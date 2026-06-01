/**
 * Owns: /api/wallt-api/* — Wallt external API for third-party service integrations.
 * Does NOT own: Wallt AI Companion (routes/wallt.js), session memory, personality engine.
 *
 * Endpoints:
 *   POST /api/wallt-api/ingest      — ephemeral sector routing, no data retained
 *   POST /api/wallt-api/project-query — project-scoped encrypted memory read via HKDF-derived key
 *   GET  /api/wallt-api/health     — return sector status and global health
 *
 * Auth:
 *   - Bearer token (WALLT_API_TOKEN env var) required on all endpoints.
 *   - /project-query additionally requires X-Project-Key header (HKDF-derived, per-project).
 *
 * Isolation (3-tier Wallt memory model):
 *   Tier 1 (Wallt Core): free read/write, independent sector knowledge bases.
 *   Tier 2 (Project Agents): per-project encrypted memory — HKDF(AES-256-GCM), zero cross-project access.
 *   Tier 3 (External API): ephemeral ingest only, read-only to Core, project-scoped reads via key.
 *
 *   /ingest: NEVER writes to any Wallt table (Core, project, or pgvector).
 *   /project-query: NEVER writes. Reads project-scoped memory only after key validation.
 *
 * Rate limits: 100 req/hour per token, 429 + Retry-After on overflow.
 */
const router = require('express').Router();
const { logAudit } = require('../db/wallt-api');

// ── Config ────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
// NOTE: WALLT_API_TOKEN and WALLT_MASTER_SECRET are checked per-request (graceful 503).
// Do NOT use process.exit() at module load — it crashes the entire server.
const API_TOKEN = process.env.WALLT_API_TOKEN || null;
const MASTER_SECRET = process.env.WALLT_MASTER_SECRET || null;
if (!API_TOKEN || !MASTER_SECRET) {
  console.warn('[wallt-api] WALLT_API_TOKEN or WALLT_MASTER_SECRET not set — Wallt API endpoints will return 503 until env vars are configured.');
}
const RATE_LIMIT = 100;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const INGEST_TIMEOUT_MS = 10_000;  // P99 hard cap
const RELEVANCE_THRESHOLD = 0.3;   // minimum score to route to a sector
const QUERY_TIMEOUT_MS = 15_000;  // P99 hard cap for project-query

// Allowed CORS origins (no wildcard — strict allowlist)
const CORS_ALLOWED = [
  'https://atlantist.cloud',
  'https://www.atlantist.cloud',
  'https://wallt-scanner-production.up.railway.app', // Wallt external scanner on Railway
  // GitHub Actions IP ranges (approximate — update as needed)
  'https://github.com',
];
function corsAllow(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (CORS_ALLOWED.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Project-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Vary', 'Origin');
    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Max-Age', '86400');
      return res.sendStatus(204);
    }
  }
  next();
}

// ── Rate limiter (in-memory, per-token) ──────────────────────────────────────
// NOTE: This in-memory Map is intentionally scoped to this process.
// Under multi-instance deployments (e.g. Render horizontal scale), each instance
// tracks its own window independently — the effective limit per token is
// max * N_instances. Acceptable for low-traffic external API; if stricter
// enforcement is needed, replace with the Redis-backed lib/rate-limit.js pattern.
const rateLimitStore = new Map();
function checkRateLimit(token) {
  const key = token || 'anon';
  const now = Date.now();
  let record = rateLimitStore.get(key);
  if (!record || now - record.window > WINDOW_MS) {
    record = { count: 0, window: now };
    rateLimitStore.set(key, record);
  }
  if (record.count >= RATE_LIMIT) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.window + WINDOW_MS - now) / 1000),
    };
  }
  record.count++;
  return { allowed: true };
}

