/**
 * crafting-palette.js — Atlantist BIM 2.0
 * Fortnite-style quick-select radial palette for element placement.
 *
 * Owns: palette DOM, keyboard shortcut (Q), recent/favorites history,
 *       variant cycling, module-derived dimension display.
 * Does NOT own: placement mode persistence (delegates to app.js via startPlacement
 *               or direct state.placementMode assignment), Three.js scene, modals.
 *
 * Architecture: Palette is the fast-selection UI layer. Every element it places
 * goes through SP-A's attachment engine (attachment-engine.js) and code compliance
 * (code-compliance.js) — the palette is the UI, SP-A is the brain.
 */

import { getModuleM, getModuleDerivedLocal, formatPlacementValue } from './placement-service.js';

// ─── ELEMENT TYPE DEFINITIONS ───────────────────────────────────────────────

const ELEMENT_TYPES = [
  {
    type: 'wall',
    label: 'Wall',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="6" width="26" height="5" rx="1"/>
      <rect x="3" y="13" width="26" height="5" rx="1"/>
      <rect x="3" y="20" width="26" height="5" rx="1"/>
    </svg>`,
    variants: [
      { id: 'cmu',      label: 'CMU',        description: 'Concrete Masonry Unit', material: 'Concrete' },
      { id: 'gwb',      label: 'GWB Stud',   description: '3-5/8" steel stud + drywall', material: 'Gypsum' },
      { id: 'brick',    label: 'Brick Veneer',description: '4" brick + air gap + sheathing', material: 'Masonry' },
      { id: 'wood',     label: 'Wood Frame', description: '2x4 wood stud @ 16" oc', material: 'Wood' },
    ],
  },
  {
    type: 'column',
    label: 'Column',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="11" y="4" width="10" height="24" rx="1"/>
      <line x1="7" y1="4" x2="25" y2="4"/>
      <line x1="7" y1="28" x2="25" y2="28"/>
    </svg>`,
    variants: [
      { id: 'w12x26',   label: 'W12×26',    description: 'AISC W12×26 wide flange', material: 'Steel' },
      { id: 'w10x22',   label: 'W10×22',    description: 'AISC W10×22 wide flange', material: 'Steel' },
      { id: 'w8x18',    label: 'W8×18',     description: 'AISC W8×18 wide flange', material: 'Steel' },
      { id: 'hss6x6',   label: 'HSS 6×6',   description: '6×6 hollow structural section', material: 'Steel' },
      { id: 'rc14',     label: 'RC 14"',    description: '14"×14" reinforced concrete column', material: 'Concrete' },
    ],
  },
  {
    type: 'door',
    label: 'Door',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="8" y="5" width="14" height="22" rx="1"/>
      <path d="M8 27 Q22 27 22 5" stroke-dasharray="2 2"/>
      <circle cx="20" cy="16" r="1.5" fill="currentColor"/>
    </svg>`,
    variants: [
      { id: 'single36', label: '36" Single', description: '3′-0" × 7′-0" single door', material: 'Wood/Metal' },
      { id: 'single32', label: '32" Single', description: '2′-8" × 7′-0" single door', material: 'Wood/Metal' },
      { id: 'double60', label: '60" Double', description: '5′-0" × 7′-0" double door', material: 'Wood/Metal' },
      { id: 'fire45',   label: 'Fire 45',  description: '45-min fire-rated single door', material: 'Steel' },
      { id: 'fire90',   label: 'Fire 90',  description: '90-min fire-rated single door', material: 'Steel' },
    ],
  },
  {
    type: 'window',
    label: 'Window',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="5" y="7" width="22" height="18" rx="1"/>
      <line x1="16" y1="7" x2="16" y2="25"/>
      <line x1="5" y1="16" x2="27" y2="16"/>
    </svg>`,
    variants: [
      { id: 'fixed48',  label: '48" Fixed',  description: '48"×48" fixed picture window', material: 'Aluminum/Glass' },
      { id: 'casement', label: 'Casement', description: '30"×48" casement window', material: 'Vinyl' },
      { id: 'doublehung',label: 'Double Hung', description: '36"×60" double-hung window', material: 'Wood' },
      { id: 'sliding',   label: 'Sliding',   description: '60"×48" sliding glass door/window', material: 'Aluminum' },
    ],
  },
  {
    type: 'floor',
    label: 'Floor',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M4 14 L16 8 L28 14 L28 24 L4 24 Z"/>
      <line x1="4" y1="19" x2="28" y2="19" stroke-dasharray="3 2"/>
    </svg>`,
    variants: [
      { id: 'composite', label: 'Composite Slab', description: '4"+2" concrete + deck', material: 'Concrete/Steel' },
      { id: 'flatplate', label: 'Flat Plate', description: '6" flat plate concrete', material: 'Concrete' },
      { id: 'metaldeck', label: 'Metal Deck', description: '3" metal deck + topping', material: 'Steel/Concrete' },
    ],
  },
  {
    type: 'beam',
    label: 'Beam',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="12" width="26" height="8" rx="1"/>
      <line x1="7" y1="12" x2="7" y2="20"/>
      <line x1="25" y1="12" x2="25" y2="20"/>
    </svg>`,
    variants: [
      { id: 'w16x26',   label: 'W16×26',    description: 'AISC W16×26 wide flange beam', material: 'Steel' },
      { id: 'w14x22',   label: 'W14×22',    description: 'AISC W14×22 wide flange beam', material: 'Steel' },
      { id: 'w12x26',   label: 'W12×26',    description: 'AISC W12×26 wide flange beam', material: 'Steel' },
      { id: 'lvl',      label: 'LVL 14"',   description: '14" LVL laminated veneer lumber', material: 'Wood' },
    ],
  },
  {
    type: 'stair',
    label: 'Stair',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M5 26 L10 26 L10 22 L15 22 L15 18 L20 18 L20 14 L25 14 L25 10 L30 10"/>
      <line x1="5" y1="26" x2="30" y2="10"/>
    </svg>`,
    variants: [
      { id: 'commercial', label: 'Commercial', description: '7" riser / 10" tread — IBC 1011.5', material: 'Concrete/Steel' },
      { id: 'residential', label: 'Residential', description: '7-3/8" riser / 10" tread — IBC 1011.5', material: 'Wood' },
      { id: 'spiral',     label: 'Spiral',    description: 'IBC 1011.10 spiral stair', material: 'Steel' },
    ],
  },
  {
    type: 'railing',
    label: 'Railing',
    icon: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
      <line x1="3" y1="8" x2="29" y2="8"/>
      <line x1="5" y1="8" x2="5" y2="24"/>
      <line x1="11" y1="8" x2="11" y2="24"/>
      <line x1="17" y1="8" x2="17" y2="24"/>
      <line x1="23" y1="8" x2="23" y2="24"/>
      <line x1="29" y1="8" x2="29" y2="24"/>
      <line x1="3" y1="14" x2="29" y2="14"/>
    </svg>`,
    variants: [
      { id: 'guard',     label: 'Guard Rail',   description: 'IBC 1014.1 — 42" min height', material: 'Steel/Wood' },
      { id: 'handrail',  label: 'Handrail',    description: 'IBC 1014.6 — 34-38" height', material: 'Aluminum' },
      { id: 'glass',     label: 'Glass Panel',  description: 'IBC 1014.4 glass infill', material: 'Glass/Metal' },
    ],
  },
];

