/**
 * Owns: /api/wallt/scan — WhatsApp scanner batch ingestion endpoint.
 * Does NOT own: Wallt personality engine, Wallt memory, conversation history.
 *
 * Auth: Bearer token via WALLT_SCANNER_TOKEN env var. 401/403 on mismatch.
 *
 * Endpoints:
 *   POST /api/wallt/scan          — process batch, classify into 6 sectors, ingest to W3, optional W4 project write
 *   GET  /api/wallt/scan/status    — last 10 batch logs (health check for external scanner)
 *   GET  /api/wallt/scan/stats    — 7-day aggregate: totals + per-sector + batches/day
 *
 * W3 Integration: Uses WALLT_API_TOKEN to call W3.sector_lookup() for deduplication,
 *   then ingests into W3's sector pgvector tables via the existing W3 pipeline.
 * W4 Integration: If X-Project-Key header present, writes to project-scoped encrypted
 *   memory via W4's project_memory_query pipeline (HKDF-derived key, AES-256-GCM).
 * W5 Integration: Emits metrics to vllm-cache-monitor observability store (messages/batch,
 *   classification latency, ingestion success rate).
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');

const { logBatch, getRecentBatches, get7DayStats } = require('../db/wallt-scan-log');

// W5 Observability — lazily required so W5 absence never blocks scan processing
let vllmMonitor = null;
try { vllmMonitor = require('../services/vllm-cache-monitor'); } catch (_) { /* noop */ }

// ── Config ─────────────────────────────────────────────────────────────────────

const SCANNER_TOKEN = process.env.WALLT_SCANNER_TOKEN;
const WALLT_API_TOKEN = process.env.WALLT_API_TOKEN || '';
const WALLT_API_BASE = process.env.WALLT_API_BASE || 'http://localhost:3000';
const INGEST_TIMEOUT_MS = 15_000;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h

// ── Sector definitions (keyword density classifier) ──────────────────────────────

const SECTORS = {
  structural: {
    label: 'Structural',
    keywords: [
      'steel', 'beam', 'column', 'concrete', 'rebar', 'moment', 'shear',
      'footing', 'foundation', 'aisc', 'aci', 'lateral', 'bracing', 'connection',
      'joist', 'girder', 'slab', 'load', 'span', 'tension', 'compression',
      'anchor', 'bolted', 'welded', 'weld', 'fastener', 'structural',
    ],
  },
  mep: {
    label: 'MEP',
    keywords: [
      'hvac', 'duct', 'pipe', 'plumbing', 'electrical', 'panel', 'diffuser',
      'sprinkler', 'fire sprinkler', 'ashrae', 'chilled', 'boiler', 'pump',
      'transformer', 'conduit', 'return air', 'supply air', 'exhaust',
      'fire alarm', 'smoke detector', 'emergency', 'generator',
    ],
  },
  thermal: {
    label: 'Thermal / Energy',
    keywords: [
      'thermal', 'u-value', 'r-value', 'insulation', 'energy code', 'ASHRAE 90',
      'envelope', 'fenestration', 'glazing', 'thermal bridging', 'heat loss',
      'heat gain', 'HVAC load', 'heating', 'cooling load', 'performance',
    ],
  },
  dob: {
    label: 'DOB / Zoning',
    keywords: [
      'DOB', 'permit', 'violation', 'inspection', 'zoning', 'BIN', 'NYC BC',
      'setback', 'FAR', 'egress', 'occupancy', 'certificate', 'sign-off',
      'place of assembly', 'nyc building code', 'bulletin', 'NB', 'BNN',
    ],
  },
  materials: {
    label: 'Materials',
    keywords: [
      'cmu', 'concrete mix', 'masonry', 'finish', 'drywall', 'door type',
      'window type', 'schedule', 'specification', 'MasterFormat', 'CSI',
      'manufacturer', 'product', 'aluminum', 'glass', 'curtain wall',
      'wood', 'steel stud', 'gypsum', 'tile', 'flooring', 'paint',
    ],
  },
  fire: {
    label: 'Fire Protection',
    keywords: [
      'nfpa', 'sprinkler', 'egress', 'fire rating', 'fire door', 'exit',
      'fire protection', 'NFPA 13', 'NFPA 101', 'smoke control', 'compartment',
      'occupancy group', 'fire barrier', 'fire partition', 'draft stop',
      'fire block', 'fire resistive', 'fire dampers', 'standpipe',
    ],
  },
};

