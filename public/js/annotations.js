/**
 * Atlantist Phase 4.2 — Annotations: Dimensions, Area Tags, Text, Keynotes, Hatching
 * Owns: Annotation mesh rendering, user interaction, DB sync.
 * Does NOT own: DAG recalculation, project/element state management.
 */
import * as THREE from 'three';

// ─── Dimension Line Builder ───────────────────────────────────────────────────

/**
 * Builds a linear dimension line between two 2D points, with arrow terminators.
 * Returns a THREE.Group containing lines + text sprite.
 * Uses CanvasTexture for crisp text sprites.
 */
export function buildLinearDim(start2d, end2d, offsetDir, offsetDist, labelText, style = {}) {
  const group = new THREE.Group();
  const color = style.color ?? 0xffffff;
  const fontSize = style.fontSize ?? 11;

  const dx = end2d.x - start2d.x;
  const dy = end2d.y - start2d.y;
  const baseLen = Math.sqrt(dx * dx + dy * dy);
  if (baseLen < 0.001) return group;

  const angle = Math.atan2(dy, dx);
  const perpAngle = angle + Math.PI / 2;

  // Extend start/end by 0.3 units for arrow shoulders
  const shoulder = 0.3;
  const ext = 0.15;
  const p1 = { x: start2d.x - Math.cos(angle) * ext, y: start2d.y - Math.sin(angle) * ext };
  const p2 = { x: end2d.x + Math.cos(angle) * ext, y: end2d.y + Math.sin(angle) * ext };

  // Offset the dimension line (parallel, away from element)
  const ox = Math.cos(perpAngle) * offsetDist;
  const oy = Math.sin(perpAngle) * offsetDist;
  const mp = { x: (p1.x + p2.x) / 2 + ox, y: (p1.y + p2.y) / 2 + oy };

  const mat = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  // Main dimension line
  const mainPts = [new THREE.Vector3(p1.x + ox, p1.y + oy, 0.01), new THREE.Vector3(p2.x + ox, p2.y + oy, 0.01)];
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(mainPts), mat));

  // Extension lines (perpendicular from element to dim line)
  const extLen = 0.15;
  const extLines = [
    [start2d, { x: p1.x + ox, y: p1.y + oy }],
    [end2d,   { x: p2.x + ox, y: p2.y + oy }],
  ];
  for (const [a, b] of extLines) {
    const pts = [new THREE.Vector3(a.x, a.y, 0.01), new THREE.Vector3(b.x, b.y, 0.01)];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, linewidth: 1, opacity: 0.6, transparent: true })));
  }

  // Arrowheads at each end
  const arrowSize = 0.18;
  const dirs = [
    { x: -Math.cos(angle), y: -Math.sin(angle) },  // arrow at start
    { x:  Math.cos(angle), y:  Math.sin(angle) },  // arrow at end
  ];
  const arrowBases = [
    { x: p1.x + ox, y: p1.y + oy },
    { x: p2.x + ox, y: p2.y + oy },
  ];
  for (let i = 0; i < 2; i++) {
    const bx = arrowBases[i].x, by = arrowBases[i].y;
    const a = dirs[i].x, b = dirs[i].y;
    const pts = [
      new THREE.Vector3(bx, by, 0.02),
      new THREE.Vector3(bx + a * arrowSize + b * arrowSize * 0.4, by + b * arrowSize - a * arrowSize * 0.4, 0.02),
      new THREE.Vector3(bx + a * arrowSize - b * arrowSize * 0.4, by + b * arrowSize + a * arrowSize * 0.4, 0.02),
      new THREE.Vector3(bx, by, 0.02),
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }

  // Label (text sprite) centered on dimension line
  const sprite = makeTextSprite(labelText, { color, fontSize });
  sprite.position.set(mp.x, mp.y, 0.03);
  group.add(sprite);

  return group;
}

