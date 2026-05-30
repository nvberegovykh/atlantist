/**
 * Owns: wallt_scan_results — WhatsApp scan result persistence.
 * Does NOT own: LLM calls, scan logic, bearer auth.
 */
'use strict';
const pool = require('./index');

/**
 * Store a WhatsApp scan result. user_id scoping is enforced at the query level.
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.summary
 * @param {Array}  params.importantItems  — will be JSON-stringified
 * @param {number} params.messageCount
 * @param {string[]} params.messageHashes  — SHA-256 hashes, not raw text
 * @param {string} [params.scannedAt]     — ISO-8601; defaults to NOW()
 */
const saveScanResult = async ({ userId, summary, importantItems, messageCount, messageHashes, scannedAt }) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_scan_results (user_id, summary, important_items, message_count, raw_message_hashes, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, summary, JSON.stringify(importantItems), messageCount, messageHashes, scannedAt || new Date().toISOString()]
  );
  return rows[0];
};

/**
 * Look up scan results for a user, newest first.
 * @param {string} userId
 * @param {number} [limit=10]
 */
const getScanResults = async (userId, limit = 10) => {
  const { rows } = await pool.query(
    `SELECT id, user_id, summary, important_items, message_count, scanned_at, created_at
     FROM wallt_scan_results
     WHERE user_id = $1
     ORDER BY scanned_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

/**
 * Count scans for a user_id within a rolling window.
 * Used for per-user rate limit enforcement.
 * @param {string} userId
 * @param {number} windowMs  — e.g. 3_600_000 for 1 hour
 */
const countScansInWindow = async (userId, windowMs) => {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM wallt_scan_results
     WHERE user_id = $1 AND scanned_at >= $2`,
    [userId, since]
  );
  return parseInt(rows[0].cnt, 10);
};

module.exports = { saveScanResult, getScanResults, countScansInWindow };