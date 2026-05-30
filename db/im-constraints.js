/**
 * Owns: im_constraints table CRUD — parametric constraint bindings.
 * Does NOT own: IM types, instances, event ledger.
 */
const pool = require('./index');

async function getConstraintsByProject(projectId) {
  const res = await pool.query(
    `SELECT c.*, e.type_name as host_element_name
     FROM im_constraints c
     LEFT JOIN elements e ON c.host_element_id = e.id
     WHERE c.project_id = $1
     ORDER BY c.constraint_type, c.constraint_key`,
    [projectId]
  );
  return res.rows;
}

async function getConstraintsByHost(hostElementId) {
  const res = await pool.query(
    `SELECT * FROM im_constraints WHERE host_element_id = $1 ORDER BY constraint_key`,
    [hostElementId]
  );
  return res.rows;
}

async function getConstraintsByTarget(targetElementId) {
  const res = await pool.query(
    `SELECT * FROM im_constraints WHERE target_element_id = $1`,
    [targetElementId]
  );
  return res.rows;
}

async function upsertConstraint({ project_id, host_element_id, constraint_key, constraint_type, target_property, target_element_id, expression }) {
  const res = await pool.query(
    `INSERT INTO im_constraints (project_id, host_element_id, constraint_key, constraint_type, target_property, target_element_id, expression)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, host_element_id, constraint_key) DO UPDATE
       SET constraint_type = EXCLUDED.constraint_type,
           target_property = EXCLUDED.target_property,
           target_element_id = EXCLUDED.target_element_id,
           expression = EXCLUDED.expression,
           updated_at = NOW()
     RETURNING *`,
    [project_id, host_element_id, constraint_key, constraint_type, target_property, target_element_id || null, JSON.stringify(expression || {})]
  );
  return res.rows[0];
}

async function updateConstraintExpression(constraintId, expression) {
  const res = await pool.query(
    `UPDATE im_constraints SET expression = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(expression), constraintId]
  );
  return res.rows[0] || null;
}

async function setConstraintActive(constraintId, is_active) {
  const res = await pool.query(
    `UPDATE im_constraints SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [is_active, constraintId]
  );
  return res.rows[0] || null;
}

async function deleteConstraint(constraintId) {
  await pool.query(`DELETE FROM im_constraints WHERE id = $1`, [constraintId]);
}

async function deleteByHost(hostElementId) {
  await pool.query(`DELETE FROM im_constraints WHERE host_element_id = $1`, [hostElementId]);
}

module.exports = {
  getConstraintsByProject,
  getConstraintsByHost,
  getConstraintsByTarget,
  upsertConstraint,
  updateConstraintExpression,
  setConstraintActive,
  deleteConstraint,
  deleteByHost,
};