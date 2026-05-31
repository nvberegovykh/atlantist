/**
 * RenderModeManager.js — Per-pane render mode switching
 *
 * OWNS: render mode state, material factory, EffectComposer per pane, mode switch logic.
 * DOES NOT OWN: scene construction (app.js), camera/renderer lifecycle, pane layout (viewport-manager.js).
 *
 * RP-3 (Shaded mode 3): delegates to services/render-modes/ShadedMode.js for
 *   MeshStandardMaterial PBR factory, directional shadow light, and edge overlay pass.
 * RP-4 (Textured mode 4): delegates to services/render-modes/TexturedMode.js for
 *   full PBR (atlas + procedural), HDRI environment, envMap binding.
 */

import {
  applySketchMode,
  restoreSolidMode,
  updateTime as sketchUpdateTime,
  injectPaperTexture,
  removePaperTexture,
} from './render-modes/SketchyMode.js';

// ── Mode definitions ───────────────────────────────────────────────────────────
export const RENDER_MODES = {
  SKETCH:     { id: 1, label: 'Sketch',     icon: '✏', shortLabel: 'SK' },
  SOLID:      { id: 2, label: 'Solid',      icon: '■', shortLabel: 'SO' },
  SHADED:     { id: 3, label: 'Shaded',     icon: '◑', shortLabel: 'SH' },
  TEXTURED:   { id: 4, label: 'Textured',   icon: '▣', shortLabel: 'TX' },
  AI:         { id: 5, label: 'AI Render',  icon: '✦', shortLabel: 'AI' },
};

const MODE_KEYS = ['', 'SKETCH', 'SOLID', 'SHADED', 'TEXTURED', 'AI'];

// ── Material cache ─────────────────────────────────────────────────────────────
const _matCache = new Map(); // key: `${cat}_${mode}` → THREE.Material

// RP-3: lazy-loaded ShadedMode module (first mode-3 use triggers import)
let _shadedMod = null;
async function _ensureShadedMod() {
  if (_shadedMod) return _shadedMod;
  try {
    const mod = await import('./render-modes/ShadedMode.js');
    _shadedMod = mod;
    return _shadedMod;
  } catch (e) {
    console.warn('[RenderModeManager] ShadedMode unavailable, using fallback:', e.message);
    return null;
  }
}

// RP-4: lazy-loaded TexturedMode module (first mode-4 use triggers import)
let _texturedMod = null;
async function _ensureTexturedMod() {
  if (_texturedMod) return _texturedMod;
  try {
    const mod = await import('./render-modes/TexturedMode.js');
    _texturedMod = mod;
    return _texturedMod;
  } catch (e) {
    console.warn('[RenderModeManager] TexturedMode unavailable, using fallback:', e.message);
    return null;
  }
}

