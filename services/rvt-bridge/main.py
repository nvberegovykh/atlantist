"""
rvt-bridge — FastAPI sidecar for Atlantist BIM platform.
Handles ONLY: open .rvt/.rfa/.rte and compile .rvt/.rfa/.rte from element data.
Stateless, no DB.

Modes:
  ODA mode  — env var ODA_BIMRV_PATH set → subprocess call to C# ODA BimRv runner.
  Stub mode — ODA_BIMRV_PATH not set    → parse OLE2 container with olefile to
              extract BasicFileInfo + thumbnail, return realistic mock element data.

Auth: X-Bridge-Key header must match BRIDGE_API_KEY env var.
CORS: allowed origin set via ATLANTIST_ORIGIN env var.
"""

import os
import uuid
import asyncio
import tempfile
import subprocess
import json
import logging
from contextlib import asynccontextmanager
from typing import Literal, Optional, Any

import httpx
import olefile
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ─── Config ──────────────────────────────────────────────────────────────────

BRIDGE_API_KEY   = os.environ.get("BRIDGE_API_KEY", "")
ATLANTIST_ORIGIN = os.environ.get("ATLANTIST_ORIGIN", "https://atlantist.cloud")
ODA_BIMRV_PATH   = os.environ.get("ODA_BIMRV_PATH", "")   # empty → stub mode

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("rvt-bridge")

# ─── Job store (in-memory) ────────────────────────────────────────────────────

_jobs: dict[str, dict] = {}   # job_id → {status, progress, result, error}

def _new_job() -> str:
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"job_id": job_id, "status": "processing", "progress": 0, "result": None}
    return job_id

def _finish_job(job_id: str, result: dict):
    if job_id in _jobs:
        _jobs[job_id].update({"status": "complete", "progress": 100, "result": result})

def _fail_job(job_id: str, message: str):
    if job_id in _jobs:
        _jobs[job_id].update({"status": "error", "progress": 0,
                               "result": {"error": message}})

def _set_progress(job_id: str, progress: int):
    if job_id in _jobs:
        _jobs[job_id]["progress"] = max(0, min(100, progress))

# ─── Pydantic models ─────────────────────────────────────────────────────────

class OpenRequest(BaseModel):
    file_url:   str
    file_type:  Literal["rvt", "rfa", "rte"] = "rvt"
    project_id: str

class CompileRequest(BaseModel):
    project_id:    str
    elements:      list[dict] = Field(default_factory=list)
    levels:        list[dict] = Field(default_factory=list)
    families:      list[dict] = Field(default_factory=list)
    output_format: Literal["rvt", "rfa", "rte"] = "rvt"
    revit_version: Literal["2024", "2025"] = "2024"

# ─── Auth helper ─────────────────────────────────────────────────────────────

def _check_auth(x_bridge_key: str):
    if not BRIDGE_API_KEY:
        return   # no key configured → open (dev mode)
    if x_bridge_key != BRIDGE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid X-Bridge-Key")

# ─── File download ────────────────────────────────────────────────────────────

