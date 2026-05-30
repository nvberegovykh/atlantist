/**
 * loading-manager.js — Singleton for all loading-state UI in Atlantist.
 * Owns: viewport spinners, BIM skeleton overlays, simulation progress bars,
 *       RVT import multi-stage progress, save indicator pill.
 * Does NOT own: the full-page app-loading-overlay (inline in app.html).
 */

// ── Save pill ─────────────────────────────────────────────────────────────────
// Single shared pill element, created once on first use.
let _pillEl = null;
let _pillTimer = null;
let _pillFadeTimer = null;

function _getPill() {
  if (!_pillEl) {
    _pillEl = document.getElementById('atl-save-pill');
    if (!_pillEl) {
      _pillEl = document.createElement('div');
      _pillEl.id = 'atl-save-pill';
      document.body.appendChild(_pillEl);
    }
  }
  return _pillEl;
}

/**
 * Flash the save pill.
 * @param {'saved'|'retrying'|'offline'} state
 * @param {string} [label] — defaults to state-based text
 * @param {number} [ms] — how long to show before fade (0 = sticky)
 */
export function showSavePill(state, label, ms) {
  const pill = _getPill();
  const labels = { saved: 'Saved', retrying: 'Retrying…', offline: 'Offline — queued' };
  const displayMs = ms ?? (state === 'saved' ? 1000 : state === 'retrying' ? 3000 : 0);

  clearTimeout(_pillTimer);
  clearTimeout(_pillFadeTimer);

  pill.textContent = label || labels[state] || 'Saved';
  pill.dataset.state = state;
  pill.classList.remove('atl-save-pill--fading');
  pill.classList.add('atl-save-pill--visible');

  if (displayMs > 0) {
    // Start fade-out BEFORE display expires so it overlaps
    _pillFadeTimer = setTimeout(() => {
      pill.classList.add('atl-save-pill--fading');
    }, Math.max(0, displayMs - 300));

    _pillTimer = setTimeout(() => {
      pill.classList.remove('atl-save-pill--visible', 'atl-save-pill--fading');
    }, displayMs);
  }
}

export function hideSavePill() {
  clearTimeout(_pillTimer);
  clearTimeout(_pillFadeTimer);
  const pill = _getPill();
  pill.classList.remove('atl-save-pill--visible', 'atl-save-pill--fading');
}

// ── Viewport spinners ─────────────────────────────────────────────────────────
const VP_LABELS = {
  '3d':          'Initializing 3D viewport…',
  'plan':        'Initializing plan view…',
  'elevation-x': 'Initializing elevation…',
  'elevation-y': 'Initializing elevation…',
  'section':     'Initializing section…',
  'rcp':         'Initializing RCP view…',
};

/**
 * Inject a spinner into a viewport pane wrapper element.
 * Called by viewport-manager.js when a pane is created.
 * @param {HTMLElement} wrapEl — the .vp-wrap div
 * @param {string} viewType — e.g. '3d', 'plan'
 * @returns {HTMLElement} the spinner element (so caller can dismiss it)
 */
export function injectViewportSpinner(wrapEl, viewType) {
  if (!wrapEl) {
    console.warn('[loading-manager] injectViewportSpinner: wrapEl is null/undefined — skipping');
    return null;
  }
  // Remove any pre-existing spinner first
  wrapEl.querySelector('.vp-spinner')?.remove();

  const label = VP_LABELS[viewType] || 'Initializing viewport…';

  // prefers-reduced-motion: skip ring animation, show static text only
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const spinner = document.createElement('div');
  spinner.className = 'vp-spinner';
  spinner.setAttribute('aria-label', label);
  spinner.setAttribute('role', 'status');
  // pointer-events:none so the spinner never blocks canvas clicks or orbit controls
  spinner.style.cssText = 'pointer-events:none;z-index:5;';

  if (!prefersReduced) {
    const ring = document.createElement('div');
    ring.className = 'vp-spinner__ring';
    ring.setAttribute('aria-hidden', 'true');
    spinner.appendChild(ring);
  }

  const text = document.createElement('span');
  text.className = 'vp-spinner__label';
  text.textContent = prefersReduced ? label : label.replace('Initializing ', '');
  spinner.appendChild(text);

  wrapEl.appendChild(spinner);
  return spinner;
}

