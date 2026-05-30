/**
 * Owns: app_updates (changelog/What's New) and app_update_seen (read receipts).
 * Does NOT own: UI rendering of update banners.
 */
const pool = require('./index');

// ─── Updates ─────────────────────────────────────────────────────────────────

async function getLatestUnseenForUser(userId, limit = 5) {
  const res = await pool.query(
    `SELECT u.id, u.title, u.body, u.version, u.category, u.badge,
            u.action_url, u.action_label, u.created_at
     FROM app_updates u
     WHERE NOT EXISTS (
       SELECT 1 FROM app_update_seen s
       WHERE s.update_id = u.id AND s.user_id = $1
     )
     ORDER BY u.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

async function getRecentUpdates(limit = 10) {
  const res = await pool.query(
    `SELECT id, title, body, version, category, badge,
            action_url, action_label, created_at
     FROM app_updates ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function markUpdateSeen(updateId, userId) {
  await pool.query(
    `INSERT INTO app_update_seen (update_id, user_id, seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT DO NOTHING`,
    [updateId, userId]
  );
}

async function createUpdate(data) {
  const { title, body, version, category = 'feature', badge, action_url, action_label } = data;
  const res = await pool.query(
    `INSERT INTO app_updates (title, body, version, category, badge, action_url, action_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [title, body, version, category, badge, action_url, action_label]
  );
  return res.rows[0];
}

async function listUpdates(filters = {}) {
  const { category, limit = 20, offset = 0 } = filters;
  let query = 'SELECT * FROM app_updates WHERE 1=1';
  const params = [];
  let i = 1;
  if (category) {
    query += ` AND category = $${i++}`;
    params.push(category);
  }
  query += ` ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`;
  params.push(parseInt(limit, 10), parseInt(offset, 10));
  const res = await pool.query(query, params);
  return res.rows;
}

module.exports = {
  getLatestUnseenForUser,
  getRecentUpdates,
  markUpdateSeen,
  createUpdate,
  listUpdates,
};