async def _download_file(url: str, suffix: str) -> str:
    """Download url to a temp file, return path."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.close()
    async with httpx.AsyncClient(follow_redirects=True, timeout=120) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with open(tmp.name, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    f.write(chunk)
    return tmp.name

# ─── OLE2 / stub helpers ──────────────────────────────────────────────────────

_STUB_WALL_TYPES = [
    "Generic - 200mm", "Generic - 300mm", "Exterior - Brick on CMU", "Interior - 138mm Partition"
]
_STUB_LEVEL_NAMES = ["Level 1", "Level 2", "Level 3", "Roof"]
_STUB_FAMILIES = [
    {"name": "Single-Flush", "category": "Doors", "type_names": ["0915 x 2134mm", "0762 x 2134mm"]},
    {"name": "Fixed",        "category": "Windows", "type_names": ["0610 x 1220mm", "0915 x 1220mm"]},
]

def _read_ole_metadata(path: str) -> dict:
    """Extract BasicFileInfo and thumbnail from an OLE2 container (.rvt/.rfa)."""
    meta = {}
    try:
        if not olefile.isOleFile(path):
            return meta
        ole = olefile.OleFileIO(path)
        # BasicFileInfo stream is a small struct with Revit version, build, locale
        if ole.exists("BasicFileInfo"):
            raw = ole.openstream("BasicFileInfo").read()
            # BasicFileInfo is a UTF-16LE string terminated with \x00\x00
            try:
                text = raw.decode("utf-16-le", errors="replace")
                meta["basic_file_info_raw"] = text.strip("\x00")
            except Exception:
                pass
        # RevitPreview / thumbnail
        if ole.exists("RevitPreview"):
            preview_bytes = ole.openstream("RevitPreview").read()
            meta["has_thumbnail"] = len(preview_bytes) > 0
        ole.close()
    except Exception as e:
        log.warning("OLE2 parse warning: %s", e)
    return meta

def _build_stub_elements(meta: dict, file_type: str, project_id: str) -> dict:
    """Build realistic mock elements for stub mode."""
    import hashlib, math
    seed = int(hashlib.md5(project_id.encode()).hexdigest()[:8], 16)
    rng_state = [seed]

    def _rng(lo, hi):
        rng_state[0] = (rng_state[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return lo + (rng_state[0] % (hi - lo + 1))

    levels = [
        {"id": f"lvl-{i}", "name": _STUB_LEVEL_NAMES[i], "elevation": i * 3.0,
         "is_building_storey": True}
        for i in range(min(4, 2 + _rng(0, 2)))
    ]

    elements = []
    elem_id = 1
    for lvl in levels:
        wall_count = _rng(4, 12)
        for w in range(wall_count):
            angle = (w / wall_count) * 2 * math.pi
            length = 3.0 + _rng(0, 80) / 10.0
            elements.append({
                "id": f"el-{elem_id}",
                "revit_guid": str(uuid.UUID(int=elem_id * 0x1234 + seed)),
                "category": "OST_Walls",
                "type_name": _STUB_WALL_TYPES[w % len(_STUB_WALL_TYPES)],
                "level_id": lvl["id"],
                "parameters": {
                    "Length": length * 3.281,
                    "Height": 3.0 * 3.281,
                    "Type Name": _STUB_WALL_TYPES[w % len(_STUB_WALL_TYPES)],
                    "Level": lvl["name"],
                    "Base Constraint": lvl["name"],
                    "Compound Structure": f"Generic|Concrete|{0.2 * 3.281:.3f}|Structure",
                },
                "position": {
                    "x": round(math.cos(angle) * 5, 2),
                    "y": round(math.sin(angle) * 5, 2),
                    "z": lvl["elevation"],
                    "length": length,
                    "angle": round(math.degrees(angle), 1),
                }
            })
            elem_id += 1

        door_count = _rng(1, 3)
        for d in range(door_count):
            elements.append({
                "id": f"el-{elem_id}",
                "revit_guid": str(uuid.UUID(int=elem_id * 0x5678 + seed)),
                "category": "OST_Doors",
                "type_name": "Single-Flush 0915 x 2134mm",
                "level_id": lvl["id"],
                "parameters": {
                    "Width": 0.915 * 3.281,
                    "Height": 2.134 * 3.281,
                    "Type Name": "Single-Flush",
                    "Level": lvl["name"],
                    "Type": "0915 x 2134mm",
                },
            })
            elem_id += 1

    families = [
        {
            "name": f["name"],
            "category": f["category"],
            "type_names": f["type_names"],
        }
        for f in _STUB_FAMILIES
    ]

    return {
        "elements": elements,
        "levels": levels,
        "families": families,
        "stub_mode": True,
        "oda_available": False,
        "meta": meta,
        "element_count": len(elements),
        "level_count": len(levels),
    }

# ─── ODA runner ──────────────────────────────────────────────────────────────

async def _run_oda_open(path: str, file_type: str, job_id: str) -> dict:
    """
    Call the C# ODA BimRv runner via subprocess.
    The runner is expected at ODA_BIMRV_PATH and accepts:
      <runner> open <path> <file_type>
    Returns JSON on stdout with { elements, levels, families }.
    """
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: subprocess.run(
                [ODA_BIMRV_PATH, "open", path, file_type],
                capture_output=True, text=True, timeout=300
            )
        )
        if result.returncode != 0:
            raise RuntimeError(f"ODA runner error: {result.stderr.strip()}")
        data = json.loads(result.stdout)
        data["oda_available"] = True
        data["stub_mode"] = False
        return data
    except json.JSONDecodeError as e:
        raise RuntimeError(f"ODA runner returned invalid JSON: {e}")

async def _run_oda_compile(elements, levels, families, output_format, revit_version, job_id: str) -> str:
    """
    Call ODA BimRv runner to compile elements → .rvt/.rfa.
    Returns path to compiled file.
    """
    payload_path = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    payload_path.close()
    with open(payload_path.name, "w") as f:
        json.dump({
            "elements": elements,
            "levels": levels,
            "families": families,
            "output_format": output_format,
            "revit_version": revit_version,
        }, f)
    out_path = payload_path.name.replace(".json", f".{output_format}")
    result = await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: subprocess.run(
            [ODA_BIMRV_PATH, "compile", payload_path.name, out_path],
            capture_output=True, text=True, timeout=600
        )
    )
    if result.returncode != 0:
        raise RuntimeError(f"ODA compile error: {result.stderr.strip()}")
    return out_path

# ─── Background workers ───────────────────────────────────────────────────────

async def _process_open(job_id: str, file_url: str, file_type: str, project_id: str):
    tmp_path = None
    try:
        _set_progress(job_id, 10)
        tmp_path = await _download_file(file_url, f".{file_type}")
        _set_progress(job_id, 40)

        if ODA_BIMRV_PATH:
            result = await _run_oda_open(tmp_path, file_type, job_id)
        else:
            meta = _read_ole_metadata(tmp_path)
            result = _build_stub_elements(meta, file_type, project_id)

        _set_progress(job_id, 90)
        _finish_job(job_id, result)
        log.info("open job %s complete: %d elements", job_id, len(result.get("elements", [])))
    except Exception as e:
        log.exception("open job %s failed", job_id)
        _fail_job(job_id, str(e))
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

async def _process_compile(job_id: str, project_id: str, elements, levels, families,
                            output_format: str, revit_version: str):
    out_path = None
    try:
        _set_progress(job_id, 10)
        if ODA_BIMRV_PATH:
            out_path = await _run_oda_compile(elements, levels, families,
                                              output_format, revit_version, job_id)
            _set_progress(job_id, 90)
            # In production, upload out_path to R2/S3 and return presigned URL.
            # For now, return a placeholder download URL.
            download_url = f"/api/bridge/download/{job_id}.{output_format}"
        else:
            # Stub: return a placeholder URL
            _set_progress(job_id, 90)
            download_url = (
                f"https://stub.atlantist.cloud/bridge/compile/{job_id}"
                f"/output.{output_format}?stub=1"
            )

        _finish_job(job_id, {
            "download_url": download_url,
            "output_format": output_format,
            "revit_version": revit_version,
            "element_count": len(elements),
            "stub_mode": not bool(ODA_BIMRV_PATH),
        })
        log.info("compile job %s complete", job_id)
    except Exception as e:
        log.exception("compile job %s failed", job_id)
        _fail_job(job_id, str(e))
    finally:
        if out_path:
            try:
                os.unlink(out_path)
            except Exception:
                pass

# ─── App ─────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("rvt-bridge starting. ODA mode: %s", bool(ODA_BIMRV_PATH))
    yield
    log.info("rvt-bridge shutting down.")

app = FastAPI(title="Atlantist RVT Bridge", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ATLANTIST_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Bridge-Key"],
)

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/bridge/health")
async def health():
    return {
        "status": "ok",
        "oda_available": bool(ODA_BIMRV_PATH) and os.path.isfile(ODA_BIMRV_PATH),
        "version": "1.0.0",
        "stub_mode": not bool(ODA_BIMRV_PATH),
    }


@app.post("/bridge/open")
async def bridge_open(
    body: OpenRequest,
    background_tasks: BackgroundTasks,
    x_bridge_key: str = Header(default=""),
):
    _check_auth(x_bridge_key)
    job_id = _new_job()
    background_tasks.add_task(
        _process_open,
        job_id, body.file_url, body.file_type, body.project_id
    )
    return {"job_id": job_id, "status": "processing", "elements": [], "levels": [], "families": []}


@app.post("/bridge/compile")
async def bridge_compile(
    body: CompileRequest,
    background_tasks: BackgroundTasks,
    x_bridge_key: str = Header(default=""),
):
    _check_auth(x_bridge_key)
    job_id = _new_job()
    background_tasks.add_task(
        _process_compile,
        job_id, body.project_id,
        body.elements, body.levels, body.families,
        body.output_format, body.revit_version,
    )
    return {"job_id": job_id, "status": "processing", "download_url": ""}


@app.get("/bridge/job/{job_id}")
async def get_job(
    job_id: str,
    x_bridge_key: str = Header(default=""),
):
    _check_auth(x_bridge_key)
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "progress": job["progress"],
        "result": job["result"],
    }
