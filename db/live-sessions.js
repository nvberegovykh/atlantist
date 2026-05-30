/**
 * Owns: live_sessions and live_session_participants DB queries.
 * Does NOT own: WebSocket routing, WS broadcast logic, session expiration cleanup.
 */
const pool = require('./index');
const crypto = require('crypto');

function generateShareToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function createSession({ projectId, hostUserId, mode = 'view', ttlHours = 24 }) {
  const token = generateShareToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3600000).toISOString();
  const res = await pool.query(
    `INSERT INTO live_sessions (project_id, host_user_id, share_token, mode, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [projectId, hostUserId, token, mode, expiresAt]
  );
  return res.rows[0];
}

async function getSessionByToken(token) {
  const res = await pool.query(
    `SELECT * FROM live_sessions WHERE share_token = $1 AND expires_at > NOW()`,
    [token]
  );
  return res.rows[0] || null;
}

async function getSessionById(id) {
  const res = await pool.query(`SELECT * FROM live_sessions WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function getParticipants(sessionId) {
  const res = await pool.query(
    `SELECT * FROM live_session_participants WHERE session_id = $1 ORDER BY joined_at`,
    [sessionId]
  );
  return res.rows;
}

async function upsertParticipant({ sessionId, userId, isGuest = false, guestHandle = null, color }) {
  const res = await pool.query(
    `INSERT INTO live_session_participants (session_id, user_id, is_guest, guest_handle, color)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, user_id) DO UPDATE SET
       last_seen_at = NOW(),
       color = EXCLUDED.color
     RETURNING *`,
    [sessionId, userId, isGuest, guestHandle, color]
  );
  return res.rows[0];
}

async function updateParticipantCursor(sessionId, userId, cursorX, cursorY) {
  await pool.query(
    `UPDATE live_session_participants
     SET cursor_x = $3, cursor_y = $4, last_seen_at = NOW()
     WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId, cursorX, cursorY]
  );
}

async function updateParticipantViewport(sessionId, userId, viewportStateJson) {
  await pool.query(
    `UPDATE live_session_participants
     SET viewport_state_json = $3, last_seen_at = NOW()
     WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId, viewportStateJson]
  );
}

async function removeParticipant(sessionId, userId) {
  await pool.query(
    `DELETE FROM live_session_participants WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
}

async function cleanExpiredSessions() {
  await pool.query(`DELETE FROM live_sessions WHERE expires_at < NOW()`);
}

module.exports = {
  createSession,
  getSessionByToken,
  getSessionById,
  getParticipants,
  upsertParticipant,
  updateParticipantCursor,
  updateParticipantViewport,
  removeParticipant,
  cleanExpiredSessions,
  generateShareToken,
};