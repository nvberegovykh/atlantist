/**
 * Owns: DAG constraint solver for parametric binding.
 * When a level's elevation changes, recalculates all bound element heights + stair geometry.
 * Uses DAG edges for explicit constraint graph navigation.
 * Does NOT own: persistence, routing, HTTP transport.
 *
 * DAG topology:
 *   Level (elevation) → Element.height = top_level.elevation - base_level.elevation
 *   Wall.area         = height × length
 *   Wall.volume       = area × thickness
 *   Stair.riser_height = (top_elev - base_elev) / number_of_risers
 *   Stair.going       = number_of_treads × tread_depth
 *   Stair.slope       = atan(total_rise / going)
 */
const { getElementsByLevelId, getElementById, updateElement, getWallLayers, getWallLayersBatch, getRoofLayers } = require('../db/elements');
const { getAllLevels, getAllLevelsByProject, getLevelById } = require('../db/levels');
const { getStairsByLevelId, updateStair } = require('../db/stairs');
const { getFloorById, updateFloor } = require('../db/floors');
const { getCeilingById, updateCeiling } = require('../db/ceilings');
const { getEdgesByParent } = require('../db/dag-edges');

/**
 * Compute derived values for a single element given its level data.
 * Returns updated computed object and merged parameters.
 */
function computeElement(element, baseLevel, topLevel, layers = []) {
  const params = typeof element.parameters === 'string'
    ? JSON.parse(element.parameters)
    : (element.parameters || {});

  const computed = {};

  if (baseLevel && topLevel) {
    const basElev = parseFloat(baseLevel.elevation);
    const topElev = parseFloat(topLevel.elevation);
    computed.height = parseFloat((topElev - basElev).toFixed(4));
  } else {
    computed.height = parseFloat((element.computed?.height || 3).toFixed(4));
  }

  if (element.type === 'wall') {
    const sx = parseFloat(params.startCoord?.x || 0);
    const sy = parseFloat(params.startCoord?.y || 0);
    const ex = parseFloat(params.endCoord?.x || 0);
    const ey = parseFloat(params.endCoord?.y || 0);
    const length = parseFloat(Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2).toFixed(4));

    const totalThickness = layers.length > 0
      ? parseFloat(layers.reduce((sum, l) => sum + parseFloat(l.thickness), 0).toFixed(4))
      : parseFloat(params.thickness || 0.2);

    computed.length = length;
    computed.thickness = totalThickness;
    computed.area = parseFloat((computed.height * length).toFixed(4));
    computed.volume = parseFloat((computed.area * totalThickness).toFixed(4));
  }

  if (element.type === 'roof') {
    const roofStyle = params.roof_style || 'flat';
    const footprint = params.footprint || [];
    if (footprint.length >= 3) {
      computed.area = parseFloat(computePolygonArea(footprint).toFixed(4));
    } else {
      computed.area = parseFloat((params.area_sqm || 0).toFixed(4));
    }
    computed.roof_style = roofStyle;
    computed.pitch = params.pitch_ratio || '0';

    // Ridge/eave for sloped roofs
    if (['gable', 'shed', 'hip', 'gambrel'].includes(roofStyle)) {
      computed.eave_height = parseFloat(params.eave_height || 0);
      computed.ridge_height = parseFloat(params.ridge_height || computed.height);
    }
  }

  return computed;
}

// Shoelace formula for arbitrary polygon area in plan view (XY plane)
function computePolygonArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += (parseFloat(pts[i].x) + parseFloat(pts[j].x)) * (parseFloat(pts[i].y) - parseFloat(pts[j].y));
  }
  return Math.abs(area / 2);
}

/**
 * Recalculate ALL elements bound to the given level (after elevation change).
 * Also recalculates elements bound to any other level that was affected.
 * Returns array of updated elements.
 *
 * Performance: uses batch wall layer fetch (single query for all walls)
 * instead of N+1 per-element queries.
 */
