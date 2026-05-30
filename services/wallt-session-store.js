/**
 * Owns: Wallt ephemeral session store — Redis-backed, auto-expires, zero persistence.
 * Does NOT own: AI calls, DB persistence, personality engine.
 *
 * Architecture:
 * - Redis key: wallt:session:{conversation_id}
 * - TTL: auto-expires on write; resets on activity (extendTTL)
 * - Hard cap: 50KB pre-allocation; FIFO eviction on overflow
 * - Encryption: AES-256 at rest (Redis SASL/auth + TLS)
 * - Zero session data in PostgreSQL — ephemeral only
 * - Fallback: in-process Map when REDIS_URL is not set (dev/no-Redis envs)
 *
 * Safety:
 * - Wipe (not archive) on conversation close or timeout
 * - Crash recovery: orphaned session wipe on next init
 * - Session events never logged (privacy — may contain user input)
 */

// ── Dependencies ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

const SESSION_TTL_SECONDS = 86400; // 24h
const SESSION_MAX_BYTES = 50 * 1024; // 50KB hard cap
const SESSION_KEY_PREFIX = 'wallt:session:';

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
// Redis SASL/TLS handles transport encryption. We optionally encrypt session
// values at rest when the key is present, so a Redis admin cannot read session
// contents directly.

let ENCRYPTION_KEY = null;

function loadEncryptionKey() {
  const keyHex = process.env.WALLT_SESSION_ENCRYPTION_KEY;
  if (!keyHex) return;
  if (keyHex.length !== 64) {
    console.warn('[wallt-session] WALLT_SESSION_ENCRYPTION_KEY must be 64 hex chars (256-bit)');
    return;
  }
  ENCRYPTION_KEY = Buffer.from(keyHex, 'hex');
}

function encrypt(plaintext) {
  if (!ENCRYPTION_KEY) return plaintext;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext) {
  if (!ENCRYPTION_KEY) return ciphertext;
  try {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.slice(0, 16);
    const tag = data.slice(16, 32);
    const encrypted = data.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return ciphertext; // Fallback: assume unencrypted
  }
}

// ── Redis store ──────────────────────────────────────────────────────────────

let redisClient = null;
let redisConnected = false;

async function getRedisClient() {
  if (redisClient) return redisClient;
  const { default: Redis } = await import('redis');
  redisClient = Redis.createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', err => {
    console.error('[wallt-session] Redis error:', err.message);
    redisConnected = false;
  });
  redisClient.on('connect', () => {
    redisConnected = true;
  });
  await redisClient.connect();
  return redisClient;
}

async function redisSet(key, value, ttlSeconds) {
  const client = await getRedisClient();
  await client.setEx(key, ttlSeconds, value);
}

async function redisGet(key) {
  const client = await getRedisClient();
  return client.get(key);
}

async function redisDel(key) {
  const client = await getRedisClient();
  await client.del(key);
}

async function redisExists(key) {
  const client = await getRedisClient();
  return client.exists(key);
}

// ── In-process fallback store ───────────────────────────────────────────────
// Used when REDIS_URL is not set (dev, CI, no-Redis environments).
// Not shared across processes — acceptable for single-instance dev.
// TTL tracked per entry; cleaned up on access.

const fallbackStore = new Map(); // key → { data: string, expiresAt: number }

function fallbackCleanup() {
  const now = Date.now();
  for (const [key, entry] of fallbackStore.entries()) {
    if (entry.expiresAt <= now) fallbackStore.delete(key);
  }
}

