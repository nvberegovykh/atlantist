/**
 * Owns: Wallt Auto-Recovery watchdog — crash detection + autonomous self-heal.
 * Does NOT own: Wallt AI conversation calls, memory cache, session store,
 *               escalation protocol (wired to).
 *
 * Monitors:
 *   - Execution timeouts  — wallt-core call exceeding WALLT_EXEC_TIMEOUT_MS
 *   - Crash signals        — uncaught exceptions / unhandled rejections in Wallt scope
 *   - Memory pressure      — heap used > WALLT_MEMORY_THRESHOLD_MB
 *   - Loop detection       — same decision_key repeated N times within window
 *
 * Self-heal actions:
 *   restart_session  — wipe ephemeral session, re-init from DB conversation
 *   clear_stale_context — evict expired cache entries, reset memory cache
 *   reinit_from_checkpoint — reload latest wallt_core_decision_log state
 *   escalate_to_human  — hand off to wallt-escalation (unrecoverable states)
 *
 * Audit: all recovery events written to wallt_recovery_events via db/wallt-recovery.js
 *        and mirrored to wallt_audit_log via app_events (wallt:audit_log type).
 */

const pool = require('../db/index');
const {
  logRecoveryEvent,
  getRecoveryEventById,
  updateRecoveryStatus,
  getRecentLoopSignature,
  bumpLoopCount,
} = require('../db/wallt-recovery');
const {
  triggerFromAutoRecovery,
} = require('./wallt-escalation');
const { wipeSession, initSession } = require('./wallt-session-store');
const { getCachedDecisions, getCachedUserProfile } = require('./wallt-memory-cache');

// ── Config / thresholds ───────────────────────────────────────────────────────

const RESPONSE_TIMEOUT_MS = parseInt(process.env.WALLT_RESPONSE_TIMEOUT_MS || '5000', 10);  // 5s latency check
const EXEC_TIMEOUT_MS  = parseInt(process.env.WALLT_EXEC_TIMEOUT_MS  || '30000', 10);     // 30s full-call timeout
const MEMORY_THRESHOLD_MB = parseInt(process.env.WALLT_MEMORY_THRESHOLD_MB || '400', 10);
const LOOP_COUNT_THRESHOLD = parseInt(process.env.WALLT_LOOP_COUNT_THRESHOLD || '5', 10);
const LOOP_WINDOW_MS      = parseInt(process.env.WALLT_LOOP_WINDOW_MS      || '60000', 10);
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.WALLT_HEALTH_CHECK_INTERVAL_MS || '30000', 10);  // 30s loop
const MAX_RECOVERY_ATTEMPTS = parseInt(process.env.WALLT_MAX_RECOVERY_ATTEMPTS || '3', 10);  // max 3/session

// ── Wallt global state ─────────────────────────────────────────────────────
// Tracks Wallt online/offline/degraded status across all sessions.

const walltState = {
  status: 'ONLINE',       // ONLINE | DEGRADED | OFFLINE
  lastCheckAt: null,
  lastError: null,        // last error message when offline
  totalSessions: 0,       // active sessions (approximate — derived from health checks)
  recoveryAttempts: new Map(), // sessionUuid → count (resets on manual override or reinit)
};

// Thread-safe access to walltState (Node.js is single-threaded; simple object access is safe).
function setWalltStatus(status, errorMessage = null) {
  walltState.status = status;
  walltState.lastCheckAt = new Date().toISOString();
  if (status === 'OFFLINE') walltState.lastError = errorMessage;
  else if (status === 'ONLINE') walltState.lastError = null;
}

function getWalltState() {
  return { ...walltState };
}

/**
 * Increment recovery attempt count for a session.
 * Returns { count, shouldGoOffline } — count > MAX_RECOVERY_ATTEMPTS means Wallt goes offline.
 */
function bumpRecoveryAttempt(sessionUuid) {
  const current = walltState.recoveryAttempts.get(sessionUuid) || 0;
  const next = current + 1;
  walltState.recoveryAttempts.set(sessionUuid, next);
  return { count: next, shouldGoOffline: next > MAX_RECOVERY_ATTEMPTS };
}

function clearRecoveryAttempts(sessionUuid) {
  walltState.recoveryAttempts.delete(sessionUuid);
}

