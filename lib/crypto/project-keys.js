/**
 * Project Key Derivation — AES-256-GCM at-rest encryption for BIM project data.
 *
 * Architecture:
 *   Master secret:  ATLANTIST_MASTER_KEY env var (32-byte hex = 64 hex chars)
 *                   Generated once per deployment, stored in Render env vars.
 *                   NEVER logged, NEVER committed, NEVER sent to client.
 *
 *   Per-project key: HKDF-SHA256(master, salt=project_id_bytes, info='atlantist-project-v1')
 *                    → 32-byte AES-256-GCM key
 *                    Derived deterministically — no need to store the key itself.
 *                    Only a verification tag (SHA-256 of derived key) is stored
 *                    in project_data_keys to detect master key rotation.
 *
 *   Encryption:     AES-256-GCM with a random 12-byte IV per encrypt call.
 *                   Output format: base64(iv[12] + ciphertext + authTag[16])
 *                   AuthTag provides integrity + authenticity (tamper detection).
 *
 *   Envelope fields encrypted per-project:
 *     - elements JSON (walls, doors, windows, columns, etc.)
 *     - IFC import buffer contents
 *     - User-supplied notes / markup text
 *     - Wallt conversation history (per user × project)
 *
 *   Fields NOT encrypted (needed for indexing/search):
 *     - project name, type, settings
 *     - user email, profile data
 *     - presence/collaboration metadata
 *
 * Usage:
 *   const { encrypt, decrypt, deriveKey, ensureProjectKey } = require('./project-keys');
 *
 *   // Encrypt element JSON before storing
 *   const enc = encrypt(JSON.stringify(elementsArray), projectId);
 *   await db.query('UPDATE projects SET elements_enc = $1 WHERE id = $2', [enc, projectId]);
 *
 *   // Decrypt on read
 *   const raw = decrypt(row.elements_enc, projectId);
 *   const elements = JSON.parse(raw);
 */
'use strict';

const crypto = require('crypto');
const db     = require('../../db/index');

const ALGO     = 'aes-256-gcm';
const IV_LEN   = 12;  // bytes — GCM standard
const TAG_LEN  = 16;  // bytes — GCM auth tag
const KEY_LEN  = 32;  // bytes — AES-256
const INFO     = Buffer.from('atlantist-project-v1');

// ── Master key ────────────────────────────────────────────────────────────────
function getMasterKey() {
  const hex = process.env.ATLANTIST_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    // Encryption is optional — if key not set, data is stored plaintext with a warning.
    // Production deployments MUST set this env var.
    return null;
  }
  return Buffer.from(hex, 'hex');
}

// ── HKDF-SHA256 key derivation ────────────────────────────────────────────────
/**
 * Derive a 32-byte AES-256 key for a specific project.
 * Deterministic: same master key + projectId always produces same derived key.
 *
 * @param {number} projectId
 * @returns {Buffer|null}  null when master key is not configured
 */
function deriveKey(projectId) {
  const master = getMasterKey();
  if (!master) return null;

  // Salt: project_id as 4-byte big-endian buffer (unique per project)
  const salt = Buffer.alloc(4);
  salt.writeUInt32BE(projectId >>> 0, 0);

  // HKDF: extract + expand
  // extract: HMAC-SHA256(salt, master)
  const prk = crypto.createHmac('sha256', salt).update(master).digest();
  // expand: HMAC-SHA256(prk, info || 0x01)
  const okm = crypto.createHmac('sha256', prk).update(Buffer.concat([INFO, Buffer.from([1])])).digest();
  return okm.slice(0, KEY_LEN);
}

// ── Encrypt ───────────────────────────────────────────────────────────────────
/**
 * Encrypt a plaintext string for a given project.
 * Returns a base64-encoded envelope: iv(12) + ciphertext + authTag(16).
 *
 * If master key is not configured, returns the plaintext unchanged (with warning).
 *
 * @param {string} plaintext
 * @param {number} projectId
 * @returns {string}
 */
function encrypt(plaintext, projectId) {
  const key = deriveKey(projectId);
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[crypto] ATLANTIST_MASTER_KEY not set — data stored unencrypted!');
    }
    return plaintext; // graceful degradation
  }

  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });

  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Envelope: iv(12) + authTag(16) + ciphertext
  const envelope = Buffer.concat([iv, tag, ct]);
  return 'enc1:' + envelope.toString('base64'); // version prefix for future rotation
}

// ── Decrypt ───────────────────────────────────────────────────────────────────
/**
 * Decrypt an encrypted envelope string.
 *
 * @param {string} envelopeOrPlaintext  — may be plaintext if encryption was not active
 * @param {number} projectId
 * @returns {string}
 */
function decrypt(envelopeOrPlaintext, projectId) {
  if (!envelopeOrPlaintext) return '';
  if (!envelopeOrPlaintext.startsWith('enc1:')) return envelopeOrPlaintext; // plaintext passthrough

  const key = deriveKey(projectId);
  if (!key) {
    console.error('[crypto] Cannot decrypt: ATLANTIST_MASTER_KEY not set');
    return ''; // return empty rather than crash
  }

  const buf    = Buffer.from(envelopeOrPlaintext.slice(5), 'base64');
  const iv     = buf.slice(0, IV_LEN);
  const tag    = buf.slice(IV_LEN, IV_LEN + TAG_LEN);
  const ct     = buf.slice(IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);

  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    console.error('[crypto] Decryption failed (tampered data or wrong key):', err.message);
    return ''; // integrity failure — return empty, caller must handle
  }
}

// ── Key verification tag ──────────────────────────────────────────────────────
/**
 * Compute the verification tag for a project's derived key.
 * Stored in project_data_keys.key_tag to detect master key rotation.
 *
 * @param {number} projectId
 * @returns {string|null}  hex SHA-256 of derived key, or null if no master key
 */
function keyTag(projectId) {
  const key = deriveKey(projectId);
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ── Ensure project key record ─────────────────────────────────────────────────
/**
 * Ensure a project_data_keys row exists for this project.
 * Called on project creation and before first encrypt.
 * Non-fatal — logs warning if encryption is disabled.
 *
 * @param {number} projectId
 */
async function ensureProjectKey(projectId) {
  const tag = keyTag(projectId);
  if (!tag) return; // encryption disabled — nothing to store

  await db.query(
    `INSERT INTO project_data_keys (project_id, key_tag)
     VALUES ($1, $2)
     ON CONFLICT (project_id) DO NOTHING`,
    [projectId, tag]
  );
}

// ── File content hash ─────────────────────────────────────────────────────────
/**
 * SHA-256 hash of a Buffer or string for integrity verification.
 * Stored in file_uploads.sha256 at upload time, verified at download.
 *
 * @param {Buffer|string} content
 * @returns {string}  hex digest
 */
function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── Generate master key (setup utility) ──────────────────────────────────────
/**
 * Generate a new 256-bit master key (run once, store in Render env vars).
 * Only call this in a setup context — NEVER in production code paths.
 *
 * @returns {string}  64-char hex string
 */
function generateMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  encrypt,
  decrypt,
  deriveKey,
  keyTag,
  ensureProjectKey,
  contentHash,
  generateMasterKey,
};