// ─── Text Sprite Builder ───────────────────────────────────────────────────────

export function makeTextSprite(text, style = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = style.fontSize ?? 12;
  const bold = style.bold ?? false;
  const color = style.color ?? '#ffffff';
  const bgColor = style.backgroundColor ?? null;

  ctx.font = `${bold ? 'bold ' : ''}${fontSize}px monospace`;
  const metrics = ctx.measureText(text);
  const tw = Math.max(metrics.width + 16, 60);
  const th = fontSize + 14;
  canvas.width = tw;
  canvas.height = th;

  ctx.clearRect(0, 0, tw, th);
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, tw, th);
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, tw / 2, th / 2);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(tw * 0.05, th * 0.05, 1);
  return sprite;
}

// ─── Area Tag Builder ─────────────────────────────────────────────────────────

/**
 * Room area tag: rectangle with room name + area.
 * position2d: {x, y} center of tag in world 2D coords.
 * roomData: { name, area_sqm } or similar.
 */
export function buildAreaTag(position2d, roomData, style = {}) {
  const group = new THREE.Group();
  const w = style.width ?? 1.6;
  const h = style.height ?? 0.6;
  const tagColor = style.tagColor ?? 0x1a4a7a;
  const textColor = style.textColor ?? 0xffffff;
  const fontSize = style.fontSize ?? 10;

  const name = roomData?.name ?? roomData?.room_name ?? 'ROOM';
  const area = roomData?.area_sqm ?? roomData?.area ?? 0;
  const label = `${name.toUpperCase()} / ${area.toFixed(1)} m²`;

  // Background rectangle (dark tag body)
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(w / 2, h / 2);
  shape.lineTo(-w / 2, h / 2);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({ color: tagColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(position2d.x, position2d.y, 0.05);
  mesh.rotation.z = 0;
  group.add(mesh);

  // Tag border line
  const borderPts = [
    new THREE.Vector3(-w / 2, -h / 2, 0.06),
    new THREE.Vector3(w / 2, -h / 2, 0.06),
    new THREE.Vector3(w / 2, h / 2, 0.06),
    new THREE.Vector3(-w / 2, h / 2, 0.06),
    new THREE.Vector3(-w / 2, -h / 2, 0.06),
  ];
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPts), new THREE.LineBasicMaterial({ color: 0x3a7abf })));

  // Label sprite
  const sprite = makeTextSprite(label, { color: intToHex(textColor), fontSize, bold: true });
  sprite.position.set(position2d.x, position2d.y, 0.07);
  group.add(sprite);

  return group;
}

// ─── Keynote Marker Builder ───────────────────────────────────────────────────

/**
 * Builds a keynote number badge at a 3D position.
 * Shows keynote code (e.g. "1.00") with a circle marker.
 */
export function buildKeynoteMarker(position3d, code, style = {}) {
  const group = new THREE.Group();
  const fontSize = style.fontSize ?? 10;
  const markerColor = style.markerColor ?? 0xffcc44;
  const textColor = style.textColor ?? '#000000';

  // Circle marker
  const geo = new THREE.CircleGeometry(0.15, 16);
  const mat = new THREE.MeshBasicMaterial({ color: markerColor });
  const circle = new THREE.Mesh(geo, mat);
  circle.position.copy(position3d);
  group.add(circle);

  // Text label
  const sprite = makeTextSprite(code, { color: textColor, fontSize, backgroundColor: null });
  sprite.position.copy(position3d);
  sprite.position.z += 0.1;
  sprite.scale.set(0.8, 0.3, 1);
  group.add(sprite);

  return group;
}

// ─── Symbol Builder ───────────────────────────────────────────────────────────

/**
 * Pre-defined symbols: north arrow, datum marker, section cut.
 * type: 'north_arrow' | 'datum' | 'section_cut'
 */
