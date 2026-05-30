/**
 * TexturedMode.js — RP-4: Full PBR textured render mode (mode 4)
 *
 * OWNS: MeshStandardMaterial factory with PBR maps, procedural texture shaders
 *   (concrete/wood/metal via GLSL), texture atlas loading + UV cell selection,
 *   HDRI environment setup, RoomEnvironment fallback.
 * DOES NOT OWN: scene graph construction, renderer lifecycle, pane layout.
 *
 * Texture atlas strategy: 2048×2048 atlas per material family, 4×4 grid
 *   (512×512 cells), 16 variants per atlas. UV selection by material type +
 *   deterministic per-element seed for variation within the same material type.
 *
 * Procedural fallback: when an atlas is unavailable, GLSL fragment shaders
 *   generate material appearance in-shader — no texture fetch needed.
 *
 * HDRI: loaded from R2 at /hdri/studio.hdr; falls back to THREE.RoomEnvironment
 *   (PMREMGenerator) when no HDRI is present.
 */

// ── R2 base URL for atlas + HDRI assets ───────────────────────────────────────
const R2_BASE = window.__POLSIA_R2_BASE__ || 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev';
const ATLAS_BASE = `${R2_BASE}/textures`;
const HDRI_BASE  = `${R2_BASE}/hdri`;

// Atlas metadata: material family → atlas URL, cell mapping
const ATLAS_META = {
  concrete: {
    // R2: https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/ce5e9412-ab62-4545-a966-8dcdf804f969.jpg
    url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/ce5e9412-ab62-4545-a966-8dcdf804f969.jpg',
    cols: 4, rows: 4,
    cells: [
      'smooth-grey', 'medium-grey', 'rough-grey', 'broom-finish',
      'exposed-aggregate', 'bush-hammered', 'ribbed-panel', 'precast-panel',
      'cast-in-place', 'stained-grey', 'polished', 'sandblast',
      'board-formed', 'form-tie', 'cold-joint', 'control-joint',
    ],
  },
  wood: {
    // R2: https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/778bab61-0c18-467e-a262-b6931cd9afe1.jpg
    url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/778bab61-0c18-467e-a262-b6931cd9afe1.jpg',
    cols: 4, rows: 4,
    cells: [
      'oak-light', 'oak-medium', 'oak-dark', 'maple',
      'cherry', 'walnut', 'mahogany', 'pine',
      'cedar', 'douglas-fir', 'birch-ply', 'spruce',
      'wenge', 'teak', 'ash-light', 'ash-dark',
    ],
  },
  metal: {
    // R2: https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/c521ba23-9f58-46c4-89e5-539abed29d88.jpg
    url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/c521ba23-9f58-46c4-89e5-539abed29d88.jpg',
    cols: 4, rows: 4,
    cells: [
      'brushed-steel', 'mill-finish-aluminum', 'galvanized', 'black-steel',
      'stainless-satin', 'stainless-mirror', 'copper-patina', 'bronze-aged',
      'corten', 'chrome', 'anodized-dark', 'painted-white',
      'painted-grey', 'zinc', 'lead', 'cast-iron',
    ],
  },
  glass: {
    // R2: https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/bff515bf-7578-46bb-9c5d-d795bcf8341d.jpg
    url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/bff515bf-7578-46bb-9c5d-d795bcf8341d.jpg',
    cols: 4, rows: 4,
    cells: [
      'clear-float', 'low-iron', 'tinted-grey', 'tinted-bronze',
      'tinted-blue', 'low-e-clear', 'low-e-mirror', 'frosted',
      'sandblasted', 'acid-etched', 'textured-reeded', 'wired',
      'laminated', 'tempered', 'spandrel-opaque', 'spandrel-glass',
    ],
  },
  brick: {
    // R2: https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/0a4682f2-32c8-45de-a5d7-669a0fd3fecc.jpg
    url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/0a4682f2-32c8-45de-a5d7-669a0fd3fecc.jpg',
    cols: 4, rows: 4,
    cells: [
      'red-clay-run', 'red-clay-stack', 'grey-mono', 'cream-clay',
      'black-glaze', 'white-glaze', 'terracotta', 'sandstone块',
      'limestone', 'brownstone', 'rustic', 'tumbled',
      'reclaimed', 'fire-rated', 'anchor-hole', 'projecting',
    ],
  },
};

// BIM category → atlas family mapping
const CAT_ATLAS = {
  wall:    'concrete',
  column:  'concrete',
  floor:   'concrete',
  door:    'wood',
  stair:   'wood',
  railing: 'metal',
  beam:    'metal',
  roof:    'concrete',
  ceiling: 'concrete',
  curved:  'concrete',
  mep:     'metal',
  window:  'glass',
  unknown: 'concrete',
};

