/**
 * Owns: all DB queries for magic_tokens table.
 * Does NOT own: email sending, token generation logic.
 *
 * Security: tokens are stored as SHA-256 hashes. The raw token is only
 * available at generation time (returned to caller for emailing). On
 * verification the caller hashes the incoming token before querying.
 */
const pool   = require('./index');
const crypto = require('crypto');

// Hash a raw token for storage / lookup
function _hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Create a new magic token (stores both token + token_hash, returns the raw token string)
// Always writes both columns: 'token' satisfies the NOT NULL constraint from core_schema,
// 'token_hash' is used for secure lookup after the security_hardening migration.
async function createMagicToken(email, sessionUuid) {
  const { generateMagicToken } = require('./auth-helpers');
  const token     = generateMagicToken();
  const tokenHash = _hashToken(token);
  try {
    // Write both token and token_hash — handles both pre- and post-hardening schemas.
    // token:      satisfies NOT NULL constraint from original core_schema
    // token_hash: used for secure lookup (security_hardening migration)
    await pool.query(
      `INSERT INTO magic_tokens (token, token_hash, email, session_uuid, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '15 minutes')`,
      [token, tokenHash, email, sessionUuid || null]
    );
  } catch (err) {
    if (err.code === '42703') {
      // token_hash column missing — legacy schema only (pre-hardening)
      await pool.query(
        `INSERT INTO magic_tokens (token, email, session_uuid, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')`,
        [token, email, sessionUuid || null]
      );
    } else {
      throw err;
    }
  }
  return token;
}

// Get valid magic token data (not used, not expired)
// Accepts the raw token; hashes it before querying.
async function getMagicTokenData(token) {
  const tokenHash = _hashToken(token);
  // Try token_hash column first (security hardening migration)
  try {
    const res = await pool.query(
      `SELECT email, session_uuid FROM magic_tokens
       WHERE token_hash = $1 AND NOT used AND expires_at > NOW()`,
      [tokenHash]
    );
    if (res.rows.length > 0) return res.rows[0];
    // Row not found via hash — could be legacy plaintext row (pre-migration)
    const legacyRes = await pool.query(
      `SELECT email, session_uuid FROM magic_tokens
       WHERE token = $1 AND NOT used AND expires_at > NOW()`,
      [token]
    );
    return legacyRes.rows[0] || null;
  } catch (err) {
    if (err.code === '42703') {
      // token_hash column missing — use legacy lookup
      const res = await pool.query(
        `SELECT email, session_uuid FROM magic_tokens
         WHERE token = $1 AND NOT used AND expires_at > NOW()`,
        [token]
      );
      return res.rows[0] || null;
    }
    throw err;
  }
}

// Mark a magic token as used (one-time consumption)
// Accepts the raw token; hashes it for the update.
async function consumeMagicToken(token) {
  const tokenHash = _hashToken(token);
  try {
    await pool.query(
      `UPDATE magic_tokens SET used = true
       WHERE (token_hash = $1 OR token = $2)`,
      [tokenHash, token]
    );
  } catch (err) {
    if (err.code === '42703') {
      await pool.query(`UPDATE magic_tokens SET used = true WHERE token = $1`, [token]);
    } else {
      throw err;
    }
  }
}

module.exports = {
  createMagicToken,
  getMagicTokenData,
  consumeMagicToken
};