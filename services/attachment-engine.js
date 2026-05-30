/**
 * Attachment Engine — real-world construction connection validation + constraint resolution.
 * Owns: attachment snap, constraint propagation, connection type validation.
 * Does NOT own: UI overlay rendering, DB persistence (db/attachments.js), DAG solver (dag-solver.js).
 *
 * Every attachment corresponds to a REAL construction connection — not just geometric proximity.
 * Uses the connection_type_catalog from the DB to validate attachments at placement time.
 */
const { getModuleDerived } = require('./module-system');

// ─── Attachment Type Definitions ──────────────────────────────────────────────
const ATTACHMENT_TYPES = ['face_to_face', 'edge_to_edge', 'point_to_point', 'center_to_center', 'offset_with_parameter'];

// ─── Snap to nearest on-center spacing ────────────────────────────────────────
/**
 * Given a target position and available anchor candidates, return the best snap point.
 * Prefers standard on-center spacings (16"oc, 24"oc, 48"oc) derived from base module M.
 *
 * @param {number} targetPos - Desired position in mm
 * @param {Array<number>} anchorPositions - Existing anchor positions in mm
 * @param {number} M_mm - Base module in mm
 * @param {string} snapMode - 'fine' (M/8) or 'coarse' (M/4)
 * @returns {object} { snapped: number, snapDelta: number, isSnap: boolean, nearestOC: number }
 */
function snapToOnCenter(targetPos, anchorPositions, M_mm, snapMode = 'fine') {
  const derived = getModuleDerived(M_mm);
  const threshold = snapMode === 'fine' ? derived.snap.fine : derived.snap.coarse;

  // Build candidate positions: all existing anchors ± M multiples
  const candidates = new Set();
  for (const anchor of anchorPositions) {
    candidates.add(anchor);
    for (const mult of [-2, -1, 0, 1, 2, 4, 8]) {
      candidates.add(anchor + mult * M_mm);
    }
  }

  // Also include direct M multiples from origin
  for (const mult of [0, 1, 2, 4, 8, 16]) {
    candidates.add(mult * M_mm);
  }

  // Add standard OC spacings (in mm)
  for (const oc of derived.standardOC_mm) {
    for (let n = 0; n <= 20; n++) {
      candidates.add(n * oc);
    }
  }

  let best = targetPos;
  let bestDist = Infinity;
  let isSnap = false;

  for (const cand of candidates) {
    const dist = Math.abs(cand - targetPos);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }

  if (bestDist <= threshold) {
    isSnap = true;
  }

  // Find nearest standard OC
  const nearestOC = derived.standardOC_mm.reduce((prev, curr) =>
    Math.abs(curr - bestDist) < Math.abs(prev - bestDist) ? curr : prev
  );

  return { snapped: best, snapDelta: best - targetPos, isSnap, nearestOC };
}

// ─── Validate attachment type + connection type ───────────────────────────────
/**
 * Given an attachment pair (host element type, attached element type), return
 * the expected connection_type_code and whether it's structurally valid.
 */
function resolveConnectionType(hostType, attachedType, hostMaterial, attachedMaterial) {
  // Door in wall
  if (attachedType === 'door' && hostType === 'wall') {
    return { code: 'door_in_wall', valid: true, requiresHeader: true };
  }
  // Window in wall
  if (attachedType === 'window' && hostType === 'wall') {
    return { code: 'window_in_wall', valid: true, requiresHeader: true };
  }
  // Wall on slab/floor
  if (hostType === 'floor_slab' && attachedType === 'wall') {
    return { code: 'wall_to_slab', valid: true, requiresBearingCheck: true };
  }
  // Beam on column
  if (hostType === 'column' && attachedType === 'beam') {
    return { code: 'beam_to_column', valid: true, requiresBearingPlate: true };
  }
  // Column on footing
  if (hostType === 'footing' && attachedType === 'column') {
    return { code: 'column_to_footing', valid: true, requiresBasePlate: true };
  }
  // CMU wall without foundation
  if (attachedType === 'wall' && hostMaterial === 'masonry' && !hostType) {
    return { code: 'cmu_wall_to_foundation', valid: false, missingFoundation: true };
  }
  // Slab to beam
  if (hostType === 'beam' && attachedType === 'floor_slab') {
    return { code: 'slab_to_beam', valid: true, shearStudRequired: true };
  }
  // Stair to floor
  if (attachedType === 'stair' && (hostType === 'floor_slab' || hostType === 'beam')) {
    return { code: 'stair_to_floor', valid: true, requiresBearing: true };
  }
  return { code: null, valid: false, reason: 'Unknown attachment combination' };
}