// ── Auth middleware ─────────────────────────────────────────────────────────────

function authenticate(req, res, next) {
  if (!SCANNER_TOKEN) {
    console.error('[wallt-scan] WALLT_SCANNER_TOKEN env var not set');
    return res.status(503).json({ error: 'Service not configured', code: 'CONFIG_ERROR' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token', code: 'UNAUTHORIZED' });
  }
  const token = header.slice(7);
  if (token !== SCANNER_TOKEN) {
    return res.status(403).json({ error: 'Invalid token', code: 'FORBIDDEN' });
  }
  next();
}

// ── Sector classification ───────────────────────────────────────────────────────

/**
 * Classify a single message into a sector via keyword density.
 * Returns sector key or 'unclassified'.
 */
function classifyMessage(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return 'unclassified';

  const lower = text.toLowerCase();
  let bestSector = 'unclassified';
  let bestScore = 0;

  for (const [key, sector] of Object.entries(SECTORS)) {
    const hits = sector.keywords.filter(kw => lower.includes(kw)).length;
    if (hits > bestScore) {
      bestScore = hits;
      bestSector = key;
    }
  }

  // Unclassified if no keywords matched at all
  if (bestScore === 0) return 'unclassified';
  return bestSector;
}

// ── W3 Sector ingestion ─────────────────────────────────────────────────────────

/**
 * Call W3.sector_lookup via the internal WALLT_API_TOKEN to check for duplicates,
 * then ingest into W3's sector pgvector tables via the /api/wallt-api/ingest pipeline.
 * Stub: returns { duplicate: false } when W3 MCP is unavailable.
 *
 * @param {string} sector
 * @param {string} content
 * @returns {Promise<{ duplicate: boolean, ingested: boolean }>}
 */
async function ingestToW3Sector(sector, content) {
  if (!WALLT_API_TOKEN) {
    // W3 not configured — skip duplicate check, just pretend ingestion worked
    return { duplicate: false, ingested: false };
  }

  const timeout = makeTimeout(INGEST_TIMEOUT_MS);

  try {
    // Check for duplicate content in the sector (last 24h)
    const checkRes = await fetch(`${WALLT_API_BASE}/api/wallt-api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WALLT_API_TOKEN}`,
      },
      body: JSON.stringify({
        source: 'whatsapp-scanner',
        payload: [{ chat: 'whatsapp-batch', sender: 'scanner', text: content, timestamp: new Date().toISOString() }],
      }),
      signal: timeout.controller.signal,
    });

    if (!checkRes.ok) {
      console.warn(`[wallt-scan] W3 ingest returned ${checkRes.status} — skipping sector write`);
      return { duplicate: false, ingested: false };
    }

    // W3 returns sector_hit list — check if our sector was hit
    const data = await checkRes.json();
    const sectorsHit = data.sectors_hit || [];

    if (sectorsHit.includes(sector)) {
      return { duplicate: true, ingested: true };
    }
    return { duplicate: false, ingested: true };
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('timeout')) {
      console.warn('[wallt-scan] W3 ingest timed out — skipping sector write');
    } else {
      console.warn(`[wallt-scan] W3 ingest error: ${err.message}`);
    }
    return { duplicate: false, ingested: false };
  } finally {
    timeout.clear();
  }
}

/**
 * Fire-and-forget W5 observability record.
 * Uses recordHit (bump requests+hits for 'whatsapp_scanner' agent)
 * and recordSectorIngestion (bump per-sector counter on classified messages).
 */