async function recalcElementsForLevel(levelId, projectId) {
  const start = Date.now();
  const elements = await getElementsByLevelId(levelId);

  // Scope levels to project so we never accidentally pull cross-project data.
  // projectId null/undefined → backward-compat returns all levels.
  const levels = await getAllLevels(projectId);
  const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));

  // Batch-fetch wall layers for all wall elements in one query
  const wallIds = elements.filter(el => el.type === 'wall').map(el => el.id);
  const roofIds = elements.filter(el => el.type === 'roof').map(el => el.id);
  const layerMap = await getWallLayersBatch(wallIds);

  const updated = [];
  for (const el of elements) {
    const baseLevel = el.base_level_id ? levelMap[el.base_level_id] : null;
    const topLevel = el.top_level_id ? levelMap[el.top_level_id] : null;
    const layers = el.type === 'wall' ? (layerMap.get(el.id) || [])
                  : el.type === 'roof' ? await getRoofLayers(el.id) : [];

    const newComputed = computeElement(el, baseLevel, topLevel, layers);
    const savedEl = await updateElement(el.id, { computed: newComputed });
    updated.push({ ...savedEl, computed: newComputed });
  }

  const elapsed = Date.now() - start;
  console.log(`[dag-solver] recalc for level ${levelId}: ${elements.length} elements in ${elapsed}ms`);
  return { updated, elapsed };
}

/**
 * Recalculate a single element's computed values.
 * Used after a PATCH to an element's parameters (e.g., thickness, coordinates).
 */
async function recalcElement(elementId) {
  const el = await getElementById(elementId);
  if (!el) return null;

  const projectId = el.project_id;
  const levels = await getAllLevels(projectId);
  const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));
  const baseLevel = el.base_level_id ? levelMap[el.base_level_id] : null;
  const topLevel = el.top_level_id ? levelMap[el.top_level_id] : null;
  const layers = el.type === 'wall' ? await getWallLayers(elementId) : [];

  const newComputed = computeElement(el, baseLevel, topLevel, layers);
  return updateElement(elementId, { computed: newComputed });
}

/**
 * Recalculate ALL elements in the model for a given project (e.g., after bulk level changes).
 */
async function recalcAll(projectId) {
  const start = Date.now();
  const { getAllElementsByProject } = require('../db/elements');
  const levels = await getAllLevels(projectId);
  const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));

  const elements = projectId
    ? await getAllElementsByProject(projectId)
    : await require('../db/elements').getAllElements();

  // Batch wall layers
  const wallIds = elements.filter(el => el.type === 'wall').map(el => el.id);
  const layerMap = await getWallLayersBatch(wallIds);

  const updated = [];
  for (const el of elements) {
    const baseLevel = el.base_level_id ? levelMap[el.base_level_id] : null;
    const topLevel = el.top_level_id ? levelMap[el.top_level_id] : null;
    const layers = el.type === 'wall' ? (layerMap.get(el.id) || []) : [];
    const newComputed = computeElement(el, baseLevel, topLevel, layers);
    const savedEl = await updateElement(el.id, { computed: newComputed });
    updated.push(savedEl);
  }

  const elapsed = Date.now() - start;
  console.log(`[dag-solver] full recalc: ${elements.length} elements in ${elapsed}ms`);
  return { updated, elapsed };
}

/**
 * Recalculate stair geometry when a level elevation changes.
 * Updates total_rise, riser_height, going, and slope_degrees.
 * Returns the updated stair row.
 */
async function recalcStair(stairId) {
  const { getStairById } = require('../db/stairs');
  const stair = await getStairById(stairId);
  if (!stair) return null;

  const baseLevel = stair.base_level_id ? await getLevelById(stair.base_level_id) : null;
  const topLevel  = stair.top_level_id  ? await getLevelById(stair.top_level_id)  : null;
  if (!baseLevel || !topLevel) return stair;

  const baseElev = parseFloat(baseLevel.elevation);
  const topElev  = parseFloat(topLevel.elevation);
  const totalRise = parseFloat((topElev - baseElev).toFixed(3));
  const risers    = parseInt(stair.number_of_risers, 10) || 1;
  const treads    = parseInt(stair.number_of_treads, 10)  || (risers - 1);
  const treadDepth = parseFloat(stair.tread_depth) || 0.275;

  const riserHeight = parseFloat((totalRise / risers).toFixed(4));
  const going       = parseFloat((treads * treadDepth).toFixed(3));
  const slopeDeg    = parseFloat((Math.atan2(totalRise, going) * 180 / Math.PI).toFixed(2));

  return updateStair(stairId, {
    total_rise: totalRise,
    riser_height: riserHeight,
    number_of_treads: treads,
    going: going,
    slope_degrees: slopeDeg,
  });
}

