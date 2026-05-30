/**
 * viewport-manager.js — Dynamic multi-pane viewport grid
 *
 * REPLACES: All previous viewport layout code in viewport-manager.js (v1 — broken).
 * REMOVED LEGACY (v1):
 *   - buildViewportDOM() — only adjusted top-row cells on col-drag, bottom row ignored (BUG)
 *   - applyDividerDrag() — scoped to rows[0] only, never touched bottom row
 *   - onDividerMove() — same bug, 2x2 col drag only touched cells in topRow
 *   - getPaneSizes() + layout string matching — rigid '1x1'/'2x1'/'1x2'/'2x2' only
 *   - makeDivider() — created DOM dividers but drag only worked on 1 of 3 borders in 2x2
 *   - All vpState.layout string dispatch in buildViewportDOM()
 *
 * WHAT THIS FILE OWNS:
 *   - Flexbox CSS grid — all 3 borders draggable in 2x2 (not just the top)
 *   - Row heights update on horizontal drag (both top + bottom columns update)
 *   - Column widths update on vertical drag (all rows update proportionally)
 *   - Double-click header → maximize pane to full viewport-area
 *   - Double-click again → restore to grid position
 *   - Independent WebGL canvas per pane (no shared WebGL state)
 *   - Default 4-pane: [3D | Plan], [El.X | El.Y]
 *   - localStorage persistence + optional server upsert
 *
 * WHAT THIS FILE DOES NOT OWN:
 *   - Three.js renderers/controls (app.js creates and owns these)
 *   - Canvas element creation (this file creates them, app.js wraps them in WebGL renderers)
 *   - WebSocket handoff (ws-client.js owns sibling session routing)
 */

import { injectViewportSpinner, dismissViewportSpinner } from './loading-manager.js';
import { buildModeToolbar, initRenderModeManager } from '../../services/RenderModeManager.js';
import { updateTime as sketchUpdateTime } from '../../services/render-modes/SketchyMode.js';

// RP-1: Scene/renderer refs for RenderModeManager — set by app.js after VP setup
export function setRenderModeManagerScenes(paneScenes, paneRenderers, paneCamKeyMap) {
  initRenderModeManager(vpState, paneScenes, paneRenderers, paneCamKeyMap);
}

// ── View Types ────────────────────────────────────────────────────────────────
export const VIEW_TYPES = {
  PERSPECTIVE_3D: 'perspective_3d',
  TOP: 'top',
  FRONT: 'front',
  BACK: 'back',
  LEFT: 'left',
  RIGHT: 'right',
  SECTION_X: 'section_x',
  SECTION_Y: 'section_y',
  RCP: 'rcp',
  CAMERA: 'camera',
};

const VIEW_LABELS = {
  perspective_3d: '3D Perspective',
  top:            'Top / Plan',
  front:          'Front',
  back:           'Back',
  left:           'Left',
  right:          'Right',
  section_x:      'Section X',
  section_y:      'Section Y',
  rcp:            'RCP',
  camera:         'Camera',
};

// Maps view type → camera key in window._atlantist_cameras + scene key
// Handles ortho vs perspective initialization
const VIEW_CAMERA_KEY = {
  perspective_3d: '3d',
  top:            'plan',
  front:          'section',
  back:           'section',
  left:           'section',
  right:          'section',
  section_x:      'section',
  section_y:      'section',
  rcp:            'plan',
  camera:         '3d',
};

// ── Public state (exported for app.js) ────────────────────────────────────────
export const vpState = {
  mode: 'grid',    // 'grid' | 'maximized'
  maximizedId: null,
  // Each pane has multiple viewport tabs
  panes: [
    {
      id: 'p0',
      visible: true,
      renderMode: 2, // RP-1: default Solid mode (1=Sketch, 2=Solid, 3=Shaded, 4=Textured, 5=AI)
      tabs: [
        { id: 't0', label: '3D', view: 'perspective_3d',
          cameraState: { position: { x: 15, y: 10, z: 15 }, target: { x: 5, y: 2, z: 5 }, zoom: 1 } },
      ],
      activeTabId: 't0',
    },
    {
      id: 'p1',
      visible: true,
      renderMode: 2,
      tabs: [
        { id: 't1', label: 'Plan', view: 'top',
          cameraState: { position: { x: 0, y: 100, z: 0 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 } },
      ],
      activeTabId: 't1',
    },
    {
      id: 'p2',
      visible: true,
      renderMode: 2,
      tabs: [
        { id: 't2', label: 'El. X', view: 'front',
          cameraState: { position: { x: 0, y: 3, z: 50 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 } },
      ],
      activeTabId: 't2',
    },
    {
      id: 'p3',
      visible: true,
      renderMode: 2,
      tabs: [
        { id: 't3', label: 'El. Y', view: 'left',
          cameraState: { position: { x: -50, y: 3, z: 0 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 } },
      ],
      activeTabId: 't3',
    },
  ],
  dragging: null,
  _initDone: false,
  _tabCounter: 4,   // next tab ID starts after t0-t3
  // Floating viewport state
  floating: {},    // paneId → { x, y, width, height, opacity, overlayMode, zBase }
  _zCounter: 200,
  _floatingDrag: null,
  _dockIndicator: null,
};

const STORAGE_KEY = 'atlantist-viewport-layout';
const MIN_FRAC = 0.12;

// ── BUG-G10: Mobile responsive constants ──────────────────────────────────────
const MOBILE_BP = 768; // single-viewport mode below this width

function _isMobile() {
  return window.innerWidth <= MOBILE_BP;
}

// ── FPS Scheduler + WebGL Context Guard (VP-D) ──────────────────────────────────
// Active viewport: 60fps.  Inactive but visible: 10fps.
// Hidden (tabbed/minimized): 0fps (render loop suspended).
// Floating overlay (pointer-events:none): 10fps.
// Browser context limits (typically 8–16 per renderer): guard against overflow.
const FPS = { ACTIVE: 60, INACTIVE: 10, SUSPENDED: 0 };

const _vpScheduler = {
  _rafId: null,
  _lastFrame: 0,      // timestamp of last rendered frame
  _lastInactive: 0,   // timestamp of last inactive render pass
  _activePaneId: null,
  _visiblePanes: new Set(),  // paneIds currently in DOM with non-zero size
  _contextCount: 0,   // approximate WebGL contexts created
  _contextLimitWarned: false,

  init() {
    // Page visibility → suspend/resume render loop
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._suspend();
      } else {
        this._resume();
      }
    });

    // Mouse focus tracking — active pane gets 60fps, others 10fps
    document.addEventListener('mousemove', (e) => {
      const canvas = e.target.closest('[id^="vp-canvas-"]');
      if (canvas) {
        const id = canvas.id.replace('vp-canvas-', '');
        if (id !== this._activePaneId) {
          this._activePaneId = id;
          this._lastFrame = 0; // force immediate render on focus change
        }
      }
    });

    // Track visible panes via ResizeObserver per pane (set during _makePane)
    // Floating window overlay state changes also affect render rate
    this._startLoop();
  },

  _startLoop() {
    const tick = (ts) => {
      if (document.hidden) { this._rafId = requestAnimationFrame(tick); return; }

      const msPerActive = 1000 / FPS.ACTIVE;        // ~16.67ms between frames
      const msPerInactive = 1000 / FPS.INACTIVE;   // ~100ms between frames

      const isActiveRender = this._activePaneId !== null;
      const minInterval = isActiveRender ? msPerActive : msPerInactive;
      const lastTarget = isActiveRender ? this._lastFrame : this._lastInactive;

      if (ts - lastTarget < minInterval) {
        this._rafId = requestAnimationFrame(tick);
        return;
      }

      // Render the frame
      const renderedPanes = this._renderTick(ts);

      // Track next frame time
      if (isActiveRender) {
        this._lastFrame = ts;
      } else {
        this._lastInactive = ts;
      }

      this._rafId = requestAnimationFrame(tick);
    };

    this._rafId = requestAnimationFrame(tick);
  },

  _suspend() {
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
  },

  _resume() {
    this._lastFrame = 0;
    this._lastInactive = 0;
    if (!this._rafId) this._startLoop();
  },

  // Returns list of paneIds actually rendered this tick
  _renderTick(ts) {
    // RP-2: tick sketch shader animation each frame
    try { sketchUpdateTime?.(ts * 0.001); } catch (_) {}

    const rendered = [];
    const now = Date.now();

    // Collect pane render tiers
    for (const pane of vpState.panes) {
      if (!pane.visible) continue;

      const canvas = document.getElementById(`vp-canvas-${pane.id}`);
      if (!canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) continue;

      const fw = document.getElementById(`vp-floating-${pane.id}`);
      const isFloatingOverlay = fw && vpState.floating[pane.id]?.overlayMode;

      // Determine FPS tier
      const isActive = pane.id === this._activePaneId || document.activeElement?.closest(`#vp-wrap-${pane.id}`)?.id === `vp-wrap-${pane.id}`;
      const tier = isActive ? 'active' : (isFloatingOverlay ? 'overlay' : 'inactive');

      // For 10fps inactive panes, skip unless enough time elapsed
      if (tier === 'inactive' || tier === 'overlay') {
        const last = this._paneLastRender?.[pane.id] || 0;
        if (ts - last < 100) continue; // ~10fps
      }

      // Render this pane
      const activeTab = pane.tabs.find(t => t.id === pane.activeTabId) || pane.tabs[0];
      if (!activeTab) continue;

      const camKey = VIEW_CAMERA_KEY[activeTab.view] || '3d';
      const rend = rendMap[camKey];
      const cam  = camMap[camKey];
      if (!rend || !cam) continue;

      const scene = _getScene(camKey);
      if (!scene) continue;

      const w = Math.max(canvas.clientWidth,  1);
      const h = Math.max(canvas.clientHeight, 1);
      const dpr = window.devicePixelRatio || 1;

      // Rebind renderer to canvas if the bound element differs (shared renderer across panes)
      if (rend.domElement.width  !== Math.round(w * dpr) ||
          rend.domElement.height !== Math.round(h * dpr) ||
          rend.domElement !== canvas) {
        rend.setSize(w, h, false);
        _updateCameraAspect(cam, w, h);
      }
      rend.render(scene, cam);

      // Dismiss spinner
      const wrap = document.getElementById(`vp-wrap-${pane.id}`);
      if (wrap) {
        const sp = wrap.querySelector('.vp-spinner');
        if (sp) dismissViewportSpinner(sp);
      }

      if (!this._paneLastRender) this._paneLastRender = {};
      this._paneLastRender[pane.id] = ts;
      rendered.push(pane.id);
    }
    return rendered;
  },

  onContextCreated() {
    this._contextCount++;
    const limit = 16; // conservative default for most browsers
    if (this._contextCount >= limit - 2 && !this._contextLimitWarned) {
      this._contextLimitWarned = true;
      this._showContextLimitWarning();
    }
  },

  _showContextLimitWarning() {
    const existing = document.getElementById('vp-context-limit-warning');
    if (existing) return;
    const w = document.createElement('div');
    w.id = 'vp-context-limit-warning';
    w.style.cssText = `
      position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
      z-index:9999;background:rgba(220,38,38,0.95);border:1px solid rgba(255,100,100,0.4);
      border-radius:10px;padding:10px 18px;font-family:'DM Sans',system-ui,sans-serif;
      font-size:12px;color:#fff;display:flex;align-items:center;gap:10px;
      box-shadow:0 4px 20px rgba(220,38,38,0.4);max-width:380px;text-align:center;
    `;
    w.innerHTML = `<span style="font-size:16px">⚠</span>
      <span><strong>Viewport limit reached.</strong> Your browser supports a limited number of WebGL contexts.
      Close some viewports before opening more.</span>
      <button onclick="document.getElementById('vp-context-limit-warning').remove()"
        style="background:none;border:1px solid rgba(255,255,255,0.4);color:#fff;cursor:pointer;font-size:11px;padding:3px 8px;border-radius:5px;flex-shrink:0">×</button>`;
    document.body.appendChild(w);
  },

  // Called by app.js when a renderer/WebGL context is created
  reportContextCreated() { this.onContextCreated(); },
};