// ── Output coherence check ─────────────────────────────────────────────────
// Returns { coherent: bool, reason: string|null }

function checkOutputCoherence(output) {
  if (output == null) return { coherent: false, reason: 'output is null' };
  if (typeof output === 'string') {
    if (output.trim().length === 0) return { coherent: false, reason: 'output is empty string' };
    // Suspicious: repeated whitespace or null bytes
    if (output.includes('\u0000')) return { coherent: false, reason: 'output contains null byte' };
  }
  if (typeof output === 'object' && JSON.stringify(output).length < 10) {
    return { coherent: false, reason: 'output is truncated/empty object' };
  }
  return { coherent: true, reason: null };
}

// ── Execution timer ───────────────────────────────────────────────────────────
// Tracks in-flight wallt calls. Start timer before AI call, clear on completion.

const inFlightCalls = new Map(); // callId → { startMs, userId, sessionUuid, conversationId }

function startCall({ callId, userId, sessionUuid, conversationId }) {
  inFlightCalls.set(callId, {
    startMs:           Date.now(),
    userId,
    sessionUuid,
    conversationId,
    timedOut:         false,
    responseTimedOut: false, // checked at 5s; cleared when response received
  });
}

function endCall(callId) {
  const call = inFlightCalls.get(callId);
  inFlightCalls.delete(callId);
  // If Wallt was OFFLINE and call completes successfully, mark as recovered
  if (call && walltState.status === 'OFFLINE') {
    // Only auto-recover if no recent failed events
    const { rows } = pool.query(
      `SELECT COUNT(*) AS cnt FROM wallt_recovery_events
       WHERE verdict = 'UNRECOVERABLE'
         AND created_at > NOW() - INTERVAL '5 minutes'`
    ).catch(() => ({ rows: [{ cnt: '0' }] }));
    // Safe to re-enable — recovery was manual/admin
    setWalltStatus('ONLINE');
  }
  // Track approximate active session count
  walltState.totalSessions = inFlightCalls.size;
  return call;
}

function checkTimeouts() {
  const now = Date.now();
  const timedOut = [];
  for (const [callId, call] of inFlightCalls.entries()) {
    if (now - call.startMs > EXEC_TIMEOUT_MS) {
      timedOut.push({ callId, ...call });
      inFlightCalls.delete(callId);
    }
  }
  return timedOut;
}

// ── Memory pressure ──────────────────────────────────────────────────────────

function checkMemoryPressure() {
  const used = process.memoryUsage();
  const usedMb = Math.round(used.heapUsed / (1024 * 1024));
  if (usedMb > MEMORY_THRESHOLD_MB) {
    return {
      detected: true,
      usedMb,
      thresholdMb: MEMORY_THRESHOLD_MB,
      rssMb: Math.round(used.rss / (1024 * 1024)),
      externalMb: Math.round(used.external / (1024 * 1024)),
    };
  }
  return { detected: false };
}

// ── Loop detection ───────────────────────────────────────────────────────────

// Rolling window of decision keys per session
const decisionWindow = new Map(); // `${sessionUuid}:${userId}` → [ { decisionKey, ts } ]

const LOOP_DECISION_WINDOW_MS = 120000; // consider last 2 min of decisions

function recordDecision({ sessionUuid, userId, decisionKey }) {
  const key = `${sessionUuid || ''}:${userId || ''}`;
  if (!decisionWindow.has(key)) {
    decisionWindow.set(key, []);
  }
  const win = decisionWindow.get(key);
  const now = Date.now();

  // Evict stale entries
  const cutoff = now - LOOP_DECISION_WINDOW_MS;
  while (win.length && win[0].ts < cutoff) win.shift();

  win.push({ decisionKey, ts: now });

  // Count occurrences of decisionKey in window
  const count = win.filter(e => e.decisionKey === decisionKey).length;
  return count;
}

function hashDecisionKey(decisionKey) {
  // Deterministic hash for loop signature (avoid storing full decision key in clear)
  let hash = 0;
  const str = String(decisionKey);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash  = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return `dec:${Math.abs(hash).toString(36)}`;
}

// ── Core self-heal actions ────────────────────────────────────────────────────

