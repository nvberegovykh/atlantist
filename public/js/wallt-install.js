/**
 * Wallt Install Manager (Phase 34E)
 * Handles: beforeinstallprompt capture, iOS HSTS modal, 30-day dismiss, banner rendering.
 * Call window.WalltInstallManager.init({ onInstallClick, onIOSDetected }) after DOM ready.
 */
(function () {
  'use strict';

  const DISMISS_KEY = 'wallt_install_dismissed_v1';
  const DISMISS_DAYS = 30;

  let deferredPrompt = null;
  let onInstallClick = null;
  let onIOSDetected = null;
  let isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  function init(opts) {
    onInstallClick = opts.onInstallClick || function () { };
    onIOSDetected = opts.onIOSDetected || function () { };

    // Already installed — skip entirely
    if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) {
      return;
    }

    // Dismissed within the last 30 days — skip
    if (wasDismissedRecently()) return;

    // Capture beforeinstallprompt (Chrome/Edge on desktop/Android)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showInstallBanner();
    });

    // iOS: show instructions modal on first visit
    if (isIOS) {
      showIOSInstructions();
    }
  }

  function showInstallBanner() {
    // Remove existing
    const existing = document.getElementById('wallt-install-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'wallt-install-banner';
    banner.innerHTML = `
      <div class="wallt-install-title">Install Wallt</div>
      <div class="wallt-install-sub">Always one tap away — works offline, stays on your home screen.</div>
      <div class="wallt-install-actions">
        <button id="wallt-install-cta">Install now</button>
        <button id="wallt-install-dismiss">Later</button>
      </div>
    `;
    document.body.appendChild(banner);

    // Animate in
    requestAnimationFrame(() => {
      banner.classList.add('visible');
    });

    banner.querySelector('#wallt-install-cta')?.addEventListener('click', () => {
      if (isIOS) {
        onIOSDetected();
      } else if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choice) => {
          if (choice.outcome === 'accepted') {
            dismissBanner();
          }
          deferredPrompt = null;
        });
      }
    });

    banner.querySelector('#wallt-install-dismiss')?.addEventListener('click', dismissBanner);
  }

  function dismissBanner() {
    const banner = document.getElementById('wallt-install-banner');
    if (banner) banner.classList.remove('visible');
    setTimeout(() => {
      if (banner) banner.remove();
    }, 300);
    setDismissed();
  }

  function showIOSInstructions() {
    // Check if user already saw this modal this session
    if (sessionStorage.getItem('wallt_ios_modal_shown')) return;
    sessionStorage.setItem('wallt_ios_modal_shown', '1');

    const modal = document.createElement('div');
    modal.id = 'wallt-ios-modal';
    modal.innerHTML = `
      <div class="wallt-ios-modal-box">
        <h2 class="wallt-ios-modal-title">Add Wallt to Home Screen</h2>
        <ol class="wallt-ios-steps">
          <li><span class="wallt-ios-step-num">1</span> Tap the Share button at the bottom of your screen</li>
          <li><span class="wallt-ios-step-num">2</span> Scroll down and tap <strong>Add to Home Screen</strong></li>
          <li><span class="wallt-ios-step-num">3</span> Tap <strong>Add</strong> — Wallt will appear on your home screen</li>
        </ol>
        <button class="wallt-ios-close" id="wallt-ios-close">Got it</button>
      </div>
    `;
    document.body.appendChild(modal);

    requestAnimationFrame(() => modal.classList.add('visible'));

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    modal.querySelector('#wallt-ios-close')?.addEventListener('click', closeModal);

    function closeModal() {
      modal.classList.remove('visible');
      setTimeout(() => modal.remove(), 300);
    }
  }

  function wasDismissedRecently() {
    try {
      const val = localStorage.getItem(DISMISS_KEY);
      if (!val) return false;
      const { ts } = JSON.parse(val);
      const msPerDay = 86400 * 1000;
      return Date.now() - ts < DISMISS_DAYS * msPerDay;
    } catch (_) {
      return false;
    }
  }

  function setDismissed() {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ ts: Date.now() }));
    } catch (_) { }
  }

  // Listen for appinstalled
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const banner = document.getElementById('wallt-install-banner');
    if (banner) {
      banner.classList.remove('visible');
      setTimeout(() => banner.remove(), 300);
    }
  });

  // Public API
  window.WalltInstallManager = { init };
})();