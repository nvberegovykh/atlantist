/**
 * placement-service.js — Atlantist BIM 2.0
 * Multi-View Placement Mode + module-derived default dimensions.
 *
 * Owns: placement context, module-derived defaults, secondary viewport
 *        management, cross-viewport click routing.
 * Does NOT own: wall/door/column modal DOM, Three.js scenes, raycasting logic.
 */

import { setViewportView, vpState } from './viewport-manager.js';

// ─── Module-derived defaults ────────────────────────────────────────────────

/**
 * Get module M in mm from the current module project.
 * Falls back to 1000mm if moduleCache not yet loaded.
 */
export function getModuleM() {
  if (window._atlantist_moduleCache) {
    return window._atlantist_moduleCache.M_value || 1000;
  }
  return 1000;
}

/**
 * Build a getModuleDerived-compatible config from the current module state.
 * Used by this service (frontend) to mirror services/module-system.js behavior.
 */
export function getModuleDerivedLocal() {
  const M_mm = getModuleM();
  const halfM  = M_mm / 2;
  const quarterM = M_mm / 4;
  const eighthM = M_mm / 8;
  const doubleM = M_mm * 2;
  const quadrupleM = M_mm * 4;
  const sextupleM = M_mm * 6;

  return {
    M_mm,
    // ── Placement defaults ──────────────────────────────────────────────────
    wallThickness: {
      // Real-world standard wall thicknesses constrained to M-derived candidates
      candidates: [
        { label: 'M/4', value_mm: quarterM, description: 'Light frame partition' },
        { label: 'M/3', value_mm: M_mm / 3,   description: 'Stud wall (3-5/8" ≈ M/3 for M≈300mm)' },
        { label: 'M/2', value_mm: halfM,     description: 'CMU 8" (203mm ≈ M/2 for M≈400mm)' },
      ],
      defaultIndex: 1, // M/3 as default
    },
    door: {
      width_mm:  doubleM,       // 2M — SP-A default
      height_mm: quadrupleM,   // 4M — SP-A default
    },
    window: {
      width_mm:  quadrupleM,   // 4M
      height_mm: doubleM,      // 2M
      sillHeight_mm: 900,       // default sill height (900mm = 3')
    },
    slab: {
      thickness_mm: quarterM,   // M/4
    },
    floorToFloor_mm: quadrupleM, // 4M
    // ── Overlay thresholds (from SP-A) ─────────────────────────────────────
    overlay: {
      red:   eighthM / 2,  // M/16 — hard violation
      amber: eighthM,      // M/8  — constructability warning
    },
    // ── Ortho framing ────────────────────────────────────────────────────────
    orthoZone_mm: quadrupleM * 4, // 4M×4 zone for close-up ortho framing
    // ── Grid snap ─────────────────────────────────────────────────────────────
    snap: {
      fine:   eighthM,
      coarse: quarterM,
    },
  };
}

// ─── Display formatting helpers ─────────────────────────────────────────────

/**
 * Format a mm value for display in the project's unit system.
 * Used for showing default dimensions in placement modals.
 */
export function formatPlacementValue(mm, unitSystem = 'si') {
  switch (unitSystem) {
    case 'imperial': {
      const inches = mm / 25.4;
      const ft = Math.floor(inches / 12);
      const ins = Math.round(inches % 12);
      if (ft === 0) return `${ins}"`;
      if (ins === 0) return `${ft}'`;
      return `${ft}'-${ins}"`;
    }
    case 'modulor': {
      const M = getModuleM();
      const multiples = (mm / M).toFixed(2);
      return `${mm.toFixed(0)} mm (${multiples} M)`;
    }
    case 'ken': {
      const ken = 910;
      const multiples = (mm / ken).toFixed(2);
      return `${mm.toFixed(0)} mm (${multiples} ken)`;
    }
    case 'si':
    default: {
      if (Math.abs(mm) >= 1000) return `${(mm / 1000).toFixed(3)} m`;
      if (Math.abs(mm) >= 100)  return `${(mm / 10).toFixed(1)} cm`;
      return `${Math.round(mm)} mm`;
    }
  }
}

// ─── Placement context ──────────────────────────────────────────────────────

// Current placement session state
export const placementContext = {
  active: false,
  type: null,           // 'wall' | 'door' | 'window' | 'column' | 'beam' | 'slab'
  subtype: null,        // for doors/windows: door/window
  moduleDerived: null,  // result of getModuleDerivedLocal()
  moduleLoaded: false,
  // Secondary viewport state
  secondaryPaneId: null,  // 'p1' | 'p2' | 'p3'
  secondaryView: null,    // 'top' | 'section_x' | 'left'
  // Close-up state
  closeupTarget: null,    // { x, y, z } world position
};

// ─── Secondary viewport mapping ─────────────────────────────────────────────
// wall → plan (top) view — most useful for wall placement in plan
// beam → section_x — shows beam section and span
// column → left elevation — shows column height and grid context
// door / window → plan (top) — shows wall face on plan
// slab → plan (top) — shows slab boundary on plan