// ─── MODULE M APPEND TO VARIANT LABELS ──────────────────────────────────────

/**
 * Build variant list for an element type with M-derived dimensions.
 * Adds module multiple labels (e.g. "W12×26 · 2M") to variant thumbnails.
 */
function buildVariantList(elementType, showMultiples = true) {
  const derived = getModuleDerivedLocal();
  const M_mm = getModuleM();
  const M_label = showMultiples ? formatModuleMultiple(M_mm) : '';

  return elementType.variants.map(v => ({
    ...v,
    dimensionLabel: getVariantDimensionLabel(v.id, elementType.type, derived, M_label),
  }));
}

function getVariantDimensionLabel(variantId, elementType, derived, M_label) {
  switch (elementType) {
    case 'wall':
      if (variantId === 'cmu')   return M_label ? `203 mm · M/2 (${M_label})` : '8" (203 mm)';
      if (variantId === 'gwb')   return M_label ? `117 mm · M/3 (${M_label})` : '4-5/8" (117 mm)';
      if (variantId === 'brick') return M_label ? `102 mm · M/2 (${M_label})` : '4" (102 mm)';
      if (variantId === 'wood')  return M_label ? `${derived.M_mm / 3} mm · M/3 (${M_label})` : '3-5/8" (92 mm)';
      return M_label || '';
    case 'column':
      // W-shapes are defined by AISC, show section name as label
      return variantId; // e.g. "W12x26"
    case 'door':
      if (variantId === 'single36') return M_label ? `914 mm · 2M (${M_label})` : '36" wide × 7′-0"';
      if (variantId === 'single32') return '32" wide × 7′-0"';
      if (variantId === 'double60') return '60" wide × 7′-0"';
      if (variantId === 'fire45')  return '45-min fire rated · 36"';
      if (variantId === 'fire90')  return '90-min fire rated · 36"';
      return '';
    case 'window':
      if (variantId === 'fixed48')   return '48" × 48" fixed';
      if (variantId === 'casement')  return '30" × 48" casement';
      if (variantId === 'doublehung')return '36" × 60" double-hung';
      if (variantId === 'sliding')   return '60" × 48" sliding';
      return '';
    case 'beam':
      // W-shape section name as label
      return variantId;
    default:
      return '';
  }
}

