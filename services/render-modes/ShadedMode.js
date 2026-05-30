/**
 * ShadedMode.js — RP-3: PBR shaded render mode (mode 3)
 *
 * OWNS: MeshStandardMaterial factory per BIM category with PBR params,
 *   directional light + PCFSoftShadowMap setup for 3D scenes,
 *   optional edge-overlay pass for pane UI toggle.
 * DOES NOT OWN: scene graph construction, camera setup, renderer lifecycle.
 */

// ── PBR roughness / metalness per BIM category ──────────────────────────────────
const CATEGORY_PBR = {
  wall:    { roughness: 0.8, metalness: 0.0 },
  column:  { roughness: 0.6, metalness: 0.0 },
  floor:   { roughness: 0.9, metalness: 0.0 },
  door:    { roughness: 0.7, metalness: 0.0 },
  window:  { roughness: 0.1, metalness: 0.0 },  // glass — low roughness, non-metallic
  stair:   { roughness: 0.7, metalness: 0.0 },
  railing: { roughness: 0.4, metalness: 0.0 },
  beam:    { roughness: 0.6, metalness: 0.0 },
  roof:    { roughness: 0.85, metalness: 0.0 },
  ceiling: { roughness: 0.8, metalness: 0.0 },
  curved:  { roughness: 0.75, metalness: 0.0 },
  mep:     { roughness: 0.3, metalness: 0.9 },   // metal MEP — glossy steel
  unknown: { roughness: 0.7, metalness: 0.0 },
};

// ── Per-category base colors (neutral architectural palette) ────────────────────
const CATEGORY_COLOR = {
  wall:    0xD4CFC6,
  column:  0xB8B0A0,
  floor:   0xC8C4B4,
  door:    0xB49060,
  window:  0x70A8D8,  // translucent blue tint for glass
  stair:   0xB8B0A0,
  railing: 0xA09888,
  beam:    0xACAA9A,
  roof:    0xC0B8A8,
  ceiling: 0xD4D0C4,
  curved:  0xC8C2B6,
  mep:     0x909AA8,
  unknown: 0xBBBBBB,
};

function _getCategory(geo) {
  if (!geo) return 'unknown';
  const n = geo.name || '';
  if (n.startsWith('wall_'))    return 'wall';
  if (n.startsWith('col_'))     return 'column';
  if (n.startsWith('floor_'))   return 'floor';
  if (n.startsWith('door_'))    return 'door';
  if (n.startsWith('window_'))  return 'window';
  if (n.startsWith('stair_'))   return 'stair';
  if (n.startsWith('rail_'))    return 'railing';
  if (n.startsWith('beam_'))    return 'beam';
  if (n.startsWith('roof_'))    return 'roof';
  if (n.startsWith('ceiling_')) return 'ceiling';
  if (n.startsWith('curved_'))  return 'curved';
  if (n.startsWith('mep_'))    return 'mep';
  return 'unknown';
}

// ── Material cache (key: `${cat}_${envMapKey}`) ───────────────────────────────
const _matCache = new Map();

export function getShadedMaterial(geo) {
  const cat = _getCategory(geo);
  const key = `shaded_${cat}`;
  if (_matCache.has(key)) return _matCache.get(key);

  const pbr = CATEGORY_PBR[cat] || CATEGORY_PBR.unknown;
  const color = CATEGORY_COLOR[cat] || CATEGORY_COLOR.unknown;
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: pbr.roughness,
    metalness: pbr.metalness,
    side: THREE.FrontSide,
    envMapIntensity: 0.3,
  });
  _matCache.set(key, mat);
  return mat;
}