export function buildSymbol(type, position2d, rotation = 0) {
  const group = new THREE.Group();
  const pts = [];

  if (type === 'north_arrow') {
    // Arrow pointing north (+Y)
    const cx = position2d.x, cy = position2d.y;
    pts.push(new THREE.Vector3(cx, cy - 0.4, 0.05));
    pts.push(new THREE.Vector3(cx - 0.15, cy + 0.1, 0.05));
    pts.push(new THREE.Vector3(cx, cy + 0.4, 0.05));
    pts.push(new THREE.Vector3(cx + 0.15, cy + 0.1, 0.05));
    pts.push(new THREE.Vector3(cx, cy - 0.4, 0.05));
    const label = makeTextSprite('N', { color: '#ffffff', fontSize: 14, bold: true });
    label.position.set(cx, cy + 0.55, 0.06);
    group.add(label);
  } else if (type === 'section_cut') {
    const cx = position2d.x, cy = position2d.y;
    // Thick line with cross marks at ends
    pts.push(new THREE.Vector3(cx - 0.6, cy, 0.05), new THREE.Vector3(cx + 0.6, cy, 0.05));
    pts.push(new THREE.Vector3(cx - 0.6, cy - 0.15, 0.05), new THREE.Vector3(cx - 0.6, cy + 0.15, 0.05));
    pts.push(new THREE.Vector3(cx + 0.6, cy - 0.15, 0.05), new THREE.Vector3(cx + 0.6, cy + 0.15, 0.05));
  } else if (type === 'datum') {
    const cx = position2d.x, cy = position2d.y;
    pts.push(new THREE.Vector3(cx, cy - 0.3, 0.05), new THREE.Vector3(cx, cy + 0.3, 0.05));
    const label = makeTextSprite('DATUM', { color: '#aaaaaa', fontSize: 9 });
    label.position.set(cx + 0.35, cy, 0.06);
    group.add(label);
  }

  if (pts.length) {
    const mat = new THREE.LineBasicMaterial({ color: 0xcccccc });
    const lines = [];
    for (let i = 0; i < pts.length; i += 2) {
      lines.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pts[i], pts[i + 1]]), mat));
    }
    lines.forEach(l => group.add(l));
  }

  return group;
}

// ─── Hatching / Filled Region Builder ─────────────────────────────────────────

/**
 * Builds a hatching fill for section cuts.
 * type: 'solid' | 'diagonal' | 'cross' | 'brick'
 * Returns a THREE.Group with line geometry.
 */