function formatModuleMultiple(M_mm) {
  if (M_mm === 304.8) return '1.25M';  // Imperial 12"
  if (M_mm === 914)    return '1M';
  if (M_mm === 1000)   return '1M';
  return `${Math.round(M_mm)}mm`;
}

// ─── RECENT / FAVORITES PERSISTENCE ─────────────────────────────────────────

const MAX_RECENT = 8;
const STORAGE_KEY_RECENT = 'atlantist_palette_recent';
const STORAGE_KEY_FAVORITES = 'atlantist_palette_favorites';

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT) || '[]');
  } catch { return []; }
}

function addRecent(type, variantId) {
  const recent = getRecent().filter(r => !(r.type === type && r.variantId === variantId));
  recent.unshift({ type, variantId, ts: Date.now() });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  try { localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(recent)); } catch {}
}

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_FAVORITES) || '[]');
  } catch { return []; }
}

function toggleFavorite(type, variantId) {
  const favs = getFavorites();
  const existing = favs.find(f => f.type === type && f.variantId === variantId);
  if (existing) {
    // Toggle off
    try { localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favs.filter(f => !(f.type === type && f.variantId === variantId)))); } catch {}
  } else {
    // Toggle on
    favs.push({ type, variantId, ts: Date.now() });
    try { localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favs)); } catch {}
  }
}

function isFavorite(type, variantId) {
  return getFavorites().some(f => f.type === type && f.variantId === variantId);
}

// ─── PALETTE STATE ───────────────────────────────────────────────────────────

const paletteState = {
  open: false,
  activeTab: 'recent', // 'recent' | 'favorites'
  selectedElementType: null,
  activeVariantIndex: 0,
  showMultiples: false, // Module multiples toggle
};

// ─── DOM CREATION ────────────────────────────────────────────────────────────

function createPaletteHTML() {
  return `
    <div id="crafting-palette" class="cp-hidden" role="dialog" aria-label="Crafting Palette — Quick Select">
      <div class="cp-backdrop"></div>
      <div class="cp-container">
        <!-- Header -->
        <div class="cp-header">
          <span class="cp-title">Crafting Palette</span>
          <div class="cp-tabs">
            <button class="cp-tab cp-tab-active" data-tab="recent">Recent</button>
            <button class="cp-tab" data-tab="favorites">Favorites</button>
          </div>
          <label class="cp-multiples-toggle" title="Show module multiples (e.g. 2M instead of 914mm)">
            <input type="checkbox" id="cp-multiples-toggle" ${paletteState.showMultiples ? 'checked' : ''}>
            <span>×M</span>
          </label>
        </div>

        <!-- Element Type Ring -->
        <div class="cp-type-ring" id="cp-type-ring">
          <!-- Populated by JS -->
        </div>

        <!-- Variant Panel -->
        <div class="cp-variant-panel" id="cp-variant-panel">
          <div class="cp-variant-panel-header">
            <span id="cp-variant-type-label">Select an element</span>
            <button class="cp-close-variant" id="cp-close-variant" title="Back to type selection">← Back</button>
          </div>
          <div class="cp-variant-grid" id="cp-variant-grid">
            <!-- Populated by JS -->
          </div>
        </div>
      </div>

      <!-- Keyboard hint -->
      <div class="cp-hint">Press Q to toggle · Esc to close · Click to place</div>
    </div>
  `;
}

