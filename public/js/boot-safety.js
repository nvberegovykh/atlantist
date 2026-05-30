/**
 * Boot Safety — prevents white-screen crashes from null-element and HTML-as-JSON errors.
 * Owns: Response.prototype.json override, window.onerror, window.unhandledrejection handler.
 * Does NOT own: app logic, error route, or error monitoring UI.
 *
 * Must load before other scripts. window.onerror and unhandledrejection are set
 * synchronously on script load; the element-existence guards activate on DOMContentLoaded.
 */
(function () {
  'use strict';

  // ── Safe fetch .json() — catches HTML-as-JSON parse regression ─────────
  // Wraps Response.prototype.json to detect when a response is actually HTML
  // (302 to login, 500 error page, or SPA shell) instead of JSON.
  // Does NOT block .json() on non-OK responses — existing code uses that to
  // read JSON error bodies ({ error: "message" }) legitimately.
  var _origJson = Response.prototype.json;
  Response.prototype.json = function safeJson() {
    var res = this;
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    // If Content-Type is HTML or totally missing, the response is NOT JSON.
    // This is the "Unexpected token <" regression — throw a clear error instead.
    if (ct.includes('text/html') || ct.includes('text/plain')) {
      return res.clone().text().then(function (body) {
        throw new Error(
          '[safeFetch] Expected JSON but got Content-Type "' + ct +
          '" from ' + res.url + ' (HTTP ' + res.status + ') — body: ' + body.slice(0, 200)
        );
      });
    }
    // If response is not OK AND content-type doesn't look like JSON, guard
    if (!res.ok && !ct.includes('json')) {
      return res.clone().text().then(function (body) {
        throw new Error(
          '[safeFetch] HTTP ' + res.status + ' from ' + res.url +
          ' (Content-Type: ' + (ct || 'none') + ') — body: ' + body.slice(0, 200)
        );
      });
    }
    // Content-Type is JSON (or at least not HTML) — use native parser
    return _origJson.call(res);
  };

  // ── Top-level window.onerror handler ────────────────────────────────────
  // Catches synchronous JS errors (TypeError: null.addEventListener, etc.)
  // that would otherwise white-screen the app. POSTs to /api/client-errors.
  window.onerror = function (message, source, lineno, colno, error) {
    var msg = String(message || '(unknown error)');
    var stack = error instanceof Error ? error.stack : '';
    console.error('[boot-safety] window.onerror:', msg, 'at', source, lineno + ':' + colno);
    try {
      fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          source: source || '(unknown)',
          lineno: lineno || 0,
          colno: colno || 0,
          stack: stack || '(no stack)',
          url: window.location.href,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
        }),
      }).catch(function () {}); // never let the reporter crash
    } catch (_) {}
    return false; // don't suppress — let console show the error
  };

  // ── Unhandled promise rejection handler ─────────────────────────────────
  // Catches rejected fetch promises that would otherwise silently kill the app
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var msg = reason instanceof Error ? reason.message : String(reason || '(unknown)');
    var stack = reason instanceof Error ? reason.stack : '';
    console.error('[boot-safety] Unhandled rejection:', msg);
    // POST to /api/client-errors — fire-and-forget
    try {
      fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Unhandled rejection: ' + msg,
          source: 'boot-safety.js',
          stack: stack || '(no stack)',
          url: window.location.href,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
        }),
      }).catch(function () {}); // never let the reporter crash
    } catch (_) {}
  });

  // ── Null-element addEventListener guard ─────────────────────────────────
  // Track which selectors have already warned so we log once per (selector, page).
  // Monkey-patches activate on DOMContentLoaded — before that, body is not parsed.
  document.addEventListener('DOMContentLoaded', function () {
    var _warnedSelectors = {};

    var _origQS = Document.prototype.querySelector;
    Document.prototype.querySelector = function (sel) {
      var result = _origQS.call(this, sel);
      if (result === null) {
        var key = 'qs:' + sel + '@' + window.location.pathname;
        if (!_warnedSelectors[key]) {
          _warnedSelectors[key] = true;
          console.warn('[boot-safety] querySelector("' + sel + '") returned null on ' + window.location.pathname);
        }
      }
      return result;
    };

    // IDs known to be created dynamically after DOMContentLoaded — never warn.
    // These cover: conditionally-rendered modals/panels, deferred UI panels, and
    // elements referenced by app.js that don't exist in app.html (legacy refs).
    // Add new IDs here whenever a null-warn appears for a conditionally-present element.
    var _knownDynamicIds = {
      // App-shell elements only present on /app — not on /, /pricing, etc.
      'entry-screen-overlay': true,
      'props-tabs': true,
      'btn-share-presence': true,
      // Wallt widget elements — present on /app only, may not exist on other pages
      'wallt-styles': true,
      'wallt-trigger': true,
      'wallt-collapse': true,
      'wallt-new-chat': true,
      'wallt-send-btn': true,
      'wallt-settings-btn': true,
      'wallt-voice-toggle': true,
      'wallt-overlay': true,
      'wallt-panel': true,
      'wallt-input': true,
      'wallt-project-pill': true,
      'cmd-palette': true,
      'cmd-palette-overlay': true,
      // app.js command-palette (dynamically built)
      'command-palette': true,
      // Store & crafting panels
      'store-css': true,
      'crafting-palette': true,
      // Elevation view buttons
      'btn-elv-N': true,
      'btn-elv-S': true,
      'btn-elv-E': true,
      'btn-elv-W': true,
      // Viewport tabs
      'view-3d': true,
      'view-plan': true,
      'view-section': true,
      // CSV export
      'btn-export-csv': true,
      // Render dropdown / modals
      'render-dropdown': true,
      'render-action-trigger': true,
      'render-history-action': true,
      'render-history-close': true,
      'export-twinmotion-action': true,
      'cancel-export-twinmotion': true,
      'confirm-export-twinmotion': true,
      // CAD export modals
      'export-cad-action': true,
      'cancel-export-cad': true,
      'confirm-export-cad': true,
      'dxf-mode-2d': true,
      'dxf-mode-3d': true,
      // Collaboration tabs
      'collab-tab-share': true,
      'collab-tab-join': true,
    };

    var _origGEBI = Document.prototype.getElementById;
    Document.prototype.getElementById = function (id) {
      var result = _origGEBI.call(this, id);
      if (result === null && !_knownDynamicIds[id]) {
        var key = 'id:' + id + '@' + window.location.pathname;
        if (!_warnedSelectors[key]) {
          _warnedSelectors[key] = true;
          console.warn('[boot-safety] getElementById("' + id + '") returned null on ' + window.location.pathname);
        }
      }
      return result;
    };
  }, { once: true });
})();
