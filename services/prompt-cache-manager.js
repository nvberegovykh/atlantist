/**
 * Owns: Prompt prefix cache lifecycle — namespacing, invalidation, tier tracking, metrics.
 * Does NOT own: Actual model inference, KV cache management, vLLM server.
 *
 * Design:
 *   - Cache key: {project_id}:{agent_role}:{sector_id}:{tier_hash}
 *   - Tier 0-1 (role + metadata) cached indefinitely; Tier 2+ invalidated on changes
 *   - Sector ingestion invalidates that sector's Tier 3+ only
 *   - Tool definition change invalidates Tier 2+; Tier 0-1 survive
 *   - All invalidation events logged with reason + tier + sector_id
 *
 * W1/W2 infra budget: under $75/month — in-memory store with JSON TTL for 10-agent parallel use.
 */

const EventEmitter = require('events');

// Lazy-load DB writer — graceful degradation if DB is temporarily unavailable
let _logDbInvalidation = null;
function _getLogDb() {
  if (!_logDbInvalidation) {
    try { _logDbInvalidation = require('../db/prompt-cache').logCacheInvalidation; } catch (_) {}
  }
  return _logDbInvalidation;
}

// ── Cache store (in-memory, per-process) ────────────────────────────────────

class CacheEntry {
  constructor(key, data, tier) {
    this.key = key;
    this.data = data;           // string hash or serialized block
    this.tier = tier;           // 0-5
    this.salt = null;           // project/sector namespace salt
    this.agentRole = null;
    this.sectorId = null;
    this.hash = null;           // stable checksum for tier block
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.hitCount = 0;
    this.hardFrozen = tier <= 1; // Tier 0-1 never evicted
  }
}

class PromptCacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._store = new Map();
    this._maxSize = options.maxSizeBytes || 50 * 1024 * 1024; // 50MB soft cap
    this._currentSize = 0;
    this._evictionLog = [];
    this._invalidationLog = [];
  }

  // ── Core cache key ────────────────────────────────────────────────────────

  /**
   * Build a stable cache key for a given agent + project + sector at a tier.
   * Key format: {project_id}:{agent_role}:{sector_id}:{tier_hash}
   */
  buildKey({ projectId, agentRole, sectorId, tierHash }) {
    const parts = [
      projectId || 'global',
      agentRole || 'unknown',
      sectorId || 'core',
      tierHash || 't0',
    ];
    return parts.join(':');
  }

  // ── Store / retrieve ─────────────────────────────────────────────────────

  /**
   * Store a tier block. Call after serializing the tier content.
   */
  set({ projectId, agentRole, sectorId, tier, contentHash, content }) {
    const key = this.buildKey({ projectId, agentRole, sectorId, tierHash: contentHash });
    const entry = new CacheEntry(key, contentHash, tier);
    entry.salt = { projectId, agentRole, sectorId };
    entry.hash = contentHash;
    entry.content = content; // stored for size tracking

    // Evict if over budget (never evict hardFrozen Tier 0-1)
    this._evictIfNeeded(entry, tier);

    const existing = this._store.get(key);
    if (existing) {
      this._currentSize -= existing.content ? existing.content.length : 0;
    }

    this._store.set(key, entry);
    this._currentSize += content ? content.length : 0;
    this._emitHit(key, true);
  }

  /**
   * Retrieve a cached tier block by its components.
   */
  get({ projectId, agentRole, sectorId, tier, contentHash }) {
    const key = this.buildKey({ projectId, agentRole, sectorId, tierHash: contentHash });
    const entry = this._store.get(key);
    if (!entry) return null;

    entry.lastUsedAt = Date.now();
    entry.hitCount++;
    this._emitHit(key, false);
    return entry.data;
  }

  /**
   * Check if a tier block is cached (by hash). Returns true if present.
   */
  has({ projectId, agentRole, sectorId, tier, contentHash }) {
    const key = this.buildKey({ projectId, agentRole, sectorId, tierHash: contentHash });
    return this._store.has(key);
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  /**
   * Invalidate all tiers >= minTier for a given agent/project/sector combo.
   * Tier 0-1 hard-frozen — never evicted by normal invalidation.
   *
   * @param {object} scope   { projectId?, agentRole?, sectorId?, minTier, reason }
   */
  invalidate(scope) {
    const { projectId, agentRole, sectorId, minTier = 2, reason } = scope;
    const sizeBefore = this._currentSize;
    const affected = [];

    for (const [key, entry] of this._store) {
      if (entry.hardFrozen) continue;
      if (entry.tier < minTier) continue;

      // Scope filter — match specific fields
      if (projectId && entry.salt?.projectId && entry.salt.projectId !== projectId) continue;
      if (agentRole && entry.agentRole && entry.agentRole !== agentRole) continue;
      if (sectorId && entry.salt?.sectorId && entry.salt.sectorId !== sectorId) continue;

      this._store.delete(key);
      this._currentSize -= entry.content ? entry.content.length : 0;
      affected.push({ key, tier: entry.tier, hash: entry.hash });
    }

    const logEntry = {
      ts: new Date().toISOString(),
      reason: reason || 'unknown',
      projectId: projectId || null,
      agentRole: agentRole || null,
      sectorId: sectorId || null,
      minTier,
      affectedCount: affected.length,
      affected: affected.slice(0, 20), // log first 20 affected keys
    };
    this._invalidationLog.push(logEntry);

    this.emit('invalidate', logEntry);
    console.info(`[prompt-cache] Invalidate: reason="${reason}" sector=${sectorId || 'all'} minTier=${minTier} affected=${affected.length}`);

    // Persist to DB — non-blocking, graceful degradation
    const logDb = _getLogDb();
    if (logDb) {
      setImmediate(async () => {
        try {
          await logDb({
            reason,
            sector_id: sectorId || null,
            agent_role: agentRole || null,
            project_id: projectId || null,
            minTier,
            maxTier: 5,
            affected,
            cacheSizeBefore: sizeBefore,
            cacheSizeAfter: this._currentSize,
            trigger_source: reason?.startsWith('sector_ingest') ? 'sector_ingest'
              : reason?.startsWith('project_switch') ? 'project_switch'
              : reason?.startsWith('tool_def_change') ? 'tool_def_change'
              : 'admin',
          });
        } catch (err) {
          console.warn('[prompt-cache] DB persistence failed:', err.message);
        }
      });
    }

    return affected;
  }

  /**
   * Invalidate a specific sector only — sector ingestion update path.
   * Tier 3+ of that sector's agent only (other sectors untouched).
   */
  invalidateSector(sectorId, reason) {
    return this.invalidate({
      sectorId,
      minTier: 3,
      reason: `sector_ingestion:${reason}`,
    });
  }

  /**
   * Invalidate Tier 2+ on tool definition change (Tier 0-1 survive).
   */
  invalidateToolDefinitions(agentRole, reason) {
    return this.invalidate({
      agentRole,
      minTier: 2,
      reason: `tool_def_change:${reason}`,
    });
  }

  /**
   * Invalidate Tier 1+ on project switch (Tier 0 survives).
   */
  invalidateProjectSwitch(projectId, reason) {
    return this.invalidate({
      projectId,
      minTier: 1,
      reason: `project_switch:${reason}`,
    });
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  /** Hit rate for a given agent+sector over the last N requests */
  getHitRate({ agentRole, sectorId, sampleSize = 100 }) {
    const entries = [...this._store.values()].filter(e => {
      if (agentRole && e.agentRole !== agentRole) return false;
      if (sectorId && e.salt?.sectorId !== sectorId) return false;
      return true;
    });

    if (!entries.length) return { hitRate: 0, totalHits: 0, tierBreakdown: {} };

    const totalHits = entries.reduce((s, e) => s + e.hitCount, 0);
    const hitRate = entries.length > 0 ? Math.min(totalHits / sampleSize, 1) : 0;

    // Per-tier breakdown
    const tierBreakdown = {};
    for (let t = 0; t <= 5; t++) {
      const tierEntries = entries.filter(e => e.tier === t);
      tierBreakdown[t] = {
        count: tierEntries.length,
        hits: tierEntries.reduce((s, e) => s + e.hitCount, 0),
        frozen: tierEntries.filter(e => e.hardFrozen).length,
      };
    }

    return { hitRate: parseFloat(hitRate.toFixed(4)), totalHits, tierBreakdown };
  }

  /** Stats snapshot for /api/wallt-agent/cache/stats endpoint */
  getStats() {
    const entries = [...this._store.values()];
    const byTier = {};
    for (let t = 0; t <= 5; t++) {
      const tierEntries = entries.filter(e => e.tier === t);
      byTier[t] = {
        count: tierEntries.length,
        frozen: tierEntries.filter(e => e.hardFrozen).length,
        totalHits: tierEntries.reduce((s, e) => s + e.hitCount, 0),
      };
    }

    return {
      totalEntries: entries.length,
      currentSizeBytes: this._currentSize,
      maxSizeBytes: this._maxSize,
      sizePct: parseFloat((this._currentSize / this._maxSize * 100).toFixed(1)),
      evictionCount: this._evictionLog.length,
      invalidationCount: this._invalidationLog.length,
      lastInvalidations: this._invalidationLog.slice(-10).reverse(),
      byTier,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _evictIfNeeded(newEntry, tier) {
    if (newEntry.hardFrozen) return; // Never evict hard-frozen
    if (this._currentSize < this._maxSize) return;

    // LRU eviction, skipping hardFrozen
    const candidates = [...this._store.values()]
      .filter(e => !e.hardFrozen)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    const toEvict = candidates.slice(0, Math.ceil(candidates.length * 0.2)); // evict 20%
    for (const entry of toEvict) {
      this._store.delete(entry.key);
      this._currentSize -= entry.content ? entry.content.length : 0;
      this._evictionLog.push({
        ts: new Date().toISOString(),
        key: entry.key,
        tier: entry.tier,
        reason: 'lru_size_pressure',
      });
    }
  }

  _emitHit(key, coldStart) {
    // Fire event for metrics / debugging (non-blocking)
    setImmediate(() => {
      this.emit('cache:hit', { key, coldStart });
    });
  }
}

// Singleton — shared across all agent calls
const manager = new PromptCacheManager();

module.exports = {
  PromptCacheManager,
  promptCacheManager: manager,
};