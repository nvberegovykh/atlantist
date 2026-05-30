/**
 * Owns: all DB queries for invites table.
 * Does NOT own: email sending, token generation logic.
 */
const pool = require('./index');
const crypto = require('crypto');

// Generate a secure invite token
function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Create invite
async function createInvite(data) {
  const { email, project_id, invited_by_user_id, role = 'member', expires_days = 7 } = data;
  const token = generateInviteToken();
  const res = await pool.query(
    `INSERT INTO invites (token, email, project_id, invited_by_user_id, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${expires_days} days')
     RETURNING *`,
    [token, email, project_id, invited_by_user_id, role]
  );
  return res.rows[0];
}

// Get invite by token
async function getInviteByToken(token) {
  const res = await pool.query(
    `SELECT i.*, p.name as project_name, u.first_name as invited_by_name
     FROM invites i
     LEFT JOIN projects p ON i.project_id = p.id
     LEFT JOIN app_users u ON i.invited_by_user_id = u.id
     WHERE i.token = $1`,
    [token]
  );
  return res.rows[0] || null;
}

// Accept invite
async function acceptInvite(token, userId) {
  const res = await pool.query(
    `UPDATE invites SET status = 'accepted', accepted_at = NOW()
     WHERE token = $1 AND status = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [token]
  );
  return res.rows[0] || null;
}

// Decline invite
async function declineInvite(token) {
  await pool.query(
    `UPDATE invites SET status = 'declined' WHERE token = $1`,
    [token]
  );
}

// Mark invite as expired
async function expireInvite(id) {
  await pool.query(`UPDATE invites SET status = 'expired' WHERE id = $1`, [id]);
}

// Get pending invites for email
async function getPendingInvitesForEmail(email) {
  const res = await pool.query(
    `SELECT i.*, p.name as project_name
     FROM invites i
     LEFT JOIN projects p ON i.project_id = p.id
     WHERE i.email = $1 AND i.status = 'pending' AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [email]
  );
  return res.rows;
}

// Get invites for a project
async function getProjectInvites(projectId) {
  const res = await pool.query(
    `SELECT i.*, u.first_name as invited_by_name
     FROM invites i
     LEFT JOIN app_users u ON i.invited_by_user_id = u.id
     WHERE i.project_id = $1
     ORDER BY i.created_at DESC`,
    [projectId]
  );
  return res.rows;
}

// Get invites sent by user
async function getUserSentInvites(userId) {
  const res = await pool.query(
    `SELECT i.*, p.name as project_name
     FROM invites i
     LEFT JOIN projects p ON i.project_id = p.id
     WHERE i.invited_by_user_id = $1
     ORDER BY i.created_at DESC`,
    [userId]
  );
  return res.rows;
}

// Cleanup expired invites (called periodically)
async function cleanupExpiredInvites() {
  const res = await pool.query(
    `UPDATE invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()`
  );
  return res.rowCount;
}

module.exports = {
  generateInviteToken,
  createInvite,
  getInviteByToken,
  acceptInvite,
  declineInvite,
  expireInvite,
  getPendingInvitesForEmail,
  getProjectInvites,
  getUserSentInvites,
  cleanupExpiredInvites
};