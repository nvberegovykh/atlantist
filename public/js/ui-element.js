/**
 * ui-element.js — Atlantist Dynamic Element System
 *
 * UIElement — base class for every animated UI component.
 * Each element owns its enter/exit lifecycle via data-state.
 * CSS ui-motion.css drives all visual transitions.
 *
 * Lifecycle states:
 *   "closed"   → display:none (invisible, no pointer events)
 *   "opening"  → enter animation playing
 *   "open"     → fully visible and interactive
 *   "closing"  → exit animation playing → lands on "closed"
 *
 * Usage:
 *   const sidebar = new UIElement('#sidebar-expanded');
 *   sidebar.open();
 *   sidebar.close();
 *   sidebar.toggle();
 *   sidebar.isOpen  // → true/false
 *
 * Events emitted on the element (bubbles):
 *   ui:open    — fired when state reaches "open"
 *   ui:close   — fired when state reaches "closed"
 *   ui:opening — fired when opening animation starts
 *   ui:closing — fired when closing animation starts
 *
 * Options (passed to constructor):
 *   onOpen(el)    — callback when fully open
 *   onClose(el)   — callback when fully closed
 *   onOpening(el) — callback on opening start
 *   onClosing(el) — callback on closing start
 *   group         — string: only one element in the group stays open
 *   persist       — bool: if true, closing is blocked (use for required panels)
 */

class UIElement {
  /**
   * @param {string|HTMLElement} target  CSS selector or DOM element
   * @param {object} opts
   */
  constructor(target, opts = {}) {
    this.el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!this.el) {
      console.warn(`[UIElement] target not found: ${target}`);
      return;
    }

    this._opts = opts;
    this._animationFrame = null;

    // Initialize state from DOM or default to closed
    if (!this.el.dataset.state) {
      // If element was previously visible via old show/hide logic, honour it
      const computed = window.getComputedStyle(this.el);
      const wasVisible = computed.display !== 'none' &&
                         !this.el.classList.contains('hidden') &&
                         !this.el.classList.contains('collapsed');
      this.el.dataset.state = wasVisible ? 'open' : 'closed';
    }

    // Listen for animation end to advance "closing" → "closed"
    this.el.addEventListener('animationend', this._onAnimationEnd.bind(this));
  }

  /* ── Public API ─────────────────────────────────────────── */

  get isOpen() {
    return this.el && (this.el.dataset.state === 'open' || this.el.dataset.state === 'opening');
  }

  get state() {
    return this.el ? this.el.dataset.state : null;
  }

  open() {
    if (!this.el) return;
    const s = this.el.dataset.state;
    if (s === 'open' || s === 'opening') return;

    // Dismiss group siblings
    if (this._opts.group) {
      UIElement._groups[this._opts.group]?.forEach(sib => {
        if (sib !== this && sib.isOpen) sib.close();
      });
    }

    this._setState('opening');
    this._emit('ui:opening');
    this._opts.onOpening?.(this.el);

    // Detect enter animation duration from CSS
    const dur = this._getAnimDuration();
    clearTimeout(this._openTimer);
    this._openTimer = setTimeout(() => {
      if (this.el.dataset.state === 'opening') {
        this._setState('open');
        this._emit('ui:open');
        this._opts.onOpen?.(this.el);
      }
    }, dur + 16); // +16ms buffer for rounding
  }

  close() {
    if (!this.el) return;
    if (this._opts.persist) return;
    const s = this.el.dataset.state;
    if (s === 'closed' || s === 'closing') return;

    this._setState('closing');
    this._emit('ui:closing');
    this._opts.onClosing?.(this.el);

    // animationend handler lands this on "closed"
    // Fallback timer in case animationend misfires
    const dur = this._getAnimDuration();
    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => {
      if (this.el.dataset.state === 'closing') {
        this._setState('closed');
        this._emit('ui:close');
        this._opts.onClose?.(this.el);
      }
    }, dur + 32);
  }

  toggle() {
    if (!this.el) return;
    this.isOpen ? this.close() : this.open();
  }

  /**
   * Instantly set to open or closed — no animation.
   * Use for initial state restoration.
   */
  snap(isOpen) {
    if (!this.el) return;
    clearTimeout(this._openTimer);
    clearTimeout(this._closeTimer);
    this._setState(isOpen ? 'open' : 'closed');
  }

  /* ── Private ─────────────────────────────────────────────── */

  _setState(state) {
    if (!this.el) return;
    this.el.dataset.state = state;
  }

  _onAnimationEnd(e) {
    // Only respond to animations on this element, not children
    if (e.target !== this.el) return;
    if (this.el.dataset.state === 'closing') {
      clearTimeout(this._closeTimer);
      this._setState('closed');
      this._emit('ui:close');
      this._opts.onClose?.(this.el);
    }
    // Note: opening → open handled by timer (more reliable cross-browser)
  }

  _emit(eventName) {
    this.el.dispatchEvent(new CustomEvent(eventName, {
      bubbles: true,
      detail: { element: this }
    }));
  }

  _getAnimDuration() {
    // Read CSS-computed animation duration to sync JS timer
    const style = window.getComputedStyle(this.el);
    const raw = style.animationDuration || '0s';
    const parts = raw.split(',');
    const max = parts.reduce((m, p) => {
      const val = parseFloat(p.trim());
      const ms = p.includes('ms') ? val : val * 1000;
      return Math.max(m, ms);
    }, 0);
    return max || 220; // fallback 220ms
  }

  /* ── Group registry ──────────────────────────────────────── */
  static _groups = {};

  static registerGroup(groupName, instance) {
    if (!UIElement._groups[groupName]) UIElement._groups[groupName] = new Set();
    UIElement._groups[groupName].add(instance);
  }
}


