/**
 * Owns: Structural audit API endpoints — project audit runs, attachment validation,
 *       load path audit, lateral system checks, fix commands.
 * Does NOT own: audit computation (services/structural-audit-engine.js),
 *               DB access (db/structural-audit.js).
 */
const express = require('express');
const router = express.Router();
const engine = require('../services/structural-audit-engine');
const db = require('../db/structural-audit');
const { appendEvent } = require('../db/events');
const pool = require('../db');

// ─── Audit runs ───────────────────────────────────────────────────────────────

// POST /api/structural-audit — trigger full project audit
router.post('/', async (req, res) => {
  try {
    const { project_id, run_name, audit_type = 'full', disclaimer_accepted, created_by, units = 'mm' } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    if (!disclaimer_accepted) {
      return res.status(400).json({
        error: 'Must accept structural audit disclaimer before running',
        disclaimer: engine.DISCLAIMER,
      });
    }

    // Resolve project-specific M from module_projects table
    let M_mm = null;
    try {
      const mp = await pool.query('SELECT M_value FROM module_projects WHERE project_id = $1', [project_id]);
      if (mp.rows[0]?.M_value) M_mm = parseFloat(mp.rows[0].M_value);
    } catch {
      // No module project set — engine will use DEFAULT_MODULE_MM
    }

    const run = await db.runs.create({ project_id, run_name, audit_type, disclaimer_accepted, created_by });

    // Run the full audit with project-specific M
    const { results, totals, load_path_summary, lateral_system_check, disclaimer, M_mm: resolvedM } =
      await engine.runFullAudit(project_id, { units, M_mm });

    // Persist results in bulk
    const rowsToInsert = results.map(r => ({ ...r, run_id: run.id }));
    await db.results.bulkInsert(rowsToInsert);

    // Update run record
    const updated = await db.runs.updateResults(run.id, { totals, load_path_summary, lateral_system_check });

    // Persist audit event to ledger
    await appendEvent({
      entity_type: 'structural_audit_run',
      entity_id: run.id,
      event_type: 'audit_completed',
      before_data: null,
      after_data: { project_id, totals, audit_type },
    });

    res.json({
      run: updated,
      totals,
      results_count: results.length,
      load_path_summary,
      lateral_system_check,
      disclaimer,
      M_mm: resolvedM,
      drift_tolerance_mm: resolvedM / 16,
      fix_snap_mm: resolvedM / 8,
    });
  } catch (err) {
    console.error('[structural-audit] POST / error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/structural-audit — list audit runs for a project
router.get('/', async (req, res) => {
  try {
    const { project_id, limit = 20 } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const runs = await db.runs.listByProject(project_id);
    res.json({ runs: runs.slice(0, parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/structural-audit/:id — get a specific audit run with results
router.get('/:id', async (req, res) => {
  try {
    const run = await db.runs.getById(parseInt(req.params.id));
    if (!run) return res.status(404).json({ error: 'Audit run not found' });

    const results = await db.results.listByRun(run.id);
    res.json({
      run,
      results,
      disclaimer: engine.DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/structural-audit/:id — delete an audit run and its results
router.delete('/:id', async (req, res) => {
  try {
    await db.results.deleteByRun(parseInt(req.params.id));
    await db.runs.delete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Validate All — geometric validation only ─────────────────────────────────

// GET /api/structural-audit/validate/:projectId — fast geometric validation
router.get('/validate/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });

    // Resolve M from module_projects
    let M_mm = engine.DEFAULT_MODULE_MM;
    try {
      const mp = await pool.query('SELECT M_value FROM module_projects WHERE project_id = $1', [projectId]);
      if (mp.rows[0]?.M_value) M_mm = parseFloat(mp.rows[0].M_value);
    } catch { /* use default */ }

    const { DRIFT_TOLERANCE_MM, FIX_SNAP_MM } = engine.getAuditConstants(M_mm);

    const [familyResults, elementResults] = await Promise.all([
      engine.validateFamilyAttachments(projectId, M_mm),
      engine.validateElementAttachments(projectId, M_mm),
    ]);

    const all = [...familyResults, ...elementResults];
    const totals = { RED: 0, AMBER: 0, GREEN: 0 };
    for (const r of all) { if (totals[r.verdict] !== undefined) totals[r.verdict]++; }

    res.json({
      results: all,
      totals,
      drift_tolerance_mm: DRIFT_TOLERANCE_MM,
      fix_snap_mm: FIX_SNAP_MM,
      M_mm,
      disclaimer: engine.DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fix orphaned attachment ───────────────────────────────────────────────────

// POST /api/structural-audit/fix — snap orphaned attachment to nearest valid position
router.post('/fix', async (req, res) => {
  try {
    const { entity_id, entity_type = 'family_instance', project_id, M_mm } = req.body;
    if (!entity_id) return res.status(400).json({ error: 'entity_id required' });

    // Resolve M from project if not provided
    let resolvedM = M_mm || engine.DEFAULT_MODULE_MM;
    if (project_id && !M_mm) {
      try {
        const mp = await pool.query('SELECT M_value FROM module_projects WHERE project_id = $1', [project_id]);
        if (mp.rows[0]?.M_value) resolvedM = parseFloat(mp.rows[0].M_value);
      } catch { /* use provided/default */ }
    }

    const result = await engine.fixOrphanedAttachment(entity_id, entity_type, resolvedM);

    if (result.error) return res.status(400).json(result);

    res.json({
      ok: true,
      ...result,
      disclaimer: engine.DISCLAIMER,
    });
  } catch (err) {
    console.error('[structural-audit] fix error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Load path audit ──────────────────────────────────────────────────────────

// GET /api/structural-audit/load-path/:projectId — trace gravity load path
router.get('/load-path/:projectId', async (req, res) => {
  try {
    let M_mm = engine.DEFAULT_MODULE_MM;
    try {
      const mp = await pool.query('SELECT M_value FROM module_projects WHERE project_id = $1', [req.params.projectId]);
      if (mp.rows[0]?.M_value) M_mm = parseFloat(mp.rows[0].M_value);
    } catch { /* use default */ }

    const result = await engine.traceLoadPath(req.params.projectId);
    res.json({
      ...result,
      units: req.query.units === 'module' ? 'module' : 'mm',
      module_size_mm: M_mm,
      disclaimer: engine.DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Lateral system check ──────────────────────────────────────────────────────

// GET /api/structural-audit/lateral/:projectId — check shear wall / moment frame presence
router.get('/lateral/:projectId', async (req, res) => {
  try {
    const result = await engine.checkLateralSystem(req.params.projectId);
    res.json({
      ...result,
      disclaimer: engine.DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Code compliance ──────────────────────────────────────────────────────────

// GET /api/structural-audit/code-compliance/:projectId — sweep DOB/NYC BC minimums
router.get('/code-compliance/:projectId', async (req, res) => {
  try {
    const results = await engine.checkCodeCompliance(req.params.projectId);
    const totals = { RED: 0, AMBER: 0, GREEN: 0 };
    for (const r of results) { if (totals[r.verdict] !== undefined) totals[r.verdict]++; }
    res.json({ results, totals, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Material compatibility ───────────────────────────────────────────────────

// GET /api/structural-audit/material-compat/:projectId
router.get('/material-compat/:projectId', async (req, res) => {
  try {
    const results = await engine.checkMaterialCompatibility(req.params.projectId);
    const totals = { RED: 0, AMBER: 0, GREEN: 0 };
    for (const r of results) { if (totals[r.verdict] !== undefined) totals[r.verdict]++; }
    res.json({ results, totals, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Connection type catalog ───────────────────────────────────────────────────

// GET /api/structural-audit/connection-types — list all valid connection types
router.get('/connection-types', async (_req, res) => {
  try {
    const types = await db.connectionTypes.list();
    res.json({ connection_types: types });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/structural-audit/edge/:parentId/:childId — update DAG edge metadata
router.patch('/edge/:parentId/:childId', async (req, res) => {
  try {
    const { parentId, childId } = req.params;
    const { connection_type, material_pair, attachment_offset_mm } = req.body;

    if (!connection_type) return res.status(400).json({ error: 'connection_type required' });

    // Validate against catalog
    const valid = await db.connectionTypes.getByType(connection_type);
    if (!valid) return res.status(400).json({
      error: `Unknown connection_type "${connection_type}"`,
      available: (await db.connectionTypes.list()).map(c => c.connection_type),
    });

    const edge = await db.edges.updateMetadata(parentId, childId, { connection_type, material_pair, attachment_offset_mm });
    if (!edge) return res.status(404).json({ error: 'DAG edge not found' });

    res.json({ ok: true, edge });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tolerances constants ──────────────────────────────────────────────────────

// GET /api/structural-audit/tolerances — return M-aware tolerance constants
// Optional query param: ?project_id=N — returns project-specific M values
// Otherwise returns DEFAULT_MODULE_MM (600mm) for backward compatibility
router.get('/tolerances', async (req, res) => {
  const { project_id } = req.query;
  let M_mm = engine.DEFAULT_MODULE_MM;

  if (project_id) {
    try {
      const mp = await pool.query('SELECT M_value FROM module_projects WHERE project_id = $1', [project_id]);
      if (mp.rows[0]?.M_value) M_mm = parseFloat(mp.rows[0].M_value);
    } catch {
      // fall through to default
    }
  }

  const { DRIFT_TOLERANCE_MM, FIX_SNAP_MM, MODULE_MM } = engine.getAuditConstants(M_mm);
  res.json({
    drift_tolerance_mm: DRIFT_TOLERANCE_MM,
    fix_snap_mm: FIX_SNAP_MM,
    module_mm: MODULE_MM,
    drift_tolerance_in: +(DRIFT_TOLERANCE_MM / 25.4).toFixed(4),
    fix_snap_in: +(FIX_SNAP_MM / 25.4).toFixed(4),
    note: `Drift tolerance = M/16 (${DRIFT_TOLERANCE_MM.toFixed(1)}mm), fix snap = M/8 (${FIX_SNAP_MM.toFixed(1)}mm), module = ${M_mm}mm (${(M_mm / 1000).toFixed(3)}m)`,
  });
});

module.exports = router;