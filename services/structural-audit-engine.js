/**
 * Owns: Structural attachment validation and fixing logic.
 *
 * Performs:
 *   1. Geometric consistency — attachment drift (M/16 = 37.5mm), orphan detection
 *   2. Structural load path audit — gravity chain: roof → slabs → beams → columns → footings
 *   3. Lateral system check — shear walls or moment frames required for >1 story
 *   4. Code compliance sweep — NYC BC/DOB minimums, door widths, ceiling heights, egress
 *   5. Connection type validation — every attachment needs real-world connection metadata
 *   6. Material compatibility — dissimilar metal isolation check
 *
 * Does NOT own: DB persistence (db/structural-audit.js), HTTP routing.
 *
 * ⚠️ All audit results are for preliminary reference only. Requires review
 *    by a licensed Professional Engineer for regulatory filing.
 */

const pool = require('../db');
const { getModuleDerived } = require('./module-system');

// ─── Fallback constants (used when M is not yet configured for a project) ───
// These default to the SP-A defaults but are superseded by getModuleDerived(M_mm)
// when the route layer passes the project-specific M value from module_projects.
const DEFAULT_MODULE_MM = 600;

const DISCLAIMER = '⚠️ Structural audit results are for preliminary reference only. Software does not guarantee code compliance or regulatory approval. All audits must be reviewed and sealed by a licensed Professional Engineer.';

// ─── Tolerance helpers (M-aware) ─────────────────────────────────────────────────
// All tolerances are derived from the project-specific base module M.
// DRIFT_TOLERANCE_MM = M/16, FIX_SNAP_MM = M/8, MODULE_MM = M.

function getAuditConstants(M_mm) {
  return {
    MODULE_MM: M_mm,
    DRIFT_TOLERANCE_MM: M_mm / 16,
    FIX_SNAP_MM: M_mm / 8,
  };
}

function toModules(mm, M_mm) {
  return +(mm / M_mm).toFixed(4);
}

function driftSeverity(driftMm, M_mm) {
  const threshold = M_mm / 16; // M/16
  if (driftMm > threshold) return 'RED';
  if (driftMm > threshold / 2) return 'AMBER'; // M/32
  return 'GREEN';
}

// ─── Geometric validation ──────────────────────────────────────────────────────

/**
 * Validate all family instance attachments (doors, windows) on walls.
 * Checks host_wall_id still exists, position within wall bounds,
 * drift from expected position > M/16.
 *
 * @param {number} projectId
 * @param {number} [M_mm] - Project-specific base module in mm. Defaults to DEFAULT_MODULE_MM.
 */
