/**
 * adaptive-grid.js — SP-B: Adaptive Grid System
 * Owns: Global/object-relative WebGL grid rendering, density toggle, snap preferences.
 * Does NOT own: Three.js renderer/scenes/cameras (app.js owns these), module persistence.
 *
 * Renders grids as WebGL LineSegments — not DOM, not GridHelper.
 * All spacing values from SP-A getModuleDerived(M) — zero hardcoded values.
 * Grid auto-activates on hover proximity (within 2× element bbox), deactivates on leave.
 * Object-relative grids rotate to match element geometry (walls, angled elements).
 * Multi-object: candidate grids shown in different colors, user picks by hovering.
 */

(function () {
  'use strict';

  // BUG-R5: adaptive-grid.js is a defer script that executes BEFORE app.js loads THREE
  // via importmap. If THREE isn't available, defer all grid rendering until initGridEngine
  // is called (after app.js has imported THREE). The window.AdaptiveGrid stubs below
  // ensure calling code doesn't crash on a missing AdaptiveGrid global.
  const _threeReady = typeof THREE !== 'undefined';

  if (!_threeReady) {
    window.AdaptiveGrid = {
      initWithModuleConfig() {}, initGridEngine() {},
      setDensity() {}, cycleDensity() {}, toggleGlobalGrid() {},
      onElementHovered() {}, onElementUnhovered() {},
      buildCandidateGrids() {}, snapToStandardOC() {},
      getDensityLabel() { return 'M = 1000 mm'; }, getDensityCount() { return 5; },
      destroy() {},
    };
    return; // short-circuit — don't define any grid logic
  }

  // ─── THREE is available — proceed with normal init ─────────────────────────
  // These are written to by initWithModuleConfig() called from app.js after
  // the module project has been loaded from the server.
  let _moduleConfig = {
    M_mm: 1000,
    sys: 'si',
    gridSpacings: [1000, 500, 250, 2000, 4000], // M, M/2, M/4, 2M, 4M in mm
    standardOC_mm: [304.8, 406.4, 609.6, 812.8, 1219.2], // 12, 16, 24, 32, 48 inches
    snapFine: 125,   // M/8
    snapCoarse: 250, // M/4
  };

  // ─── Grid state ──────────────────────────────────────────────────────────────
  let _activeDensityIdx = 0; // index into gridSpacings
  let _showGlobalGrid = true;
  let _activeGrids = []; // { group: THREE.Group, origin: THREE.Vector3, angle: number }
  let _candidateGrids = []; // when between multiple objects, multiple candidates shown

  // Active element being hovered (from raycaster)
  let _hoveredElementId = null;
  let _hoveredElementGroup = null; // THREE.Group for the wall/element

  // Density colors (each density level gets a distinct color for visual clarity)
  const DENSITY_COLORS = [
    0x4a8df5, // M — blue
    0x22c55e, // M/2 — green
    0xf59e0b, // M/4 — amber
    0x8b5cf6, // 2M — purple
    0xec4899, // 4M — pink
  ];

  // ─── Scene wiring ────────────────────────────────────────────────────────────
  let _scenes = null;  // { '3d': scene3d, 'plan': scenePlan, 'section': sceneSection }
  let _camMap = null;  // { '3d': cam3d, 'plan': camPlan, 'section': camSect }
  let _rendMap = null; // { '3d': rend3d, 'plan': rendPlan, 'section': rendSect }
  let _raycaster = null;
  let _mouse = null;

  // ─── Module config API (called by app.js after loading module_project) ────────
  /**
   * Called by app.js once the active module_project has been loaded from the server.
   * Recomputes all derived values from M and system.
   * @param {object} cfg — result of getModuleDerived(M, system)
   */
  function initWithModuleConfig(cfg) {
    if (!cfg) return;
    _moduleConfig.M_mm = cfg.M_mm || _moduleConfig.M_mm;
    _moduleConfig.sys = cfg.sys || 'si';
    _moduleConfig.gridSpacings = (cfg.grid || []).map(g => g.value || g);
    _moduleConfig.standardOC_mm = cfg.standardOC_mm || _moduleConfig.standardOC_mm;
    _moduleConfig.snapFine = (cfg.snap && cfg.snap.fine) ? cfg.snap.fine : _moduleConfig.M_mm / 8;
    _moduleConfig.snapCoarse = (cfg.snap && cfg.snap.coarse) ? cfg.snap.coarse : _moduleConfig.M_mm / 4;
    _rebuildAll();
  }

  /**
   * Called by app.js on project load to inject scene/camera/renderer refs.
   */
  function initGridEngine(scenes, camMap, rendMap, raycaster, mouse) {
    _scenes = scenes;
    _camMap = camMap;
    _rendMap = rendMap;
    _raycaster = raycaster;
    _mouse = mouse;
    _rebuildAll();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────
  function setDensity(idx) {
    _activeDensityIdx = Math.max(0, Math.min(idx, _moduleConfig.gridSpacings.length - 1));
    _rebuildAll();
  }

  function cycleDensity() {
    _activeDensityIdx = (_activeDensityIdx + 1) % _moduleConfig.gridSpacings.length;
    _rebuildAll();
  }

  function toggleGlobalGrid() {
    _showGlobalGrid = !_showGlobalGrid;
    _rebuildAll();
  }

  function onElementHovered(elementId, elementGroup, mouseWorldPos) {
    _hoveredElementId = elementId;
    _hoveredElementGroup = elementGroup;
    if (elementGroup) {
      _activateObjectGrid(elementGroup, mouseWorldPos);
    } else {
      _deactivateObjectGrid();
    }
  }

  function onElementUnhovered() {
    _hoveredElementId = null;
    _hoveredElementGroup = null;
    _deactivateObjectGrid();
  }

  // ─── Core: build global grid ──────────────────────────────────────────────────
  // BUG-R5: guard against THREE not being loaded yet (defer script runs before app.js imports THREE)
  if (typeof THREE === 'undefined') {
    console.warn('[adaptive-grid] THREE not yet loaded — skipping init');
  }

  /**
   * Build a grid of horizontal and vertical lines as a THREE.LineSegments object.
   * Lines extend ±50 units from origin in world space.
   */
  function buildGridLineGeometry(spacing, extent) {
    const positions = [];
    const half = extent / 2;
    const step = spacing;

    // Horizontal lines (along X axis, varying Y)
    for (let y = -half; y <= half; y += step) {
      positions.push(-half, 0, y,  half, 0, y);
    }
    // Vertical lines (along Z axis, varying X)
    for (let x = -half; x <= half; x += step) {
      positions.push(x, 0, -half,  x, 0, half);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }

  /**
   * Build the global grid group — orthonormal, XZ plane at y=0.
   * Returns a THREE.Group with LineSegments children at different density levels.
   * Only the active density is visible; others are hidden for performance.
   */
  function buildGlobalGrid() {
    const group = new THREE.Group();
    group.name = '_adaptive_global_grid';

    const spacings = _moduleConfig.gridSpacings;
    const extent = 100; // world units — covers a big area; adjust if needed

    spacings.forEach((spacing, idx) => {
      const color = DENSITY_COLORS[idx % DENSITY_COLORS.length];
      const isActive = idx === _activeDensityIdx;

      const geo = buildGridLineGeometry(spacing, extent);
      const mat = new THREE.LineBasicMaterial({
        color,
        opacity: isActive ? 0.5 : 0.08,
        transparent: true,
      });
      const lines = new THREE.LineSegments(geo, mat);
      lines.name = `global_grid_density_${idx}`;
      lines.visible = isActive;
      group.add(lines);
    });

    return group;
  }

  /**
   * Build an object-relative grid aligned to an element's orientation.
   * For walls, this means the grid follows the wall's rotation around Y.
   * Extends from the element's projected bounding box edges.
   */
  function buildObjectGrid(elementGroup, mouseWorldPos) {
    const group = new THREE.Group();
    group.name = '_adaptive_object_grid';

    // Determine element bounding box in world space
    const bbox = new THREE.Box3().setFromObject(elementGroup);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    // Extract element's Y-axis rotation
    const elementMatrix = elementGroup.matrixWorld;
    const right = new THREE.Vector3(1, 0, 0).applyMatrix4(elementMatrix).normalize();
    const forward = new THREE.Vector3(0, 0, 1).applyMatrix4(elementMatrix).normalize();
    const angleY = Math.atan2(right.x, right.z);

    const spacing = _moduleConfig.gridSpacings[_activeDensityIdx] || _moduleConfig.M_mm / 1000;
    const extent = 60; // lines extend ±30 units in element-aligned space

    const spacings = _moduleConfig.gridSpacings;
    spacings.forEach((sp, idx) => {
      const color = DENSITY_COLORS[idx % DENSITY_COLORS.length];
      const isActive = idx === _activeDensityIdx;

      // Build unrotated grid geometry
      const geo = buildGridLineGeometry(sp, extent);

      // Rotate geometry around Y to align with element
      geo.applyMatrix4(new THREE.Matrix4().makeRotationY(angleY));

      // Translate geometry so it spans from the element outward
      // Center the grid on the element's center
      geo.applyMatrix4(new THREE.Matrix4().makeTranslation(center.x, 0, center.z));

      const mat = new THREE.LineBasicMaterial({
        color,
        opacity: isActive ? 0.6 : 0.08,
        transparent: true,
      });
      const lines = new THREE.LineSegments(geo, mat);
      lines.name = `object_grid_density_${idx}`;
      lines.visible = isActive;
      group.add(lines);
    });

    return group;
  }

  // ─── Placement logic ─────────────────────────────────────────────────────────
  /**
   * Given a list of nearby element groups, build candidate grids for each.
   * Shown simultaneously with different colors — mouse hover selects which to prefer.
   */
  function buildCandidateGrids(nearbyGroups) {
    _candidateGrids.forEach(g => g.forEach(child => {
      // remove from scene if attached
    }));
    _candidateGrids = [];

    // Only show up to 3 candidates to avoid visual clutter
    const maxCandidates = 3;
    nearbyGroups.slice(0, maxCandidates).forEach((elemGroup, i) => {
      const grid = buildObjectGrid(elemGroup, null);
      grid.traverse(child => {
        if (child.isLine) {
          child.material = child.material.clone();
          // Tint each candidate a different shade
          const baseColor = new THREE.Color(DENSITY_COLORS[i % DENSITY_COLORS.length]);
          child.material.color = baseColor;
          child.material.opacity = child.visible ? 0.55 : 0.06;
        }
      });

      if (_scenes && _scenes['3d']) _scenes['3d'].add(grid);
      _candidateGrids.push(grid);
    });
  }

  // ─── Snap preferences — standard OC spacing ranking ──────────────────────────
  /**
   * Given a raw snap position (in mm) and the current M value, return the
   * nearest snap candidate that falls within snapCoarse threshold.
   * Prefers standard OC spacings (16", 24", 48") over raw M subdivisions.
   * @param {number} rawPos - raw mouse position in mm
   * @param {number} origin - reference origin in mm
   * @returns {number} snapped position in mm, or rawPos if nothing within threshold
   */
  function snapToStandardOC(rawPos, origin) {
    const snapThresh = _moduleConfig.snapCoarse;
    const standardOC = _moduleConfig.standardOC_mm; // already in mm
    const M_subdivs = _moduleConfig.gridSpacings; // M, M/2, M/4, 2M, 4M

    // Collect all candidates within threshold
    let best = null;
    let bestDist = Infinity;

    const allCandidates = [
      ...standardOC.map(v => ({ value: v, weight: 2 })), // standard OC gets priority
      ...M_subdivs.map(v => ({ value: v, weight: 1 })),
    ];

    for (const c of allCandidates) {
      const snapped = Math.round((rawPos - origin) / c.value) * c.value + origin;
      const dist = Math.abs(rawPos - snapped);
      if (dist < snapThresh && dist < bestDist) {
        bestDist = dist;
        best = snapped;
      }
    }

    return best !== null ? best : rawPos;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────
  function _activateObjectGrid(elementGroup, mouseWorldPos) {
    _deactivateObjectGrid();
    const grid = buildObjectGrid(elementGroup, mouseWorldPos);
    if (_scenes && _scenes['3d']) _scenes['3d'].add(grid);
    _activeGrids.push(grid);
  }

  function _deactivateObjectGrid() {
    _activeGrids.forEach(g => {
      if (_scenes && _scenes['3d']) _scenes['3d'].remove(g);
    });
    _activeGrids = [];
  }

  function _rebuildAll() {
    // Remove existing global grid from all scenes
    if (_scenes) {
      Object.values(_scenes).forEach(scene => {
        const existing = scene.getObjectByName('_adaptive_global_grid');
        if (existing) scene.remove(existing);
      });
    }

    if (_showGlobalGrid) {
      const globalGrid = buildGlobalGrid();
      if (_scenes && _scenes['3d']) _scenes['3d'].add(globalGrid);
      // Also add to plan and section scenes for full 3D coverage
      if (_scenes && _scenes['plan']) {
        const pg = buildGlobalGrid();
        _scenes['plan'].add(pg);
      }
      if (_scenes && _scenes['section']) {
        const sg = buildGlobalGrid();
        _scenes['section'].add(sg);
      }
    }

    // Rebuild object grids if any are active
    if (_hoveredElementGroup) {
      _activateObjectGrid(_hoveredElementGroup, null);
    }
  }

  // ─── Density label helper (for UI display) ──────────────────────────────────
  function getDensityLabel() {
    const spacing = _moduleConfig.gridSpacings[_activeDensityIdx];
    const labels = ['M', 'M/2', 'M/4', '2M', '4M'];
    const unitLabel = _moduleConfig.sys === 'imperial' ? '"' : ' mm';
    const display = _moduleConfig.sys === 'imperial'
      ? (spacing / 25.4).toFixed(1) + '"\n'
      : spacing.toFixed(0) + unitLabel;
    return `${labels[_activeDensityIdx] || 'M'} = ${display}`;
  }

  function getDensityCount() {
    return _moduleConfig.gridSpacings.length;
  }

  // ─── Module export (AMD / globals) ────────────────────────────────────────────
  // Expose globally for app.js to call
  window.AdaptiveGrid = {
    initWithModuleConfig,
    initGridEngine,
    setDensity,
    cycleDensity,
    toggleGlobalGrid,
    onElementHovered,
    onElementUnhovered,
    buildCandidateGrids,
    snapToStandardOC,
    getDensityLabel,
    getDensityCount,
    get activeDensityIdx() { return _activeDensityIdx; },
    get showGlobalGrid() { return _showGlobalGrid; },
    get moduleConfig() { return Object.assign({}, _moduleConfig); },
    // Debug
    get activeGrids() { return _activeGrids; },
    get candidateGrids() { return _candidateGrids; },
  };

})();