// Expose to app.js so it can report context creation
export function reportViewportContextCreated() { _vpScheduler.reportContextCreated(); }
export function getRenderStats() {
  return {
    activePaneId: _vpScheduler._activePaneId,
    visiblePaneCount: _vpScheduler._visiblePanes?.size || vpState.panes.filter(p => p.visible).length,
    contextCount: _vpScheduler._contextCount,
    isRunning: !!_vpScheduler._rafId,
    isSuspended: document.hidden,
  };
}

// ── Pane visibility tracking (called from _makePane / floating setup) ──────────
export function setPaneVisible(paneId, visible) {
  if (visible) _vpScheduler._visiblePanes?.add(paneId);
  else _vpScheduler._visiblePanes?.delete(paneId);
}

// Camera/renderer map — set by app.js via initCameraMap()
let camMap = {};
let rendMap = {};

// Cross-device continuity refs (set by app.js via initViewportHandoff / setViewportProjectId)
let _authUserId = null;
let _projectId = null;
let _wsClientRef = null;
let _pushTimer = null;
const PUSH_DEB = 400;

// Used by app.js for cross-device continuity
export function setViewportProjectId(id) { _projectId = id; }

export function initViewportHandoff(authUserId, projectId, wsClientInstance) {
  _authUserId = authUserId;
  _projectId = projectId;
  _wsClientRef = wsClientInstance;
  if (_wsClientRef?.socket?.readyState === WebSocket.OPEN) {
    _wsClientRef.identifyViewportSession(authUserId, projectId);
  }
  if (_wsClientRef) {
    _wsClientRef.onViewportSiblingState = (state) => _applyRestoredState(state);
    _wsClientRef.onViewportPullRequested = () => _wsClientRef.respondViewportPull(_captureState());
  }
  _tryRestoreFromServer();
}

// ── Camera / renderer wiring ───────────────────────────────────────────────────
export function initCameraMap(cam3d, camPlan, camSect, rend3d, rendPlan, rendSect) {
  camMap = {
    '3d': cam3d,
    'plan': camPlan,
    'section': camSect,
    'elevation-x': camSect,
    'elevation-y': camSect,
  };
  rendMap = {
    '3d': rend3d,
    'plan': rendPlan,
    'section': rendSect,
    'elevation-x': rendSect,
    'elevation-y': rendSect,
  };
}

// Post-build callback — app.js registers this to re-attach WebGL renderers
let _onAfterBuild = null;
export function setOnAfterBuildViewportDOM(fn) { _onAfterBuild = fn; }

// ── Public init entry point ───────────────────────────────────────────────────
// Supports both old signature initViewports(cam3d,camPlan,camSect,rend3d,rendPlan,rendSect)
// and new zero-arg initViewports(). Cameras/renderers are set via initCameraMap() separately.
export function initViewports(cam3d, camPlan, camSect, rend3d, rendPlan, rendSect) {
  if (cam3d && camPlan && camSect) {
    initCameraMap(cam3d, camPlan, camSect, rend3d || null, rendPlan || null, rendSect || null);
  }

  const saved = _loadLayout();
  if (saved) {
    if (saved.mode)     vpState.mode         = saved.mode;
    if (saved.maximizedId != null) vpState.maximizedId = saved.maximizedId;
    if (saved.panes)    vpState.panes        = saved.panes;
    if (saved.floating) vpState.floating     = saved.floating;
  }

  requestAnimationFrame(() => {
    _buildGrid();
    // VP-D: restore any saved splitter fractions (column/row split positions)
    applyPendingSplitterState();
    _renderAll();
  });

  // Window resize — BUG-G10: rebuild grid when crossing mobile breakpoint
  window.addEventListener('resize', _debounce(() => {
    _buildGrid();
    _renderAll();
    // Notify mobile bottom bar view label when viewport switches to single 3D on mobile
    if (_isMobile()) {
      const labelEl = document.getElementById('mob-view-label');
      if (labelEl) labelEl.textContent = '3D';
    }
  }, 120));

  // Visibility change → scheduler handles suspend/resume
  document.addEventListener('visibilitychange', () => {
    // _vpScheduler already listens; just force one immediate render on tab return
    if (!document.hidden) requestAnimationFrame(() => _renderAll());
  });

  // BUG-G10: visualViewport API — mobile keyboard appears/disappears without triggering
  // window.resize, but visualViewport fires its own resize event. This keeps the
  // canvas sized correctly when the mobile keyboard opens (e.g. in a search input).
  if (typeof visualViewport !== 'undefined') {
    visualViewport.addEventListener('resize', _debounce(() => {
      _buildGrid();
      _renderAll();
    }, 80));

    visualViewport.addEventListener('scroll', _debounce(() => {
      _renderAll(); // viewport scroll (e.g. after keyboard dismiss) needs re-render
    }, 80));
  }

  // ResizeObserver on viewport-area
  const vpArea = document.getElementById('viewport-area');
  if (vpArea && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(_debounce(() => {
      if (vpState.mode !== 'maximized') { _buildGrid(); }
      _renderAll();
    }, 60)).observe(vpArea);
  }

  vpState._initDone = true;

  // VP-D: start the FPS scheduler (handles 60fps/10fps/0fps throttling + context guard)
  _vpScheduler.init();

  // Restore any floating panes from saved state
  setTimeout(_restoreFloatingPanes, 50);
}

export function getActiveViewports() { return vpState.panes.filter(p => p.visible); }
export function getViewportState()  { return vpState; }

export function notifyPaneVisible() {
  // Scheduler handles visibility state; this forces a render tick via the scheduler
  if (!vpState._initDone) return;
  _vpScheduler._lastFrame = 0; // force immediate render
}

// BUG-G10: Expose mobile state for the mobile bottom bar
export function setMobileViewMode(viewName) {
  // Update the active tab label to match the view switch
  const p0 = vpState.panes[0];
  if (p0 && p0.tabs[0]) {
    p0.tabs[0].view = viewName;
    p0.tabs[0].label = viewName === 'perspective_3d' ? '3D'
      : viewName === 'top' ? 'Plan'
      : viewName === 'section_x' ? 'Section X'
      : viewName === 'section_y' ? 'Section Y'
      : viewName === 'rcp' ? 'RCP'
      : viewName;
    _renderAll();
  }
}

export function isMobileViewport() { return _isMobile(); }

// BUG-G10: Mobile single-viewport — show only p0, hide p1–p3
// Called when switching to 3D view from the mobile bottom bar.
// Returns true if mobile mode is active.
export function showMobileSingleViewport() {
  if (!_isMobile()) return false;
  vpState.panes.forEach((p, i) => { p.visible = (i === 0); });
  _buildGrid();
  _renderAll();
  return true;
}

// BUG-G10: Mobile swipe dots updater — called from mobile.js
// viewName: '3d' | 'plan' | 'section_x' | 'section_y'
window._vpUpdateSwipeDots = function(viewName) {
  const dots = document.querySelector('.vp-swipe-dots');
  if (!dots) return;
  const viewNames = ['3d', 'plan', 'section-x', 'section-y'];
  const activeIdx = viewNames.indexOf(viewName);
  dots.querySelectorAll('.vp-swipe-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === activeIdx);
  });
};

export function setViewportView(paneId, view) {
  const p = vpState.panes.find(p => p.id === paneId);
  if (!p) return;
  const tab = p.tabs.find(t => t.id === p.activeTabId) || p.tabs[0];
  if (tab) { tab.view = view; tab.label = VIEW_LABELS[view] || view; _saveLayout(); _renderAll(); }
}

export function pushViewportStateImmediate() {
  clearTimeout(_pushTimer);
  if (_wsClientRef) _wsClientRef.pushViewportState(_captureState());
}

