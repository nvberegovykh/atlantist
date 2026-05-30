/**
 * FPS monitor using stats.js — dev/debug mode only.
 * Wire to app.js animate() render loop. Show/hide via window.__atlStatsToggle().
 * Enabled via ?debugStats=true URL param or window.__atlForceStats = true.
 */
import Stats from 'https://cdn.jsdelivr.net/npm/stats.js@0.17.0/+esm';

let _stats = null;
let _enabled = false;

function isEnabled() {
  return window.__atlForceStats === true ||
    new URLSearchParams(location.search).has('debugStats');
}

function init() {
  if (_stats) return;
  _stats = new Stats();
  _stats.showPanel(0); // FPS panel — 0=ms, 1=fps, 2=mb
  _stats.dom.style.position = 'fixed';
  _stats.dom.style.top = '0';
  _stats.dom.style.left = '0';
  _stats.dom.style.right = 'auto';
  _stats.dom.style.zIndex = '99999';
  _stats.dom.style.pointerEvents = 'none';
  _stats.dom.style.opacity = '0.75';
  document.body.appendChild(_stats.dom);
}

// ─── Called every frame from animate() in app.js ──────────────────────────────
export function statsBegin() {
  if (!isEnabled()) return;
  if (!_stats) init();
  if (_stats) _stats.begin();
}

export function statsEnd() {
  if (!isEnabled()) return;
  if (_stats) _stats.end();
}

// ─── Toggle visibility ───────────────────────────────────────────────────────
export function statsToggle() {
  if (!_stats) { init(); _enabled = true; return; }
  _enabled = !_enabled;
  _stats.dom.style.display = _enabled ? 'block' : 'none';
}

window.__atlStatsToggle = statsToggle;

// ─── Wire to animate() — call statsBegin() at frame start, statsEnd() at end ─
export function wireToRenderLoop() {
  const origAnimate = window.__atlOrigAnimate;
  // Patch is done in app.js — this module just exports the helpers.
  // G8 performance verification uses the same slow-frame log (app.js line ~3520).
}

// ─── Expose internals for G8 verification ────────────────────────────────────
window.__atlStats = {
  begin: statsBegin,
  end: statsEnd,
  toggle: statsToggle,
  enabled: isEnabled,
};