/* ============================================================
   UIToast — self-dismissing notification element
   ============================================================ */
class UIToast extends UIElement {
  /**
   * @param {HTMLElement} el
   * @param {number} duration  ms before auto-close (default 4000)
   */
  constructor(el, duration = 4000) {
    super(el);
    this._duration = duration;
  }

  show() {
    this.open();
    clearTimeout(this._autoClose);
    this._autoClose = setTimeout(() => this.close(), this._duration);
  }
}


/* ============================================================
   UIBadge — animated status indicator dot
   ============================================================ */
class UIBadge extends UIElement {
  /** Show badge with optional label */
  show(label) {
    if (label !== undefined && this.el) {
      this.el.textContent = label;
    }
    this.open();
  }

  hide() { this.close(); }
}


/* ============================================================
   UIManager — registry + factory
   Manages all live UIElement instances.
   ============================================================ */
const UIManager = {
  _registry: new Map(),

  /**
   * Register or retrieve a UIElement by id.
   * @param {string} selector
   * @param {object} opts
   * @param {typeof UIElement} Cls
   * @returns {UIElement}
   */
  register(selector, opts = {}, Cls = UIElement) {
    if (this._registry.has(selector)) return this._registry.get(selector);
    const inst = new Cls(selector, opts);
    if (inst.el) this._registry.set(selector, inst);
    if (opts.group) UIElement.registerGroup(opts.group, inst);
    return inst;
  },

  get(selector) {
    return this._registry.get(selector);
  },

  /** Open an element by selector (registers if not yet known) */
  open(selector, opts) {
    return this.register(selector, opts).open?.();
  },

  close(selector) {
    return this.get(selector)?.close();
  },

  toggle(selector, opts) {
    return this.register(selector, opts).toggle?.();
  },

  /** Close all elements in a group */
  closeGroup(groupName) {
    UIElement._groups[groupName]?.forEach(el => el.close());
  },

  /** Initialize all [data-ui-element] nodes in DOM */
  initAll() {
    document.querySelectorAll('[data-ui-element]').forEach(node => {
      const sel = '#' + node.id || '[data-ui-element]';
      if (!this._registry.has(sel)) {
        const opts = {};
        if (node.dataset.uiGroup)   opts.group   = node.dataset.uiGroup;
        if (node.dataset.uiPersist) opts.persist  = true;
        this.register(sel, opts);
      }
    });
  }
};