export function buildHatchedRegion(bounds2d, type, style = {}) {
  const group = new THREE.Group();
  const spacing = style.spacing ?? 0.05;
  const angleDeg = style.angleDeg ?? 45;
  const lineColor = style.color ?? 0x555555;
  const { minX, maxX, minY, maxY } = bounds2d;
  const mat = new THREE.LineBasicMaterial({ color: lineColor, opacity: 0.6, transparent: true });

  if (type === 'solid') {
    // Solid fill — many small rectangles
    const step = spacing;
    for (let x = minX; x < maxX; x += step) {
      for (let y = minY; y < maxY; y += step) {
        const pts = [
          new THREE.Vector3(x, y, 0.001), new THREE.Vector3(x + step * 0.9, y, 0.001),
          new THREE.Vector3(x + step * 0.9, y + step * 0.9, 0.001), new THREE.Vector3(x, y + step * 0.9, 0.001),
          new THREE.Vector3(x, y, 0.001),
        ];
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
      }
    }
  } else if (type === 'diagonal' || type === 'brick') {
    // Diagonal hatch lines
    const angleRad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
    // Extend bounds for diagonal clipping
    const ext = Math.max(maxX - minX, maxY - minY) * 2;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    for (let d = -ext; d < ext; d += spacing) {
      const x1 = minX - ext, y1 = cy + (d - (minX - ext - cx) * sin) / cos;
      const x2 = maxX + ext, y2 = cy + (d - (maxX + ext - cx) * sin) / cos;
      const p1 = new THREE.Vector3(x1, y1, 0.001);
      const p2 = new THREE.Vector3(x2, y2, 0.001);
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]), mat));

      if (type === 'brick' || type === 'diagonal') {
        const p3 = new THREE.Vector3(x1, y1 + (maxY - minY), 0.001);
        const p4 = new THREE.Vector3(x2, y2 - (maxY - minY), 0.001);
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p3, p4]), mat));
      }
    }
  } else if (type === 'cross') {
    for (let x = minX; x < maxX; x += spacing) {
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, minY, 0.001), new THREE.Vector3(x, maxY, 0.001)]), mat));
    }
    for (let y = minY; y < maxY; y += spacing) {
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(minX, y, 0.001), new THREE.Vector3(maxX, y, 0.001)]), mat));
    }
  } else if (type === 'dot') {
    // Dot hatch: small + marks
    for (let x = minX; x < maxX; x += spacing) {
      for (let y = minY; y < maxY; y += spacing) {
        const s = spacing * 0.15;
        const pts = [
          new THREE.Vector3(x - s, y, 0.001), new THREE.Vector3(x + s, y, 0.001),
          new THREE.Vector3(x, y - s, 0.001), new THREE.Vector3(x, y + s, 0.001),
        ];
        for (let i = 0; i < pts.length; i += 2) {
          group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pts[i], pts[i + 1]]), mat));
        }
      }
    }
  }

  // Boundary outline
  const borderPts = [
    new THREE.Vector3(minX, minY, 0.002), new THREE.Vector3(maxX, minY, 0.002),
    new THREE.Vector3(maxX, maxY, 0.002), new THREE.Vector3(minX, maxY, 0.002),
    new THREE.Vector3(minX, minY, 0.002),
  ];
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPts), new THREE.LineBasicMaterial({ color: lineColor })));

  return group;
}

// ─── Elevation Dimension ──────────────────────────────────────────────────────

/**
 * Vertical elevation dimension — shown in elevation/section views.
 * startY / endY are world elevations (Y axis in 3D).
 */
export function buildElevationDim(startY, endY, xPos, levelElevation, style = {}) {
  const group = new THREE.Group();
  const color = style.color ?? 0xffffff;
  const fontSize = style.fontSize ?? 11;

  const h = Math.abs(endY - startY);
  const label = `${h.toFixed(3)}m`;

  const mat = new THREE.LineBasicMaterial({ color });
  const half = 0.1; // arrow shoulder half

  // Main vertical line
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xPos, startY, 0.05), new THREE.Vector3(xPos, endY, 0.05)]),
    mat
  ));

  // Extension line to wall
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xPos + 0.15, startY, 0.05), new THREE.Vector3(xPos, startY, 0.05)]),
    new THREE.LineBasicMaterial({ color, opacity: 0.5, transparent: true })
  ));
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xPos + 0.15, endY, 0.05), new THREE.Vector3(xPos, endY, 0.05)]),
    new THREE.LineBasicMaterial({ color, opacity: 0.5, transparent: true })
  ));

  // Top arrow
  const arrowLen = 0.2;
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(xPos, endY, 0.06),
      new THREE.Vector3(xPos - arrowLen * 0.5, endY - arrowLen * 0.5, 0.06),
      new THREE.Vector3(xPos + arrowLen * 0.5, endY - arrowLen * 0.5, 0.06),
      new THREE.Vector3(xPos, endY, 0.06),
    ]),
    mat
  ));

  // Bottom arrow
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(xPos, startY, 0.06),
      new THREE.Vector3(xPos - arrowLen * 0.5, startY + arrowLen * 0.5, 0.06),
      new THREE.Vector3(xPos + arrowLen * 0.5, startY + arrowLen * 0.5, 0.06),
      new THREE.Vector3(xPos, startY, 0.06),
    ]),
    mat
  ));

  // Label
  const sprite = makeTextSprite(label, { color: intToHex(color), fontSize });
  sprite.position.set(xPos + 0.3, (startY + endY) / 2, 0.07);
  group.add(sprite);

  return group;
}