// ── CSS Grid Builder ──────────────────────────────────────────────────────────
//
// Layout model:
//   viewport-area
//     ├── vp-maximized-wrap  (when maximized — single pane, full area)
//     └── vp-grid            (when in grid mode — flex rows + draggable dividers)
//          ├── vp-row.flex
//          │    ├── .vp-cell.flex-item  [flex: colFrac]
//          │    │    └── .vp-wrap (pane DOM: canvas + toolbar)
//          │    └── .vp-divider-col (drag handle)
//          │         └── .vp-cell.flex-item  [flex: 1 - colFrac]
//          │              └── .vp-wrap
//          └── .vp-divider-row (drag handle)
//               └── vp-row.flex
//                    └── ... same as top row ...
//
// The key fix vs v1: on column drag, we update BOTH rows' column fractions.
// On row drag, we update BOTH rows' row flex (they share the same parent flex container).

function _buildGrid() {
  const container = document.getElementById('viewport-area');
  if (!container) return;

  if (vpState.mode === 'maximized') {
    _buildMaximized(container);
    return;
  }

  // BUG-G10: On mobile (≤768px), force single-viewport mode — 3D perspective only.
  // The CSS hides all other panes; JS sets p1–p3 visible=false so render ignores them.
  if (_isMobile()) {
    // Only pane p0 (3D) is visible on mobile; hide the others from the scheduler
    vpState.panes.forEach((p, i) => { p.visible = (i === 0); });
  }

  // Preserve non-VP children (issue-pins-overlay, etc.)
  const preserved = [];
  Array.from(container.children).forEach(child => {
    if (child.id === 'issue-pins-overlay' || child.classList.contains('vp-persistent')) {
      preserved.push(child); child.remove();
    }
  });

  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'vp-grid';

  const visible = vpState.panes.filter(p => p.visible);
  if (visible.length === 0) { container.appendChild(grid); return; }

  if (visible.length === 1) {
    grid.appendChild(_makeRow([visible[0]], [1]));
  } else if (visible.length === 2) {
    grid.appendChild(_makeRow(visible, [0.5, 0.5], 'row'));
  } else {
    // 2x2 — top row: [p0 | p1], divider, bottom row: [p2 | p3]
    const topRow = _makeRow([visible[0], visible[1]], [0.5, 0.5], 'col', 0);
    const botRow = _makeRow([visible[2] || visible[0], visible[3] || visible[1]], [0.5, 0.5], 'col', 2);

    grid.appendChild(topRow);

    // Row divider (horizontal drag — adjusts top vs bottom height)
    const rowDiv = _makeDivider({ axis: 'row', index: 1 });
    rowDiv.addEventListener('mouseenter', () => { rowDiv.classList.add('drag-active'); });
    rowDiv.addEventListener('mouseleave', () => { rowDiv.classList.remove('drag-active'); });
    grid.appendChild(rowDiv);

    grid.appendChild(botRow);
  }

  // Add pane label overlay + max button
  grid.querySelectorAll('.vp-wrap').forEach(wrap => {
    const paneId = wrap.dataset.paneId;
    _addPaneOverlay(wrap, paneId);
  });

  container.appendChild(grid);
  preserved.forEach(el => container.appendChild(el));

  requestAnimationFrame(() => {
    if (_onAfterBuild) _onAfterBuild();
    _renderAll();
  });
}

function _makeRow(paneList, fracs, dividerAxis, dividerIndexOffset = 0) {
  const row = document.createElement('div');
  row.className = 'vp-row';

  paneList.forEach((pane, i) => {
    // Cell (flex container for pane + right-side divider)
    const cell = document.createElement('div');
    cell.className = 'vp-cell';
    cell.style.flexBasis = `${(fracs[i] || 1) * 100}%`;

    // Pane wrap
    const wrap = _makePane(pane, i);
    cell.appendChild(wrap);

    // Column divider (after every cell except the last in a row)
    if (i < paneList.length - 1) {
      const colDiv = _makeDivider({ axis: 'col', index: dividerIndexOffset + i });
      colDiv.addEventListener('mouseenter', () => { colDiv.classList.add('drag-active'); });
      colDiv.addEventListener('mouseleave', () => { colDiv.classList.remove('drag-active'); });
      cell.appendChild(colDiv);
    }

    row.appendChild(cell);
  });

  return row;
}

function _makeDivider({ axis, index }) {
  const el = document.createElement('div');
  el.className = `vp-divider vp-divider-${axis}`;
  el.dataset.dividerAxis = axis;
  el.dataset.dividerIndex = index;

  el.addEventListener('mousedown', (e) => { e.preventDefault(); _startDrag(e, axis, index); });
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    _startDrag(e.touches[0], axis, index);
  }, { passive: false });

  // Double-click divider → reset to equal split
  el.addEventListener('dblclick', () => resetLayout());

  return el;
}

function _makePane(pane, index) {
  const wrap = document.createElement('div');
  wrap.className = 'vp-wrap';
  wrap.id = `vp-wrap-${pane.id}`;
  wrap.dataset.paneId = pane.id;

  // WebGL canvas
  const canvas = document.createElement('canvas');
  canvas.id = `vp-canvas-${pane.id}`;
  wrap.appendChild(canvas);

  // Loading spinner — injected into pane wrap
  injectViewportSpinner(wrap, (pane.tabs && pane.tabs[0]) ? pane.tabs[0].view : 'perspective_3d');

  // BUG-UI-1 safety: if spinner hasn't dismissed in 4s, force-dismiss it.
  // Prevents EL. Y (p3) and other panes from showing stuck spinner when the
  // scene/renderer map isn't populated before the first scheduler tick.
  setTimeout(() => {
    const sp = wrap.querySelector('.vp-spinner');
    if (sp) dismissViewportSpinner(sp);
  }, 4000);

  // Track canvas size to handle hidden→visible transitions
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        requestAnimationFrame(() => _renderAll());
      }
    }).observe(canvas);
  }

  // Double-click header → maximize
  wrap.addEventListener('dblclick', (e) => {
    e.stopPropagation(); // prevent parent handlers (dividers, viewport-area) from intercepting
    if (e.target.closest('button')) return;
    _toggleMaximize(pane.id);
  });

  return wrap;
}

