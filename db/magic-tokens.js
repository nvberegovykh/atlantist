/**
 * Owns: all DB queries for magic_tokens table.
 * Does NOT own: email sending, token generation logic.
 */
const pool = require('./index');

// Create a new magic token (returns the raw token string)
async function createMagicToken(email, sessionUuid) {
  const { generateMagicToken } = require('./auth-helpers');
  const token = generateMagicToken();
  await pool.query(
    `INSERT INTO magic_tokens (token, email, session_uuid, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')`,
    [token, email, sessionUuid || null]
  );
  return token;
}

// Get valid magic token data (not used, not expired)
async function getMagicTokenData(token) {
  const res = await pool.query(
    `SELECT email, session_uuid FROM magic_tokens
     WHERE token = $1 AND NOT used AND expires_at > NOW()`,
    [token]
  );
  return res.rows[0] || null;
}

// Mark a magic token as used (one-time consumption)
async function consumeMagicToken(token) {
  await pool.query(`UPDATE magic_tokens SET used = true WHERE token = $1`, [token]);
}

module.exports = {
  createMagicToken,
  getMagicTokenData,
  consumeMagicToken
};