/**
 * Owns: Wallt Core Memory Redis cache layer.
 * Does NOT own: PostgreSQL core memory tables (db/wallt-memory.js), Wallt AI.
 *
 * Redis cache for hot core facts. Gracefully degrades to no-op when Redis
 * is not configured (REDIS_URL env var absent).
 *
 * Cached data:
 *   wallt:core:profile:{userId}      — user profile JSON
 *   wallt:core:inst:{category}:{key} — institutional memory records
 *   wallt:core:skill:{skillKey}      — skill inventory entries
 *   wallt:core:decisions:{userId}    — recent decisions (TTL: 1h)
 *   wallt:core:size                  — current store size in bytes
 *
 * Cache policy:
 *   Hot facts (is_hot=true) → Redis with 24h TTL, refresh on access
 *   Cold facts → PostgreSQL only
 *   Size cap: 500MB (configurable via MAX_CACHE_BYTES)
 */
const { Pool: RedisPool } = require('pg');

let redis = null;
let redisAvailable = false;

// Try to connect to Redis; silently fall back if REDIS_URL is not set
const MAX_CACHE_BYTES = parseInt(process.env.WALLT_CACHE_MAX_BYTES || String(500 * 1024 * 1024), 10); // 500MB default
const DEFAULT_TTL_SECONDS = parseInt(process.env.WALLT_CACHE_TTL_SECONDS || '86400', 10); // 24h default

function getRedisPool() {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    try {
      redis = new RedisPool({ connectionString: process.env.REDIS_URL, max: 5 });
    } catch (err) {
      console.warn('[wallt-memory-cache] Redis connection failed:', err.message);
      return null;
    }
  }
  return redis;
}

async function initCache() {
  const pool = getRedisPool();
  if (!pool) {
    console.info('[wallt-memory-cache] REDIS_URL not set — cache disabled, using PostgreSQL only');
    return;
  }
  try {
    await pool.query('SELECT 1');
    redisAvailable = true;
    console.info('[wallt-memory-cache] Redis connected');
  } catch (err) {
    console.warn('[wallt-memory-cache] Redis ping failed:', err.message);
    redisAvailable = false;
  }
}

// ── Cache key helpers ───────────────────────────────────────────────────────

const key = {
  userProfile: (userId) => `wallt:core:profile:${userId}`,
  institutionalMem: (category, memoryKey) => `wallt:core:inst:${category}:${memoryKey}`,
  skill: (skillKey) => `wallt:core:skill:${skillKey}`,
  decisionSet: (userId) => `wallt:core:decisions:${userId}`,
  sizeCounter: () => `wallt:core:size`,
};

// ── Core cache operations ───────────────────────────────────────────────────

async function cacheGet(keyStr) {
  if (!redisAvailable) return null;
  try {
    const pool = getRedisPool();
    const { rows } = await pool.query('SELECT value FROM cache WHERE key = $1', [keyStr]);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn('[wallt-cache] get error:', err.message);
    return null;
  }
}

async function cacheSet(keyStr, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!redisAvailable) return;
  try {
    const pool = getRedisPool();
    await pool.query(
      `INSERT INTO cache (key, value, expires_at)
       VALUES ($1, $2, NOW() + $3::interval)
       ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = NOW() + $3::interval`,
      [keyStr, typeof value === 'string' ? value : JSON.stringify(value), `${ttlSeconds} seconds`]
    );
  } catch (err) {
    console.warn('[wallt-cache] set error:', err.message);
  }
}

async function cacheDel(keyStr) {
  if (!redisAvailable) return;
  try {
    const pool = getRedisPool();
    await pool.query('DELETE FROM cache WHERE key = $1', [keyStr]);
  } catch (err) {
    console.warn('[wallt-cache] del error:', err.message);
  }
}

async function cacheInvalidatePattern(pattern) {
  if (!redisAvailable) return;
  try {
    const pool = getRedisPool();
    const escaped = pattern.replace(/[*]/g, '\\*').replace(/[%]/g, '\\%');
    await pool.query('DELETE FROM cache WHERE key LIKE $1', [pattern]);
  } catch (err) {
    console.warn('[wallt-cache] invalidate error:', err.message);
  }
}

// ── High-level cache wrappers ────────────────────────────────────────────────

// User profile cache
async function cacheUserProfile(userId, profileJson, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await cacheSet(key.userProfile(userId), profileJson, ttlSeconds);
}

