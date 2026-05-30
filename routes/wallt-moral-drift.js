/**
 * Owns: /api/wallt/moral-drift — Wallt Moral Drift Detection watchdog API.
 * Does NOT own: Wallt AI calls, escalation execution, memory cache.
 *
 * Endpoints:
 *   GET  /api/wallt/moral-drift/score     — current drift score (user or session)
 *   POST /api/wallt/moral-drift/check    — evaluate drift and log event
 *   GET  /api/wallt/moral-drift/history   — recent drift events
 *   GET  /api/wallt/moral-drift/stats     — aggregate admin stats
 *   PATCH /api/wallt/moral-drift/:id/resolve — resolve a drift event (admin)
 *   GET  /api/wallt/moral-drift/:id       — single event detail
 *
 * Thresholds:
 *   score < 0.3  → GREEN  (log only)
 *   score 0.3-0.6 → YELLOW (log + warn event)
 *   score > 0.6  → RED    (log + escalate to human)
 */
const router = require('express').Router();
const { optionalAuth, adminMiddleware: requireAdmin } = require('./auth');
const driftService = require('../services/wallt-moral-drift');

// ── GET /api/wallt/moral-drift/score — current drift score ───────────────────

router.get('/score', optionalAuth, async (req, res) => {
  try {
    const userId     = req.user ? req.user.id : null;
    const sessionUuid = req.session?.uuid || req.query.session_uuid || null;

    // Return cached score if recent (< 5 min)
    const { getLatestScore } = require('../db/wallt-moral-drift');
    const latest = await getLatestScore({ userId, sessionUuid });

    if (latest) {
      const ageMs = Date.now() - new Date(latest.created_at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        return res.json({
          score:         parseFloat(latest.drift_score),
          verdict:       latest.verdict,
          age_seconds:   Math.round(ageMs / 1000),
          event_id:      latest.id,
          cached:        true,
        });
      }
    }

    // Fall back: compute from current decision history
    const result = await driftService.checkAndLogDrift({
      userId, sessionUuid,
    });

    return res.json({
      score:         result.score,
      verdict:       result.verdict,
      flags:         result.flags,
      recommendation: result.recommendation,
      breakdown:     result.breakdown,
      event_id:      result.event_id,
      cached:        false,
    });
  } catch (err) {
    console.error('[wallt-moral-drift] score error:', err.message);
    res.status(500).json({ error: 'Failed to compute drift score' });
  }
});

// ── POST /api/wallt/moral-drift/check — evaluate and log drift ───────────────

router.post('/check', optionalAuth, async (req, res) => {
  try {
    const userId      = req.user ? req.user.id : null;
    const sessionUuid = req.session?.uuid || req.body.session_uuid || null;
    const projectId   = req.body.project_id || null;

    // Optional: pass explicit state history (for testing / manual evaluation)
    const { state_history } = req.body;

    let result;
    if (state_history && Array.isArray(state_history) && state_history.length > 0) {
      // Direct computation, no DB fetch
      const { driftScore } = require('../services/wallt-moral-drift');
      result = driftScore(state_history);
      // Log event
      const { logDriftEvent } = require('../db/wallt-moral-drift');
      const eventId = await logDriftEvent({
        userId, sessionUuid,
        driftScore: result.score,
        verdict: result.verdict,
        stateHistoryJson: state_history,
        flagsJson: result.flags,
        recommendation: result.recommendation,
      });
      result.event_id = eventId;
    } else {
      // Standard path: fetch from wallt_core_decision_log
      result = await driftService.checkAndLogDrift({
        userId, sessionUuid, projectId,
      });
    }

    return res.json({
      score:         result.score,
      verdict:       result.verdict,
      flags:         result.flags,
      recommendation: result.recommendation,
      breakdown:     result.breakdown,
      event_id:      result.event_id,
      escalated:     result.verdict === 'RED',
    });
  } catch (err) {
    console.error('[wallt-moral-drift] check error:', err.message);
    res.status(500).json({ error: 'Failed to evaluate drift' });
  }
});

