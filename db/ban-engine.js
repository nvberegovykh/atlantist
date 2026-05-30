/**
 * Owns: DB queries for banned_models table and account_status/grace fields on app_users.
 * Does NOT own: Stripe coupon creation, email sending, or session invalidation (those stay in services/ban-engine.js).
 */
const pool = require('./index');

// Write a sentinel row to banned_models for legal-hold audit trail.
async function insertBannedModel({ model_id, owner_user_id, decided_by, report_id, notes }) {
  const res = await pool.query(
    `INSERT INTO banned_models (model_id, owner_user_id, decided_by, report_id, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [model_id, owner_user_id || null, decided_by || null, report_id || null, notes || null]
  );
  return res.rows[0];
}

// Hard-delete a project and all its child rows (event_ledger, renders, elements, levels, issues).
// Caller must already have written the banned_models sentinel row.
async function hardDeleteProject(project_id) {
  // Cascade-delete in dependency order. family_instances cascade via wall FK.
  await pool.query(`DELETE FROM renders WHERE project_id = $1`, [project_id]);
  await pool.query(`DELETE FROM event_ledger WHERE project_id = $1`, [project_id]);
  await pool.query(`DELETE FROM issues WHERE project_id = $1`, [project_id]);
  await pool.query(`DELETE FROM elements WHERE project_id = $1`, [project_id]);
  await pool.query(`DELETE FROM levels WHERE project_id = $1`, [project_id]);
  // project_members cascade-deletes on project
  await pool.query(`DELETE FROM projects WHERE id = $1`, [project_id]);
}

// Set account_status + grace_expires_at on a user.
async function setAccountStatus(user_id, status, grace_expires_at = null) {
  await pool.query(
    `UPDATE app_users SET account_status = $1, grace_expires_at = $2 WHERE id = $3`,
    [status, grace_expires_at, user_id]
  );
}

// Get a user's current account_status.
async function getAccountStatus(user_id) {
  const res = await pool.query(
    `SELECT account_status, grace_expires_at FROM app_users WHERE id = $1`,
    [user_id]
  );
  return res.rows[0] || null;
}

// Find users whose grace window has expired (for the suspension cron job).
async function getExpiredGraceUsers() {
  const res = await pool.query(
    `SELECT id, email, first_name FROM app_users
     WHERE account_status = 'grace_export_only' AND grace_expires_at <= NOW()`
  );
  return res.rows;
}

// Invalidate all auth sessions for a user (force-logout).
async function invalidateAllSessions(user_id) {
  await pool.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [user_id]);
}

// Record acceptable-use acknowledgement on a user.
async function recordAcceptableUseAck(user_id, { ip, user_agent }) {
  await pool.query(
    `UPDATE app_users
     SET acceptable_use_ack_at = NOW(),
         acceptable_use_ack_ip = $2,
         acceptable_use_ack_ua = $3
     WHERE id = $1`,
    [user_id, ip || null, user_agent || null]
  );
}

// Check whether a user has acknowledged the acceptable-use terms.
async function hasAcceptableUseAck(user_id) {
  const res = await pool.query(
    `SELECT acceptable_use_ack_at FROM app_users WHERE id = $1`,
    [user_id]
  );
  return !!res.rows[0]?.acceptable_use_ack_at;
}

// Get Stripe customer ID from the subscriptions table.
async function getStripeCustomerId(user_id) {
  const res = await pool.query(
    `SELECT stripe_customer_id, stripe_subscription_id
     FROM subscriptions WHERE user_id = $1 LIMIT 1`,
    [user_id]
  );
  return res.rows[0] || null;
}

module.exports = {
  insertBannedModel,
  hardDeleteProject,
  setAccountStatus,
  getAccountStatus,
  getExpiredGraceUsers,
  invalidateAllSessions,
  recordAcceptableUseAck,
  hasAcceptableUseAck,
  getStripeCustomerId
};