function injectPaletteHTML() {
  const container = document.createElement('div');
  container.innerHTML = createPaletteHTML();
  document.body.appendChild(container);
}

function renderTypeRing() {
  const ring = document.getElementById('cp-type-ring');
  if (!ring) return;

  const recent = getRecent();
  const favs = getFavorites();

  let typesToShow = ELEMENT_TYPES;
  if (paletteState.activeTab === 'recent') {
    // Show recent entries first, then remaining elements
    const recentTypes = recent.map(r => ELEMENT_TYPES.find(t => t.type === r.type)).filter(Boolean);
    const seen = new Set(recent.map(r => r.type));
    typesToShow = [...recentTypes, ...ELEMENT_TYPES.filter(t => !seen.has(t.type))];
  } else if (paletteState.activeTab === 'favorites') {
    const favTypes = favs.map(f => ELEMENT_TYPES.find(t => t.type === f.type)).filter(Boolean);
    typesToShow = favTypes;
  }

  ring.innerHTML = typesToShow.map(et => {
    const recentCount = recent.filter(r => r.type === et.type).length;
    return `
      <button class="cp-type-btn ${paletteState.selectedElementType === et.type ? 'cp-type-active' : ''}"
              data-type="${et.type}" title="${et.label}">
        <span class="cp-type-icon">${et.icon}</span>
        <span class="cp-type-label">${et.label}</span>
        ${recentCount > 0 ? `<span class="cp-type-badge">${recentCount}</span>` : ''}
      </button>
    `;
  }).join('');

  // Wire click
  ring.querySelectorAll('.cp-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      openVariantPanel(type);
    });
  });
}

function openVariantPanel(elementType) {
  paletteState.selectedElementType = elementType;
  paletteState.activeVariantIndex = 0;

  const et = ELEMENT_TYPES.find(e => e.type === elementType);
  if (!et) return;

  const panel = document.getElementById('cp-variant-panel');
  const label = document.getElementById('cp-variant-type-label');
  const grid = document.getElementById('cp-variant-grid');
  const backBtn = document.getElementById('cp-close-variant');

  label.textContent = et.label;
  panel.classList.add('cp-variant-open');

  backBtn.onclick = () => {
    paletteState.selectedElementType = null;
    panel.classList.remove('cp-variant-open');
    renderTypeRing();
  };

  const showMultiples = paletteState.showMultiples;
  const derived = getModuleDerivedLocal();
  const M_label = showMultiples ? formatModuleMultiple(getModuleM()) : '';

  grid.innerHTML = et.variants.map((v, i) => {
    const dimLabel = getVariantDimensionLabel(v.id, et.type, derived, M_label);
    const favClass = isFavorite(et.type, v.id) ? 'cp-fav-active' : '';
    return `
      <div class="cp-variant-card ${i === paletteState.activeVariantIndex ? 'cp-variant-selected' : ''}"
           data-index="${i}" data-variant-id="${v.id}">
        <div class="cp-variant-icon">${et.icon}</div>
        <div class="cp-variant-info">
          <div class="cp-variant-name">${v.label}</div>
          <div class="cp-variant-desc">${v.description}</div>
          ${dimLabel ? `<div class="cp-variant-dim">${dimLabel}</div>` : ''}
        </div>
        <button class="cp-fav-btn ${favClass}" data-variant-id="${v.id}" title="Toggle favorite">
          ${isFavorite(et.type, v.id) ? '★' : '☆'}
        </button>
      </div>
    `;
  }).join('');

  // Wire click on cards — activate placement
  grid.querySelectorAll('.cp-variant-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('cp-fav-btn')) {
        const variantId = e.target.dataset.variantId;
        toggleFavorite(elementType, variantId);
        openVariantPanel(elementType); // refresh
        return;
      }
      activatePlacement(elementType, card.dataset.variantId);
    });
  });

  // Arrow key navigation within variant panel
  grid.setAttribute('tabindex', '0');
  grid.focus();
}

function activatePlacement(elementType, variantId) {
  addRecent(elementType, variantId);
  closePalette();

  // Delegate to app.js placement system
  // The palette fires the same state changes that toolbar buttons trigger.
  const et = ELEMENT_TYPES.find(e => e.type === elementType);
  if (!et) return;

  // Map to app.js placement types
  const placementMap = { wall: 'wall', column: 'column', door: 'door', window: 'window', floor: 'floor', beam: 'beam', stair: 'stair', railing: 'railing' };
  const appType = placementMap[elementType];
  if (!appType) return;

  // Trigger via window dispatch so app.js can handle it
  window.dispatchEvent(new CustomEvent('atlantist:crafting-palette:place', {
    detail: { type: appType, variantId, elementType, label: et.label + ' — ' + variantId }
  }));
}