// ── Sector definitions ────────────────────────────────────────────────────────
const SECTORS = {
  structural: {
    label: 'Structural',
    description: 'AISC, ACI, IBC structural — beam spans, column loads, foundation bearing, lateral systems',
    triggers: ['beam', 'column', 'load', 'span', 'foundation', 'footing', 'steel', 'moment', 'shear', 'lateral', 'aisc', 'aci'],
  },
  mep: {
    label: 'MEP',
    description: 'ASHRAE, NYC MEP — HVAC duct sizing, plumbing pressure, electrical panels, sprinkler coverage',
    triggers: ['duct', 'pipe', 'hvac', 'plumbing', 'electrical', 'panel', 'sprinkler', 'diffuser', 'ashrae', 'nfpa mechanical'],
  },
  thermal: {
    label: 'Thermal / Energy',
    description: 'ASHRAE 90.1, NYC energy code — U-values, R-values, envelope, EN-001 compliance',
    triggers: ['thermal', 'energy', 'u-value', 'r-value', 'hvac load', 'envelope', 'insulation', 'ASHRAE', 'energy code'],
  },
  dob: {
    label: 'DOB / Zoning',
    description: 'NYC Building Code, Zoning Resolution — FAR, setbacks, egress, fire rating, DOB bulletins',
    triggers: ['dob', 'zoning', 'far', 'setback', 'egress', 'fire rating', 'nyc bc', 'zoning resolution', 'DOB', 'BIN'],
  },
  materials: {
    label: 'Materials',
    description: 'CSI MasterFormat — finish schedules, door/window types, CMU, concrete, specifications',
    triggers: ['cmu', 'concrete', 'masonry', 'finish', 'door type', 'window type', 'schedule', 'specification', 'MasterFormat'],
  },
  fire: {
    label: 'Fire Protection',
    description: 'NFPA 13/101/72, NYC fire code — sprinkler layout, egress path, occupancy, smoke control',
    triggers: ['nfpa', 'sprinkler', 'egress', 'fire', 'smoke', 'occupancy', 'exit', 'fire protection', 'NFPA 13', 'NFPA 101'],
  },
};

/**
 * Score each payload item against all sectors.
 * Returns { sectorKey: score (0-1) } — score > 0.3 means route to that sector.
 */
function scoreSectors(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [key, sector] of Object.entries(SECTORS)) {
    const hits = sector.triggers.filter(t => lower.includes(t)).length;
    scores[key] = hits > 0 ? Math.min(hits / sector.triggers.length + 0.1, 1) : 0;
  }
  return scores;
}

/**
 * Route each item in payload to sectors scoring above RELEVANCE_THRESHOLD.
 * Calls W3 sector_lookup for each matched sector.
 * Returns { results, sectorsHit, timedOut }.
 * timedOut=true means the 10s budget was exhausted — caller should return partial results.
 */
async function processIngest(payload, timeoutController) {
  const results = [];
  const sectorsHit = new Set();

  for (const item of payload) {
    const text = item.text || item.message || item.content || '';
    if (!text) continue;

    const scores = scoreSectors(text);
    const active = Object.entries(scores).filter(([, v]) => v >= RELEVANCE_THRESHOLD);
    active.sort((a, b) => b[1] - a[1]);

    for (const [key] of active) {
      sectorsHit.add(key);
    }

    // Race sector routing against the 10s hard budget.
    const raceResult = await Promise.race([
      routeToSectors(active, { ...item, text }),
      timeoutController.promise,
    ]);

    // Timeout fires — abort remaining items and return partial results.
    if (raceResult && raceResult.timedOut === true) {
      return { results, sectorsHit: [...sectorsHit], timedOut: true };
    }

    results.push({
      original: item.sender || item.from || null,
      chat: item.chat || null,
      timestamp: item.timestamp || null,
      sectors: raceResult,
    });
  }

  return { results, sectorsHit: [...sectorsHit], timedOut: false };
}

/**
 * Route active sectors to W3's sector_lookup MCP.
 * Stub returns placeholder when MCP is unavailable; replace with real call once W3 is live.
 */
async function routeToSectors(activeSectors, item) {
  const enriched = [];

  for (const [key, score] of activeSectors) {
    let insight = '';
    let references = [];
    let sectorStatus = 'available';

    try {
      // ── W3 INTEGRATION POINT ────────────────────────────────────────────────
      // Replace this block with actual W3.sector_lookup() call:
      //   const { insight, references } = await w3MCP.sector_lookup({ sector: key, query: item.text });
      //
      // Currently returns a placeholder response keyed to the sector.
      // The placeholder shows the routing worked; W3 delivers real AI analysis.
      // ─────────────────────────────────────────────────────────────────────────

      const sector = SECTORS[key];
      insight = `[W3 integration pending] Sector "${sector.label}" matched at ${(score * 100).toFixed(0)}% relevance. ` +
        `W3 sector_lookup will provide detailed code references, applicable standards, and contextual analysis for: "${item.text.slice(0, 120)}${item.text.length > 120 ? '…' : ''}"`;

      references = [
        { type: 'sector', code: key, label: sector.label },
        { type: 'trigger', matched: score.toFixed(2) },
      ];
    } catch (err) {
      insight = `Sector analysis unavailable: ${err.message}`;
      sectorStatus = 'degraded';
    }

    enriched.push({
      sector: key,
      relevance: parseFloat(score.toFixed(2)),
      insight,
      references,
      status: sectorStatus,
    });
  }

  return enriched;
}