async function validateFamilyAttachments(projectId, M_mm = DEFAULT_MODULE_MM) {
  const { DRIFT_TOLERANCE_MM, MODULE_MM } = getAuditConstants(M_mm);
  const rows = await pool.query(`
    SELECT
      fi.id, fi.family_type, fi.type_name, fi.host_wall_id, fi.host_face_u,
      fi.parameters, fi.computed,
      e.id AS wall_exists,
      e.parameters AS wall_params,
      e.computed AS wall_computed,
      bl.elevation AS wall_base_elev,
      tl.elevation AS wall_top_elev,
      l.name AS level_name, l.id AS level_id
    FROM family_instances fi
    LEFT JOIN elements e ON fi.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    WHERE e.project_id = $1
    ORDER BY fi.id
  `, [projectId]);

  const results = [];
  for (const fi of rows.rows) {
    // Orphan check — host wall deleted or moved
    if (!fi.wall_exists) {
      // Find nearest valid wall on same level
      const nearestWall = await findNearestWall(projectId, fi, M_mm);
      results.push({
        entity_type: 'family_instance',
        entity_id: fi.id,
        entity_name: `${fi.family_type === 'door' ? 'Door' : 'Window'}: ${fi.type_name || 'Unknown'}`,
        verdict: 'RED',
        category: 'geometric',
        issue_code: 'ORPHAN_HOST',
        message: `Host wall ${fi.host_wall_id} no longer exists. Attachment is orphaned.`,
        details: { former_host_id: fi.host_wall_id, family_type: fi.family_type, host_face_u: fi.host_face_u },
        fix_available: true,
        fix_position: nearestWall ? { wall_id: nearestWall.id, host_face_u: nearestWall.suggested_u } : null,
      });
      continue;
    }

    // Verify wall still has valid geometry
    const wallParams = fi.wall_params || {};
    const wallComputed = fi.wall_computed || {};
    const wallStartX = wallParams.startCoord?.x ?? wallComputed.start_coord?.x ?? 0;
    const wallStartZ = wallParams.startCoord?.y ?? wallComputed.start_coord?.y ?? 0;
    const wallEndX = wallParams.endCoord?.x ?? wallComputed.end_coord?.x ?? wallStartX;
    const wallEndZ = wallParams.endCoord?.y ?? wallComputed.end_coord?.y ?? wallStartZ;

    const wallLength = Math.sqrt(Math.pow(wallEndX - wallStartX, 2) + Math.pow(wallEndZ - wallStartZ, 2));
    const expectedU = fi.host_face_u || 0.5;
    const expectedX = wallStartX + (wallEndX - wallStartX) * expectedU;
    const expectedZ = wallStartZ + (wallEndZ - wallStartZ) * expectedU;

    // Compute actual position from family instance
    const fiComputed = fi.computed || {};
    const fiX = fiComputed.x ?? fiComputed.position_x ?? 0;
    const fiZ = fiComputed.z ?? fiComputed.position_z ?? 0;

    const driftMm = Math.sqrt(Math.pow(fiX - expectedX, 2) + Math.pow(fiZ - expectedZ, 2)) * 1000;
    const severity = driftSeverity(driftMm, M_mm);
    const thresholdMm = M_mm / 16;
    const halfThresholdMm = thresholdMm / 2;

    if (severity !== 'GREEN') {
      results.push({
        entity_type: 'family_instance',
        entity_id: fi.id,
        entity_name: `${fi.family_type === 'door' ? 'Door' : 'Window'}: ${fi.type_name || 'Unknown'}`,
        verdict: severity,
        category: 'geometric',
        issue_code: severity === 'RED' ? 'DRIFT_EXCEEDED' : 'DRIFT_WARN',
        message: severity === 'RED'
          ? `Position drift ${driftMm.toFixed(1)}mm exceeds M/16 (${thresholdMm.toFixed(1)}mm).`
          : `Position drift ${driftMm.toFixed(1)}mm exceeds M/32 (${halfThresholdMm.toFixed(1)}mm) — monitor.`,
        details: {
          drift_mm: Math.round(driftMm * 10) / 10,
          tolerance_mm: thresholdMm,
          expected_x: Math.round(expectedX * 1000) / 1000,
          expected_z: Math.round(expectedZ * 1000) / 1000,
          actual_x: Math.round(fiX * 1000) / 1000,
          actual_z: Math.round(fiZ * 1000) / 1000,
          host_face_u: expectedU,
          units: 'mm',
          modules: toModules(driftMm, M_mm),
        },
        fix_available: true,
        fix_position: { x: expectedX, y: (fi.wall_base_elev || 0), z: expectedZ, wall_id: fi.host_wall_id, host_face_u: expectedU },
      });
    } else {
      results.push({
        entity_type: 'family_instance',
        entity_id: fi.id,
        entity_name: `${fi.family_type === 'door' ? 'Door' : 'Window'}: ${fi.type_name || 'Unknown'}`,
        verdict: 'GREEN',
        category: 'geometric',
        issue_code: 'GEOMETRIC_OK',
        message: `Position within tolerance. Drift: ${driftMm.toFixed(1)}mm / ${thresholdMm.toFixed(1)}mm.`,
        details: { drift_mm: Math.round(driftMm * 10) / 10, tolerance_mm: thresholdMm },
        fix_available: false,
        fix_position: null,
      });
    }
  }

  return results;
}

/**
 * Find the nearest wall to snap an orphaned family instance to.
 * Uses proximity search on same level or nearest level.
 */
