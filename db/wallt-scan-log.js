/**
 * wallt_scan_log — WhatsApp scanner batch audit log.
 * Owns: write-only inserts + indexed reads (status / stats).
 * Does NOT own: wallt_conversations, wallt_messages, wallt_memory, any pgvector tables.
 */
'use strict';
const pool = require('./index');

/**
 * Insert a new scan log record after processing a batch.
 * @param {Object} opts
 * @param {string}   opts.batchId
 * @param {number}   opts.totalMessages
 * @param {Object}   opts.classified      — sector counts, e.g. { structural: 3, mep: 5, unclassified: 1 }
 * @param {number}   opts.ingested
 * @param {number}   opts.skippedDuplicate
 * @param {boolean}  opts.projectKeyPresent
 * @param {string}   opts.scannedAt       — ISO-8601 from the scanner
 */
async function logBatch({
  batchId,
  totalMessages,
  classified,
  ingested,
  skippedDuplicate,
  projectKeyPresent,
  scannedAt,
}) {
  const { rows } = await pool.query(
    `INSERT INTO wallt_scan_log
       (batch_id, total_messages, classified, ingested, skipped_duplicate, project_key_present, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      batchId,
      totalMessages,
      JSON.stringify(classified),
      ingested,
      skippedDuplicate,
      projectKeyPresent,
      scannedAt,
    ]
  );
  return rows[0];
}

/**
 * Last N batch logs (newest first). Used by GET /api/wallt/scan/status.
 * @param {number} [limit=10]
 */
async function getRecentBatches(limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, batch_id, total_messages, classified, ingested, skipped_duplicate,
            project_key_present, scanned_at, processed_at
     FROM wallt_scan_log
     ORDER BY processed_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * 7-day aggregate stats. Used by GET /api/wallt/scan/stats.
 * Returns: { totalMessages, totalIngested, messagesPerSector, batchesPerDay }
 */
async function get7DayStats() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const totals = await pool.query(
    `SELECT
       SUM(total_messages)     AS total_messages,
       SUM(ingested)            AS total_ingested,
       SUM(skipped_duplicate)  AS total_skipped
     FROM wallt_scan_log
     WHERE processed_at >= $1`,
    [since]
  );

  // messages per sector (sum classified[sector] across all batches)
  const sectorRows = await pool.query(
    `SELECT classified FROM wallt_scan_log WHERE processed_at >= $1`,
    [since]
  );

  const sectorTotals = {};
  for (const row of sectorRows) {
    const classified = row.classified || {};
    for (const [sector, count] of Object.entries(classified)) {
      sectorTotals[sector] = (sectorTotals[sector] || 0) + count;
    }
  }

  // batches per day (date-keyed)
  const batchRows = await pool.query(
    `SELECT DATE(processed_at) AS day, COUNT(*) AS count
     FROM wallt_scan_log
     WHERE processed_at >= $1
     GROUP BY DATE(processed_at)
     ORDER BY day`,
    [since]
  );
  const batchesPerDay = {};
  for (const row of batchRows) {
    batchesPerDay[row.day.toISOString().slice(0, 10)] = parseInt(row.count, 10);
  }

  const t = totals.rows[0] || {};
  return {
    total_messages: parseInt(t.total_messages || 0, 10),
    total_ingested: parseInt(t.total_ingested || 0, 10),
    total_skipped: parseInt(t.total_skipped || 0, 10),
    messages_per_sector: sectorTotals,
    batches_per_day: batchesPerDay,
  };
}

module.exports = { logBatch, getRecentBatches, get7DayStats };