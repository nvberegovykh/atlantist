/**
 * DXF/DWG export for CAD engineers.
 * Converts Atlantist BIM DAG elements to ASCII DXF R14/2000 format.
 * Does NOT own: element query, HTTP routing, WebSocket.
 */
const DB_HEADER = 'AC1024'; // AutoCAD 2010 (DXF 2010 — supports LWPOLYLINE, XDATA)
const DB_UNITS = 1; // 1 = Unitless, but we write real-world coordinates (ft)

/**
 * @param {Array} walls  - wall elements with computed.start/end + parameters.height
 * @param {Array} columns - column elements with computed + parameters
 * @param {Array} familyInstances - doors and windows (host_face_u normalized 0-1)
 * @param {Array} levels - level records with elevation
 * @param {Array} grids  - grid lines {axis, position, label}
 * @param {Object} opts  - { viewMode: '2d'|'3d', levelId: null|'current', units: 'ft' }
 * @returns {string} ASCII DXF file content
 */
function generateDXF(walls, columns, familyInstances, levels, grids, opts = {}) {
  const { viewMode = '2d', levelId = null } = opts;
  const lines = [];

  const push = (...args) => lines.push(args.join('\n'));

  // ── HEADER ──────────────────────────────────────────────────────────────────
  push('0', 'SECTION', '2', 'HEADER');
  push('9', `$ACADVER`);
  push('1', DB_HEADER);
  push('9', `$INSUNITS`);
  push('70', String(DB_UNITS));
  push('9', `$EXTMIN`);
  push('10', '0.0');
  push('20', '0.0');
  push('30', '0.0');
  push('9', `$EXTMAX`);
  push('10', '1000.0');
  push('20', '1000.0');
  push('30', '100.0');
  push('9', `$LIMMIN`);
  push('10', '0.0');
  push('20', '0.0');
  push('9', `$LIMMAX`);
  push('10', '1000.0');
  push('20', '1000.0');
  push('0', 'ENDSEC');

  // ── TABLES ──────────────────────────────────────────────────────────────────
  push('0', 'SECTION', '2', 'TABLES');

  // Layer table
  push('0', 'TABLE', '2', 'LAYER', '70', '13');
  const layers = [
    { name: '0', color: 7 },
    { name: 'A-WALL', color: 2 },
    { name: 'A-WALL-OPEN', color: 3 },
    { name: 'A-GLAZ', color: 5 },
    { name: 'A-SUPORT', color: 1 },
    { name: 'A-FLOR', color: 3 },
    { name: 'A-STR', color: 1 },
    { name: 'A-DIMS', color: 4 },
    { name: 'A-ANNO', color: 7 },
    { name: 'A-GRID', color: 8 },
    { name: 'A-TEXT', color: 7 },
    { name: 'A-LEVEL', color: 3 },
  ];
  for (const l of layers) {
    push('0', 'LAYER', '2', l.name, '70', '0', '62', String(l.color), '6', 'CONTINUOUS');
  }
  push('0', 'ENDTAB');

  // Linetype table (solid)
  push('0', 'TABLE', '2', 'LTYPE', '70', '1');
  push('0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0');
  push('0', 'ENDTAB');

  // Text style table
  push('0', 'TABLE', '2', 'STYLE', '70', '2');
  push('0', 'STYLE', '2', 'STANDARD', '70', '0', '71', '0', '40', '0.0', '41', '1.0', '42', '1.0', '3', 'txt', '2', '');
  push('0', 'STYLE', '2', 'ROMANS', '70', '0', '71', '0', '40', '0.0', '41', '1.0', '42', '1.0', '3', 'romans.shx', '2', '');
  push('0', 'ENDTAB');

  // Dimension style table
  push('0', 'TABLE', '2', 'DIMSTYLE', '70', '1');
  push('0', 'DIMSTYLE', '2', 'ATLANTIST', '70', '0');
  push('70', '0'); push('71', '0'); push('72', '0'); push('73', '0'); push('74', '0');
  push('75', '0'); push('76', '0'); push('77', '0'); push('78', '0');
  push('40', '0.0625'); // 3/4" text height in inches → 0.0625 ft
  push('41', '0.025'); // arrow size
  push('42', '0.0'); push('43', '0.0'); push('44', '0.0'); push('45', '0.0'); push('46', '0.0');
  push('47', '0.0'); push('48', '0.0');
  push('140', '0.0625'); push('141', '0.025'); push('142', '0.0'); push('143', '1.0');
  push('144', '1.0'); push('145', '0.0'); push('146', '1.0');
  push('147', '0.0625'); push('148', '0.0'); push('149', '0.0');
  push('3', 'STANDARD'); push('4', ''); push('5', '');
  push('0', 'ENDTAB');

  push('0', 'ENDSEC');

  // ── BLOCKS (doors + windows as block inserts) ───────────────────────────────
  push('0', 'SECTION', '2', 'BLOCKS');
  writeDoorBlock(push);
  writeWindowBlock(push);
  push('0', 'ENDSEC');

  // ── ENTITIES ────────────────────────────────────────────────────────────────
  push('0', 'SECTION', '2', 'ENTITIES');

  // Walls as LWPOLYLINE (closed, 2D plan profile)
  for (const wall of walls) {
    const p = wall.parameters || {};
    const c = wall.computed || {};
    if (!c.start || !c.end) continue;

    const xs = parseFloat(c.start.x || c.start[0]);
    const ys = parseFloat(c.start.y || c.start[1]);
    const zs = parseFloat(c.start.z || c.start[2] || 0);
    const xe = parseFloat(c.end.x || c.end[0]);
    const ye = parseFloat(c.end.y || c.end[1]);
    const ze = parseFloat(c.end.z || c.end[2] || 0);

    const height = parseFloat(p.height || 10); // feet
    const thickness = parseFloat(p.thickness || 0.5); // feet

    if (viewMode === '2d') {
      // 2D plan: draw wall centerline + elevation label
      writeLwpolyline2D(push, [
        [xs, ys, zs],
        [xe, ye, ze],
      ], 'A-WALL', 0);

      // Wall label at midpoint
      const mx = (xs + xe) / 2, my = (ys + ye) / 2;
      writeText(push, `${wall.type_name || 'Wall'} H=${height}'`, mx, my, 0.04, 'A-TEXT');
    } else {
      // 3D: wall as 3D polyline (lower face + upper face)
      write3DWall(push, xs, ys, zs, xe, ye, ze, height, thickness, 'A-WALL');
    }
  }

  // Columns as CIRCLE or LWPOLYLINE
  for (const col of columns) {
    const c = col.computed || {};
    const p = col.parameters || {};
    if (!c.position) continue;

    const px = parseFloat(c.position.x || c.position[0] || 0);
    const py = parseFloat(c.position.y || c.position[1] || 0);
    const pz = parseFloat(c.position.z || c.position[2] || 0);
    const dia = parseFloat(p.diameter || p.width || 1);
    const height = parseFloat(p.height || 10);

    if (viewMode === '2d') {
      writeCircle(push, px, py, pz, dia / 2, 'A-SUPORT');
      writeText(push, col.type_name || 'Col', px + 0.5, py + 0.5, 0.04, 'A-TEXT');
    } else {
      write3DColumn(push, px, py, pz, dia / 2, height, 'A-SUPORT');
    }
  }

  // Family instances (doors + windows) as BLOCK INSERT
  for (const fi of familyInstances) {
    const type = fi.family_type || fi.type;
    if (!fi.host_face_u && fi.host_element_id) continue;

    // Look up host wall to get position along it
    const hostWall = walls.find(w => w.id === fi.host_element_id);
    if (!hostWall || !hostWall.computed?.start || !hostWall.computed?.end) continue;

    const ws = hostWall.computed.start, we = hostWall.computed.end;
    const wsx = parseFloat(ws.x || ws[0]), wsy = parseFloat(ws.y || ws[1]);
    const wex = parseFloat(we.x || we[0]), wey = parseFloat(we.y || we[1]);
    const t = parseFloat(fi.host_face_u || 0);
    const fx = wsx + (wex - wsx) * t;
    const fy = wsy + (wey - wsy) * t;
    const p = fi.parameters || {};
    const fz = parseFloat(fi.floor_elevation || 0);

    if (type === 'door') {
      writeBlockInsert(push, 'DOOR_3X7', fx, fy, fz, 0, fi.id || '', 'A-WALL-OPEN');
    } else {
      writeBlockInsert(push, 'WINDOW_4X4', fx, fy, fz, 0, fi.id || '', 'A-GLAZ');
    }
  }

  // Grids as LINE + TEXT label
  for (const g of grids) {
    const axis = g.axis || 'X';
    const pos = parseFloat(g.position || 0);
    if (axis === 'X') {
      // Vertical grid line
      writeLine(push, pos, -500, 0, pos, 500, 0, 'A-GRID');
      writeText(push, g.label || `X${pos.toFixed(1)}`, pos, -5, 0.04, 'A-TEXT');
    } else {
      // Horizontal grid line
      writeLine(push, -500, pos, 0, 500, pos, 0, 'A-GRID');
      writeText(push, g.label || `Y${pos.toFixed(1)}`, -5, pos, 0.04, 'A-TEXT');
    }
  }

  // Levels as LINE + TEXT
  for (const lvl of levels) {
    const elev = parseFloat(lvl.elevation || 0);
    writeLine(push, -500, elev, 0, 500, elev, 0, 'A-LEVEL');
    writeText(push, `${lvl.name || 'L' + lvl.id}  ${elev.toFixed(2)}'`, -490, elev + 0.3, 0.05, 'A-TEXT');
  }

  push('0', 'ENDSEC');

  // ── EOF ─────────────────────────────────────────────────────────────────────
  push('0', 'EOF');

  return lines.join('\n');
}