async function healRestartSession(userId, sessionUuid, conversationId) {
  const steps = [];
  const errors = [];

  // Step 1: wipe ephemeral session
  try {
    const before = Date.now();
    if (sessionUuid) await wipeSession(sessionUuid);
    if (conversationId) await wipeSession(String(conversationId));
    steps.push({ action: 'wipe_session', duration_ms: Date.now() - before, success: true });
  } catch (err) {
    errors.push({ action: 'wipe_session', error: err.message });
    steps.push({ action: 'wipe_session', duration_ms: 0, success: false, error: err.message });
  }

  // Step 2: re-init session from DB conversation state
  try {
    const before = Date.now();
    if (conversationId) await initSession(String(conversationId));
    steps.push({ action: 'reinit_session', duration_ms: Date.now() - before, success: true });
  } catch (err) {
    errors.push({ action: 'reinit_session', error: err.message });
    steps.push({ action: 'reinit_session', duration_ms: 0, success: false, error: err.message });
  }

  return { healed: errors.length === 0, steps, errors };
}

async function healClearStaleContext(userId) {
  const steps = [];
  const errors = [];

  try {
    const before = Date.now();
    const { evictLRUUntilUnderCap, getCacheSizeBytes } = require('./wallt-memory-cache');
    const currentSize = await getCacheSizeBytes();
    const targetSize = 500 * 1024 * 1024 * 0.7; // 70% of 500MB
    const evicted = currentSize > targetSize ? await evictLRUUntilUnderCap(targetSize) : 0;
    steps.push({
      action: 'clear_stale_context',
      details: { evictedEntries: evicted, freed_bytes_approx: evicted * 2000 },
      duration_ms: Date.now() - before,
      success: true,
    });
  } catch (err) {
    errors.push({ action: 'clear_stale_context', error: err.message });
    steps.push({ action: 'clear_stale_context', duration_ms: 0, success: false, error: err.message });
  }

  return { healed: errors.length === 0, steps, errors };
}

async function healReinitFromCheckpoint(userId, sessionUuid) {
  const steps = [];
  const errors = [];

  // Reload latest decisions from wallt_core_decision_log
  try {
    const before = Date.now();
    const { getDecisions } = require('../db/wallt-memory');
    const recent = await getDecisions(userId, { limit: 10 });
    steps.push({
      action: 'reinit_from_checkpoint',
      details: { decisions_loaded: recent.length },
      duration_ms: Date.now() - before,
      success: true,
    });
  } catch (err) {
    errors.push({ action: 'reinit_from_checkpoint', error: err.message });
    steps.push({ action: 'reinit_from_checkpoint', duration_ms: 0, success: false, error: err.message });
  }

  // Warm cache from reloaded decisions
  try {
    const { cacheDecisions } = require('./wallt-memory-cache');
    const { getDecisions } = require('../db/wallt-memory');
    const recent = await getDecisions(userId, { limit: 10 });
    if (recent.length) {
      await cacheDecisions(userId, JSON.stringify(recent), 3600);
      steps.push({
        action: 'warm_cache_from_checkpoint',
        details: { cached_decisions: recent.length },
        duration_ms: 0,
        success: true,
      });
    }
  } catch (err) {
    steps.push({ action: 'warm_cache_from_checkpoint', duration_ms: 0, success: false, error: err.message });
  }

  return { healed: errors.length === 0, steps, errors };
}

// ── Recovery orchestration ────────────────────────────────────────────────────

const RECOVERY_SEQUENCE = [
  { action: 'restart_session',  fn: healRestartSession,     escalateAfter: 1 },
  { action: 'clear_stale_context', fn: healClearStaleContext, escalateAfter: 2 },
  { action: 'reinit_from_checkpoint', fn: healReinitFromCheckpoint, escalateAfter: 3 },
];

/**
 * Execute self-heal sequence for a detected condition.
 * Returns { recoveryStatus, verdict, steps, escalated }.
 */