// ─── Check if two elements are within snap range ─────────────────────────────
/**
 * Bounding-box spatial proximity check.
 * @param {object} bboxA - { minX, maxX, minY, maxY, minZ, maxZ } in mm
 * @param {object} bboxB - same
 * @param {number} M_mm - base module
 * @returns {object} { withinRange: boolean, distance: number, closestPoint: object }
 */
function bboxDistance(bboxA, bboxB, M_mm) {
  const derived = getModuleDerived(M_mm);
  const snapRange = derived.snap.attach; // M/8

  const dx = Math.max(0, Math.max(bboxA.minX - bboxB.maxX, bboxB.minX - bboxA.maxX));
  const dy = Math.max(0, Math.max(bboxA.minY - bboxB.maxY, bboxB.minY - bboxA.maxY));
  const dz = Math.max(0, Math.max(bboxA.minZ - bboxB.maxZ, bboxB.minZ - bboxA.maxZ));
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  return {
    withinRange: dist <= snapRange,
    distance: dist,
    dx, dy, dz,
  };
}

// ─── Compute constrained position ─────────────────────────────────────────────
/**
 * Given a host element + attached element + attachment type + offsets,
 * compute the final 3D position of the attached element.
 */
function computeConstrainedPosition(hostPosition, hostRotation, attachmentType, offsets, hostFaceParams) {
  // For face_to_face: project attached element onto host face plane
  // For center_to_center: align centers with offset
  // For point_to_point: snap to exact host face coordinate (face_u, face_v)
  // For edge_to_edge: align edges with tolerance
  // For offset_with_parameter: offset from host by parameter value

  const { face_u = 0.5, face_v = 0.5, face_z = 0 } = hostFaceParams || {};
  const { x = 0, y = 0, z = 0 } = offsets || {};

  // Build face plane from host position + rotation
  const baseX = hostPosition.x + (face_u - 0.5) * (hostPosition.width || 0) + x;
  const baseY = hostPosition.y + (face_v - 0.5) * (hostPosition.height || 0) + y;
  const baseZ = hostPosition.z + face_z + z;

  return { x: baseX, y: baseY, z: baseZ };
}

// ─── Constraint graph operations ──────────────────────────────────────────────
/**
 * Build attachment adjacency list for a project.
 * Returns { byHost: Map<elementId, [attachedElementId]>, byAttached: Map<elementId, hostElementId> }
 */
function buildAdjacencyList(constraints) {
  const byHost = new Map();
  const byAttached = new Map();

  for (const c of constraints) {
    if (!byHost.has(c.host_element_id)) byHost.set(c.host_element_id, []);
    byHost.get(c.host_element_id).push(c.attached_element_id);
    byAttached.set(c.attached_element_id, c.host_element_id);
  }

  return { byHost, byAttached };
}

/**
 * Propagate position change from host to all downstream attached elements.
 * Returns array of { elementId, newPosition } to update.
 */