// ── DXF entity helpers ────────────────────────────────────────────────────────

function writeLwpolyline2D(push, points, layer, closed = 1) {
  push('0', 'LWPOLYLINE');
  push('8', layer);
  push('90', String(points.length));
  push('70', String(closed));
  for (const pt of points) {
    push('10', String(parseFloat(pt[0])));
    push('20', String(parseFloat(pt[1])));
    if (pt[2] !== undefined) push('30', String(parseFloat(pt[2])));
  }
}

function writeLine(push, x1, y1, z1, x2, y2, z2, layer) {
  push('0', 'LINE', '8', layer);
  push('10', String(x1)); push('20', String(y1)); push('30', String(z1));
  push('11', String(x2)); push('21', String(y2)); push('31', String(z2));
}

function writeCircle(push, cx, cy, cz, radius, layer) {
  push('0', 'CIRCLE', '8', layer);
  push('10', String(cx)); push('20', String(cy)); push('30', String(cz));
  push('40', String(radius));
}

function writeText(push, text, x, y, height, layer) {
  push('0', 'TEXT', '8', layer);
  push('10', String(x)); push('20', String(y)); push('30', '0.0');
  push('40', String(height));
  push('1', text);
  push('72', '0'); push('73', '0');
  push('11', String(x)); push('21', String(y)); push('31', '0.0');
}

