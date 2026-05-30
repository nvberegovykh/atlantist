/**
 * Owns: im_instances table CRUD — per-element parameter overrides.
 * Does NOT own: IM types, constraints, event ledger.
 */
const pool = require('./index');

async function getInstancesByProject(projectId) {
  const res = await pool.query(
    `SELECT i.*, t.type_name, t.category, t.parameters as type_parameters
     FROM im_instances i
     LEFT JOIN im_types t ON i.type_id = t.id
     WHERE i.project_id = $1
     ORDER BY i.element_id`,
    [projectId]
  );
  return res.rows;
}

async function getInstancesByElement(elementId) {
  const res = await pool.query(
    `SELECT i.*, t.type_name, t.category, t.parameters as type_parameters
     FROM im_instances i
     LEFT JOIN im_types t ON i.type_id = t.id
     WHERE i.element_id = $1`,
    [elementId]
  );
  return res.rows;
}

async function getInstanceByElement(elementId) {
  const res = await pool.query(
    `SELECT i.*, t.type_name, t.category, t.parameters as type_parameters
     FROM im_instances i
     LEFT JOIN im_types t ON i.type_id = t.id
     WHERE i.element_id = $1`,
    [elementId]
  );
  return res.rows[0] || null;
}

async function upsertInstance({ project_id, element_id, type_id, overrides }) {
  const res = await pool.query(
    `INSERT INTO im_instances (project_id, element_id, type_id, overrides)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, element_id) DO UPDATE
       SET type_id = EXCLUDED.type_id,
           overrides = EXCLUDED.overrides,
           updated_at = NOW()
     RETURNING *`,
    [project_id, element_id, type_id || null, JSON.stringify(overrides || {})]
  );
  return res.rows[0];
}

async function updateOverrides(elementId, overrides) {
  const res = await pool.query(
    `UPDATE im_instances SET overrides = $1, updated_at = NOW()
     WHERE element_id = $2 RETURNING *`,
    [JSON.stringify(overrides), elementId]
  );
  return res.rows[0] || null;
}

async function deleteByElement(elementId) {
  await pool.query(`DELETE FROM im_instances WHERE element_id = $1`, [elementId]);
}

module.exports = {
  getInstancesByProject,
  getInstancesByElement,
  getInstanceByElement,
  upsertInstance,
  updateOverrides,
  deleteByElement,
};