/* ============================================================
   showToast() — global helper (replaces inline impl in app-shell.js)
   ============================================================ */
window.showToast = function showToast(msg, type = 'info', duration = 4000) {
  // Reuse existing container or create
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.dataset.state = 'closed'; // UIElement picks this up
  toast.textContent = msg;
  container.appendChild(toast);

  const instance = new UIToast(toast, duration);
  instance.show();

  // Cleanup DOM after close
  toast.addEventListener('ui:close', () => {
    setTimeout(() => toast.remove(), 50);
  });
};


/* ============================================================
   Wire up existing shell elements on DOMContentLoaded
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // ── Nav-rail expanded panel ──────────────────────────────
  const sidebarExpanded = UIManager.register('#sidebar-expanded', {
    onOpen:  () => window._notifyViewportResize?.(),
    onClose: () => window._notifyViewportResize?.()
  });

  // ── Explorer sidebar ─────────────────────────────────────
  UIManager.register('#sidebar-left');

  // ── Properties panel ─────────────────────────────────────
  UIManager.register('#sidebar-right');

  // ── IM panel ─────────────────────────────────────────────
  UIManager.register('#im-panel');

  // ── Version timeline drawer ──────────────────────────────
  UIManager.register('#version-timeline-drawer');

  // ── Command palette ──────────────────────────────────────
  UIManager.register('#command-palette');

  // ── Wallt panel ──────────────────────────────────────────
  UIManager.register('#wallt-panel');

  // ── Store modal ──────────────────────────────────────────
  UIManager.register('#store-modal');

  // ── Simulation launcher ──────────────────────────────────
  UIManager.register('#modal-simulations');

  // ── Node editor ──────────────────────────────────────────
  UIManager.register('#node-editor');

  // ── Auto-init any declarative [data-ui-element] nodes ────
  UIManager.initAll();

  // ── WS offline badge ─────────────────────────────────────
  // Suppress "Offline" badge in demo mode entirely
  const wsBadge = document.getElementById('ws-status-badge');
  if (wsBadge) {
    const badge = UIManager.register('#ws-status-badge', {}, UIBadge);
    // BUG-UI-3: Do not show badge in demo mode
    const isDemo = window.PROJECT_ID === 'aabbccdd-0001-4000-8000-000000000001'
                || window.IS_DEMO_MODE === true;
    if (isDemo) {
      // Snap to closed, never open in demo
      badge.snap(false);
      badge._opts.persist = true; // block open() calls
    }
  }

  // Expose globally for legacy call sites
  window.UIManager  = UIManager;
  window.UIElement  = UIElement;
  window.UIToast    = UIToast;
  window.UIBadge    = UIBadge;
});


/* ============================================================
   Bridge: patch legacy open/close functions to use UIManager
   Existing code like openVersionDrawer() / closeVersionDrawer()
   stays working — they now delegate into UIElement.
   ============================================================ */

// Patch after DOM ready so elements exist
document.addEventListener('DOMContentLoaded', () => {
  const _orig_openVersionDrawer  = window.openVersionDrawer;
  const _orig_closeVersionDrawer = window.closeVersionDrawer;

  window.openVersionDrawer = function() {
    const el = UIManager.get('#version-timeline-drawer');
    if (el) { el.open(); }
    else { _orig_openVersionDrawer?.(); }
  };

  window.closeVersionDrawer = function() {
    const el = UIManager.get('#version-timeline-drawer');
    if (el) { el.close(); }
    else { _orig_closeVersionDrawer?.(); }
  };

  // openNavRail expansion → UIManager toggle
  const _orig_toggleNavTab = window.toggleNavTab;
  window.toggleNavTab = function(tabId) {
    // Run the original to handle tab switching logic
    _orig_toggleNavTab?.(tabId);
    // Then sync UIManager state
    const expanded = document.getElementById('sidebar-expanded');
    if (expanded) {
      const el = UIManager.get('#sidebar-expanded');
      const isNowOpen = expanded.classList.contains('open');
      if (el) el.snap(isNowOpen);
    }
  };
});