// ── POST /api/wallt/moral-drift/scan — pre-output value alignment scan ────────
// Scans text against Nikita's value vectors. For testing / admin review.
// Returns scan results with excerpts and drift verdict.
router.post('/scan', optionalAuth, async (req, res) => {
  try {
    const { text, session_uuid } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text (string) is required' });
    }

    const userId = req.user ? req.user.id : null;
    const { checkPreOutputDrift, VALUES_AND_PATTERNS } = require('../services/wallt-moral-drift');

    // Run pre-output drift check (non-mutating — does not update ring buffer for existing sessions)
    const result = await checkPreOutputDrift({
      output: text,
      sessionUuid: session_uuid || `scan-${Date.now()}`,
      userId,
    });

    // Also surface the value definitions for transparency
    const values = Object.entries(VALUES_AND_PATTERNS).map(([key, def]) => ({
      principle: key,
      description: def.description,
      anti_pattern_count: def.anti.length,
      pro_pattern_count: def.pro.length,
    }));

    return res.json({
      scan_result: {
        verdict: result.verdict,
        aligned: result.aligned,
        drift_confirmed: result.verdict === 'drifted',
        scan_matches: result.driftDetails,
        rolled_back: result.rolledBack,
        event_id: result.eventId,
        escalated: result.escalated,
      },
      values_definitions: values,
    });
  } catch (err) {
    console.error('[wallt-moral-drift] scan error:', err.message);
    res.status(500).json({ error: 'Failed to scan text against values' });
  }
});

// ── GET /api/wallt/moral-drift/values — Nikita's actual values (transparency) ─
// Returns the full value vectors for admin/user review. Shows anti and pro patterns.
router.get('/values', optionalAuth, async (req, res) => {
  try {
    const { VALUES_AND_PATTERNS } = require('../services/wallt-moral-drift');
    const { ATLANTIST_PRINCIPLES } = require('../services/wallt-moral-drift');

    const values = Object.entries(VALUES_AND_PATTERNS).map(([key, def]) => ({
      principle: key,
      principle_key: ATLANTIST_PRINCIPLES[key.toUpperCase()] || key,
      description: def.description,
      anti_patterns: def.anti,
      pro_patterns: def.pro,
      drift_trigger_threshold: '3 consecutive anti-pattern matches',
    }));

    res.json({
      values,
      transparency_note: 'Every drift detection is logged with full reasoning chain. Users and admins can review all drift events in the Wallt admin panel.',
      sources: ['wallt_core_user_profile', 'wallt_context_graph:company_profile', 'wallt_context_graph:user_context'],
    });
  } catch (err) {
    console.error('[wallt-moral-drift] values error:', err.message);
    res.status(500).json({ error: 'Failed to load values definitions' });
  }
});

// ── GET /api/wallt/moral-drift/history — recent drift events ─────────────────

router.get('/history', optionalAuth, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { limit } = req.query;
    const events = await driftService.getDriftHistory({
      userId,
      limit: Math.min(parseInt(limit, 10) || 30, 100),
    });
    return res.json({ events, count: events.length });
  } catch (err) {
    console.error('[wallt-moral-drift] history error:', err.message);
    res.status(500).json({ error: 'Failed to load drift history' });
  }
});

// ── GET /api/wallt/moral-drift/stats — aggregate admin stats ──────────────────

router.get('/stats', optionalAuth, async (req, res) => {
  try {
    const { getDriftStats } = require('../db/wallt-moral-drift');
    const stats = await getDriftStats({ days: parseInt(req.query.days, 10) || 30 });
    return res.json(stats);
  } catch (err) {
    console.error('[wallt-moral-drift] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load drift stats' });
  }
});

// ── GET /api/wallt/moral-drift/:id — single event detail ─────────────────────

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { getDriftEventById } = require('../db/wallt-moral-drift');
    const event = await getDriftEventById(parseInt(req.params.id));
    if (!event) return res.status(404).json({ error: 'Drift event not found' });
    res.json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/wallt/moral-drift/:id/resolve — resolve event ──────────────────

router.patch('/:id/resolve', requireAdmin, async (req, res) => {
  try {
    const { resolution } = req.body;
    if (!resolution) return res.status(400).json({ error: 'resolution is required' });

    const valid = ['logged', 'escalated', 'acknowledged', 'cleared'];
    if (!valid.includes(resolution)) {
      return res.status(400).json({ error: `resolution must be one of: ${valid.join(', ')}` });
    }

    const { resolveDriftEvent } = require('../db/wallt-moral-drift');
    const event = await resolveDriftEvent(
      parseInt(req.params.id),
      req.user.id,
      resolution
    );

    if (!event) return res.status(404).json({ error: 'Drift event not found' });
    res.json({ event });
  } catch (err) {
    console.error('[wallt-moral-drift] resolve error:', err.message);
    res.status(500).json({ error: 'Failed to resolve drift event' });
  }
});

module.exports = router;