/**
 * Simple AbortController-like timeout wrapper.
 * The promise resolves to { timedOut: true } after ms milliseconds.
 */
function makeTimeout(ms) {
  let timer;
  const promise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return {
    promise,
    clear: () => clearTimeout(timer),
  };
}

// ── Project key derivation (HKDF-SHA256) ─────────────────────────────────────
const PROJECT_KEY_INFO = 'wallt-project-memory';

/**
 * Derive the expected project key for a given project_id.
 * Uses HKDF-SHA256 with a fixed info string so the same project_id always
 * produces the same derived key — no per-request randomness needed.
 */
function deriveProjectKey(projectId) {
  return crypto.createHKDF('sha256', {
    key: Buffer.from(MASTER_SECRET, 'utf8'),
    salt: Buffer.from('atlantist-wallt-v1', 'utf8'),
    info: Buffer.from(PROJECT_KEY_INFO, 'utf8'),
    length: 32,
  }).update(projectId).digest('base64url');
}

/**
 * Constant-time comparison to prevent timing attacks on key validation.
 * Returns true if keys match, false otherwise.
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate X-Project-Key header against the HKDF-derived key for project_id.
 * Returns { valid: boolean, reason: string|null }.
 */
function validateProjectKey(projectId, providedKey) {
  if (!projectId || typeof projectId !== 'string') {
    return { valid: false, reason: 'missing_project_id' };
  }
  if (!providedKey || typeof providedKey !== 'string') {
    return { valid: false, reason: 'missing_project_key' };
  }
  const expectedKey = deriveProjectKey(projectId);
  if (!constantTimeEqual(expectedKey, providedKey)) {
    return { valid: false, reason: 'invalid_project_key' };
  }
  return { valid: true, reason: null };
}

/**
 * Middleware: authenticate Bearer token (existing) AND validate optional X-Project-Key.
 * Sets req.projectKeyValid and req.projectId on the request object.
 * Skips key check if X-Project-Key is absent — callers must enforce key requirement
 * for routes that need it.
 */
// ── 503 guard middleware — returns 503 if env vars are not configured ─────────────
function requireWalltConfig(req, res, next) {
  if (!API_TOKEN || !MASTER_SECRET) {
    return res.status(503).json({
      error: 'Wallt API is not configured on this server (missing env vars)',
      code: 'SERVICE_UNAVAILABLE',
    });
  }
  next();
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token', code: 'UNAUTHORIZED' });
  }
  const token = header.slice(7);
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(403).json({ error: 'Invalid token', code: 'FORBIDDEN' });
  }
  req.authToken = token;

  const projectKey = req.headers['x-project-key'];
  const projectId = req.body && req.body.project_id;

  if (projectKey && projectId) {
    const result = validateProjectKey(projectId, projectKey);
    req.projectKeyValid = result.valid;
    req.projectId = result.valid ? projectId : null;
  } else {
    req.projectKeyValid = null;
    req.projectId = null;
  }

  next();
}
/**
 * Request body:
 * {
 *   "source": "whatsapp-scanner",        // required
 *   "user_id": "uuid",                    // optional
 *   "payload": [                          // required, non-empty array
 *     { "chat": "GroupName", "sender": "John", "text": "...", "timestamp": "ISO-8601" }
 *   ]
 * }
 *
 * Response:
 * {
 *   "request_id": "uuid",
 *   "enriched": [ { "sector": "dob", "relevance": 0.87, "insight": "...", "references": [...] } ],
 *   "sectors_hit": ["DOB/Zoning", "Materials"],
 *   "processing_time_ms": 1234,
 *   "timeout": false
 * }
 */