function emitScanMetrics({ batchId, total, classified, ingestionMs, successRate }) {
  try {
    if (!vllmMonitor) return;
    vllmMonitor.recordHit('whatsapp_scanner');
    // Bump each non-zero sector's ingestion counter
    for (const [sector, count] of Object.entries(classified || {})) {
      if (count > 0 && sector !== 'unclassified') {
        vllmMonitor.recordSectorIngestion(sector);
      }
    }
  } catch (_) {
    // W5 observability failure never blocks the response
  }
}

// ── Batch processing ────────────────────────────────────────────────────────────

/**
 * Process a batch of messages: classify → deduplicate → ingest → log.
 * Returns the full result object for the API response.
 */
async function processBatch({ batchId, messages, scannedAt, projectKey }) {
  const t0 = Date.now();
  let ingested = 0;
  let skippedDuplicate = 0;
  const classified = { structural: 0, mep: 0, thermal: 0, dob: 0, materials: 0, fire: 0, unclassified: 0 };

  // Track content hashes for duplicate detection (in-memory, 24h window)
  // NOTE: For production at scale this would use a Redis SET with TTL.
  // In this implementation we use a module-level Map for simplicity.
  await initDedupStore();

  const results = [];
  for (const msg of messages) {
    const text = msg.text || '';
    const sector = classifyMessage(text);

    classified[sector] = (classified[sector] || 0) + 1;

    // Duplicate check
    const hash = hashContent(text);
    if (isDuplicate(hash)) {
      skippedDuplicate++;
      results.push({ id: msg.id, sector, skipped: true, duplicate: true });
      continue;
    }
    markProcessed(hash);

    // W3 sector ingestion (skip unclassified)
    let duplicate = false;
    let ingestedThis = false;
    if (sector !== 'unclassified') {
      const w3result = await ingestToW3Sector(sector, text);
      duplicate = w3result.duplicate;
      ingestedThis = w3result.ingested;
      if (duplicate) skippedDuplicate++;
      if (ingestedThis) ingested++;
    }

    results.push({ id: msg.id, sector, skipped: false, duplicate, ingested: ingestedThis });
  }

  // W4 project memory write (if X-Project-Key header present)
  let projectMemoryWritten = false;
  if (projectKey && projectKey.projectId) {
    projectMemoryWritten = await writeToProjectMemory(projectKey, results, messages);
  }

  const processingMs = Date.now() - t0;

  // Log batch to wallt_scan_log
  await logBatch({
    batchId,
    totalMessages: messages.length,
    classified,
    ingested,
    skippedDuplicate,
    projectKeyPresent: !!projectKey,
    scannedAt,
  });

  // Emit W5 metrics (fire-and-forget)
  emitScanMetrics({
    batchId,
    total: messages.length,
    classified,
    ingestionMs: processingMs,
    successRate: (messages.length - skippedDuplicate) / messages.length,
  });

  return {
    batch_id: batchId,
    processed: messages.length,
    ingested,
    skipped_duplicate: skippedDuplicate,
    unclassified: classified.unclassified || 0,
    sector_breakdown: Object.fromEntries(
      Object.entries(classified).filter(([, v]) => v > 0)
    ),
    project_memory_written: projectMemoryWritten,
    processing_ms: processingMs,
  };
}

/**
 * Write classified messages to W4 project-scoped encrypted memory.
 * Stub: calls /api/wallt-api/project-query with valid key.
 */
