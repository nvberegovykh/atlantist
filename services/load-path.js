/**
 * Load Path Service — structural load path traceability and lateral system detection.
 * Owns: load path graph construction, span validation, lateral system detection.
 * Does NOT own: DB persistence (db/attachments.js), structural analysis (services/structural-engine.js).
 *
 * Load path: roof → floor slabs → beams → columns → footings
 * Lateral system: shear walls or moment frames required for buildings >1 story.
 * System flags missing bearing and unsupported spans.
 */
const { getModuleDerived } = require('./module-system');

// ─── Load path order (top to bottom) ─────────────────────────────────────────
const LOAD_PATH_ORDER = ['roof', 'floor_slab', 'beam', 'column', 'footing'];
const LOAD_TYPE_DEFAULT = 'dead';

// ─── Element type classification ─────────────────────────────────────────────
function classifyElement(element) {
  const type = (element.type || '').toLowerCase();
  const name = (element.type_name || '').toLowerCase();

  if (name.includes('roof') || type === 'roof') return 'roof';
  if (name.includes('slab') || name.includes('floor') || type === 'floor') return 'floor_slab';
  if (name.includes('beam') || type === 'beam') return 'beam';
  if (name.includes('column') || type === 'column') return 'column';
  if (name.includes('footing') || name.includes('foundation') || type === 'footing') return 'footing';
  if (name.includes('wall') || type === 'wall') return 'wall';

  return null;
}

// ─── Build load path edges from elements ─────────────────────────────────────
/**
 * Given project elements, build load path directed edges.
 * Returns array of { from_element_id, to_element_id, load_magnitude_kn, load_type }
 */
function buildLoadPathEdges(elements) {
  const edges = [];
  const byType = {};
  const byId = {};

  for (const el of elements) {
    const cat = classifyElement(el);
    if (!cat) continue;
    if (!byType[cat]) byType[cat] = [];
    byType[cat].push(el);
    byId[el.id] = el;
  }

  // Roof → Floor Slab: roof rests on floor slabs (by vertical proximity)
  const slabs = byType.floor_slab || [];
  const roofs = byType.roof || [];
  for (const roof of roofs) {
    const roofZ = roof.position?.elevation || 0;
    for (const slab of slabs) {
      const slabZ = slab.position?.elevation || 0;
      if (Math.abs(slabZ - roofZ) < 500) { // within 500mm vertically
        edges.push({
          from_element_id: roof.id,
          to_element_id: slab.id,
          load_type: 'roof',
          load_magnitude_kn: 0.5, // default estimate
        });
      }
    }
  }

  // Floor Slab → Beam: slab bears on beam
  const beams = byType.beam || [];
  for (const slab of slabs) {
    const slabZ = slab.position?.elevation || 0;
    const slabX = slab.position?.x || 0;
    const slabZx = slab.position?.z || 0;
    for (const beam of beams) {
      const beamZ = beam.position?.elevation || 0;
      const beamX = beam.position?.x || 0;
      const beamZx = beam.position?.z || 0;
      // Beam is below slab (within 300mm), within M/4 in XZ
      const dx = Math.abs(beamX - slabX);
      const dz = Math.abs(beamZx - slabZx);
      if (beamZ < slabZ && Math.abs(beamZ - slabZ) < 300 && dx < 500 && dz < 500) {
        edges.push({
          from_element_id: slab.id,
          to_element_id: beam.id,
          load_type: 'dead',
          load_magnitude_kn: 0.3,
        });
      }
    }
  }

  // Beam → Column: beam bears on column
  const columns = byType.column || [];
  for (const beam of beams) {
    const beamZ = beam.position?.elevation || 0;
    const beamX = beam.position?.x || 0;
    const beamZx = beam.position?.z || 0;
    for (const col of columns) {
      const colZ = col.position?.elevation || 0;
      const colX = col.position?.x || 0;
      const colZx = col.position?.z || 0;
      // Column is below beam, within M/4 in XZ
      const dx = Math.abs(colX - beamX);
      const dz = Math.abs(colZx - beamZx);
      if (colZ < beamZ && dx < 250 && dz < 250) {
        edges.push({
          from_element_id: beam.id,
          to_element_id: col.id,
          load_type: 'dead',
          load_magnitude_kn: 0.2,
        });
      }
    }
  }

  // Column → Footing: column bears on footing
  const footings = byType.footing || [];
  for (const col of columns) {
    const colZ = col.position?.elevation || 0;
    const colX = col.position?.x || 0;
    const colZx = col.position?.z || 0;
    for (const foot of footings) {
      const footZ = foot.position?.elevation || 0;
      const footX = foot.position?.x || 0;
      const footZx = foot.position?.z || 0;
      if (footZ < colZ && Math.abs(footZ - colZ) < 500 && Math.abs(footX - colX) < 250 && Math.abs(footZx - colZx) < 250) {
        edges.push({
          from_element_id: col.id,
          to_element_id: foot.id,
          load_type: 'dead',
          load_magnitude_kn: 0.1,
        });
      }
    }
  }

  return edges;
}

