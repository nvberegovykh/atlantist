/**
 * IFC import pipeline using web-ifc-three (IFCjs).
 * Bolt-on: does not replace existing RVT import or IFC route.
 * Wire: call initIFCImporter() then bind file inputs / drag-drop to importIFCFile().
 *
 * IFC Pset schema alignment (buildingSMART):
 *   Pset_WallCommon    → wall properties in IM panel
 *   Pset_ColumnCommon  → column properties
 *   Pset_SlabCommon    → floor/ceiling properties
 *   Pset_BeamCommon    → beam properties
 *   Pset_DoorCommon    → door properties
 *   Pset_WindowCommon  → window properties
 *   Pset_StairCommon   → stair properties
 *   Pset_SpaceCommon   → room/space properties
 */
import * as THREE from 'three';

// Dynamic import of web-ifc-three — only loads when user initiates IFC import
let _ifcManager = null;
let _ifcReady = false;

// ─── IFC type → Atlantist element category mapping ───────────────────────────
// Fixed: removed incorrect IFCSI* prefix (buildingSMART uses IFC* not IFCSI*)
const IFC_TYPE_MAP = {
  IFCWALL:                  'element',
  IFCWALLSTANDARDCASE:      'element',
  IFCCOLUMN:                'element',
  IFCSLAB:                  'floor',
  IFCDOOR:                  'family',
  IFCWINDOW:                'family',
  IFCBEAM:                  'element',
  IFCSTAIR:                 'stair',
  IFCSTAIRFLIGHT:           'stair',
  IFCRAMP:                  'stair',
  IFCROOF:                  'element',
  IFCSPACE:                 'room',
  IFCBUILDINGELEMENTPROXY:  'element',
  IFCPLATE:                 'element',
  IFCMEMBER:                'element',
  IFCCURTAINWALL:           'element',
  IFCRAILING:               'element',
};

// ─── Pset property name normalization ─────────────────────────────────────────
function normalizePropertyName(raw) {
  return raw.replace(/^(Pset_|_|IFC|Ifc)/gi, '').replace(/([A-Z])/g, '_$1').toLowerCase().trim();
}

// ─── Extract properties from IFC model ─────────────────────────────────────────
// Fixed: web-ifc-three@0.0.126 getAllItemsOfType(modelID, typeCode, verbose)
// typeCode comes from web-ifc constants (e.g., IFCWALL). Called lazily after parse().
async function extractProperties(modelID, ifcManager) {
  const props = {};
  try {
    const { IFCWALL } = await import('web-ifc');
    const walls = await ifcManager.getAllItemsOfType(modelID, IFCWALL, false);
    for (const id of (walls || [])) {
      try {
        const item = await ifcManager.getItemProperties(modelID, id, false);
        props[id] = { name: item?.Name?.value || 'IFC Wall' };
      } catch (_) {}
    }
  } catch (_) {}
  return props;
}

// ─── Import an IFC file from an ArrayBuffer ───────────────────────────────────
async function doImportIFC(buffer, filename, onProgress) {
  if (!_ifcReady) {
    // web-ifc-three@0.0.126 exports IFCLoader (not WebIFCManager)
    // It imports web-ifc@0.0.39 internally via jsdelivr
    const { IFCLoader } = await import('web-ifc-three');
    _ifcManager = new IFCLoader();
    // WASM path must match web-ifc version used by web-ifc-three@0.0.126 (= 0.0.39)
    await _ifcManager.ifcManager.setWasmPath('https://cdn.jsdelivr.net/npm/web-ifc@0.0.39/');
    _ifcReady = true;
  }

  onProgress?.('Parsing IFC geometry…');
  // IFCLoader.parse(buffer) returns an IFCModel (THREE.Group subclass)
  const model = await _ifcManager.ifcManager.parse(buffer);
  // model is an IFCModel — model.modelID is the integer model ID

  // Tag all meshes as IFC for layer counting
  const meshes = [];
  model.traverse(child => {
    if (child.isMesh) {
      child.userData.ifc_type = 'IFC';
      child.userData.ifcSource = filename;
      meshes.push(child);
    }
  });

  onProgress?.(`Loaded ${meshes.length} meshes, building scene…`);
  return { model, meshCount: meshes.length };
}

// ─── Main import function — wire to file input or drag-drop ─────────────────
export async function importIFCFile(file, {
  scene,
  camera,
  renderer,
  onProgress,
  onComplete,
  onError,
} = {}) {
  try {
    onProgress?.('Reading file…');
    const buffer = await file.arrayBuffer();

    onProgress?.('Initializing IFC parser (WASM)…');
    const { model, meshCount } = await doImportIFC(buffer, file.name, onProgress);

    if (scene) {
      // Set material: semi-transparent IFC-default grey
      model.traverse(child => {
        if (child.isMesh) {
          child.material = child.material?.clone() || new THREE.MeshStandardMaterial({
            color: 0x8888aa,
            roughness: 0.7,
            metalness: 0.1,
            transparent: true,
            opacity: 0.95,
          });
        }
      });
      scene.add(model);
    }

    onComplete?.({ model, meshCount, filename: file.name });
  } catch (err) {
    onError?.(err);
  }
}

// ─── Initialize drag-drop zone for IFC files ──────────────────────────────────
export function initIFCDropZone(dropTargetEl, { scene, camera, renderer, onComplete, onError } = {}) {
  if (!dropTargetEl) return;

  const handleFile = (file) => {
    if (!file.name.toLowerCase().endsWith('.ifc')) {
      onError?.({ message: 'Only .ifc files are supported' });
      return;
    }
    importIFCFile(file, { scene, camera, renderer, onComplete, onError });
  };

  dropTargetEl.addEventListener('dragover', e => {
    e.preventDefault();
    dropTargetEl.style.outline = '2px dashed var(--accent)';
  });
  dropTargetEl.addEventListener('dragleave', () => {
    dropTargetEl.style.outline = '';
  });
  dropTargetEl.addEventListener('drop', e => {
    e.preventDefault();
    dropTargetEl.style.outline = '';
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  return { handleFile };
}

// ─── IFC import progress UI helpers ──────────────────────────────────────────
export function showIFCProgress(msg) {
  const el = document.getElementById('ifc-import-progress');
  if (!el) return;
  el.style.display = 'flex';
  const msgEl = document.getElementById('ifc-import-msg');
  if (msgEl) msgEl.textContent = msg;
}
export function hideIFCProgress() {
  const el = document.getElementById('ifc-import-progress');
  if (el) el.style.display = 'none';
}
export function setIFCProgressPct(pct) {
  const bar = document.getElementById('ifc-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

// ─── Global API for IFC import panel ─────────────────────────────────────────
window.__atlIFCImport = {
  importFile: importIFCFile,
  initDrop: initIFCDropZone,
  showProgress: showIFCProgress,
  hideProgress: hideIFCProgress,
  setPct: setIFCProgressPct,
};

// (initIFCDropZone already exported inline above)