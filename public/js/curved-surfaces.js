/**
 * Atlantist BIM 2.0 — Phase 22: Curved Surface Primitives
 * Geometry math + Three.js mesh builders for:
 *   Hyperboloid (1-sheet, 2-sheet), Paraboloid (elliptic, hyperbolic),
 *   Ruled surfaces, NURBS surfaces, Revolution, Sweep, Loft.
 *   Conic arcs (elliptic, parabolic, hyperbolic) as 2D primitives.
 *
 * Does NOT own: app.js state, WebSocket, DOM events.
 */
import * as THREE from 'three';

// ─── Material cache ───────────────────────────────────────────────────────────
const _matCache = new Map();

export function getCurvedSurfaceMaterial(color = '#7a9cbf', opacity = 1) {
  const key = `${color}_${opacity}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    transparent: opacity < 1,
    opacity,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
    depthWrite: opacity === 1,
  });
  _matCache.set(key, mat);
  return mat;
}

// ─── Surface mesh builder ─────────────────────────────────────────────────────
/**
 * Build Three.js meshes for a curved surface element.
 * Returns an array of THREE.Mesh objects (grouped in a THREE.Group).
 */
export function buildCurvedSurfaceMesh(surface, isSelected) {
  const params = typeof surface.parameters === 'string'
    ? JSON.parse(surface.parameters)
    : (surface.parameters || {});

  const color = surface.color || '#7a9cbf';
  const baseMat = getCurvedSurfaceMaterial(isSelected ? '#4a7dbd' : color);
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.15 });

  const group = new THREE.Group();
  group.userData.surfaceId = surface.id;

  const type = surface.surface_type;
  let meshes = [];

  try {
    if (type === 'hyperboloid_one' || type === 'hyperboloid_two') {
      meshes = buildHyperboloidMeshes(params, baseMat, wireMat, type === 'hyperboloid_two');
    } else if (type === 'paraboloid_elliptic') {
      meshes = buildParaboloidMesh(params, baseMat, wireMat, 'elliptic');
    } else if (type === 'paraboloid_hyperbolic') {
      meshes = buildParaboloidMesh(params, baseMat, wireMat, 'hyperbolic');
    } else if (type === 'ruled') {
      meshes = buildRuledSurfaceMesh(params, baseMat, wireMat);
    } else if (type === 'nurbs') {
      meshes = buildNURBSSurfaceMesh(surface, baseMat, wireMat);
    } else if (type === 'revolution') {
      meshes = buildRevolutionSurfaceMesh(surface, baseMat, wireMat);
    } else if (type === 'sweep') {
      meshes = buildSweepSurfaceMesh(surface, baseMat, wireMat);
    } else if (type === 'loft') {
      meshes = buildLoftSurfaceMesh(surface, baseMat, wireMat);
    } else if (type === 'elliptic_arc' || type === 'parabolic_arc' || type === 'hyperbolic_arc') {
      meshes = buildConicArcMesh(surface, baseMat, wireMat, type);
    } else {
      // Fallback: render a simple curved panel
      meshes = buildGenericCurvedMesh(params, baseMat, wireMat);
    }
  } catch (e) {
    console.warn(`[curved-surfaces] build error for type ${type}:`, e.message);
    return group;
  }

  for (const mesh of meshes) {
    group.add(mesh);
  }

  return group;
}

// ─── Hyperboloid ──────────────────────────────────────────────────────────────
// One-sheet (both nappes share the same surface) or two-sheet (separate shells).
// Parametric: x(u,v) = a*sec(v)*cos(u), y(u,v) = c*tan(v), z(u,v) = a*sec(v)*sin(u)
function buildHyperboloidMeshes(params, baseMat, wireMat, isTwoSheet) {
  const n = parseInt(params.segments_u || 32, 10);
  const m = parseInt(params.segments_v || 24, 10);
  const a = parseFloat(params.radius_a || 2.0);   // equatorial radius
  const c = parseFloat(params.waist_c   || 1.0);   // waist radius (0 = pinched)
  const halfH = parseFloat(params.half_height || 4.0);

  const uStep = (Math.PI * 2) / n;
  const vMin = Math.atan(0.01);
  const vMax = Math.atanc ? Math.atan(halfH / Math.max(c, 0.01)) : Math.atan(halfH);
  const vStep = (vMax - vMin) / m;

  const verts = [];
  const indices = [];

  // Surface of revolution: rotate hyperbola y²/a² - x²/c² = 1 around y-axis
  for (let j = 0; j <= m; j++) {
    const v = vMin + j * vStep;
    const tanV = Math.tan(v);
    const secV = 1 / Math.cos(v);
    const r = a * secV;        // radius at this height
    const y = halfH * tanV;
    for (let i = 0; i <= n; i++) {
      const u = i * uStep;
      verts.push(r * Math.cos(u), y, r * Math.sin(u));
    }
  }

  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const a0 = j * (n + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + n + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, m + 1, n + 1);
}

// ─── Paraboloid ───────────────────────────────────────────────────────────────
// Elliptic:  y = (x²/a² + z²/b²) / p
// Hyperbolic: y = (x²/a² - z²/b²) / p
function buildParaboloidMesh(params, baseMat, wireMat, variant) {
  const n = parseInt(params.segments_u || 24, 10);
  const m = parseInt(params.segments_v || 16, 10);
  const a = parseFloat(params.a || 2.0);
  const b = parseFloat(params.b || 2.0);
  const p = parseFloat(params.p || 0.5);   // focal parameter
  const halfH = parseFloat(params.half_height || 3.0);

  const verts = [];
  const indices = [];
  const uStep = (Math.PI * 2) / n;
  const vMax = Math.sqrt(halfH * p);  // max radial where y = halfH

  for (let j = 0; j <= m; j++) {
    const r = (j / m) * vMax;
    const y = variant === 'elliptic'
      ? (r * r / p)
      : (r * r / p);
    for (let i = 0; i <= n; i++) {
      const u = i * uStep;
      verts.push(r * Math.cos(u), y, r * Math.sin(u));
    }
  }

  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const a0 = j * (n + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + n + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, m + 1, n + 1);
}

// ─── Ruled surface ─────────────────────────────────────────────────────────────
// Sweep a straight line between two curves (guide curves).
function buildRuledSurfaceMesh(params, baseMat, wireMat) {
  const n = parseInt(params.segments_along || 16, 10);  // along the ruling
  const m = parseInt(params.segments_curve || 24, 10);   // along guide curves

  // Guide curves defined by control points
  const curve1 = params.curve1 || [{ x: -4, y: 0, z: -2 }, { x: 0, y: 0, z: 2 }, { x: 4, y: 0, z: -2 }];
  const curve2 = params.curve2 || [{ x: -4, y: 4, z: -2 }, { x: 0, y: 4, z: 2 }, { x: 4, y: 4, z: -2 }];

  // Sample both curves
  const pts1 = sampleLinePoints(curve1, m + 1);
  const pts2 = sampleLinePoints(curve2, m + 1);

  const verts = [];
  const indices = [];

  for (let j = 0; j <= n; j++) {
    const t = j / n;
    for (let i = 0; i <= m; i++) {
      const x = pts1[i].x + t * (pts2[i].x - pts1[i].x);
      const y = pts1[i].y + t * (pts2[i].y - pts1[i].y);
      const z = pts1[i].z + t * (pts2[i].z - pts1[i].z);
      verts.push(x, y, z);
    }
  }

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < m; i++) {
      const a0 = j * (m + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + m + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, n + 1, m + 1);
}

// ─── NURBS surface ─────────────────────────────────────────────────────────────
// control_points: [[x,y,z]...] 2D array (u × v)
// weights: [w0, w1, ...] (optional, defaults to 1)
// degree_u, degree_v: polynomial degree (default 2)
function buildNURBSSurfaceMesh(surface, baseMat, wireMat) {
  const params = typeof surface.parameters === 'string'
    ? JSON.parse(surface.parameters)
    : (surface.parameters || {});

  const ctrlPts = surface.control_points || params.control_points || [];
  const degreeU = parseInt(params.degree_u || 2, 10);
  const degreeV = parseInt(params.degree_v || 2, 10);
  const nU = parseInt(params.segments_u || 20, 10);
  const nV = parseInt(params.segments_v || 20, 10);

  if (ctrlPts.length < 2 || ctrlPts[0].length < 2) {
    // Not enough control points — fall back to generic
    return buildGenericCurvedMesh(params, baseMat, wireMat);
  }

  // Build knot vectors (uniform)
  const knotU = uniformKnots(ctrlPts.length, degreeU);
  const knotV = uniformKnots(ctrlPts[0].length, degreeV);

  const verts = [];
  const indices = [];

  // Evaluate NURBS surface at (nU+1) × (nV+1) parametric points
  for (let iu = 0; iu <= nU; iu++) {
    const u = knotU[degreeU] + (iu / nU) * (knotU[knotU.length - 1 - degreeU] - knotU[degreeU]);
    for (let iv = 0; iv <= nV; iv++) {
      const v = knotV[degreeV] + (iv / nV) * (knotV[knotV.length - 1 - degreeV] - knotV[degreeV]);
      const pt = evaluateNURBS(ctrlPts, knotU, knotV, degreeU, degreeV, u, v, params.weights);
      verts.push(pt.x, pt.y, pt.z);
    }
  }

  for (let iu = 0; iu < nU; iu++) {
    for (let iv = 0; iv < nV; iv++) {
      const a0 = iu * (nV + 1) + iv;
      const a1 = a0 + 1;
      const a2 = a0 + nV + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, nU + 1, nV + 1);
}

// ─── Revolution surface ────────────────────────────────────────────────────────
// Profile curve revolved around an axis (vertical by default).
function buildRevolutionSurfaceMesh(surface, baseMat, wireMat) {
  const profileCurve = surface.profile_curve
    || (typeof surface.parameters === 'string' ? JSON.parse(surface.parameters) : surface.parameters || {}).profile_curve
    || { type: 'line', points: [{ x: 0, y: -4, z: 0 }, { x: 2, y: 4, z: 0 }] };

  const axisStart = surface.axis_start || { x: 0, y: -4, z: 0 };
  const axisEnd   = surface.axis_end   || { x: 0, y:  4, z: 0 };

  const segmentsU = parseInt(surface.parameters?.segments_u || 32, 10);
  const segmentsV = parseInt(surface.parameters?.segments_v || 16, 10);

  // Build axis direction
  const axDX = axisEnd.x - axisStart.x;
  const axDY = axisEnd.y - axisStart.y;
  const axDZ = axisEnd.z - axisStart.z;

  // Sample profile curve
  const profilePts = sampleLinePoints(profileCurve.points || [], segmentsV + 1);

  // Rotate each profile point around the axis
  const verts = [];
  const indices = [];

  for (let j = 0; j <= segmentsV; j++) {
    const pt = profilePts[j] || { x: 0, y: -4 + (8 * j / segmentsV), z: 0 };
    for (let i = 0; i <= segmentsU; i++) {
      const theta = (i / segmentsU) * Math.PI * 2;
      // Rotate point around Y-axis (simplified — assumes axis ~Y)
      const r = Math.sqrt(pt.x * pt.x + pt.z * pt.z);
      const x = r * Math.cos(theta);
      const z = r * Math.sin(theta);
      const y = pt.y;
      verts.push(x, y, z);
    }
  }

  for (let j = 0; j < segmentsV; j++) {
    for (let i = 0; i < segmentsU; i++) {
      const a0 = j * (segmentsU + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + segmentsU + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, segmentsV + 1, segmentsU + 1);
}

// ─── Sweep surface ─────────────────────────────────────────────────────────────
// Profile curve swept along a path curve.
function buildSweepSurfaceMesh(surface, baseMat, wireMat) {
  const params = typeof surface.parameters === 'string'
    ? JSON.parse(surface.parameters)
    : (surface.parameters || {});

  const profileCurve = surface.profile_curve || params.profile_curve
    || { type: 'line', points: [{ x: -0.5, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }] };
  const pathCurve    = surface.path_curve    || params.path_curve
    || { type: 'line', points: [{ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }] };

  const segmentsPath   = parseInt(params.segments_path   || 24, 10);
  const segmentsProf  = parseInt(params.segments_profile || 8, 10);

  const pathPts   = sampleLinePoints(pathCurve.points   || [], segmentsPath + 1);
  const profilePts = sampleLinePoints(profileCurve.points || [], segmentsProf + 1);

  const verts = [];
  const indices = [];

  // Compute path tangents for orientation
  for (let j = 0; j <= segmentsPath; j++) {
    const tangent = computeTangent(pathPts, j, segmentsPath);
    for (let i = 0; i <= segmentsProf; i++) {
      const p = profilePts[i];
      // Build local frame from tangent
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
      const realUp = new THREE.Vector3().crossVectors(right, tangent).normalize();
      const pt = pathPts[j];
      const x = pt.x + p.x * right.x + p.y * realUp.x;
      const y = pt.y + p.x * right.y + p.y * realUp.y;
      const z = pt.z + p.x * right.z + p.y * realUp.z;
      verts.push(x, y, z);
    }
  }

  for (let j = 0; j < segmentsPath; j++) {
    for (let i = 0; i < segmentsProf; i++) {
      const a0 = j * (segmentsProf + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + segmentsProf + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, segmentsPath + 1, segmentsProf + 1);
}

// ─── Loft surface ──────────────────────────────────────────────────────────────
// Smooth surface through a series of cross-section curves.
function buildLoftSurfaceMesh(surface, baseMat, wireMat) {
  const crossSections = surface.loft_cross_sections
    || (typeof surface.parameters === 'string' ? JSON.parse(surface.parameters) : surface.parameters || {}).loft_cross_sections
    || [];

  if (crossSections.length < 2) {
    return buildGenericCurvedMesh(surface.parameters || {}, baseMat, wireMat);
  }

  const n = crossSections.length;   // # cross-sections
  const m = 20;                     // points per section

  const allPts = crossSections.map(cs => sampleLinePoints(cs.points || [], m + 1));

  const verts = [];
  const indices = [];

  for (let j = 0; j < n; j++) {
    for (let i = 0; i <= m; i++) {
      const pt = allPts[j][i] || { x: 0, y: j, z: 0 };
      verts.push(pt.x, pt.y, pt.z);
    }
  }

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < m; i++) {
      const a0 = j * (m + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + m + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, n, m + 1);
}

// ─── Conic arc (2D primitive) ──────────────────────────────────────────────────
// Renders as a thin extruded band along the arc curve.
function buildConicArcMesh(surface, baseMat, wireMat, type) {
  const params = typeof surface.parameters === 'string'
    ? JSON.parse(surface.parameters)
    : (surface.parameters || {});

  const n = parseInt(params.segments || 32, 10);
  const startAngle = parseFloat(params.start_angle || 0);
  const endAngle   = parseFloat(params.end_angle   || Math.PI);
  const radius     = parseFloat(params.radius      || 2.0);
  const height     = parseFloat(params.height      || 0.15);

  const verts = [];
  const indices = [];

  const angleStep = (endAngle - startAngle) / n;

  // Build arc profile (thin rectangular strip)
  for (let i = 0; i <= n; i++) {
    const angle = startAngle + i * angleStep;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    // Bottom vertex
    verts.push(x, y, -height / 2);
    // Top vertex
    verts.push(x, y, height / 2);
  }

  for (let i = 0; i < n; i++) {
    const b0 = i * 2;
    const b1 = b0 + 1;
    const b2 = b0 + 2;
    const b3 = b2 + 1;
    indices.push(b0, b2, b1, b1, b2, b3);
  }

  const mesh = buildMeshFromGeometry(verts, indices, baseMat, wireMat, n + 1, 2)[0];

  // Rotate to lie flat in XZ plane (2D plan display)
  const group = new THREE.Group();
  group.add(mesh);
  group.rotation.x = -Math.PI / 2;
  return [group];
}

// ─── Generic curved panel (fallback) ──────────────────────────────────────────
function buildGenericCurvedMesh(params, baseMat, wireMat) {
  const n = parseInt(params.segments_u || 16, 10);
  const m = parseInt(params.segments_v || 12, 10);
  const width  = parseFloat(params.width  || 4.0);
  const height = parseFloat(params.height || 4.0);
  const curvature = parseFloat(params.curvature || 0.5);

  const verts = [];
  const indices = [];

  for (let j = 0; j <= m; j++) {
    const v = j / m;
    const y = v * height + curvature * Math.sin(v * Math.PI) * height * 0.3;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const x = (u - 0.5) * width;
      verts.push(x, y, 0);
    }
  }

  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const a0 = j * (n + 1) + i;
      const a1 = a0 + 1;
      const a2 = a0 + n + 1;
      const a3 = a2 + 1;
      indices.push(a0, a2, a1, a1, a2, a3);
    }
  }

  return buildMeshFromGeometry(verts, indices, baseMat, wireMat, m + 1, n + 1);
}

// ─── Low-level mesh builder ───────────────────────────────────────────────────
function buildMeshFromGeometry(verts, indices, baseMat, wireMat, rows, cols) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const surfaceMesh = new THREE.Mesh(geometry, baseMat);
  surfaceMesh.castShadow = true;
  surfaceMesh.receiveShadow = true;

  const wireMesh = new THREE.Mesh(geometry.clone(), wireMat);

  return [surfaceMesh, wireMesh];
}

// ─── Curve sampling helpers ───────────────────────────────────────────────────
function sampleLinePoints(points, count) {
  if (!points || points.length < 2) {
    // Default linear path
    return Array.from({ length: count }, (_, i) => ({
      x: -4 + (8 * i / (count - 1)),
      y: 0,
      z: 0,
    }));
  }

  // Resample to desired point count
  const result = [];
  const totalLen = getLineLength(points);
  for (let i = 0; i < count; i++) {
    const t = totalLen > 0 ? (i / (count - 1)) * totalLen : i / (count - 1);
    result.push(pointAtLength(points, t));
  }
  return result;
}

function getLineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += dist3(pts[i - 1], pts[i]);
  }
  return len;
}

function pointAtLength(pts, target) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist3(pts[i - 1], pts[i]);
    if (acc + d >= target) {
      const t = (target - acc) / d;
      return {
        x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
        z: pts[i - 1].z + t * (pts[i].z - pts[i - 1].z),
      };
    }
    acc += d;
  }
  return pts[pts.length - 1];
}

function dist3(a, b) {
  return Math.sqrt(
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2
  );
}

function computeTangent(pts, idx, total) {
  if (pts.length < 2) return new THREE.Vector3(1, 0, 0);
  const prev = pts[Math.max(idx - 1, 0)];
  const next = pts[Math.min(idx + 1, pts.length - 1)];
  return new THREE.Vector3(
    next.x - prev.x,
    next.y - prev.y,
    next.z - prev.z
  ).normalize();
}

// ─── NURBS helpers ────────────────────────────────────────────────────────────
function uniformKnots(controlPointCount, degree) {
  const n = controlPointCount - 1; // last index
  const total = n + degree + 1;
  const knots = [];
  for (let i = 0; i < total; i++) {
    if (i <= degree) knots.push(0);
    else if (i >= total - degree - 1) knots.push(1);
    else knots.push((i - degree) / (total - 2 * degree - 1));
  }
  return knots;
}

function evaluateNURBS(ctrlPts, knotU, knotV, degU, degV, u, v, weights) {
  const nPts = ctrlPts.length;
  const mPts = ctrlPts[0].length;
  const w = weights || Array.from({ length: nPts }, () => Array(mPts).fill(1));

  let wx = 0, wy = 0, wz = 0, wSum = 0;

  for (let i = 0; i < nPts; i++) {
    for (let j = 0; j < mPts; j++) {
      const nU = basisFunction(i, degU, u, knotU);
      const nV = basisFunction(j, degV, v, knotV);
      const n = nU * nV;
      const wij = (w[i] && w[i][j]) ? w[i][j] : 1;
      const wt = n * wij;
      const pt = ctrlPts[i][j];
      wx += (pt.x || 0) * wt;
      wy += (pt.y || 0) * wt;
      wz += (pt.z || 0) * wt;
      wSum += wt;
    }
  }

  if (wSum < 1e-10) return { x: 0, y: 0, z: 0 };
  return { x: wx / wSum, y: wy / wSum, z: wz / wSum };
}

function basisFunction(i, p, u, knots) {
  if (p === 0) {
    return (u >= knots[i] && u < knots[i + 1]) ? 1 : 0;
  }
  let left = 0, right = 0;
  if (knots[i + p] - knots[i] > 1e-10) {
    left = ((u - knots[i]) / (knots[i + p] - knots[i])) * basisFunction(i, p - 1, u, knots);
  }
  if (knots[i + p + 1] - knots[i + 1] > 1e-10) {
    right = ((knots[i + p + 1] - u) / (knots[i + p + 1] - knots[i + 1])) * basisFunction(i + 1, p - 1, u, knots);
  }
  return left + right;
}

// ─── 2D plan view helper ──────────────────────────────────────────────────────
// Returns a THREE.Group with 2D line art for the plan view.
export function buildCurvedSurface2DLine(surface) {
  const group = new THREE.Group();
  const params = typeof surface.parameters === 'string'
    ? JSON.parse(surface.parameters)
    : (surface.parameters || {});

  const type = surface.surface_type;
  const segments = parseInt(params.segments_u || 32, 10);

  const points = [];
  const step = (Math.PI * 2) / segments;

  for (let i = 0; i <= segments; i++) {
    const t = i * step;
    if (type === 'hyperboloid_one' || type === 'hyperboloid_two') {
      const r = parseFloat(params.radius_a || 2.0);
      points.push(new THREE.Vector3(r * Math.cos(t), 0, r * Math.sin(t)));
    } else if (type.startsWith('paraboloid')) {
      const maxR = parseFloat(params.a || 2.0);
      points.push(new THREE.Vector3(maxR * Math.cos(t), 0, maxR * Math.sin(t)));
    } else if (type === 'elliptic_arc' || type === 'parabolic_arc' || type === 'hyperbolic_arc') {
      const r = parseFloat(params.radius || 2.0);
      points.push(new THREE.Vector3(r * Math.cos(t), 0, r * Math.sin(t)));
    } else {
      // Generic plan — ellipse outline
      const a = parseFloat(params.width  || 4) / 2;
      const b = parseFloat(params.height || 4) / 2;
      points.push(new THREE.Vector3(a * Math.cos(t), 0, b * Math.sin(t)));
    }
  }

  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0x7a9cbf });
  group.add(new THREE.Line(geo, mat));

  return group;
}

// ─── Toolbar UI ────────────────────────────────────────────────────────────────
const SURFACE_TYPES = [
  { value: 'hyperboloid_one',    label: 'Hyperboloid (1-Sheet)', icon: '⌔' },
  { value: 'hyperboloid_two',    label: 'Hyperboloid (2-Sheet)', icon: '⌔' },
  { value: 'paraboloid_elliptic',label: 'Paraboloid (Elliptic)',  icon: '◡' },
  { value: 'paraboloid_hyperbolic',label:'Paraboloid (Hyperbolic)', icon: '◣' },
  { value: 'ruled',              label: 'Ruled Surface',           icon: '⤢' },
  { value: 'nurbs',              label: 'NURBS Surface',           icon: '∿' },
  { value: 'revolution',          label: 'Revolution',             icon: '↻' },
  { value: 'sweep',              label: 'Sweep',                  icon: '→' },
  { value: 'loft',               label: 'Loft',                   icon: '⋕' },
  { value: 'elliptic_arc',        label: 'Elliptic Arc (2D)',       icon: '○' },
  { value: 'parabolic_arc',       label: 'Parabolic Arc (2D)',      icon: '∩' },
  { value: 'hyperbolic_arc',      label: 'Hyperbolic Arc (2D)',     icon: '∪' },
];

export function getSurfaceTypeLabel(value) {
  const found = SURFACE_TYPES.find(t => t.value === value);
  return found ? found.label : value;
}

export function getSurfaceTypeIcon(value) {
  const found = SURFACE_TYPES.find(t => t.value === value);
  return found ? found.icon : '◈';
}

export function getAllSurfaceTypes() {
  return SURFACE_TYPES;
}