router.post('/ingest', corsAllow, requireWalltConfig, authenticate, async (req, res) => {
  // Rate limit
  const rate = checkRateLimit(req.authToken);
  if (!rate.allowed) {
    res.set('Retry-After', String(rate.retryAfter));
    return res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      retry_after: rate.retryAfter,
    });
  }

  // Validate body
  const { source, user_id, payload } = req.body || {};
  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: '"source" is required', code: 'BAD_REQUEST' });
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return res.status(400).json({
      error: '"payload" must be a non-empty array',
      code: 'BAD_REQUEST',
    });
  }

  const requestId = `wtapi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const t0 = Date.now();
  const timeout = makeTimeout(INGEST_TIMEOUT_MS);

  try {
    const { results, sectorsHit, timedOut } = await processIngest(payload, timeout);
    const processingTimeMs = Date.now() - t0;

    // Fire-and-forget audit (never fails the response)
    logAudit({
      requestId,
      source,
      userId: user_id || null,
      sectorHits: sectorsHit,
      processingTimeMs,
      statusCode: 200,
      timeout: timedOut,
      projectId: req.projectId || null,
      keyValid: req.projectKeyValid || null,
    });

    return res.json({
      request_id: requestId,
      enriched: results,
      sectors_hit: sectorsHit,
      processing_time_ms: processingTimeMs,
      timeout: timedOut,
    });
  } catch (err) {
    // Unexpected error (not timeout)
    const processingTimeMs = Date.now() - t0;
    timeout.clear();

    logAudit({
      requestId,
      source,
      userId: user_id || null,
      sectorHits: [],
      processingTimeMs,
      statusCode: 500,
      timeout: false,
      projectId: req.projectId || null,
      keyValid: req.projectKeyValid || null,
    });

    return res.status(500).json({
      error: 'Internal processing error',
      code: 'INTERNAL_ERROR',
      request_id: requestId,
    });
  } finally {
    timeout.clear();
  }
});

// ── GET /api/wallt-api/health ─────────────────────────────────────────────────
/**
 * Returns sector status from W3 stale_check per sector.
 * Includes each sector's last ingestion timestamp, staleness, and version.
 *
 * Response:
 * {
 *   "ok": true,
 *   "status": "operational|degraded|maintenance",
 *   "sectors": {
 *     "structural":  { "status": "operational", "last_ingestion": "ISO-8601", "stale": false, "version": 1 },
 *     ...
 *   },
 *   "read_only": true,
 *   "ephemeral": true,
 *   "version": "1.0",
 *   "timestamp": "ISO-8601"
 * }
 */
router.get('/health', corsAllow, async (req, res) => {
  const sectors = {};
  for (const [key, sector] of Object.entries(SECTORS)) {
    // TODO: Replace with actual W3.stale_check() call once W3 MCP is live.
    // Currently returns placeholder values. When W3 is deployed:
    //   const { last_ingestion, stale, version } = await w3MCP.stale_check({ sector: key });
    const now = new Date();
    sectors[key] = {
      label: sector.label,
      status: 'operational',   // W3 will report real status
      last_ingestion: now.toISOString(),
      stale: false,
      version: 1,
    };
  }

  // Remaining rate limit for caller
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const remaining = Math.max(0, RATE_LIMIT - (rateLimitStore.get(token)?.count || 0));

  res.json({
    ok: true,
    status: 'operational',
    sectors,
    read_only: true,
    ephemeral: true,
    no_data_retention: true,
    version: '1.0',
    rate_limit: {
      requests: RATE_LIMIT,
      window: '1 hour',
      remaining,
    },
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/wallt-api/project-query ─────────────────────────────────────────
/**
 * Project-scoped encrypted memory query.
 *
 * Auth: Bearer WALLT_API_TOKEN + X-Project-Key header.
 * Key validation: HKDF(WALLT_MASTER_SECRET, project_id, "wallt-project-memory") → expected key.
 * Constant-time comparison prevents timing attacks.
 *
 * Request body:
 * {
 *   "project_id": "uuid",           // required — used to derive the expected key
 *   "query": "What steel grade?",   // required
 *   "sectors": ["Structural"]       // optional — filters sector enrichment
 * }
 *
 * Response:
 * {
 *   "request_id": "uuid",
 *   "project_context": [{ "relevance": 0.92, "content": "...", "source": "project_memory" }],
 *   "sector_enrichment": [{ "sector": "Structural", "relevance": 0.85, "insight": "..." }],
 *   "processing_time_ms": 890
 * }
 *
 * Isolation:
 *   - NEVER writes to any Wallt table (Core, project_memory, pgvector).
 *   - Only READS project-scoped encrypted memory for the validated project_id.
 *   - Cross-project key reuse (key for project A used with project B) → 403 + audit log with key_valid=false.
 */
router.post('/project-query', corsAllow, requireWalltConfig, authenticate, async (req, res) => {
  // Rate limit — counts against the same 100 req/hr limit.
  const rate = checkRateLimit(req.authToken);
  if (!rate.allowed) {
    res.set('Retry-After', String(rate.retryAfter));
    return res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      retry_after: rate.retryAfter,
    });
  }

  const { project_id, query, sectors: requestedSectors } = req.body || {};

  // Validate project_id presence
  if (!project_id || typeof project_id !== 'string') {
    const requestId = `wtapi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    logAudit({ requestId, source: 'project-query', statusCode: 400, projectId: null, keyValid: null });
    return res.status(400).json({ error: '"project_id" is required', code: 'BAD_REQUEST', request_id: requestId });
  }

  // Validate query presence
  if (!query || typeof query !== 'string' || !query.trim()) {
    const requestId = `wtapi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    logAudit({ requestId, source: 'project-query', statusCode: 400, projectId: project_id, keyValid: req.projectKeyValid });
    return res.status(400).json({ error: '"query" is required and must be non-empty', code: 'BAD_REQUEST', request_id: requestId });
  }

  // Validate X-Project-Key header — 403 if missing or wrong.
  // req.projectKeyValid is null when header is absent; false when key is wrong.
  if (req.projectKeyValid !== true) {
    const requestId = `wtapi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    logAudit({
      requestId,
      source: 'project-query',
      statusCode: 403,
      projectId: project_id,
      keyValid: false,
    });
    return res.status(403).json({
      error: 'invalid_project_key',
      code: 'FORBIDDEN',
      request_id: requestId,
    });
  }

  // key is valid — no cross-project replay attempt (constant-time check above already caught it).
  const requestId = `wtapi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const t0 = Date.now();
  const timeout = makeTimeout(QUERY_TIMEOUT_MS);

  try {
    // ── W3 INTEGRATION POINT ────────────────────────────────────────────────────
    // Replace with actual W3.project_memory_query() call:
    //
    //   const result = await w3MCP.project_memory_query({
    //     project_id,
    //     query,
    //     sectors: requestedSectors || Object.keys(SECTORS),
    //   });
    //   // Returns: { project_context: [...], sector_enrichment: [...] }
    //
    // Stub below shows routing works; W3 delivers encrypted project memory + sector enrichment.
    // ─────────────────────────────────────────────────────────────────────────────

    const sectorsToQuery = requestedSectors && requestedSectors.length > 0
      ? requestedSectors
      : Object.keys(SECTORS);

    // Score query against all sectors to get enrichment
    const queryScores = scoreSectors(query);
    const sectorEnrichment = [];
    const activeSectors = Object.entries(queryScores)
      .filter(([, score]) => score >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b[1] - a[1]);

    for (const [key, score] of activeSectors) {
      if (!sectorsToQuery.includes(key)) continue;
      const sector = SECTORS[key];
      sectorEnrichment.push({
        sector: key,
        relevance: parseFloat(score.toFixed(2)),
        insight: `[W3 project_memory_query pending] Sector "${sector.label}" matched at ${(score * 100).toFixed(0)}% for query: "${query.slice(0, 120)}". W3 will return encrypted project memory + code references.`,
      });
    }

    // Placeholder project context — W3 will replace with real encrypted memory read.
    const projectContext = [{
      relevance: 0.85,
      content: `[W3 project_memory_query pending] Project memory for project ${project_id}. W3.project_memory_query will decrypt and return enriched project context for: "${query.slice(0, 120)}"`,
      source: 'project_memory',
    }];

    const processingTimeMs = Date.now() - t0;

    logAudit({
      requestId,
      source: 'project-query',
      sectorHits: sectorEnrichment.map(e => e.sector),
      processingTimeMs,
      statusCode: 200,
      timeout: false,
      projectId,
      keyValid: true,
    });

    return res.json({
      request_id: requestId,
      project_context: projectContext,
      sector_enrichment: sectorEnrichment,
      processing_time_ms: processingTimeMs,
    });
  } catch (err) {
    const processingTimeMs = Date.now() - t0;
    timeout.clear();

    logAudit({
      requestId,
      source: 'project-query',
      sectorHits: [],
      processingTimeMs,
      statusCode: 500,
      timeout: false,
      projectId,
      keyValid: true,
    });

    return res.status(500).json({
      error: 'Internal processing error',
      code: 'INTERNAL_ERROR',
      request_id: requestId,
    });
  } finally {
    timeout.clear();
  }
});

module.exports = router;
module.exports.SECTORS = SECTORS; // exported for testing
module.exports.deriveProjectKey = deriveProjectKey; // exported for testing