function propagateHostMove(hostElementId, newPosition, constraints, M_mm) {
  const { byHost } = buildAdjacencyList(constraints);
  const downstream = byHost.get(hostElementId) || [];
  const updates = [];

  for (const attachedId of downstream) {
    const constraint = constraints.find(c => c.host_element_id === hostElementId && c.attached_element_id === attachedId);
    if (!constraint) continue;

    const newPos = computeConstrainedPosition(
      newPosition,
      null,
      constraint.attachment_type,
      { x: constraint.offset_x, y: constraint.offset_y, z: constraint.offset_z },
      { face_u: constraint.host_face_u, face_v: constraint.host_face_v, face_z: constraint.host_face_z }
    );

    updates.push({ elementId: attachedId, newPosition: newPos, constraintId: constraint.id });

    // Recurse downstream
    const childUpdates = propagateHostMove(attachedId, newPos, constraints, M_mm);
    updates.push(...childUpdates);
  }

  return updates;
}

/**
 * Detect cycle in attachment graph (would mean circular dependency).
 */
function detectCycle(constraints) {
  const { byHost } = buildAdjacencyList(constraints);
  const visited = new Set();
  const stack = new Set();

  function dfs(nodeId) {
    if (stack.has(nodeId)) return true;  // cycle
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    stack.add(nodeId);

    const children = byHost.get(nodeId) || [];
    for (const child of children) {
      if (dfs(child)) return true;
    }

    stack.delete(nodeId);
    return false;
  }

  for (const nodeId of byHost.keys()) {
    if (!visited.has(nodeId)) {
      if (dfs(nodeId)) return true;
    }
  }
  return false;
}

// ─── Octree Spatial Index ─────────────────────────────────────────────────────
/**
 * Simple octree for fast nearest-element queries within snap range.
 * Used during drag operations to find nearby attachment candidates efficiently.
 */
class OctreeNode {
  constructor(bounds, depth = 0, maxDepth = 6, maxItems = 8) {
    this.bounds = bounds; // { minX, maxX, minY, maxY, minZ, maxZ }
    this.items = []; // { id, bbox, element }
    this.children = null;
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.maxItems = maxItems;
  }

  _subdivide() {
    const { minX, maxX, minY, maxY, minZ, maxZ } = this.bounds;
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    const mz = (minZ + maxZ) / 2;
    this.children = [
      { minX, maxX: mx, minY, maxY: my, minZ, maxZ: mz },
      { minX: mx, maxX, minY, maxY: my, minZ, maxZ: mz },
      { minX, maxX: mx, minY, maxY: my, minZ: mz, maxZ },
      { minX: mx, maxX, minY, maxY: my, minZ: mz, maxZ },
      { minX, maxX: mx, minY: my, maxY, minZ, maxZ: mz },
      { minX: mx, maxX, minY: my, maxY, minZ, maxZ: mz },
      { minX, maxX: mx, minY: my, maxY, minZ: mz, maxZ },
      { minX: mx, maxX, minY: my, maxY, minZ: mz, maxZ },
    ].map(b => new OctreeNode(b, this.depth + 1, this.maxDepth, this.maxItems));
  }

  _bboxContains(bbox, nodeBounds) {
    return bbox.minX >= nodeBounds.minX && bbox.maxX <= nodeBounds.maxX &&
           bbox.minY >= nodeBounds.minY && bbox.maxY <= nodeBounds.maxY &&
           bbox.minZ >= nodeBounds.minZ && bbox.maxZ <= nodeBounds.maxZ;
  }

  _bboxIntersects(bbox, nodeBounds) {
    return !(bbox.maxX < nodeBounds.minX || bbox.minX > nodeBounds.maxX ||
             bbox.maxY < nodeBounds.minY || bbox.minY > nodeBounds.maxY ||
             bbox.maxZ < nodeBounds.minZ || bbox.minZ > nodeBounds.maxZ);
  }

  insert(id, bbox, element) {
    if (!this._bboxContains(bbox, this.bounds)) return false;

    if (this.children) {
      for (const child of this.children) {
        if (this._bboxContains(bbox, child.bounds)) {
          child.insert(id, bbox, element);
          return true;
        }
      }
      // Doesn't fit in any child — store in this node
      this.items.push({ id, bbox, element });
      return true;
    }

    this.items.push({ id, bbox, element });

    if (this.items.length > this.maxItems && this.depth < this.maxDepth) {
      this._subdivide();
      const items = this.items;
      this.items = [];
      for (const item of items) {
        for (const child of this.children) {
          if (this._bboxContains(item.bbox, child.bounds)) {
            child.insert(item.id, item.bbox, item.element);
            break;
          }
        }
      }
    }
    return true;
  }