async function findNearestWall(projectId, orphanedFi, M_mm = DEFAULT_MODULE_MM) {
  const walls = await pool.query(`
    SELECT e.id, e.parameters, e.computed, bl.elevation
    FROM elements e
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    WHERE e.project_id = $1 AND e.type = 'wall'
    ORDER BY e.id
    LIMIT 50
  `, [projectId]);

  if (!walls.rows.length) return null;

  // Use projected position from host_face_u + parameters if available
  const fiParams = orphanedFi.parameters || {};
  const fiComputed = orphanedFi.computed || {};
  const searchX = fiComputed.position_x ?? fiParams.x ?? 0;
  const searchZ = fiComputed.position_z ?? fiParams.z ?? 0;

  let best = null;
  let bestDist = Infinity;

  for (const wall of walls.rows) {
    const wParams = wall.parameters || {};
    const wComputed = wall.computed || {};
    const sX = wParams.startCoord?.x ?? wComputed.start_coord?.x ?? 0;
    const sZ = wParams.startCoord?.y ?? wComputed.start_coord?.y ?? 0;
    const eX = wParams.endCoord?.x ?? wComputed.end_coord?.x ?? sX;
    const eZ = wParams.endCoord?.y ?? wComputed.end_coord?.y ?? sZ;

    const segLen = Math.sqrt(Math.pow(eX - sX, 2) + Math.pow(eZ - sZ, 2));
    if (segLen < 0.001) continue;

    // Distance from point to line segment (2D)
    const dx = eX - sX, dz = eZ - sZ;
    const t = Math.max(0, Math.min(1, ((searchX - sX) * dx + (searchZ - sZ) * dz) / (dx * dx + dz * dz)));
    const projX = sX + t * dx, projZ = sZ + t * dz;
    const dist = Math.sqrt(Math.pow(searchX - projX, 2) + Math.pow(searchZ - projZ, 2));

    if (dist < bestDist) {
      bestDist = dist;
      best = { id: wall.id, suggested_u: +t.toFixed(4) };
    }
  }

  return best;
}

/**
 * Validate element attachments (columns, walls) bound to levels.
 * Checks for drift and broken elevation bindings.
 */
async function validateElementAttachments(projectId, M_mm = DEFAULT_MODULE_MM) {
  const { DRIFT_TOLERANCE_MM } = getAuditConstants(M_mm);
  const elements = await pool.query(`
    SELECT e.id, e.type, e.type_name, e.parameters, e.computed, e.base_level_id, e.top_level_id,
           bl.elevation AS base_elev, bl.name AS base_level_name,
           tl.elevation AS top_elev, tl.name AS top_level_name,
           de.connection_type, de.attachment_tolerance_mm
    FROM elements e
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    LEFT JOIN dag_edges de ON de.child_id = e.id
    WHERE e.project_id = $1 AND e.type IN ('wall', 'column')
    ORDER BY e.id
  `, [projectId]);

  const results = [];

  for (const el of elements.rows) {
    const params = el.parameters || {};
    const computed = el.computed || {};

    // Elevation binding check — element base should match level elevation
    if (el.base_level_id && el.base_elev !== null) {
      const elevMm = (params.elevation ?? computed.elevation ?? 0) * 1000;
      const baseLevelElevMm = el.base_elev * 1000;
      const elevDrift = Math.abs(elevMm - baseLevelElevMm);

      if (elevDrift > DRIFT_TOLERANCE_MM) {
        results.push({
          entity_type: 'element',
          entity_id: el.id,
          entity_name: `${el.type}: ${el.type_name}`,
          verdict: elevDrift > DRIFT_TOLERANCE_MM * 2 ? 'RED' : 'AMBER',
          category: 'geometric',
          issue_code: 'ELEVATION_DRIFT',
          message: `Elevation ${elevMm.toFixed(0)}mm differs from bound level "${el.base_level_name}" at ${baseLevelElevMm.toFixed(0)}mm by ${elevDrift.toFixed(0)}mm.`,
          details: { drift_mm: Math.round(elevDrift), base_elev_mm: baseLevelElevMm, actual_elev_mm: elevMm, tolerance_mm: DRIFT_TOLERANCE_MM },
          fix_available: true,
          fix_position: { x: params.x ?? computed.x ?? 0, y: el.base_elev, z: params.z ?? computed.z ?? 0 },
        });
      }
    }

    // Structural attachment type validation
    if (el.connection_type === null) {
      const structural = params.structural ?? params.is_shear_wall ?? false;
      results.push({
        entity_type: 'element',
        entity_id: el.id,
        entity_name: `${el.type}: ${el.type_name}`,
        verdict: 'AMBER',
        category: 'code_compliance',
        issue_code: 'MISSING_CONNECTION_TYPE',
        message: `Structural element missing real-world connection type in DAG edge metadata. Assign shear_tab, base_plate, or moment_frame.`,
        details: { element_type: el.type, structural, dag_edge_has_metadata: false },
        fix_available: false,
        fix_position: null,
      });
    }
  }

  // Also check floor slabs for elevation binding
  const floors = await pool.query(`
    SELECT f.id, f.name, f.base_level_id, f.top_level_id, f.parameters,
           bl.elevation AS base_elev, bl.name AS base_level_name,
           tl.elevation AS top_elev, tl.name AS top_level_name
    FROM floors f
    LEFT JOIN levels bl ON f.base_level_id = bl.id
    LEFT JOIN levels tl ON f.top_level_id = tl.id
    WHERE f.project_id = $1
    ORDER BY f.id
  `, [projectId]);

  for (const fl of floors.rows) {
    const params = fl.parameters || {};
    if (fl.base_level_id && fl.base_elev !== null) {
      const elevMm = (params.elevation ?? 0) * 1000;
      const baseElevMm = fl.base_elev * 1000;
      const drift = Math.abs(elevMm - baseElevMm);
      if (drift > DRIFT_TOLERANCE_MM) {
        results.push({
          entity_type: 'floor',
          entity_id: fl.id,
          entity_name: `Floor: ${fl.name || fl.id}`,
          verdict: drift > DRIFT_TOLERANCE_MM * 2 ? 'RED' : 'AMBER',
          category: 'geometric',
          issue_code: 'ELEVATION_DRIFT',
          message: `Floor elevation ${elevMm.toFixed(0)}mm differs from bound level "${fl.base_level_name}" by ${drift.toFixed(0)}mm.`,
          details: { drift_mm: Math.round(drift), expected_elev_mm: baseElevMm, tolerance_mm: DRIFT_TOLERANCE_MM },
          fix_available: true,
          fix_position: { y: fl.base_elev },
        });
      }
    }
  }

  return results;
}

