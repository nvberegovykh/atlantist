/**
 * AES-256-GCM encryption helpers for sensitive fields (e.g. GitHub access tokens).
 *
 * Requires ENCRYPTION_KEY env — a 64-char hex string (32 bytes).
 * Format of encrypted value: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param {string} text - Plaintext to encrypt.
 * @returns {string} Encrypted string in "iv:tag:ciphertext" hex format.
 */
function encrypt(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32-byte hex
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a value encrypted by {@link encrypt}.
 * @param {string} enc - Encrypted string in "iv:tag:ciphertext" hex format.
 * @returns {string} Decrypted plaintext.
 */
function decrypt(enc) {
  const [ivHex, tagHex, encHex] = enc.split(':');
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