  _queryRange(bbox, results) {
    if (!this._bboxIntersects(bbox, this.bounds)) return;

    for (const item of this.items) {
      if (this._bboxIntersects(item.bbox, bbox)) {
        results.push(item);
      }
    }

    if (this.children) {
      for (const child of this.children) {
        child._queryRange(bbox, results);
      }
    }
  }

  queryRange(bbox) {
    const results = [];
    this._queryRange(bbox, results);
    return results;
  }
}

function computeBounds(elements) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const el of elements) {
    const bbox = el.bbox || el.parameters || {};
    const x = el.position?.x || bbox.x || 0;
    const y = el.position?.y || bbox.y || 0;
    const z = el.position?.z || bbox.z || 0;
    const w = bbox.width || 200;
    const h = bbox.height || 3000;
    const d = bbox.depth || 200;
    minX = Math.min(minX, x - w);
    maxX = Math.max(maxX, x + w);
    minY = Math.min(minY, y - h);
    maxY = Math.max(maxY, y + h);
    minZ = Math.min(minZ, z - d);
    maxZ = Math.max(maxZ, z + d);
  }
  return { minX: minX || -50000, maxX: maxX || 50000, minY: minY || -50000, maxY: maxY || 50000, minZ: minZ || -50000, maxZ: maxZ || 50000 };
}

/**
 * Build an octree from element list.
 * @param {Array} elements - Array of element objects with position/bbox
 * @returns {OctreeNode}
 */
function buildOctree(elements) {
  const bounds = computeBounds(elements);
  const tree = new OctreeNode(bounds);
  for (const el of elements) {
    const bbox = el.bbox || el.parameters || {};
    const x = el.position?.x || bbox.x || 0;
    const y = el.position?.y || bbox.y || 0;
    const z = el.position?.z || bbox.z || 0;
    const w = (bbox.width || 200) / 2;
    const h = (bbox.height || 3000) / 2;
    const d = (bbox.depth || 200) / 2;
    tree.insert(el.id, {
      minX: x - w, maxX: x + w,
      minY: y - h, maxY: y + h,
      minZ: z - d, maxZ: z + d,
    }, el);
  }
  return tree;
}

/**
 * Find elements within snap range of a target position.
 * @param {OctreeNode} tree - Pre-built octree
 * @param {object} position - { x, y, z } in mm
 * @param {number} range_mm - Snap search range (typically M/8)
 * @returns {Array} - Elements within range
 */
function queryNearby(tree, position, range_mm) {
  const searchBbox = {
    minX: position.x - range_mm, maxX: position.x + range_mm,
    minY: position.y - range_mm, maxY: position.y + range_mm,
    minZ: position.z - range_mm, maxZ: position.z + range_mm,
  };
  return tree.queryRange(searchBbox);
}

// ─── Connection Metadata Validation ───────────────────────────────────────────
/**
 * Validate structural metadata requirements per connection type.
 * Returns { valid: boolean, issues: string[], required_fields: string[] }
 *
 * Real-world construction connections per ACI/AISC/IBC/NYC BC:
 * - Bearing plate: required for beam-to-column gravity connections
 * - Anchor bolts: required for column-to-footing base plate connections
 * - Shear studs: required for composite slab-to-beam shear connection
 * - Fire rating continuity: wall-to-slab must maintain fire rating through joint
 */