/**
 * Recalculate ALL stairs bound to the given level after elevation change.
 */
async function recalcStairsForLevel(levelId) {
  const start = Date.now();
  const stairs = await getStairsByLevelId(levelId);
  const updated = [];
  for (const stair of stairs) {
    const result = await recalcStair(stair.id);
    if (result) updated.push(result);
  }
  const elapsed = Date.now() - start;
  console.log(`[dag-solver] recalc stairs for level ${levelId}: ${stairs.length} stairs in ${elapsed}ms`);
  return { updated, elapsed };
}

/**
 * Recalculate floor elevation and area when base/top level changes.
 * elevation = base_level.elevation (floor bottom surface).
 * area = from polygon boundary if provided, or from computed thickness.
 */
async function recalcFloor(floorId) {
  const floor = await getFloorById(floorId);
  if (!floor) return null;

  const baseLevel = floor.base_level_id ? await getLevelById(floor.base_level_id) : null;
  if (!baseLevel) return floor;

  const params = typeof floor.parameters === 'string'
    ? JSON.parse(floor.parameters)
    : (floor.parameters || {});

  const thickness = parseFloat(floor.thickness || 0.3);
  const elevation = parseFloat(baseLevel.elevation);

  // Compute area if boundary polygon provided
  let area_sqm = floor.area_sqm;
  if (params.boundary && Array.isArray(params.boundary) && params.boundary.length >= 3) {
    area_sqm = parseFloat(Math.abs(signedPolygonArea(params.boundary)).toFixed(4));
  }

  return updateFloor(floorId, { elevation, area_sqm, thickness });
}

/**
 * Recalculate ceiling elevation when host level changes.
 * ceiling_elevation = host_level.elevation + elevation_offset
 */
async function recalcCeiling(ceilingId) {
  const ceiling = await getCeilingById(ceilingId);
  if (!ceiling) return null;

  const hostLevel = ceiling.host_level_id ? await getLevelById(ceiling.host_level_id) : null;
  if (!hostLevel) return ceiling;

  const params = typeof ceiling.parameters === 'string'
    ? JSON.parse(ceiling.parameters)
    : (ceiling.parameters || {});

  const hostElev = parseFloat(hostLevel.elevation);
  const offset   = parseFloat(ceiling.elevation_offset || 2.7);
  const ceilingElev = hostElev + offset;

  return updateCeiling(ceilingId, { parameters: { ...params, ceiling_elevation: ceilingElev } });
}

/**
 * Recalculate all floors bound to a level when elevation changes.
 */
async function recalcFloorsForLevel(levelId) {
  const { getAllFloors } = require('../db/floors');
  // Note: in production, add a getFloorsByLevelId(indexed query) to avoid scanning all floors
  const floors = await getAllFloors(1); // project_id passed through state — scan & filter
  const bound  = floors.filter(f => f.base_level_id === levelId || f.top_level_id === levelId);
  const updated = [];
  for (const f of bound) {
    const result = await recalcFloor(f.id);
    if (result) updated.push(result);
  }
  console.log(`[dag-solver] recalc floors for level ${levelId}: ${updated.length} floors updated`);
  return { updated };
}

/**
 * Recalculate all ceilings bound to a level when elevation changes.
 */
async function recalcCeilingsForLevel(levelId) {
  const { getAllCeilings } = require('../db/ceilings');
  const ceilings = await getAllCeilings(1);
  const bound    = ceilings.filter(c => c.host_level_id === levelId);
  const updated  = [];
  for (const c of bound) {
    const result = await recalcCeiling(c.id);
    if (result) updated.push(result);
  }
  console.log(`[dag-solver] recalc ceilings for level ${levelId}: ${updated.length} ceilings updated`);
  return { updated };
}

function signedPolygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
  }
  return a / 2;
}

// ─── Async execution wrapper — never blocks the event loop ───────────────

/**
 * Run a DAG recalc in a setImmediate microtask, resolving when complete.
 * UI requests return immediately; recalc happens in background.
 * Performance target: <100ms for 1000-element cascade.
 */
function executeAsync(fn) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    setImmediate(async () => {
      try {
        const result = await fn();
        result._elapsed = Date.now() - start;
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Async version of recalcElementsForLevel — runs in setImmediate microtask.
 * Uses DAG edges (explicit constraint graph) for cascade propagation.
 * Returns immediately; recalc completes in background.
 */
async function recalcElementsForLevelAsync(levelId, projectId) {
  return executeAsync(async () => {
    // Query DAG edges for this level
    const edges = await getEdgesByParent(levelId);
    if (edges.length === 0) {
      return { updated: [], elapsed: 0, via: 'edge_query_empty' };
    }

    // Scope levels to project. projectId null/undefined → backward-compat returns all levels.
    const levels = await getAllLevels(projectId);
    const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));

    // Collect child IDs for batch layer fetch
    const wallIds = [];
    const roofIds = [];
    const elementIds = [];
    for (const edge of edges) {
      if (['wall', 'column', 'roof'].includes(edge.child_type)) {
        elementIds.push(edge.child_id);
        if (edge.child_type === 'wall') wallIds.push(edge.child_id);
        if (edge.child_type === 'roof') roofIds.push(edge.child_id);
      }
    }

    // Batch fetch wall layers
    const layerMap = await getWallLayersBatch(wallIds);
    const updated = [];

    for (const edge of edges) {
      switch (edge.child_type) {
        case 'wall':
        case 'column':
        case 'roof': {
          const el = await getElementById(edge.child_id);
          if (!el) break;
          const baseLevel = el.base_level_id ? levelMap[el.base_level_id] : null;
          const topLevel  = el.top_level_id  ? levelMap[el.top_level_id]  : null;
          const layers = el.type === 'wall' ? (layerMap.get(el.id) || [])
                        : el.type === 'roof' ? await getRoofLayers(el.id) : [];
          const newComputed = computeElement(el, baseLevel, topLevel, layers);
          const saved = await updateElement(el.id, { computed: newComputed });
          updated.push({ ...saved, computed: newComputed });
          break;
        }
        case 'stair': {
          const result = await recalcStair(edge.child_id);
          if (result) updated.push(result);
          break;
        }
        case 'floor': {
          const result = await recalcFloor(edge.child_id);
          if (result) updated.push(result);
          break;
        }
        case 'ceiling': {
          const result = await recalcCeiling(edge.child_id);
          if (result) updated.push(result);
          break;
        }
      }
    }

    const elapsed = Date.now();
    console.log(`[dag-solver] async recalc for level ${levelId}: ${updated.length} elements`);
    return { updated, elapsed, via: 'dag_edges' };
  });
}

/**
 * Async full model recalc — processes all DAG edges.
 * Performance target: <100ms for 1000-element cascade.
 */
async function recalcAllAsync(projectId) {
  return executeAsync(async () => {
    const { getAllElementsByProject } = require('../db/elements');
    const projectIdToUse = projectId;
    const levels = await getAllLevels(projectIdToUse);
    const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));
    const elements = projectId
      ? await getAllElementsByProject(projectId)
      : await getAllElementsByProject(1); // preserve backward compat: all elements if no project

    const wallIds = elements.filter(el => el.type === 'wall').map(el => el.id);
    const layerMap = await getWallLayersBatch(wallIds);

    const updated = [];
    for (const el of elements) {
      const baseLevel = el.base_level_id ? levelMap[el.base_level_id] : null;
      const topLevel  = el.top_level_id  ? levelMap[el.top_level_id]  : null;
      const layers = el.type === 'wall' ? (layerMap.get(el.id) || []) : [];
      const newComputed = computeElement(el, baseLevel, topLevel, layers);
      const saved = await updateElement(el.id, { computed: newComputed });
      updated.push(saved);
    }

    return { updated, count: updated.length };
  });
}

