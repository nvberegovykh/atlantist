/**
 * Atlantist Overlay Service — real-time 3-tier RED/AMBER/GREEN overlay rendering.
 *
 * Manages Three.js overlay meshes on the WebGL scene.
 * Updated via requestAnimationFrame on every drag frame.
 * Tooltip on hover shows code reference + required vs actual values.
 *
 * Exposes: window.OverlayService (singleton), renderOverlays(), clearOverlays()
 *
 * Dependencies: window.scene, window.elementObjects (from app.js)
 * No circular deps — imports nothing from app.js.
 */

// ─── THREE guard (BUG-R5) ─────────────────────────────────────────────────────
// overlay-service.js is a defer script that executes BEFORE app.js loads THREE
// via importmap. Guard against THREE being undefined at init time.
if (typeof THREE === 'undefined') {
  console.warn('[overlay-service] THREE not yet loaded — skipping init (app.js will re-enable)');
  // Stub the global so calls to OverlayService don't throw ReferenceError
  window.OverlayService = { enable(){}, disable(){}, isEnabled() { return false; },
    getStats() { return {}; }, updateBadgePositions() {}, fetchAndRender() {},
    onMouseMove() {}, onMouseLeave() {} };
  window.__updateOverlayBadges = function() {};
  // Re-enable when app.js is ready
  window.addEventListener('atlantist_ready', () => { /* app.js will overwrite window.OverlayService */ }, { once: true });
  // Don't execute the rest of the IIFE — this file's real init is in app.js after THREE loads
  // The remaining code below is guarded with `if (typeof THREE !== 'undefined')` blocks
} else {
  // THREE is available — normal initialization
}