// ─── Detect missing support ───────────────────────────────────────────────────
/**
 * For each element, check if it has a support below in the load path.
 * Returns array of elements with has_missing_support = true.
 */
function detectMissingSupport(elements, edges, M_mm = 1000) {
  const derived = getModuleDerived(M_mm);
  const downstream = new Map(); // elementId → array of supported element IDs

  for (const edge of edges) {
    if (!downstream.has(edge.from_element_id)) downstream.set(edge.from_element_id, []);
    downstream.get(edge.from_element_id).push(edge.to_element_id);
  }

  const missing = [];

  for (const el of elements) {
    const cat = classifyElement(el);
    if (!cat || cat === 'roof' || cat === 'footing') continue; // top and bottom of path

    // Check if element has downstream support (something below it)
    const hasSupport = downstream.has(el.id) && downstream.get(el.id).length > 0;
    // Also check: does something point TO this element?
    const hasUpstream = edges.some(e => e.to_element_id === el.id);

    // Element needs to both: (a) support things above it, OR (b) be supported by things below
    // A beam should have columns below it
    // A column should have footings below it
    // A slab should have beams below it

    if (!hasSupport && cat !== 'footing') {
      // No elements below — potential missing support
      // But only flag if it's not at the very top
      const hasUpstreamEdge = edges.some(e => e.from_element_id === el.id);
      if (hasUpstreamEdge || cat === 'wall') {
        missing.push({ element: el, reason: `No structural support detected below ${cat} element` });
      }
    }
  }

  return missing;
}

// ─── Detect lateral system ─────────────────────────────────────────────────────
/**
 * Detect if building has lateral load resisting system (shear walls or moment frames).
 * Required for buildings >1 story.
 * Returns { hasLateral: boolean, lateralElements: array, missingSystem: boolean }
 */
function detectLateralSystem(elements, M_mm = 1000) {
  const levels = new Set();
  for (const el of elements) {
    if (el.base_level_id) levels.add(el.base_level_id);
  }

  const numStories = levels.size;

  const lateralTypes = new Set();
  const lateralElements = [];

  for (const el of elements) {
    const name = (el.type_name || '').toLowerCase();
    const props = el.parameters || {};

    if (name.includes('shear_wall') || name.includes('shear wall') || props.is_lateral === true) {
      lateralTypes.add('shear_wall');
      lateralElements.push(el);
    }
    if (name.includes('moment_frame') || name.includes('moment frame') || props.lateral_system_type === 'moment_frame') {
      lateralTypes.add('moment_frame');
      lateralElements.push(el);
    }
    if (name.includes('brace') || name.includes('braced')) {
      lateralTypes.add('braced_frame');
      lateralElements.push(el);
    }
    if (name.includes('core') || name.includes('stairwell')) {
      lateralTypes.add('core');
      lateralElements.push(el);
    }
  }

  const hasLateral = lateralTypes.size > 0;
  const missingSystem = numStories > 1 && !hasLateral;

  return {
    hasLateral,
    lateralTypes: Array.from(lateralTypes),
    lateralElements,
    numStories,
    missingSystem,
    message: missingSystem
      ? `Building has ${numStories} stories but no lateral load-resisting system detected. Shear walls or moment frames required.`
      : hasLateral
        ? `Lateral system detected: ${Array.from(lateralTypes).join(', ')}`
        : 'Single-story building — lateral system not required.',
  };
}

// ─── Validate load path trace ─────────────────────────────────────────────────
/**
 * Trace load path from a starting element to ground.
 * Returns array of { element, load_to_ground_kn } ordered top-to-bottom.
 */
function traceLoadPath(startElementId, elements, edges) {
  const byId = {};
  for (const el of elements) byId[el.id] = el;

  const path = [];
  let currentId = startElementId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const el = byId[currentId];
    if (!el) break;

    const cat = classifyElement(el);
    path.push({ element: el, category: cat });

    // Find next element below
    const nextEdge = edges.find(e => e.from_element_id === currentId);
    currentId = nextEdge ? nextEdge.to_element_id : null;
  }

  return path;
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  LOAD_PATH_ORDER,
  classifyElement,
  buildLoadPathEdges,
  detectMissingSupport,
  detectLateralSystem,
  traceLoadPath,
};