function validateConnectionMetadata(connectionCode, metadata = {}) {
  const issues = [];
  const requiredFields = [];

  switch (connectionCode) {
    case 'beam_to_column': {
      requiredFields.push('bearing_plate_width_mm', 'bearing_plate_thickness_mm', 'connection_type');
      if (!metadata.bearing_plate_width_mm || metadata.bearing_plate_width_mm < 75) {
        issues.push(`Bearing plate width ${metadata.bearing_plate_width_mm || 'undefined'}mm below AISC minimum 75mm — add bearing plate`);
      }
      if (!metadata.bearing_plate_thickness_mm || metadata.bearing_plate_thickness_mm < 10) {
        issues.push(`Bearing plate thickness ${metadata.bearing_plate_thickness_mm || 'undefined'}mm below AISC minimum 10mm — increase plate thickness`);
      }
      if (!metadata.connection_type || !['shear', 'pinned', 'moment', 'bolted', 'welded'].includes(metadata.connection_type)) {
        issues.push(`Connection type must be specified: shear/pinned/moment/bolted/welded per AISC 358`);
      }
      break;
    }
    case 'column_to_footing': {
      requiredFields.push('anchor_bolt_pattern', 'base_plate_size_mm');
      if (!metadata.anchor_bolt_pattern) {
        issues.push('Anchor bolt pattern required per ACI 318-22 §17.4 — specify bolt count and layout');
      }
      if (!metadata.base_plate_size_mm || metadata.base_plate_size_mm < 200) {
        issues.push(`Base plate size ${metadata.base_plate_size_mm || 'undefined'}mm below minimum 200mm for typical column base`);
      }
      if (!metadata.grout_present && metadata.grout_present !== true) {
        issues.push('Grout pad required under base plate per AISC/ACI requirements for uniform bearing');
      }
      break;
    }
    case 'slab_to_beam': {
      requiredFields.push('shear_stud_dia_mm', 'shear_stud_count');
      if (!metadata.shear_stud_dia_mm || metadata.shear_stud_dia_mm < 13) {
        issues.push('Shear stud diameter must be ≥ 13mm per AISC for composite action');
      }
      if (!metadata.shear_stud_count || metadata.shear_stud_count < 1) {
        issues.push('Shear studs required for composite slab-to-beam connection per AISC 360-22 §I3.2');
      }
      if (metadata.composite === false && !issues.some(i => i.includes('composite'))) {
        issues.push('Non-composite slab-to-beam: verify beam alone can support superimposed loads');
      }
      break;
    }
    case 'wall_to_slab': {
      requiredFields.push('fire_rating_continuity');
      if (!metadata.fire_rating_continuity) {
        issues.push('Fire rating continuity through wall-to-slab joint required — rated assemblies must maintain continuity per NYC BC §707.3');
      }
      if (metadata.bearing_length_mm && metadata.bearing_length_mm < 50) {
        issues.push(`Wall bearing length ${metadata.bearing_length_mm}mm below 50mm minimum — increase bearing area`);
      }
      break;
    }
    case 'door_in_wall':
    case 'window_in_wall': {
      if (metadata.opening_width_mm > metadata.header_span_mm && !metadata.header_verified) {
        issues.push(`Opening width ${metadata.opening_width_mm}mm exceeds header span — header sizing verification required per IBC §2308.5.1`);
      }
      if (metadata.sill_height_mm && metadata.sill_height_mm < 24 * 25.4) {
        issues.push(`Sill height ${metadata.sill_height_mm}mm below IBC minimum 24" in hazardous locations`);
      }
      break;
    }
    case 'cmu_wall_to_foundation': {
      requiredFields.push('mortar_type', 'reinforcement');
      if (!metadata.mortar_type) {
        issues.push('Mortar type required for CMU walls per TMS 602: Type S or N for above-grade');
      }
      if (!metadata.reinforcement || metadata.reinforcement === 'none') {
        issues.push('CMU wall reinforcement required for load-bearing or seismic design per TMS 602');
      }
      break;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    required_fields: requiredFields,
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  ATTACHMENT_TYPES,
  snapToOnCenter,
  resolveConnectionType,
  bboxDistance,
  computeConstrainedPosition,
  buildAdjacencyList,
  propagateHostMove,
  detectCycle,
  // Spatial index
  OctreeNode,
  buildOctree,
  queryNearby,
  // Connection metadata validation
  validateConnectionMetadata,
};