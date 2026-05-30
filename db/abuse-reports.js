/**
 * Owns: all DB queries for abuse_reports and project lock_status.
 * Does NOT own: admin scan records (db/abuse.js), routing, Stripe coupons.
 */
const pool = require('./index');

// Create a new abuse report. Returns the created report.
async function createAbuseReport({ project_id, reporter_user_id, reason, description }) {
  const res = await pool.query(
    `INSERT INTO abuse_reports (project_id, reporter_user_id, reason, description)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [project_id, reporter_user_id, reason, description]
  );
  return res.rows[0];
}

// Count distinct reporters for a project (pending/upheld reports only).
async function countDistinctReporters(project_id) {
  const res = await pool.query(
    `SELECT COUNT(DISTINCT reporter_user_id) AS cnt
     FROM abuse_reports
     WHERE project_id = $1 AND status IN ('pending', 'upheld')`,
    [project_id]
  );
  return parseInt(res.rows[0].cnt, 10);
}

// Check if reporter has already filed a report for this project.
async function reporterAlreadyFiled(project_id, reporter_user_id) {
  const res = await pool.query(
    `SELECT id FROM abuse_reports WHERE project_id = $1 AND reporter_user_id = $2 LIMIT 1`,
    [project_id, reporter_user_id]
  );
  return res.rows.length > 0;
}

// Set lock_status on a project.
async function setProjectLockStatus(project_id, lock_status) {
  await pool.query(
    `UPDATE projects SET lock_status = $1 WHERE id = $2`,
    [lock_status, project_id]
  );
}

// Get project lock status.
async function getProjectLockStatus(project_id) {
  const res = await pool.query(
    `SELECT lock_status FROM projects WHERE id = $1`,
    [project_id]
  );
  return res.rows[0]?.lock_status || 'none';
}

// Get project owner user id.
async function getProjectOwnerId(project_id) {
  const res = await pool.query(
    `SELECT user_id FROM project_members WHERE project_id = $1 AND role = 'owner' LIMIT 1`,
    [project_id]
  );
  return res.rows[0]?.user_id || null;
}

// Paginated list of all reports for admin queue.
async function listAbuseReports({ status, limit = 50, offset = 0 }) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`ar.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const res = await pool.query(
    `SELECT ar.*,
            p.name AS project_name, p.created_at AS project_created_at,
            p.settings AS project_settings,
            reporter.email AS reporter_email,
            owner_m.user_id AS owner_user_id,
            owner_u.email AS owner_email
     FROM abuse_reports ar
     JOIN projects p ON p.id = ar.project_id
     JOIN app_users reporter ON reporter.id = ar.reporter_user_id
     LEFT JOIN project_members owner_m ON owner_m.project_id = ar.project_id AND owner_m.role = 'owner'
     LEFT JOIN app_users owner_u ON owner_u.id = owner_m.user_id
     ${where}
     ORDER BY ar.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
}

// Get a single report by id.
async function getAbuseReportById(id) {
  const res = await pool.query(
    `SELECT ar.*,
            p.name AS project_name, p.created_at AS project_created_at,
            reporter.email AS reporter_email,
            owner_m.user_id AS owner_user_id,
            owner_u.email AS owner_email
     FROM abuse_reports ar
     JOIN projects p ON p.id = ar.project_id
     JOIN app_users reporter ON reporter.id = ar.reporter_user_id
     LEFT JOIN project_members owner_m ON owner_m.project_id = ar.project_id AND owner_m.role = 'owner'
     LEFT JOIN app_users owner_u ON owner_u.id = owner_m.user_id
     WHERE ar.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

// Decide a report: uphold or dismiss.
async function decideAbuseReport(id, decided_by, decision, notes) {
  const res = await pool.query(
    `UPDATE abuse_reports
     SET status = $1, decided_at = NOW(), decided_by = $2, decision_notes = $3
     WHERE id = $4 RETURNING *`,
    [decision === 'uphold' ? 'upheld' : 'dismissed', decided_by, notes || null, id]
  );
  return res.rows[0] || null;
}

// Get all reports for a specific project (for owner-facing banner data).
async function getReportsForProject(project_id) {
  const res = await pool.query(
    `SELECT id, status, created_at FROM abuse_reports WHERE project_id = $1 ORDER BY created_at DESC`,
    [project_id]
  );
  return res.rows;
}

// Get the reporter's own report for a project (to show "you reported" banner).
async function getMyReportForProject(project_id, reporter_user_id) {
  const res = await pool.query(
    `SELECT id, status, created_at FROM abuse_reports
     WHERE project_id = $1 AND reporter_user_id = $2 LIMIT 1`,
    [project_id, reporter_user_id]
  );
  return res.rows[0] || null;
}

// Get Stripe customer ID for a user (for coupon issuance).
async function getStripeCustomerId(user_id) {
  const res = await pool.query(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 LIMIT 1`,
    [user_id]
  );
  return res.rows[0]?.stripe_customer_id || null;
}

module.exports = {
  createAbuseReport,
  countDistinctReporters,
  reporterAlreadyFiled,
  setProjectLockStatus,
  getProjectLockStatus,
  getProjectOwnerId,
  listAbuseReports,
  getAbuseReportById,
  decideAbuseReport,
  getReportsForProject,
  getMyReportForProject,
  getStripeCustomerId
};
