/**
 * Owns: all DB queries for auth_sessions table.
 * Does NOT own: session token generation, cookie settings, middleware logic.
 */
const pool = require('./index');
const crypto = require('crypto');

// Generate a secure session token
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash a token for storage
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Create session for user
async function createSession(userId) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const res = await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')
     RETURNING *`,
    [userId, tokenHash]
  );
  // Return plain token (only time it's available)
  return { session: res.rows[0], token };
}

// Get session by token hash
async function getSessionByToken(token) {
  const tokenHash = hashToken(token);
  const res = await pool.query(
    `SELECT s.*, u.id as user_id, u.email, u.first_name, u.project_type, u.role, u.specializations, u.location
     FROM auth_sessions s
     JOIN app_users u ON s.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );
  return res.rows[0] || null;
}

// Invalidate session (logout)
async function invalidateSession(token) {
  const tokenHash = hashToken(token);
  await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
}

// Invalidate all sessions for user
async function invalidateAllUserSessions(userId) {
  await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
}

// Extend session (touch last_active)
async function touchSession(token) {
  const tokenHash = hashToken(token);
  await pool.query(
    'UPDATE auth_sessions SET last_active = NOW() WHERE token_hash = $1',
    [tokenHash]
  );
}

// Cleanup expired sessions
async function cleanupExpiredSessions() {
  const res = await pool.query(
    'DELETE FROM auth_sessions WHERE expires_at < NOW()'
  );
  return res.rowCount;
}

// Get active session count for user
async function getActiveSessionCount(userId) {
  const res = await pool.query(
    'SELECT COUNT(*) FROM auth_sessions WHERE user_id = $1 AND expires_at > NOW()',
    [userId]
  );
  return parseInt(res.rows[0].count, 10);
}

module.exports = {
  generateSessionToken,
  hashToken,
  createSession,
  getSessionByToken,
  invalidateSession,
  invalidateAllUserSessions,
  touchSession,
  cleanupExpiredSessions,
  getActiveSessionCount
};