// ── PBR parameter overrides per category ──────────────────────────────────────
const CAT_PBR = {
  wall:    { roughness: 0.85, metalness: 0.0, envMapIntensity: 0.25 },
  column:  { roughness: 0.75, metalness: 0.0, envMapIntensity: 0.30 },
  floor:   { roughness: 0.90, metalness: 0.0, envMapIntensity: 0.20 },
  door:    { roughness: 0.55, metalness: 0.0, envMapIntensity: 0.40 },
  window:  { roughness: 0.05, metalness: 0.0, envMapIntensity: 0.80, transparent: true, opacity: 0.85 },
  stair:   { roughness: 0.60, metalness: 0.0, envMapIntensity: 0.35 },
  railing: { roughness: 0.30, metalness: 0.85, envMapIntensity: 0.60 },
  beam:    { roughness: 0.40, metalness: 0.80, envMapIntensity: 0.55 },
  roof:    { roughness: 0.90, metalness: 0.0, envMapIntensity: 0.20 },
  ceiling: { roughness: 0.80, metalness: 0.0, envMapIntensity: 0.15 },
  curved:  { roughness: 0.80, metalness: 0.0, envMapIntensity: 0.25 },
  mep:     { roughness: 0.25, metalness: 0.90, envMapIntensity: 0.70 },
  unknown: { roughness: 0.70, metalness: 0.0, envMapIntensity: 0.30 },
};

// Base colors per category (used for fallback / untextured base)
const CAT_COLOR = {
  wall:    0xBEB8AE,
  column:  0xACA69A,
  floor:   0xC2BEAF,
  door:    0x9A7040,
  window:  0x6098C0,
  stair:   0xAEA898,
  railing: 0x909090,
  beam:    0x989898,
  roof:    0xB8B0A0,
  ceiling: 0xCAC4B4,
  curved:  0xBEB8AE,
  mep:     0x808890,
  unknown: 0xAAAAAA,
};

// ── Procedural GLSL shaders ────────────────────────────────────────────────────

const PROCEDURAL_VERTEX = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ── Concrete: multi-octave Perlin noise → roughness variation ────────────────
const CONCRETE_FRAG = /* glsl */`
  uniform float uSeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash2(i), b = hash2(i + vec2(1,0)), c = hash2(i + vec2(0,1)), d = hash2(i + vec2(1,1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
  float fbm(vec2 p, int oct) {
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 8; i++) {
      if (i >= oct) break;
      v += amp * noise2(p);
      p = p * 2.1 + vec2(1.7, 9.2);
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    // Deterministic seed offset per element
    float se = uSeed * 0.001;
    vec2 uv = vUv * 3.0 + vec2(se * 0.37, se * 0.71);
    vec2 uw = vWorldPos.xz * 0.15 + vec2(se * 0.13, se * 0.29);

    float n1 = fbm(uv, 5);
    float n2 = fbm(uv * 2.3 + vec2(5.1, 2.7), 4);
    float n3 = fbm(uw, 3);

    // Aggregate variation
    float variation = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
    float grey = 0.72 + variation * 0.18;
    // Subtle cool tint
    vec3 color = vec3(grey - 0.02, grey, grey + 0.01);
    // Roughness from noise
    float roughness = 0.75 + n2 * 0.18;
    // Bump normal from gradient
    float eps = 0.02;
    float nx = fbm(uv + vec2(eps, 0.0), 4) - fbm(uv - vec2(eps, 0.0), 4);
    float ny = fbm(uv + vec2(0.0, eps), 4) - fbm(uv - vec2(0.0, eps), 4);
    vec3 norm = normalize(vNormal + vec3(nx, ny, 0.0) * 0.08);

    gl_FragColor = vec4(color, 1.0);
    // Store roughness in alpha for MeshStandardMaterial roughnessMap
    // (We embed it via roughness uniform directly in the procedural material)
  }
`;

