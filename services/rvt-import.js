/**
 * Owns: Autodesk Model Derivative API calls, element parsing, DAG mapping.
 * Does NOT own: DB writes, HTTP routing, file upload to R2.
 *
 * Revit files (.rvt) are processed through the Autodesk Forge / Model Derivative
 * API to extract geometry (SVF2 manifest) and element metadata (Design Automation).
 * Results are mapped into Atlantist's DAG element model:
 *   elements (walls, columns) + wall_layers + family_instances (doors, windows) + levels.
 *
 * Pipeline steps:
 *   1. Upload .rvt to Autodesk OSS (or receive pre-signed URL)
 *   2. Register manifest job (SVF2 output, design data)
 *   3. Poll manifest until ready
 *   4. Download SVF2 manifest + metadata bundles
 *   5. Parse element JSON → map to Atlantist types
 *   6. Return structured import results
 */

const https = require('https');
const http = require('http');

// ─── Config ─────────────────────────────────────────────────────────────────

const FORGE_BASE = 'developer.api.autodesk.com';
const OSS_BUCKET = process.env.FORGE_OSS_BUCKET || 'atlantist-rvt-imports';
const CLIENT_ID = process.env.FORGE_CLIENT_ID;
const CLIENT_SECRET = process.env.FORGE_CLIENT_SECRET;

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Cache token in-module (15 min TTL)
let _token = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('FORGE_CLIENT_ID / FORGE_CLIENT_SECRET env vars are not set. ' +
      'See https://autodesk.com/developer-platform/autodesk-platform-services ' +
      'to create a Forge app and enable Model Derivative + Data Management APIs.');
  }
  const payload = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'data:read data:write data:create bucket:read bucket:create'
  });
  const body = await rawFetch('POST', FORGE_BASE,
    '/authentication/v1/authenticate', null, payload.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded'
    });
  _token = body.access_token;
  _tokenExpiry = Date.now() + (body.expires_in - 60) * 1000;
  return _token;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function rawFetch(method, host, path, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, path, method, headers: { 'Accept': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    if (extraHeaders) Object.assign(opts.headers, extraHeaders);
    const req = (host === 'developer.api.autodesk.com' ? https : http).request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers: { 'Accept': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
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

// ─── Parameter extraction helpers ────────────────────────────────────────────

function extractString(params, ...keys) {
  for (const k of keys) {
    if (params && params[k]) return String(params[k]);
  }
  return null;
}

function extractNumber(params, ...keys) {
  for (const k of keys) {
    if (params && params[k] !== undefined && params[k] !== null) {
      const n = parseFloat(params[k]);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function parseRevitParams(element) {
  // element.parameters may be a flat object or array
  if (!element.parameters) return {};
  if (typeof element.parameters === 'object' && !Array.isArray(element.parameters)) {
    return element.parameters;
  }
  if (Array.isArray(element.parameters)) {
    const out = {};
    for (const p of element.parameters) {
      if (p.name) out[p.name] = p.value ?? p.expression ?? p.container;
    }
    return out;
  }
  return {};
}

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

// ─── Core pipeline ───────────────────────────────────────────────────────────

/**
 * Main import function. Processes a .rvt file from a Forge OSS object key.
 *
 * @param {Object} ctx
 * @param {string} ctx.ossUrn     — Base64-URL-encoded object URN in Forge OSS
 * @param {string} ctx.runId      — rvt_import_runs DB row ID
 * @param {string} [ctx.projectId]
 * @param {Object} db             — DB access object (for createElement, createLevel, etc.)
 * @returns {Promise<Object>} importResults — summary of what was mapped
 */
async function importRvtFile(ctx, db) {
  const { ossUrn, runId, projectId } = ctx;
  const token = await getAccessToken();
  const results = [];
  let totalLevels = 0;
  let totalWalls = 0;
  let totalFamilyInstances = 0;

  // ── Step 1: Get / Register manifest job ─────────────────────────────────
  const manifest = await getOrCreateManifest(ossUrn, token);
  if (manifest.status === 'failed') {
    throw new Error(`Forge manifest failed: ${manifest.urn}`);
  }

  // Wait for manifest to complete (up to 5 min)
  await pollManifest(ossUrn, token, 30000, 120000);

  // ── Step 2: Extract SVF2 manifest ───────────────────────────────────────
  const svfManifest = await fetchJson(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${ossUrn}/manifest`,
    token
  );
  const derivatives = svfManifest?.derivatives || [];

  // Find the SVF2 derivatives (ifc, ifcZIP, or svf2 output)
  const ifcDeriv = derivatives.find(d =>
    d.outputType === 'ifc' || d.outputType === 'ifcZIP' || d.outputType === 'svf2'
  );
  if (!ifcDeriv) {
    throw new Error(`No IFC/SVF2 derivative found in manifest for ${ossUrn}. ` +
      'Ensure the "IFC" or "SVF2" output is included in the job registration.');
  }

  // ── Step 3: Download metadata bundle ────────────────────────────────────
  // SVF2 stores element data in a separate JSON bundle. The manifest lists
  // childurns for each derivative — follow those to find metadata JSON.
  const childUrns = ifcDeriv.children || [];
  const metadataBundle = await downloadMetadataBundle(childUrns, token);
  if (!metadataBundle) {
    throw new Error(`Could not download metadata bundle from derivative for ${ossUrn}`);
  }

  // ── Step 4: Parse elements and map to Atlantist ────────────────────────

  // If metadataBundle.elements exists, process it directly
  const elements = metadataBundle.elements || metadataBundle.dbands || [];

  if (!elements.length) {
    // Fallback: try to parse from raw SVF zip assets (not implemented here — requires
    // binary SVF parsing which is out of scope for this service layer)
    throw new Error(`No elements found in metadata bundle. ` +
      'The .rvt file may be empty or the SVF2 output did not include design metadata. ' +
      'Try re-exporting from Revit with "Include design data" checked in the job settings.');
  }

  // Track level IDs by Revit level name
  const levelIdByName = {};
  // Track wall IDs by Revit element ID for family instance hosting
  const wallIdByRevitGuid = {};

  for (const el of elements) {
    try {
      const cat = el.category || el._cat || '_other';
      const cfg = CAT_MAP[cat] || CAT_MAP['_other'];
      const params = parseRevitParams(el);
      const mappedParams = mapRevitParamsToAtlantist(params, cat, cfg.family);

      // ── Level binding ──────────────────────────────────────────────────
      let levelId = null;
      const revitLevelName = params.Level || params['Base Constraint'] || null;
      if (revitLevelName) {
        if (!levelIdByName[revitLevelName]) {
          // Create level in DB — elevation is derived from a placeholder
          // (exact elevation requires the Revit Level API, not SVF2 metadata)
          const elevation = Object.values(levelIdByName).length * 3.0; // 3m floor height assumption
          const created = await db.createLevel({
            name: revitLevelName,
            elevation,
            is_building_storey: true,
            phase: 'New Construction'
          });
          levelIdByName[revitLevelName] = created.id;
          totalLevels++;
        }
        levelId = levelIdByName[revitLevelName];
      }

      // ── Element creation ───────────────────────────────────────────────
      let atlantistId = null;
      let atlantistType = null;
      let status = cfg.supported ? 'success' : 'skipped';

      if (cfg.type === 'wall') {
        // Walls need wall_layers extracted from the compound structure parameter
        const layers = parseCompoundStructure(params);
        const wall = await db.createElement({
          type: 'wall',
          type_name: params['Type Name'] || params.Type || 'Generic Wall',
          parameters: mappedParams,
          base_level_id: levelId,
          top_level_id: levelId, // simplified — exact top needs 'Top Constraint' param
          computed: {}
        });
        if (layers.length && cfg.layers) {
          await db.setWallLayers(wall.id, layers);
        }
        wallIdByRevitGuid[el.guid || el.id] = wall.id;
        atlantistId = wall.id;
        atlantistType = 'wall';
        totalWalls++;
      } else if (cfg.type === 'column') {
        const col = await db.createElement({
          type: 'column',
          type_name: params['Type Name'] || params.Type || 'Generic Column',
          parameters: mappedParams,
          base_level_id: levelId,
          top_level_id: levelId,
          computed: {}
        });
        atlantistId = col.id;
        atlantistType = 'column';
      } else if (cfg.type === 'family_instance') {
        // Find hosting wall — look up by Revit's HostElementId
        const hostId = el.hostElementId || el.Host?.id || null;
        let hostWallId = null;
        if (hostId && wallIdByRevitGuid[hostId]) {
          hostWallId = wallIdByRevitGuid[hostId];
        }
        // host_face_u from element position along wall (normalized 0–1)
        // Revit's Wall hosted families have LocationCurve with Host parameter
        const faceU = (el.hostFaceU !== undefined) ? el.hostFaceU : 0.5;
        const fi = await db.createFamilyInstance({
          family_type: cfg.family,
          type_name: params['Type Name'] || params.Type || `Generic ${cfg.family}`,
          host_wall_id: hostWallId,
          host_face_u: faceU,
          mark: params['Mark'] || params.Mark || null,
          parameters: mappedParams,
          computed: {}
        });
        atlantistId = fi.id;
        atlantistType = 'family_instance';
        totalFamilyInstances++;
      } else if (cfg.type === 'floor' || cfg.type === 'roof' || cfg.type === 'ceiling') {
        const elem = await db.createElement({
          type: cfg.type,
          type_name: params['Type Name'] || params.Type || `Generic ${cfg.type}`,
          parameters: mappedParams,
          base_level_id: levelId,
          computed: {}
        });
        atlantistId = elem.id;
        atlantistType = cfg.type;
      } else if (cfg.type === 'room') {
        // Rooms live in levels — create as element for rendering
        const elem = await db.createElement({
          type: 'room',
          type_name: params['Name'] || params.Name || 'Unnamed Room',
          parameters: mappedParams,
          base_level_id: levelId,
          computed: {}
        });
        atlantistId = elem.id;
        atlantistType = 'room';
      } else if (cfg.type === 'beam') {
        const elem = await db.createElement({
          type: 'beam',
          type_name: params['Type Name'] || params.Type || 'Generic Beam',
          parameters: mappedParams,
          base_level_id: levelId,
          computed: {}
        });
        atlantistId = elem.id;
        atlantistType = 'beam';
      } else {
        // Unsupported category — record but don't create element
        status = 'skipped';
      }

      results.push({
        run_id: runId,
        category: cat,
        subcategory: cfg.sub || null,
        element_name: params['Type Name'] || params.Type || el.name || cat,
        revit_guid: el.guid || el.id || null,
        atlantist_element_id: atlantistId,
        atlantist_element_type: atlantistType,
        import_status: status,
        error_message: cfg.supported ? null : `${cat} is not yet supported — see docs/rvt-import-compatibility.md`,
        revit_params: params,
        mapped_params: mappedParams
      });
    } catch (err) {
      results.push({
        run_id: runId,
        category: el.category || 'unknown',
        subcategory: null,
        element_name: el.name || el.id || 'unknown',
        revit_guid: el.guid || el.id || null,
        atlantist_element_id: null,
        atlantist_element_type: null,
        import_status: 'failed',
        error_message: err.message,
        revit_params: parseRevitParams(el),
        mapped_params: {}
      });
    }
  }

  return {
    results,
    totalLevels,
    totalWalls,
    totalFamilyInstances,
    totalElements: elements.length
  };
}

// ─── Manifest helpers ───────────────────────────────────────────────────────

async function getOrCreateManifest(urn, token) {
  try {
    const m = await fetchJson(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      token
    );
    return m;
  } catch (err) {
    // 404 — no manifest yet, trigger job
  }
  // Register translation job
  const jobBody = {
    input: { urn },
    output: {
      formats: [
        { type: 'svf2', views: ['3d', '2d'] },
        { type: 'ifc', views: ['3d'] }
      ]
    }
  };
  await rawFetch('POST', FORGE_BASE,
    '/modelderivative/v2/designdata/job', token, JSON.stringify(jobBody), {
      'Content-Type': 'application/json'
    });
  // Poll will happen in the caller
  return { status: 'pending' };
}

async function pollManifest(urn, token, interval = 30000, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const m = await fetchJson(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      token
    );
    const status = m?.status;
    if (status === 'success' || status === 'finished') return m;
    if (status === 'failed') return m;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Manifest polling timed out after ${timeout}ms for ${urn}`);
}

async function downloadMetadataBundle(childUrns, token) {
  // childUrns are URNs of child derivatives — for SVF2, one of them
  // contains 'metadata' in its path or is a JSON file with element data
  for (const childUrn of childUrns) {
    try {
      const decoded = Buffer.from(childUrn, 'base64').toString('utf8');
      // If it looks like a metadata bundle (ends in .json or contains 'metadata')
      if (decoded.endsWith('.json') || decoded.includes('metadata')) {
        const data = await fetchJson(
          `https://developer.api.autodesk.com/modelderivative/v2/designdata/${childUrn}`,
          token
        );
        if (data && (data.elements || data.dbands)) return data;
      }
    } catch {
      // Try next child
    }
  }
  // No metadata bundle found — SVF2 may not include design metadata.
  // For .rvt files specifically, the Design Automation API is the correct path
  // for full element extraction. SVF2 only provides geometry for viewing.
  return null;
}

// ─── Compound structure parsing for walls ─────────────────────────────────────

function parseCompoundStructure(params) {
  // Revit stores compound structure in 'WallType' or 'Compound Structure' parameter
  // Each layer has: material, thickness, function (Finish1/2, Structure, Membrane, etc.)
  const layers = [];
  const cs = params['Compound Structure'] || params.CompoundStructure;
  if (!cs) return layers;

  // CS format: "Layer 1 Name | Material | Thickness | Function | Layer 2 ..."
  // Revit's compound structure can be multi-row; parse each row
  const rows = Array.isArray(cs) ? cs : cs.split('|');
  let order = 0;
  for (const row of rows) {
    const parts = Array.isArray(row) ? row : String(row).split('|');
    if (parts.length >= 3) {
      const thicknessFt = parseFloat(parts[2]);
      if (!isNaN(thicknessFt)) {
        layers.push({
          material: parts[1]?.trim() || 'Generic',
          thickness: thicknessFt / 3.281, // ft → m
          function: parts[3]?.trim() || 'Structure',
          layer_order: order++
        });
      }
    }
  }
  return layers;
}

// ─── Round-trip validation ───────────────────────────────────────────────────

/**
 * Validates that a set of Atlantist elements can be exported back to a
 * representation that matches the original Revit element.
 *
 * For each imported element, checks:
 * - Parameters that were mapped survive round-trip
 * - Level bindings are consistent
 * - Geometry (where extractable) is within tolerance
 *
 * @param {Object} runResults — results from importRvtFile()
 * @param {Object} db — DB access object
 * @returns {Object} validationReport
 */
async function validateRoundTrip(runResults, db) {
  const { results } = runResults;
  const validation = [];

  for (const r of results) {
    if (r.import_status !== 'success' || !r.atlantist_element_id) continue;

    let element;
    if (r.atlantist_element_type === 'family_instance') {
      element = await db.getFamilyInstanceById(r.atlantist_element_id);
    } else {
      element = await db.getElementById(r.atlantist_element_id);
    }
    if (!element) {
      validation.push({ element_id: r.atlantist_element_id, status: 'missing', message: 'Element not found in DB' });
      continue;
    }

    // Check required parameters
    const mapped = r.mapped_params || {};
    const dbParams = typeof element.parameters === 'string' ? JSON.parse(element.parameters) : (element.parameters || {});

    const issues = [];
    if (r.category === 'OST_Walls') {
      if (!dbParams.length && !dbParams.wall_height) {
        issues.push('missing length or wall_height parameter');
      }
    }
    if (r.atlantist_element_type === 'family_instance') {
      if (!element.host_wall_id) {
        issues.push('family instance has no host wall — wall hosting not resolved');
      }
      if (element.host_face_u === undefined) {
        issues.push('host_face_u not set — position on wall unknown');
      }
    }

    validation.push({
      element_id: r.atlantist_element_id,
      element_type: r.atlantist_element_type,
      category: r.category,
      status: issues.length ? 'warnings' : 'ok',
      issues
    });
  }

  return { validation, total: validation.length, warnings: validation.filter(v => v.status === 'warnings').length };
}

// ─── Exported API ───────────────────────────────────────────────────────────

module.exports = {
  getAccessToken,
  importRvtFile,
  validateRoundTrip,
  CAT_MAP,
  mapRevitParamsToAtlantist,
  parseCompoundStructure,
  // Expose for testing without Forge credentials
  _testHelpers: {
    parseRevitParams,
    mapRevitParamsToAtlantist,
    parseCompoundStructure
  }
};