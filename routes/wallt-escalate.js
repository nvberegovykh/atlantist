/**
 * Owns: /api/wallt/escalate — Wallt Escalation Protocol trigger and resolution API.
 * Does NOT own: Wallt AI calls, memory cache, personality engine, action execution.
 *
 * Endpoints:
 *   POST   /api/wallt/escalate        — create escalation (any trigger source)
 *   GET    /api/wallt/escalate        — list pending/escalated tickets (admin + user)
 *   GET    /api/wallt/escalate/:id   — single escalation detail
 *   PATCH  /api/wallt/escalate/:id    — resolve escalation (admin only)
 *
 * Trigger types:
 *   moral_drift       — moral_drift_score > 0.6 from wallt-admin
 *   legal_uncertainty — legal engine confidence < 0.5
 *   autonomous_action — Wallt acted outside declared user scope
 *   user_request      — user explicitly asks for human review
 *   auto_recovery     — auto-recovery hit an unexpected state
 *
 * Notification: Slack webhook + email to ADMIN_EMAIL on escalation creation.
 */
const router = require('express').Router();
const { optionalAuth, adminMiddleware: requireAdmin } = require('./auth');
const escalationService = require('../services/wallt-escalation');

function resolveUserId(req) {
  return req.user ? req.user.id : null;
}

// ── POST /api/wallt/escalate — create escalation ──────────────────────────────

router.post('/', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const {
      escalation_type,  // required: moral_drift | legal_uncertainty | autonomous_action | user_request | auto_recovery
      trigger_source,   // optional: wallt:moral-drift | wallt:legal-engine | wallt:auto-recovery | wallt:user | wallt:admin
      reason,           // required: one-line reason
      context,          // optional: full context (object or string)
      wallt_recommendation, // optional
      priority,         // optional: critical | high | normal | low
    } = req.body;

    if (!escalation_type || !reason) {
      return res.status(400).json({
        error: 'escalation_type and reason are required',
        hint: 'escalation_type must be one of: moral_drift, legal_uncertainty, autonomous_action, user_request, auto_recovery',
      });
    }

    const validTypes = ['moral_drift', 'legal_uncertainty', 'autonomous_action', 'user_request', 'auto_recovery'];
    if (!validTypes.includes(escalation_type)) {
      return res.status(400).json({
        error: `invalid escalation_type "${escalation_type}"`,
        hint: `must be one of: ${validTypes.join(', ')}`,
      });
    }

    const escalation = await escalationService.createEscalation({
      escalation_type,
      trigger_source: trigger_source || `wallt:user`,
      reason,
      context: context || {},
      wallt_recommendation: wallt_recommendation || null,
      userId,
      sessionUuid: req.session?.uuid || null,
      priority: priority || 'normal',
    });

    res.status(201).json({
      escalation,
      message: 'Escalation created. Human review pending.',
    });
  } catch (err) {
    console.error('[wallt-escalate] create error:', err.message);
    res.status(500).json({ error: 'Failed to create escalation' });
  }
});

// ── GET /api/wallt/escalate — list escalations ─────────────────────────────────

router.get('/', optionalAuth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { status, escalation_type, trigger_source, limit } = req.query;

    const escalations = await escalationService.getPendingEscalations({
      escalation_type: escalation_type || null,
      trigger_source: trigger_source || null,
      limit: Math.min(parseInt(limit, 10) || 20, 100),
    });

    // Non-admins see only their own escalations
    const visible = escalations.filter(e => e.user_id === userId || e.user_id === null);

    res.json({ escalations: visible, count: visible.length });
  } catch (err) {
    console.error('[wallt-escalate] list error:', err.message);
    res.status(500).json({ error: 'Failed to load escalations' });
  }
});

// ── GET /api/wallt/escalate/:id — single escalation ────────────────────────────

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { pool } = require('../db/index');
    const { rows } = await pool.query(
      `SELECT * FROM wallt_core_escalation_log WHERE id = $1`,
      [parseInt(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ escalation: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/wallt/escalate/:id — resolve escalation ────────────────────────

router.patch('/:id', optionalAuth, async (req, res) => {
  try {
    // Only admin can resolve escalations
    const token = req.cookies?.session_token;
    if (!token) return res.status(401).json({ error: 'Login required' });

    const { getSessionByToken } = require('../db/auth');
    const session = await getSessionByToken(token);
    if (!session) return res.status(401).json({ error: 'Invalid session' });

    const { getUserRole } = require('../db/roles');
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { response, resolution_action } = req.body;
    if (!response) return res.status(400).json({ error: 'response is required' });

    const validActions = ['approved', 'denied', 'modified', 'pending'];
    if (resolution_action && !validActions.includes(resolution_action)) {
      return res.status(400).json({ error: `resolution_action must be one of: ${validActions.join(', ')}` });
    }

    const escalation = await escalationService.resolveEscalation(
      parseInt(req.params.id),
      response,
      session.user_id,
      resolution_action || 'approved'
    );

    if (!escalation) return res.status(404).json({ error: 'Escalation not found' });

    res.json({ escalation });
  } catch (err) {
    console.error('[wallt-escalate] resolve error:', err.message);
    res.status(500).json({ error: 'Failed to resolve escalation' });
  }
});

module.exports = router;