const SECONDARY_VIEW_MAP = {
  wall:    { pane: 'p1', view: 'top' },
  beam:    { pane: 'p2', view: 'section_x' },
  column:  { pane: 'p3', view: 'left' },
  door:    { pane: 'p1', view: 'top' },
  window:  { pane: 'p1', view: 'top' },
  slab:    { pane: 'p1', view: 'top' },
};

/**
 * Start a placement session. Call when user clicks "Add Wall/Door/Column/etc."
 * Auto-opens the appropriate secondary viewport.
 */
export function startPlacement(type) {
  const derived = getModuleDerivedLocal();
  placementContext.active = true;
  placementContext.type = type;
  placementContext.moduleDerived = derived;
  placementContext.moduleLoaded = true;

  const mapping = SECONDARY_VIEW_MAP[type] || SECONDARY_VIEW_MAP.wall;
  placementContext.secondaryPaneId = mapping.pane;
  placementContext.secondaryView = mapping.view;

  // Auto-switch secondary pane to the right ortho view
  setViewportView(mapping.pane, mapping.view);

  // Show structural load path overlays in ortho if type is structural
  if (['beam', 'column'].includes(type)) {
    _enableStructuralOverlay(true);
  }
}

/**
 * End the current placement session.
 */
export function endPlacement() {
  placementContext.active = false;
  placementContext.type = null;
  placementContext.subtype = null;
  placementContext.secondaryPaneId = null;
  placementContext.secondaryView = null;
  placementContext.closeupTarget = null;

  // Disable structural overlay when placement ends
  _enableStructuralOverlay(false);
}

function _enableStructuralOverlay(enable) {
  if (window.OverlayService) {
    if (enable) {
      // Trigger load-path visualization in ortho scenes
      window.OverlayService.setPlacementMode && window.OverlayService.setPlacementMode(true);
    } else {
      window.OverlayService.setPlacementMode && window.OverlayService.setPlacementMode(false);
    }
  }
}

/**
 * Update placement position (for close-up zoom).
 * Call from mouse move during placement.
 */
export function updatePlacementPosition(worldPoint) {
  if (!placementContext.active) return;
  placementContext.closeupTarget = worldPoint
    ? { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }
    : null;
}

/**
 * Get wall thickness candidates for the wall type selector.
 * Returns array with { label, value, description, selected }.
 */
export function getWallThicknessCandidates(unitSystem = 'si') {
  const derived = placementContext.moduleDerived || getModuleDerivedLocal();
  return derived.wallThickness.candidates.map((c, i) => ({
    ...c,
    displayValue: formatPlacementValue(c.value_mm, unitSystem),
    selected: i === derived.wallThickness.defaultIndex,
  }));
}

/**
 * Get door default dimensions as { width, height } in mm.
 */
export function getDoorDefaults(unitSystem = 'si') {
  const derived = placementContext.moduleDerived || getModuleDerivedLocal();
  return {
    width:  formatPlacementValue(derived.door.width_mm, unitSystem),
    height: formatPlacementValue(derived.door.height_mm, unitSystem),
    width_mm:  derived.door.width_mm,
    height_mm: derived.door.height_mm,
  };
}

/**
 * Get window default dimensions as { width, height, sillHeight } in mm.
 */
export function getWindowDefaults(unitSystem = 'si') {
  const derived = placementContext.moduleDerived || getModuleDerivedLocal();
  return {
    width:    formatPlacementValue(derived.window.width_mm, unitSystem),
    height:   formatPlacementValue(derived.window.height_mm, unitSystem),
    sillHeight: formatPlacementValue(derived.window.sillHeight_mm, unitSystem),
    width_mm:  derived.window.width_mm,
    height_mm: derived.window.height_mm,
    sillHeight_mm: derived.window.sillHeight_mm,
  };
}

/**
 * Get slab thickness default.
 */
export function getSlabDefaults(unitSystem = 'si') {
  const derived = placementContext.moduleDerived || getModuleDerivedLocal();
  return {
    thickness: formatPlacementValue(derived.slab.thickness_mm, unitSystem),
    thickness_mm: derived.slab.thickness_mm,
  };
}

/**
 * Get floor-to-floor height default.
 */
export function getFloorToFloorHeight(unitSystem = 'si') {
  const derived = placementContext.moduleDerived || getModuleDerivedLocal();
  return {
    height: formatPlacementValue(derived.floorToFloor_mm, unitSystem),
    height_mm: derived.floorToFloor_mm,
  };
}

/**
 * Get ortho M×4 zone size in mm (used for ortho framing in secondary view).
 */
export function getOrthoZoneSize() {
  const derived = placementContext.moduleDerived || getModuleDerivedLocal();
  return derived.orthoZone_mm;
}

/**
 * Sync module state from external cache (called by app.js when moduleCache loads).
 */
export function syncModuleCache(moduleCache) {
  window._atlantist_moduleCache = moduleCache;
}