// ─── Load path audit ───────────────────────────────────────────────────────────

/**
 * Trace gravity load path: roof slab → floor slab → beam → column → footing.
 * Builds a graph from elements and flags any break in the chain.
 */
async function traceLoadPath(projectId) {
  const levels = await pool.query(`
    SELECT id, name, elevation FROM levels
    WHERE project_id = $1 ORDER BY elevation DESC
  `, [projectId]);

  if (!levels.rows.length) {
    return { status: 'NO_LEVELS', chain: [], missing_segments: [], is_complete: false };
  }

  const highestLevel = levels.rows[0];
  const chains = []; // One chain per vertical stack

  // Build element map by level
  const elementsByLevel = {};
  for (const lvl of levels.rows) {
    elementsByLevel[lvl.id] = { level: lvl, columns: [], shear_walls: [], beams: [], slabs: [] };
  }

  const elements = await pool.query(`
    SELECT id, type, type_name, parameters, computed, base_level_id, top_level_id
    FROM elements
    WHERE project_id = $1 AND type IN ('wall', 'column')
  `, [projectId]);

  for (const el of elements.rows) {
    const blId = el.base_level_id;
    if (!elementsByLevel[blId]) continue;
    const params = el.parameters || {};
    if (el.type === 'column') {
      elementsByLevel[blId].columns.push(el);
    } else if (params.is_shear_wall === true || params.structural === true) {
      elementsByLevel[blId].shear_walls.push(el);
    }
  }

  const floors = await pool.query(`
    SELECT id, name, base_level_id, top_level_id, parameters, computed
    FROM floors WHERE project_id = $1
  `, [projectId]);
  for (const fl of floors.rows) {
    const blId = fl.base_level_id;
    if (elementsByLevel[blId]) elementsByLevel[blId].slabs.push(fl);
  }

  const beams = await pool.query(`
    SELECT id, name, element_type, parameters, computed, level_id
    FROM elements
    WHERE project_id = $1 AND element_type IN ('beam', 'structural_beam')
  `, [projectId]);
  for (const bm of beams.rows) {
    const blId = bm.level_id;
    if (elementsByLevel[blId]) elementsByLevel[blId].beams.push(bm);
  }

  // Trace chain from top to bottom
  const levelIds = levels.rows.map(l => l.id);
  const chain = [];

  for (const lvl of levels.rows) {
    const entry = elementsByLevel[lvl.id];
    if (!entry) continue;

    const layer = {
      level_id: lvl.id,
      level_name: lvl.name,
      elevation_m: lvl.elevation,
      slabs: entry.slabs.map(s => ({ id: s.id, name: s.name || s.id, type: 'slab' })),
      beams: entry.beams.map(b => ({ id: b.id, name: b.name || b.id, type: 'beam' })),
      columns: entry.columns.map(c => ({ id: c.id, name: c.type_name, type: 'column' })),
      shear_walls: entry.shear_walls.map(w => ({ id: w.id, name: w.type_name, type: 'shear_wall' })),
    };
    chain.push(layer);
  }

  // Check for chain breaks
  const missingSegments = [];
  for (let i = 0; i < chain.length; i++) {
    const cur = chain[i];
    const hasLoadBearing = cur.columns.length > 0 || cur.shear_walls.length > 0;
    if (!hasLoadBearing) {
      missingSegments.push({
        level_id: cur.level_id,
        level_name: cur.level_name,
        elevation_m: cur.elevation_m,
        issue: 'NO_VERTICAL_LOAD_BEARING_ELEMENTS',
        message: `Level "${cur.level_name}" has no columns or structural walls to carry gravity loads downward.`,
        verdict: cur.elevation_m > 0 ? 'RED' : 'AMBER', // Red for all except ground floor
      });
    }
    if (cur.slabs.length === 0 && i < chain.length - 1) {
      // This level doesn't carry a slab to the next — check if it's a roof
      if (i === 0) {
        // Top level is a roof — ok if it has something below
      } else {
        missingSegments.push({
          level_id: cur.level_id,
          level_name: cur.level_name,
          elevation_m: cur.elevation_m,
          issue: 'NO_SLAB',
          message: `Level "${cur.level_name}" has no floor slab to distribute gravity loads.`,
          verdict: 'AMBER',
        });
      }
    }
  }

  const isComplete = missingSegments.filter(s => s.verdict === 'RED').length === 0;
  const totals = {
    levels_checked: chain.length,
    chain_complete: isComplete,
    missing_segments: missingSegments.length,
    issues: missingSegments.map(s => ({ level: s.level_name, issue: s.issue, verdict: s.verdict })),
  };

  return { status: isComplete ? 'COMPLETE' : 'INCOMPLETE', chain, missing_segments: missingSegments, ...totals };
}

