/**
 * Owns: all DB queries for user_integrations table (Google Drive OAuth tokens).
 * Does NOT own: token encryption/decryption, OAuth flow, API calls.
 */
const pool = require('./index');

// Encrypt/decrypt helper — uses app-level ENCRYPTION_KEY env var.
// ENCRYPTION_KEY must be set. If absent, server refuses to start.
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const crypto = require('crypto');
const ALGORITHM = 'aes-256-gcm';
if (!process.env.ENCRYPTION_KEY) {
  console.error('[user-integrations] FATAL: ENCRYPTION_KEY env var is not set. OAuth tokens cannot be stored securely. Set ENCRYPTION_KEY to a 32-byte hex string.');
  process.exit(1);
}
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 bytes (hex or base64)

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '\u0000'), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  try {
    const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '\u0000'), 'utf8');
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    if (!ivHex || !tagHex || !encHex) return ciphertext;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext; // passthrough on decrypt failure
  }
}

// Upsert integration (creates or updates)
async function upsertIntegration(userId, provider, data) {
  const row = await pool.query(
    `INSERT INTO user_integrations
       (user_id, provider, access_token, refresh_token, token_type, expires_at, scope, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_type    = EXCLUDED.token_type,
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope,
       metadata_json = EXCLUDED.metadata_json,
       updated_at    = NOW()
     RETURNING *`,
    [
      userId, provider,
      encrypt(data.access_token),
      encrypt(data.refresh_token),
      data.token_type || 'Bearer',
      data.expires_at || null,
      data.scope || '',
      data.metadata_json || {}
    ]
  );
  return row.rows[0];
}

// Get integration by user+provider (returns plaintext tokens)
async function getIntegration(userId, provider) {
  const row = await pool.query(
    `SELECT * FROM user_integrations WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
  const r = row.rows[0];
  if (!r) return null;
  return {
    ...r,
    access_token:  decrypt(r.access_token),
    refresh_token: decrypt(r.refresh_token),
  };
}

// Update tokens only (token refresh flow)
async function updateTokens(userId, provider, tokens) {
  await pool.query(
    `UPDATE user_integrations SET
       access_token = $3, refresh_token = $4, token_type = $5,
       expires_at = $6, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`,
    [
      userId, provider,
      encrypt(tokens.access_token),
      encrypt(tokens.refresh_token || null),
      tokens.token_type || 'Bearer',
      tokens.expires_at || null
    ]
  );
}

// Disconnect — clear tokens but keep record
async function disconnectIntegration(userId, provider) {
  await pool.query(
    `UPDATE user_integrations SET
       access_token = NULL, refresh_token = NULL, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
}

// Delete integration record
async function deleteIntegration(userId, provider) {
  await pool.query(
    `DELETE FROM user_integrations WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
}

// Get all integrations for a user
async function getUserIntegrations(userId) {
  const rows = await pool.query(
    `SELECT * FROM user_integrations WHERE user_id = $1 ORDER BY connected_at DESC`,
    [userId]
  );
  return rows.rows.map(r => ({
    ...r,
    access_token:  undefined,  // never return tokens in list
    refresh_token: undefined,
  }));
}

// Get connection status
async function getConnectionStatus(userId, provider) {
  const row = await pool.query(
    `SELECT connected_at, expires_at FROM user_integrations
     WHERE user_id = $1 AND provider = $2 AND refresh_token IS NOT NULL`,
    [userId, provider]
  );
  return row.rows[0] || null;
}

module.exports = {
  upsertIntegration,
  getIntegration,
  updateTokens,
  disconnectIntegration,
  deleteIntegration,
  getUserIntegrations,
  getConnectionStatus,
};