// ─── Auto-Dimension for Selected Wall ─────────────────────────────────────────

/**
 * Creates a linear dimension showing the wall's length, positioned on the side
 * away from the wall center. Returns a THREE.Group.
 */
export function buildWallAutoDimension(element, side = 1, style = {}) {
  const params = typeof element.parameters === 'string' ? JSON.parse(element.parameters) : (element.parameters || {});
  const computed = typeof element.computed === 'string' ? JSON.parse(element.computed) : (element.computed || {});

  const sx = parseFloat(params.startCoord?.x || 0);
  const sy = parseFloat(params.startCoord?.y || 0);
  const ex = parseFloat(params.endCoord?.x || sx + 5);
  const ey = parseFloat(params.endCoord?.y || sy);

  const length = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) || 1;
  const angle = Math.atan2(ey - sy, ex - sx);
  const perpAngle = angle + Math.PI / 2;

  const offsetDist = 0.6 * side;
  const ox = Math.cos(perpAngle) * offsetDist;
  const oy = Math.sin(perpAngle) * offsetDist;

  // Midpoint of wall in 2D
  const mid = { x: (sx + ex) / 2, y: (sy + ey) / 2 };

  const dimColor = style.color ?? 0xffff00;
  return buildLinearDim(
    { x: sx, y: sy },
    { x: ex, y: ey },
    { x: Math.cos(perpAngle), y: Math.sin(perpAngle) },
    offsetDist,
    `${length.toFixed(3)} m`,
    { color: dimColor, fontSize: 12 }
  );
}

// ─── Annotation Sync ──────────────────────────────────────────────────────────

/**
 * Clears the annotation overlay group and rebuilds all annotation meshes.
 * Called from rebuildScene() and when annotations change.
 */