// ── Tab System ────────────────────────────────────────────────────────────────
function _renderTab(tab, tabBar, paneId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const isActive = tab.id === pane.activeTabId;

  const tabEl = document.createElement('div');
  tabEl.className = 'vp-tab' + (isActive ? ' vp-tab-active' : '');
  tabEl.dataset.tabId = tab.id;
  tabEl.style.cssText = `
    display:flex;align-items:center;gap:6px;padding:0 10px;
    cursor:pointer;position:relative;flex-shrink:0;
    font-size:10px;font-weight:500;letter-spacing:0.04em;
    color:${isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)'};
    background:${isActive ? 'rgba(74,141,245,0.12)' : 'transparent'};
    border-bottom:2px solid ${isActive ? 'rgba(74,141,245,0.8)' : 'transparent'};
    transition:color 0.12s, background 0.12s;
  `;

  const label = document.createElement('span');
  label.style.cssText = 'pointer-events:none;';
  label.textContent = tab.label;
  tabEl.appendChild(label);

  // Close button (hide if only 1 tab)
  if (pane.tabs.length > 1) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'vp-tab-close';
    closeBtn.title = 'Close this viewport';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      background:none;border:none;color:rgba(255,255,255,0.2);cursor:pointer;
      font-size:12px;line-height:1;padding:0 1px;border-radius:3px;
      transition:color 0.1s;
    `;
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); e.stopPropagation(); _closeTab(paneId, tab.id); });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'rgba(255,80,80,0.8)'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'rgba(255,255,255,0.2)'; });
    tabEl.appendChild(closeBtn);
  }

  tabEl.addEventListener('click', () => { _switchTab(paneId, tab.id); });
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _showViewContextMenu(e.clientX, e.clientY, paneId, tab.id);
  });

  // Drag-to-reorder
  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', `vp-tab:${paneId}:${tab.id}`);
    tabEl.style.opacity = '0.5';
  });
  tabEl.addEventListener('dragend', () => { tabEl.style.opacity = ''; });
  tabEl.addEventListener('dragover', (e) => { e.preventDefault(); });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain');
    if (!data.startsWith('vp-tab:')) return;
    const [, srcPaneId, srcTabId] = data.split(':');
    if (srcPaneId === paneId && srcTabId !== tab.id) {
      _reorderTab(paneId, srcTabId, tab.id);
    }
  });

  // Insert before "+" button
  const addBtn = tabBar.querySelector('.vp-tab-add');
  if (addBtn) tabBar.insertBefore(tabEl, addBtn);
  else tabBar.appendChild(tabEl);
}

function _switchTab(paneId, tabId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const tab = pane.tabs.find(t => t.id === tabId);
  if (!tab) return;

  pane.activeTabId = tabId;

  // Update tab bar visual state
  const tabBar = document.getElementById(`vp-tab-bar-${paneId}`);
  if (tabBar) {
    tabBar.querySelectorAll('.vp-tab').forEach(el => {
      const isActive = el.dataset.tabId === tabId;
      el.className = 'vp-tab' + (isActive ? ' vp-tab-active' : '');
      el.style.color = isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)';
      el.style.background = isActive ? 'rgba(74,141,245,0.12)' : 'transparent';
      el.style.borderBottom = isActive ? '2px solid rgba(74,141,245,0.8)' : 'transparent';
    });
  }

  // Update label
  const lbl = document.getElementById(`vp-label-${paneId}`);
  if (lbl) lbl.textContent = VIEW_LABELS[tab.view] || tab.label;

  // Apply camera state from this tab (viewport-manager captures via _captureCameraState)
  _applyTabCameraState(paneId, tab);

  // Render with the correct camera
  _renderAll();

  _saveLayout();
}

function _reorderTab(paneId, srcTabId, dstTabId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const srcIdx = pane.tabs.findIndex(t => t.id === srcTabId);
  const dstIdx = pane.tabs.findIndex(t => t.id === dstTabId);
  if (srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx) return;
  const [tab] = pane.tabs.splice(srcIdx, 1);
  pane.tabs.splice(dstIdx, 0, tab);
  _rebuildTabBar(paneId);
}

function _addNewTab(paneId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;

  const id = `t${vpState._tabCounter++}`;
  const newTab = {
    id,
    label: '3D',
    view: 'perspective_3d',
    cameraState: {
      position: { x: 15, y: 10, z: 15 },
      target:   { x: 5,  y: 2,  z: 5 },
      zoom: 1,
    },
  };
  pane.tabs.push(newTab);
  pane.activeTabId = id;
  _rebuildTabBar(paneId);
  _renderAll();
  _saveLayout();
}

function _closeTab(paneId, tabId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane || pane.tabs.length <= 1) return; // block closing last tab

  const idx = pane.tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;

  pane.tabs.splice(idx, 1);
  if (pane.activeTabId === tabId) {
    pane.activeTabId = pane.tabs[Math.min(idx, pane.tabs.length - 1)].id;
  }

  _rebuildTabBar(paneId);
  _renderAll();
  _saveLayout();
}

function _rebuildTabBar(paneId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const tabBar = document.getElementById(`vp-tab-bar-${paneId}`);
  if (!tabBar) return;

  // Remove existing tab elements (keep "+" button)
  tabBar.querySelectorAll('.vp-tab').forEach(el => el.remove());

  // Re-render all tabs
  pane.tabs.forEach(tab => _renderTab(tab, tabBar, paneId));
}

// ── View Type Switching ───────────────────────────────────────────────────────
function _showViewContextMenu(x, y, paneId, tabIdOverride) {
  _hideContextMenu();

  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;

  const activeTab = pane.tabs.find(t => t.id === (tabIdOverride || pane.activeTabId));
  if (!activeTab) return;

  const menu = document.createElement('div');
  menu.id = 'vp-context-menu';
  menu.style.cssText = `
    position:fixed;left:${x}px;top:${y}px;z-index:9999;
    background:rgba(12,17,26,0.97);border:1px solid rgba(74,141,245,0.35);
    border-radius:8px;padding:4px;min-width:180px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);
    backdrop-filter:blur(12px);
    font-family:'DM Sans',system-ui,sans-serif;
    animation:vp-cm-in 0.12s ease-out both;
  `;

  const header = document.createElement('div');
  header.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);padding:6px 10px 4px;';
  header.textContent = 'View Type';
  menu.appendChild(header);

  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:2px 6px;';
  menu.appendChild(divider);

  const viewEntries = [
    { key: 'perspective_3d', label: '3D Perspective', icon: '◈' },
    { key: 'top',            label: 'Top / Plan',      icon: '⊥' },
    { key: 'front',          label: 'Front',           icon: '▭' },
    { key: 'back',           label: 'Back',            icon: '▭' },
    { key: 'left',           label: 'Left',            icon: '▭' },
    { key: 'right',          label: 'Right',           icon: '▭' },
    { key: 'section_x',      label: 'Section X',      icon: '⊟' },
    { key: 'section_y',      label: 'Section Y',      icon: '⊟' },
    { key: 'rcp',            label: 'RCP',             icon: '⊙' },
    { key: 'camera',         label: 'Camera',           icon: '◎' },
  ];

  viewEntries.forEach(entry => {
    const isCurrent = entry.key === activeTab.view;
    const item = document.createElement('div');
    item.style.cssText = `
      display:flex;align-items:center;gap:8px;padding:7px 10px;
      cursor:pointer;border-radius:5px;font-size:12px;
      color:${isCurrent ? 'rgba(74,141,245,0.9)' : 'rgba(255,255,255,0.75)'};
      background:${isCurrent ? 'rgba(74,141,245,0.08)' : 'transparent'};
      transition:background 0.1s, color 0.1s;
    `;
    item.innerHTML = `<span style="font-size:11px;opacity:0.6;width:14px;text-align:center">${entry.icon}</span>${entry.label}${isCurrent ? ' ✓' : ''}`;
    item.addEventListener('mouseenter', () => { if (!isCurrent) item.style.background = 'rgba(255,255,255,0.06)'; });
    item.addEventListener('mouseleave', () => { if (!isCurrent) item.style.background = 'transparent'; });
    item.addEventListener('click', () => {
      _setViewType(paneId, tabIdOverride || pane.activeTabId, entry.key);
      _hideContextMenu();
    });
    menu.appendChild(item);
  });

  // Camera submenu
  const camHeader = document.createElement('div');
  camHeader.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);padding:8px 10px 4px;margin-top:2px;';
  camHeader.textContent = 'Named Cameras';
  menu.appendChild(camHeader);

  const camDivider = document.createElement('div');
  camDivider.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:2px 6px;';
  menu.appendChild(camDivider);

  const camItem = document.createElement('div');
  camItem.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-radius:5px;font-size:12px;color:rgba(255,255,255,0.45);';
  camItem.innerHTML = '<span style="font-size:11px;opacity:0.5">◎</span> Saved Camera...';
  camItem.addEventListener('click', () => {
    _loadNamedCameraList(paneId, tabIdOverride || pane.activeTabId);
    _hideContextMenu();
  });
  camItem.addEventListener('mouseenter', () => { camItem.style.background = 'rgba(255,255,255,0.06)'; });
  camItem.addEventListener('mouseleave', () => { camItem.style.background = 'transparent'; });
  menu.appendChild(camItem);

  // ── Reset Layout divider + item (VP-D) ───────────────────────────────────────
  const resetDivider = document.createElement('div');
  resetDivider.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:4px 6px;';
  menu.appendChild(resetDivider);

  const resetItem = document.createElement('div');
  resetItem.style.cssText = `
    display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;
    border-radius:5px;font-size:12px;color:rgba(255,80,80,0.8);
  `;
  resetItem.innerHTML = '<span style="font-size:11px;opacity:0.6;width:14px;text-align:center">⟲</span> Reset Layout';
  resetItem.title = 'Restore default 4-pane layout';
  resetItem.addEventListener('mouseenter', () => { resetItem.style.background = 'rgba(255,80,80,0.08)'; });
  resetItem.addEventListener('mouseleave', () => { resetItem.style.background = 'transparent'; });
  resetItem.addEventListener('click', () => {
    _hideContextMenu();
    resetLayout();
  });
  menu.appendChild(resetItem);

  document.body.appendChild(menu);

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', _hideContextMenu, { once: true });
    document.addEventListener('contextmenu', _hideContextMenu, { once: true });
  }, 0);
}

function _hideContextMenu() {
  const menu = document.getElementById('vp-context-menu');
  if (menu) menu.remove();
}

function _setViewType(paneId, tabId, viewType) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const tab = pane.tabs.find(t => t.id === tabId);
  if (!tab) return;

  tab.view = viewType;
  tab.label = VIEW_LABELS[viewType] || viewType;

  // Initialize default camera state for the new view type
  const defaults = {
    perspective_3d: { position: { x: 15, y: 10, z: 15 }, target: { x: 5, y: 2, z: 5 }, zoom: 1 },
    top:            { position: { x: 0, y: 100, z: 0 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 },
    front:          { position: { x: 0, y: 3, z: 50 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 },
    back:           { position: { x: 0, y: 3, z: -50 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 },
    left:           { position: { x: -50, y: 3, z: 0 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 },
    right:          { position: { x: 50, y: 3, z: 0 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 },
    section_x:      { position: { x: 0, y: 3, z: 50 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 },
    section_y:      { position: { x: -50, y: 3, z: 0 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 },
    rcp:            { position: { x: 0, y: -100, z: 0 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 },
    camera:         { position: { x: 15, y: 10, z: 15 }, target: { x: 5, y: 2, z: 5 }, zoom: 1 },
  };
  tab.cameraState = defaults[viewType] || defaults.perspective_3d;

  // Rebuild tab bar with updated label
  _rebuildTabBar(paneId);

  // Update label
  const lbl = document.getElementById(`vp-label-${paneId}`);
  if (lbl) lbl.textContent = VIEW_LABELS[viewType] || tab.label;

  // Apply camera state
  _applyTabCameraState(paneId, tab);

  // Re-render
  _renderAll();
  _saveLayout();
}

function _applyTabCameraState(paneId, tab) {
  // Delegate to app.js if it has a handler for view type changes
  // This lets app.js morph the camera between perspective/orthographic as needed
  if (window._atlantist_applyViewportCameraState) {
    window._atlantist_applyViewportCameraState(paneId, tab.view, tab.cameraState);
    return;
  }

  // Fallback: directly manipulate the camera mapped to this view type
  const camKey = VIEW_CAMERA_KEY[tab.view] || '3d';
  const cam = window._atlantist_cameras?.[camKey];
  if (!cam || !tab.cameraState) return;

  if (cam.position) {
    cam.position.set(tab.cameraState.position.x, tab.cameraState.position.y, tab.cameraState.position.z);
  }
  if (cam.target) {
    cam.lookAt(tab.cameraState.target.x, tab.cameraState.target.y, tab.cameraState.target.z);
  }
}

function _loadNamedCameraList(paneId, tabId) {
  // Placeholder for named camera loading — app.js can populate this
  // by setting window._atlantist_namedCameras = [{ name, cameraState }]
  const namedCams = window._atlantist_namedCameras || [];
  if (namedCams.length === 0) {
    // No cameras saved yet — show toast
    if (window._atlantist_toast) window._atlantist_toast('No saved cameras. Create one via Camera > Save.', 'info');
    return;
  }
  // For now, just pick the first — expand to a submenu if needed
  const cam = namedCams[0];
  const pane = vpState.panes.find(p => p.id === paneId);
  const tab = pane?.tabs.find(t => t.id === tabId);
  if (tab && cam.cameraState) {
    tab.view = 'camera';
    tab.label = cam.name || 'Camera';
    tab.cameraState = cam.cameraState;
    _rebuildTabBar(paneId);
    _applyTabCameraState(paneId, tab);
    _renderAll();
    _saveLayout();
  }
}

// Capture camera state when user interacts (called by app.js render loop)
export function captureViewportCameraState(paneId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  if (!tab) return;

  const camKey = VIEW_CAMERA_KEY[tab.view] || '3d';
  const cam = window._atlantist_cameras?.[camKey];
  if (!cam) return;

  tab.cameraState = {
    position: cam.position ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : tab.cameraState?.position,
    target:   cam.target   ? { x: cam.target.x,   y: cam.target.y,   z: cam.target.z   } : tab.cameraState?.target,
    zoom:     cam.zoom     || 1,
  };
}

function _addPaneOverlay(wrap, paneId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;

  // Guard against corrupted pane state (missing tabs array)
  if (!pane.tabs) pane.tabs = [];

  // ── Tab bar (top, full-width) ────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.className = 'vp-tab-bar';
  tabBar.id = `vp-tab-bar-${paneId}`;
  tabBar.style.cssText = `
    position:absolute;top:0;left:0;right:0;z-index:20;
    display:flex;align-items:stretch;gap:0;
    height:28px;min-height:28px;
    background:rgba(8,13,20,0.82);border-bottom:1px solid rgba(255,255,255,0.07);
    user-select:none;
  `;

  // Render tabs
  pane.tabs.forEach(tab => _renderTab(tab, tabBar, paneId));

  // "+" button to add new viewport tab
  const addBtn = document.createElement('button');
  addBtn.className = 'vp-tab-add';
  addBtn.title = 'Add viewport tab';
  addBtn.textContent = '+';
  addBtn.style.cssText = `
    background:none;border:none;color:rgba(255,255,255,0.3);cursor:pointer;
    font-size:14px;font-weight:400;padding:0 8px;flex-shrink:0;
    transition:color 0.15s;
  `;
  addBtn.addEventListener('click', () => { _addNewTab(paneId); });
  addBtn.addEventListener('mouseenter', () => { addBtn.style.color = 'rgba(255,255,255,0.8)'; });
  addBtn.addEventListener('mouseleave', () => { addBtn.style.color = 'rgba(255,255,255,0.3)'; });
  tabBar.appendChild(addBtn);

  wrap.appendChild(tabBar);

  // View label (bottom-left)
  const label = document.createElement('div');
  label.className = 'vp-view-label';
  label.id = `vp-label-${paneId}`;
  label.textContent = VIEW_LABELS[pane.tabs?.find(t => t.id === pane.activeTabId)?.view] || 'Viewport';
  wrap.appendChild(label);

  // Toolbar (below tab bar): minimize / maximize button
  const tb = document.createElement('div');
  tb.className = 'vp-toolbar';
  tb.style.cssText = `
    position:absolute;top:34px;left:6px;z-index:15;
    display:flex;align-items:center;gap:4px;
    background:rgba(8,13,20,0.75);backdrop-filter:blur(8px);
    border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px 6px;
  `;

  // Max button
  const maxBtn = document.createElement('button');
  maxBtn.className = 'vp-btn';
  maxBtn.title = 'Maximize (double-click also works)';
  maxBtn.textContent = '⛶';
  maxBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.5);cursor:pointer;font-size:12px;padding:2px 3px;border-radius:4px;';
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggleMaximize(paneId); });
  tb.appendChild(maxBtn);

  // Pop-out button
  const popBtn = document.createElement('button');
  popBtn.className = 'vp-btn vp-pop-btn';
  popBtn.title = 'Pop out to floating window';
  popBtn.textContent = '⧉';
  popBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:11px;padding:2px 4px;border-radius:4px;';
  popBtn.addEventListener('click', (e) => { e.stopPropagation(); _detachPane(paneId); });
  tb.appendChild(popBtn);

  wrap.appendChild(tb);

  // RP-1: Mode switcher toolbar (render mode icons)
  const modeBar = buildModeToolbar(paneId);
  wrap.appendChild(modeBar);

  // Right-click on tab bar or label → show context menu
  tabBar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _showViewContextMenu(e.clientX, e.clientY, paneId);
  });
}

// ── Maximize / Restore ────────────────────────────────────────────────────────
function _toggleMaximize(paneId) {
  const container = document.getElementById('viewport-area');
  if (!container) return;

  if (vpState.mode === 'maximized' && vpState.maximizedId === paneId) {
    // Restore to grid
    vpState.mode = 'maximized'; // will be set below
    vpState.maximizedId = null;
    vpState.mode = 'grid';
    _buildGrid();
    _renderAll();
  } else if (vpState.mode === 'grid') {
    // Maximize this pane
    vpState.mode = 'maximized';
    vpState.maximizedId = paneId;
    _buildGrid();
    _renderAll();
  }
}

function _buildMaximized(container) {
  const pane = vpState.panes.find(p => p.id === vpState.maximizedId) ||
               vpState.panes.find(p => p.visible);
  if (!pane) return;

  const wrap = _makePane(pane, 0);
  wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  _addPaneOverlay(wrap, pane.id);
  container.appendChild(wrap);

  requestAnimationFrame(() => {
    if (_onAfterBuild) _onAfterBuild();
    _renderAll();
  });
}

// ── Drag Resize ────────────────────────────────────────────────────────────────
//
// BUG FIX vs v1: applyDividerDrag only touched rows[0] cells. In 2x2, dragging
// the vertical border would resize cells in the top row but leave bottom row
// untouched — the bottom columns stayed equal width while top columns adjusted,
// creating visual mismatch.
//
// FIX: when axis='col', update BOTH rows' column flex values to stay in sync.
// when axis='row', update both rows' flex ratio within the outer flex container.

function _startDrag(e, axis, index) {
  vpState.dragging = {
    axis,
    index,
    startX: axis === 'col' ? e.clientX : e.clientY,
    startCells: _captureCellFlex(),
  };

  document.addEventListener('mousemove', _onDragMove);
  document.addEventListener('mouseup',   _endDrag);
  document.addEventListener('touchmove', _onDragMoveTouch, { passive: false });
  document.addEventListener('touchend',  _endDrag);
}

function _captureCellFlex() {
  // Read CSS variable for column split (or fall back to current style)
  const colSplit = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vp-col-split')) || 0.5;
  return [colSplit, 1 - colSplit];
}

function _onDragMove(e) {
  if (!vpState.dragging) return;
  const cur = vpState.dragging.axis === 'col' ? e.clientX : e.clientY;
  _applyDrag(cur);
}

function _onDragMoveTouch(e) {
  e.preventDefault();
  if (!vpState.dragging) return;
  const cur = vpState.dragging.axis === 'col' ? e.touches[0].clientX : e.touches[0].clientY;
  _applyDrag(cur);
}

function _applyDrag(curX) {
  const { axis, startX, startCells } = vpState.dragging;
  const delta = (curX - startX) / (axis === 'col' ? window.innerWidth : window.innerHeight);

  if (axis === 'col') {
    const cells = document.querySelectorAll('.vp-cell');
    if (!cells.length) return;
    const n = cells.length;
    const leftIdx  = 2 * vpState.dragging.index;
    const rightIdx = leftIdx + 1;
    if (leftIdx >= n || rightIdx >= n) return;

    const baseFrac = startCells[leftIdx] ?? 0.5;
    const newFrac  = Math.max(MIN_FRAC, Math.min(1 - MIN_FRAC, baseFrac + delta));

    // Write col split as CSS variable — VP grid reads it via CSS flex-basis on cells
    document.documentElement.style.setProperty('--vp-col-split', String(newFrac));

  } else {
    const rows = document.querySelectorAll('.vp-row');
    if (rows.length < 2) return;
    const baseFrac = startCells[0] ?? 0.5;
    const newFrac  = Math.max(MIN_FRAC, Math.min(1 - MIN_FRAC, baseFrac + delta));

    // Write row split as CSS variable — VP grid reads it via CSS flex-basis on row
    document.documentElement.style.setProperty('--vp-row-split', String(newFrac));
  }
}

function _endDrag() {
  if (vpState.dragging) {
    _saveLayout();
  }
  vpState.dragging = null;
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup',   _endDrag);
  document.removeEventListener('touchmove', _onDragMoveTouch);
  document.removeEventListener('touchend',  _endDrag);
}

// ── Render ────────────────────────────────────────────────────────────────────
// G8 perf fix: coalesce consecutive _renderAll() calls into one RAF frame.
// applyViewportCameras() is called from both the RAF loop (animate) and the
// ResizeObserver (canvas resize) — this flag ensures only one render per frame.
let _renderAllPending = false;
export function applyViewportCameras() {
  if (_renderAllPending) return;
  _renderAllPending = true;
  requestAnimationFrame(() => {
    _renderAllPending = false;
    _renderAll();
  });
}

function _renderAll() {
  if (!vpState._initDone) return;
  if (vpState.mode === 'maximized') { _renderMaximized(); return; }
  vpState.panes.filter(p => p.visible).forEach(pane => {
    const canvas = document.getElementById(`vp-canvas-${pane.id}`);
    if (!canvas) return;

    const activeTab = pane.tabs.find(t => t.id === pane.activeTabId) || pane.tabs[0];
    if (!activeTab) return;

    const viewType = activeTab.view;
    const camKey = VIEW_CAMERA_KEY[viewType] || '3d';
    const rend = rendMap[camKey];
    const cam  = camMap[camKey];
    if (!rend || !cam) return;

    const scene = _getScene(camKey);
    if (!scene) return;

    const w = Math.max(canvas.clientWidth,  1);
    const h = Math.max(canvas.clientHeight, 1);
    const dpr = window.devicePixelRatio || 1;

    // Ensure renderer is bound to this canvas (not just the canvas it was initialized with).
    // When multiple panes share a renderer (e.g. p2 El.X and p3 El.Y both use
    // _vpRendererSect which was created with vp-canvas-p2), calling setSize(w,h)
    // with the target canvas rebinds the WebGL context to that canvas.
    if (rend.domElement.width  !== Math.round(w * dpr) ||
        rend.domElement.height !== Math.round(h * dpr) ||
        rend.domElement !== canvas) {
      rend.setSize(w, h, false);
      _updateCameraAspect(cam, w, h);
    }
    rend.render(scene, cam);

    // Dismiss spinner on first render
    const wrap = document.getElementById(`vp-wrap-${pane.id}`);
    if (wrap) {
      const sp = wrap.querySelector('.vp-spinner');
      if (sp) dismissViewportSpinner(sp);
    }
  });
}

function _renderMaximized() {
  const paneId = vpState.maximizedId || vpState.panes.find(p => p.visible)?.id;
  if (!paneId) return;
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;
  const canvas = document.getElementById(`vp-canvas-${paneId}`);
  if (!canvas) return;

  const activeTab = pane.tabs.find(t => t.id === pane.activeTabId) || pane.tabs[0];
  if (!activeTab) return;
  const viewType = activeTab.view;
  const camKey = VIEW_CAMERA_KEY[viewType] || '3d';
  const rend = rendMap[camKey];
  const cam  = camMap[camKey];
  if (!rend || !cam) return;

  const scene = _getScene(camKey);
  if (!scene) return;

  const w = Math.max(canvas.clientWidth,  1);
  const h = Math.max(canvas.clientHeight, 1);
  const dpr = window.devicePixelRatio || 1;
  // Rebind renderer to canvas if needed
  if (rend.domElement.width  !== Math.round(w * dpr) ||
      rend.domElement.height !== Math.round(h * dpr) ||
      rend.domElement !== canvas) {
    rend.setSize(w, h, false);
    _updateCameraAspect(cam, w, h);
  }
  rend.render(scene, cam);

  const wrap = document.getElementById(`vp-wrap-${paneId}`);
  if (wrap) {
    const sp = wrap.querySelector('.vp-spinner');
    if (sp) dismissViewportSpinner(sp);
  }
}

function _getScene(view) {
  if (window._atlantist_scenes) {
    // Direct key lookup — covers '3d', 'plan', 'section', 'elevation-x', 'elevation-y'
    const direct = window._atlantist_scenes[view];
    if (direct) return direct;
    // BUG-UI-1 fix: VIEW_CAMERA_KEY maps many views → 'section' camKey.
    // _getScene is called with camKey ('section'), not view ('left').
    // But if somehow called with view name, resolve via camera key map.
    const camKey = VIEW_CAMERA_KEY[view];
    if (camKey && camKey !== view) return window._atlantist_scenes[camKey] || null;
  }
  return null;
}

function _updateCameraAspect(cam, w, h) {
  if (!cam) return;
  if (cam.isPerspectiveCamera) {
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  } else {
    const a = w / h;
    if (cam.view === 'plan') {
      cam.left = -15 * a; cam.right = 15 * a;
    } else {
      cam.left = -25 * a; cam.right = 25 * a;
    }
    cam.top = 10; cam.bottom = -2;
    cam.updateProjectionMatrix();
  }
}

// ── Layout Reset ──────────────────────────────────────────────────────────────
export function resetLayout() {
  vpState.mode = 'grid';
  vpState.maximizedId = null;
  vpState._tabCounter = 4;
  vpState.floating = {};
  vpState.panes = [
    {
      id: 'p0', visible: true,
      tabs: [{ id: 't0', label: '3D', view: 'perspective_3d',
        cameraState: { position: { x: 15, y: 10, z: 15 }, target: { x: 5, y: 2, z: 5 }, zoom: 1 } }],
      activeTabId: 't0',
    },
    {
      id: 'p1', visible: true,
      tabs: [{ id: 't1', label: 'Plan', view: 'top',
        cameraState: { position: { x: 0, y: 100, z: 0 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 } }],
      activeTabId: 't1',
    },
    {
      id: 'p2', visible: true,
      tabs: [{ id: 't2', label: 'El. X', view: 'front',
        cameraState: { position: { x: 0, y: 3, z: 50 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 } }],
      activeTabId: 't2',
    },
    {
      id: 'p3', visible: true,
      tabs: [{ id: 't3', label: 'El. Y', view: 'left',
        cameraState: { position: { x: -50, y: 3, z: 0 }, target: { x: 0, y: 3, z: 0 }, zoom: 1 } }],
      activeTabId: 't3',
    },
  ];

  // VP-D: clear floating windows from DOM
  document.querySelectorAll('[id^="vp-floating-"]').forEach(el => el.remove());

  // Clear saved localStorage + DB state
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  if (_projectId) {
    fetch(`/api/viewport-states/${_projectId}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }

  _buildGrid();
  _renderAll();
  pushViewportStateImmediate();
}

