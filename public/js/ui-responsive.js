/**
 * ui-responsive.js — Keyboard shortcuts, touch/gesture support, responsive toolbar,
 * loading overlay, and Tracker tab wiring.
 * Does NOT own: Three.js scene, API calls, WebSocket. Only UI chrome.
 */
(function () {
  'use strict';

  // ─── Loading overlay — dismiss once Three.js canvas paints ──────────────
  const loadingBar = document.getElementById('loading-bar');
  const loadingOverlay = document.getElementById('app-loading-overlay');
  let loadingPct = 0;
  const tickLoading = setInterval(() => {
    loadingPct = Math.min(loadingPct + 8 + Math.random() * 12, 92);
    if (loadingBar) loadingBar.style.width = loadingPct + '%';
  }, 200);

  function dismissLoading() {
    clearInterval(tickLoading);
    if (loadingBar) loadingBar.style.width = '100%';
    if (loadingOverlay) {
      loadingOverlay.classList.add('fade-out');
      setTimeout(() => loadingOverlay.remove(), 400);
    }
  }

  // Dismiss on first canvas paint or after 3s fallback
  const canvas3d = document.getElementById('canvas-3d');
  if (canvas3d) {
    const obs = new MutationObserver(() => { dismissLoading(); obs.disconnect(); });
    obs.observe(canvas3d, { attributes: true });
    // Also check if canvas is already attached to a WebGL context
    requestAnimationFrame(() => {
      if (canvas3d.getContext && (canvas3d.width > 0 || canvas3d.height > 0)) dismissLoading();
    });
  }
  setTimeout(dismissLoading, 3000);

  // ─── Secondary toolbar toggle (mobile) ──────────────────────────────────
  const toolbar = document.getElementById('secondary-toolbar');
  const toggleBtn = document.getElementById('btn-toolbar-toggle');
  const mainLayout = document.querySelector('.main-layout');

  function updateToolbarVisibility() {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      if (!toolbar.classList.contains('collapsed')) {
        toolbar.classList.add('collapsed');
        mainLayout.classList.remove('toolbar-visible');
      }
    } else {
      toolbar.classList.remove('collapsed');
      mainLayout.classList.remove('toolbar-visible');
    }
  }

  if (toggleBtn && toolbar) {
    toggleBtn?.addEventListener('click', () => {
      toolbar.classList.toggle('collapsed');
      mainLayout.classList.toggle('toolbar-visible', !toolbar.classList.contains('collapsed'));
    });
  }
  window.addEventListener('resize', updateToolbarVisibility);
  updateToolbarVisibility();

  // ─── Properties panel — bottom sheet on mobile ──────────────────────────
  const propsPanel = document.getElementById('properties-panel');
  const propsClose = document.getElementById('btn-close-props');

  function openPropsPanel() {
    if (window.innerWidth <= 768 && propsPanel) {
      propsPanel.classList.add('mobile-open');
      propsPanel.classList.remove('hidden');
    }
  }
  function closePropsPanel() {
    if (window.innerWidth <= 768 && propsPanel) {
      propsPanel.classList.remove('mobile-open');
    }
  }
  if (propsClose) propsClose?.addEventListener('click', closePropsPanel);

  // ─── Tracker tab wiring ────────────────────────────────────────────────
  const tabTracker = document.getElementById('tab-tracker');
  const trackerContent = document.getElementById('tracker-content');
  const tabProps = document.getElementById('tab-props');
  const tabIssues = document.getElementById('tab-issues');
  const tabSchedule = document.getElementById('tab-schedule');
  const propsContent = document.getElementById('properties-content');
  const issuesContent = document.getElementById('issues-content');
  const scheduleContent = document.getElementById('schedule-content');

  function switchTab(activeTab) {
    const tabs = [tabProps, tabIssues, tabSchedule, tabTracker];
    const contents = [propsContent, issuesContent, scheduleContent, trackerContent];
    tabs.forEach((t, i) => {
      if (!t || !contents[i]) return;
      if (t === activeTab) {
        t.classList.add('active');
        contents[i].classList.remove('hidden');
      } else {
        t.classList.remove('active');
        contents[i].classList.add('hidden');
      }
    });
    openPropsPanel();
  }

  if (tabTracker) tabTracker?.addEventListener('click', () => switchTab(tabTracker));
  // Re-wire existing tabs to use same function for consistency
  if (tabProps) tabProps?.addEventListener('click', () => switchTab(tabProps));
  if (tabIssues) tabIssues?.addEventListener('click', () => switchTab(tabIssues));
  if (tabSchedule) tabSchedule?.addEventListener('click', () => switchTab(tabSchedule));

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────
  const shortcutsModal = document.getElementById('modal-shortcuts');
  const shortcutsClose = document.getElementById('shortcuts-modal-close');
  const shortcutsBtn = document.getElementById('btn-shortcuts');

  function showShortcuts() {
    if (shortcutsModal) shortcutsModal.classList.remove('hidden');
  }
  function hideShortcuts() {
    if (shortcutsModal) shortcutsModal.classList.add('hidden');
  }
  if (shortcutsBtn) shortcutsBtn?.addEventListener('click', showShortcuts);
  if (shortcutsClose) shortcutsClose?.addEventListener('click', hideShortcuts);
  if (shortcutsModal) {
    shortcutsModal?.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) hideShortcuts();
    });
  }

  document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // ? — show shortcuts
    if (key === '?' || (shift && key === '/')) { e.preventDefault(); showShortcuts(); return; }

    // Escape — close modals, deselect, cancel placement
    if (key === 'Escape') {
      hideShortcuts();
      // Close any open modal
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
      // Trigger deselect in app (fire a custom event the main app.js can listen to)
      document.dispatchEvent(new CustomEvent('atlantist:escape'));
      closePropsPanel();
      return;
    }

    // Delete / Backspace — delete selected element
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('atlantist:delete'));
      return;
    }

    // Ctrl+Z — undo
    if (ctrl && !shift && key === 'z') {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('atlantist:undo'));
      return;
    }
    // Ctrl+Shift+Z — redo
    if (ctrl && shift && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('atlantist:redo'));
      return;
    }
    // Ctrl+S — save
    if (ctrl && key === 's') {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('atlantist:save'));
      return;
    }

    // Tool shortcuts (single letter, no modifier)
    if (ctrl || shift || e.altKey) return;

    switch (key.toLowerCase()) {
      case 'w': clickBtn('btn-add-wall'); break;
      case 'c': clickBtn('btn-add-column'); break;
      case 'd': clickBtn('btn-add-door'); break;
      case 'l': clickBtn('btn-add-level'); break;
      case 't': if (toggleBtn) toggleBtn.click(); break;
      case '1': clickBtn('btn-3d'); break;
      case '2': clickBtn('btn-plan'); break;
      case '3': clickBtn('btn-section'); break;
      case '4': clickBtn('btn-rcp'); break;
    }
  });

  function clickBtn(id) {
    const btn = document.getElementById(id);
    if (btn && !btn.classList.contains('hidden')) btn.click();
  }

  // ─── Touch/gesture support for Three.js canvases ────────────────────────
  const viewportArea = document.getElementById('viewport-area');
  if (viewportArea && 'ontouchstart' in window) {
    let lastTouchDist = 0;
    let lastTouchCenter = null;
    let longPressTimer = null;

    viewportArea?.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        // Pinch start — record initial distance
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.sqrt(dx * dx + dy * dy);
        lastTouchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      } else if (e.touches.length === 1) {
        // Long press detection (500ms)
        const touch = e.touches[0];
        longPressTimer = setTimeout(() => {
          document.dispatchEvent(new CustomEvent('atlantist:longpress', {
            detail: { x: touch.clientX, y: touch.clientY },
          }));
        }, 500);
      }
    }, { passive: true });

    viewportArea?.addEventListener('touchmove', (e) => {
      // Cancel long press on move
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

      if (e.touches.length === 2) {
        // Pinch zoom
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastTouchDist > 0) {
          const scale = dist / lastTouchDist;
          document.dispatchEvent(new CustomEvent('atlantist:pinchzoom', {
            detail: { scale, centerX: (e.touches[0].clientX + e.touches[1].clientX) / 2, centerY: (e.touches[0].clientY + e.touches[1].clientY) / 2 },
          }));
        }
        lastTouchDist = dist;

        // Two-finger pan
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        if (lastTouchCenter) {
          document.dispatchEvent(new CustomEvent('atlantist:twofingerpan', {
            detail: { dx: cx - lastTouchCenter.x, dy: cy - lastTouchCenter.y },
          }));
        }
        lastTouchCenter = { x: cx, y: cy };
      }
    }, { passive: true });

    viewportArea?.addEventListener('touchend', () => {
      lastTouchDist = 0;
      lastTouchCenter = null;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }, { passive: true });
  }

  // ─── Swipe to switch views on mobile ────────────────────────────────────
  if ('ontouchstart' in window) {
    let swipeStartX = 0;
    const viewBtns = ['btn-3d', 'btn-plan', 'btn-section', 'btn-rcp'];
    let currentViewIdx = 0;

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) swipeStartX = e.touches[0].clientX;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      const diff = e.changedTouches[0].clientX - swipeStartX;
      if (Math.abs(diff) < 80) return; // Not a swipe
      // Only swipe on viewport area
      const target = e.target;
      if (!target.closest || !target.closest('.viewport-area')) return;
      if (diff < 0) currentViewIdx = Math.min(currentViewIdx + 1, viewBtns.length - 1);
      else currentViewIdx = Math.max(currentViewIdx - 1, 0);
      clickBtn(viewBtns[currentViewIdx]);
    }, { passive: true });
  }

  // ─── Close modals by clicking overlay background ─────────────────────────
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

})();