function _getCategory(geo) {
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

// ── Material factories per mode ────────────────────────────────────────────────
function _matSolid(cat) {
  const colors = {
    wall:    0xE0DCD4,
    column:  0xC8C0B0,
    floor:   0xD4D0C4,
    door:    0xC4A882,
    window:  0x88BBE8,
    stair:   0xC8C0B0,
    railing: 0xB0A898,
    beam:    0xBCB4A4,
    roof:    0xD0C8B8,
    ceiling: 0xE4E0D8,
    curved:  0xD8D4C8,
    mep:     0xA0A8B8,
    unknown: 0xCCCCCC,
  };
  const c = colors[cat] || colors.unknown;
  return new THREE.MeshLambertMaterial({ color: c, side: THREE.FrontSide });
}

function _matShaded(cat) {
  const colors = {
    wall:    0xD8D2C8,
    column:  0xB8B0A0,
    floor:   0xCAC6BA,
    door:    0xB4986A,
    window:  0x78AAE0,
    stair:   0xB8B0A0,
    railing: 0xA8A090,
    beam:    0xACAA9C,
    roof:    0xC2BAAC,
    ceiling: 0xD8D4CC,
    curved:  0xCEC8BC,
    mep:     0x909AA8,
    unknown: 0xBBBBBB,
  };
  const c = colors[cat] || colors.unknown;
  return new THREE.MeshPhongMaterial({ color: c, side: THREE.FrontSide, shininess: 25 });
}

function _matSketch(cat) {
  const colors = {
    wall:    0xE0DCD4,
    column:  0xC8C0B0,
    floor:   0xD4D0C4,
    door:    0xC4A882,
    window:  0x88BBE8,
    stair:   0xC8C0B0,
    railing: 0xB0A898,
    beam:    0xBCB4A4,
    roof:    0xD0C8B8,
    ceiling: 0xE4E0D8,
    curved:  0xD8D4C8,
    mep:     0xA0A8B8,
    unknown: 0xCCCCCC,
  };
  const c = colors[cat] || colors.unknown;
  // White edge + colored face — sketch feel
  return new THREE.MeshLambertMaterial({ color: c, side: THREE.FrontSide });
}

function _matTextured(cat) {
  const colors = {
    wall:    0xE0DCD4,
    column:  0xC8C0B0,
    floor:   0xD4D0C4,
    door:    0xC4A882,
    window:  0x88BBE8,
    stair:   0xC8C0B0,
    railing: 0xB0A898,
    beam:    0xBCB4A4,
    roof:    0xD0C8B8,
    ceiling: 0xE4E0D8,
    curved:  0xD8D4C8,
    mep:     0xA0A8B8,
    unknown: 0xCCCCCC,
  };
  const c = colors[cat] || colors.unknown;
  return new THREE.MeshStandardMaterial({ color: c, side: THREE.FrontSide, roughness: 0.7, metalness: 0.0 });
}

function _matAI(cat) {
  const colors = {
    wall:    0xE8E4DC,
    column:  0xD0C8B8,
    floor:   0xDCD8CC,
    door:    0xD4AA7A,
    window:  0xA0C8F0,
    stair:   0xD0C8B8,
    railing: 0xC0B8A8,
    beam:    0xC4BCAC,
    roof:    0xDCD8CC,
    ceiling: 0xE8E4DC,
    curved:  0xDCD8CC,
    mep:     0xB0B8C8,
    unknown: 0xD0D0D0,
  };
  const c = colors[cat] || colors.unknown;
  return new THREE.MeshStandardMaterial({ color: c, side: THREE.FrontSide, roughness: 0.45, metalness: 0.08 });
}

// Cache + retrieve
function _getMaterial(geo, mode) {
  const cat = _getCategory(geo);
  const key = `${cat}_${mode}`;
  if (_matCache.has(key)) return _matCache.get(key);
  let mat;
  switch (mode) {
    case 1: mat = _matSketch(cat);   break;
    case 2: mat = _matSolid(cat);    break;
    // RP-3: delegate mode 3 (Shaded) to ShadedMode.js PBR factory
    case 3: mat = getShadedMaterial(geo); break;
    case 4: mat = _matTextured(cat); break;
    case 5: mat = _matAI(cat);       break;
    default: mat = _matSolid(cat);
  }
  _matCache.set(key, mat);
  return mat;
}

// ── Outline pass material (mode 2 solid — thin black edge via second pass) ──────
let _outlineMat = null;
function _getOutlineMat() {
  if (!_outlineMat) {
    _outlineMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide });
  }
  return _outlineMat;
}

// Per-pane outline mesh collection
const _paneOutlineScenes = new Map(); // paneId → THREE.Scene

// ── EffectComposer per pane ─────────────────────────────────────────────────────
const _paneComposers = new Map();  // paneId → THREE.EffectComposer
const _paneRenderPasses = new Map(); // paneId → THREE.RenderPass (stored so we can replace)

let _EffectComposer = null;
let _RenderPass = null;
let _ShaderPass = null;
let _FXAAShader = null;

