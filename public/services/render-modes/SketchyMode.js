/**
 * SketchyMode.js — RP-2: Hand-drawn sketch render mode
 *
 * OWNS: EdgesGeometry extraction, custom GLSL jitter shader, category-based line widths.
 * DOES NOT OWN: scene graph construction, renderer lifecycle, pane layout.
 */

import * as THREE from 'three';

// ── Category → line color map ─────────────────────────────────────────────────
export const SKETCH_COLORS = {
  wall:    0x2a2a2a,
  column:  0x1a1a1a,
  floor:   0x3a3a3a,
  door:    0x6a4a2a,
  window:  0x3a5a6a,
  stair:   0x2a2a2a,
  railing: 0x4a4a4a,
  beam:    0x2a2a2a,
  roof:    0x3a3a3a,
  ceiling: 0x4a4a4a,
  curved:  0x3a3a3a,
  mep:     0x4a5060,
  unknown: 0x555555,
};

// ── Line width by element type ────────────────────────────────────────────────
export const SKETCH_LINE_WIDTH = {
  wall:    1.5,
  column:  2.0,
  beam:    1.8,
  door:    1.0,
  window:  1.0,
  floor:   1.0,
  roof:    1.5,
  ceiling: 1.0,
  stair:   1.2,
  railing: 1.2,
  curved:  1.0,
  mep:     0.8,
  unknown: 1.0,
};