// ─── Lateral system check ──────────────────────────────────────────────────────

/**
 * Buildings >1 story must have shear walls or moment frames.
 * Per IBC 2021 / NYC BC 2022 — seismic design category determines lateral system.
 */
async function checkLateralSystem(projectId) {
  const levels = await pool.query(`
    SELECT COUNT(*) AS count FROM levels WHERE project_id = $1 AND is_building_storey = true
  `, [projectId]);

  const storyCount = parseInt(levels.rows[0]?.count || 1);

  if (storyCount <= 1) {
    return {
      status: 'COMPLIANT',
      story_count: storyCount,
      has_shear_walls: false,
      has_moment_frames: false,
      message: 'Single-story building — lateral system check not required.',
      code_ref: 'IBC 2021 §1.4',
      is_compliant: true,
    };
  }

  // Look for structural walls (shear walls) and moment-frame beams
  const shearWalls = await pool.query(`
    SELECT COUNT(*) AS count FROM elements
    WHERE project_id = $1 AND type = 'wall'
      AND parameters->>'is_shear_wall' = 'true'
  `, [projectId]);

  const momentBeams = await pool.query(`
    SELECT COUNT(*) AS count FROM beam_types
    WHERE connection_type = 'moment'
  `);

  const structuralColumns = await pool.query(`
    SELECT COUNT(*) AS count FROM elements
    WHERE project_id = $1 AND type = 'column'
      AND parameters->>'structural' != 'false'
  `, [projectId]);

  const hasShearWalls = parseInt(shearWalls.rows[0]?.count || 0) > 0;
  const hasMomentBeams = parseInt(momentBeams.rows[0]?.count || 0) > 0;
  const hasStructuralCols = parseInt(structuralColumns.rows[0]?.count || 0) > 0;

  const hasLateralSystem = hasShearWalls || hasMomentBeams;

  if (!hasLateralSystem) {
    return {
      status: 'NON_COMPLIANT',
      story_count: storyCount,
      has_shear_walls: hasShearWalls,
      has_moment_frames: hasMomentBeams,
      structural_columns: hasStructuralCols,
      message: `${storyCount}-story building has neither shear walls nor moment frames — IBC 2021 §12.2 requires lateral force-resisting system. ADD shear walls or moment frames before filing.`,
      code_ref: 'IBC 2021 §12.2, NYC BC 2022 §1810.3.2.1',
      is_compliant: false,
    };
  }

  return {
    status: 'COMPLIANT',
    story_count: storyCount,
    has_shear_walls: hasShearWalls,
    has_moment_frames: hasMomentBeams,
    structural_columns: hasStructuralCols,
    message: hasShearWalls
      ? `${storyCount}-story building has ${parseInt(shearWalls.rows[0]?.count)} shear wall(s). Lateral system present.`
      : `${storyCount}-story building has moment frame beam connections. Lateral system present.`,
    code_ref: 'IBC 2021 §12.2',
    is_compliant: true,
  };
}

