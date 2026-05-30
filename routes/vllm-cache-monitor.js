/**
 * Owns: KV cache monitoring REST API endpoints.
 * Does NOT own: vLLM server, GPU hardware, the in-memory cache monitor service.
 */

'use strict';

const express = require('express');
const monitor = require('../services/vllm-cache-monitor');

const router = express.Router();

// ── GET /api/vllm-cache-monitor/snapshot ──────────────────────────────────────
// Returns the full current state: per-agent hit rates, sector staleness,
// GPU memory, eviction log, active alerts.
router.get('/snapshot', (req, res) => {
  try {
    res.json(monitor.getSnapshot());
  } catch (err) {
    console.error('[vllm-cache-monitor] snapshot error:', err);
    res.status(500).json({ error: 'Failed to generate snapshot' });
  }
});

// ── GET /api/vllm-cache-monitor/alerts ────────────────────────────────────────
// Returns only active alerts.
router.get('/alerts', (req, res) => {
  const snap = monitor.getSnapshot();
  res.json({ alerts: snap.alerts, timestamp: snap.timestamp });
});

// ── POST /api/vllm-cache-monitor/record-hit ───────────────────────────────────
// Record a cache hit event. Called by vllm-proxy on prefix cache hit.
// Body: { agent_id, meta?: { sector_id, tier } }
router.post('/record-hit', (req, res) => {
  const { agent_id, meta } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  monitor.recordHit(agent_id, meta || {});
  res.json({ ok: true });
});

// ── POST /api/vllm-cache-monitor/record-miss ───────────────────────────────────
// Record a cache miss event.
router.post('/record-miss', (req, res) => {
  const { agent_id, meta } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  monitor.recordMiss(agent_id, meta || {});
  res.json({ ok: true });
});

// ── POST /api/vllm-cache-monitor/record-eviction ───────────────────────────────
// Record block eviction event.
// Body: { tier, agent_id, sector_id, block_count, reason }
router.post('/record-eviction', (req, res) => {
  const { tier, agent_id, sector_id, block_count, reason } = req.body;
  if (!tier || !agent_id) {
    return res.status(400).json({ error: 'tier and agent_id required' });
  }
  monitor.recordEviction({ tier, agent_id, sector_id, block_count, reason });
  res.json({ ok: true });
});

// ── POST /api/vllm-cache-monitor/record-invalidation ─────────────────────────
// Record prefix invalidation event.
// Body: { tier_depth, reason, sector_id }
router.post('/record-invalidation', (req, res) => {
  const { tier_depth, reason, sector_id } = req.body;
  if (!tier_depth || !reason) {
    return res.status(400).json({ error: 'tier_depth and reason required' });
  }
  monitor.recordInvalidation({ tier_depth, reason, sector_id });
  res.json({ ok: true });
});

// ── POST /api/vllm-cache-monitor/record-cpu-swap ──────────────────────────────
// Record CPU swap fallback event.
// Body: { agent_id, reason }
router.post('/record-cpu-swap', (req, res) => {
  const { agent_id, reason } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  monitor.recordCpuSwap(agent_id, reason || 'unknown');
  res.json({ ok: true });
});

// ── POST /api/vllm-cache-monitor/sector-ingestion ─────────────────────────────
// Record a sector ingestion event (invalidates Tier 3 blocks).
// Body: { sector_id }
router.post('/sector-ingestion', (req, res) => {
  const { sector_id } = req.body;
  const VALID = ['structural', 'mep', 'thermal', 'dob', 'materials', 'fire'];
  if (!sector_id || !VALID.includes(sector_id)) {
    return res.status(400).json({ error: `sector_id required, one of: ${VALID.join(', ')}` });
  }
  monitor.recordSectorIngestion(sector_id);
  res.json({ ok: true, sector_id, ingested_at: new Date().toISOString() });
});

// ── POST /api/vllm-cache-monitor/gpu-utilization ───────────────────────────────
// Update GPU memory utilization.
// Body: { utilization: 0.0–1.0 }
router.post('/gpu-utilization', (req, res) => {
  const { utilization } = req.body;
  if (typeof utilization !== 'number' || utilization < 0 || utilization > 1) {
    return res.status(400).json({ error: 'utilization must be a number 0.0–1.0' });
  }
  monitor.updateGpuUtilization(utilization);
  res.json({ ok: true, utilization });
});

// ── POST /api/vllm-cache-monitor/block-allocated ───────────────────────────────
// Update block allocation count.
// Body: { count }
router.post('/block-allocated', (req, res) => {
  const { count } = req.body;
  if (typeof count !== 'number' || count < 0) {
    return res.status(400).json({ error: 'count must be a non-negative number' });
  }
  monitor.setBlockAllocated(count);
  res.json({ ok: true, allocated: count });
});

// ── POST /api/vllm-cache-monitor/reset ─────────────────────────────────────────
// Reset all metrics — admin use only.
router.post('/reset', (req, res) => {
  const { agent_id, all } = req.body;
  if (agent_id) {
    monitor.resetAgentMetrics(agent_id);
  } else if (all) {
    monitor.resetAllMetrics();
  } else {
    return res.status(400).json({ error: 'pass agent_id or all=true' });
  }
  res.json({ ok: true, reset: agent_id ? { agent_id } : { all: true } });
});

module.exports = router;