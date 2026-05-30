/**
 * Owns: /api/wallt/health — Wallt system health check endpoint.
 * Does NOT own: /api/wallt/recover (in routes/wallt-recover.js), Wallt AI calls.
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const { getSystemHealth, runHealthCheck } = require('../services/wallt-auto-recovery');
const { getActiveEvents, getRecoveryStats } = require('../db/wallt-recovery');

// ── GET /api/wallt/health ───────────────────────────────────────────────────
// Returns current Wallt system health without executing any recovery actions.
router.get('/', optionalAuth, async (req, res) => {
  try {
    const health = await getSystemHealth();
    res.json(health);
  } catch (err) {
    console.error('[wallt-health] health check error:', err.message);
    res.status(500).json({ error: 'Health check failed', status: 'UNKNOWN' });
  }
});

// ── POST /api/wallt/health/check ─────────────────────────────────────────────
// Run a proactive health check — executes recovery actions if issues detected.
// Requires admin auth for system-wide checks; regular auth for user-scope checks.
router.post('/check', optionalAuth, async (req, res) => {
  try {
    const { session_uuid, conversation_id } = req.body;
    const userId = req.user ? req.user.id : null;

    const result = await runHealthCheck({
      userId,
      sessionUuid:   session_uuid || null,
      conversationId: conversation_id ? parseInt(conversation_id) : null,
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
    console.error('[wallt-health] check error:', err.message);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// ── GET /api/wallt/health/recovery-events ───────────────────────────────────
// Returns active (unresolved) recovery events for admin monitoring.
router.get('/recovery-events', optionalAuth, async (req, res) => {
  try {
    const { limit } = req.query;
    const events = await getActiveEvents({ limit: Math.min(parseInt(limit, 10) || 20, 100) });
    res.json({ events, count: events.length });
  } catch (err) {
    console.error('[wallt-health] recovery events error:', err.message);
    res.status(500).json({ error: 'Failed to load recovery events' });
  }
});

// ── GET /api/wallt/health/stats ──────────────────────────────────────────────
// Returns 30-day aggregate recovery stats (event counts by type, status, daily trend).
router.get('/stats', optionalAuth, async (req, res) => {
  try {
    const { days } = req.query;
    const stats = await getRecoveryStats({ days: Math.min(parseInt(days, 10) || 30, 90) });
    res.json(stats);
  } catch (err) {
    console.error('[wallt-health] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load recovery stats' });
  }
});

module.exports = router;