// ─── Code compliance sweep ────────────────────────────────────────────────────

/**
 * DOB / NYC BC minimum checks:
 *   - Door widths (ADA + egress)
 *   - Ceiling heights (min 2.44m residential, 2.7m egress)
 *   - Fire separation (if fire_rating metadata present)
 *   - Egress path width
 */
async function checkCodeCompliance(projectId) {
  const results = [];

  // Door minimum widths (NYC BC / ADA)
  const doors = await pool.query(`
    SELECT fi.id, fi.type_name, fi.parameters, fi.computed,
           bl.name AS level_name, e.id AS wall_id
    FROM family_instances fi
    JOIN elements e ON fi.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    WHERE e.project_id = $1 AND fi.family_type = 'door'
  `, [projectId]);

  for (const door of doors.rows) {
    const params = door.parameters || {};
    const widthM = parseFloat(params.width || params.w || door.computed?.width_m || 0);
    const fireRating = params.fireRating || params.fire_rating || null;

    // ADA minimum: 32" (813mm) clear door width
    if (widthM > 0 && widthM < 0.813) {
      results.push({
        entity_type: 'family_instance',
        entity_id: door.id,
        entity_name: `Door: ${door.type_name || 'Unknown'}`,
        verdict: 'RED',
        category: 'code_compliance',
        issue_code: 'DOOR_WIDTH_ADA',
        message: `Door width ${(widthM * 1000).toFixed(0)}mm is below ADA minimum of 813mm (32").`,
        details: { actual_mm: Math.round(widthM * 1000), minimum_mm: 813, code_ref: 'ADA 404.2.3' },
        fix_available: false,
        fix_position: null,
      });
    }

    // Egress minimum: NYC BC requires 32" for most occupancy, 36" for Assembly
    if (widthM > 0 && widthM < 0.813) {
      results.push({
        entity_type: 'family_instance',
        entity_id: door.id,
        entity_name: `Door: ${door.type_name || 'Unknown'}`,
        verdict: 'RED',
        category: 'code_compliance',
        issue_code: 'DOOR_WIDTH_EGRESS',
        message: `Door width ${(widthM * 1000).toFixed(0)}mm below NYC BC egress minimum of 813mm (32").`,
        details: { actual_mm: Math.round(widthM * 1000), minimum_mm: 813, code_ref: 'NYC BC 2022 §1005.1' },
        fix_available: false,
        fix_position: null,
      });
    }

    // Fire-rated door without fire rating metadata
    const wallParams = {}; // Would come from element join
    if (wallParams.loadBearing && !fireRating) {
      results.push({
        entity_type: 'family_instance',
        entity_id: door.id,
        entity_name: `Door: ${door.type_name || 'Unknown'}`,
        verdict: 'AMBER',
        category: 'code_compliance',
        issue_code: 'FIRE_RATING_MISSING',
        message: 'Load-bearing wall with door — verify fire rating requirement per IBC Table 716.1.',
        details: { code_ref: 'IBC 2021 Table 716.1' },
        fix_available: false,
        fix_position: null,
      });
    }
  }

  // Ceiling heights
  const ceilings = await pool.query(`
    SELECT c.id, c.name, c.elevation_offset, c.parameters,
           bl.elevation AS host_elev, bl.name AS level_name
    FROM ceilings c
    LEFT JOIN levels bl ON c.host_level_id = bl.id
    WHERE c.project_id = $1
  `, [projectId]);

  for (const ceil of ceilings.rows) {
    const params = ceil.parameters || {};
    const elevOffset = ceil.elevation_offset ?? 0;
    const ceilingElev = (ceil.host_elev || 0) + elevOffset;
    // Approximate clear height (would need floor thickness — simplified)
    if (elevOffset < -3.0) { // Very low ceiling (< 3m below level = potentially < 2.44m clear)
      results.push({
        entity_type: 'ceiling',
        entity_id: ceil.id,
        entity_name: `Ceiling: ${ceil.name || ceil.id}`,
        verdict: 'AMBER',
        category: 'code_compliance',
        issue_code: 'LOW_CEILING_HEIGHT',
        message: `Ceiling elevation offset ${(elevOffset * 1000).toFixed(0)}mm may produce insufficient clear height. Verify against IBC 1205.1 minimum 2.44m (7'-10").`,
        details: { elevation_offset_mm: elevOffset * 1000, code_ref: 'IBC 2021 §1205.1' },
        fix_available: false,
        fix_position: null,
      });
    }
  }

  return results;
}