/**
 * Dismiss a viewport spinner (crossfade out, then remove from DOM).
 * Call this once Three.js has rendered its first frame into the canvas.
 * @param {HTMLElement} spinnerEl
 */
export function dismissViewportSpinner(spinnerEl) {
  if (!spinnerEl) return;
  spinnerEl.classList.add('vp-spinner--gone');
  // Remove from DOM after CSS transition completes (80ms defined in CSS)
  setTimeout(() => spinnerEl.remove(), 100);
}

// ── BIM model skeleton screens ────────────────────────────────────────────────

/**
 * Build and inject a skeleton overlay into a panel element.
 * @param {HTMLElement} panelEl — the panel to cover (must have position:relative)
 * @param {'tree'|'props'|'viewport'} kind
 * @returns {HTMLElement} overlay element
 */
export function injectSkeletonOverlay(panelEl, kind) {
  if (!panelEl) {
    console.warn('[loading-manager] injectSkeletonOverlay: panelEl is null/undefined — skipping');
    return null;
  }
  const existing = panelEl.querySelector('.atl-skeleton-overlay,.atl-skel-viewport');
  if (existing) return existing;

  if (kind === 'viewport') {
    return _injectViewportSkeleton(panelEl);
  }

  const overlay = document.createElement('div');
  overlay.className = 'atl-skeleton-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  if (kind === 'tree') {
    overlay.append(
      ..._buildTreeSkeletonRows(),
    );
  } else if (kind === 'props') {
    overlay.append(
      ..._buildPropsSkeletonRows(),
    );
  }

  panelEl.style.position = 'relative';
  panelEl.appendChild(overlay);
  return overlay;
}

/**
 * Dismiss and crossfade out a skeleton overlay.
 * @param {HTMLElement} overlayEl
 */
export function dismissSkeletonOverlay(overlayEl) {
  if (!overlayEl) return;
  const goneClass = overlayEl.classList.contains('atl-skel-viewport')
    ? 'atl-skel-viewport--gone'
    : 'atl-skeleton-overlay--gone';
  overlayEl.classList.add(goneClass);
  // Remove after 200ms CSS crossfade
  setTimeout(() => overlayEl.remove(), 220);
}

function _injectViewportSkeleton(panelEl) {
  const overlay = document.createElement('div');
  overlay.className = 'atl-skel-viewport';
  overlay.setAttribute('aria-hidden', 'true');

  const ring = document.createElement('div');
  ring.className = 'vp-spinner__ring';

  const txt = document.createElement('span');
  txt.className = 'vp-spinner__label';
  txt.textContent = 'Loading model…';

  overlay.appendChild(ring);
  overlay.appendChild(txt);
  panelEl.style.position = 'relative';
  panelEl.appendChild(overlay);
  return overlay;
}

function _buildTreeSkeletonRows() {
  // 7 rows: mix of top-level and indented items to mimic a project tree
  const patterns = [
    { indent: false, width: '70%' },
    { indent: true,  width: '55%' },
    { indent: true,  width: '62%' },
    { indent: false, width: '65%' },
    { indent: true,  width: '48%' },
    { indent: true,  width: '58%' },
    { indent: false, width: '60%' },
  ];
  return patterns.map(({ indent, width }) => {
    const row = document.createElement('div');
    row.className = 'atl-skeleton atl-skel-tree-row' + (indent ? ' atl-skel-tree-row--indent' : '');
    row.style.width = width;
    return row;
  });
}

function _buildPropsSkeletonRows() {
  // 5 label+value pairs
  const widths = [
    { l: '30%', v: '55%' },
    { l: '25%', v: '60%' },
    { l: '35%', v: '45%' },
    { l: '28%', v: '50%' },
    { l: '32%', v: '52%' },
  ];
  return widths.map(({ l, v }) => {
    const row = document.createElement('div');
    row.className = 'atl-skel-prop';
    const label = document.createElement('div');
    label.className = 'atl-skeleton atl-skel-prop__label';
    label.style.width = l;
    const value = document.createElement('div');
    value.className = 'atl-skeleton atl-skel-prop__value';
    value.style.width = v;
    row.appendChild(label);
    row.appendChild(value);
    return row;
  });
}

// ── Simulation / analysis progress bar ────────────────────────────────────────

const _activeProgress = new Map(); // key → { el, startMs, intervalId }

/**
 * Show a simulation progress bar.
 * @param {string} key — unique key (e.g. 'energy', 'structural', 'fire')
 * @param {string} title — e.g. 'Running EnergyPlus…'
 * @param {string[]} stages — ordered stage labels
 */