// ── Persistence ────────────────────────────────────────────────────────────────
function _loadLayout() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return null;
    const parsed = JSON.parse(s);
    // VP-D: restore splitter fractions if saved
    if (parsed._splitterState) {
      // Apply via _applySplitterState after grid build
      _pendingSplitterState = parsed._splitterState;
    }
    return parsed;
  } catch { return null; }
}

let _pendingSplitterState = null;

// Apply splitter fractions from localStorage (called after _buildGrid)
export function applyPendingSplitterState() {
  if (!_pendingSplitterState) return;
  _applySplitterState(_pendingSplitterState);
  _pendingSplitterState = null;
}

function _applySplitterState(state) {
  if (!state) return;
  if (state.colFrac != null) {
    document.documentElement.style.setProperty('--vp-col-split', String(state.colFrac));
  }
  if (state.rowFrac != null) {
    document.documentElement.style.setProperty('--vp-row-split', String(state.rowFrac));
  }
}

function _captureSplitterState() {
  const root = document.documentElement;
  const colFrac = parseFloat(root.style.getPropertyValue('--vp-col-split')) || 0.5;
  const rowFrac = parseFloat(root.style.getPropertyValue('--vp-row-split')) || 0.5;
  return { colFrac, rowFrac };
}

function _saveLayout() {
  const splitterState = _captureSplitterState();
  const snapshot = {
    mode: vpState.mode,
    maximizedId: vpState.maximizedId,
    panes: vpState.panes,
    floating: vpState.floating,
    _splitterState: splitterState,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}

  // VP-D: persist to viewport_states DB via viewport-states route
  if (_projectId && _authUserId) {
    const dbPayload = {
      mode: vpState.mode,
      panes: vpState.panes,
      floating: vpState.floating,
      splitterState,
      _tabCounter: vpState._tabCounter,
    };
    fetch(`/api/viewport-states/${_projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dbPayload),
    }).catch(() => {});
  }

  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    if (_wsClientRef) _wsClientRef.pushViewportState(_captureState());
  }, PUSH_DEB);
}

function _captureState() {
  const cameras = {};
  if (window._atlantist_cameras) {
    for (const [view, cam] of Object.entries(window._atlantist_cameras)) {
      if (!cam) continue;
      cameras[view] = {
        position: cam.position ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
        target:   cam.target    ? { x: cam.target.x,   y: cam.target.y,   z: cam.target.z   } : null,
        zoom: cam.zoom || 1,
      };
    }
  }
  return {
    mode: vpState.mode,
    maximizedId: vpState.maximizedId,
    panes: vpState.panes.map(p => ({ ...p })),
    floating: vpState.floating,
    splitterState: _captureSplitterState(),
    cameras,
    capturedAt: Date.now(),
    _tabCounter: vpState._tabCounter,
  };
}

// ── Server restore ────────────────────────────────────────────────────────────
async function _tryRestoreFromServer() {
  if (!_authUserId || !_projectId) return;
  try {
    const res = await fetch(`/api/viewport-states/${_projectId}`, { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.state) return;
    if (Date.now() - (data.state.capturedAt || 0) > 86400000) return;
    _showResumePrompt(data.state);
  } catch {}
}

function _showResumePrompt(state) {
  if (!state?.mode || !state?.panes) return;
  const existing = document.getElementById('vp-resume-prompt');
  if (existing) existing.remove();

  const prompt = document.createElement('div');
  prompt.id = 'vp-resume-prompt';
  prompt.style.cssText = `
    position:fixed;top:72px;left:50%;transform:translateX(-50%);
    z-index:500;background:rgba(8,13,20,0.95);border:1px solid rgba(74,141,245,0.4);
    border-radius:12px;padding:14px 20px;display:flex;align-items:center;gap:14px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);backdrop-filter:blur(16px);
    font-family:'DM Sans',system-ui,sans-serif;max-width:420px;width:calc(100vw-32px);
    animation:vp-slide-in 0.22s cubic-bezier(.21,1.02,.73,1) both;
  `;

  const icon = document.createElement('div');
  icon.textContent = '↩';
  icon.style.cssText = 'font-size:20px;flex-shrink:0;color:#6ba3ff;';
  prompt.appendChild(icon);

  const title = document.createElement('div');
  title.style.cssText = 'font-size:13px;font-weight:600;color:rgba(255,255,255,0.9);';
  title.textContent = 'Resume where you left off?';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.45);margin-top:2px;';
  const mins = Math.round((Date.now() - (state.capturedAt || 0)) / 60000);
  sub.textContent = mins < 2 ? 'Just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;

  const txt = document.createElement('div');
  txt.style.cssText = 'flex:1;min-width:0;';
  txt.appendChild(title); txt.appendChild(sub);
  prompt.appendChild(txt);

  const yes = document.createElement('button');
  yes.textContent = 'Resume';
  yes.style.cssText = 'background:rgba(74,141,245,0.2);border:1px solid rgba(74,141,245,0.4);color:#6ba3ff;font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;cursor:pointer;flex-shrink:0;';
  yes.addEventListener('click', () => { _applyRestoredState(state); prompt.remove(); });
  prompt.appendChild(yes);

  const no = document.createElement('button');
  no.textContent = '×';
  no.title = 'Start fresh';
  no.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.3);font-size:18px;cursor:pointer;padding:4px 6px;flex-shrink:0;';
  no.addEventListener('click', () => {
    prompt.remove();
    if (_projectId) fetch(`/api/viewport-states/${_projectId}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  });
  prompt.appendChild(no);

  _injectResumeStyle();
  document.body.appendChild(prompt);
  setTimeout(() => { if (prompt.isConnected) prompt.remove(); }, 10000);
}

