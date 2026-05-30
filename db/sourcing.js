/**
 * Owns: crafting_source_cache CRUD.
 * Does NOT own: sourcing logic (services/sourcing-engine.js).
 */
const pool = require('./index');

// ── crafting_source_cache ─────────────────────────────────────────────────────

async function setSourcingCache(userId, query, channels, data) {
  const r = await pool.query(
    `INSERT INTO crafting_source_cache (user_id, query, channels, cached_data)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, query, channels)
     DO UPDATE SET cached_data=$4, cached_at=NOW()
     RETURNING *`,
    [userId, query, channels || 'retail,secondary,fabrication', data]
  );
  return r.rows[0];
}

async function getSourcingCache(userId, query, channels) {
  const r = await pool.query(
    `SELECT * FROM crafting_source_cache
     WHERE user_id=$1 AND query=$2 AND channels=$3
       AND cached_at > NOW() - INTERVAL '30 minutes'`,
    [userId, query, channels || 'retail,secondary,fabrication']
  );
  return r.rows[0] || null;
}

async function deleteSourcingCache(userId) {
  await pool.query(`DELETE FROM crafting_source_cache WHERE user_id=$1`, [userId]);
}

async function pruneExpiredCache(olderThanHours = 48) {
  const r = await pool.query(
    `DELETE FROM crafting_source_cache WHERE cached_at < NOW() - $1`,
    [`${olderThanHours} hours`]
  );
  return r.rowCount;
}

module.exports = {
  setSourcingCache,
  getSourcingCache,
  deleteSourcingCache,
  pruneExpiredCache,
};