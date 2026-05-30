/**
 * Owns: all DB queries for structural_grids and structural_grid_lines.
 * Does NOT own: level queries, element snapping, Three.js rendering.
 */
const pool = require('./index');
const { toInt } = require('./index');

// ── Grid CRUD ────────────────────────────────────────────────────────────────

async function getAllGrids(projectId = 1) {
  const res = await pool.query(
    `SELECT * FROM structural_grids WHERE project_id = $1 ORDER BY id ASC`,
    [String(projectId)]
  );
  return res.rows;
}

async function getGridById(id) {
  const res = await pool.query(`SELECT * FROM structural_grids WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createGrid(data) {
  const { name = 'Grid', system_type = 'structural', project_id = 1,
    origin_x = 0, origin_z = 0, spacing_x = 5, spacing_z = 5, bubble_visible = true } = data;
  const res = await pool.query(
    `INSERT INTO structural_grids (name, system_type, project_id, origin_x, origin_z, spacing_x, spacing_z, bubble_visible)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name, system_type, String(project_id), origin_x, origin_z, spacing_x, spacing_z, bubble_visible]
  );
  return res.rows[0];
}

async function updateGrid(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
  if (data.origin_x !== undefined) { fields.push(`origin_x = $${idx++}`); values.push(data.origin_x); }
  if (data.origin_z !== undefined) { fields.push(`origin_z = $${idx++}`); values.push(data.origin_z); }
  if (data.spacing_x !== undefined) { fields.push(`spacing_x = $${idx++}`); values.push(data.spacing_x); }
  if (data.spacing_z !== undefined) { fields.push(`spacing_z = $${idx++}`); values.push(data.spacing_z); }
  if (data.bubble_visible !== undefined) { fields.push(`bubble_visible = $${idx++}`); values.push(data.bubble_visible); }
  if (fields.length === 0) return getGridById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const res = await pool.query(
    `UPDATE structural_grids SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteGrid(id) {
  await pool.query(`DELETE FROM structural_grids WHERE id = $1`, [id]);
}

// ── Grid Lines CRUD ────────────────────────────────────────────────────────────

async function getLinesByGrid(gridId) {
  const res = await pool.query(
    `SELECT * FROM structural_grid_lines WHERE grid_id = $1 ORDER BY axis ASC, coordinate ASC`,
    [gridId]
  );
  return res.rows;
}

async function getAllLinesByProject(projectId) {
  const res = await pool.query(
    `SELECT gl.*, g.name as grid_name, g.origin_x, g.origin_z, g.spacing_x, g.spacing_z
     FROM structural_grid_lines gl
     JOIN structural_grids g ON gl.grid_id = g.id
     WHERE g.project_id = $1
     ORDER BY gl.axis ASC, gl.coordinate ASC`,
    [projectId]
  );
  return res.rows;
}

async function createGridLine(data) {
  const { grid_id, axis, label, coordinate, bubble_end_a = true, bubble_end_b = true } = data;
  const res = await pool.query(
    `INSERT INTO structural_grid_lines (grid_id, axis, label, coordinate, bubble_end_a, bubble_end_b)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [grid_id, axis, label, coordinate, bubble_end_a, bubble_end_b]
  );
  return res.rows[0];
}

async function deleteGridLines(gridId) {
  await pool.query(`DELETE FROM structural_grid_lines WHERE grid_id = $1`, [gridId]);
}

// Generate a full grid system with lines (e.g. A-E on X, 1-5 on Z)
async function generateGridLines(gridId, xLabels, zLabels) {
  await deleteGridLines(gridId);
  const lines = [];
  // X-axis lines (columns A, B, C...)
  for (const label of xLabels) {
    const line = await createGridLine({ grid_id: gridId, axis: 'x', label, coordinate: 0 });
    lines.push(line);
  }
  // Z-axis lines (rows 1, 2, 3...)
  for (const label of zLabels) {
    const line = await createGridLine({ grid_id: gridId, axis: 'z', label, coordinate: 0 });
    lines.push(line);
  }
  return lines;
}

// Compute world position of a grid intersection (e.g. "A-1" → x=0, z=0)
function gridIntersectionPosition(intersectionLabel, grid) {
  const labelParts = intersectionLabel.split('-');
  const colLabel = labelParts[0] || 'A';
  const rowLabel = labelParts[1] || '1';

  // Sort X lines to determine column order
  const gridData = typeof grid === 'string' ? JSON.parse(grid) : grid;
  const originX = parseFloat(gridData.origin_x || 0);
  const originZ = parseFloat(gridData.origin_z || 0);
  const spacingX = parseFloat(gridData.spacing_x || 5);
  const spacingZ = parseFloat(gridData.spacing_z || 5);

  const colIdx = colLabel.charCodeAt(0) - 65; // A=0, B=1...
  const rowIdx = parseInt(rowLabel, 10) - 1;   // 1=0, 2=1...

  return {
    x: originX + colIdx * spacingX,
    z: originZ + rowIdx * spacingZ,
  };
}

// Find nearest grid intersection to a given world point
function snapToGridIntersection(x, z, xLines, zLines, spacingX, spacingZ, originX, originZ) {
  let nearestX = Math.round((x - originX) / spacingX) * spacingX + originX;
  let nearestZ = Math.round((z - originZ) / spacingZ) * spacingZ + originZ;

  // Clamp to existing lines if possible
  if (xLines.length > 0) {
    let minDiff = Infinity;
    for (const line of xLines) {
      const diff = Math.abs(line.coordinate - x);
      if (diff < minDiff) { minDiff = diff; nearestX = line.coordinate; }
    }
  }
  if (zLines.length > 0) {
    let minDiff = Infinity;
    for (const line of zLines) {
      const diff = Math.abs(line.coordinate - z);
      if (diff < minDiff) { minDiff = diff; nearestZ = line.coordinate; }
    }
  }

  // Determine label
  const colLetter = String.fromCharCode(65 + Math.round((nearestX - originX) / spacingX));
  const rowNum = Math.round((nearestZ - originZ) / spacingZ) + 1;
  const label = `${colLetter}-${rowNum}`;

  return { x: nearestX, z: nearestZ, label };
}

module.exports = {
  getAllGrids,
  getGridById,
  createGrid,
  updateGrid,
  deleteGrid,
  getLinesByGrid,
  getAllLinesByProject,
  createGridLine,
  deleteGridLines,
  generateGridLines,
  gridIntersectionPosition,
  snapToGridIntersection,
};