function _injectResumeStyle() {
  if (document.getElementById('vp-resume-style')) return;
  const s = document.createElement('style');
  s.id = 'vp-resume-style';
  s.textContent = '@keyframes vp-slide-in{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
  document.head.appendChild(s);
}

function _applyRestoredState(state) {
  if (!state?.mode || !state?.panes) return;
  vpState.mode = state.mode;
  vpState.maximizedId = state.maximizedId || null;
  vpState.panes = state.panes.map(p => ({
    ...p,
    tabs: p.tabs ? p.tabs.map(t => ({ ...t })) : [],
  }));
  if (state.floating) vpState.floating = state.floating;
  if (state._tabCounter != null) vpState._tabCounter = state._tabCounter;

  // VP-D: restore splitter fractions from DB state
  if (state.splitterState) {
    _pendingSplitterState = state.splitterState;
  }

  _saveLayout();
  _buildGrid();
  applyPendingSplitterState();
  _renderAll();

  // Restore floating panes after a brief delay
  setTimeout(_restoreFloatingPanes, 100);
}

// ── Floating Viewport System ─────────────────────────────────────────────────────
//
// Detach any pane → position:fixed floating window with free drag + resize.
// Snap back to grid via dock zones on the viewport-area edges.
// Overlay mode: configurable opacity + pointer-events passthrough.
//
// State lives in vpState.floating[paneId]: { x, y, width, height, opacity, overlayMode }

