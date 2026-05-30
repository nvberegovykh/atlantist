/**
 * canvas-bootstrap.js — Single source of truth for the Three.js canvas elements.
 *
 * WHY THIS IS A MODULE:
 * app.js is 17,000+ lines and grows with every feature. Two or more separate
 * feature additions each declared `const canvas3dEl = document.getElementById('canvas-3d')`
 * at module scope, causing a SyntaxError on load and a 503 on /app. Extracting to a
 * dedicated module means there is exactly one declaration, one import path, and the
 * browser's ES module deduplication guarantees it runs once. Future agents: import
 * `canvas3dEl` from this file — never re-declare it inline.
 *
 * This module does NOT own: rendering, camera, controls, or scene setup.
 */

function requireDOMReady(id) {
  if (document.readyState === 'loading') {
    // Module evaluated before DOM parsed — return null; callers must null-guard.
    return null;
  }
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[canvas-bootstrap] DOM element #${id} not found — canvas may not be on this page`);
    return null;
  }
  return el;
}

// The three canvas elements used by Three.js renderers and 2D plan/section drawing.
// Exported as named constants — import { canvas3dEl } from './canvas-bootstrap.js'
// Use lazy getters so null guards are unnecessary at evaluation time.
export function getCanvas3dEl()      { return requireDOMReady('canvas-3d'); }
export function getCanvasPlanEl()    { return requireDOMReady('canvas-plan'); }
export function getCanvasSectionEl(){ return requireDOMReady('canvas-section'); }

// Backwards-compatible aliases — return null safely rather than crashing callers
// who imported them before this fix.
export const canvas3dEl      = typeof document !== 'undefined' ? getCanvas3dEl() : null;
export const canvasPlanEl    = typeof document !== 'undefined' ? getCanvasPlanEl() : null;
export const canvasSectionEl = typeof document !== 'undefined' ? getCanvasSectionEl() : null;

