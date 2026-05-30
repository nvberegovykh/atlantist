/**
 * Owns: all DB queries for railings and railing_types catalog.
 * Does NOT own: stair queries, DAG recalculation, HTTP routing.
 */
const pool = require('./index');

async function getAllRailings(projectId) {
  if (!projectId) return [];
  const res = await pool.query(`
    SELECT r.*, s.name AS stair_name, s.stair_type
    FROM railings r
    JOIN stairs s ON r.host_stair_id = s.id
    WHERE r.project_id = $1
    ORDER BY r.created_at ASC
  `, [String(projectId)]);
  return res.rows;
}

async function getRailingsByStairId(stairId) {
  const numId = parseInt(stairId, 10);
  if (isNaN(numId)) return [];
  const res = await pool.query(
    'SELECT * FROM railings WHERE host_stair_id = $1 ORDER BY created_at ASC',
    [numId]
  );
  return res.rows;
}

async function getRailingById(id) {
  // railings.id is INTEGER; coerce UUID strings from route path params
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  const res = await pool.query(
    `SELECT r.*, s.name AS stair_name, s.stair_type
     FROM railings r JOIN stairs s ON r.host_stair_id = s.id WHERE r.id = $1`,
    [numId]
  );
  return res.rows[0] || null;
}

async function createRailing(data) {
  const {
    project_id = 1,
    name = 'Handrail',
    host_stair_id = null,
    railing_type = 'baluster',
    height = 0.9,
    top_rail_width = 0.05,
    baluster_spacing = 0.11,
    glass_thickness = 0.012,
    side = 'left',
    material = 'Aluminum',
    glass_finish = 'clear',
  } = data;

  const res = await pool.query(
    `INSERT INTO railings (project_id,name,host_stair_id,railing_type,height,top_rail_width,
     baluster_spacing,glass_thickness,side,material,glass_finish)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [project_id, name, host_stair_id, railing_type, height, top_rail_width,
     baluster_spacing, glass_thickness, side, material, glass_finish]
  );
  return res.rows[0];
}

async function updateRailing(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;

  const allowed = [
    'name','railing_type','height','top_rail_width',
    'baluster_spacing','glass_thickness','side','material','glass_finish',
  ];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }

  // railings.id is INTEGER; coerce UUID strings
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  if (fields.length === 0) return getRailingById(numId);
  fields.push(`updated_at = NOW()`);
  values.push(numId);

  const res = await pool.query(
    `UPDATE railings SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteRailing(id) {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return;
  await pool.query('DELETE FROM railings WHERE id = $1', [numId]);
}

// Cascade delete railings when a stair is deleted — handled by ON DELETE CASCADE on FK
// but provide explicit helper
async function deleteRailingsByStairId(stairId) {
  const numId = parseInt(stairId, 10);
  if (isNaN(numId)) return;
  await pool.query('DELETE FROM railings WHERE host_stair_id = $1', [numId]);
}

// Catalog
async function getRailingTypes() {
  const res = await pool.query('SELECT * FROM railing_types ORDER BY name ASC');
  return res.rows;
}

module.exports = {
  getAllRailings, getRailingsByStairId, getRailingById,
  createRailing, updateRailing, deleteRailing,
  deleteRailingsByStairId,
  getRailingTypes,
};