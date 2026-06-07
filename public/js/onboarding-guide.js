/**
 * onboarding-guide.js — Smart first-run tooltip guide for Atlantist.
 *
 * Owns: contextual tooltip hints anchored to UI elements, step-by-step coach marks,
 *       Revit-style "Learn more →" citations linking to /docs/features, persistent
 *       dismissal via localStorage, 7-step sequence covering core BIM workflow.
 *
 * Does NOT own: auth, THREE.js canvas, onboarding checklist modal, craft-tour overlay.
 *
 * Trigger: auto-starts on first authenticated session (atl_guide_done not set).
 * Manual: window.AtlGuide.start() to replay.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'atl_guide_done_v1';
  const GUIDE_Z     = 8500; // above entry screen, below supreme

  // ── Step definitions ──────────────────────────────────────────────────────
  // anchor: CSS selector of element to highlight (null = center screen)
  // pos: 'top'|'bottom'|'left'|'right'|'center' — tooltip placement relative to anchor
  // cite: { label, url } — Revit-style doc citation
  const STEPS = [
    {
      id: 'welcome',
      anchor: null,
      pos: 'center',
      title: 'Welcome to Atlantist',
      body: 'A real-time BIM workspace built for architects and engineers. This quick guide walks you through the core workflow — takes about 60 seconds.',
      cite: { label: 'Platform overview', url: '/docs/features' },
      cta: 'Start →',
    },
    {
      id: 'explorer',
      anchor: '#sidebar-left, .sidebar-left, [data-panel="explorer"]',
      pos: 'right',
      title: 'Cloud Explorer',
      body: 'Your project file system. Open or import RVT/RFA files, connect Google Drive, or link Autodesk Forma directly as a folder branch.',
      cite: { label: 'File formats & connectors', url: '/docs/features#explorer' },
      cta: 'Next →',
    },
    {
      id: 'toolbar',
      anchor: '#toolbar, .toolbar',
      pos: 'bottom',
      title: 'BIM Toolbar',
      body: 'Add walls, levels, doors, windows, structural elements, MEP fixtures, and roofs. Every element is parametric — edit dimensions, materials, and connections live.',
      cite: { label: 'Element types reference', url: '/docs/features#elements' },
      cta: 'Next →',
    },
    {
      id: 'viewport',
      anchor: '#three-canvas, canvas',
      pos: 'top',
      title: '3D Viewport',
      body: 'Orbit with right-click drag, pan with middle mouse, scroll to zoom. All geometry updates in real time as you edit parameters.',
      cite: { label: 'Navigation controls', url: '/docs/features#viewport' },
      cta: 'Next →',
    },
    {
      id: 'wallt',
      anchor: '#wallt-widget, .wallt-widget-btn, [id*="wallt"]',
      pos: 'left',
      title: 'Wallt AI Assistant',
      body: 'Ask about code compliance, structural loads, MEP coordination, or BIM model questions. Wallt answers in context — it sees your current model.',
      cite: { label: 'Wallt AI capabilities', url: '/docs/features#wallt' },
      cta: 'Next →',
    },
    {
      id: 'account',
      anchor: '#account-btn, [data-modal="account"], .nav-btn-account',
      pos: 'right',
      title: 'Your Account',
      body: 'Open Alpha — no subscription required. Your cost-based bill only starts if you use compute-heavy features like energy simulation or large file processing.',
      cite: { label: 'Cost-based pricing explained', url: '/pricing' },
      cta: 'Next →',
    },
    {
      id: 'done',
      anchor: null,
      pos: 'center',
      title: "You're ready",
      body: 'Start by opening or creating a project. Import an existing RVT file or begin from a blank template. The whole platform is yours.',
      cite: { label: 'Quick-start examples', url: '/docs/features#quickstart' },
      cta: 'Open Atlantist →',
    },
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let _step = 0;
  let _overlay, _card, _backdrop;
  let _prevHighlight = null;

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }

  function resolveAnchor(selectors) {
    if (!selectors) return null;
    for (const s of selectors.split(',')) {
      const el = $(s.trim());
      if (el) return el;
    }
    return null;
  }

  function getRect(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height,
             cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  // ── Build overlay DOM (once) ───────────────────────────────────────────────
  function buildDOM() {
    if ($('#atl-guide-backdrop')) return;

    _backdrop = document.createElement('div');
    _backdrop.id = 'atl-guide-backdrop';
    Object.assign(_backdrop.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(5,10,18,0.55)',
      zIndex: GUIDE_Z,
      transition: 'opacity 0.25s ease',
      opacity: '0',
      pointerEvents: 'none',
    });
    document.body.appendChild(_backdrop);

    _overlay = document.createElement('div');
    _overlay.id = 'atl-guide-overlay';
    Object.assign(_overlay.style, {
      position: 'fixed', inset: '0',
      zIndex: GUIDE_Z + 1,
      pointerEvents: 'none',
    });
    document.body.appendChild(_overlay);

    // Highlight ring
    const ring = document.createElement('div');
    ring.id = 'atl-guide-ring';
    Object.assign(ring.style, {
      position: 'absolute',
      border: '2px solid rgba(74,125,189,0.8)',
      borderRadius: '10px',
      boxShadow: '0 0 0 4px rgba(74,125,189,0.15), 0 0 32px rgba(74,125,189,0.25)',
      transition: 'all 0.3s cubic-bezier(0.34,1.2,0.64,1)',
      pointerEvents: 'none',
      display: 'none',
    });
    _overlay.appendChild(ring);

    // Tooltip card
    _card = document.createElement('div');
    _card.id = 'atl-guide-card';
    Object.assign(_card.style, {
      position: 'fixed',
      width: 'min(360px, calc(100vw - 32px))',
      background: '#0d1520',
      border: '1px solid rgba(74,125,189,0.35)',
      borderRadius: '14px',
      padding: '18px 20px 16px',
      boxShadow: '0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(74,125,189,0.1)',
      zIndex: GUIDE_Z + 2,
      pointerEvents: 'auto',
      transition: 'opacity 0.2s ease, transform 0.2s ease',
      opacity: '0',
      transform: 'translateY(8px)',
      fontFamily: 'inherit',
    });
    document.body.appendChild(_card);
  }

  // ── Position card relative to anchor ──────────────────────────────────────
  function positionCard(el, pos) {
    const W = window.innerWidth, H = window.innerHeight;
    const cw = 360;
    const ch = 200; // estimated card height
    let top, left;

    if (!el || pos === 'center') {
      top  = H / 2 - ch / 2;
      left = W / 2 - cw / 2;
    } else {
      const r = getRect(el);
      const GAP = 14;
      switch (pos) {
        case 'right':
          top  = r.cy - ch / 2;
          left = r.left + r.width + GAP;
          break;
        case 'left':
          top  = r.cy - ch / 2;
          left = r.left - cw - GAP;
          break;
        case 'bottom':
          top  = r.top + r.height + GAP;
          left = r.cx - cw / 2;
          break;
        case 'top':
        default:
          top  = r.top - ch - GAP;
          left = r.cx - cw / 2;
          break;
      }
      // Clamp to viewport
      left = Math.max(12, Math.min(left, W - cw - 12));
      top  = Math.max(12, Math.min(top,  H - ch - 12));
    }

    _card.style.top  = `${top}px`;
    _card.style.left = `${left}px`;
  }

  // ── Render step ───────────────────────────────────────────────────────────
  function renderStep(idx) {
    const step  = STEPS[idx];
    const isLast = idx === STEPS.length - 1;
    const anchor = resolveAnchor(step.anchor);
    const ring   = $('#atl-guide-ring');

    // Highlight ring
    if (_prevHighlight) {
      _prevHighlight.style.outline = '';
      _prevHighlight.style.outlineOffset = '';
    }
    if (anchor && ring) {
      const r = getRect(anchor);
      const PAD = 6;
      Object.assign(ring.style, {
        display: 'block',
        top:    `${r.top - PAD}px`,
        left:   `${r.left - PAD}px`,
        width:  `${r.width + PAD * 2}px`,
        height: `${r.height + PAD * 2}px`,
      });
      _prevHighlight = anchor;
    } else if (ring) {
      ring.style.display = 'none';
    }

    // Card content
    const skipBtn = idx > 0 ? '' : ''; // only show skip after first step
    _card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="display:flex;gap:5px">
          ${STEPS.map((_, i) => '<div style="width:' + (i===idx?'18px':'6px') + ';height:6px;border-radius:3px;background:' + (i===idx?'#4a7dbd':'rgba(74,125,189,0.25)') + ';transition:all 0.3s ease"></div>').join('')}
        </div>
        <button id="atl-guide-skip" style="background:none;border:none;color:#4a5568;font-size:12px;cursor:pointer;padding:2px 4px;font-family:inherit">Skip guide</button>
      </div>
      <div style="font-size:15px;font-weight:700;color:#f0f4ff;margin-bottom:7px;letter-spacing:-0.01em">${step.title}</div>
      <div style="font-size:13px;color:#8b95a5;line-height:1.55;margin-bottom:12px">${step.body}</div>
      ${step.cite ? `<a href="${step.cite.url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#4a7dbd;text-decoration:none;margin-bottom:14px;font-weight:500;letter-spacing:0.01em">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        ${step.cite.label}
      </a>` : ''}
      <div style="display:flex;gap:8px;align-items:center">
        ${idx > 0 ? `<button id="atl-guide-prev" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#8b95a5;font-size:13px;font-weight:500;padding:8px 14px;border-radius:8px;cursor:pointer;font-family:inherit">← Back</button>` : ''}
        <button id="atl-guide-next" style="flex:1;background:#1d5fa6;border:none;color:white;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;cursor:pointer;font-family:inherit;letter-spacing:0.01em">${step.cta || 'Next →'}</button>
      </div>
    `;

    // Bind buttons
    $('#atl-guide-next')?.addEventListener('click', () => isLast ? finish() : advance());
    $('#atl-guide-prev')?.addEventListener('click', () => retreat());
    $('#atl-guide-skip')?.addEventListener('click', () => finish());

    // Position
    positionCard(anchor, step.pos);

    // Animate in
    requestAnimationFrame(() => {
      _card.style.opacity = '1';
      _card.style.transform = 'translateY(0)';
    });
  }

  // ── Step controls ─────────────────────────────────────────────────────────
  function advance() {
    _card.style.opacity = '0';
    _card.style.transform = 'translateY(6px)';
    setTimeout(() => {
      _step = Math.min(_step + 1, STEPS.length - 1);
      renderStep(_step);
    }, 180);
  }

  function retreat() {
    _card.style.opacity = '0';
    _card.style.transform = 'translateY(-6px)';
    setTimeout(() => {
      _step = Math.max(_step - 1, 0);
      renderStep(_step);
    }, 180);
  }

  function finish() {
    // Fade out
    _card.style.opacity = '0';
    _backdrop.style.opacity = '0';
    const ring = $('#atl-guide-ring');
    if (ring) ring.style.display = 'none';

    setTimeout(() => {
      _card.style.display = 'none';
      _backdrop.style.pointerEvents = 'none';
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
      // Re-enable page interaction
      _backdrop.style.display = 'none';
    }, 300);

    // Telemetry
    try {
      fetch('/api/app-events', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_name: 'onboarding_guide_finished',
          properties: { steps_seen: _step + 1, total: STEPS.length },
          url: location.href,
        }),
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function start() {
    buildDOM();
    _step = 0;

    _backdrop.style.display = 'block';
    _backdrop.style.pointerEvents = 'auto';
    _card.style.display = 'block';

    requestAnimationFrame(() => {
      _backdrop.style.opacity = '1';
      renderStep(0);
    });

    // ESC to skip
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { finish(); document.removeEventListener('keydown', onEsc); }
    });

    // Telemetry
    try {
      fetch('/api/app-events', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_name: 'onboarding_guide_started', url: location.href }),
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Auto-start logic ──────────────────────────────────────────────────────
  function maybeAutoStart() {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return; // already completed
    } catch (_) {}

    // Wait for entry screen to clear + app to mount
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      // Check: entry screen is gone, canvas is visible, user is authenticated
      const entrySplash = document.getElementById('entry-splash');
      const entryDone = !entrySplash || entrySplash.style.display === 'none'
                        || entrySplash.classList.contains('hidden')
                        || getComputedStyle(entrySplash).opacity === '0';

      // Also check auth state
      const isAuthed = window.__atlasist_me?.authenticated || window._atlMe?.authenticated;

      if ((entryDone && isAuthed) || attempts > 60) {
        clearInterval(poll);
        if (entryDone) {
          // Short delay so app fully settles
          setTimeout(start, 800);
        }
      }
    }, 500);
  }

  // ── Expose globally ───────────────────────────────────────────────────────
  window.AtlGuide = { start, finish };

  // Auto-start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoStart);
  } else {
    maybeAutoStart();
  }

})();