function writeBlockInsert(push, blockName, x, y, z, rotation, handle, layer) {
  push('0', 'INSERT', '8', layer);
  push('2', blockName);
  push('10', String(x)); push('20', String(y)); push('30', String(z));
  push('50', String(rotation));
  push('1', handle);
}

function write3DWall(push, xs, ys, zs, xe, ye, ze, height, thickness, layer) {
  // 2D plan representation: draw 3D polyline at elevation 0
  writeLwpolyline2D(push, [
    [xs, ys, zs],
    [xe, ye, ze],
    [xe, ye, ze + height],
    [xs, ys, zs + height],
    [xs, ys, zs],
  ], layer, 1);
  // Also draw the top edge line
  writeLine(push, xs, ys, zs + height, xe, ye, ze + height, layer);
}

function write3DColumn(push, cx, cy, cz, radius, height, layer) {
  // Draw 3D column as LWPOLYLINE rectangle footprint + top face
  const r = radius;
  writeLwpolyline2D(push, [
    [cx - r, cy - r, cz],
    [cx + r, cy - r, cz],
    [cx + r, cy + r, cz],
    [cx - r, cy + r, cz],
    [cx - r, cy - r, cz],
  ], layer, 1);
  writeLwpolyline2D(push, [
    [cx - r, cy - r, cz + height],
    [cx + r, cy - r, cz + height],
    [cx + r, cy + r, cz + height],
    [cx - r, cy + r, cz + height],
    [cx - r, cy - r, cz + height],
  ], layer, 1);
  // Vertical edges
  writeLine(push, cx - r, cy - r, cz, cx - r, cy - r, cz + height, layer);
  writeLine(push, cx + r, cy - r, cz, cx + r, cy - r, cz + height, layer);
  writeLine(push, cx + r, cy + r, cz, cx + r, cy + r, cz + height, layer);
  writeLine(push, cx - r, cy + r, cz, cx - r, cy + r, cz + height, layer);
}

function writeDoorBlock(push) {
  push('0', 'BLOCK', '2', 'DOOR_3X7');
  push('70', '0');
  push('10', '0.0'); push('20', '0.0'); push('30', '0.0');
  push('3', 'DOOR_3X7');

  // 3' wide × 7' tall door rectangle
  writeLwpolyline2D(push, [
    [-1.5, -0.5, 0], [1.5, -0.5, 0], [1.5, 0.5, 0],
    [-1.5, 0.5, 0], [-1.5, -0.5, 0],
  ], '0', 1);

  // Door swing arc (90°)
  push('0', 'ARC', '8', '0', '10', '0.0', '20', '0.0', '30', '0.0');
  push('40', '3.0'); push('50', '315'); push('51', '45');

  // Door swing line
  writeLine(push, -1.5, -0.5, 0, -1.5, 2.5, 0, '0');

  push('0', 'ENDBLK', '2', 'DOOR_3X7');
}

function writeWindowBlock(push) {
  push('0', 'BLOCK', '2', 'WINDOW_4X4');
  push('70', '0');
  push('10', '0.0'); push('20', '0.0'); push('30', '0.0');
  push('3', 'WINDOW_4X4');

  // 4' wide × 4' tall window
  writeLwpolyline2D(push, [
    [-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0], [-2, -2, 0],
  ], '0', 1);

  // Cross lines for window sash
  writeLine(push, -2, 0, 0, 2, 0, 0, '0');
  writeLine(push, 0, -2, 0, 0, 2, 0, '0');

  push('0', 'ENDBLK', '2', 'WINDOW_4X4');
}

module.exports = { generateDXF };