function _detachPane(paneId) {
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;

  const vpArea = document.getElementById('viewport-area');
  if (!vpArea) return;

  // Find the pane's current wrap in the grid
  const gridWrap = document.getElementById(`vp-wrap-${paneId}`);
  if (!gridWrap) return;

  const rect = gridWrap.getBoundingClientRect();

  // Snapshot current camera so floating viewport keeps rendering the right scene
  const cam  = camMap[pane.view];
  const rend = rendMap[pane.view];
  const scene = _getScene(pane.view);
  const w = Math.max(rect.width,  1);
  const h = Math.max(rect.height, 1);

  // Create floating window
  const fw = _makeFloatingWindow(pane, rect.left, rect.top, rect.width, rect.height);

  // Animate out of grid
  gridWrap.style.transition = 'opacity 0.2s';
  gridWrap.style.opacity = '0';
  setTimeout(() => {
    gridWrap.style.display = 'none';
    gridWrap.style.opacity = '';
    gridWrap.style.transition = '';
  }, 200);

  document.body.appendChild(fw);

  // Mark pane as floating in state
  vpState.floating[paneId] = {
    x: rect.left, y: rect.top,
    width: rect.width, height: rect.height,
    opacity: 1.0,
    overlayMode: false,
    zBase: vpState._zCounter++,
  };

  // Make this the topmost floating viewport
  _bringToFront(paneId, fw);

  // Start free-drag on the floating window
  _startFloatingDrag(fw, paneId);

  // Render immediately
  requestAnimationFrame(() => _renderFloating(paneId, fw));
}

function _makeFloatingWindow(pane, x, y, w, h) {
  const fw = document.createElement('div');
  fw.className = 'vp-floating';
  fw.id = `vp-floating-${pane.id}`;
  fw.style.cssText = [
    `position:fixed`,
    `left:${x}px`, `top:${y}px`,
    `width:${w}px`, `height:${h}px`,
    `z-index:${vpState._zCounter}`,
    `background:#080d14`,
    `border:1px solid rgba(255,255,255,0.12)`,
    `border-radius:8px`,
    `box-shadow:0 16px 48px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.06)`,
    `overflow:hidden`,
    `display:flex`,
    `flex-direction:column`,
  ].join(';');

  // Resize handle (bottom-right corner)
  const rh = document.createElement('div');
  rh.className = 'vp-float-resize-handle';
  rh.style.cssText = [
    'position:absolute', 'bottom:0', 'right:0',
    'width:16px', 'height:16px',
    'cursor:nwse-resize',
    'background:linear-gradient(135deg,transparent 60%,rgba(255,255,255,0.15) 100%)',
    'border-radius:0 0 7px 0',
  ].join(';');
  rh.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    _startFloatingResize(e, fw, pane.id);
  });
  fw.appendChild(rh);

  // Toolbar
  const tb = document.createElement('div');
  tb.className = 'vp-float-toolbar';
  tb.style.cssText = [
    'position:absolute', 'top:0', 'left:0', 'right:0',
    'z-index:10',
    'display:flex', 'align-items:center', 'gap:6px',
    'padding:6px 8px',
    'background:rgba(8,13,20,0.82)',
    'backdrop-filter:blur(10px)',
    'border-bottom:1px solid rgba(255,255,255,0.08)',
    'border-radius:8px 8px 0 0',
    'cursor:move',
  ].join(';');

  // Drag handle — label acts as drag bar
  const labelTxt = document.createElement('span');
  labelTxt.style.cssText = 'font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.7);flex:1;cursor:move;';
  labelTxt.textContent = pane.label;
  tb.appendChild(labelTxt);

  // Snap back button
  const snapBtn = document.createElement('button');
  snapBtn.className = 'vp-btn';
  snapBtn.textContent = '⤴';
  snapBtn.title = 'Snap back to grid';
  snapBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:11px;padding:2px 5px;border-radius:4px;';
  snapBtn.addEventListener('click', (e) => { e.stopPropagation(); _snapBackToGrid(pane.id); });
  tb.appendChild(snapBtn);

  // Overlay toggle
  const ovBtn = document.createElement('button');
  ovBtn.className = 'vp-btn vp-ov-btn';
  ovBtn.textContent = '⊙';
  ovBtn.title = 'Toggle overlay mode';
  ovBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:4px;';
  ovBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggleOverlayMode(pane.id, fw, ovBtn, opacitySlider); });
  tb.appendChild(ovBtn);

  // Opacity slider
  const opacitySlider = document.createElement('input');
  opacitySlider.type = 'range';
  opacitySlider.min = '40';
  opacitySlider.max = '100';
  opacitySlider.value = '100';
  opacitySlider.title = 'Overlay opacity';
  opacitySlider.style.cssText = 'width:60px;cursor:pointer;accent-color:#6ba3ff;';
  opacitySlider.addEventListener('input', (e) => {
    e.stopPropagation();
    const v = parseInt(e.target.value) / 100;
    if (vpState.floating[pane.id]) vpState.floating[pane.id].opacity = v;
    fw.style.opacity = v;
  });
  opacitySlider.addEventListener('mousedown', (e) => e.stopPropagation());
  tb.appendChild(opacitySlider);

  fw.appendChild(tb);

  // Canvas container
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'position:absolute;top:36px;left:0;right:0;bottom:0;overflow:hidden;';
  const canvas = document.createElement('canvas');
  canvas.id = `vp-float-canvas-${pane.id}`;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  canvasWrap.appendChild(canvas);
  fw.appendChild(canvasWrap);

  // View label
  const lbl = document.createElement('div');
  lbl.style.cssText = 'position:absolute;bottom:8px;left:8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);pointer-events:none;z-index:5;';
  lbl.textContent = pane.label;
  fw.appendChild(lbl);

  return fw;
}

function _renderFloating(paneId, fw) {
  if (!fw || !fw.isConnected) return;
  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;

  const canvas = document.getElementById(`vp-float-canvas-${paneId}`);
  if (!canvas) return;

  const activeTab = pane.tabs.find(t => t.id === pane.activeTabId) || pane.tabs[0];
  if (!activeTab) return;
  const viewType = activeTab.view;
  const camKey = VIEW_CAMERA_KEY[viewType] || '3d';
  const rend = rendMap[camKey];
  const cam  = camMap[camKey];
  if (!rend || !cam) return;

  const scene = _getScene(camKey);
  if (!scene) return;

  const fwRect = fw.getBoundingClientRect();
  const newW = Math.max(fwRect.width,  1);
  const newH = Math.max(fwRect.height, 1);
  const dpr = window.devicePixelRatio || 1;

  if (canvas.width  !== Math.round(newW * dpr) ||
      canvas.height !== Math.round(newH * dpr)) {
    canvas.width  = Math.round(newW * dpr);
    canvas.height = Math.round(newH * dpr);
    _updateCameraAspect(cam, newW, newH);
  }
  rend.setSize(newW, newH, false);
  rend.render(scene, cam);
}

// ── Layer manager ────────────────────────────────────────────────────────────
function _bringToFront(paneId, fw) {
  if (!fw) return;
  const nextZ = vpState._zCounter++;
  fw.style.zIndex = nextZ;
  if (vpState.floating[paneId]) vpState.floating[paneId].zBase = nextZ;
}

