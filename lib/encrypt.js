/**
 * Encryption helpers.
 *
 * Production: uses @atlantist/core when installed (NODE_AUTH_TOKEN required
 * to install the private GitHub package). Until then, falls back to the
 * built-in implementation using ENCRYPTION_KEY env var.
 *
 * The built-in implementation is functionally equivalent — same AES-256-GCM
 * cipher, same format. @atlantist/core provides the canonical version once
 * the private package is wired into the build.
 */
'use strict';

const crypto = require('crypto');
const ALGO = 'aes-256-gcm';

let _core = null;
try { _core = require('@atlantist/core').encrypt; } catch { /* not installed yet */ }

function _key() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length < 32) throw new Error('ENCRYPTION_KEY env var is required (min 32 chars)');
  // Accept both hex (64 chars → 32 bytes) and raw 32-char strings
  return k.length === 64 ? Buffer.from(k, 'hex') : Buffer.from(k.slice(0, 32), 'utf8');
}

function encrypt(text) {
  if (_core) return _core.encrypt(text);
  if (!text && text !== 0) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(ciphertext) {
  if (_core) return _core.decrypt(ciphertext);
  if (!ciphertext) return null;
  const [ivHex, tagHex, encHex] = String(ciphertext).split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid ciphertext format');
  const decipher = crypto.createDecipheriv(ALGO, _key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}

function encryptJSON(obj) { return encrypt(JSON.stringify(obj)); }
function decryptJSON(c) { const p = decrypt(c); return p ? JSON.parse(p) : null; }

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON };
