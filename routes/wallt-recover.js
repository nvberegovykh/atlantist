/**
 * Owns: /api/wallt/recover — Wallt recovery trigger and audit endpoint.
 * Does NOT own: /api/wallt/health (in routes/wallt-health.js), Wallt AI calls.
 *
 * Endpoints:
 *   POST /api/wallt/recover  — manually trigger recovery for a session/conversation
 *   GET  /api/wallt/recover  — list recovery events with filters
 *   GET  /api/wallt/recover/:id — get single recovery event
 *   POST /api/wallt/recover/crash-signal — report a crash signal (from global error handler)
 *   POST /api/wallt/recover/loop-check  — check if a decision key is looping
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const { getSessionByToken } = require('../db/auth');
const { getUserRole } = require('../db/roles');
const {
  runHealthCheck,
  checkLoopThreshold,
  handleCrashSignal,
} = require('../services/wallt-auto-recovery');
const {
  getRecoveryEvents,
  getRecoveryEventById,
} = require('../db/wallt-recovery');

// ── POST /api/wallt/recover ─────────────────────────────────────────────────
// Manually trigger Wallt self-recovery for a session or conversation.
router.post('/', optionalAuth, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { session_uuid, conversation_id, trigger_type } = req.body;

    if (!session_uuid && !conversation_id && !trigger_type) {
      return res.status(400).json({
        error: 'At least one of session_uuid, conversation_id, or trigger_type is required',
      });
    }

    const conversationId = conversation_id ? parseInt(conversation_id) : null;

    const result = await runHealthCheck({
      userId,
      sessionUuid:    session_uuid || null,
      conversationId,
    });

    res.json({
      triggered:  result.detected.length > 0,
      healthy:    result.healthy,
      verdict:    result.verdict,
      detected:   result.detected,
      actions:    result.actions,
      errors:     result.errors,
    });
  } catch (err) {
    console.error('[wallt-recover] error:', err.message);
    res.status(500).json({ error: 'Recovery check failed' });
  }
});

// ── GET /api/wallt/recover ──────────────────────────────────────────────────
// List recovery events with optional filters.
router.get('/', optionalAuth, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { event_type, recovery_status, verdict, limit } = req.query;

    // Non-admins see only their own events
    const token = req.cookies?.session_token;
    let isAdmin = false;
    if (token) {
      const session = await getSessionByToken(token);
      if (session) {
        const role = await getUserRole(session.user_id);
        isAdmin = role === 'admin';
      }
    }

    const events = await getRecoveryEvents({
      userId:  isAdmin ? null : userId,
      eventType:     event_type || null,
      recoveryStatus: recovery_status || null,
      verdict:       verdict || null,
      limit:         Math.min(parseInt(limit, 10) || 50, 200),
    });

    res.json({ events, count: events.length });
  } catch (err) {
    console.error('[wallt-recover] list error:', err.message);
    res.status(500).json({ error: 'Failed to load recovery events' });
  }
});

// ── GET /api/wallt/recover/:id ───────────────────────────────────────────────
// Get a single recovery event by ID.
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });

    const event = await getRecoveryEventById(eventId);
    if (!event) return res.status(404).json({ error: 'Recovery event not found' });

    res.json({ event });
  } catch (err) {
    console.error('[wallt-recover] get error:', err.message);
    res.status(500).json({ error: 'Failed to load recovery event' });
  }
});

// ── POST /api/wallt/recover/crash-signal ─────────────────────────────────────
// Report an uncaught exception / crash signal from Wallt scope.
// Called from global error handlers (uncaughtException, unhandledRejection).
// Always escalates to human — no self-heal possible for crashes.
router.post('/crash-signal', async (req, res) => {
  try {
    const { error, source, session_uuid, conversation_id } = req.body;

    if (!error) {
      return res.status(400).json({ error: 'error object is required' });
    }

    const userId = req.user ? req.user.id : null;
    const conversationId = conversation_id ? parseInt(conversation_id) : null;

    const result = await handleCrashSignal({
      error:        typeof error === 'string' ? new Error(error) : error,
      source:      source || 'wallt:uncaught-exception',
      userId,
      sessionUuid: session_uuid || null,
      conversationId,
    });

    res.status(201).json({
      recovery_event_id: result.eventId,
      verdict:           result.verdict,
      escalated:         true,
      message:           'Crash signal detected. Human escalation triggered. Wallt paused pending review.',
    });
  } catch (err) {
    console.error('[wallt-recover] crash-signal error:', err.message);
    res.status(500).json({ error: 'Failed to process crash signal' });
  }
});

// ── POST /api/wallt/recover/loop-check ───────────────────────────────────────
// Check if a decision key has exceeded the loop threshold.
// Called from Wallt routes after recordDecisionMade returns count ≥ threshold.
router.post('/loop-check', optionalAuth, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { session_uuid, decision_key, decision_type } = req.body;

    if (!decision_key) {
      return res.status(400).json({ error: 'decision_key is required' });
    }

    if (!userId && !session_uuid) {
      return res.status(400).json({
        error: 'At least one of user auth or session_uuid is required',
      });
    }

    const result = await checkLoopThreshold({
      userId,
      sessionUuid:  session_uuid || null,
      decisionKey:   decision_key,
      decisionType:  decision_type || null,
    });

    res.json({
      decision_key:     decision_key,
      loop_count:       result.loopCount,
      verdict:          result.verdict,
      recovery_event_id: result.eventId,
      existing_event:   result.existing,
      threshold_reached: result.loopCount >= 5, // LOOP_COUNT_THRESHOLD
    });
  } catch (err) {
    console.error('[wallt-recover] loop-check error:', err.message);
    res.status(500).json({ error: 'Loop check failed' });
  }
});

module.exports = router;