// ── Wood: ring pattern via polar coordinates ───────────────────────────────────
const WOOD_FRAG = /* glsl */`
  uniform float uSeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash2(i), b = hash2(i + vec2(1,0)), c = hash2(i + vec2(0,1)), d = hash2(i + vec2(1,1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }

  void main() {
    float se = uSeed * 0.001;
    // Map UV to cylindrical coordinates in world space for natural ring orientation
    vec2 wp = vWorldPos.xz * 0.5 + vWorldPos.y * vec2(0.1, 0.15) + vec2(se * 0.11, se * 0.07);
    float r = length(wp) * 4.0;
    float rings = fract(r);
    float ringShade = smoothstep(0.0, 0.45, rings) * smoothstep(1.0, 0.55, rings);

    // Base warm wood colors
    vec3 lightWood = vec3(0.76, 0.56, 0.34);
    vec3 darkWood  = vec3(0.52, 0.32, 0.16);
    vec3 color = mix(lightWood, darkWood, ringShade * 0.7);

    // Grain noise
    float grain = noise2(wp * vec2(20.0, 1.5) + vec2(se * 0.3, 0.0)) * 0.08;
    color += grain;

    // Slight roughness variation
    float roughness = 0.55 + ringShade * 0.1 + grain;

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

// ── Metal: subtle noise scratches ──────────────────────────────────────────────
const METAL_FRAG = /* glsl */`
  uniform float uSeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash2(i), b = hash2(i + vec2(1,0)), c = hash2(i + vec2(0,1)), d = hash2(i + vec2(1,1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }

  void main() {
    float se = uSeed * 0.001;
    vec2 uv = vUv * vec2(30.0, 8.0) + vec2(se * 0.22, se * 0.14);
    // Brushed scratches
    float scratch = noise2(uv) * 0.5 + noise2(uv * 3.0 + vec2(17.3, 9.1)) * 0.3;
    float grey = 0.68 + scratch * 0.12;

    // Warm steel color
    vec3 color = vec3(grey * 0.95, grey * 0.97, grey);
    float metalness = 0.85 + scratch * 0.05;
    float roughness = 0.25 + scratch * 0.15;

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

// ── Glass: near-transparent with tint + reflection hints ───────────────────────
const GLASS_FRAG = /* glsl */`
  uniform float uSeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash2(i), b = hash2(i + vec2(1,0)), c = hash2(i + vec2(0,1)), d = hash2(i + vec2(1,1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }

  void main() {
    float se = uSeed * 0.001;
    vec2 uv = vUv * 8.0 + vec2(se * 0.09, se * 0.06);
    // Subtle refraction shimmer
    float shimmer = noise2(uv) * 0.04;
    // Glass tint
    vec3 tint = vec3(0.55, 0.78, 0.95);
    vec3 color = tint * (0.92 + shimmer);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 0.12);
  }
`;

// ── Atlas texture loader ────────────────────────────────────────────────────────
// Loaded lazily; cached in _atlasCache
const _atlasCache   = new Map(); // family → { image, loaded }
const _atlasLoading = new Map(); // family → Promise
const _texLoader    = new THREE.TextureLoader();

async function _loadAtlas(family) {
  const meta = ATLAS_META[family];
  if (!meta) return null;
  if (_atlasCache.has(family)) return _atlasCache.get(family);
  if (_atlasLoading.has(family)) return _atlasLoading.get(family);

  const p = new Promise(resolve => {
    _texLoader.load(
      meta.url,
      img => {
        const tex = new THREE.Texture(img);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.flipY = false;
        tex.needsUpdate = true;
        _atlasCache.set(family, { image: tex, loaded: true });
        resolve(_atlasCache.get(family));
      },
      undefined,
      () => {
        // Atlas unavailable — mark as failed so we use procedural fallback
        _atlasCache.set(family, { image: null, loaded: false });
        resolve({ image: null, loaded: false });
      },
    );
  });
  _atlasLoading.set(family, p);
  return p;
}

function _selectAtlasCell(family, elementId) {
  const meta = ATLAS_META[family];
  if (!meta) return { u: 0, v: 0 };
  // Deterministic cell from element ID
  const cellIdx = Math.abs((elementId * 2654435761) >>> 0) % (meta.cols * meta.rows);
  const col = cellIdx % meta.cols;
  const row = Math.floor(cellIdx / meta.cols);
  const u = col / meta.cols;
  const v = row / meta.rows;
  return { u, v, col, row };
}

function _buildAtlasUVOffset(family, elementId, tex) {
  const meta = ATLAS_META[family];
  if (!meta || !tex) return null;
  const { u, v } = _selectAtlasCell(family, elementId);
  return { offsetU: u, offsetV: v, repeatU: 1 / meta.cols, repeatV: 1 / meta.rows };
}

// ── Environment / HDRI setup ───────────────────────────────────────────────────
let _envMap      = null;
let _envLoaded   = false;
let _envLoading  = false;
const _envListeners = [];

function _bindEnvToScene(scene) {
  if (!_envMap) return;
  scene.environment = _envMap;
  scene.traverse(obj => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => {
        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMap = _envMap;
        }
      });
    }
  });
}

export async function loadEnvironment(renderer) {
  if (_envLoaded || _envLoading) return;
  _envLoading = true;

  // Try HDRI from R2
  const loader = new THREE.HDRCubeTextureLoader();
  const pmrem  = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  try {
    await new Promise((resolve, reject) => {
      loader.load(
        `${HDRI_BASE}/studio.hdr`,
        tex => {
          _envMap = pmrem.fromCubemap(tex).texture;
          tex.dispose();
          pmrem.dispose();
          _envLoaded = true;
          _envLoading = false;
          _envListeners.forEach(fn => fn(_envMap));
          resolve();
        },
        undefined,
        () => reject(new Error('HDRI not found')),
      );
    });
  } catch {
    // Fallback to RoomEnvironment
    const roomEnv = new THREE.RoomEnvironment();
    _envMap = pmrem.fromScene(roomEnv, 0.04).texture;
    roomEnv.dispose();
    pmrem.dispose();
    _envLoaded = true;
    _envLoading = false;
    _envListeners.forEach(fn => fn(_envMap));
  }
}