// ── Directional light factory for shadow casting ────────────────────────────────
// Creates a sun-style light positioned above scene centroid, casting PCFSoft
// shadows that cover the full scene bounds.
export function createShadedLight(sceneBounds, intensity = 2.5) {
  // sceneBounds: { min: THREE.Vector3, max: THREE.Vector3 } from scene bbox
  const cx = (sceneBounds.min.x + sceneBounds.max.x) * 0.5;
  const cy = sceneBounds.max.y + (sceneBounds.max.y - sceneBounds.min.y) * 0.5;
  const cz = (sceneBounds.min.z + sceneBounds.max.z) * 0.5;

  const dx = sceneBounds.max.x - sceneBounds.min.x;
  const dz = sceneBounds.max.z - sceneBounds.min.z;
  const diag = Math.sqrt(dx * dx + dz * dz);
  const halfSize = Math.max(diag * 0.6, 10);

  const dirLight = new THREE.DirectionalLight(0xFFF5E8, intensity);
  dirLight.position.set(cx + 5, cy, cz + 8);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = Math.max(diag * 3, 80);
  dirLight.shadow.camera.left = -halfSize;
  dirLight.shadow.camera.right = halfSize;
  dirLight.shadow.camera.top = halfSize;
  dirLight.shadow.camera.bottom = -halfSize;
  dirLight.shadow.camera.updateProjectionMatrix();
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.normalBias = 0.02;

  // Soft shadows — PCFSoftShadowMap set on renderer; this controls blur passes
  dirLight.shadow.radius = 4;

  return dirLight;
}

// ── Scene bounds helper ────────────────────────────────────────────────────────
export function computeSceneBounds(scene) {
  const box = new THREE.Box3();
  box.setFromObject(scene);
  return box.isEmpty()
    ? { min: new THREE.Vector3(-10, 0, -10), max: new THREE.Vector3(10, 10, 10) }
    : box;
}

// ── Edge overlay pass (toggle) ─────────────────────────────────────────────────
// Draws thin wireframe outlines over shaded surfaces for drafting feel.
// Uses THREE.EdgesGeometry + LineSegments — cheaper than a second render pass.
const _edgeOverlays = new Map(); // paneId → { scene, meshes[] }

export function applyEdgeOverlay(paneId, scene, color = 0x111111, thickness = 1.0) {
  // Remove existing overlay for this pane
  removeEdgeOverlay(paneId);

  const overlayScene = new THREE.Scene();
  scene.traverse(obj => {
    if (obj.isMesh && !obj.userData._noEdge) {
      const edges = new THREE.EdgesGeometry(obj.geometry, 15);
      const lineMat = new THREE.LineBasicMaterial({
        color,
        linewidth: thickness,
        transparent: true,
        opacity: 0.6,
      });
      const wireframe = new THREE.LineSegments(edges, lineMat);
      wireframe.position.copy(obj.position);
      wireframe.rotation.copy(obj.rotation);
      wireframe.scale.copy(obj.scale);
      overlayScene.add(wireframe);
    }
  });

  _edgeOverlays.set(paneId, { scene: overlayScene, meshes: overlayScene.children });
  return overlayScene;
}

export function removeEdgeOverlay(paneId) {
  const existing = _edgeOverlays.get(paneId);
  if (existing) {
    existing.meshes.forEach(m => {
      m.geometry.dispose();
      m.material.dispose();
    });
    _edgeOverlays.delete(paneId);
  }
}

export function getEdgeOverlay(paneId) {
  return _edgeOverlays.get(paneId)?.scene ?? null;
}

// ── Performance tier detection ────────────────────────────────────────────────
// Returns true if device can handle full SSAO (desktop with dedicated GPU)
export function isSSAORecommended() {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // Tablet / mobile — disable SSAO
  if (/tablet|ipad|android|mobile/i.test(ua)) return false;
  // Check device memory hint (available in some browsers)
  const mem = navigator.deviceMemory;
  if (mem != null && mem < 4) return false;
  return true;
}

// ── Dispose ────────────────────────────────────────────────────────────────────
export function disposeShadedMaterials() {
  _matCache.forEach(m => m.dispose());
  _matCache.clear();
  _edgeOverlays.forEach(([, data]) => {
    data.meshes.forEach(m => {
      m.geometry.dispose();
      m.material.dispose();
    });
  });
  _edgeOverlays.clear();
}