// Lazily import Three.js post-processing (only when first EffectComposer is needed)
async function _ensurePostFX() {
  if (_EffectComposer) return;
  try {
    const mod = await import('three/addons/postprocessing/EffectComposer.js');
    const rp  = await import('three/addons/postprocessing/RenderPass.js');
    const sp  = await import('three/addons/postprocessing/ShaderPass.js');
    const fxaa = await import('three/addons/postprocessing/ShaderPass.js');
    _EffectComposer = mod.EffectComposer;
    _RenderPass     = rp.RenderPass;
    _ShaderPass     = sp.ShaderPass;
    // FXAA shader inline
    _FXAAShader = {
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        varying vec2 vUv;
        void main() {
          vec2 d = 1.0 / resolution;
          vec4 c = texture2D(tDiffuse, vUv);
          // Simple FXAA
          float luma = dot(c.rgb, vec3(0.299,0.587,0.114));
          vec2 p = vUv;
          float lumaN = dot(texture2D(tDiffuse, p + vec2(0, d.y)).rgb, vec3(0.299,0.587,0.114));
          float lumaS = dot(texture2D(tDiffuse, p - vec2(0, d.y)).rgb, vec3(0.299,0.587,0.114));
          float lumaE = dot(texture2D(tDiffuse, p + vec2(d.x, 0)).rgb, vec3(0.299,0.587,0.114));
          float lumaW = dot(texture2D(tDiffuse, p - vec2(d.x, 0)).rgb, vec3(0.299,0.587,0.114));
          float lumaNE = dot(texture2D(tDiffuse, p + d).rgb, vec3(0.299,0.587,0.114));
          float lumaSW = dot(texture2D(tDiffuse, p - d).rgb, vec3(0.299,0.587,0.114));
          float lumaNW = dot(texture2D(tDiffuse, p + vec2(-d.x, d.y)).rgb, vec3(0.299,0.587,0.114));
          float lumaSE = dot(texture2D(tDiffuse, p + vec2(d.x, -d.y)).rgb, vec3(0.299,0.587,0.114));
          float lumaMax = max(luma, max(max(max(lumaN,lumaS),max(lumaE,lumaW)),max(max(lumaNE,lumaSW),max(lumaNW,lumaSE))));
          float lumaMin = min(luma, min(min(min(lumaN,lumaS),min(lumaE,lumaW)),min(min(lumaNE,lumaSW),min(lumaNW,lumaSE))));
          float contrast = (lumaMax - lumaMin);
          if (contrast > 0.02) {
            float edge = contrast * 0.5;
            c.rgb = mix(c.rgb, c.rgb * 0.95, edge);
          }
          gl_FragColor = c;
        }
      `,
    };
  } catch (e) {
    console.warn('[RenderModeManager] post-processing unavailable:', e.message);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * setRenderMode(paneId, mode) — switch render mode for one pane.
 * mode: 1–5 (RENDER_MODES keys)
 */
export async function setRenderMode(paneId, mode) {
  const pane = vpStateRef.panes.find(p => p.id === paneId);
  if (!pane) return;
  pane.renderMode = mode;

  // Update toolbar icon highlighting
  _updateModeToolbarUI(paneId, mode);

  // Apply to the scene
  const scene = _paneScenes?.get(paneId);
  if (!scene) return;

  await applyModeMaterials(paneId, scene, mode);

  // Trigger re-render via viewport-manager's render call
  _forceRender(paneId);

  _saveRenderModeToStorage();
}

/**
 * getRenderMode(paneId) — returns current mode number (default 2 = Solid)
 */
export function getRenderMode(paneId) {
  const pane = vpStateRef?.panes?.find(p => p.id === paneId);
  return pane?.renderMode ?? 2;
}

/**
 * applyModeMaterials(paneId, scene, mode) — traverse scene, apply mode-specific materials
 */
export async function applyModeMaterials(paneId, scene, mode) {
  if (!scene) return;

  // RP-3: mode 3 uses ShadedMode.js — async lazy load on first use
  if (mode === 3) {
    const mod = await _ensureShadedMod();
    if (mod) {
      scene.traverse(obj => {
        if (obj.isMesh) obj.material = mod.getShadedMaterial(obj.geometry);
      });
    } else {
      scene.traverse(obj => {
        if (obj.isMesh) obj.material = _matShaded(obj.geometry);
      });
    }
  // RP-4: mode 4 uses TexturedMode.js — full PBR atlas + procedural textures + HDRI
  } else if (mode === 4) {
    const mod = await _ensureTexturedMod();
    const rend = _paneRenderers?.get(paneId);
    if (mod) {
      await mod.applyTexturedMode(scene, rend);
    } else {
      scene.traverse(obj => {
        if (obj.isMesh) obj.material = _matTextured(obj.geometry);
      });
    }
  } else {
    scene.traverse(obj => {
      if (obj.isMesh) obj.material = _getMaterial(obj.geometry, mode);
    });
  }

  // Mode 2 (Solid): rebuild outline scene for thin edge pass
  if (mode === 2) {
    _rebuildOutlineScene(paneId, scene);
  }

  // Update scene background / renderer clear color
  const rend = _paneRenderers?.get(paneId);
  if (rend) {
    switch (mode) {
      case 1: // Sketch — edges only, cream background, paper overlay
        rend.setClearColor(0xF5F2EA, 1);
        scene.background = new THREE.Color(0xF5F2EA);
        applySketchMode(scene);
        injectPaperTexture();
        break;
      case 2: // Solid
        restoreSolidMode(scene);
        removePaperTexture();
        rend.setClearColor(0x1A1E26, 1);
        if (!scene.background) scene.background = new THREE.Color(0x1A1E26);
        break;
      case 3: // Shaded
        restoreSolidMode(scene);
        removePaperTexture();
        rend.setClearColor(0x1A1E26, 1);
        if (!scene.background) scene.background = new THREE.Color(0x1A1E26);
        break;
      case 4: // Textured — dark studio background
        restoreSolidMode(scene);
        removePaperTexture();
        rend.setClearColor(0x111820, 1);
        if (!scene.background) scene.background = new THREE.Color(0x111820);
        break;
      case 5: // AI
        restoreSolidMode(scene);
        removePaperTexture();
        rend.setClearColor(0x0D1420, 1);
        if (!scene.background) scene.background = new THREE.Color(0x0D1420);
        break;
    }
  }
}

// ── Outline pass (mode 2 second pass) ──────────────────────────────────────────
function _rebuildOutlineScene(paneId, srcScene) {
  let outScene = _paneOutlineScenes.get(paneId);
  if (!outScene) {
    outScene = new THREE.Scene();
    _paneOutlineScenes.set(paneId, outScene);
  } else {
    // Clear previous outline meshes
    while (outScene.children.length) outScene.remove(outScene.children[0]);
  }

  const outlineMat = _getOutlineMat();
  srcScene.traverse(obj => {
    if (obj.isMesh) {
      const edgeGeo = obj.geometry.clone();
      // Backface expand — create slightly larger copy
      const geo = obj.geometry;
      const pos = geo.attributes.position;
      if (pos) {
        const expanded = pos.array.slice();
        const expandAmt = 0.015; // thin black edge
        for (let i = 0; i < expanded.length; i += 3) {
          const nx = pos.getX(i / 3);
          const ny = pos.getY(i / 3);
          const nz = pos.getZ(i / 3);
          // Use normal direction — approximate with scale
          expanded[i]     = nx * (1 + expandAmt);
          expanded[i + 1] = ny * (1 + expandAmt);
          expanded[i + 2] = nz * (1 + expandAmt);
        }
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.BufferAttribute(expanded, 3));
        // Copy index
        if (geo.index) newGeo.setIndex(geo.index);
        const mesh = new THREE.Mesh(newGeo, outlineMat);
        outScene.add(mesh);
      }
    }
  });
}

// ── EffectComposer ─────────────────────────────────────────────────────────────
export async function ensureComposerForPane(paneId, renderer, scene, camera) {
  await _ensurePostFX();
  if (!_EffectComposer) return; // post-fx unavailable

  let composer = _paneComposers.get(paneId);
  if (!composer) {
    composer = new _EffectComposer(renderer);
    _paneComposers.set(paneId, composer);

    // Add render pass
    const rp = new _RenderPass(scene, camera);
    composer.addPass(rp);
    _paneRenderPasses.set(paneId, rp);

    // FXAA pass
    if (_ShaderPass && _FXAAShader) {
      const fxaaPass = new _ShaderPass(_FXAAShader);
      const canvas = renderer.domElement;
      fxaaPass.uniforms.resolution.value.set(1 / (canvas.clientWidth || 1), 1 / (canvas.clientHeight || 1));
      composer.addPass(fxaaPass);
    }
  }
  return composer;
}

export function renderWithComposer(paneId, renderer, scene, camera, w, h) {
  const composer = _paneComposers.get(paneId);
  if (!composer) return;

  const rp = _paneRenderPasses.get(paneId);
  if (rp) { rp.scene = scene; rp.camera = camera; }

  // Resize composer if needed
  if (composer.setSize) composer.setSize(w, h);

  composer.render();
}

// ── Storage ─────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'atlantist-vp-layout';

function _saveRenderModeToStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // Collect renderMode for each pane
    const renderModes = {};
    (vpStateRef?.panes || []).forEach(p => { renderModes[p.id] = p.renderMode || 2; });
    saved.renderModes = renderModes;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {}
}

export function loadRenderModesFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return;
    const saved = JSON.parse(s);
    if (saved.renderModes && vpStateRef?.panes) {
      vpStateRef.panes.forEach(p => {
        if (saved.renderModes[p.id] != null) p.renderMode = saved.renderModes[p.id];
        else if (p.renderMode == null) p.renderMode = 2;
      });
    }
  } catch {}
}

// ── Edge overlay state (mode 3 only) ──────────────────────────────────────────
const _edgeState = new Map(); // paneId → { enabled: bool, edgeScene: THREE.Scene|null }

// RP-3: toggle edges for a pane — applies/removes EdgesGeometry overlay
export async function toggleEdgesForPane(paneId, scene) {
  const state = _edgeState.get(paneId) ?? { enabled: false, edgeScene: null };
  const nextEnabled = !state.enabled;

  const mod = await _ensureShadedMod();
  if (!mod) return;

  if (nextEnabled) {
    const overlayScene = mod.applyEdgeOverlay(paneId, scene);
    _edgeState.set(paneId, { enabled: true, edgeScene: overlayScene });
  } else {
    mod.removeEdgeOverlay(paneId);
    _edgeState.set(paneId, { enabled: false, edgeScene: null });
  }
  _updateEdgeToggleUI(paneId, nextEnabled);
}

// ── UI — mode icon toolbar ─────────────────────────────────────────────────────
export function buildModeToolbar(paneId) {
  const toolbar = document.createElement('div');
  toolbar.className = 'vp-mode-toolbar';
  toolbar.id = `vp-mode-toolbar-${paneId}`;
  toolbar.style.cssText = `
    position:absolute;top:60px;left:6px;z-index:15;
    display:flex;align-items:center;gap:3px;
    background:rgba(8,13,20,0.7);backdrop-filter:blur(6px);
    border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:3px 5px;
  `;

  const modes = [RENDER_MODES.SKETCH, RENDER_MODES.SOLID, RENDER_MODES.SHADED,
                 RENDER_MODES.TEXTURED, RENDER_MODES.AI];
  const currentMode = getRenderMode(paneId);

  modes.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'vp-mode-btn' + (m.id === currentMode ? ' vp-mode-btn-active' : '');
    btn.dataset.mode = m.id;
    btn.title = m.label;
    btn.textContent = m.icon;
    btn.style.cssText = `
      background:none;border:1px solid transparent;
      color:${m.id === currentMode ? 'rgba(74,141,245,0.9)' : 'rgba(255,255,255,0.35)'};
      cursor:pointer;font-size:11px;padding:3px 5px;border-radius:5px;
      transition:color 0.12s, border-color 0.12s, background 0.12s;
      font-family:monospace;min-width:20px;text-align:center;
    `;
    if (m.id === currentMode) {
      btn.style.background = 'rgba(74,141,245,0.15)';
      btn.style.borderColor = 'rgba(74,141,245,0.3)';
    }
    btn.addEventListener('click', () => setRenderMode(paneId, m.id));
    btn.addEventListener('mouseenter', () => { if (m.id !== currentMode) btn.style.color = 'rgba(255,255,255,0.7)'; });
    btn.addEventListener('mouseleave', () => {
      if (m.id !== currentMode) btn.style.color = 'rgba(255,255,255,0.35)';
    });
    toolbar.appendChild(btn);
  });

  // RP-3: edge toggle — visible only when Shaded mode (3) is active
  const edgeBtn = document.createElement('button');
  edgeBtn.id = `vp-edge-toggle-${paneId}`;
  edgeBtn.className = 'vp-mode-btn vp-edge-btn';
  edgeBtn.title = 'Toggle Edges (Shaded mode)';
  edgeBtn.textContent = '⊞';
  const isMode3 = currentMode === 3;
  const edgeState = _edgeState.get(paneId);
  const edgeActive = isMode3 && (edgeState?.enabled ?? false);
  edgeBtn.style.cssText = `
    background:none;border:1px solid ${edgeActive ? 'rgba(74,141,245,0.4)' : 'rgba(255,255,255,0.12)'};
    color:${edgeActive ? 'rgba(74,141,245,0.9)' : 'rgba(255,255,255,0.25)'};
    cursor:${isMode3 ? 'pointer' : 'default'};font-size:11px;padding:3px 5px;border-radius:5px;
    transition:color 0.12s, border-color 0.12s, background 0.12s;
    font-family:monospace;min-width:20px;text-align:center;
    margin-left:2px;
  `;
  if (edgeActive) edgeBtn.style.background = 'rgba(74,141,245,0.12)';
  edgeBtn.style.opacity = isMode3 ? '1' : '0.35';
  edgeBtn.addEventListener('click', async () => {
    if (!isMode3) return;
    const scene = _paneScenes?.get(paneId);
    if (scene) await toggleEdgesForPane(paneId, scene);
  });
  toolbar.appendChild(edgeBtn);

  return toolbar;
}

function _updateModeToolbarUI(paneId, activeMode) {
  const toolbar = document.getElementById(`vp-mode-toolbar-${paneId}`);
  if (!toolbar) return;
  toolbar.querySelectorAll('.vp-mode-btn:not(.vp-edge-btn)').forEach(btn => {
    const m = parseInt(btn.dataset.mode);
    const isActive = m === activeMode;
    btn.className = 'vp-mode-btn' + (isActive ? ' vp-mode-btn-active' : '');
    btn.style.color = isActive ? 'rgba(74,141,245,0.9)' : 'rgba(255,255,255,0.35)';
    btn.style.background = isActive ? 'rgba(74,141,245,0.15)' : 'none';
    btn.style.borderColor = isActive ? 'rgba(74,141,245,0.3)' : 'transparent';
  });

  // RP-3: update edge toggle visibility / style when mode changes
  const edgeBtn = document.getElementById(`vp-edge-toggle-${paneId}`);
  if (!edgeBtn) return;
  const isMode3 = activeMode === 3;
  const edgeState = _edgeState.get(paneId);
  const edgeActive = isMode3 && (edgeState?.enabled ?? false);
  edgeBtn.style.opacity = isMode3 ? '1' : '0.35';
  edgeBtn.style.cursor = isMode3 ? 'pointer' : 'default';
  edgeBtn.style.borderColor = edgeActive ? 'rgba(74,141,245,0.4)' : 'rgba(255,255,255,0.12)';
  edgeBtn.style.color = edgeActive ? 'rgba(74,141,245,0.9)' : 'rgba(255,255,255,0.25)';
  edgeBtn.style.background = edgeActive ? 'rgba(74,141,245,0.12)' : 'none';
}

function _updateEdgeToggleUI(paneId, enabled) {
  const edgeBtn = document.getElementById(`vp-edge-toggle-${paneId}`);
  if (!edgeBtn) return;
  edgeBtn.style.borderColor = enabled ? 'rgba(74,141,245,0.4)' : 'rgba(255,255,255,0.12)';
  edgeBtn.style.color = enabled ? 'rgba(74,141,245,0.9)' : 'rgba(255,255,255,0.25)';
  edgeBtn.style.background = enabled ? 'rgba(74,141,245,0.12)' : 'none';
}

// ── References (set by app.js init) ─────────────────────────────────────────────
let vpStateRef = null;
let _paneScenes  = null;
let _paneRenderers = null;
let _paneCamKey = null;

export function initRenderModeManager(vpState, paneScenes, paneRenderers, paneCamKeyMap) {
  vpStateRef = vpState;
  _paneScenes = paneScenes;
  _paneRenderers = paneRenderers;
  _paneCamKey = paneCamKeyMap;

  // Initialize renderMode = 2 for all panes that don't have it
  (vpState.panes || []).forEach(p => {
    if (p.renderMode == null) p.renderMode = 2;
  });

  loadRenderModesFromStorage();
}

// ── Force render (triggers viewport-manager's _renderAll) ──────────────────────
function _forceRender(paneId) {
  // Signal the viewport-manager scheduler to do an immediate render
  if (window.__vpManager?._vpScheduler) {
    window.__vpManager._vpScheduler._lastFrame = 0;
  }
}

// ── Dispose ─────────────────────────────────────────────────────────────────────
export function disposeAll() {
  _matCache.forEach(m => m.dispose());
  _matCache.clear();
  _paneComposers.forEach(c => c.dispose());
  _paneComposers.clear();
  if (_outlineMat) { _outlineMat.dispose(); _outlineMat = null; }
  _edgeState.clear();
}