/**
 * SceneCoordinator — Atlantist multi-branch neural scene graph
 *
 * Phase 0: Shim mode. Each branch wraps the existing monolithic build functions.
 * Behavioral output is IDENTICAL to rebuildScene() — this is a structural migration
 * with zero visible change. Later phases enable dirty-bit isolation, geometry pools,
 * InstancedMesh, and WorkerBridge offload.
 *
 * Architecture: See /atlantist_neural_scene_arch.md
 *
 * Branch priority tiers:
 *   T0 (60fps): elements, structuralMembers
 *   T1 (60fps): floors, familyInstances
 *   T2 (10fps): mepElements, stairs
 *   T3 (10fps): grids, annotations
 *
 * Usage:
 *   import { initSceneCoordinator, sceneCoordinator } from './scene/coordinator.js';
 *   initSceneCoordinator(scene3d, scenePlan, sceneSection, builders, state);
 *   // In animate():  sceneCoordinator.flush();
 *   // On patch:      sceneCoordinator.markDirty('wall', id);
 */

'use strict';

// ─── Branch-to-type routing table ─────────────────────────────────────────────
const BRANCH_ROUTING = {
  // T0 — structural envelope
  wall:             'elements',
  column:           'elements',
  roof:             'elements',
  // T0 — structural analysis members
  beam:             'structuralMembers',
  structuralColumn: 'structuralMembers',
  structural:       'structuralMembers',
  // T1 — horizontal planes
  floor:            'floors',
  ceiling:          'floors',
  // T1 — hosted openings
  door:             'familyInstances',
  window:           'familyInstances',
  family:           'familyInstances',
  // T2 — MEP systems
  duct:             'mepElements',
  pipe:             'mepElements',
  cable_tray:       'mepElements',
  mep:              'mepElements',
  // T2 — vertical circulation
  stair:            'stairs',
  railing:          'stairs',
  // T3 — datum
  grid:             'grids',
  room:             'grids',
  level:            'grids',
  // T3 — annotations
  dimension:        'annotations',
  tag:              'annotations',
  keynote:          'annotations',
  annotation:       'annotations',
};

// ─── SceneBranch base ─────────────────────────────────────────────────────────
class SceneBranch {
  constructor(name, options = {}) {
    this.name            = name;
    this.dirty           = true;           // start dirty so first flush rebuilds
    this.dirtyIds        = new Set();
    this.fullRebuild     = true;
    this.lastRebuildMs   = 0;
    this.lastFlushTime   = 0;
    this.maxFps          = options.maxFps ?? 60;
    this._minInterval    = 1000 / this.maxFps;

    // Scene groups — added to scenes once, never recreated
    this.group3d      = new THREE.Group();
    this.group3d.name = `branch_${name}_3d`;
    this.groupPlan    = new THREE.Group();
    this.groupPlan.name = `branch_${name}_plan`;
    this.groupSection = new THREE.Group();
    this.groupSection.name = `branch_${name}_section`;
  }

  markDirty(id = null) {
    this.dirty = true;
    if (id === null) {
      this.fullRebuild = true;
      this.dirtyIds.clear();
    } else {
      this.dirtyIds.add(id);
    }
  }

  flush(now) {
    if (!this.dirty) return false;
    if (now - this.lastFlushTime < this._minInterval) return false;

    const t0 = performance.now();
    try {
      if (this.fullRebuild) {
        this._rebuildAll();
        this.fullRebuild = false;
      } else {
        this._rebuildChanged([...this.dirtyIds]);
      }
    } catch (e) {
      console.warn(`[SceneBranch:${this.name}] flush error:`, e.message);
    }

    this.dirty        = false;
    this.dirtyIds.clear();
    this.lastRebuildMs = performance.now() - t0;
    this.lastFlushTime = now;
    return true; // flushed
  }

  getStats() {
    return {
      name:          this.name,
      dirty:         this.dirty,
      lastRebuildMs: +this.lastRebuildMs.toFixed(2),
      dirtyCount:    this.dirtyIds.size,
    };
  }

  // Subclasses implement:
  _rebuildAll()        {}
  _rebuildChanged(ids) { this._rebuildAll(); } // Phase 0: incremental falls back to full
}