export function showSimProgress(key, title, stages) {
  hideSimProgress(key); // clear any previous for this key

  const el = document.createElement('div');
  el.className = 'atl-sim-progress';
  el.id = `atl-sim-progress-${key}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  el.innerHTML = `
    <div class="atl-sim-progress__header">
      <span class="atl-sim-progress__title">${_esc(title)}</span>
      <span class="atl-sim-progress__elapsed" data-elapsed>0s</span>
    </div>
    <div class="atl-sim-progress__track">
      <div class="atl-sim-progress__fill atl-sim-progress__fill--indeterminate" data-fill></div>
    </div>
    <div class="atl-sim-progress__stage" data-stage-label></div>
    ${stages.length ? `<div class="atl-sim-progress__stages" data-stages>
      ${stages.map((s, i) => `<span class="atl-sim-progress__stage-dot${i === 0 ? ' atl-sim-progress__stage-dot--active' : ''}" data-stage-idx="${i}">${_esc(s)}</span>`).join('')}
    </div>` : ''}
  `;

  document.body.appendChild(el);

  const startMs = Date.now();
  const elapsedEl = el.querySelector('[data-elapsed]');
  const intervalId = setInterval(() => {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    if (elapsedEl) elapsedEl.textContent = sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m${sec%60}s`;
  }, 1000);

  // Set first stage label
  const stageLabelEl = el.querySelector('[data-stage-label]');
  if (stageLabelEl && stages.length) stageLabelEl.textContent = stages[0];

  _activeProgress.set(key, { el, startMs, intervalId, stages, currentStage: 0 });
}

/**
 * Advance to a specific stage (0-indexed) and optionally set a real percent.
 * @param {string} key
 * @param {number} stageIdx
 * @param {number} [pct] — 0–100; omit for indeterminate
 */
export function advanceSimStage(key, stageIdx, pct) {
  const entry = _activeProgress.get(key);
  if (!entry) return;
  const { el, stages } = entry;

  // Update stage label
  const stageLabelEl = el.querySelector('[data-stage-label]');
  if (stageLabelEl && stages[stageIdx]) stageLabelEl.textContent = stages[stageIdx];

  // Update stage dots
  el.querySelectorAll('[data-stage-idx]').forEach(dot => {
    const idx = parseInt(dot.dataset.stageIdx, 10);
    dot.classList.remove('atl-sim-progress__stage-dot--active', 'atl-sim-progress__stage-dot--done');
    if (idx < stageIdx) dot.classList.add('atl-sim-progress__stage-dot--done');
    else if (idx === stageIdx) dot.classList.add('atl-sim-progress__stage-dot--active');
  });

  // Update fill bar
  const fillEl = el.querySelector('[data-fill]');
  if (fillEl) {
    if (pct != null) {
      fillEl.classList.remove('atl-sim-progress__fill--indeterminate');
      fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    } else {
      fillEl.classList.add('atl-sim-progress__fill--indeterminate');
      fillEl.style.width = '';
    }
  }

  entry.currentStage = stageIdx;
}

/**
 * Hide and remove a simulation progress bar.
 * @param {string} key
 */
export function hideSimProgress(key) {
  const entry = _activeProgress.get(key);
  if (!entry) return;
  clearInterval(entry.intervalId);
  entry.el.remove();
  _activeProgress.delete(key);
}

// ── RVT import multi-stage ────────────────────────────────────────────────────
const RVT_STAGES = [
  'Uploading to APS…',
  'Translating…',
  'Extracting geometry…',
  'Building DAG…',
];

export function showRvtProgress() {
  showSimProgress('rvt', 'Importing .rvt model', RVT_STAGES);
  const el = document.getElementById('atl-sim-progress-rvt');
  if (el) el.id = 'atl-rvt-progress'; // alias for CSS targeting
}

export function advanceRvtStage(stageIdx, pct) {
  advanceSimStage('rvt', stageIdx, pct);
}

export function hideRvtProgress() {
  hideSimProgress('rvt');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Global api() wrapper: auto-show save pill on mutations ────────────────────
// Called from app.js after the api() function is defined.
// Patches window.atlApiMutationHook if present; alternatively app.js calls
// showSavePill directly after each mutation.
// (This file does not import app.js to avoid circular deps.)