// ── Vertex shader — hand-drawn jitter ─────────────────────────────────────────
const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uJitterAmount;
  uniform float uFrequency;
  uniform float uLineWidth;

  // Fast 2D hash noise — no texture needed
  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main() {
    vec3 pos = position;
    // Jitter amplitude scales with position frequency → smaller lines jitter less
    float amp = uJitterAmount * (1.0 + noise2(pos.xy * uFrequency + uTime * 0.4) * 0.8);
    vec2 seed = pos.xy * uFrequency + uTime * 0.15;
    float jx = (noise2(seed)               - 0.5) * amp;
    float jy = (noise2(seed + vec2(17.3,  9.1)) - 0.5) * amp;
    float jz = (noise2(seed + vec2( 5.7, 23.9)) - 0.5) * amp * 0.5;
    pos.x += jx;
    pos.y += jy;
    pos.z += jz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

// ── Fragment shader — solid category color ────────────────────────────────────
const FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  void main() {
    gl_FragColor = vec4(uColor, 1.0);
  }
`;

/**
 * getCategory(geo) — derive sketch category from geometry name tag.
 */
export function getCategory(geo) {
  if (!geo) return 'unknown';
  const n = geo.name || '';
  if (n.startsWith('wall_'))    return 'wall';
  if (n.startsWith('col_'))     return 'column';
  if (n.startsWith('floor_'))   return 'floor';
  if (n.startsWith('door_'))   return 'door';
  if (n.startsWith('window_'))  return 'window';
  if (n.startsWith('stair_'))   return 'stair';
  if (n.startsWith('rail_'))    return 'railing';
  if (n.startsWith('beam_'))    return 'beam';
  if (n.startsWith('roof_'))    return 'roof';
  if (n.startsWith('ceiling_')) return 'ceiling';
  if (n.startsWith('curved_'))  return 'curved';
  if (n.startsWith('mep_'))     return 'mep';
  return 'unknown';
}

// ── Material cache (per category, per jitter config) ──────────────────────────
const _matCache = new Map(); // key: `${cat}_${jitterAmount}` → THREE.ShaderMaterial

let _jitterUniforms = null; // shared time uniforms — updated per frame

/**
 * getSketchMaterial(category) — returns cached ShaderMaterial for edges.
 * uTime is updated externally via updateTime(uniforms).
 */
export function getSketchMaterial(category) {
  const key = `${category}_jitter`;
  if (_matCache.has(key)) return _matCache.get(key);

  const colorHex = SKETCH_COLORS[category] || SKETCH_COLORS.unknown;
  const color = new THREE.Color(colorHex);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime:        { value: 0 },
      uJitterAmount: { value: 0.012 },
      uFrequency:   { value: 2.5 },
      uLineWidth:   { value: SKETCH_LINE_WIDTH[category] || 1.0 },
      uColor:       { value: color },
    },
  });

  _matCache.set(key, mat);
  return mat;
}

/**
 * updateTime(t) — call each animation frame to animate wobble.
 */
export function updateTime(t) {
  for (const mat of _matCache.values()) {
    mat.uniforms.uTime.value = t;
  }
}

/**
 * extractSketchEdges(mesh) — removes solid mesh fill, returns LineSegments with
 * jitter shader. Returns null if nothing to extract.
 */
export function extractSketchEdges(mesh) {
  if (!mesh?.geometry) return null;

  const cat   = getCategory(mesh.geometry);
  const edges = new THREE.EdgesGeometry(mesh.geometry, 15); // 15° threshold
  if (!edges.attributes.position) return null;

  const lineSeg = new THREE.LineSegments(edges, getSketchMaterial(cat));
  // Carry over mesh world transform
  lineSeg.position.copy(mesh.position);
  lineSeg.rotation.copy(mesh.rotation);
  lineSeg.scale.copy(mesh.scale);
  lineSeg.matrixAutoUpdate = false;
  lineSeg.updateMatrix();

  return lineSeg;
}

/**
 * applySketchMode(scene) — traverse scene, replace solid meshes with edge-only
 * sketch lines. Removes solid fills. Safe to call multiple times (idempotent —
 * only touches meshes that have userData._origMesh !== true).
 */
export function applySketchMode(scene) {
  if (!scene) return;

  const toConvert = [];
  scene.traverse(obj => {
    if (obj.isMesh && !obj.userData._sketchEdge) {
      toConvert.push(obj);
    }
  });

  for (const mesh of toConvert) {
    const sketch = extractSketchEdges(mesh);
    if (sketch) {
      sketch.userData._sketchEdge   = true;
      sketch.userData._origMeshRef = mesh; // keep reference for non-sketch restore
      sketch.name = mesh.name;
      sketch.userData.id   = mesh.userData.id;
      sketch.userData.type = mesh.userData.type;
      // Preserve placement in scene hierarchy
      const parent = mesh.parent;
      parent?.remove(mesh);
      parent?.add(sketch);
    }
  }
}

/**
 * restoreSolidMode(scene) — traverse, replace sketch edge lines with original
 * solid meshes (if preserved). Clears _sketchEdge flag.
 */
export function restoreSolidMode(scene) {
  if (!scene) return;
  const toRestore = [];
  scene.traverse(obj => {
    if (obj.isLineSegments && obj.userData._sketchEdge && obj.userData._origMeshRef) {
      toRestore.push(obj);
    }
  });

  for (const sketch of toRestore) {
    const orig = sketch.userData._origMeshRef;
    const parent = sketch.parent;
    parent?.remove(sketch);
    if (orig) parent?.add(orig);
  }
}

/**
 * buildSketchScene(srcScene) — returns a new scene containing only sketch edges
 * for the given scene's meshes. Does not mutate srcScene.
 */
export function buildSketchScene(srcScene) {
  const sketchScene = new THREE.Scene();
  sketchScene.background = new THREE.Color(0xF5F2EA); // cream paper background

  srcScene.traverse(obj => {
    if (obj.isMesh) {
      const sketch = extractSketchEdges(obj);
      if (sketch) sketchScene.add(sketch);
    }
  });

  return sketchScene;
}

// ── CSS paper texture helper ───────────────────────────────────────────────────
/**
 * injectPaperTexture() — injects a CSS class onto all vp-wrap panes for paper overlay.
 * Safe to call multiple times.
 */
export function injectPaperTexture() {
  if (document.getElementById('sketchy-paper-style')) return;
  const style = document.createElement('style');
  style.id = 'sketchy-paper-style';
  style.textContent = `
    .vp-wrap-sketchy {
      background-color: #f5f2ea !important;
    }
    .vp-wrap-sketchy::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      opacity: 0.06;
      background-image:
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
      background-size: 200px 200px;
      mix-blend-mode: multiply;
    }
  `;
  document.head.appendChild(style);
}

export function removePaperTexture() {
  document.getElementById('sketchy-paper-style')?.remove();
}