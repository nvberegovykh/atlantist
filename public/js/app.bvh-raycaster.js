/**
 * BVH-accelerated raycasting — bolt-on, replaces nothing.
 * Uses three-mesh-bvh to accelerate element picking on large models.
 * Exports bvhRaycast(ray, scene) → intersected BVHMesh or null.
 *
 * Fix 2026-05-30: Removed non-existent serializeMesh import.
 * Correct API: geometry.boundsTree = new MeshBVH(geometry) + acceleratedRaycast patch.
 */
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// Patch THREE raycasting globally to use BVH acceleration
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ─── BVH cache keyed by scene UUID ───────────────────────────────────────────
const _bvhCache = new Map(); // sceneUUID → { meshMap: Map<uuid, mesh> }
let _bvhReady = false;

// ─── Build BVH for all meshes in a scene ──────────────────────────────────────
export function buildBVH(scene) {
  const meshes = [];
  scene.traverse(obj => {
    if (obj.isMesh && !obj.userData.isBVHRoot && !obj.userData.noBVH) {
      meshes.push(obj);
    }
  });
  if (!meshes.length) return null;

  const meshMap = new Map();
  meshes.forEach(m => {
    if (m.geometry && !m.geometry.boundsTree) {
      try { m.geometry.boundsTree = new MeshBVH(m.geometry); } catch (_) {}
    }
    meshMap.set(m.uuid, m);
  });

  _bvhCache.set(scene.uuid, { meshMap });
  _bvhReady = true;
  return true;
}

// ─── Update BVH cache when scene changes ─────────────────────────────────────
export function refreshBVH(scene) {
  const entry = _bvhCache.get(scene.uuid);
  if (entry) {
    entry.meshMap.forEach(m => { if (m.geometry?.boundsTree) m.geometry.boundsTree = null; });
    _bvhCache.delete(scene.uuid);
  }
  return buildBVH(scene);
}

// ─── Raycast using BVH — returns closest hit or null ─────────────────────────
export function bvhRaycast(ray, scene) {
  const entry = _bvhCache.get(scene.uuid);
  if (!entry) return null;
  const { meshMap } = entry;

  const raycaster = new THREE.Raycaster();
  raycaster.ray.copy(ray);
  const hits = [];
  raycaster.intersectObjects(Array.from(meshMap.values()), false, hits);
  if (!hits.length) return null;

  const hit = hits[0];
  let obj = hit.object;
  while (obj && !meshMap.has(obj.uuid) && obj.parent) obj = obj.parent;
  return { ...hit, object: obj, pickMesh: meshMap.get(obj?.uuid) };
}

// ─── Quick BVH raycast for element picking (pickMap-aware) ───────────────────
export function bvhPick(ray, scene, pickMap) {
  const hit = bvhRaycast(ray, scene);
  if (!hit) return null;
  return pickMap.get(hit.object?.uuid) ?? null;
}

// ─── Dev console access ───────────────────────────────────────────────────────
window.__atlBVH = {
  build: buildBVH,
  refresh: refreshBVH,
  raycast: bvhRaycast,
  pick: bvhPick,
  ready: () => _bvhReady,
};

// ─── Auto-build BVH after scene is fully populated ────────────────────────────
export function initBVH() {
  if (window._atlantist_scenes?.main) buildBVH(window._atlantist_scenes.main);
  if (typeof window.rebuildScene === 'function') {
    const orig = window.rebuildScene;
    window.rebuildScene = function (...args) {
      const r = orig.apply(this, args);
      try { if (window._atlantist_scenes?.main) refreshBVH(window._atlantist_scenes.main); } catch (_) {}
      return r;
    };
  }
}
