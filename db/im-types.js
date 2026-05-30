/**
 * Owns: im_types table CRUD — type catalog management.
 * Does NOT own: IM instances, constraints, event ledger.
 */
const pool = require('./index');

async function getTypesByProject(projectId) {
  const res = await pool.query(
    `SELECT * FROM im_types WHERE project_id = $1 ORDER BY category, type_name`,
    [projectId]
  );
  return res.rows;
}

async function getTypesByCategory(projectId, category) {
  const res = await pool.query(
    `SELECT * FROM im_types WHERE project_id = $1 AND category = $2 ORDER BY type_name`,
    [projectId, category]
  );
  return res.rows;
}

async function getTypeById(typeId) {
  const res = await pool.query(`SELECT * FROM im_types WHERE id = $1`, [typeId]);
  return res.rows[0] || null;
}

async function createType({ project_id, category, type_name, description, parameters }) {
  const res = await pool.query(
    `INSERT INTO im_types (project_id, category, type_name, description, parameters)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, category, type_name) DO UPDATE
       SET description = EXCLUDED.description,
           parameters = EXCLUDED.parameters,
           updated_at = NOW()
     RETURNING *`,
    [project_id, category, type_name, description || null, JSON.stringify(parameters || {})]
  );
  return res.rows[0];
}

async function updateType(typeId, { type_name, description, parameters }) {
  const fields = [];
  const vals = [];
  let i = 1;
  if (type_name !== undefined) { fields.push(`type_name = $${i++}`); vals.push(type_name); }
  if (description !== undefined) { fields.push(`description = $${i++}`); vals.push(description); }
  if (parameters !== undefined) { fields.push(`parameters = $${i++}`); vals.push(JSON.stringify(parameters)); }
  if (!fields.length) return getTypeById(typeId);
  fields.push(`updated_at = NOW()`);
  vals.push(typeId);
  const res = await pool.query(
    `UPDATE im_types SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function deleteType(typeId) {
  await pool.query(`DELETE FROM im_types WHERE id = $1`, [typeId]);
}

module.exports = {
  getTypesByProject,
  getTypesByCategory,
  getTypeById,
  createType,
  updateType,
  deleteType,
};