/**
 * Circular dependency detection — uses DB-level cycle detection.
 * Returns cycle path if A→B→C→A detected, null otherwise.
 */
async function detectCircularDependency(parentId, childId) {
  const { detectCycle } = require('../db/dag-edges');
  return detectCycle(parentId, childId);
}

// ─── Phase 22: Curved Surface DAG recalculation ─────────────────────────────────
/**
 * Recalculate curved surface bounds when level elevations change.
 * curved_surface.computed = { height, min_x, max_x, min_z, max_z, area_sqm }
 * Height = top_level.elevation - base_level.elevation (or half_height × 2 for un-bound).
 */
async function recalcCurvedSurface(surfaceId) {
  const { getCurvedSurfaceById, updateCurvedSurface } = require('../db/curved-surfaces');
  const surface = await getCurvedSurfaceById(surfaceId);
  if (!surface) return null;

  const params = typeof surface.parameters === 'string'
    ? JSON.parse(surface.parameters)
    : (surface.parameters || {});

  let baseElevation = 0, topElevation = 0;
  if (surface.base_level_id) {
    const baseLvl = await getLevelById(surface.base_level_id);
    baseElevation = baseLvl ? parseFloat(baseLvl.elevation) : 0;
  }
  if (surface.top_level_id) {
    const topLvl = await getLevelById(surface.top_level_id);
    topElevation = topLvl ? parseFloat(topLvl.elevation) : 0;
  }

  const halfH = parseFloat(params.half_height || 4.0);
  const radiusA = parseFloat(params.radius_a || 2.0);
  const height = surface.top_level_id && surface.base_level_id
    ? topElevation - baseElevation
    : halfH * 2;

  // Approximate surface area based on type
  const segmentsU = parseInt(params.segments_u || 32, 10);
  const segmentsV = parseInt(params.segments_v || 16, 10);
  let areaSqM = Math.PI * radiusA * radiusA; // default: circular footprint
  if (surface.surface_type === 'hyperboloid_one' || surface.surface_type === 'hyperboloid_two') {
    areaSqM = Math.PI * radiusA * halfH * 1.5;
  } else if (surface.surface_type === 'paraboloid_elliptic' || surface.surface_type === 'paraboloid_hyperbolic') {
    areaSqM = (4 / 3) * Math.PI * radiusA * halfH;
  }

  const computed = {
    height: parseFloat(height.toFixed(4)),
    base_elevation: parseFloat(baseElevation.toFixed(4)),
    top_elevation: parseFloat(topElevation.toFixed(4)),
    area_sqm: parseFloat(areaSqM.toFixed(2)),
    segments_u: segmentsU,
    segments_v: segmentsV,
    bounding_box: {
      min_x: -radiusA, max_x: radiusA,
      min_z: -radiusA, max_z: radiusA,
    },
  };

  await updateCurvedSurface(surfaceId, { computed });
  return computed;
}

/**
 * Recalculate all curved surfaces bound to a level after elevation change.
 */
async function recalcCurvedSurfacesForLevel(levelId, projectId) {
  const { getAllCurvedSurfaces } = require('../db/curved-surfaces');
  const surfaces = await getAllCurvedSurfaces(projectId || 1);
  const bound = surfaces.filter(s => s.base_level_id === levelId || s.top_level_id === levelId);
  const updated = [];
  for (const s of bound) {
    const result = await recalcCurvedSurface(s.id);
    updated.push({ id: s.id, computed: result });
  }
  return updated;
}

module.exports = {
  recalcElementsForLevel, recalcElement, recalcAll, computeElement,
  recalcStair, recalcStairsForLevel,
  recalcFloor, recalcCeiling, recalcFloorsForLevel, recalcCeilingsForLevel,
  recalcCurvedSurface, recalcCurvedSurfacesForLevel,
  // Async variants
  recalcElementsForLevelAsync, recalcAllAsync,
  // Cycle detection
  detectCircularDependency,
  // Internal helpers exposed for testing
  executeAsync,
};
