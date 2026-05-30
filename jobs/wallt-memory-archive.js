/**
 * Wallt Core Memory — weekly archive & eviction job.
 *
 * Runs via [[crons]] every Sunday at 6am UTC.
 * Guard: process.env.POLSIA_IN_PROCESS_CRONS_ENABLED === 'true' (Render-only).
 *
 * What it does:
 * 1. Archive institutional memory not accessed in 90 days → wallt_core_archive
 * 2. Hard-delete archive records past 2-year retention
 * 3. Evict Redis cache entries to keep store under 500MB soft cap
 * 4. Log stats: archived count, deleted count, evicted count, cache size
 */
'use strict';

const pool = require('../db/index');
const walltMem = require('../db/wallt-memory');
const cache = require('../services/wallt-memory-cache');

const ARCHIVE_DAYS = 90;     // access cutoff threshold
const RETENTION_YEARS = 2;  // hard delete after 2 years
const MAX_CACHE_BYTES = parseInt(process.env.WALLT_CACHE_MAX_BYTES || String(500 * 1024 * 1024), 10);
const TARGET_CACHE_BYTES = MAX_CACHE_BYTES * 0.8;

async function run() {
  const startedAt = Date.now();
  let archived = 0, purged = 0, evicted = 0, cacheSize = 0;

  console.info('[wallt-memory-archive] Starting weekly archive run');

  try {
    // 1. Archive old institutional memory records
    const archResult = await walltMem.archiveOldRecords('wallt_core_institutional_mem', ARCHIVE_DAYS);
    archived = archResult || 0;
    console.info(`[wallt-memory-archive] Archived ${archived} institutional memory records`);

    // 2. Hard delete records past 2-year retention
    const purgeResult = await walltMem.purgeExpiredArchive();
    purged = purgeResult || 0;
    console.info(`[wallt-memory-archive] Purged ${purged} expired archive records`);

    // 3. Cache eviction to stay under soft cap
    cacheSize = await cache.getCacheSizeBytes();
    if (cacheSize > TARGET_CACHE_BYTES) {
      const evictedCount = await cache.evictLRUUntilUnderCap(TARGET_CACHE_BYTES);
      evicted = evictedCount || 0;
      console.info(`[wallt-memory-archive] Evicted ${evicted} cache entries (size: ${cacheSize} → under ${TARGET_CACHE_BYTES})`);
    } else {
      console.info(`[wallt-memory-archive] Cache size ${cacheSize} bytes — within soft cap`);
    }

    // 4. Log run stats to a dedicated wallt_memory_archive_log table
    //    (create on the fly so the job itself is self-contained)
    await pool.query(
      `INSERT INTO wallt_memory_archive_log (archived_count, purged_count, evicted_count, cache_size_bytes, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [archived, purged, evicted, cacheSize, new Date(startedAt).toISOString()]
    );

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.info(`[wallt-memory-archive] Done — archived:${archived} purged:${purged} evicted:${evicted} cache:${cacheSize}b in ${elapsed}s`);
  } catch (err) {
    console.error('[wallt-memory-archive] Fatal error:', err.message);
    throw err; // Re-throw so the cron framework marks it as failed
  }
}

// Allow manual trigger via POST /api/admin/wallt-memory-archive
// (web route will be added by whoever needs it)
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[wallt-memory-archive] Exit with error:', err.message);
      process.exit(1);
    });
}

module.exports = { run };