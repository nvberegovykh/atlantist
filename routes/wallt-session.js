/**
 * Owns: /api/wallt/session/* — Wallt Session Memory REST API.
 * Does NOT own: AI calls, core memory tables (wallt_memory), personality engine.
 *
 * Endpoints:
 *   GET  /api/wallt/session/:conversationId              — read session context window
 *   POST /api/wallt/session/:conversationId             — init / re-init session
 *   DELETE /api/wallt/session/:conversationId            — wipe session
 *   GET  /api/wallt/session/:conversationId/tools        — active tool calls
 *   POST /api/wallt/session/:conversationId/abort         — set abort signal
 *   GET  /api/wallt/session/:conversationId/abort         — peek abort signal (health)
 *
 * Redis key pattern: wallt:session:{conversationId}
 * Tool key pattern: wallt:tool:{conversationId}:*
 * Abort key pattern: wallt:abort:{conversationId}
 * TTL: 24h, auto-reset on activity via extendTTL.
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const {
  initSession,
  wipeSession,
  readSession,
  extendTTL,
  getActiveToolCalls,
  setAbortSignal,
  checkAbortSignal,
  peekAbortSignal,
  SESSION_TTL_SECONDS,
  SESSION_MAX_BYTES,
} = require('../services/wallt-session-store');

// Resolve userId from auth
function resolveUserId(req) {
  return req.user ? req.user.id : null;
}

// ── GET /api/wallt/session/:conversationId ────────────────────────────────────
// Read the ephemeral session context window.
// Returns the event log (last N events, capped at 50KB).
router.get('/:conversationId', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    const events = await readSession(conversationId);
    await extendTTL(conversationId);

    res.json({
      conversation_id: conversationId,
      event_count: events.length,
      events: events.slice(-50), // last 50 events (FIFO-enforced at 50KB cap)
      ttl_seconds: SESSION_TTL_SECONDS,
      max_bytes: SESSION_MAX_BYTES,
    });
  } catch (err) {
    console.error('[wallt-session] GET error:', err.message);
    res.status(500).json({ error: 'Failed to read session' });
  }
});

// ── POST /api/wallt/session/:conversationId ───────────────────────────────────
// Initialize or re-initialize an ephemeral session.
// POST body: { user_context?: object } — optional seed context.
router.post('/:conversationId', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    await initSession(conversationId);

    // Optionally seed an initial context event
    const { user_context } = req.body || {};
    if (user_context) {
      const { appendEvent } = require('../services/wallt-session-store');
      await appendEvent(conversationId, 'init', {
        user_id: resolveUserId(req),
        user_context,
        seed_ts: new Date().toISOString(),
      });
    }

    res.status(201).json({
      conversation_id: conversationId,
      status: 'initialized',
      ttl_seconds: SESSION_TTL_SECONDS,
      max_bytes: SESSION_MAX_BYTES,
    });
  } catch (err) {
    console.error('[wallt-session] POST init error:', err.message);
    res.status(500).json({ error: 'Failed to init session' });
  }
});

// ── DELETE /api/wallt/session/:conversationId ─────────────────────────────────
// Wipe session — not archive, complete destruction.
router.delete('/:conversationId', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    await wipeSession(conversationId);
    res.json({ conversation_id: conversationId, status: 'wiped' });
  } catch (err) {
    console.error('[wallt-session] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to wipe session' });
  }
});

// ── GET /api/wallt/session/:conversationId/tools ──────────────────────────────
// Return all active (pending + in_progress) tool calls for this session.
router.get('/:conversationId/tools', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    const activeTools = await getActiveToolCalls(conversationId);

    res.json({
      conversation_id: conversationId,
      active_count: activeTools.length,
      active_tools: activeTools,
    });
  } catch (err) {
    console.error('[wallt-session] tools error:', err.message);
    res.status(500).json({ error: 'Failed to read tool calls' });
  }
});

// ── POST /api/wallt/session/:conversationId/abort ────────────────────────────
// Set an abort signal for this session.
// Body: { reason?: string } — defaults to 'user_abort'.
// Returns immediately; the Wallt coordinator checks the signal before long ops.
router.post('/:conversationId/abort', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    const reason = req.body?.reason || 'user_abort';
    await setAbortSignal(conversationId, reason);

    res.status(202).json({
      conversation_id: conversationId,
      aborted: true,
      reason,
      ttl_seconds: 30, // abort signal auto-expires in 30s
    });
  } catch (err) {
    console.error('[wallt-session] abort error:', err.message);
    res.status(500).json({ error: 'Failed to set abort signal' });
  }
});

// ── GET /api/wallt/session/:conversationId/abort ─────────────────────────────
// Health check — peek at the current abort signal without consuming it.
router.get('/:conversationId/abort', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    const signal = await peekAbortSignal(conversationId);

    res.json({
      conversation_id: conversationId,
      signal: signal || null,
    });
  } catch (err) {
    console.error('[wallt-session] abort peek error:', err.message);
    res.status(500).json({ error: 'Failed to check abort signal' });
  }
});

// ── POST /api/wallt/session/:conversationId/abort/check ──────────────────────
// Consume and clear an abort signal. Returns { aborted, reason }.
// Coordinator calls this before starting long-running AI operations.
router.post('/:conversationId/abort/check', optionalAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    const { aborted, reason } = await checkAbortSignal(conversationId);

    res.json({
      conversation_id: conversationId,
      aborted,
      reason: reason || null,
    });
  } catch (err) {
    console.error('[wallt-session] abort check error:', err.message);
    res.status(500).json({ error: 'Failed to check abort signal' });
  }
});

module.exports = router;