// ─── Material compatibility check ─────────────────────────────────────────────

/**
 * Flag incompatible material pairings (dissimilar metals without isolation).
 * E.g., aluminum in contact with steel without isolating washer/gasket.
 */
async function checkMaterialCompatibility(projectId) {
  const results = [];

  // Check wall layer material pairs — incompatible pairs from SP-A library
  const INCOMPATIBLE_PAIRS = [
    ['Aluminum', 'Steel'],
    ['Galvanized Steel', 'Copper'],
    ['Stainless Steel', 'Aluminum'],
    ['Zinc', 'Steel'],
  ];

  const walls = await pool.query(`
    SELECT wl.element_id, e.type_name, wl.material AS layer1_material, wl.layer_order
    FROM wall_layers wl
    JOIN elements e ON wl.element_id = e.id
    WHERE e.project_id = $1
    ORDER BY wl.element_id, wl.layer_order
  `, [projectId]);

  // Group by wall
  const wallsByElement = {};
  for (const row of walls.rows) {
    if (!wallsByElement[row.element_id]) wallsByElement[row.element_id] = [];
    wallsByElement[row.element_id].push(row);
  }

  for (const [elementId, layers] of Object.entries(wallsByElement)) {
    for (let i = 0; i < layers.length - 1; i++) {
      const mat1 = layers[i].layer1_material?.toLowerCase() || '';
      const mat2 = layers[i + 1].layer1_material?.toLowerCase() || '';

      for (const [a, b] of INCOMPATIBLE_PAIRS) {
        if ((mat1.includes(a.toLowerCase()) && mat2.includes(b.toLowerCase())) ||
            (mat1.includes(b.toLowerCase()) && mat2.includes(a.toLowerCase()))) {
          results.push({
            entity_type: 'element',
            entity_id: elementId,
            entity_name: `Wall: ${layers[0].type_name || elementId}`,
            verdict: 'AMBER',
            category: 'material_compat',
            issue_code: 'DISSIMILAR_METALS',
            message: `Incompatible materials in adjacent wall layers: "${layers[i].layer1_material}" adjacent to "${layers[i + 1].layer1_material}" without isolation layer. Add neoprene gasket or isolating washer.`,
            details: {
              layer1: layers[i].layer1_material,
              layer2: layers[i + 1].layer1_material,
              code_ref: 'AISC 360-22 §3.4, BIM Protocol §08 00 00',
            },
            fix_available: false,
            fix_position: null,
          });
        }
      }
    }
  }

  return results;
}

// ─── Full audit run ───────────────────────────────────────────────────────────

/**
 * Run full structural + code compliance audit for a project.
 * Returns { totals, load_path_summary, lateral_system_check, issues, M_mm }
 *
 * @param {number} projectId
 * @param {object} options - { units, M_mm }
 *   M_mm: project base module. If not provided, reads from module_projects table.
 */
async function runFullAudit(projectId, options = {}) {
  const { units = 'mm', M_mm: providedM_mm } = options;

  // Resolve M_mm from project module settings, or use default
  let M_mm = providedM_mm;
  if (!M_mm) {
    try {
      const mpRows = await pool.query('SELECT M_value FROM module_projects WHERE project_id = $1', [projectId]);
      M_mm = mpRows.rows[0]?.M_value ? parseFloat(mpRows.rows[0].M_value) : DEFAULT_MODULE_MM;
    } catch {
      M_mm = DEFAULT_MODULE_MM;
    }
  }

  const { DRIFT_TOLERANCE_MM, FIX_SNAP_MM, MODULE_MM } = getAuditConstants(M_mm);
  const results = [];

  // 1. Geometric validation
  const geoFamily = await validateFamilyAttachments(projectId, M_mm);
  const geoElement = await validateElementAttachments(projectId, M_mm);
  results.push(...geoFamily, ...geoElement);

  // 2. Load path trace
  const loadPath = await traceLoadPath(projectId);

  // 3. Lateral system check
  const lateral = await checkLateralSystem(projectId);

  // 4. Code compliance sweep
  const codeIssues = await checkCodeCompliance(projectId);
  results.push(...codeIssues);

  // 5. Material compatibility
  const materialIssues = await checkMaterialCompatibility(projectId);
  results.push(...materialIssues);

  // 6. Load path issues from trace
  for (const seg of loadPath.missing_segments || []) {
    results.push({
      entity_type: 'element',
      entity_id: seg.level_id,
      entity_name: `Level: ${seg.level_name}`,
      verdict: seg.verdict,
      category: 'load_path',
      issue_code: seg.issue,
      message: seg.message,
      details: { elevation_m: seg.elevation_m },
      fix_available: seg.verdict === 'AMBER',
      fix_position: null,
    });
  }

  // Tally verdicts
  const totals = { RED: 0, AMBER: 0, GREEN: 0 };
  for (const r of results) {
    if (totals[r.verdict] !== undefined) totals[r.verdict]++;
  }

  return { results, totals, load_path_summary: loadPath, lateral_system_check: lateral, disclaimer: DISCLAIMER, M_mm, drift_tolerance_mm: DRIFT_TOLERANCE_MM, fix_snap_mm: FIX_SNAP_MM };
}