// ─── OPEN / CLOSE ────────────────────────────────────────────────────────────

function openPalette() {
  const el = document.getElementById('crafting-palette');
  if (!el) return;
  paletteState.open = true;
  el.classList.remove('cp-hidden');
  el.classList.add('cp-open');
  paletteState.selectedElementType = null;
  document.getElementById('cp-variant-panel')?.classList.remove('cp-variant-open');
  renderTypeRing();

  // Ensure type ring has items
  if (paletteState.activeTab === 'favorites' && getFavorites().length === 0) {
    paletteState.activeTab = 'recent';
    document.querySelectorAll('.cp-tab').forEach(t => t.classList.remove('cp-tab-active'));
    document.querySelector('.cp-tab[data-tab="recent"]')?.classList.add('cp-tab-active');
    renderTypeRing();
  }
}

function closePalette() {
  const el = document.getElementById('crafting-palette');
  if (!el) return;
  paletteState.open = false;
  el.classList.remove('cp-open');
  el.classList.add('cp-hidden');
}

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────────

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Q key — toggle palette (unless in input)
    if (e.key === 'q' || e.key === 'Q') {
      if (e.target.matches('input,textarea,select,[contenteditable]')) return;
      e.preventDefault();
      if (paletteState.open) closePalette(); else openPalette();
      return;
    }

    // Escape — close palette
    if (e.key === 'Escape' && paletteState.open) {
      e.preventDefault();
      closePalette();
      return;
    }

    // Arrow keys within variant panel
    if (!paletteState.open || !paletteState.selectedElementType) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

    const et = ELEMENT_TYPES.find(e => e.type === paletteState.selectedElementType);
    if (!et) return;

    e.preventDefault();
    const cols = 3;
    let idx = paletteState.activeVariantIndex;
    if (e.key === 'ArrowRight') idx = (idx + 1) % et.variants.length;
    if (e.key === 'ArrowLeft')  idx = (idx - 1 + et.variants.length) % et.variants.length;
    if (e.key === 'ArrowDown')  idx = Math.min(idx + cols, et.variants.length - 1);
    if (e.key === 'ArrowUp')    idx = Math.max(idx - cols, 0);

    paletteState.activeVariantIndex = idx;
    openVariantPanel(paletteState.selectedElementType); // re-render
  });
}

// ─── TAB SWITCHING ───────────────────────────────────────────────────────────

function initTabs() {
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.cp-tab');
    if (!tab) return;
    paletteState.activeTab = tab.dataset.tab;
    document.querySelectorAll('.cp-tab').forEach(t => t.classList.remove('cp-tab-active'));
    tab.classList.add('cp-tab-active');
    paletteState.selectedElementType = null;
    document.getElementById('cp-variant-panel')?.classList.remove('cp-variant-open');
    renderTypeRing();
  });
}

// ─── MODULE MULTIPLES TOGGLE ─────────────────────────────────────────────────

function initMultiplesToggle() {
  document.addEventListener('change', (e) => {
    if (e.target.id === 'cp-multiples-toggle') {
      paletteState.showMultiples = e.target.checked;
      if (paletteState.selectedElementType) {
        openVariantPanel(paletteState.selectedElementType);
      }
    }
  });
}

// ─── BACKDROP CLOSE ─────────────────────────────────────────────────────────

function initBackdrop() {
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('cp-backdrop') && paletteState.open) {
      closePalette();
    }
  });
}

// ─── INIT ────────────────────────────────────────────────────────────────────

let initialized = false;

export function initCraftingPalette() {
  if (initialized) return;
  initialized = true;

  // Check if already injected
  if (!document.getElementById('crafting-palette')) {
    injectPaletteHTML();
    initKeyboardShortcuts();
    initTabs();
    initMultiplesToggle();
    initBackdrop();
  }
}

// Auto-init when module loads (runs after DOM is ready)
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCraftingPalette);
  } else {
    initCraftingPalette();
  }
}

export { ELEMENT_TYPES, openPalette, closePalette, paletteState };