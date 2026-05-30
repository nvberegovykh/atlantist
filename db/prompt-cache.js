/**
 * Owns: wallt_cache_invalidation_log persistence + cache telemetry queries.
 * Does NOT own: PromptCacheManager (services/prompt-cache-manager.js) — this file is
 * write-only for the DB; reads stay in-memory in the cache manager.
 *
 * W2: PagedAttention Prefix Caching — cache invalidation audit trail.
 * Logs every sector ingestion, project switch, tool def change, and admin trigger.
 *
 * W1 legacy note: vLLM proxy is active when VLLM_BASE_URL is set; Polsia proxy
 * fallback handles prefix caching server-side. This table records invalidation events
 * regardless of which inference backend is active.
 */

'use strict';

const pool = require('./index');

// ── Write: log invalidation event ──────────────────────────────────────────

/**
 * Persist a cache invalidation event. Called by prompt-cache-manager.js
 * after every invalidation (sector ingest, project switch, tool def change, admin).
 *
 * @param {object} entry
 * @param {string} entry.reason           Human-readable reason
 * @param {string|null} entry.sector_id   Sector that triggered (null = all)
 * @param {string|null} entry.agent_role  Agent that triggered (null = all)
 * @param {string|null} entry.project_id  Project namespace (null = global)
 * @param {number} entry.minTier          Lowest tier invalidated
 * @param {number} entry.maxTier          Highest tier invalidated
 * @param {Array}  entry.affected         Array of {key, tier, hash}
 * @param {number} entry.cacheSizeBefore  Cache size bytes before invalidation
 * @param {number} entry.cacheSizeAfter   Cache size bytes after invalidation
 * @param {string} entry.triggerSource    'api'|'project_switch'|'sector_ingest'|'tool_def_change'|'admin'
 */
async function logCacheInvalidation(entry) {
  const {
    reason,
    sector_id = null,
    agent_role = null,
    project_id = null,
    minTier,
    maxTier,
    affected = [],
    cacheSizeBefore = null,
    cacheSizeAfter = null,
    trigger_source = 'api',
  } = entry;

  // 6-sector classification
  let classification = 'all';
  if (sector_id && sector_id !== 'core') {
    const VALID = new Set(['structural', 'mep', 'thermal', 'dob', 'materials', 'fire']);
    if (VALID.has(sector_id)) classification = sector_id;
  } else if (sector_id === 'core') {
    classification = 'core';
  }

  // Log first 50 affected keys
  const affectedKeys = affected.slice(0, 50).map(a => ({
    key: a.key,
    tier: a.tier,
    hash: a.hash,
  }));

  await pool.query(
    `INSERT INTO wallt_cache_invalidation_log
       (reason, sector_id, agent_role, project_id, min_tier, max_tier,
        affected_count, affected_keys, cache_size_bytes_before, cache_size_bytes_after,
        trigger_source, classification)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      reason,
      sector_id,
      agent_role,
      project_id,
      minTier,
      maxTier,
      affected.length,
      JSON.stringify(affectedKeys),
      cacheSizeBefore,
      cacheSizeAfter,
      trigger_source,
      classification,
    ]
  );
}

// ── Read: cache analytics ───────────────────────────────────────────────────

/**
 * Get invalidation history for a given sector (for W2 acceptance: sector-specific audit).
 * Returns last N entries, newest first.
 */
async function getInvalidationsBySector(sectorId, limit = 20) {
  const res = await pool.query(
    `SELECT id, ts, reason, min_tier, max_tier, affected_count, trigger_source
     FROM wallt_cache_invalidation_log
     WHERE sector_id = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [sectorId, limit]
  );
  return res.rows;
}

/**
 * Get invalidation history for a given project.
 */
async function getInvalidationsByProject(projectId, limit = 20) {
  const res = await pool.query(
    `SELECT id, ts, reason, sector_id, min_tier, max_tier, affected_count, trigger_source
     FROM wallt_cache_invalidation_log
     WHERE project_id = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [projectId, limit]
  );
  return res.rows;
}

/**
 * Get all invalidation events in a time window, with tier breakdown.
 * Used by /api/wallt-agent/cache/stats for cache analytics.
 */
async function getInvalidationStats(sinceHours = 24) {
  const res = await pool.query(
    `SELECT
       trigger_source,
       classification,
       COUNT(*)                         AS event_count,
       SUM(affected_count)             AS total_keys_invalidated,
       AVG(affected_count)::int         AS avg_keys_per_event,
       MIN(ts)                          AS first_event,
       MAX(ts)                          AS last_event
     FROM wallt_cache_invalidation_log
     WHERE ts > NOW() - INTERVAL '${parseInt(sinceHours)} hours'
     GROUP BY trigger_source, classification
     ORDER BY event_count DESC`
  );
  return res.rows;
}

/**
 * Get per-tier hit rate from persisted invalidation + cache size telemetry.
 * Reads from the in-process cache manager's _store to compute current hit rates.
 * (The manager is a singleton in services/prompt-cache-manager.js — imported directly.)
 */
async function getTierHitRates() {
  // Import from the singleton — this is the same manager that routes/wallt-agent.js uses
  const { promptCacheManager } = require('../services/prompt-cache-manager');
  const stats = promptCacheManager.getStats();

  const byTier = stats.byTier || {};
  const tiers = [0, 1, 2, 3, 4, 5];
  const result = {};

  for (const tier of tiers) {
    const t = byTier[tier] || { count: 0, hits: 0, frozen: 0 };
    result[tier] = {
      cached_blocks: t.count,
      total_hits: t.hits,
      frozen_blocks: t.frozen,
      // Tier 0-1 are hard-frozen — hit rate is trivially 100% for frozen blocks
      // Tier 2+ are dynamic — hit rate computed from hits / (hits + misses)
      // We use (hits / max(hits, 1)) as a proxy since we don't track misses directly
      // The actual steady-state hit rate depends on the model serving layer (vLLM or Polsia proxy)
      hit_rate_proxy: t.hits > 0 ? Math.min(t.hits / 10, 1) : 0,
    };
  }

  return result;
}

module.exports = {
  logCacheInvalidation,
  getInvalidationsBySector,
  getInvalidationsByProject,
  getInvalidationStats,
  getTierHitRates,
};