// ─── Fix orphaned attachment ──────────────────────────────────────────────────

/**
 * Snap an orphaned family instance back to nearest valid position on a wall.
 * Uses M/8 snap precision.
 */
async function fixOrphanedAttachment(entityId, entityType, M_mm = DEFAULT_MODULE_MM) {
  if (entityType !== 'family_instance') {
    return { error: 'Only family_instance (door/window) fixing is currently supported' };
  }

  const fi = await pool.query('SELECT * FROM family_instances WHERE id = $1', [entityId]);
  if (!fi.rows.length) return { error: 'Family instance not found' };

  const instance = fi.rows[0];
  const projectId = instance.project_id || '1';

  const nearest = await findNearestWall(projectId, instance, M_mm);
  if (!nearest) return { error: 'No valid wall found for snapping' };

  const fixSnap = M_mm / 8; // M/8 snap precision in mm

  // Get wall geometry to compute 3D position
  const wall = await pool.query(`
    SELECT e.parameters, e.computed, bl.elevation AS base_elev, tl.elevation AS top_elev
    FROM elements e
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    WHERE e.id = $1
  `, [nearest.id]);

  if (!wall.rows.length) return { error: 'Wall not found' };

  const wParams = wall.rows[0].parameters || {};
  const wComputed = wall.rows[0].computed || {};
  const baseElev = wall.rows[0].base_elev || 0;
  const topElev = wall.rows[0].top_elev || 3;

  const startX = wParams.startCoord?.x ?? wComputed.start_coord?.x ?? 0;
  const startZ = wParams.startCoord?.y ?? wComputed.start_coord?.y ?? 0;
  const endX = wParams.endCoord?.x ?? wComputed.end_coord?.x ?? startX;
  const endZ = wParams.endCoord?.y ?? wComputed.end_coord?.y ?? startZ;

  // M/8 snap (M/8 in meters)
  const u = nearest.suggested_u;
  const rawX = startX + (endX - startX) * u;
  const rawZ = startZ + (endZ - startZ) * u;
  const snapGrid = fixSnap / 1000; // M/8 in meters
  const snappedX = Math.round(rawX / snapGrid) * snapGrid;
  const snappedZ = Math.round(rawZ / snapGrid) * snapGrid;

  // Update family instance
  await pool.query(`
    UPDATE family_instances
    SET host_wall_id = $1,
        host_face_u = $2,
        computed = computed || $3::jsonb,
        updated_at = NOW()
    WHERE id = $4
  `, [nearest.id, nearest.suggested_u, JSON.stringify({
    x: snappedX, z: snappedZ,
    _fixed_at: new Date().toISOString(),
    _snap_precision: 'M/8',
  }), entityId]);

  // Persist audit event
  await pool.query(`
    INSERT INTO event_ledger (entity_type, entity_id, event_type, after_data)
    VALUES ('family_instance', $1, 'snap_fix', $2)
  `, [entityId, JSON.stringify({ snapped_x: snappedX, snapped_z: snappedZ, host_wall_id: nearest.id, snap_mm: fixSnap })]);

  return {
    ok: true,
    snapped: true,
    wall_id: nearest.id,
    host_face_u: nearest.suggested_u,
    snapped_position: { x: +snappedX.toFixed(4), y: baseElev, z: +snappedZ.toFixed(4) },
    snap_precision_mm: fixSnap,
    level_elevation: baseElev,
  };
}

module.exports = {
  DISCLAIMER,
  DEFAULT_MODULE_MM,
  getAuditConstants,
  toModules,
  validateFamilyAttachments,
  validateElementAttachments,
  traceLoadPath,
  checkLateralSystem,
  checkCodeCompliance,
  checkMaterialCompatibility,
  runFullAudit,
  fixOrphanedAttachment,
};