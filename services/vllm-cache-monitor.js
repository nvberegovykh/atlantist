/**
 * Owns: In-memory KV cache observability store — hit/miss counters, eviction log,
 *       GPU memory state, sector ingestion timestamps, alert state.
 * Does NOT own: vLLM server, GPU hardware, the actual inference.
 *
 * Architecture:
 *   - All 10 agents (4 core + 6 sector + 3 pipeline) call recordHit / recordMiss
 *     on every request so the proxy can correlate prefix-caching performance.
 *   - Eviction events are recorded by the proxy whenever vLLM signals block eviction.
 *   - Sector staleness is computed every call against the SECTOR_INGESTION_CADENCE map.
 *   - Alerts fire when thresholds are breached and self-resolve when metrics recover.
 *
 * Budget: $0 additional infra. In-memory store with optional Redis fallback ( guarded ).
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

/** gpu-memory-utilization ceiling from W1 spec */
const GPU_MEM_CEILING = 0.90;
/** Sustained alert threshold — warn at 85% for 5 min */
const GPU_MEM_WARN_THRESHOLD = 0.85;
const GPU_MEM_WARN_DURATION_MS = 5 * 60 * 1000; // 5 min

/** Hit rate alert threshold */
const HIT_RATE_ALERT_THRESHOLD = 0.60; // 60%

/** Sector staleness thresholds (ms) */
const SECTOR_STALENESS = {
  dob: 24 * 60 * 60 * 1000,          // 24 h — regulatory code changes frequently
  materials: 7 * 24 * 60 * 60 * 1000, // 7 days — less volatile
  // others: cadence × 1.5 (dynamic, see computeStaleness())
};

/** Sectors with expected ingestion cadence (ms) */
const SECTOR_CADENCE = {
  structural:  2 * 60 * 60 * 1000,  // 2 h
  mep:         2 * 60 * 60 * 1000,
  thermal:     4 * 60 * 60 * 1000,  // 4 h
  dob:         12 * 60 * 60 * 1000, // 12 h
  materials:   24 * 60 * 60 * 1000, // 24 h
  fire:        12 * 60 * 60 * 1000,
};

// ── In-memory store ────────────────────────────────────────────────────────────

/** Per-agent hit/miss counters */
const agentMetrics = {
  // Core LLM agents
  ingestion:          { hits: 0, misses: 0, requests: 0 },
  transformation:     { hits: 0, misses: 0, requests: 0 },
  analytics:          { hits: 0, misses: 0, requests: 0 },
  governance:         { hits: 0, misses: 0, requests: 0 },
  // Sector agents
  structural:         { hits: 0, misses: 0, requests: 0 },
  mep:                { hits: 0, misses: 0, requests: 0 },
  thermal:            { hits: 0, misses: 0, requests: 0 },
  dob:                { hits: 0, misses: 0, requests: 0 },
  materials:          { hits: 0, misses: 0, requests: 0 },
  fire:               { hits: 0, misses: 0, requests: 0 },
  // Goal 19 pipeline agents
  goal19_code_review: { hits: 0, misses: 0, requests: 0 },
  goal19_sandbox:    { hits: 0, misses: 0, requests: 0 },
  goal19_promotion:  { hits: 0, misses: 0, requests: 0 },
};

/** Circular buffer — last 200 eviction events */
const evictionBuffer = [];
const EVICTION_BUFFER_MAX = 200;

/** Block pool stats */
const blockStats = {
  allocated: 0,       // total blocks currently allocated
  evicted_1h: 0,      // evictions in last 1 hour (sliding window)
  evicted_24h: 0,     // evictions in last 24 hours
};

/** GPU memory state */
const gpuState = {
  utilization: 0.0,   // 0.0–1.0 — updated by proxy on each vLLM metrics poll
  last_updated: null,
  sustained_high_start: null, // timestamp when >0.85 first crossed
};

/** Sector ingestion timestamps */
const sectorIngestion = {
  structural:  null,
  mep:         null,
  thermal:     null,
  dob:         null,
  materials:   null,
  fire:        null,
};

/** Alert state — key = alert type, value = { fired_at, resolved_at, message } */
const alerts = {};
let alertIdCounter = 0;

/** Prefix invalidation log */
const invalidationLog = [];
const INVALIDATION_LOG_MAX = 200;

/** CPU swap fallback events */
const cpuSwapEvents = []; // [{ timestamp, agent_id, reason }]
const CPU_SWAP_LOG_MAX = 50;

// ── Alert helpers ──────────────────────────────────────────────────────────────

function fireAlert(type, message, severity) {
  const id = ++alertIdCounter;
  alerts[type] = {
    id,
    type,
    message,
    severity,        // 'warning' | 'critical'
    fired_at: new Date().toISOString(),
    resolved_at: null,
  };
  return alerts[type];
}

function resolveAlert(type) {
  if (alerts[type] && !alerts[type].resolved_at) {
    alerts[type].resolved_at = new Date().toISOString();
  }
}

function computeHitRate(metrics) {
  const total = metrics.hits + metrics.misses;
  if (total === 0) return null;
  return metrics.hits / total;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Record a cache hit for an agent.
 * @param {string} agentId - agent key from agentMetrics
 * @param {object} [meta] - optional { sector_id, tier }
 */
function recordHit(agentId, meta) {
  const m = agentMetrics[agentId];
  if (!m) return;
  m.hits++;
  m.requests++;
  if (meta?.sector_id) {
    // also bump sector-level counter
    recordSectorActivity(meta.sector_id);
  }
}

/**
 * Record a cache miss for an agent.
 * @param {string} agentId
 * @param {object} [meta]
 */
function recordMiss(agentId, meta) {
  const m = agentMetrics[agentId];
  if (!m) return;
  m.misses++;
  m.requests++;
  if (meta?.sector_id) {
    recordSectorActivity(meta.sector_id);
  }
}

/**
 * Record a sector ingestion event (new data written → invalidates Tier 3 blocks).
 * @param {string} sectorId - one of: structural, mep, thermal, dob, materials, fire
 */
function recordSectorIngestion(sectorId) {
  sectorIngestion[sectorId] = new Date().toISOString();
}

/** Bump sector active soft-link count (called on sector task start) */
function recordSectorActivity(sectorId) {
  // No-op for now — can be extended later
}

/**
 * Record a block eviction event.
 * @param {object} event - { tier, agent_id, sector_id, block_count, reason }
 */
function recordEviction(event) {
  const entry = {
    id: evictionBuffer.length + 1,
    timestamp: new Date().toISOString(),
    ...event,
  };
  evictionBuffer.push(entry);
  if (evictionBuffer.length > EVICTION_BUFFER_MAX) {
    evictionBuffer.shift();
  }
  // bump counters
  blockStats.evicted_1h++;
  blockStats.evicted_24h++;
}

/**
 * Update GPU memory utilization. Called by the proxy on every metrics poll.
 * @param {number} utilization - 0.0 to 1.0
 */
function updateGpuUtilization(utilization) {
  gpuState.utilization = utilization;
  gpuState.last_updated = new Date().toISOString();

  // Check sustained high threshold
  if (utilization > GPU_MEM_WARN_THRESHOLD) {
    if (!gpuState.sustained_high_start) {
      gpuState.sustained_high_start = Date.now();
    } else if (Date.now() - gpuState.sustained_high_start >= GPU_MEM_WARN_DURATION_MS) {
      const key = 'gpu_memory_sustained_high';
      if (!alerts[key] || alerts[key].resolved_at) {
        fireAlert(key,
          `GPU memory sustained >${Math.round(GPU_MEM_WARN_THRESHOLD * 100)}% for 5+ minutes (current: ${Math.round(utilization * 100)}%)`,
          'warning');
      }
    }
  } else {
    gpuState.sustained_high_start = null;
    resolveAlert('gpu_memory_sustained_high');
  }
}

/**
 * Record a CPU swap fallback event.
 * @param {string} agentId
 * @param {string} reason
 */
function recordCpuSwap(agentId, reason) {
  const entry = { timestamp: new Date().toISOString(), agent_id: agentId, reason };
  cpuSwapEvents.push(entry);
  if (cpuSwapEvents.length > CPU_SWAP_LOG_MAX) cpuSwapEvents.shift();
  fireAlert('cpu_swap_fallback',
    `CPU swap fallback triggered by agent '${agentId}': ${reason}`,
    'critical');
}

/**
 * Record a prefix invalidation event.
 * @param {object} event - { tier_depth, reason, sector_id }
 */
function recordInvalidation(event) {
  const entry = {
    id: invalidationLog.length + 1,
    timestamp: new Date().toISOString(),
    ...event,
  };
  invalidationLog.push(entry);
  if (invalidationLog.length > INVALIDATION_LOG_MAX) invalidationLog.shift();
}

/**
 * Update block allocation count.
 * @param {number} count
 */
function setBlockAllocated(count) {
  blockStats.allocated = count;
}

/**
 * Check hit rate thresholds and fire/resolve alerts.
 */
function checkHitRates() {
  for (const [agentId, m] of Object.entries(agentMetrics)) {
    const rate = computeHitRate(m);
    if (rate === null) continue;
    if (rate < HIT_RATE_ALERT_THRESHOLD) {
      const key = `hit_rate_low_${agentId}`;
      if (!alerts[key] || alerts[key].resolved_at) {
        fireAlert(key,
          `Agent '${agentId}' hit rate dropped to ${Math.round(rate * 100)}% (threshold: ${HIT_RATE_ALERT_THRESHOLD * 100}%)`,
          'warning');
      }
    } else {
      resolveAlert(`hit_rate_low_${agentId}`);
    }
  }
}

/**
 * Compute staleness status for all sectors.
 * @returns {Array} [{ sector_id, last_ingestion, stale_ms, status: 'ok'|'warning'|'critical', threshold_ms }]
 */
function getSectorStaleness() {
  const now = Date.now();
  return Object.entries(sectorIngestion).map(([sectorId, lastIso]) => {
    const lastMs = lastIso ? new Date(lastIso).getTime() : null;
    const staleMs = lastMs ? now - lastMs : null;

    // Determine threshold
    let thresholdMs;
    if (SECTOR_STALENESS[sectorId]) {
      thresholdMs = SECTOR_STALENESS[sectorId];
    } else {
      const cadence = SECTOR_CADENCE[sectorId] || 24 * 60 * 60 * 1000;
      thresholdMs = cadence * 1.5;
    }

    let status;
    if (!lastMs) {
      status = 'critical';
    } else if (staleMs > thresholdMs * 1.5) {
      status = 'critical';
    } else if (staleMs > thresholdMs) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      sector_id: sectorId,
      last_ingestion: lastIso,
      stale_ms: staleMs,
      threshold_ms: thresholdMs,
      status,
    };
  });
}

