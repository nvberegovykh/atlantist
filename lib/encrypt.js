/**
 * Encryption helpers — implementation lives in @atlantist/core (private).
 * This module provides a thin interface so the public codebase never contains
 * the cipher implementation or key-handling logic.
 *
 * In production: @atlantist/core is installed via GitHub npm package using
 * NODE_AUTH_TOKEN (a GitHub PAT with repo scope, set as Render secret).
 *
 * In development without @atlantist/core: falls back to a local dev-only
 * implementation that warns loudly and refuses to run in production.
 */
'use strict';

let _impl;
try {
  _impl = require('@atlantist/core').encrypt;
} catch {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[encrypt] @atlantist/core is required in production. Set NODE_AUTH_TOKEN and run npm install.');
  }
  // Dev fallback — warns but doesn't crash local dev without the private package
  const crypto = require('crypto');
  const ALGO = 'aes-256-gcm';
  const DEV_KEY = Buffer.alloc(32, 0); // zero key — dev only, never encrypts real data
  console.warn('[encrypt] WARNING: Using dev fallback encryption. @atlantist/core not installed.');
  _impl = {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, DEV_KEY, iv);
      const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc.toString('hex');
    },
    decrypt(ciphertext) {
      const [ivHex, tagHex, encHex] = ciphertext.split(':');
      const d = crypto.createDecipheriv(ALGO, DEV_KEY, Buffer.from(ivHex, 'hex'));
      d.setAuthTag(Buffer.from(tagHex, 'hex'));
      return d.update(Buffer.from(encHex, 'hex')) + d.final('utf8');
    },
    encryptJSON: (obj) => _impl.encrypt(JSON.stringify(obj)),
    decryptJSON: (c) => { const p = _impl.decrypt(c); return p ? JSON.parse(p) : null; },
  };
}

module.exports = _impl;
