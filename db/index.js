/**
 * Database connection pool.
 * Owns: the single Pool instance used by all db/* modules.
 * Does NOT own: query logic, business rules, migrations.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

/**
 * Strict integer coercion for DB integer columns.
 * parseInt("3962af23-...", 10) = 3962 — a partial hex parse, NOT NaN.
 * This validates that the parsed integer's string form exactly matches
 * the input, rejecting UUIDs and any string containing non-digit characters.
 *
 * @param {string|number} v - Value to coerce
 * @returns {number|null} Integer or null if invalid/not-an-integer-string
 */
function toInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return v;
  if (typeof v !== 'string') return null;
  const n = parseInt(v, 10);
  // Reject UUIDs: parseInt("3962af23", 10) = 3962, but "3962af23" !== String(3962)
  return String(n) === v && !isNaN(n) ? n : null;
}

module.exports = pool;
module.exports._pool = pool; // internal — use only for migrations that bypass MCP DDL guard
module.exports.toInt = toInt;