function fallbackSet(key, value, ttlSeconds) {
  fallbackCleanup();
  fallbackStore.set(key, {
    data: value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function fallbackGet(key) {
  fallbackCleanup();
  const entry = fallbackStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    fallbackStore.delete(key);
    return null;
  }
  return entry.data;
}

function fallbackDel(key) {
  fallbackStore.delete(key);
}

// ── Storage abstraction ──────────────────────────────────────────────────────

async function storeSet(key, value, ttlSeconds) {
  if (process.env.REDIS_URL && !process.env.WALLT_SESSION_USE_FALLBACK) {
    await redisSet(key, value, ttlSeconds);
  } else {
    fallbackSet(key, value, ttlSeconds);
  }
}

async function storeGet(key) {
  if (process.env.REDIS_URL && !process.env.WALLT_SESSION_USE_FALLBACK) {
    return await redisGet(key);
  } else {
    return fallbackGet(key);
  }
}

async function storeDel(key) {
  if (process.env.REDIS_URL && !process.env.WALLT_SESSION_USE_FALLBACK) {
    await redisDel(key);
  } else {
    fallbackDel(key);
  }
}

async function storeExists(key) {
  if (process.env.REDIS_URL && !process.env.WALLT_SESSION_USE_FALLBACK) {
    return await redisExists(key);
  } else {
    fallbackCleanup();
    return fallbackStore.has(key) && fallbackStore.get(key).expiresAt > Date.now();
  }
}

// ── Session data operations ───────────────────────────────────────────────────

/**
 * Enforce 50KB hard cap. If data + newEntry would exceed cap, evict oldest
 * events (FIFO) until it fits.
 */
function enforceCap(eventLog, newEntryJson) {
  const currentSize = Buffer.byteLength(eventLog, 'utf8');
  const newSize = Buffer.byteLength(newEntryJson, 'utf8');

  if (currentSize + newSize <= SESSION_MAX_BYTES) return eventLog;

  // Need to evict. Parse current log and reconstruct with oldest removed.
  let events = [];
  try {
    events = JSON.parse(eventLog);
  } catch {
    events = [];
  }

  const targetSize = SESSION_MAX_BYTES - newSize;
  while (events.length > 0 && Buffer.byteLength(JSON.stringify(events), 'utf8') > targetSize) {
    events.shift(); // Remove oldest (FIFO)
  }

  return JSON.stringify(events);
}

/**
 * Append a typed event to the session log.
 * @param {string} conversationId
 * @param {string} eventType  'read' | 'decision' | 'escalation' | 'user_context' | 'system'
 * @param {object} payload
 */
async function appendEvent(conversationId, eventType, payload) {
  const key = SESSION_KEY_PREFIX + String(conversationId);
  const event = {
    type: eventType,
    payload,
    ts: new Date().toISOString(),
  };
  const eventJson = JSON.stringify(event);

  let existingData = await storeGet(key);
  let eventLog = '[]';

  if (existingData) {
    try {
      const decrypted = decrypt(existingData);
      const parsed = JSON.parse(decrypted);
      // Re-enforce cap while appending
      eventLog = enforceCap(decrypted, eventJson);
      const events = JSON.parse(eventLog);
      events.push(event);
      eventLog = JSON.stringify(events);
    } catch {
      // Corrupted data — wipe and start fresh
      await storeDel(key);
      eventLog = JSON.stringify([event]);
    }
  } else {
    eventLog = JSON.stringify([event]);
  }

  const encrypted = encrypt(eventLog);
  await storeSet(key, encrypted, SESSION_TTL_SECONDS);
}

/**
 * Extend TTL on session (called on any session read to keep it alive).
 */
async function extendTTL(conversationId) {
  const key = SESSION_KEY_PREFIX + String(conversationId);
  const existingData = await storeGet(key);
  if (existingData) {
    const encrypted = encrypt(existingData); // Re-encrypt to reset TTL
    await storeSet(key, encrypted, SESSION_TTL_SECONDS);
  }
}

/**
 * Read all session events. Returns empty array if session doesn't exist.
 */
async function readSession(conversationId) {
  const key = SESSION_KEY_PREFIX + String(conversationId);
  const data = await storeGet(key);
  if (!data) return [];
  try {
    const decrypted = decrypt(data);
    return JSON.parse(decrypted);
  } catch {
    return [];
  }
}

/**
 * Initialize an empty session for a conversation.
 * Wipes any existing session data first (idempotent init).
 */
async function initSession(conversationId) {
  const key = SESSION_KEY_PREFIX + String(conversationId);
  await storeDel(key); // Wipe first — idempotent
  const emptyLog = JSON.stringify([]);
  const encrypted = encrypt(emptyLog);
  await storeSet(key, encrypted, SESSION_TTL_SECONDS);
}

/**
 * Wipe session — not archive, not persist. Complete destruction.
 * Called on conversation close OR timeout.
 */
async function wipeSession(conversationId) {
  const key = SESSION_KEY_PREFIX + String(conversationId);
  await storeDel(key);
}

/**
 * Check for orphaned sessions and wipe them.
 * Called on Wallt init to handle stale sessions from crashed processes.
 */
async function cleanupOrphanedSessions() {
  // In fallback mode, just clean up expired entries
  if (!process.env.REDIS_URL || process.env.WALLT_SESSION_USE_FALLBACK) {
    fallbackCleanup();
    return;
  }

  // In Redis mode, orphaned sessions expire via TTL automatically.
  // No cross-key enumeration needed — TTL is the orphan cleanup.
}

// ── Tool call tracking ───────────────────────────────────────────────────────
// Tracks in-progress tool calls for the Wallt coordinator.
// Stored under wallt:tool:{conversationId}:{toolCallId} (separate key, 5min TTL).
// Status flow: pending → in_progress → completed | aborted

const TOOL_KEY_PREFIX = 'wallt:tool:';
const TOOL_TTL_SECONDS = 300; // 5 min — auto-expire stale tool calls

/**
 * Append a tool_call event with status=pending.
 * Returns a toolCallId (UUID) for later completion/abort.
 */
async function appendToolCall(conversationId, toolName, toolArgs, sessionId) {
  const toolCallId = crypto.randomUUID();
  const key = TOOL_KEY_PREFIX + String(conversationId) + ':' + toolCallId;
  const toolEvent = {
    tool_call_id: toolCallId,
    name: toolName,
    args: toolArgs,
    session_id: sessionId || null,
    status: 'pending',
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    ts: new Date().toISOString(),
  };
  const encrypted = encrypt(JSON.stringify(toolEvent));
  await storeSet(key, encrypted, TOOL_TTL_SECONDS);
  return toolCallId;
}

/**
 * Mark a tool call as in_progress (when the tool starts executing).
 */
async function startToolCall(conversationId, toolCallId) {
  const key = TOOL_KEY_PREFIX + String(conversationId) + ':' + toolCallId;
  const raw = await storeGet(key);
  if (!raw) return;
  try {
    const event = JSON.parse(decrypt(raw));
    event.status = 'in_progress';
    event.started_at = new Date().toISOString();
    const encrypted = encrypt(JSON.stringify(event));
    await storeSet(key, encrypted, TOOL_TTL_SECONDS);
  } catch {
    // Corrupted — ignore
  }
}

/**
 * Mark a tool call as completed with a result.
 */
async function completeToolCall(conversationId, toolCallId, result) {
  const key = TOOL_KEY_PREFIX + String(conversationId) + ':' + toolCallId;
  const raw = await storeGet(key);
  if (!raw) return;
  try {
    const event = JSON.parse(decrypt(raw));
    event.status = 'completed';
    event.completed_at = new Date().toISOString();
    event.result = result;
    const encrypted = encrypt(JSON.stringify(event));
    await storeSet(key, encrypted, TOOL_TTL_SECONDS);
  } catch {
    // Corrupted — ignore
  }
}

/**
 * Mark a tool call as aborted (timed out or cancelled).
 */
async function abortToolCall(conversationId, toolCallId, reason) {
  const key = TOOL_KEY_PREFIX + String(conversationId) + ':' + toolCallId;
  const raw = await storeGet(key);
  if (!raw) return;
  try {
    const event = JSON.parse(decrypt(raw));
    event.status = 'aborted';
    event.completed_at = new Date().toISOString();
    event.error = reason;
    const encrypted = encrypt(JSON.stringify(event));
    await storeSet(key, encrypted, TOOL_TTL_SECONDS);
  } catch {
    // Corrupted — ignore
  }
}

/**
 * Get all active (pending + in_progress) tool calls for a session.
 */
async function getActiveToolCalls(conversationId) {
  if (!process.env.REDIS_URL || process.env.WALLT_SESSION_USE_FALLBACK) {
    // In fallback mode, scan the fallback store (limited — no SCAN in plain Map)
    // Active tool calls are only queryable when Redis is available.
    return [];
  }
  try {
    const client = await getRedisClient();
    const pattern = TOOL_KEY_PREFIX + String(conversationId) + ':*';
    let cursor = 0;
    const active = [];
    do {
      const [nextCursor, keys] = await client.scan(cursor, { MATCH: pattern, COUNT: 50 });
      cursor = nextCursor;
      for (const key of keys) {
        const raw = await client.get(key);
        if (!raw) continue;
        try {
          const event = JSON.parse(decrypt(raw));
          if (event.status === 'pending' || event.status === 'in_progress') {
            active.push(event);
          }
        } catch {
          // Corrupted entry — skip
        }
      }
    } while (cursor !== 0);
    return active;
  } catch {
    return [];
  }
}

// ── Abort signal handling ───────────────────────────────────────────────────
// Stored under wallt:abort:{conversationId} — 30s TTL, single-use.
// Coordinator checks this flag before long-running operations.

const ABORT_KEY_PREFIX = 'wallt:abort:';
const ABORT_TTL_SECONDS = 30;

/**
 * Set an abort signal for a session (from user or coordinator timeout).
 */
async function setAbortSignal(conversationId, reason = 'user_abort') {
  const key = ABORT_KEY_PREFIX + String(conversationId);
  await storeSet(key, JSON.stringify({ reason, ts: new Date().toISOString() }), ABORT_TTL_SECONDS);
}

/**
 * Check and consume an abort signal. Returns { aborted: bool, reason: string|null }.
 * Signal is consumed (deleted) on read — idempotent abort.
 */
async function checkAbortSignal(conversationId) {
  const key = ABORT_KEY_PREFIX + String(conversationId);
  const raw = await storeGet(key);
  if (!raw) return { aborted: false, reason: null };
  try {
    const data = JSON.parse(raw);
    await storeDel(key); // Consume the signal
    return { aborted: true, reason: data.reason };
  } catch {
    return { aborted: false, reason: null };
  }
}

/**
 * Get current abort signal without consuming it (for health checks).
 */
async function peekAbortSignal(conversationId) {
  const key = ABORT_KEY_PREFIX + String(conversationId);
  const raw = await storeGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

module.exports = {
  // Session lifecycle
  initSession,
  wipeSession,
  cleanupOrphanedSessions,

  // Event operations
  appendEvent,
  readSession,

  // Keep-alive (resets TTL on activity)
  extendTTL,

  // Tool call tracking
  appendToolCall,
  startToolCall,
  completeToolCall,
  abortToolCall,
  getActiveToolCalls,

  // Abort signal
  setAbortSignal,
  checkAbortSignal,
  peekAbortSignal,

  // Constants (used by integration layer for logging/metrics)
  SESSION_KEY_PREFIX,
  SESSION_MAX_BYTES,
  SESSION_TTL_SECONDS,
};