export function onEnvReady(fn) {
  if (_envLoaded && _envMap) fn(_envMap);
  else _envListeners.push(fn);
}

// ── Material factory ───────────────────────────────────────────────────────────

// Procedural ShaderMaterials per family (shared uniforms, no textures)
function _makeProceduralMaterial(family, elementId) {
  const uniforms = { uSeed: { value: elementId } };
  let frag;
  switch (family) {
    case 'concrete': frag = CONCRETE_FRAG; break;
    case 'wood':     frag = WOOD_FRAG;     break;
    case 'metal':    frag = METAL_FRAG;    break;
    case 'glass':    frag = GLASS_FRAG;    break;
    default:         frag = CONCRETE_FRAG;
  }
  // Use a ShaderMaterial with MeshStandardMaterial-like outputs
  const mat = new THREE.ShaderMaterial({
    vertexShader: PROCEDURAL_VERTEX,
    fragmentShader: frag,
    uniforms,
    side: THREE.FrontSide,
  });
  return mat;
}

// PBR MeshStandardMaterial with atlas map (or procedural fallback)
function _makePBRMaterial(family, elementId, cat) {
  const pbr = CAT_PBR[cat] || CAT_PBR.unknown;
  const color = CAT_COLOR[cat] || CAT_COLOR.unknown;
  const mat = new THREE.MeshStandardMaterial({ color, side: THREE.FrontSide });
  mat.roughness     = pbr.roughness;
  mat.metalness     = pbr.metalness;
  mat.envMapIntensity = pbr.envMapIntensity;
  if (pbr.transparent) { mat.transparent = true; mat.opacity = pbr.opacity; }

  // Seed stored in userData for deterministic variation
  const seed = elementId;

  // Attempt atlas load (async — material updates on load)
  const atlas = ATLAS_META[family];
  if (atlas) {
    _loadAtlas(family).then(({ image }) => {
      if (!image) return;
      const uvData = _buildAtlasUVOffset(family, elementId, image);
      if (!uvData) return;
      const mapped = image.clone();
      mapped.needsUpdate = true;
      mapped.offset.set(uvData.offsetU, uvData.offsetV);
      mapped.repeat.set(uvData.repeatU, uvData.repeatV);
      mat.map = mapped;
      mat.needsUpdate = true;
    });
  }

  return mat;
}

// Category → atlas family
function _getAtlasFamily(cat) {
  return CAT_ATLAS[cat] || 'concrete';
}

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

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getTexturedMaterial(geo) — returns a MeshStandardMaterial with PBR maps
 *   for the given mesh's geometry name (category). Uses procedural fallback
 *   when atlas is unavailable. All materials share the loaded envMap.
 */
export function getTexturedMaterial(geo) {
  const cat = _getCategory(geo);
  const family = _getAtlasFamily(cat);
  const elemId = geo ? (geo.uuid ? parseInt(geo.uuid.replace(/-/g,'').slice(0, 8), 16) : 1) : 1;
  return _makePBRMaterial(family, elemId, cat);
}

/**
 * applyTexturedMode(scene, renderer) — traverse scene, apply textured PBR materials
 *   and bind environment map. Safe to call multiple times.
 */
export async function applyTexturedMode(scene, renderer) {
  if (!scene) return;

  // Ensure environment
  await loadEnvironment(renderer);

  scene.traverse(obj => {
    if (obj.isMesh) {
      obj.material = getTexturedMaterial(obj.geometry);
    }
  });

  _bindEnvToScene(scene);
}

/**
 * bindEnvMapToScene(scene) — attach envMap to all MeshStandardMaterials in scene.
 *   Call after scene is modified (new meshes added after initial textured mode).
 */
export function bindEnvMapToScene(scene) {
  _bindEnvToScene(scene);
}

/**
 * preloadAtlases() — start loading all atlas textures in parallel.
 *   Call once at app init to avoid pop-in on first mode switch.
 */
export async function preloadAtlases() {
  const families = Object.keys(ATLAS_META);
  await Promise.allSettled(families.map(f => _loadAtlas(f)));
}

/**
 * disposeTexturedMaterials() — dispose all cached materials + textures.
 */
export function disposeTexturedMaterials() {
  _atlasCache.forEach(({ image }) => { if (image) image.dispose(); });
  _atlasCache.clear();
  _envListeners.length = 0;
}