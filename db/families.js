/**
 * Owns: all DB queries for family_instances (doors, windows) and their type catalogs.
 * Does NOT own: DAG recalculation, HTTP routing, Three.js rendering.
 */
const pool = require('./index');

async function getAllFamilyInstances() {
  const res = await pool.query(`
    SELECT f.*,
           e.type_name AS host_wall_type, e.parameters AS host_wall_params,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM family_instances f
    JOIN elements e ON f.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    ORDER BY f.created_at ASC
  `);
  return res.rows;
}

async function getFamilyInstanceById(id) {
  const res = await pool.query(`
    SELECT f.*,
           e.type_name AS host_wall_type, e.parameters AS host_wall_params,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation,
           tl.name AS top_level_name, tl.elevation AS top_level_elevation
    FROM family_instances f
    JOIN elements e ON f.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    LEFT JOIN levels tl ON e.top_level_id = tl.id
    WHERE f.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function getFamilyInstancesByWall(wallId) {
  const res = await pool.query(`
    SELECT * FROM family_instances WHERE host_wall_id = $1 ORDER BY host_face_u ASC
  `, [wallId]);
  return res.rows;
}

async function getFamilyInstancesByProject(projectId) {
  const res = await pool.query(`
    SELECT f.*,
           e.type_name AS host_wall_type, e.parameters AS host_wall_params,
           bl.name AS base_level_name, bl.elevation AS base_level_elevation
    FROM family_instances f
    JOIN elements e ON f.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    WHERE e.project_id = $1
    ORDER BY f.created_at ASC
  `, [projectId]);
  return res.rows;
}

async function createFamilyInstance(data) {
  const {
    family_type, type_name, host_wall_id, host_face_u = 0.5,
    mark = null, parameters = {}, computed = {},
    ifc_global_id = null, ifc_entity_id = null, ifc_type = null,
    project_id = 1
  } = data;
  const res = await pool.query(
    `INSERT INTO family_instances (family_type, type_name, host_wall_id, host_face_u, mark, parameters, computed, ifc_global_id, ifc_entity_id, ifc_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [family_type, type_name, host_wall_id, host_face_u, mark, JSON.stringify(parameters), JSON.stringify(computed), ifc_global_id, ifc_entity_id, ifc_type]
  );
  return res.rows[0];
}

async function updateFamilyInstance(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (data.type_name !== undefined) { fields.push(`type_name = $${idx++}`); values.push(data.type_name); }
  if (data.host_face_u !== undefined) { fields.push(`host_face_u = $${idx++}`); values.push(data.host_face_u); }
  if (data.mark !== undefined) { fields.push(`mark = $${idx++}`); values.push(data.mark); }
  if (data.parameters !== undefined) { fields.push(`parameters = $${idx++}`); values.push(JSON.stringify(data.parameters)); }
  if (data.computed !== undefined) { fields.push(`computed = $${idx++}`); values.push(JSON.stringify(data.computed)); }

  if (fields.length === 0) return getFamilyInstanceById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);

  const res = await pool.query(
    `UPDATE family_instances SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteFamilyInstance(id) {
  await pool.query('DELETE FROM family_instances WHERE id = $1', [id]);
}

// Door types catalog
async function getDoorTypes() {
  const res = await pool.query('SELECT * FROM door_types ORDER BY name ASC');
  return res.rows;
}

// Window types catalog
async function getWindowTypes() {
  const res = await pool.query('SELECT * FROM window_types ORDER BY name ASC');
  return res.rows;
}

// Schedule generation — door instances grouped by type
async function getDoorSchedule() {
  const res = await pool.query(`
    SELECT
      f.mark,
      f.type_name,
      f.parameters->>'width' AS width,
      f.parameters->>'height' AS height,
      f.parameters->>'material' AS material,
      f.parameters->>'fireRating' AS fire_rating,
      f.parameters->>'type' AS door_type,
      f.parameters->>'hand' AS hand,
      e.type_name AS wall_host_type,
      bl.name AS level_name
    FROM family_instances f
    JOIN elements e ON f.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    WHERE f.family_type = 'door'
    ORDER BY f.mark ASC
  `);
  return res.rows;
}

// Schedule generation — window instances grouped by type
async function getWindowSchedule() {
  const res = await pool.query(`
    SELECT
      f.mark,
      f.type_name,
      f.parameters->>'width' AS width,
      f.parameters->>'height' AS height,
      f.parameters->>'sillHeight' AS sill_height,
      f.parameters->>'type' AS window_type,
      f.parameters->>'glazing' AS glazing,
      f.parameters->>'material' AS material,
      e.type_name AS wall_host_type,
      bl.name AS level_name
    FROM family_instances f
    JOIN elements e ON f.host_wall_id = e.id
    LEFT JOIN levels bl ON e.base_level_id = bl.id
    WHERE f.family_type = 'window'
    ORDER BY f.mark ASC
  `);
  return res.rows;
}

module.exports = {
  getAllFamilyInstances, getFamilyInstancesByProject, getFamilyInstanceById, getFamilyInstancesByWall,
  createFamilyInstance, updateFamilyInstance, deleteFamilyInstance,
  getDoorTypes, getWindowTypes,
  getDoorSchedule, getWindowSchedule,
};