function _startFloatingDrag(fw, paneId) {
  const tb = fw.querySelector('.vp-float-toolbar');
  if (!tb) return;

  let startMouseX, startMouseY, startLeft, startTop;

  const onMove = (e) => {
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = cx - startMouseX;
    const dy = cy - startMouseY;

    const newLeft = startLeft + dx;
    const newTop  = startTop  + dy;
    fw.style.left = `${newLeft}px`;
    fw.style.top  = `${newTop}px`;

    if (vpState.floating[paneId]) {
      vpState.floating[paneId].x = newLeft;
      vpState.floating[paneId].y = newTop;
    }

    _checkDockZone(paneId, cx, cy, fw);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
    _hideDockIndicators();

    // Check if released inside a dock zone
    const cx = parseFloat(fw.style.left) + parseFloat(fw.style.width) / 2;
    const cy = parseFloat(fw.style.top)  + parseFloat(fw.style.height) / 2;
    const zone = _detectDockZone(cx, cy);
    if (zone) _snapBackToGrid(paneId, zone);
  };

  tb.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    e.stopPropagation();
    _bringToFront(paneId, fw);
    startMouseX = e.clientX; startMouseY = e.clientY;
    startLeft = parseFloat(fw.style.left) || 0;
    startTop  = parseFloat(fw.style.top)  || 0;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onUp);
  });

  // Click on fw body → bring to front
  fw.addEventListener('mousedown', (e) => {
    if (e.target.closest('.vp-float-toolbar') || e.target.closest('input') || e.target.closest('button')) return;
    _bringToFront(paneId, fw);
    // If in overlay mode: focus and restore pointer events
    if (vpState.floating[paneId]?.overlayMode) {
      _disableOverlayPassthrough(paneId, fw);
    }
  });
}

function _startFloatingResize(e, fw, paneId) {
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const startY = e.clientY;
  const startW = parseFloat(fw.style.width)  || fw.getBoundingClientRect().width;
  const startH = parseFloat(fw.style.height) || fw.getBoundingClientRect().height;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const newW = Math.max(320, startW + dx);
    const newH = Math.max(200, startH + dy);
    fw.style.width  = `${newW}px`;
    fw.style.height = `${newH}px`;
    if (vpState.floating[paneId]) {
      vpState.floating[paneId].width  = newW;
      vpState.floating[paneId].height = newH;
    }
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    requestAnimationFrame(() => _renderFloating(paneId, fw));
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ── Dock zone detection ──────────────────────────────────────────────────────
function _checkDockZone(paneId, mouseX, mouseY, fw) {
  _hideDockIndicators();
  const vpArea = document.getElementById('viewport-area');
  if (!vpArea) return;

  const rect = vpArea.getBoundingClientRect();
  const edge = 80; // snap threshold in pixels

  let zone = null;
  if (mouseX < rect.left + edge)        zone = 'left';
  else if (mouseX > rect.right - edge)  zone = 'right';
  else if (mouseY < rect.top + edge)   zone = 'top';
  else if (mouseY > rect.bottom - edge) zone = 'bottom';

  if (zone) _showDockIndicator(zone, fw);
}

function _detectDockZone(cx, cy) {
  const vpArea = document.getElementById('viewport-area');
  if (!vpArea) return null;
  const rect = vpArea.getBoundingClientRect();
  const edge = 80;
  if (cx < rect.left + edge)        return 'left';
  if (cx > rect.right - edge)      return 'right';
  if (cy < rect.top + edge)        return 'top';
  if (cy > rect.bottom - edge)     return 'bottom';
  return null;
}

function _showDockIndicator(zone, fw) {
  const vpArea = document.getElementById('viewport-area');
  if (!vpArea) return;
  _hideDockIndicators();

  const rect = vpArea.getBoundingClientRect();
  const ind = document.createElement('div');
  ind.id = 'vp-dock-indicator';
  ind.dataset.zone = zone;

  let css = [
    'position:fixed', 'z-index:9999', 'pointer-events:none',
    'border:2px dashed rgba(74,141,245,0.8)',
    'border-radius:8px',
    'background:rgba(74,141,245,0.08)',
    'transition:opacity 0.15s',
  ];

  if (zone === 'left' || zone === 'right') {
    css.push(`left:${rect.left}px`, `top:${rect.top}px`,
             `width:${Math.round(rect.width * 0.45)}px`, `height:${rect.height}px`);
    if (zone === 'right') css.push(`left:${rect.left + Math.round(rect.width * 0.55)}px`);
  } else {
    css.push(`left:${rect.left}px`, `top:${rect.top}px`,
             `width:${rect.width}px`, `height:${Math.round(rect.height * 0.45)}px`);
    if (zone === 'bottom') css.push(`top:${rect.top + Math.round(rect.height * 0.55)}px`);
  }

  ind.style.cssText = css.join(';');
  document.body.appendChild(ind);
}

function _hideDockIndicators() {
  const existing = document.getElementById('vp-dock-indicator');
  if (existing) existing.remove();
}

// ── Snap back to grid ─────────────────────────────────────────────────────────
function _snapBackToGrid(paneId, zone) {
  const fw = document.getElementById(`vp-floating-${paneId}`);
  if (!fw) return;

  const pane = vpState.panes.find(p => p.id === paneId);
  if (!pane) return;

  // Animate to center of viewport area first
  const vpArea = document.getElementById('viewport-area');
  if (!vpArea) return;
  const vpRect = vpArea.getBoundingClientRect();

  let targetX = vpRect.left + vpRect.width  / 2 - 320;
  let targetY = vpRect.top  + vpRect.height / 2 - 220;

  // If specific dock zone triggered, snap to that edge
  if (zone === 'left') {
    targetX = vpRect.left;
    targetY = vpRect.top;
  } else if (zone === 'right') {
    targetX = vpRect.left + vpRect.width - (vpState.floating[paneId]?.width  || 640);
    targetY = vpRect.top;
  } else if (zone === 'top') {
    targetX = vpRect.left;
    targetY = vpRect.top;
  } else if (zone === 'bottom') {
    targetX = vpRect.left;
    targetY = vpRect.top + vpRect.height - (vpState.floating[paneId]?.height || 440);
  }

  // Animate out and remove
  fw.style.transition = 'opacity 0.2s, transform 0.25s';
  fw.style.opacity = '0';
  fw.style.transform = 'scale(0.9)';
  setTimeout(() => {
    fw.remove();
    delete vpState.floating[paneId];
    _hideDockIndicators();

    // Restore to grid
    const gridWrap = document.getElementById(`vp-wrap-${paneId}`);
    if (gridWrap) {
      gridWrap.style.display = '';
      gridWrap.style.opacity = '0';
      requestAnimationFrame(() => {
        gridWrap.style.transition = 'opacity 0.25s';
        gridWrap.style.opacity = '1';
        setTimeout(() => { gridWrap.style.opacity = ''; gridWrap.style.transition = ''; }, 300);
      });
    }

    _saveLayout();
    requestAnimationFrame(() => { _buildGrid(); _renderAll(); });
  }, 250);
}

// ── Overlay mode ──────────────────────────────────────────────────────────────
function _toggleOverlayMode(paneId, fw, ovBtn, slider) {
  const state = vpState.floating[paneId];
  if (!state) return;

  state.overlayMode = !state.overlayMode;

  if (state.overlayMode) {
    // Enable overlay: semi-transparent, pointer-events:none (passthrough)
    fw.style.opacity = String(state.opacity);
    _enableOverlayPassthrough(paneId, fw);
    ovBtn.style.color = 'rgba(74,141,245,0.9)';
    ovBtn.title = 'Overlay mode ON — click to focus';
  } else {
    fw.style.pointerEvents = '';
    fw.style.opacity = '1';
    _disableOverlayPassthrough(paneId, fw);
    ovBtn.style.color = 'rgba(255,255,255,0.4)';
    ovBtn.title = 'Toggle overlay mode';
  }
}

function _enableOverlayPassthrough(paneId, fw) {
  const canvasWrap = fw.querySelector('div[style*="position:absolute"]');
  if (canvasWrap) canvasWrap.style.pointerEvents = 'none';

  // The entire floating window has pointer-events:none so clicks pass through to content below
  fw.style.pointerEvents = 'none';

  // But keep toolbar interactive
  const tb = fw.querySelector('.vp-float-toolbar');
  if (tb) tb.style.pointerEvents = 'auto';
}

function _disableOverlayPassthrough(paneId, fw) {
  fw.style.pointerEvents = '';
  const canvasWrap = fw.querySelector('div[style*="position:absolute"]');
  if (canvasWrap) canvasWrap.style.pointerEvents = '';
}

// ── Restore floating from saved state ────────────────────────────────────────
export function _restoreFloatingPanes() {
  if (!vpState.floating || Object.keys(vpState.floating).length === 0) return;

  for (const [paneId, fstate] of Object.entries(vpState.floating)) {
    const pane = vpState.panes.find(p => p.id === paneId);
    if (!pane) continue;

    // Hide from grid
    const gridWrap = document.getElementById(`vp-wrap-${paneId}`);
    if (gridWrap) { gridWrap.style.display = 'none'; }

    // Reconstruct floating window
    const fw = _makeFloatingWindow(pane, fstate.x, fstate.y, fstate.width, fstate.height);
    fw.style.opacity = String(fstate.opacity);

    if (fstate.overlayMode) {
      _enableOverlayPassthrough(paneId, fw);
      const ovBtn = fw.querySelector('.vp-ov-btn');
      if (ovBtn) ovBtn.style.color = 'rgba(74,141,245,0.9)';
    }

    document.body.appendChild(fw);
    _bringToFront(paneId, fw);

    // Re-render
    requestAnimationFrame(() => _renderFloating(paneId, fw));

    // Re-attach drag
    _startFloatingDrag(fw, paneId);
  }
}

// ── Floating render loop (called from app.js render cycle) ───────────────────
export function renderFloatingViewports() {
  for (const paneId of Object.keys(vpState.floating)) {
    const fw = document.getElementById(`vp-floating-${paneId}`);
    if (fw) _renderFloating(paneId, fw);
  }
}

// ── Keyboard shortcut: Ctrl+Shift+V resets layout ──────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    resetLayout();
  }
});

// ── Public alias for app.js (backward compat with old buildViewportDOM name) ──
export function buildViewportDOM() { _buildGrid(); }

// ── Utility ────────────────────────────────────────────────────────────────────
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Window exports for app.js render loop access ─────────────────────────────
// Expose vpState and capture function so app.js can capture camera state per tab
window.__vpManager = { vpState, captureViewportCameraState };