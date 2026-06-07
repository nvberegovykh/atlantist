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
      // Project-view panels (only exist when a project is open)
      'btn-create-room': true, 'copy-room-code': true, 'btn-join-room': true,
      'collab-leave': true, 'ctx-send-finch3d': true, 'cancel-send-finch3d': true,
      'confirm-send-finch3d': true, 'ctx-validate-arcol': true,
      'cancel-validate-arcol': true, 'btn-run-arcol-validation': true,
      'confirm-validate-arcol': true, 'btn-dob-checklist': true,
      'dob-panel-close': true, 'btn-autofill-en1': true, 'dob-project-name': true,
      'dob-address': true, 'dob-bin': true, 'dob-zoning-district': true,
      'dob-occupancy-type': true, 'btn-generate-zd1': true, 'cancel-zd1': true,
      'download-zd1': true, 'btn-export-dob-ifc': true, 'btn-materials-schedule': true,
      'materials-panel-close': true, 'btn-export-materials-csv': true,
      'btn-energy-analysis': true, 'energy-cancel': true,
      'energy-dob-package-footer': true, 'en1wb-save-btn': true,
      'en1wb-save-bottom-btn': true, 'en1wb-export-xlsm-btn': true,
      'en1wb-export-xlsm-bottom-btn': true, 'en1wb-export-pdf-btn': true,
      'en1wb-export-pdf-bottom-btn': true, 'en1wb-roof-u-value': true,
      'en1wb-lpd-actual': true, 'en1wb-lpd-allowed': true,
      'close-profile': true, 'user-avatar-btn': true, 'menu-profile': true,
      'menu-collaborators': true, 'menu-projects': true, 'menu-contact': true,
      'menu-admin-matching': true, 'menu-signup': true, 'menu-logout': true,
      'close-contact': true, 'close-onboarding': true, 'send-invite-btn': true,
      'close-help': true, 'landing-submit': true, 'landing-skip': true,
      'optin-submit': true, 'modal-optin': true, 'history-filter-type': true,
      'settings-admins-close': true, 'modal-settings-admins': true,
      'promote-btn': true, 'btn-fire-protection': true, 'btn-fire-pdf-smoke': true,
      'btn-fds-play': true, 'fds-time-slider': true, 'btn-fds-export-fds': true,
      'btn-fds-3d-reset': true, 'btn-geotechnical': true, 'geo-tabs': true,
      'geo-result-tabs': true, 'geo-e': true, 'geo-gw': true,
      'geo-soil-preview-canvas': true, 'btn-geo-run-again': true,
      'btn-geo-clear': true, 'btn-geo-save-run': true, 'btn-db-save-cover': true,
      'btn-cancel-placeholder': true, 'btn-save-placeholder': true,
      'btn-db-product-search': true, 'db-product-query': true,
      'btn-db-export-procurement-csv': true, 'btn-db-export-csv': true,
      'btn-db-export-full': true, 'btn-db-export-contractor': true,
      'btn-db-export-open-items': true, 'db-svp-close': true,
      'btn-sheet-export-single': true, 'btn-sheet-export-set': true,
      'btn-auto-align-views': true, 'aap-cancel': true, 'aap-confirm': true,
      'vp-floating-p0': true, 'vp-floating-p1': true, 'vp-floating-p2': true,
      'vp-floating-p3': true, 'properties-panel': true, 'props-panel': true,
      'canvas-3d-wrap': true, 'canvas-plan-wrap': true, 'canvas-section-wrap': true,
      'viewcube-wrap': true, 'cursor-overlay-3d': true, 'snap-indicator': true,
      'canvas-3d': true, 'modal-landing': true, 'app-loading-overlay': true,
      'loading-bar': true, 'auto-align-popover': true,
      'vp-canvas-p1': true, 'vp-canvas-p2': true, 'vp-canvas-p3': true,
      'count-native': true,
      // Topbar buttons added dynamically by initAuth / addHelpButton
      'btn-forum': true, 'btn-collab': true, 'btn-render': true, 'btn-help': true,
      // User identity elements set after auth resolves
      'user-email': true, 'user-name': true, 'user-role': true,
      // Issues list panel
      'issues-list': true, 'btn-issues': true,
      // Explorer elements (Cloud OS Explorer — mounted dynamically)
      'cloud-explorer': true, 'expl-grid': true, 'expl-search': true,
      // Nav buttons (rendered dynamically by app.js toolbar init)
      'nav-btn-levels': true,
      'nav-btn-walls': true,
      'nav-btn-columns': true,
      'nav-btn-doors': true,
      'nav-btn-windows': true,
      'nav-btn-floors': true,
      'nav-btn-roofs': true,
      'nav-btn-stairs': true,
      'nav-btn-ceilings': true,
      'nav-btn-rooms': true,
      'update-banner': true,
      'expl-versions-panel': true,
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

// ── Sentry Browser SDK init ──────────────────────────────────────────────────
// Loaded from CDN to capture errors before app.js fully initializes.
// DSN is injected by the server via a <meta> tag or window.__SENTRY_DSN__.
// If DSN is not set, this is a no-op (Sentry will not initialize).
(function initSentryBrowser() {
  var dsn = (typeof window.__SENTRY_DSN__ !== 'undefined' && window.__SENTRY_DSN__) ||
            (document.querySelector('meta[name="sentry-dsn"]') || {}).content;
  if (!dsn) return; // no DSN configured — skip

  // Load Sentry browser SDK dynamically after page load to not block rendering
  window.addEventListener('load', function() {
    var s = document.createElement('script');
    s.src = 'https://browser.sentry-cdn.com/8.44.0/bundle.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function() {
      if (window.Sentry && typeof window.Sentry.init === 'function') {
        window.Sentry.init({
          dsn: dsn,
          environment: window.__SENTRY_ENV__ || 'production',
          // Capture 10% of sessions for performance monitoring
          tracesSampleRate: 0.1,
          // Integrate with existing onerror/unhandledrejection handlers
          integrations: [],
          beforeSend: function(event) {
            // Strip cookies and auth headers from events
            if (event.request) {
              delete event.request.cookies;
              if (event.request.headers) {
                delete event.request.headers['authorization'];
                delete event.request.headers['cookie'];
              }
            }
            return event;
          },
        });
        console.log('[boot-safety] Sentry browser SDK initialized');
      }
    };
    document.head.appendChild(s);
  });
})();
