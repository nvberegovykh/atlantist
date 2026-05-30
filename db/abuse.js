/**
 * Owns: abuse scan records, flagged models, and abuse log queries.
 * Does NOT own: scan execution (jobs/deep-abuse-scan.js), admin UI routing.
 */
const pool = require('./index');
const { getUserRole } = require('./roles');

async function requireAdminSession(token) {
  const session = await pool.query(
    `SELECT user_id FROM auth_sessions WHERE token_hash = $1 AND expires_at > NOW()`,
    [token]
  );
  if (!session.rows.length) return null;
  return { user_id: session.rows[0].user_id };
}

async function getAbuseScans() {
  const res = await pool.query(`
    SELECT id, scan_type, status, started_at, completed_at,
           models_scanned, models_flagged, tier1_count, tier2_count, tier3_count,
           accounts_suspended, error_log
    FROM abuse_scan_records
    ORDER BY started_at DESC
    LIMIT 20
  `);
  return res.rows;
}

async function getAbusePendingModels() {
  const res = await pool.query(`
    SELECT afm.*, u.email as owner_email, u.suspended_at as owner_suspended_at
    FROM abuse_flagged_models afm
    LEFT JOIN users u ON u.id = afm.owner_user_id
    WHERE afm.resolution = 'pending'
    ORDER BY afm.tier ASC, afm.created_at DESC
    LIMIT 100
  `);
  return res.rows;
}

async function getAbuseRecentActions() {
  const res = await pool.query(`
    SELECT al.*, afm.model_type, afm.model_id, u.email as actor_email
    FROM abuse_log al
    LEFT JOIN abuse_flagged_models afm ON afm.id = al.flagged_model_id
    LEFT JOIN users u ON u.id = al.actor_user_id
    ORDER BY al.created_at DESC
    LIMIT 50
  `);
  return res.rows;
}

async function getFlaggedModel(id) {
  const res = await pool.query(`SELECT * FROM abuse_flagged_models WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function suspendUser(userId) {
  await pool.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
  await pool.query(`UPDATE users SET suspended_at = NOW() WHERE id = $1 AND suspended_at IS NULL`, [userId]);
}

async function resolveFlaggedModel(id, resolution, actorId) {
  const res = await pool.query(
    `UPDATE abuse_flagged_models SET resolution = $2, resolved_at = NOW() WHERE id = $1 RETURNING *`,
    [id, resolution]
  );
  return res.rows[0] || null;
}

async function logAbuseAction(flaggedModelId, actorUserId, action, details) {
  const res = await pool.query(
    `INSERT INTO abuse_log (flagged_model_id, actor_user_id, action, details)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [flaggedModelId, actorUserId, action, details]
  );
  return res.rows[0];
}

async function getScanRecord(id) {
  const res = await pool.query(`SELECT * FROM abuse_scan_records WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function getFlaggedModelsByScan(scanId) {
  const res = await pool.query(`
    SELECT afm.*, u.email as owner_email
    FROM abuse_flagged_models afm
    LEFT JOIN users u ON u.id = afm.owner_user_id
    WHERE afm.scan_id = $1
    ORDER BY afm.tier ASC, afm.created_at DESC
  `, [scanId]);
  return res.rows;
}

async function eraseModel(modelType, modelId) {
  const erasures = {
    element: `DELETE FROM elements WHERE id = $1`,
    family_instance: `DELETE FROM family_instances WHERE id = $1`,
    energy_simulation: `DELETE FROM energy_simulations WHERE id = $1`,
    fire_protection_run: `DELETE FROM fire_protection_runs WHERE id = $1`,
    geotechnical_run: `DELETE FROM geotechnical_runs WHERE id = $1`,
    design_book_placeholder: `DELETE FROM design_book_placeholders WHERE id = $1`,
  };
  const sql = erasures[modelType];
  if (!sql) throw new Error(`Unknown model type: ${modelType}`);
  await pool.query(sql, [modelId]);
}

async function updateFlaggedModelResolved(id, resolution, resolvedBy) {
  await pool.query(
    `UPDATE abuse_flagged_models SET resolution = $1, resolved_at = NOW(), resolved_by = $2 WHERE id = $3`,
    [resolution, resolvedBy, id]
  );
}

module.exports = {
  requireAdminSession,
  getAbuseScans,
  getAbusePendingModels,
  getAbuseRecentActions,
  getFlaggedModel,
  suspendUser,
  resolveFlaggedModel,
  logAbuseAction,
  getScanRecord,
  getFlaggedModelsByScan,
  eraseModel,
  updateFlaggedModelResolved
};