export function syncAnnotationOverlays(annotations, scene3d, scenePlan, sceneSection, activeView) {
  const group3d = scene3d.getObjectByProperty('name', 'annotations_3d');
  const groupPlan = scenePlan.getObjectByProperty('name', 'annotations_plan');
  const groupSection = sceneSection.getObjectByProperty('name', 'annotations_section');

  if (!group3d || !groupPlan || !groupSection) return;

  // Clear all annotation groups
  for (const g of [group3d, groupPlan, groupSection]) {
    while (g.children.length) g.remove(g.children[0]);
  }

  const dimGroup = activeView === 'plan' ? groupPlan : activeView === 'section' ? groupSection : group3d;

  for (const ann of annotations) {
    if (!ann.visible) continue;
    const data = typeof ann.data === 'string' ? JSON.parse(ann.data) : (ann.data || {});
    const style = typeof ann.style === 'string' ? JSON.parse(ann.style) : (ann.style || {});
    const pos2d = ann.position_2d || (data.position2d ? JSON.parse(data.position2d) : null);
    const pos3d = ann.position_3d || (data.position3d ? JSON.parse(data.position3d) : null);

    try {
      let mesh;

      if (ann.type === 'linear_dim' || ann.type === 'aligned_dim') {
        const start = data.start || { x: 0, y: 0 };
        const end = data.end || { x: 1, y: 0 };
        const offsetDir = data.offsetDir || { x: 0, y: 1 };
        const offsetDist = data.offsetDist ?? 0.5;
        const label = data.label || `${dist2d(start, end).toFixed(3)} m`;
        mesh = buildLinearDim(start, end, offsetDir, offsetDist, label, style);
        dimGroup.add(mesh);

      } else if (ann.type === 'elevation_dim') {
        const startY = data.startY ?? 0;
        const endY = data.endY ?? 3;
        const xPos = pos2d?.x ?? 0;
        const levelElev = data.levelElevation ?? 0;
        mesh = buildElevationDim(startY, endY, xPos, levelElev, style);
        groupSection.add(mesh);

      } else if (ann.type === 'area_tag') {
        if (pos2d) {
          mesh = buildAreaTag(pos2d, data.room || data, style);
          groupPlan.add(mesh);
          group3d.add(mesh.clone());
        }

      } else if (ann.type === 'text') {
        if (pos2d) {
          const sprite = makeTextSprite(data.text || 'Text', style);
          sprite.position.set(pos2d.x, pos2d.y, 0.05);
          mesh = new THREE.Group();
          mesh.add(sprite);
          dimGroup.add(mesh);
        }

      } else if (ann.type === 'keynote') {
        if (pos2d || pos3d) {
          const code = data.code || ann.data?.keynote_code || '?';
          const p = pos3d ? new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z) : new THREE.Vector3(pos2d.x, pos2d.y, 0.05);
          mesh = buildKeynoteMarker(p, code, style);
          group3d.add(mesh);
          if (pos2d) {
            const planMesh = buildKeynoteMarker(new THREE.Vector3(pos2d.x, pos2d.y, 0.05), code, style);
            groupPlan.add(planMesh);
          }
        }

      } else if (ann.type === 'symbol') {
        if (pos2d) {
          mesh = buildSymbol(data.symbolType || 'north_arrow', pos2d, data.rotation || 0);
          dimGroup.add(mesh);
        }

      } else if (ann.type === 'filled_region') {
        const bounds = data.bounds || { minX: -1, maxX: 1, minY: -1, maxY: 1 };
        const hatchType = data.hatchType || 'diagonal';
        mesh = buildHatchedRegion(bounds, hatchType, style);
        dimGroup.add(mesh);
      }
    } catch (err) {
      console.warn('[annotations] Failed to build mesh:', ann.type, err.message);
    }
  }
}

// ─── Manual Dimension Placement ───────────────────────────────────────────────

/**
 * Returns the click handler for manual dimension placement.
 * Canvas should call: dimClickHandler(event, camera, canvas, renderer)
 */
export function makeDimClickHandler(state, annotations, api) {
  return async function handleDimClick(event, camera, canvas, renderer) {
    const rect = canvas.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(mx, my), camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const pt = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, pt);
    if (!pt) return;

    if (!state.dimStartPoint) {
      state.dimStartPoint = { x: pt.x, y: pt.y, z: pt.z };
      toast('Click second point to place dimension', 'info');
    } else {
      const start = state.dimStartPoint;
      const end = { x: pt.x, y: pt.y };
      const dx = end.x - start.x, dy = end.y - start.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const perpAngle = angle + Math.PI / 2;

      try {
        const projectId = window.currentProjectId;
        if (projectId) {
          await api('POST', '/api/annotations', {
            projectId,
            type: 'linear_dim',
            data: {
              start: { x: parseFloat(start.x.toFixed(3)), y: parseFloat(start.y.toFixed(3)) },
              end: { x: parseFloat(end.x.toFixed(3)), y: parseFloat(end.y.toFixed(3)) },
              offsetDir: { x: Math.cos(perpAngle), y: Math.sin(perpAngle) },
              offsetDist: 0.5,
              label: `${length.toFixed(3)} m`,
            },
            position2d: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
          });
        }
      } catch (err) {
        console.warn('[annotations] Failed to save dim:', err.message);
      }

      state.dimStartPoint = null;
      toast('Dimension placed', 'success');
    }
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dist2d(a, b) {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

function intToHex(color) {
  if (typeof color === 'string') return color;
  return '#' + color.toString(16).padStart(6, '0');
}

// Toast helper (imported from app.js context)
let _toastFn = null;
export function setToastFn(fn) { _toastFn = fn; }
function toast(msg, type) { if (_toastFn) _toastFn(msg, type); }