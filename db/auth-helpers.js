/**
 * Owns: shared auth utility functions (token generation, hashing).
 * Does NOT own: session storage, DB queries, middleware.
 */
const crypto = require('crypto');

function generateMagicToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  generateMagicToken,
  generateSessionToken,
  hashToken
};