// ─── Singleton state ───────────────────────────────────────────────────────────
const OverlayService = (function () {
  // Lazy init: _overlayGroup is null until first enable(), when THREE is guaranteed available
  let _overlayGroup = null;

  function _ensureGroup() {
    if (!_overlayGroup) {
      _overlayGroup = new THREE.Group();
      _overlayGroup.name = 'compliance_overlays';
      _overlayGroup.renderOrder = 998; // render before selection helpers (999)
    }
    return _overlayGroup;
  }

  // Map: overlayId → { mesh, line, arrow, label, timeoutId, data }
  const _overlays = new Map();
  let _overlayIdCounter = 0;
  let _lastOverlays = [];    // last rendered overlay set
  let _tooltipEl = null;
  let _hoveredOverlayId = null;
  let _isEnabled = false;

  // ─── Color constants ────────────────────────────────────────────────────────
  const COLOR = { RED: 0xff4444, AMBER: 0xff9900, GREEN: 0x22cc66 };
  const OPACITY = {
    RED:   { solid: 0.85, wireframe: 0.45 },
    AMBER: { solid: 0.70, wireframe: 0.35 },
    GREEN: { solid: 0.50, wireframe: 0.25 },
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function _uid() { return ++_overlayIdCounter; }

  function _getElementBBox(elementId) {
    const obj = window.elementObjects?.get(elementId);
    if (!obj) return null;
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    return { box, size, center, obj };
  }

  function _getScene() {
    return window.scene;
  }

  // ─── Mesh builders ─────────────────────────────────────────────────────────

  /**
   * Create a transparent solid box overlay at a specific position.
   * Used for clearance violations (volumetric conflict regions).
   */
  function _makeSolidBox(center, size, color, opacity) {
    const geo = new THREE.BoxGeometry(
      Math.max(size.x, 5),
      Math.max(size.y, 5),
      Math.max(size.z, 5)
    );
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(center.x, center.y, center.z);
    mesh.renderOrder = 998;
    return mesh;
  }

  /**
   * Create a wireframe box overlay around an element.
   * Used for alignment violations and code check overlays.
   */
  function _makeWireframeBox(elementId, color, opacity, padding = 50) {
    const bbox = _getElementBBox(elementId);
    if (!bbox) return null;
    const { center, size } = bbox;

    const geo = new THREE.BoxGeometry(
      size.x + padding * 2,
      size.y + padding * 2,
      size.z + padding * 2
    );
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      linewidth: 2,
    });
    const lines = new THREE.LineSegments(edges, mat);
    lines.position.set(center.x, center.y, center.z);
    lines.renderOrder = 999;
    return lines;
  }

  /**
   * Create a dashed outline overlay around an element with delta arrow.
   * Used for MISALIGNMENT_VIOLATION — shows distance from target.
   */
  function _makeAlignmentOverlay(elementId, delta_mm, color, opacity, threshold_mm) {
    const bbox = _getElementBBox(elementId);
    if (!bbox) return null;
    const { center, size, obj } = bbox;

    // Build group: wireframe box + arrow showing direction of correction
    const group = new THREE.Group();

    // Wireframe box
    const geo = new THREE.BoxGeometry(
      size.x + 40,
      size.y + 40,
      size.z + 40
    );
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, linewidth: 2 });
    const lines = new THREE.LineSegments(edges, mat);
    group.add(lines);

    // Delta arrow — point in direction of correction (toward target)
    const arrowLen = Math.min(Math.abs(delta_mm), 300);
    const arrowDir = delta_mm >= 0 ? -1 : 1; // point toward target

    // Arrow pointing in X direction (primary alignment axis)
    const arrowOrigin = new THREE.Vector3(
      center.x + (arrowDir * (size.x / 2 + 20)),
      center.y,
      center.z
    );
    const arrowTip = new THREE.Vector3(
      center.x - (arrowDir * arrowLen),
      center.y,
      center.z
    );

    const dir = new THREE.Vector3().subVectors(arrowTip, arrowOrigin).normalize();
    const arrow = new THREE.ArrowHelper(dir, arrowOrigin, arrowLen, color, 20, 8);
    arrow.renderOrder = 999;
    group.add(arrow);

    // Label: show delta value in native units
    const labelStr = `${Math.abs(delta_mm).toFixed(0)}mm`;
    const label = _makeTextLabel(labelStr, color);
    label.position.set(
      center.x + (arrowDir * (size.x / 2 + 60)),
      center.y + size.y / 2 + 40,
      center.z
    );
    group.add(label);

    group.renderOrder = 999;
    group.userData.isOverlayGroup = true;
    return group;
  }

  /**
   * Create a sphere badge for code violation overlays.
   * Positioned above the element.
   */
  function _makeBadge(elementId, color, opacity, verdict) {
    const bbox = _getElementBBox(elementId);
    if (!bbox) return null;
    const { center, size } = bbox;

    const r = verdict === 'RED' ? 60 : verdict === 'AMBER' ? 45 : 30;
    const geo = new THREE.SphereGeometry(r, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat);

    // Position above element, visible from all angles
    mesh.position.set(center.x, center.y + size.y / 2 + r + 20, center.z);
    mesh.renderOrder = 1000;
    mesh.userData.isOverlayBadge = true;
    mesh.userData.overlayVerdict = verdict;
    mesh.userData.overlayType = 'badge';
    return mesh;
  }

  /**
   * Create a text label at a specific world position.
   */
  function _makeTextLabel(text, color = 0xffffff) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.roundRect(0, 0, 256, 64, 8);
    ctx.fill();
    ctx.font = 'bold 28px monospace';
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(120, 30, 1);
    sprite.renderOrder = 1001;
    return sprite;
  }

  /**
   * Create a "no lateral system" overlay — amber semi-transparent box
   * that wraps the entire structure bounds.
   */
  function _makeNoLateralOverlay(elements) {
    if (!elements || elements.length === 0) return null;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const el of elements) {
      const pos = el.position || {};
      const x = pos.x || 0, y = pos.y || 0, z = pos.z || 0;
      const w = 500, h = 500, d = 500;
      minX = Math.min(minX, x - w); maxX = Math.max(maxX, x + w);
      minY = Math.min(minY, y - h); maxY = Math.max(maxY, y + h);
      minZ = Math.min(minZ, z - d); maxZ = Math.max(maxZ, z + d);
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;

    const geo = new THREE.BoxGeometry(Math.max(sx, 100), Math.max(sy, 100), Math.max(sz, 100));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff9900,
      transparent: true,
      opacity: 0.08,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.renderOrder = 997;
    mesh.userData.isOverlayGroup = true;
    mesh.userData.overlayType = 'no_lateral_system';
    return mesh;
  }

  // ─── Tooltip management ─────────────────────────────────────────────────────

  function _createTooltipEl() {
    if (_tooltipEl) return _tooltipEl;
    const el = document.createElement('div');
    el.id = 'overlay-tooltip';
    el.style.cssText = `
      position: fixed;
      z-index: 99999;
      pointer-events: none;
      display: none;
      background: rgba(15,15,25,0.96);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12px;
      color: #e2e8f0;
      max-width: 320px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      backdrop-filter: blur(8px);
    `;
    document.body.appendChild(el);
    _tooltipEl = el;
    return el;
  }

  function _showTooltip(x, y, data) {
    const el = _createTooltipEl();
    const verdict = data.verdict || 'RED';
    const badgeColor = verdict === 'RED' ? '#ff4444' : verdict === 'AMBER' ? '#ff9900' : '#22cc66';
    const codeRef = data.code_reference
      ? `<div style="color:#94a3b8;font-size:10px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);padding-top:4px">${data.code_reference}</div>`
      : '';

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="width:10px;height:10px;border-radius:50%;background:${badgeColor};display:inline-block"></span>
        <span style="font-weight:700;color:${badgeColor}">${verdict}</span>
        <span style="color:#64748b;font-size:10px">${data.category?.toUpperCase()}</span>
      </div>
      <div style="color:#f1f5f9;margin-bottom:2px">${data.message || ''}</div>
      ${data.fix_suggestion ? `<div style="color:#86efac;font-size:11px;margin-top:4px">&#9654; ${data.fix_suggestion}</div>` : ''}
      ${codeRef}
    `;

    // Position: below cursor, flip if near edge
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let tx = x + 16, ty = y + 16;
    if (tx + 340 > vw) tx = x - 340;
    if (ty + 200 > vh) ty = y - 200;
    el.style.left = `${tx}px`;
    el.style.top = `${ty}px`;
    el.style.display = 'block';
  }

  function _hideTooltip() {
    if (_tooltipEl) _tooltipEl.style.display = 'none';
  }

  // ─── Build overlay meshes from descriptor ─────────────────────────────────

  function _buildMeshes(overlay) {
    const meshes = [];
    const id = overlay._uid || _uid();

    const color = COLOR[overlay.verdict] || COLOR.RED;
    const op = OPACITY[overlay.verdict] || OPACITY.RED;
    const opacity = overlay.opacity || op.solid;

    switch (overlay.type) {
      case 'clearance_vol': {
        // Volumetric conflict box between two elements
        const center = overlay.center || { x: 0, y: 0, z: 0 };
        const size = overlay.size || { x: 100, y: 100, z: 100 };
        const mesh = _makeSolidBox(center, size, color, opacity);
        if (mesh) {
          mesh.userData = { ...overlay, _uid: id, isOverlayMesh: true, overlayId: id };
          meshes.push(mesh);
        }
        break;
      }

      case 'alignment_off': {
        // Dashed outline + delta arrow
        if (overlay.element_id && overlay.delta_mm !== undefined) {
          const group = _makeAlignmentOverlay(
            overlay.element_id,
            overlay.delta_mm,
            color,
            opacity,
            overlay.threshold_mm
          );
          if (group) {
            group.userData = { ...overlay, _uid: id, isOverlayMesh: true, overlayId: id };
            meshes.push(group);
          }
        }
        break;
      }

      case 'code_violation':
      case 'missing_bearing':
      case 'unsupported_span':
      case 'unsupported_span_critical':
      case 'load_path_break': {
        // Wireframe box around element + badge
        if (overlay.element_id) {
          const wire = _makeWireframeBox(overlay.element_id, color, op.wireframe, 30);
          if (wire) {
            wire.userData = { ...overlay, _uid: id, isOverlayMesh: true, overlayId: id };
            meshes.push(wire);
          }
          const badge = _makeBadge(overlay.element_id, color, opacity, overlay.verdict);
          if (badge) {
            badge.userData = { ...overlay, _uid: id, isOverlayMesh: true, overlayId: id };
            meshes.push(badge);
          }
        }
        break;
      }

      case 'no_lateral_system': {
        // Full-structure amber box (no element_id — applies to entire model)
        const sceneEls = overlay._sceneElements || [];
        const mesh = _makeNoLateralOverlay(sceneEls);
        if (mesh) {
          mesh.userData = { ...overlay, _uid: id, isOverlayMesh: true, overlayId: id };
          meshes.push(mesh);
        }
        break;
      }

      case 'green_confirm': {
        // Brief green badge — auto-dismiss handled separately
        if (overlay.element_id) {
          const badge = _makeBadge(overlay.element_id, 0x22cc66, 0.3, 'GREEN');
          if (badge) {
            badge.userData = { ...overlay, _uid: id, isOverlayMesh: true, overlayId: id };
            meshes.push(badge);
          }
        }
        break;
      }
    }

    return meshes;
  }

  // ─── Main render function ───────────────────────────────────────────────────

  /**
   * Render overlays on the Three.js scene.
   * Called on every animate frame when overlays are active.
   *
   * @param {Array} overlays - Array of overlay descriptors from overlay-check service
   * @param {object} opts - { moduleProject, sceneElements }
   */
  function render(overlays, opts = {}) {
    if (!_isEnabled) return;

    const scene = _getScene();
    if (!scene) return;

    const { moduleProject, sceneElements = [] } = opts;

    // Ensure overlay group is in scene
    if (!scene.getObjectByName('compliance_overlays')) {
      scene.add(_ensureGroup());
    }

    // Build quick lookup for new overlays
    const newOverlayMap = new Map();
    overlays.forEach((ov, idx) => {
      const key = `${ov.type}:${ov.element_id || 'noid'}:${ov.category}`;
      newOverlayMap.set(key, { ...ov, _idx: idx, _sceneElements: sceneElements });
    });

    // Remove overlays no longer present
    const toRemove = [];
    _overlays.forEach((data, key) => {
      if (!newOverlayMap.has(key)) {
        // Remove meshes from scene
        if (data.meshes) {
          for (const m of data.meshes) {
            if (m.parent) m.parent.remove(m);
          }
        }
        if (data.timeoutId) clearTimeout(data.timeoutId);
        toRemove.push(key);
      }
    });
    toRemove.forEach(k => _overlays.delete(k));

    // Add/update overlays
    newOverlayMap.forEach((ov, key) => {
      if (_overlays.has(key)) {
        // Already rendered — update if position changed
        return;
      }

      const meshes = _buildMeshes(ov);
      for (const m of meshes) {
        _ensureGroup().add(m);
      }

      let timeoutId = null;
      if (ov.type === 'green_confirm' && ov.auto_dismiss_ms) {
        timeoutId = setTimeout(() => {
          for (const m of meshes) {
            if (m.parent) m.parent.remove(m);
          }
          _overlays.delete(key);
        }, ov.auto_dismiss_ms);
      }

      _overlays.set(key, {
        meshes,
        timeoutId,
        data: ov,
        renderedAt: Date.now(),
      });
    });

    _lastOverlays = overlays;
  }

  // ─── Update overlay positions (for dragging elements) ──────────────────────
  /**
   * Refresh badge positions on every frame — badges follow their elements.
   * Call from animate loop after scene renders.
   */
  function updateBadgePositions() {
    _overlays.forEach((data) => {
      if (!data.data.element_id) return;
      for (const mesh of data.meshes) {
        if (mesh.userData?.overlayType === 'badge') {
          const bbox = _getElementBBox(data.data.element_id);
          if (bbox) {
            const { center, size } = bbox;
            mesh.position.set(center.x, center.y + size.y / 2 + mesh.geometry.parameters?.radius + 20, center.z);
          }
        }
        // Update alignment labels too
        if (mesh.isGroup) {
          mesh.children.forEach(child => {
            if (child.isSprite) {
              const bbox = _getElementBBox(data.data.element_id);
              if (bbox) {
                const { center, size } = bbox;
                child.position.set(
                  center.x + (data.data.delta_mm >= 0 ? (size.x / 2 + 60) : -(size.x / 2 + 60)),
                  center.y + size.y / 2 + 40,
                  center.z
                );
              }
            }
          });
        }
      }
    });
  }

  // ─── Clear all overlays ─────────────────────────────────────────────────────
  function clear() {
    _overlays.forEach((data) => {
      if (data.meshes) {
        for (const m of data.meshes) {
          if (m.parent) m.parent.remove(m);
        }
      }
      if (data.timeoutId) clearTimeout(data.timeoutId);
    });
    _overlays.clear();
    _lastOverlays = [];

    const scene = _getScene();
    if (scene) {
      const group = scene.getObjectByName('compliance_overlays');
      if (group) scene.remove(group);
    }
  }

  // ─── Enable / disable ───────────────────────────────────────────────────────
  function enable() { _isEnabled = true; }
  function disable() {
    _isEnabled = false;
    clear();
  }
  function isEnabled() { return _isEnabled; }

  // ─── Stats for UI ───────────────────────────────────────────────────────────
  function getStats() {
    const stats = { RED: 0, AMBER: 0, GREEN: 0 };
    _overlays.forEach((data) => {
      const v = data.data?.verdict;
      if (v) stats[v] = (stats[v] || 0) + 1;
    });
    return stats;
  }

  // ─── Hover detection ───────────────────────────────────────────────────────
  function onMouseMove(event) {
    if (!_isEnabled || _overlays.size === 0) return;

    const scene = _getScene();
    if (!scene) return;

    // Simple raycasting against overlay meshes
    // Use the renderer domElement for picking
    const renderer = window._vpRenderer3d || window.renderer3d;
    if (!renderer) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const camera = window._vpCam3d || window.cam3d;
    if (!camera) return;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const meshList = [];
    _overlays.forEach((data) => {
      if (data.meshes) meshList.push(...data.meshes);
    });

    const hits = raycaster.intersectObjects(meshList, true);
    if (hits.length > 0) {
      // Find which overlay group this belongs to
      let hitMesh = hits[0].object;
      while (hitMesh.parent && !hitMesh.userData?.overlayId) {
        hitMesh = hitMesh.parent;
      }
      if (hitMesh.userData?.overlayId) {
        const overlayId = hitMesh.userData.overlayId;
        if (_hoveredOverlayId !== overlayId) {
          _hoveredOverlayId = overlayId;
          // Find the overlay data
          _overlays.forEach((data, key) => {
            const firstMesh = data.meshes?.[0];
            if (firstMesh?.userData?.overlayId === overlayId) {
              _showTooltip(event.clientX, event.clientY, data.data);
            }
          });
        }
        return;
      }
    }

    _hoveredOverlayId = null;
    _hideTooltip();
  }

  function onMouseLeave() {
    _hoveredOverlayId = null;
    _hideTooltip();
  }

  // ─── Fetch overlays from API ─────────────────────────────────────────────────
  async function fetchAndRender(projectId, moduleProject) {
    try {
      const res = await fetch('/api/overlay-check/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          moduleProject,
          elements: [], // empty → just get current state from DB
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      render(data.overlays || [], { moduleProject, sceneElements: [] });
    } catch (err) {
      console.warn('[OverlayService] fetchAndRender failed:', err.message);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  return {
    render,
    clear,
    enable,
    disable,
    isEnabled,
    getStats,
    updateBadgePositions,
    fetchAndRender,
    onMouseMove,
    onMouseLeave,
  };
})();

window.OverlayService = OverlayService;

// ─── Default disable — enabled on structural modal open ───────────────────────
OverlayService.disable();

// ─── Wire to app.js animate loop ──────────────────────────────────────────────
// The animate loop in app.js calls this every frame to update badge positions.
window.__updateOverlayBadges = function () {
  OverlayService.updateBadgePositions();
};

// ─── Hover event wiring (called from app.js init) ─────────────────────────────
document.addEventListener('mousemove', (e) => OverlayService.onMouseMove(e));
document.addEventListener('mouseleave', () => OverlayService.onMouseLeave());