/**
 * Check sector staleness and fire alerts.
 */
function checkSectorStaleness() {
  const staleness = getSectorStaleness();
  for (const s of staleness) {
    if (s.status === 'critical') {
      const key = `staleness_${s.sector_id}`;
      const sectorLabel = s.sector_id.toUpperCase();
      if (!alerts[key] || alerts[key].resolved_at) {
        const since = s.last_ingestion
          ? `Last ingestion ${Math.round(s.stale_ms / (60 * 60 * 1000))}h ago`
          : 'No ingestion recorded';
        fireAlert(key,
          `${sectorLabel} sector is STALE: ${since} (threshold: ${Math.round(s.threshold_ms / (60 * 60 * 1000))}h)`,
          'critical');
      }
    } else if (s.status === 'ok') {
      resolveAlert(`staleness_${s.sector_id}`);
    }
  }
}

/**
 * Get the full current state snapshot — used by the dashboard API.
 */
function getSnapshot() {
  checkHitRates();
  checkSectorStaleness();

  const agentStats = Object.entries(agentMetrics).map(([id, m]) => {
    const rate = computeHitRate(m);
    return {
      agent_id: id,
      hits: m.hits,
      misses: m.misses,
      requests: m.requests,
      hit_rate: rate !== null ? Math.round(rate * 1000) / 1000 : null,
      tier: getAgentTier(id),
      sector: getAgentSector(id),
    };
  });

  const sectorStats = getSectorStaleness();

  const activeAlerts = Object.values(alerts)
    .filter(a => !a.resolved_at)
    .sort((a, b) => new Date(b.fired_at) - new Date(a.fired_at));

  return {
    timestamp: new Date().toISOString(),
    agents: agentStats,
    sectors: sectorStats,
    blocks: { ...blockStats },
    gpu: {
      utilization: Math.round(gpuState.utilization * 1000) / 1000,
      last_updated: gpuState.last_updated,
      warn_threshold: GPU_MEM_WARN_THRESHOLD,
      ceiling: GPU_MEM_CEILING,
      sustained_high_start: gpuState.sustained_high_start
        ? new Date(gpuState.sustained_high_start).toISOString()
        : null,
    },
    evictions: evictionBuffer.slice(-20),   // last 20
    invalidations: invalidationLog.slice(-20),
    cpu_swap_events: cpuSwapEvents.slice(-10),
    alerts: activeAlerts,
  };
}

/** Tier + sector helpers */
function getAgentTier(id) {
  if (['ingestion', 'transformation', 'analytics', 'governance'].includes(id)) return 'core';
  if (id.startsWith('goal19_')) return 'pipeline';
  return 'sector';
}

function getAgentSector(id) {
  const map = {
    structural: 'structural', mep: 'mep', thermal: 'thermal',
    dob: 'dob', materials: 'materials', fire: 'fire',
  };
  return map[id] || null;
}

// ── Reset (for testing / scheduled reset) ─────────────────────────────────────

function resetAgentMetrics(agentId) {
  if (agentMetrics[agentId]) {
    agentMetrics[agentId] = { hits: 0, misses: 0, requests: 0 };
  }
}

function resetAllMetrics() {
  for (const k of Object.keys(agentMetrics)) {
    agentMetrics[k] = { hits: 0, misses: 0, requests: 0 };
  }
  evictionBuffer.length = 0;
  blockStats.allocated = 0;
  blockStats.evicted_1h = 0;
  blockStats.evicted_24h = 0;
  Object.keys(sectorIngestion).forEach(k => { sectorIngestion[k] = null; });
  Object.keys(alerts).forEach(k => { delete alerts[k]; });
  invalidationLog.length = 0;
  cpuSwapEvents.length = 0;
  gpuState.utilization = 0;
  gpuState.sustained_high_start = null;
}

// ── Module exports ──────────────────────────────────────────────────────────────

module.exports = {
  // Recording
  recordHit,
  recordMiss,
  recordSectorIngestion,
  recordEviction,
  updateGpuUtilization,
  recordCpuSwap,
  recordInvalidation,
  setBlockAllocated,
  // Queries
  getSnapshot,
  getSectorStaleness,
  checkHitRates,
  checkSectorStaleness,
  // Debug
  resetAgentMetrics,
  resetAllMetrics,
  // Constants
  HIT_RATE_ALERT_THRESHOLD,
  GPU_MEM_WARN_THRESHOLD,
  GPU_MEM_WARN_DURATION_MS,
};