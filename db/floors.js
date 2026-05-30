/**
 * Owns: all DB queries for floors and floor_layers (multi-layer slab construction).
 * Does NOT own: DAG recalculation, HTTP routing, ceiling queries, room integration.
 */
const pool = require('./index');

async function getAllFloors(projectId) {
  const pid = String(projectId || '1');
  const res = await pool.query(`
    SELECT f.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM floors f
    LEFT JOIN levels bl ON bl.id = f.base_level_id
    LEFT JOIN levels tl ON tl.id = f.top_level_id
    WHERE f.project_id = $1
    ORDER BY f.created_at ASC
  `, [pid]);
  return res.rows;
}

async function getFloorById(id) {
  const res = await pool.query(`
    SELECT f.*,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM floors f
    LEFT JOIN levels bl ON bl.id = f.base_level_id
    LEFT JOIN levels tl ON tl.id = f.top_level_id
    WHERE f.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function createFloor(data) {
  const {
    project_id, name = 'Floor', base_level_id = null, top_level_id = null,
    area_sqm = null, thickness = 0.3, position_x = 0, position_y = 0,
    elevation = 0, parameters = {}
  } = data;
  const res = await pool.query(
    `INSERT INTO floors (project_id, name, base_level_id, top_level_id, area_sqm, thickness, position_x, position_y, elevation, parameters)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [project_id, name, base_level_id, top_level_id, area_sqm, thickness, position_x, position_y, elevation, JSON.stringify(parameters)]
  );
  return res.rows[0];
}

async function updateFloor(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  const allowed = ['name','base_level_id','top_level_id','area_sqm','thickness','position_x','position_y','elevation','parameters'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(key === 'parameters' ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (!fields.length) return getFloorById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const res = await pool.query(
    `UPDATE floors SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteFloor(id) {
  await pool.query('DELETE FROM floors WHERE id = $1', [id]);
}

async function getFloorLayers(floorId) {
  const res = await pool.query(
    'SELECT * FROM floor_layers WHERE element_id = $1 ORDER BY layer_order ASC',
    [floorId]
  );
  return res.rows;
}

async function setFloorLayers(floorId, layers) {
  await pool.query('DELETE FROM floor_layers WHERE element_id = $1', [floorId]);
  for (let i = 0; i < layers.length; i++) {
    const { material, thickness, function: fn, thickness_before_drawing = false } = layers[i];
    await pool.query(
      `INSERT INTO floor_layers (element_id, layer_order, material, thickness, function, thickness_before_drawing)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [floorId, i, material, thickness, fn, thickness_before_drawing]
    );
  }
}

async function getFloorTypes() {
  const res = await pool.query('SELECT * FROM floor_types ORDER BY name ASC');
  return res.rows;
}

module.exports = {
  getAllFloors, getFloorById, createFloor, updateFloor, deleteFloor,
  getFloorLayers, setFloorLayers, getFloorTypes,
};