// ─── Phase 0 branch implementations ──────────────────────────────────────────
// Each branch calls the existing app.js build functions via a shared builders
// registry. No geometry pooling yet — that's Phase 2.

class ElementsBranch extends SceneBranch {
  constructor(name, opts, ctx) {
    super(name, opts);
    this._ctx = ctx; // { state, scene3d, scenePlan, sceneSection, buildWallMesh, buildColumnMesh, buildRoofMesh, levelElevation, pickMap, objectMap, markRenderDirty }
  }
  _rebuildAll() {
    const { state, scene3d, scenePlan, sceneSection, buildWallMesh, buildColumnMesh, buildRoofMesh, levelElevation, pickMap, objectMap, markRenderDirty } = this._ctx;
    // Clear this branch's groups
    _clearGroup(this.group3d);
    _clearGroup(this.groupPlan);
    _clearGroup(this.groupSection);

    for (const el of state.elements) {
      const isSelected = el.id === state.selectedId || state.multiSelection.some(s => s.id === el.id);
      let objs = [];
      if (el.type === 'wall') {
        const wallFamilies = state.familyInstances.filter(f => f.host_wall_id === el.id);
        objs = buildWallMesh(el, isSelected, wallFamilies);
      } else if (el.type === 'column') {
        objs = buildColumnMesh(el, isSelected);
      } else if (el.type === 'roof') {
        objs = buildRoofMesh(el, isSelected);
      }
      for (const obj of objs) {
        this.group3d.add(obj);
        const clonePlan = obj.clone(); clonePlan.userData = obj.userData;
        this.groupPlan.add(clonePlan);
        this.groupSection.add(obj.clone());
        pickMap.set(obj.uuid, { id: el.id, type: 'element' });
      }
      if (objs.length) objectMap.set(el.id, objs);
    }
    if (markRenderDirty) markRenderDirty();
  }
}

class StructuralMembersBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { state, buildStructuralMemberMesh, objectMap, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    try {
      for (const member of (state.structuralMembers || [])) {
        const isSelected = member.id === state.selectedId;
        const objs = buildStructuralMemberMesh(member, isSelected);
        for (const obj of objs) {
          this.group3d.add(obj);
          this.groupPlan.add(obj.clone());
          this.groupSection.add(obj.clone());
        }
        if (objs.length) objectMap.set(member.id, objs);
      }
    } catch (e) { console.warn('[branch:structuralMembers]', e.message); }
    if (markRenderDirty) markRenderDirty();
  }
}

class FloorsBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { state, buildFloorMesh, buildFloorPlan2D, buildCeilingMesh, objectMap, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    try {
      for (const floor of (state.floors || [])) {
        const isSelected = floor.id === state.selectedId;
        const objs3d = buildFloorMesh(floor, isSelected);
        const objs2d = buildFloorPlan2D(floor);
        for (const obj of objs3d) { this.group3d.add(obj); this.groupSection.add(obj.clone()); }
        for (const obj of objs2d) this.groupPlan.add(obj);
        if (objs3d.length) objectMap.set(floor.id, objs3d);
      }
      for (const ceiling of (state.ceilings || [])) {
        const isSelected = ceiling.id === state.selectedId;
        const objs = buildCeilingMesh(ceiling, isSelected);
        for (const obj of objs) { this.group3d.add(obj); this.groupSection.add(obj.clone()); }
        if (objs.length) objectMap.set(ceiling.id, objs);
      }
    } catch (e) { console.warn('[branch:floors]', e.message); }
    if (markRenderDirty) markRenderDirty();
  }
}

class FamilyInstancesBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { state, buildDoorMesh, buildWindowMesh, objectMap, pickMap, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    for (const fam of (state.familyInstances || [])) {
      const isSelected = fam.id === state.selectedId;
      let objs = [];
      if (fam.family_type === 'door')   objs = buildDoorMesh(fam, isSelected);
      else if (fam.family_type === 'window') objs = buildWindowMesh(fam, isSelected);
      for (const obj of objs) {
        this.group3d.add(obj);
        this.groupPlan.add(obj.clone());
        this.groupSection.add(obj.clone());
        pickMap.set(obj.uuid, { id: fam.id, type: 'family' });
      }
      if (objs.length) objectMap.set(fam.id, objs);
    }
    if (markRenderDirty) markRenderDirty();
  }
}

class MepElementsBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { state, buildMEPMesh, objectMap, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    try {
      if (state.mepLayerVisible) {
        for (const el of (state.mepElements || [])) {
          const isSelected = el.id === state.selectedId;
          const objs = buildMEPMesh(el, isSelected);
          for (const obj of objs) { this.group3d.add(obj); this.groupPlan.add(obj.clone()); }
          if (objs.length) objectMap.set(el.id, objs);
        }
      }
    } catch (e) { console.warn('[branch:mepElements]', e.message); }
    if (markRenderDirty) markRenderDirty();
  }
}

class StairsBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { state, buildStairMesh, buildStairSymbol2D, buildRailingMesh, objectMap, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    try {
      for (const stair of (state.stairs || [])) {
        const isSelected = stair.id === state.selectedId;
        const objs = buildStairMesh(stair, isSelected);
        const planObjs = buildStairSymbol2D(stair);
        for (const obj of objs) { this.group3d.add(obj); }
        for (const p of planObjs) { this.groupPlan.add(p); this.groupSection.add(p.clone()); }
        if (objs.length) objectMap.set(stair.id, objs);
      }
      for (const railing of (state.railings || [])) {
        const isSelected = railing.id === state.selectedId;
        const objs = buildRailingMesh(railing, isSelected);
        for (const obj of objs) { this.group3d.add(obj); this.groupPlan.add(obj.clone()); }
        if (objs.length) objectMap.set(railing.id, objs);
      }
    } catch (e) { console.warn('[branch:stairs]', e.message); }
    if (markRenderDirty) markRenderDirty();
  }
}

class GridsBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { state, buildGridMesh, buildLevelPlane, objectMap, pickMap, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    try {
      for (const grid of (state.grids || [])) {
        const objs = buildGridMesh(grid);
        for (const obj of objs) { this.group3d.add(obj); this.groupPlan.add(obj.clone()); }
        if (objs.length) objectMap.set(grid.id, objs);
      }
      // Level planes belong to grids branch (datum elements)
      for (const level of (state.levels || [])) {
        const objs = buildLevelPlane(level);
        for (const obj of objs) {
          this.group3d.add(obj);
          obj.userData = { id: level.id, type: 'level' };
          pickMap.set(obj.uuid, { id: level.id, type: 'level' });
        }
        if (objs.length) objectMap.set(level.id, objs);
      }
    } catch (e) { console.warn('[branch:grids]', e.message); }
    if (markRenderDirty) markRenderDirty();
  }
}

