/**
 * Owns: annotation CRUD, keynote table, hatching patterns.
 * Does NOT own: Three.js rendering, DAG recalculation, HTTP routing.
 */
const pool = require('./index');

// ─── Annotations ──────────────────────────────────────────────────────────────

async function getAnnotationsByProject(projectId) {
  const res = await pool.query(
    `SELECT a.*, kt.code AS keynote_code, kt.description AS keynote_desc
     FROM annotations a
     LEFT JOIN keynote_table kt ON (a.data->>'keynoteId')::int = kt.id
     WHERE a.project_id = $1
     ORDER BY a.created_at ASC`,
    [projectId]
  );
  return res.rows;
}

async function getAnnotationsByElement(elementId) {
  const res = await pool.query(
    `SELECT * FROM annotations WHERE element_id = $1 AND visible = true`,
    [elementId]
  );
  return res.rows;
}

async function createAnnotation({ projectId, type, data, elementId, roomId, position2d, position3d, style, createdBy }) {
  const res = await pool.query(
    `INSERT INTO annotations (project_id, type, data, element_id, room_id, position_2d, position_3d, style, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [projectId, type, JSON.stringify(data), elementId || null, roomId || null,
     position2d ? JSON.stringify(position2d) : null,
     position3d ? JSON.stringify(position3d) : null,
     JSON.stringify(style || {}), createdBy || null]
  );
  return res.rows[0];
}

async function updateAnnotation(id, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (patch.data !== undefined)    { sets.push(`data = $${i++}`); vals.push(JSON.stringify(patch.data)); }
  if (patch.style !== undefined)   { sets.push(`style = $${i++}`); vals.push(JSON.stringify(patch.style)); }
  if (patch.visible !== undefined){ sets.push(`visible = $${i++}`); vals.push(patch.visible); }
  if (patch.locked !== undefined) { sets.push(`locked = $${i++}`); vals.push(patch.locked); }
  if (patch.position2d !== undefined) { sets.push(`position_2d = $${i++}`); vals.push(patch.position2d ? JSON.stringify(patch.position2d) : null); }
  if (patch.position3d !== undefined) { sets.push(`position_3d = $${i++}`); vals.push(patch.position3d ? JSON.stringify(patch.position3d) : null); }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await pool.query(
    `UPDATE annotations SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0];
}

async function deleteAnnotation(id) {
  await pool.query(`DELETE FROM annotations WHERE id = $1`, [id]);
}

async function deleteAnnotationsByElement(elementId) {
  await pool.query(`DELETE FROM annotations WHERE element_id = $1`, [elementId]);
}

async function deleteAnnotationsByRoom(roomId) {
  await pool.query(`DELETE FROM annotations WHERE room_id = $1`, [roomId]);
}

// ─── Keynote Table ────────────────────────────────────────────────────────────

async function getKeynoteTable(projectId) {
  const res = await pool.query(
    `SELECT * FROM keynote_table WHERE project_id = $1 OR project_id IS NULL ORDER BY code`,
    [projectId]
  );
  return res.rows;
}

async function createKeynote({ projectId, code, description, category }) {
  const res = await pool.query(
    `INSERT INTO keynote_table (project_id, code, description, category)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [projectId, code, description, category || 'General']
  );
  return res.rows[0];
}

async function updateKeynote(id, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (patch.code !== undefined)        { sets.push(`code = $${i++}`); vals.push(patch.code); }
  if (patch.description !== undefined){ sets.push(`description = $${i++}`); vals.push(patch.description); }
  if (patch.category !== undefined)   { sets.push(`category = $${i++}`); vals.push(patch.category); }
  if (!sets.length) return null;
  vals.push(id);
  const res = await pool.query(
    `UPDATE keynote_table SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0];
}

async function deleteKeynote(id) {
  await pool.query(`DELETE FROM keynote_table WHERE id = $1`, [id]);
}

// ─── Hatching Patterns ────────────────────────────────────────────────────────

async function getHatchingPatterns() {
  const res = await pool.query(`SELECT * FROM hatching_patterns ORDER BY name`);
  return res.rows;
}

module.exports = {
  getAnnotationsByProject,
  getAnnotationsByElement,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  deleteAnnotationsByElement,
  deleteAnnotationsByRoom,
  getKeynoteTable,
  createKeynote,
  updateKeynote,
  deleteKeynote,
  getHatchingPatterns,
};