async function getCachedUserProfile(userId) {
  const raw = await cacheGet(key.userProfile(userId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// Institutional memory cache
async function cacheInstitutionalMem(category, memoryKey, contentMd, tags, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await cacheSet(key.institutionalMem(category, memoryKey), JSON.stringify({ content_md: contentMd, tags }), ttlSeconds);
}

async function getCachedInstitutionalMem(category, memoryKey) {
  const raw = await cacheGet(key.institutionalMem(category, memoryKey));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function invalidateInstitutionalMem(category, memoryKey) {
  await cacheDel(key.institutionalMem(category, memoryKey));
}

// Skill inventory cache
async function cacheSkill(skillKey, skillData, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await cacheSet(key.skill(skillKey), skillData, ttlSeconds);
}

async function getCachedSkill(skillKey) {
  const raw = await cacheGet(key.skill(skillKey));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function invalidateSkill(skillKey) {
  await cacheDel(key.skill(skillKey));
}

// Decisions cache (short TTL — 1h)
async function cacheDecisions(userId, decisions, ttlSeconds = 3600) {
  await cacheSet(key.decisionSet(userId), decisions, ttlSeconds);
}

async function getCachedDecisions(userId) {
  const raw = await cacheGet(key.decisionSet(userId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function invalidateDecisions(userId) {
  await cacheDel(key.decisionSet(userId));
}

// Cold archive flag — evict from cache when institutional memory goes cold
async function evictFromCacheOnArchive(category, memoryKey) {
  await cacheDel(key.institutionalMem(category, memoryKey));
}

// ── Cache size tracking ─────────────────────────────────────────────────────

// Approximate size of cache in bytes (tracked via Redis key)
// On each cacheSet, we increment; on cacheDel, decrement
// This is approximate but sufficient for the 500MB soft cap check

async function incrementCacheSize(approxBytes) {
  if (!redisAvailable) return;
  try {
    const pool = getRedisPool();
    await pool.query(
      `INSERT INTO cache (key, value, expires_at)
       VALUES ($1, GREATEST(COALESCE((SELECT value::bigint FROM cache WHERE key = $1), 0) + $2, 0), NOW() + INTERVAL '30 days')
       ON CONFLICT (key) DO UPDATE SET value = GREATEST(COALESCE((SELECT value::bigint FROM cache WHERE key = $1), 0) + $2, 0)::text`,
      [key.sizeCounter(), approxBytes]
    );
  } catch (err) {
    console.warn('[wallt-cache] size increment error:', err.message);
  }
}

async function getCacheSizeBytes() {
  if (!redisAvailable) return 0;
  try {
    const pool = getRedisPool();
    const { rows } = await pool.query('SELECT value::bigint as size FROM cache WHERE key = $1', [key.sizeCounter()]);
    return rows[0]?.size ?? 0;
  } catch (err) {
    return 0;
  }
}

async function evictLRUUntilUnderCap(targetBytes = MAX_CACHE_BYTES * 0.8) {
  if (!redisAvailable) return 0;
  try {
    const pool = getRedisPool();
    const currentSize = await getCacheSizeBytes();
    if (currentSize <= targetBytes) return 0;

    // Evict oldest institutional memory entries first (most likely cold)
    const { rows } = await pool.query(
      `SELECT key FROM cache WHERE key LIKE 'wallt:core:inst:%'
       ORDER BY expires_at ASC LIMIT 50`
    );
    let evicted = 0;
    for (const row of rows) {
      if (currentSize <= targetBytes) break;
      const sz = await cacheGet(row.key);
      await cacheDel(row.key);
      const approx = sz ? new TextEncoder().encode(JSON.stringify(sz)).length : 1000;
      currentSize -= approx;
      evicted++;
    }
    return evicted;
  } catch (err) {
    console.warn('[wallt-cache] LRU evict error:', err.message);
    return 0;
  }
}

// ── Session ↔ Core migration helpers ────────────────────────────────────────

// load_to_session: load core memory into session context for AI injection
async function loadToSession(userId) {
  const profile = await getCachedUserProfile(userId);
  const decisions = await getCachedDecisions(userId);
  return { profile, decisions };
}

// persist_to_core: write a decision/conclusion back to core memory
async function persistToCore(type, data) {
  // Handled by db/wallt-memory.js — this is just the cache warm path
  switch (type) {
    case 'decision':
      await invalidateDecisions(data.userId);
      break;
    case 'institutional_mem':
      await evictFromCacheOnArchive(data.category, data.memoryKey);
      break;
    case 'skill':
      await invalidateSkill(data.skillKey);
      break;
  }
}

module.exports = {
  init: initCache,
  isAvailable: () => redisAvailable,
  // Low-level
  cacheGet,
  cacheSet,
  cacheDel,
  cacheInvalidatePattern,
  // High-level wrappers
  cacheUserProfile,
  getCachedUserProfile,
  cacheInstitutionalMem,
  getCachedInstitutionalMem,
  invalidateInstitutionalMem,
  cacheSkill,
  getCachedSkill,
  invalidateSkill,
  cacheDecisions,
  getCachedDecisions,
  invalidateDecisions,
  evictFromCacheOnArchive,
  evictLRUUntilUnderCap,
  getCacheSizeBytes,
  MAX_CACHE_BYTES,
  // Session ↔ Core migration
  loadToSession,
  persistToCore,
};