/**
 * Owns: RVT bridge client — delegates open/compile to the rvt-bridge sidecar.
 * Does NOT own: DB writes, HTTP routing, file upload.
 *
 * The rvt-bridge sidecar handles the actual RVT binary parsing (ODA BimRv SDK
 * or stub mode). This service is just the Node.js client that talks to it.
 *
 * Bridge endpoints used:
 *   POST /bridge/open      — parse .rvt/.rfa/.rte → elements/levels/families
 *   POST /bridge/compile   — elements/levels/families → download URL
 *   GET  /bridge/job/:id   — poll job status (progress 0–100, status, result)
 *   GET  /bridge/health    — service liveness + ODA availability flag
 */

'use strict';

const BRIDGE_URL = process.env.RVT_BRIDGE_URL || 'http://localhost:8001';
const BRIDGE_KEY = process.env.BRIDGE_API_KEY  || '';

// ─── Poll config ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1500;   // wait between /bridge/job polls
const POLL_TIMEOUT_MS  = 300000; // 5 min max

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function _bridgeFetch(method, path, body) {
  const url = `${BRIDGE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(BRIDGE_KEY ? { 'X-Bridge-Key': BRIDGE_KEY } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rvt-bridge ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Job polling ──────────────────────────────────────────────────────────────

async function _pollJob(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const job = await _bridgeFetch('GET', `/bridge/job/${jobId}`);
    if (job.status === 'complete') return job.result;
    if (job.status === 'error') {
      throw new Error(`rvt-bridge job ${jobId} failed: ${job.result?.error || 'unknown error'}`);
    }
    // status === 'processing' → keep polling
  }
  throw new Error(`rvt-bridge job ${jobId} timed out after ${POLL_TIMEOUT_MS}ms`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open a .rvt/.rfa/.rte file via the bridge.
 *
 * @param {Object} opts
 * @param {string} opts.fileUrl      — presigned S3/R2 URL or direct download URL
 * @param {string} [opts.fileType]   — "rvt" | "rfa" | "rte" (default: "rvt")
 * @param {string} opts.projectId    — Atlantist project ID
 * @returns {Promise<{ elements: Object[], levels: Object[], families: Object[], stub_mode: boolean }>}
 */
async function openRvtFile({ fileUrl, fileType = 'rvt', projectId }) {
  const initial = await _bridgeFetch('POST', '/bridge/open', {
    file_url:   fileUrl,
    file_type:  fileType,
    project_id: projectId,
  });
  const result = await _pollJob(initial.job_id);
  return {
    elements:  result.elements  || [],
    levels:    result.levels    || [],
    families:  result.families  || [],
    stub_mode: result.stub_mode || false,
    oda_available: result.oda_available || false,
  };
}

/**
 * Compile Atlantist element data into a .rvt/.rfa file via the bridge.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {Object[]} opts.elements
 * @param {Object[]} opts.levels
 * @param {Object[]} opts.families
 * @param {string} [opts.outputFormat]  — "rvt" | "rfa" | "rte" (default: "rvt")
 * @param {string} [opts.revitVersion]  — "2024" | "2025" (default: "2024")
 * @returns {Promise<{ downloadUrl: string, stub_mode: boolean }>}
 */
async function compileRvtFile({
  projectId,
  elements,
  levels,
  families,
  outputFormat = 'rvt',
  revitVersion = '2024',
}) {
  const initial = await _bridgeFetch('POST', '/bridge/compile', {
    project_id:    projectId,
    elements:      elements  || [],
    levels:        levels    || [],
    families:      families  || [],
    output_format: outputFormat,
    revit_version: revitVersion,
  });
  const result = await _pollJob(initial.job_id);
  return {
    downloadUrl: result.download_url || '',
    stub_mode:   result.stub_mode    || false,
  };
}

/**
 * Check bridge health.
 * @returns {Promise<{ status: string, oda_available: boolean }>}
 */
async function bridgeHealth() {
  return _bridgeFetch('GET', '/bridge/health');
}

// ─── Element category → Atlantist type mapping ────────────────────────────────
//
// Revit DB API categories (IFC-equivalent mapping):
//   OST_Walls              → wall      (element row, with wall_layers)
//   OST_StructuralColumns  → column    (element row)
//   OST_Columns            → column    (architectural column)
//   OST_Doors              → family_instance (family_type=door)
//   OST_Windows            → family_instance (family_type=window)
//   OST_Floors             → floor     (element row, type_name=generic)
//   OST_Roofs              → roof      (element row)
//   OST_Ceilings           → ceiling   (element row)
//   OST_Rooms              → room      (element row)
//   OST_Stairs             → stair     (element row)
//   OST_StairsRisers        → stair     (element row)
//   OST_Railing            → railing   (element row)
//   OST_Fabrication Rails  → duct      (element row, MEP)
//   OST_DuctCurves         → duct      (element row, MEP)
//   OST_PipeCurves         → pipe      (element row, MEP)
//   OST_CableTray          → cabletray (element row, MEP)
//   OST_Conduit            → conduit   (element row, MEP)
//   OST_LightingFixtures   → fixture   (element row)
//   OST_MechanicalEquipment → equipment (element row)
//   OST_PlumbingFixtures   → fixture   (element row)
//   OST_StructuralFraming  → beam      (element row)
//   OST_StructuralFoundation → foundation (element row)
//   OST_Rebar              → rebar     (element row)
//   OST_StructuralConnections → connection (element row)
//   OST_HVACZoningEquipt   → equipment (element row)

const CAT_MAP = {
  // Architectural
  'OST_Walls':              { type: 'wall',         supported: true,  layers: true  },
  'OST_CurtainWallPanels':  { type: 'wall',         supported: true,  layers: false, sub: 'curtain' },
  'OST_StackedWalls':       { type: 'wall',         supported: true,  layers: true,  sub: 'stacked' },
  'OST_Floors':             { type: 'floor',         supported: true,  layers: false },
  'OST_Roofs':              { type: 'roof',          supported: true,  layers: false },
  'OST_Ceilings':           { type: 'ceiling',       supported: true,  layers: false },
  'OST_Rooms':              { type: 'room',          supported: true,  layers: false },
  'OST_RoomTags':           { type: 'room_tag',      supported: true,  layers: false },
  'OST_Doors':              { type: 'family_instance', supported: true, layers: false, family: 'door' },
  'OST_Windows':            { type: 'family_instance', supported: true, layers: false, family: 'window' },
  'OST_Stairs':             { type: 'stair',         supported: true,  layers: false },
  'OST_StairsRisers':       { type: 'stair',         supported: false, layers: false },
  'OST_StairsTreads':       { type: 'stair',         supported: false, layers: false },
  'OST_Railing':            { type: 'railing',       supported: false, layers: false },
  'OST_RailingTermination': { type: 'railing',       supported: false, layers: false },
  'OST_Columns':            { type: 'column',        supported: true,  layers: false },
  // Structural
  'OST_StructuralColumns':  { type: 'column',        supported: true,  layers: false, sub: 'structural' },
  'OST_StructuralFraming':  { type: 'beam',          supported: true,  layers: false },
  'OST_StructuralFoundation':{ type: 'foundation',   supported: false, layers: false },
  'OST_StructuralConnections':{ type: 'connection',  supported: false, layers: false },
  'OST_Rebar':              { type: 'rebar',          supported: false, layers: false },
  'OST_FabricationRebar':   { type: 'rebar',          supported: false, layers: false },
  // MEP
  'OST_DuctCurves':         { type: 'duct',          supported: false, layers: false },
  'OST_FabricationDuctwork':{ type: 'duct',          supported: false, layers: false },
  'OST_DuctTerminal':       { type: 'duct_terminal', supported: false, layers: false },
  'OST_PipeCurves':         { type: 'pipe',          supported: false, layers: false },
  'OST_FabricationPipework':{ type: 'pipe',          supported: false, layers: false },
  'OST_PipeCurves FIT':     { type: 'pipe',          supported: false, layers: false },
  'OST_CableTray':          { type: 'cabletray',     supported: false, layers: false },
  'OST_Conduit':            { type: 'conduit',        supported: false, layers: false },
  'OST_LightingDevices':   { type: 'fixture',       supported: false, layers: false },
  'OST_LightingFixtures':   { type: 'fixture',       supported: false, layers: false },
  'OST_ElectricalEquipment':{ type: 'equipment',    supported: false, layers: false },
  'OST_MechanicalEquipment':{ type: 'equipment',   supported: false, layers: false },
  'OST_PlumbingFixtures':   { type: 'fixture',       supported: false, layers: false },
  // Model organization
  'OST_RevitLinks':         { type: 'revit_link',    supported: false, layers: false },
  'OST_Groups':             { type: 'group',          supported: false, layers: false },
  // Unknown
  '_other':                 { type: 'unknown',       supported: false, layers: false },
};

// ─── Parameter extraction helpers (used by routes/rvt-import.js) ──────────────

function mapRevitParamsToAtlantist(params, category, familyType) {
  const mapped = {};

  // Universal parameters
  if (params.Level) mapped.revit_level = params.Level;
  if (params.Family) mapped.family_name = params.Family;
  if (params.Type) mapped.type_name = params.Type;
  if (params['Type Name']) mapped.type_name = params['Type Name'];
  if (params.Name) mapped.name = params.Name;
  if (params['Unique Id']) mapped.revit_guid = params['Unique Id'];

  // Wall-specific (only set wall_height for wall categories)
  if (params['Length']) mapped.length = params['Length'] / 3.281; // ft → m
  const isWallCategory = category === 'OST_Walls';
  if (isWallCategory && params['Height']) mapped.wall_height = params['Height'] / 3.281;
  if (params['Base Constraint']) mapped.base_constraint = params['Base Constraint'];
  if (params['Top Constraint']) mapped.top_constraint = params['Top Constraint'];
  if (params['Base Offset']) mapped.base_offset = params['Base Offset'] / 3.281;
  if (params['Top Offset']) mapped.top_offset = params['Top Offset'] / 3.281;
  if (params['Structural']) mapped.is_structural = params['Structural'];

  // Column-specific
  if (params['Location Line']) mapped.location_line = params['Location Line'];
  if (params['Height Type']) mapped.height_type = params['Height Type'];
  if (params['Column Style']) mapped.column_style = params['Column Style'];

  // Door/Window (only set height for door/window categories, not walls)
  const isDoorWindow = ['OST_Doors', 'OST_Windows'].includes(category) ||
                       ['door', 'window'].includes(familyType);
  if (params['Width']) mapped.width = params['Width'] / 3.281;
  if (isDoorWindow && params['Height']) mapped.height = params['Height'] / 3.281;
  if (params['Sill Height']) mapped.sillHeight = params['Sill Height'] / 3.281;
  if (params['Fire Rating']) mapped.fireRating = params['Fire Rating'];
  if (params['Material']) mapped.material = params['Material'];
  if (params['Type']) mapped.door_type = params['Type'];
  if (params['Hand']) mapped.hand = params['Hand'];

  // Room
  if (params['Area']) mapped.area = params['Area'] / 10.764; // ft² → m²
  if (params['Number']) mapped.room_number = params['Number'];
  if (params['Department']) mapped.department = params['Department'];

  // Floor/Roof
  if (params['Height Offset From Level']) mapped.height_offset = params['Height Offset From Level'] / 3.281;
  if (params['Slope']) mapped.slope = params['Slope'];

  // Beam
  if (params['Start Level']) mapped.start_level = params['Start Level'];
  if (params['End Level']) mapped.end_level = params['End Level'];
  if (params['Start Offset']) mapped.start_offset = params['Start Offset'] / 3.281;
  if (params['End Offset']) mapped.end_offset = params['End Offset'] / 3.281;
  if (params['Structural Usage']) mapped.structural_usage = params['Structural Usage'];

  // MEP
  if (params['Diameter']) mapped.diameter = params['Diameter'] / 3.281;
  if (params['Rough Size']) mapped.rough_size = params['Rough Size'];
  if (params['System Type']) mapped.system_type = params['System Type'];

  // Materials
  if (params['Material']) mapped.material = params['Material'];

  return mapped;
}

/**
 * Parse the Revit compound structure parameter into an array of wall layers.
 * Format: "Layer Name | Material | Thickness (ft) | Function | ..."
 */
function parseCompoundStructure(params) {
  const layers = [];
  const cs = params['Compound Structure'] || params.CompoundStructure;
  if (!cs) return layers;

  const rows = Array.isArray(cs) ? cs : cs.split('|');
  let order = 0;
  for (const row of rows) {
    const parts = Array.isArray(row) ? row : String(row).split('|');
    if (parts.length >= 3) {
      const thicknessFt = parseFloat(parts[2]);
      if (!isNaN(thicknessFt)) {
        layers.push({
          material:    parts[1]?.trim() || 'Generic',
          thickness:   thicknessFt / 3.281, // ft → m
          function:    parts[3]?.trim() || 'Structure',
          layer_order: order++,
        });
      }
    }
  }
  return layers;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  openRvtFile,
  compileRvtFile,
  bridgeHealth,
  CAT_MAP,
  mapRevitParamsToAtlantist,
  parseCompoundStructure,
};
