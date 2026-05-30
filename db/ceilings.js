/**
 * Owns: all DB queries for ceilings and ceiling_layers.
 * Does NOT own: room queries, floor queries, DAG recalculation, HTTP routing.
 */
const pool = require('./index');

async function getAllCeilings(projectId) {
  if (!projectId) return [];
  const res = await pool.query(`
    SELECT c.*,
           l.name AS host_level_name, l.elevation AS host_level_elevation,
           r.name AS room_name
    FROM ceilings c
    LEFT JOIN levels l ON l.id = c.host_level_id
    LEFT JOIN rooms r ON c.room_id = r.id
    WHERE c.project_id = $1
    ORDER BY c.created_at ASC
  `, [String(projectId)]);
  return res.rows;
}

async function getCeilingById(id) {
  if (!id) return null;
  const res = await pool.query(`
    SELECT c.*,
           l.name AS host_level_name, l.elevation AS host_level_elevation,
           r.name AS room_name
    FROM ceilings c
    LEFT JOIN levels l ON l.id = c.host_level_id
    LEFT JOIN rooms r ON c.room_id = r.id
    WHERE c.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function createCeiling(data) {
  const {
    project_id, name = 'Ceiling', host_level_id = null, room_id = null,
    elevation_offset = 2.7, ceiling_type = 'flat', slope_direction = null, parameters = {}
  } = data;
  const res = await pool.query(
    `INSERT INTO ceilings (project_id, name, host_level_id, room_id, elevation_offset, ceiling_type, slope_direction, parameters)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [project_id, name, host_level_id, room_id, elevation_offset, ceiling_type, slope_direction, JSON.stringify(parameters)]
  );
  return res.rows[0];
}

async function updateCeiling(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  const allowed = ['name','host_level_id','room_id','elevation_offset','ceiling_type','slope_direction','parameters'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(key === 'parameters' ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (!fields.length) return getCeilingById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const res = await pool.query(
    `UPDATE ceilings SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteCeiling(id) {
  await pool.query('DELETE FROM ceilings WHERE id = $1', [id]);
}

async function getCeilingLayers(ceilingId) {
  const res = await pool.query(
    'SELECT * FROM ceiling_layers WHERE element_id = $1 ORDER BY layer_order ASC',
    [ceilingId]
  );
  return res.rows;
}

async function setCeilingLayers(ceilingId, layers) {
  await pool.query('DELETE FROM ceiling_layers WHERE element_id = $1', [ceilingId]);
  for (let i = 0; i < layers.length; i++) {
    const { material, thickness, function: fn, thickness_before_drawing = false } = layers[i];
    await pool.query(
      `INSERT INTO ceiling_layers (element_id, layer_order, material, thickness, function, thickness_before_drawing)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ceilingId, i, material, thickness, fn, thickness_before_drawing]
    );
  }
}

async function getCeilingTypes() {
  const res = await pool.query('SELECT * FROM ceiling_types ORDER BY name ASC');
  return res.rows;
}

module.exports = {
  getAllCeilings, getCeilingById, createCeiling, updateCeiling, deleteCeiling,
  getCeilingLayers, setCeilingLayers, getCeilingTypes,
};