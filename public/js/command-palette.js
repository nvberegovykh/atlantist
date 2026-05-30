/* ============================================================
   Command Palette — Cmd+K for Atlantist BIM.
   Fuzzy search over navigation, tools, store actions.
   ============================================================ */

(function () {
  'use strict';

  // ── Command registry ────────────────────────────────────────────────────────

  const COMMANDS = [
    // Navigation
    { id: 'nav-explorer',    group: 'Navigation',  name: 'Explorer',           desc: 'Open project tree',            icon: '📁', action: () => triggerNav('explorer')     },
    { id: 'nav-library',     group: 'Navigation',  name: 'Library',            desc: 'BIM families & materials',     icon: '🗂️', action: () => triggerNav('library')      },
    { id: 'nav-simulations', group: 'Navigation',  name: 'Simulations',        desc: 'All analysis engines',         icon: '🔬', action: () => triggerNav('simulations')  },
    { id: 'nav-collab',      group: 'Navigation',  name: 'Collaboration',      desc: 'Issues, presence, chat',        icon: '🤝', action: () => triggerNav('collaboration') },
    { id: 'nav-versions',    group: 'Navigation',  name: 'Version Timeline',   desc: 'Model history & snapshots',     icon: '🕐', action: () => triggerNav('versions')     },
    { id: 'nav-dob',         group: 'Navigation',  name: 'DOB Filing',          desc: 'NYC DOB tracker',              icon: '📄', action: () => triggerNav('dob')          },
    { id: 'nav-scripting',   group: 'Navigation',  name: 'Scripting',          desc: 'Dynamo/Grasshopper node editor', icon: '🔧', action: () => triggerNav('scripting')   },
    // Tools
    { id: 'tool-select',    group: 'Tools',       name: 'Select Tool',        desc: 'Select and move elements',     icon: '↖',  action: () => fire('bim:tool', 'select')   },
    { id: 'tool-wall',       group: 'Tools',       name: 'Draw Wall',          desc: 'Place parametric walls',        icon: '▬',  action: () => fire('bim:tool', 'wall')      },
    { id: 'tool-column',     group: 'Tools',       name: 'Place Column',       desc: 'Structural column insertion',   icon: '⬛', action: () => fire('bim:tool', 'column')   },
    { id: 'tool-door',      group: 'Tools',       name: 'Place Door',          desc: 'Door family on wall face',      icon: '🚪', action: () => fire('bim:tool', 'door')     },
    { id: 'tool-window',     group: 'Tools',       name: 'Place Window',       desc: 'Window family on wall face',    icon: '🪟', action: () => fire('bim:tool', 'window')   },
    { id: 'tool-level',      group: 'Tools',       name: 'Add Level',          desc: 'Create building floor/level',   icon: '➖', action: () => fire('bim:tool', 'level')    },
    // Store (Phase 30a)
    { id: 'store-browse',    group: 'Store',       name: 'Browse Store',       desc: 'Browse & search assets',       icon: '🏪', action: () => openStore(),   shortcut: '⌘K' },
    { id: 'store-my-assets', group: 'Store',       name: 'My Assets',          desc: 'Download acquired assets',     icon: '📦', action: () => openMyAssets()  },
    { id: 'store-upload',    group: 'Store',       name: 'Upload Asset',       desc: 'List a new asset in the store', icon: '⬆',  action: () => openUploadModal(), shortcut: '⌘U' },
    { id: 'store-external',  group: 'Store',       name: 'Search External',    desc: 'BIMObject, Exchange, Poliigon', icon: '🌐', action: () => openStore('external') },
    // Views
    { id: 'view-3d',         group: 'Views',       name: '3D View',             desc: 'Isometric 3D perspective',      icon: '🧊', action: () => fire('bim:view', '3d')     },
    { id: 'view-plan',       group: 'Views',       name: 'Plan View',           desc: 'Top-down floor plan',           icon: '⬇',  action: () => fire('bim:view', 'plan')    },
    { id: 'view-section',    group: 'Views',       name: 'Section View',       desc: 'Cut section through model',    icon: '↔',  action: () => fire('bim:view', 'section') },
    { id: 'view-iso',        group: 'Views',       name: 'Isometric',           desc: 'Orthographic isometric',        icon: '◇',  action: () => fire('bim:view', 'iso')     },
  ];

  // ── DOM scaffolding (once) ──────────────────────────────────────────────────

  function buildPalette() {
    if (document.getElementById('cmd-palette-overlay')) return;
    const html = '<div id="cmd-palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '<div id="cmd-palette">' +
        '<div class="cmd-search-wrap">' +
          '<span class="cmd-search-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>' +
          '<input id="cmd-search" type="text" placeholder="Search commands…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search commands">' +
          '<span class="cmd-shortcut-hint" aria-hidden="true">Esc</span>' +
        '</div>' +
        '<div class="cmd-results" role="listbox" aria-label="Commands"></div>' +
        '<div class="cmd-footer" aria-hidden="true">' +
          '<span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span>' +
        '</div>' +
      '</div>' +
    '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }

  // ── State ───────────────────────────────────────────────────────────────────

  let activeIndex = 0;
  let filtered = COMMANDS;

  // ── Fuzzy filter ─────────────────────────────────────────────────────────────

  function fuzzyScore(cmd, q) {
    const haystack = (cmd.name + ' ' + cmd.desc).toLowerCase();
    const needle = q.toLowerCase();
    if (haystack === needle) return 100;
    if (haystack.startsWith(needle)) return 90;
    if (haystack.includes(needle)) return 60 + (needle.length / haystack.length) * 20;
    let si = 0;
    for (const ch of haystack) {
      if (si < needle.length && ch === needle[si]) si++;
    }
    return si > 0 ? (si / needle.length) * 40 : 0;
  }

  function filterCommands(q) {
    if (!q) return COMMANDS;
    return COMMANDS
      .map(c => Object.assign({}, c, { _score: fuzzyScore(c, q) }))
      .filter(c => c._score > 0)
      .sort((a, b) => b._score - a._score);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function renderResults(commands) {
    const results = document.querySelector('.cmd-results');
    if (!results) return;
    filtered = commands;

    if (!commands.length) {
      results.innerHTML = '<div class="cmd-empty">No matching commands</div>';
      activeIndex = 0;
      return;
    }

    let html = '';
    let currentGroup = null;
    commands.forEach((cmd, i) => {
      if (cmd.group !== currentGroup) {
        currentGroup = cmd.group;
        html += '<div class="cmd-group-label">' + currentGroup + '</div>';
      }
      html += '<div class="cmd-item' + (i === activeIndex ? ' active' : '') + '" role="option" aria-selected="' + (i === activeIndex) + '" data-idx="' + i + '">' +
        '<div class="cmd-item-icon" aria-hidden="true">' + cmd.icon + '</div>' +
        '<div class="cmd-item-text">' +
          '<div class="cmd-item-name">' + cmd.name + '</div>' +
          '<div class="cmd-item-desc">' + cmd.desc + '</div>' +
        '</div>' +
        (cmd.shortcut ? '<span class="cmd-item-shortcut">' + cmd.shortcut + '</span>' : '') +
      '</div>';
    });

    results.innerHTML = html;
    results.scrollTop = 0;
  }

  function ensureActiveVisible() {
    const active = document.querySelector('.cmd-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // ── Open / Close ─────────────────────────────────────────────────────────────

  function openPalette() {
    buildPalette();
    const overlay = document.getElementById('cmd-palette-overlay');
    const input = document.getElementById('cmd-search');
    overlay.classList.add('open');
    input.value = '';
    input.focus();
    activeIndex = 0;
    filtered = COMMANDS;
    renderResults(COMMANDS);
  }

  function closePalette() {
    const overlay = document.getElementById('cmd-palette-overlay');
    if (overlay) overlay.classList.remove('open');
    activeIndex = 0;
    filtered = COMMANDS;
  }

  function onInput(e) {
    const q = e.target.value.trim();
    activeIndex = 0;
    renderResults(filterCommands(q));
  }

  // ── Navigation helpers ───────────────────────────────────────────────────────

  function triggerNav(tabId) {
    closePalette();
    if (typeof closeNavRail === 'function') closeNavRail();
    if (typeof toggleNavTab === 'function') toggleNavTab(tabId);
  }

  function fire(channel, value) {
    closePalette();
    window.dispatchEvent(new CustomEvent(channel, { detail: { type: value } }));
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  function handleKeydown(e) {
    const overlay = document.getElementById('cmd-palette-overlay');
    const isOpen = overlay && overlay.classList.contains('open');

    if (!isOpen) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openPalette();
      }
      return;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        closePalette();
        break;
      case 'ArrowDown':
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
        updateActive();
        ensureActiveVisible();
        break;
      case 'ArrowUp':
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActive();
        ensureActiveVisible();
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[activeIndex]) filtered[activeIndex].action();
        break;
    }
  }

  function updateActive() {
    document.querySelectorAll('.cmd-item').forEach((el, i) => {
      const active = i === activeIndex;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    });
  }

  // ── Mouse click ───────────────────────────────────────────────────────────────

  function handleClick(e) {
    const item = e.target.closest('.cmd-item');
    if (item) {
      const idx = parseInt(item.dataset.idx, 10);
      if (filtered[idx]) filtered[idx].action();
      return;
    }
    if (e.target.id === 'cmd-palette-overlay') closePalette();
  }

  // ── Input listener (re-attach on open) ───────────────────────────────────────

  function attachInputListener() {
    const input = document.getElementById('cmd-search');
    if (input) {
      input.removeEventListener('input', onInput);
      input?.addEventListener('input', onInput);
    }
  }

  // Patch openPalette to also attach listener
  const _openPalette = openPalette;
  openPalette = function () {
    _openPalette();
    setTimeout(attachInputListener, 0);
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────────

  document.addEventListener('keydown', handleKeydown, { passive: true });
  document.addEventListener('click', handleClick);

  window.openCommandPalette = openPalette;
  window.closeCommandPalette = closePalette;

})();