class AnnotationsBranch extends SceneBranch {
  constructor(name, opts, ctx) { super(name, opts); this._ctx = ctx; }
  _rebuildAll() {
    const { renderAnnotations, renderIMHighlight, renderRoomBoundaries, renderIssuePins, markRenderDirty } = this._ctx;
    _clearGroup(this.group3d); _clearGroup(this.groupPlan); _clearGroup(this.groupSection);
    // Annotations use their own render functions that manage DOM/CSS2D objects
    // — they add directly to annotationGroup* globals, not to branch groups.
    // Branch just triggers them at the right time/priority.
    try { if (renderAnnotations)   renderAnnotations(); }   catch (e) { console.warn('[branch:annotations] renderAnnotations', e.message); }
    try { if (renderIMHighlight)   renderIMHighlight(); }   catch (e) { console.warn('[branch:annotations] renderIMHighlight', e.message); }
    try { if (renderRoomBoundaries) renderRoomBoundaries(); } catch (e) { console.warn('[branch:annotations] renderRoomBoundaries', e.message); }
    if (markRenderDirty) markRenderDirty();
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Clear a THREE.Group without disposing shared cached geometries/materials.
 * Phase 0: children are mesh instances using the _matCache/_geoCache system,
 * so we only remove from the group — cache owns lifetime.
 */
function _clearGroup(group) {
  while (group.children.length > 0) {
    group.remove(group.children[0]);
  }
}

// ─── SceneCoordinator ─────────────────────────────────────────────────────────

export class SceneCoordinator {
  constructor(scene3d, scenePlan, sceneSection, ctx) {
    this._branches = new Map();
    this._ctx      = ctx;
    this._initBranches(scene3d, scenePlan, sceneSection, ctx);
  }

  _initBranches(scene3d, scenePlan, sceneSection, ctx) {
    const defs = [
      // T0
      { Cls: ElementsBranch,          name: 'elements',          maxFps: 60 },
      { Cls: StructuralMembersBranch, name: 'structuralMembers', maxFps: 60 },
      // T1
      { Cls: FloorsBranch,            name: 'floors',            maxFps: 60 },
      { Cls: FamilyInstancesBranch,   name: 'familyInstances',   maxFps: 60 },
      // T2
      { Cls: MepElementsBranch,       name: 'mepElements',       maxFps: 10 },
      { Cls: StairsBranch,            name: 'stairs',            maxFps: 10 },
      // T3
      { Cls: GridsBranch,             name: 'grids',             maxFps: 10 },
      { Cls: AnnotationsBranch,       name: 'annotations',       maxFps: 10 },
    ];

    for (const { Cls, name, maxFps } of defs) {
      const branch = new Cls(name, { maxFps }, ctx);
      this._branches.set(name, branch);
      // Add branch groups to scenes once
      scene3d.add(branch.group3d);
      scenePlan.add(branch.groupPlan);
      sceneSection.add(branch.groupSection);
    }
  }

  /**
   * Route an element type patch to the correct branch.
   * @param {string} elementType — 'wall' | 'column' | 'floor' | 'door' | ...
   * @param {*}      id          — element id (null = full branch rebuild)
   */
  markDirty(elementType, id = null) {
    const branchName = BRANCH_ROUTING[elementType];
    if (!branchName) {
      // Unknown type — mark all T0 branches dirty as safe fallback
      this._branches.get('elements')?.markDirty(null);
      return;
    }
    this._branches.get(branchName)?.markDirty(id);
  }

  /** Direct branch access by name */
  markBranchDirty(branchName, id = null) {
    this._branches.get(branchName)?.markDirty(id);
  }

  /** Mark ALL branches dirty (full scene rebuild — replaces rebuildScene()) */
  rebuildAll() {
    for (const branch of this._branches.values()) branch.markDirty(null);
  }

  /**
   * Called every animation frame from animate().
   * Flushes dirty branches in T0 → T1 → T2 → T3 priority order.
   * T2/T3 branches self-throttle to 10fps via their minInterval.
   */
  flush() {
    const now = performance.now();
    // T0 — must be current at 60fps
    this._branches.get('elements')?.flush(now);
    this._branches.get('structuralMembers')?.flush(now);
    // T1
    this._branches.get('floors')?.flush(now);
    this._branches.get('familyInstances')?.flush(now);
    // T2 — throttled to 10fps
    this._branches.get('mepElements')?.flush(now);
    this._branches.get('stairs')?.flush(now);
    // T3 — throttled to 10fps
    this._branches.get('grids')?.flush(now);
    this._branches.get('annotations')?.flush(now);
  }

  getBranchStats() {
    return [...this._branches.values()].map(b => b.getStats());
  }

  /**
   * Update the live context object (called when state refs change).
   * Safe to call at any time — branches read ctx on flush, not on init.
   */
  updateCtx(ctx) {
    Object.assign(this._ctx, ctx);
    for (const branch of this._branches.values()) {
      branch._ctx = this._ctx;
    }
  }

  dispose() {
    for (const branch of this._branches.values()) {
      _clearGroup(branch.group3d);
      _clearGroup(branch.groupPlan);
      _clearGroup(branch.groupSection);
    }
    this._branches.clear();
  }
}

// ─── Module singleton ─────────────────────────────────────────────────────────

export let sceneCoordinator = null;

/**
 * Call once after THREE scenes exist and build functions are defined.
 * Returns the coordinator instance.
 */
export function initSceneCoordinator(scene3d, scenePlan, sceneSection, ctx) {
  sceneCoordinator = new SceneCoordinator(scene3d, scenePlan, sceneSection, ctx);
  // Expose globally for legacy call sites and debugging
  window.__atlSceneCoordinator = sceneCoordinator;
  return sceneCoordinator;
}
