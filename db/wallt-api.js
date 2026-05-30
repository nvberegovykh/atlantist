/**
 * wallt_api_audit — append-only audit log access.
 * Owns: write-only inserts to wallt_api_audit.
 * Does NOT own: wallt_conversations, wallt_messages, wallt_memory, any pgvector tables.
 *
 * All audit functions are fire-and-forget — failures are logged to stderr,
 * never thrown (avoids poisoning the API response for audit failures).
 */
const pool = require('./index');

/**
 * @param {Object} opts
 * @param {string}   opts.requestId
 * @param {string}   [opts.source]
 * @param {string}   [opts.userId]
 * @param {string[]} [opts.sectorHits]
 * @param {number}   [opts.processingTimeMs]
 * @param {number}   [opts.statusCode]
 * @param {boolean}  [opts.timeout]
 * @param {string}   [opts.projectId]   — UUID, nullable. Set for /project-query calls.
 * @param {boolean}  [opts.keyValid]    — TRUE/FALSE, nullable. NULL for non-project calls.
 */
function logAudit({ requestId, source, userId, sectorHits, processingTimeMs, statusCode, timeout, projectId, keyValid }) {
  const sql = `
    INSERT INTO wallt_api_audit
      (request_id, source, user_id, sector_hits, processing_time_ms, status_code, timeout_flag, project_id, key_valid)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `;
  pool.query(sql, [
    requestId,
    source || null,
    userId || null,
    JSON.stringify(sectorHits || []),
    processingTimeMs || null,
    statusCode || null,
    timeout ? true : false,
    projectId || null,
    keyValid !== undefined ? keyValid : null,
  ]).catch(err => {
    console.error('[wallt-api-audit] failed to write audit row:', err.message);
  });
}

module.exports = { logAudit };