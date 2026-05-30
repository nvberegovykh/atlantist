/**
 * Owns: all DB queries for elements (walls, columns) and wall_layers.
 * Does NOT own: DAG recalculation, HTTP routing, level queries.
 */
const pool = require('./index');

async function getAllElements() {
  const res = await pool.query(`
    SELECT e.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM elements e
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    ORDER BY e.created_at ASC
  `);
  return res.rows;
}

async function getElementById(id) {
  const res = await pool.query(`
    SELECT e.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM elements e
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    WHERE e.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function getAllElementsByProject(projectId) {
  const res = await pool.query(`
    SELECT e.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM elements e
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    WHERE e.project_id = $1
    ORDER BY e.created_at ASC
  `, [projectId]);
  return res.rows;
}

async function createElement(data) {
  const { type, type_name = 'Generic', parameters = {}, base_level_id, top_level_id, computed = {},
          project_id, ifc_global_id = null, ifc_entity_id = null, ifc_type = null } = data;
  const res = await pool.query(
    `INSERT INTO elements (type, type_name, parameters, base_level_id, top_level_id, computed, project_id, ifc_global_id, ifc_entity_id, ifc_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [type, type_name, JSON.stringify(parameters), base_level_id || null, top_level_id || null,
     JSON.stringify(computed), project_id, ifc_global_id, ifc_entity_id, ifc_type]
  );
  return res.rows[0];
}

async function updateElement(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (data.type_name !== undefined) { fields.push(`type_name = $${idx++}`); values.push(data.type_name); }
  if (data.parameters !== undefined) { fields.push(`parameters = $${idx++}`); values.push(JSON.stringify(data.parameters)); }
  if (data.base_level_id !== undefined) { fields.push(`base_level_id = $${idx++}`); values.push(data.base_level_id); }
  if (data.top_level_id !== undefined) { fields.push(`top_level_id = $${idx++}`); values.push(data.top_level_id); }
  if (data.computed !== undefined) { fields.push(`computed = $${idx++}`); values.push(JSON.stringify(data.computed)); }

  if (fields.length === 0) return getElementById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);

  const res = await pool.query(
    `UPDATE elements SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteElement(id) {
  await pool.query('DELETE FROM elements WHERE id = $1', [id]);
}

// Get elements bound to a specific level (for DAG recalc)
async function getElementsByLevelId(levelId) {
  const res = await pool.query(
    `SELECT * FROM elements WHERE base_level_id = $1 OR top_level_id = $1`,
    [levelId]
  );
  return res.rows;
}

// Wall layers for a single element
async function getWallLayers(elementId) {
  const res = await pool.query(
    'SELECT * FROM wall_layers WHERE element_id = $1 ORDER BY layer_order ASC',
    [elementId]
  );
  return res.rows;
}

// Batch-fetch wall layers for N elements in a single query. Returns Map<elementId → layers[]>
async function getWallLayersBatch(elementIds) {
  if (!elementIds || elementIds.length === 0) return new Map();
  const res = await pool.query(
    'SELECT * FROM wall_layers WHERE element_id = ANY($1) ORDER BY element_id, layer_order ASC',
    [elementIds]
  );
  const map = new Map();
  for (const row of res.rows) {
    if (!map.has(row.element_id)) map.set(row.element_id, []);
    map.get(row.element_id).push(row);
  }
  return map;
}

async function setWallLayers(elementId, layers) {
  await pool.query('DELETE FROM wall_layers WHERE element_id = $1', [elementId]);
  for (let i = 0; i < layers.length; i++) {
    const { material, thickness, function: fn, thickness_before_drawing = false } = layers[i];
    await pool.query(
      `INSERT INTO wall_layers (element_id, layer_order, material, thickness, function, thickness_before_drawing)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [elementId, i, material, thickness, fn, thickness_before_drawing]
    );
  }
}

// Roof layers
async function getRoofLayers(elementId) {
  const res = await pool.query(
    'SELECT * FROM roof_layers WHERE element_id = $1 ORDER BY layer_order ASC',
    [elementId]
  );
  return res.rows;
}

async function setRoofLayers(elementId, layers) {
  await pool.query('DELETE FROM roof_layers WHERE element_id = $1', [elementId]);
  for (let i = 0; i < layers.length; i++) {
    const { material, thickness, function: fn, thickness_before_drawing = false } = layers[i];
    await pool.query(
      `INSERT INTO roof_layers (element_id, layer_order, material, thickness, function, thickness_before_drawing)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [elementId, i, material, thickness, fn, thickness_before_drawing]
    );
  }
}

// Wall and column types catalogs
async function getWallTypes() {
  const res = await pool.query('SELECT * FROM wall_types ORDER BY name ASC');
  return res.rows;
}

async function getColumnTypes() {
  const res = await pool.query('SELECT * FROM column_types ORDER BY name ASC');
  return res.rows;
}

// Roof types catalog
async function getRoofTypes() {
  const res = await pool.query('SELECT * FROM roof_types ORDER BY name ASC');
  return res.rows;
}

module.exports = {
  getAllElements, getAllElementsByProject, getElementById, createElement, updateElement, deleteElement,
  getElementsByLevelId,
  getWallLayers, getWallLayersBatch, setWallLayers,
  getRoofLayers, setRoofLayers,
  getWallTypes, getColumnTypes, getRoofTypes,
};