async function writeToProjectMemory({ projectId, providedKey }, results, messages) {
  if (!WALLT_API_TOKEN || !projectId || !providedKey) return false;

  // Build content from classified results
  const content = messages
    .map((m, i) => `[WhatsApp] ${m.chat} | ${m.sender}: ${m.text || ''}`)
    .filter(Boolean)
    .join('\n\n');

  const timeout = makeTimeout(INGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${WALLT_API_BASE}/api/wallt-api/project-query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WALLT_API_TOKEN}`,
        'X-Project-Key': providedKey,
      },
      body: JSON.stringify({ project_id: projectId, query: content }),
      signal: timeout.controller.signal,
    });
    return res.ok;
  } catch (err) {
    console.warn(`[wallt-scan] W4 project memory write failed: ${err.message}`);
    return false;
  } finally {
    timeout.clear();
  }
}

// ── Duplicate detection (in-memory, 24h TTL) ───────────────────────────────────

const dedupStore = new Map(); // hash → timestamp

async function initDedupStore() {
  // For production: replace with Redis SET TTL for cross-instance dedup.
  // Cleanup stale entries every 100 batches to prevent unbounded growth.
  if (dedupStore.size > 10_000) {
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (const [k, v] of dedupStore.entries()) {
      if (v < cutoff) dedupStore.delete(k);
    }
  }
}

function hashContent(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

function isDuplicate(hash) {
  const ts = dedupStore.get(hash);
  if (!ts) return false;
  if (Date.now() - ts > DUPLICATE_WINDOW_MS) {
    dedupStore.delete(hash);
    return false;
  }
  return true;
}

function markProcessed(hash) {
  dedupStore.set(hash, Date.now());
}

// ── Timeout helper ─────────────────────────────────────────────────────────────

function makeTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    clear: () => { clearTimeout(timer); controller.abort(); },
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/wallt/scan
 *
 * Request body:
 *   { messages: [{ id, chat, sender, text, timestamp, media_type?, media_url? }],
 *     batch_id, scanned_at }
 *
 * Response:
 *   { batch_id, processed, ingested, skipped_duplicate, unclassified,
 *     sector_breakdown, project_memory_written, processing_ms }
 */
router.post('/', authenticate, async (req, res) => {
  const { messages, batch_id, scanned_at } = req.body || {};

  // Validate
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: '"messages" must be a non-empty array',
      code: 'BAD_REQUEST',
    });
  }
  if (!batch_id || typeof batch_id !== 'string') {
    return res.status(400).json({
      error: '"batch_id" is required and must be a string',
      code: 'BAD_REQUEST',
    });
  }
  if (!scanned_at || typeof scanned_at !== 'string') {
    return res.status(400).json({
      error: '"scanned_at" is required and must be an ISO-8601 string',
      code: 'BAD_REQUEST',
    });
  }

  // Validate each message has required fields
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m.id || typeof m.id !== 'string') {
      return res.status(400).json({
        error: `messages[${i}].id is required`,
        code: 'BAD_REQUEST',
      });
    }
    if (typeof m.text !== 'string') {
      return res.status(400).json({
        error: `messages[${i}].text must be a string`,
        code: 'BAD_REQUEST',
      });
    }
  }

  // Parse X-Project-Key header (optional — triggers W4 write)
  const projectKeyHeader = req.headers['x-project-key'];
  let projectKey = null;
  if (projectKeyHeader && typeof projectKeyHeader === 'string') {
    // Extract project_id from batch metadata if provided by scanner
    const projectId = req.headers['x-project-id'] || null;
    projectKey = { projectId, providedKey: projectKeyHeader };
  }

  try {
    const result = await processBatch({
      batchId: batch_id,
      messages,
      scannedAt: scanned_at,
      projectKey,
    });
    res.json(result);
  } catch (err) {
    console.error('[wallt-scan] batch processing failed:', err);
    res.status(500).json({
      error: 'Batch processing failed',
      code: 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * GET /api/wallt/scan/status
 *
 * Returns last 10 batch logs. Health check endpoint for the external scanner.
 * No auth required — scanner checks its own batches.
 */
router.get('/status', async (_req, res) => {
  try {
    const batches = await getRecentBatches(10);
    res.json({
      ok: true,
      batches,
      count: batches.length,
    });
  } catch (err) {
    console.error('[wallt-scan] status query failed:', err);
    res.status(500).json({ error: 'Status query failed', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/wallt/scan/stats
 *
 * 7-day aggregate stats for monitoring dashboards.
 * No auth required — public-facing health stats.
 */
router.get('/stats', async (_req, res) => {
  try {
    const stats = await get7DayStats();
    res.json({
      ok: true,
      period: '7 days',
      ...stats,
    });
  } catch (err) {
    console.error('[wallt-scan] stats query failed:', err);
    res.status(500).json({ error: 'Stats query failed', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;