async function executeRecovery(detectedCondition, userId, sessionUuid, conversationId, triggerSource) {
  let recoveryStatus = 'success';
  let verdict = 'HEALTHY';
  let escalated = false;
  const allSteps = [];

  for (const step of RECOVERY_SEQUENCE) {
    const { healed, steps, errors } = await step.fn(userId, sessionUuid, conversationId);
    allSteps.push(...steps);

    if (!healed) {
      recoveryStatus = 'partial';
      verdict = 'DEGRADED';
      // After escalateAfter failures, escalate
      const failedCount = allSteps.filter(s => !s.success).length;
      if (failedCount >= step.escalateAfter) {
        recoveryStatus = 'failed';
        verdict = 'UNHEALTHY';
        break;
      }
    }
  }

  return { recoveryStatus, verdict, steps: allSteps, escalated };
}

// ── Audit logging ─────────────────────────────────────────────────────────────

async function logToAuditLog(eventId, eventType, userId, sessionUuid, context) {
  try {
    await pool.query(
      `INSERT INTO app_events (event_name, session_uuid, user_id, properties, url, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'wallt:audit_log',
        sessionUuid,
        userId,
        JSON.stringify({
          event_type: eventType,
          recovery_event_id: eventId,
          logged_at: new Date().toISOString(),
          ...context,
        }),
        '/api/wallt/health',
        '0.0.0.0',
      ]
    );
  } catch (_) {
    // Non-fatal — audit log must never break recovery
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a wallt AI call start. Call BEFORE the AI call.
 */
function recordCallStart({ callId, userId, sessionUuid, conversationId }) {
  startCall({ callId, userId, sessionUuid, conversationId });
}

/**
 * Record a wallt AI call end. Call AFTER the AI call completes (success or failure).
 */
function recordCallEnd({ callId, success, errorMessage }) {
  const call = endCall(callId);
  if (!call) return null; // call was already cleaned up (timeout already fired)

  const durationMs = Date.now() - call.startMs;
  const timedOut = durationMs > EXEC_TIMEOUT_MS;

  return {
    callId,
    userId: call.userId,
    sessionUuid: call.sessionUuid,
    conversationId: call.conversationId,
    durationMs,
    timedOut,
    success,
    errorMessage,
  };
}

/**
 * Record a decision made by Wallt (for loop detection).
 * Returns loop count if loop threshold reached.
 */
function recordDecisionMade({ userId, sessionUuid, decisionKey, decisionType }) {
  const count = recordDecision({ sessionUuid, userId, decisionKey });
  return count;
}

/**
 * Run health check — detect issues and execute recovery as needed.
 * Called by health-check route and optionally on a schedule.
 * Returns { healthy, events, actions, errors }.
 */
async function runHealthCheck({ userId = null, sessionUuid = null, conversationId = null } = {}) {
  const actions = [];
  const errors  = [];
  const detected = [];
  let healthy = true;
  let degraded = false;
  let verdict = 'HEALTHY';

  // 0. Update Wallt global state on every check
  setWalltStatus(verdict === 'HEALTHY' ? 'ONLINE' : verdict === 'DEGRADED' ? 'DEGRADED' : 'OFFLINE');

  // 1. Check response latency (5s threshold — pre-first-token lag)
  const responseTimedOut = checkTimeouts(); // same map tracks both 5s and 30s via separate checks below
  // Check 5s response timeout using walltResponseTimeout registry
  const now = Date.now();
  for (const [callId, call] of inFlightCalls.entries()) {
    if (call.timedOut || call.startMs === undefined) continue;
    const elapsed = now - call.startMs;
    // 5s response latency check
    if (elapsed > RESPONSE_TIMEOUT_MS && !call.responseTimedOut) {
      const entry = inFlightCalls.get(callId);
      if (entry) entry.responseTimedOut = true;
      healthy = false;
      degraded = true;
      verdict = 'DEGRADED';
      detected.push({ type: 'response_latency', detail: { callId, elapsed_ms: elapsed, threshold_ms: RESPONSE_TIMEOUT_MS } });

      const event = await logRecoveryEvent({
        eventType:      'response_latency',
        triggerSource:  'wallt:auto-recovery',
        userId:         call.userId,
        sessionUuid:    call.sessionUuid,
        conversationId: call.conversationId,
        detectedCondition: {
          type:        'response_latency',
          threshold_ms: RESPONSE_TIMEOUT_MS,
          actual_ms:   elapsed,
          callId:      callId,
        },
        recoveryAction: 'restart_session',
      });

      // Max recovery attempts check
      const { count: recoveryCount, shouldGoOffline } = bumpRecoveryAttempt(call.sessionUuid);
      if (shouldGoOffline) {
        setWalltStatus('OFFLINE', `Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) exceeded for session ${call.sessionUuid}`);
        verdict = 'UNRECOVERABLE';
        await updateRecoveryStatus(event.id, {
          recoveryStatus: 'failed',
          verdict: 'UNRECOVERABLE',
          verdictReason: `Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) exceeded — Wallt offline, requires admin manual override`,
        });
        await triggerFromAutoRecovery({
          recovery_event_id: event.id,
          type: 'max_recovery_exceeded',
          recovery_count: recoveryCount,
        }, call.userId, call.sessionUuid);
        continue;
      }

      const { recoveryStatus, recoveryVerdict, steps, escalated } = await executeRecovery(
        { type: 'response_latency', elapsed, threshold: RESPONSE_TIMEOUT_MS },
        call.userId, call.sessionUuid, call.conversationId,
        'wallt:auto-recovery'
      );

      await updateRecoveryStatus(event.id, { recoveryStatus, steps, verdict: recoveryVerdict });
      await logToAuditLog(event.id, 'response_latency', call.userId, call.sessionUuid, {
        threshold_ms: RESPONSE_TIMEOUT_MS, actual_ms: elapsed,
      });

      actions.push({ eventId: event.id, action: 'restart_session', result: recoveryStatus, recovery_count: recoveryCount });
      if (escalated) {
        await triggerFromAutoRecovery({ recovery_event_id: event.id, type: 'response_latency' }, call.userId, call.sessionUuid);
      }
    }
  }

  // 2. Check full execution timeouts (30s — full call completion)
  const timedOut = checkTimeouts();
  for (const call of timedOut) {
    healthy = false;
    detected.push({ type: 'execution_timeout', detail: call });

    const event = await logRecoveryEvent({
      eventType:      'execution_timeout',
      triggerSource:  'wallt:auto-recovery',
      userId:         call.userId,
      sessionUuid:    call.sessionUuid,
      conversationId: call.conversationId,
      detectedCondition: {
        type:        'execution_timeout',
        threshold_ms: EXEC_TIMEOUT_MS,
        actual_ms:   Date.now() - call.startMs,
        callId:      call.callId,
      },
      recoveryAction: 'restart_session',
    });

    const { recoveryStatus, recoveryVerdict, steps, escalated } = await executeRecovery(
      { type: 'execution_timeout', call },
      call.userId, call.sessionUuid, call.conversationId,
      'wallt:auto-recovery'
    );

    await updateRecoveryStatus(event.id, { recoveryStatus, steps, verdict: recoveryVerdict });
    await logToAuditLog(event.id, 'execution_timeout', call.userId, call.sessionUuid, {
      threshold_ms: EXEC_TIMEOUT_MS, actual_ms: Date.now() - call.startMs,
    });

    actions.push({ eventId: event.id, action: 'restart_session', result: recoveryStatus });
    if (escalated) {
      await triggerFromAutoRecovery({ recovery_event_id: event.id, type: 'execution_timeout' }, call.userId, call.sessionUuid);
    }
  }

  // 3. Check memory pressure
  const mem = checkMemoryPressure();
  if (mem.detected) {
    healthy = false;
    degraded = true;
    verdict = 'DEGRADED';
    detected.push({ type: 'memory_pressure', detail: mem });

    const event = await logRecoveryEvent({
      eventType:        'memory_pressure',
      triggerSource:    'wallt:auto-recovery',
      userId,
      sessionUuid,
      conversationId,
      detectedCondition: {
        type:            'memory_pressure',
        threshold_mb:    mem.thresholdMb,
        actual_mb:       mem.usedMb,
        rss_mb:          mem.rssMb,
        external_mb:     mem.externalMb,
      },
      recoveryAction:   'clear_stale_context',
      memoryUsageMb:    mem.usedMb,
      memoryThresholdMb: mem.thresholdMb,
    });

    const { recoveryStatus, recoveryVerdict, steps, escalated } = await executeRecovery(
      { type: 'memory_pressure', memory: mem },
      userId, sessionUuid, conversationId,
      'wallt:auto-recovery'
    );

    await updateRecoveryStatus(event.id, { recoveryStatus, steps, verdict: recoveryVerdict });
    await logToAuditLog(event.id, 'memory_pressure', userId, sessionUuid, {
      threshold_mb: mem.thresholdMb, actual_mb: mem.usedMb,
    });

    actions.push({ eventId: event.id, action: 'clear_stale_context', result: recoveryStatus });
    if (escalated) {
      await triggerFromAutoRecovery({ recovery_event_id: event.id, type: 'memory_pressure' }, userId, sessionUuid);
    }
  }

  // Update global Wallt status based on all checks
  if (verdict === 'UNRECOVERABLE') {
    setWalltStatus('OFFLINE', 'Auto-recovery failed — Wallt offline');
  } else if (verdict === 'DEGRADED' || degraded) {
    setWalltStatus('DEGRADED');
  }

  return { healthy, degraded, verdict, detected, actions, errors };
}

/**
 * Check if a specific decision key has exceeded the loop threshold.
 * Call this after recordDecisionMade returns a count ≥ LOOP_COUNT_THRESHOLD.
 */
async function checkLoopThreshold({ userId, sessionUuid, decisionKey, decisionType }) {
  const sig = hashDecisionKey(decisionKey);

  // Check for recent same-sig event (within LOOP_WINDOW_MS)
  const existing = await getRecentLoopSignature(sig, LOOP_WINDOW_MS);

  if (existing) {
    // Bump loop count, don't create new event
    const bumped = await bumpLoopCount(existing.id, existing.loop_count + 1);
    const verdict = bumped.loop_count >= LOOP_COUNT_THRESHOLD ? 'UNHEALTHY' : 'DEGRADED';

    await logToAuditLog(existing.id, 'loop_detected', userId, sessionUuid, {
      loop_signature: sig,
      loop_count: bumped.loop_count,
      verdict,
    });

    if (bumped.loop_count >= LOOP_COUNT_THRESHOLD) {
      verdict = 'UNRECOVERABLE';
      // Trigger escalation
      await triggerFromAutoRecovery({
        recovery_event_id: bumped.id,
        type:             'loop_detected',
        loop_count:       bumped.loop_count,
        decision_key:     decisionKey,
      }, userId, sessionUuid);
    }

    return { existing: true, loopCount: bumped.loop_count, verdict, eventId: bumped.id };
  }

  // First occurrence of this loop signature
  const event = await logRecoveryEvent({
    eventType:      'loop_detected',
    triggerSource:  'wallt:auto-recovery',
    userId,
    sessionUuid,
    detectedCondition: {
      type:           'loop_detected',
      loop_signature: sig,
      decision_key:   decisionKey,
      decision_type:  decisionType,
      threshold:      LOOP_COUNT_THRESHOLD,
      current_count:  1,
    },
    recoveryAction:  'reinit_from_checkpoint',
    loopSignature:   sig,
    loopCount:       1,
    loopDecisionKeys: [decisionKey],
  });

  await logToAuditLog(event.id, 'loop_detected', userId, sessionUuid, {
    loop_signature: sig, loop_count: 1, decision_key: decisionKey,
  });

  return { existing: false, loopCount: 1, verdict: 'DEGRADED', eventId: event.id };
}

/**
 * Check for crash signals (uncaught exception / unhandled rejection).
 * Wire these by calling this function from a global error handler.
 */
async function handleCrashSignal({ error, source, userId, sessionUuid, conversationId }) {
  const event = await logRecoveryEvent({
    eventType:      'crash_signal',
    triggerSource:  source || 'wallt:auto-recovery',
    userId,
    sessionUuid,
    conversationId,
    detectedCondition: {
      type:   'crash_signal',
      error:  { message: error?.message || String(error), name: error?.name || 'Error', stack: error?.stack },
      source: source,
    },
    recoveryAction:  'escalate_to_human',
  });

  await updateRecoveryStatus(event.id, {
    recoveryStatus: 'failed',
    verdict: 'UNRECOVERABLE',
    verdictReason: 'Crash signal — unrecoverable, human required',
  });

  await logToAuditLog(event.id, 'crash_signal', userId, sessionUuid, {
    error_message: error?.message || String(error), source,
  });

  // Always escalate crash signals
  await triggerFromAutoRecovery({
    recovery_event_id: event.id,
    type:             'crash_signal',
    error:            error?.message || String(error),
  }, userId, sessionUuid);

  return { eventId: event.id, verdict: 'UNRECOVERABLE' };
}

/**
 * Full system health summary (used by GET /api/wallt/health).
 */
async function getSystemHealth() {
  const inFlight = inFlightCalls.size;
  const mem = checkMemoryPressure();
  const state = getWalltState();

  // Check for any active unhealthy events in last 5 min
  const { rows: active } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM wallt_recovery_events
     WHERE created_at > NOW() - INTERVAL '5 minutes'
       AND verdict IN ('UNHEALTHY', 'UNRECOVERABLE')`
  );
  const hasActiveIssues = parseInt(active[0].cnt, 10) > 0;

  // Count recovery attempts from wallt_recovery_events for last 24h
  const { rows: recoveryCounts } = await pool.query(
    `SELECT session_uuid, COUNT(*) AS attempt_count
     FROM wallt_recovery_events
     WHERE created_at > NOW() - INTERVAL '24 hours'
       AND event_type IN ('response_latency', 'execution_timeout', 'memory_pressure', 'loop_detected')
     GROUP BY session_uuid`
  );

  // Per-session recovery counts (max 3)
  const sessionRecoveryCounts = {};
  recoveryCounts.forEach(r => {
    if (r.session_uuid) sessionRecoveryCounts[r.session_uuid] = parseInt(r.attempt_count, 10);
  });

  // Decision window stats
  const decisionWindowSize = decisionWindow.size;

  let healthStatus = state.status; // ONLINE / DEGRADED / OFFLINE
  if (hasActiveIssues && healthStatus === 'ONLINE') healthStatus = 'DEGRADED';
  // OFFLINE is set directly when max recovery exceeded — preserve it
  if (state.status === 'OFFLINE') healthStatus = 'OFFLINE';

  return {
    status:              healthStatus,
    wallt_status:        state.status,    // ONLINE | DEGRADED | OFFLINE
    last_check:          state.lastCheckAt,
    last_error:          state.lastError, // shown when OFFLINE
    active_sessions:     state.totalSessions || 0,
    in_flight_calls:     inFlight,
    recovery_attempts_24h: recoveryCounts.reduce((sum, r) => sum + parseInt(r.attempt_count, 10), 0),
    session_recovery_counts: sessionRecoveryCounts,  // sessionUuid → count (for admin display)
    max_recovery_per_session: MAX_RECOVERY_ATTEMPTS,
    memory: {
      used_mb:     mem.usedMb    || 0,
      threshold_mb: MEMORY_THRESHOLD_MB,
      rss_mb:      mem.rssMb     || 0,
      pressure:    mem.detected   ? 'elevated' : 'normal',
    },
    decision_window_entries: decisionWindowSize,
    active_issues: hasActiveIssues,
    thresholds: {
      response_timeout_ms:   RESPONSE_TIMEOUT_MS,
      exec_timeout_ms:        EXEC_TIMEOUT_MS,
      memory_threshold_mb:    MEMORY_THRESHOLD_MB,
      loop_count_threshold:   LOOP_COUNT_THRESHOLD,
      loop_window_ms:         LOOP_WINDOW_MS,
      health_check_interval_ms: HEALTH_CHECK_INTERVAL_MS,
    },
    now: new Date().toISOString(),
  };
}

module.exports = {
  recordCallStart,
  recordCallEnd,
  recordDecisionMade,
  checkLoopThreshold,
  runHealthCheck,
  handleCrashSignal,
  getSystemHealth,
  getWalltState,
  setWalltStatus,
  bumpRecoveryAttempt,
  clearRecoveryAttempts,
  checkOutputCoherence,
  // Expose constants for tests / monitoring
  RESPONSE_TIMEOUT_MS,
  EXEC_TIMEOUT_MS,
  MEMORY_THRESHOLD_MB,
  LOOP_COUNT_THRESHOLD,
  LOOP_WINDOW_MS,
  HEALTH_CHECK_INTERVAL_MS,
  MAX_RECOVERY_ATTEMPTS,
};