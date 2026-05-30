/**
 * Owns: all DB queries for AI renders and Twinmotion export metadata.
 * Does NOT own: image generation, file export, HTTP routing.
 */
const pool = require('./index');

async function createRender({ style, imageUrl, thumbnailUrl, viewpointName, cameraData, promptUsed, sourceCanvas }) {
  const res = await pool.query(
    `INSERT INTO renders (style, image_url, thumbnail_url, viewpoint_name, camera_data, prompt_used, source_canvas)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [style, imageUrl, thumbnailUrl || null, viewpointName || 'Unnamed View', JSON.stringify(cameraData || {}), promptUsed || null, sourceCanvas || '3d']
  );
  return res.rows[0];
}

async function getAllRenders() {
  const res = await pool.query(
    `SELECT * FROM renders ORDER BY created_at DESC LIMIT 100`
  );
  return res.rows;
}

async function getRenderById(id) {
  const res = await pool.query(`SELECT * FROM renders WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function deleteRender(id) {
  await pool.query(`DELETE FROM renders WHERE id = $1`, [id]);
}

module.exports = { createRender, getAllRenders, getRenderById, deleteRender };