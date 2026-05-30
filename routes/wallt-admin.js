/**
 * Owns: /api/wallt/admin/* — Wallt Admin Panel monitoring API.
 * Does NOT own: Wallt AI calls, memory cache, UI, WebSocket server.
 *
 * All endpoints require admin role. WebSocket broadcasts on:
 *   wallt:admin:refresh  — pushed every 30s, all clients should re-fetch
 */
const router = require('express').Router();
const pool = require('../db/index');
const { getSessionByToken } = require('../db/auth');
const { getUserRole } = require('../db/roles');
const walltAdmin = require('../db/wallt-admin');
const escalationService = require('../services/wallt-escalation');
const driftService      = require('../services/wallt-moral-drift');

// ── Auth guard ──────────────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    const session = await getSessionByToken(token);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    const role = await getUserRole(session.user_id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.adminUserId = session.user_id;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth error' });
  }
}

// ── WS broadcast helper ───────────────────────────────────────────────────────

let broadcastFn = null;
router.setBroadcast = (fn) => { broadcastFn = fn; };
function broadcast(data) {
  if (broadcastFn) broadcastFn('wallt:admin', data);
}

// ── GET /api/wallt/admin/stats — all panels at once ──────────────────────────

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    // Run drift check first — may trigger escalation via wallt-moral-drift service
    const driftResult = await driftService.checkAndLogDrift({ userId: null, sessionUuid: null });

    const [memory, decisions, escalations, legal, deploy, driftEvents] = await Promise.all([
      walltAdmin.getMemoryStats(),
      walltAdmin.getActiveDecisions({ limit: 30 }),
      walltAdmin.getEscalationQueue(),
      walltAdmin.getLegalComplianceStatus(),
      walltAdmin.getSelfDeployLog({ limit: 30 }),
      // Build history for panel: 14-day trend from wallt_moral_drift_log
      (async () => {
        const { getDriftStats } = require('../db/wallt-moral-drift');
        const stats = await getDriftStats({ days: 14 });
        return stats.dailyTrend.map(d => ({
          day:            d.day,
          totalDecisions: d.eventCount,   // renamed for compat with panel
          reversed:       0,
          lowConfidence:  0,
          conflicts:      d.redEvents,     // red events = conflicts
        }));
      })(),
    ]);

    // Build drift response matching the old panel-3 shape for backward compat
    const drift = {
      score:       Math.round(driftResult.score * 100),
      verdict:     driftResult.score < 0.3 ? 'STABLE'
                 : driftResult.score < 0.6 ? 'DRIFTING'
                 : 'CRITICAL',
      flags:       driftResult.flags,
      recommendation: driftResult.recommendation,
      breakdown:   driftResult.breakdown,
      history:     driftEvents,           // panel expects this shape
      event_id:    driftResult.event_id,
    };

    res.json({ memory, decisions, drift, escalations, legal, deploy, ts: Date.now() });
  } catch (err) {
    console.error('[wallt-admin] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load admin stats' });
  }
});

// ── GET /api/wallt/admin/memory ──────────────────────────────────────────────

router.get('/memory', requireAdmin, async (req, res) => {
  try {
    const stats = await walltAdmin.getMemoryStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/decisions ────────────────────────────────────────────

router.get('/decisions', requireAdmin, async (req, res) => {
  try {
    const decisions = await walltAdmin.getActiveDecisions({
      limit: Math.min(parseInt(req.query.limit, 10) || 30, 100),
    });
    res.json({ decisions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/drift — real-time drift score + flags ─────────────────

router.get('/drift', requireAdmin, async (req, res) => {
  try {
    const result = await driftService.checkAndLogDrift({ userId: null, sessionUuid: null });
    res.json({
      score:         result.score,
      verdict:       result.verdict,
      flags:         result.flags,
      recommendation: result.recommendation,
      breakdown:     result.breakdown,
      event_id:      result.event_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/drift/history — drift event log ───────────────────────

router.get('/drift/history', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const { getDriftEvents } = require('../db/wallt-moral-drift');
    const events = await getDriftEvents({ limit });
    res.json({ events, count: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/drift/stats — aggregate drift stats ───────────────────

router.get('/drift/stats', requireAdmin, async (req, res) => {
  try {
    const { getDriftStats } = require('../db/wallt-moral-drift');
    const stats = await getDriftStats({ days: parseInt(req.query.days, 10) || 30 });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/wallt/admin/drift/resolve/:id — resolve drift event ───────────────

router.patch('/drift/resolve/:id', requireAdmin, async (req, res) => {
  try {
    const { resolution } = req.body;
    const valid = ['logged', 'escalated', 'acknowledged', 'cleared'];
    if (!resolution || !valid.includes(resolution)) {
      return res.status(400).json({ error: `resolution must be one of: ${valid.join(', ')}` });
    }
    const { resolveDriftEvent } = require('../db/wallt-moral-drift');
    const event = await resolveDriftEvent(parseInt(req.params.id), req.adminUserId, resolution);
    if (!event) return res.status(404).json({ error: 'Drift event not found' });
    res.json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/wallt/admin/drift/escalate — force moral drift escalation ────────
// Admins can manually trigger escalation for the current drift score
router.post('/drift/escalate', requireAdmin, async (req, res) => {
  try {
    const { score_override, reason } = req.body;
    const result = await driftService.checkAndLogDrift({ userId: null, sessionUuid: null });
    const score = score_override ?? result.score;

    if (score <= 0.6) return res.json({ skipped: true, reason: 'drift score below threshold (0.6)', score });

    const escalation = await escalationService.triggerFromMoralDrift(
      score,
      { drift_data: result, override: !!score_override, reason: reason || `Admin-triggered at score ${score}`, event_id: result.event_id },
      null, null
    );
    res.status(201).json({ escalation, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/escalations ─────────────────────────────────────────

router.get('/escalations', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    const escalations = await walltAdmin.getEscalationQueue({ status });
    res.json({ escalations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/wallt/admin/escalations/:id — resolve escalation ───────────────

router.patch('/escalations/:id', requireAdmin, async (req, res) => {
  try {
    const { response } = req.body;
    if (!response) return res.status(400).json({ error: 'response is required' });
    const row = await walltAdmin.resolveEscalation(parseInt(req.params.id), response);
    if (!row) return res.status(404).json({ error: 'Not found' });
    broadcast({ type: 'escalation_resolved', escalationId: row.id });
    res.json({ escalation: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/legal ────────────────────────────────────────────────

router.get('/legal', requireAdmin, async (req, res) => {
  try {
    const legal = await walltAdmin.getLegalComplianceStatus();
    res.json(legal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/admin/deploy-log ──────────────────────────────────────────

router.get('/deploy-log', requireAdmin, async (req, res) => {
  try {
    const deploy = await walltAdmin.getSelfDeployLog({
      limit: Math.min(parseInt(req.query.limit, 10) || 30, 100),
    });
    res.json(deploy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/wallt/admin/ping — nudge WS broadcast (e.g., after action) ─────

router.post('/ping', requireAdmin, (_req, res) => {
  broadcast({ type: 'refresh', ts: Date.now() });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Concern / Escalation Log
// Filterable by date range, type (moral/legal/both), resolution status.
// Status badges: PENDING / APPROVED / REFUSED / RECORRECTED.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/wallt/admin/concern-log
router.get('/concern-log', requireAdmin, async (req, res) => {
  try {
    const {
      start_date, end_date, concern_type,
      status, limit, offset,
    } = req.query;

    const rows = await walltAdmin.getConcernLog({
      startDate:   start_date || null,
      endDate:     end_date   || null,
      concernType: concern_type || null,
      status:      status      || null,
      limit:       Math.min(parseInt(limit, 10)  || 50, 100),
      offset:      Math.max(parseInt(offset, 10) || 0,  0),
    });
    res.json({ concerns: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallt/admin/concern-log/export?format=csv|json
router.get('/concern-log/export', requireAdmin, async (req, res) => {
  try {
    const { format = 'json', start_date, end_date, concern_type, status } = req.query;
    const concerns = await walltAdmin.getConcernLog({
      startDate:   start_date   || null,
      endDate:     end_date     || null,
      concernType: concern_type || null,
      status:      status       || null,
      limit:       1000,
    });

    if (format === 'csv') {
      const header = 'id,escalation_type,subject,status,priority,user_email,created_at,polsia_response,resolution_action\n';
      const lines  = concerns.map(c =>
        `"${c.id}","${c.escalation_type}","${(c.subject||'').replace(/"/g,'""')}","${c.status}","${c.priority}","${c.user_email||''}","${c.created_at}","${(c.polsia_response||'').replace(/"/g,'""')}","${c.resolution_action||''}"`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=wallt-concern-log.csv');
      return res.send(header + lines);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=wallt-concern-log.json');
    res.json({ concerns, exported_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/wallt/admin/concern-log/:id — resolve concern
router.patch('/concern-log/:id', requireAdmin, async (req, res) => {
  try {
    const { resolution } = req.body;
    const valid = ['approved', 'refused', 'recorrected', 'acknowledged'];
    if (!resolution || !valid.includes(resolution)) {
      return res.status(400).json({ error: `resolution must be one of: ${valid.join(', ')}` });
    }
    const row = await walltAdmin.resolveConcern(parseInt(req.params.id), resolution, req.adminUserId);
    if (!row) return res.status(404).json({ error: 'Concern not found' });
    broadcast({ type: 'concern_resolved', concernId: row.id });
    res.json({ concern: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Audio Composition Library
// Admin-only; not published externally.
// Filter by date, concern type, rights breakdown completeness.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/wallt/admin/audio-library
router.get('/audio-library', requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date, concern_type, rights_complete, limit, offset } = req.query;
    const result = await walltAdmin.getAudioCatalogAdmin({
      startDate:     start_date      || null,
      endDate:       end_date        || null,
      concernType:   concern_type    || null,
      rightsComplete: rights_complete === 'true' ? true : rights_complete === 'false' ? false : null,
      limit:         Math.min(parseInt(limit, 10)  || 50, 100),
      offset:        Math.max(parseInt(offset, 10) || 0,  0),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallt/admin/audio-library/:id — single track with rights
router.get('/audio-library/:id', requireAdmin, async (req, res) => {
  try {
    const track = await walltAdmin.getAudioById(parseInt(req.params.id));
    if (!track) return res.status(404).json({ error: 'Track not found' });
    res.json({ track });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallt/admin/audio-library/:id/download — download wav + rights JSON
router.get('/audio-library/:id/download', requireAdmin, async (req, res) => {
  try {
    const track = await walltAdmin.getAudioById(parseInt(req.params.id));
    if (!track) return res.status(404).json({ error: 'Track not found' });

    // Return metadata + rights breakdown as JSON (file served from R2 or static)
    const payload = {
      track: {
        id:             track.id,
        file_name:      track.file_name,
        format:         track.format,
        duration_secs:  track.duration_seconds,
        sample_rate_hz: track.sample_rate_hz,
        tags:           track.tags,
      },
      rights: track.rights_breakdown_json,
      metadata: track.metadata_json,
      generated_at: track.created_at,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${track.file_name.replace(/\/[^\/]+$/, '')}.rights.json"`);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Wallt Health Status
// Live: ONLINE / DEGRADED / OFFLINE / ERROR, last check, active sessions,
// recovery attempts, last 10 errors.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/wallt/admin/health-status
router.get('/health-status', requireAdmin, async (req, res) => {
  try {
    const health = await walltAdmin.getWalltHealthStatus();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Emergency Recovery
// Hard reset Wallt, restore from last Core checkpoint.
// Email admin with recovery report after reset.
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/wallt/admin/emergency-recovery
// Body: { confirm: true } — must pass confirm=true to execute
router.post('/emergency-recovery', requireAdmin, async (req, res) => {
  try {
    const { confirm } = req.body;
    if (!confirm) {
      return res.status(400).json({
        error: 'Confirmation required. Pass { confirm: true } to execute emergency recovery.',
        warning: 'This will wipe the current session and restore from the last checkpoint.',
      });
    }

    const { wipeSession } = require('../services/wallt-session-store');
    const { getLatestDecisionState } = require('../db/wallt-memory');

    // Gather pre-reset state for the report
    const preState = await walltAdmin.getWalltHealthStatus();
    const latestState = await getLatestDecisionState ? await getLatestDecisionState() : null;

    // Wipe all active sessions (hard reset)
    const { rows: activeSessions } = await pool.query(`
      SELECT id FROM wallt_conversations WHERE is_archived = FALSE
    `);
    const wipedSessions = [];
    for (const s of activeSessions) {
      await wipeSession(String(s.id)).catch(() => {});
      wipedSessions.push(s.id);
    }

    // Re-init from last checkpoint (latest decision state)
    if (latestState) {
      const { initSession } = require('../services/wallt-session-store');
      await initSession(latestState.conversation_id).catch(() => {});
    }

    // Log the recovery event
    const { logRecoveryEvent } = require('../db/wallt-recovery');
    const event = await logRecoveryEvent({
      eventType:        'admin_emergency_reset',
      triggerSource:    'wallt:admin:emergency-recovery',
      userId:           req.adminUserId,
      detectedCondition: { wiped_sessions: wipedSessions.length, pre_state: preState },
      recoveryAction:   'wipe_session + reinit_from_checkpoint',
      verdict:          'DEGRADED',  // system is now in recovery state
    });

    // Send email report to admin
    const EMAIL_PROXY_URL = process.env.EMAIL_PROXY_URL;
    const ADMIN_EMAIL     = process.env.ADMIN_EMAIL || process.env.ATLANTIST_ADMIN_EMAIL;
    if (EMAIL_PROXY_URL && ADMIN_EMAIL) {
      const htmlBody = `
        <h2>Wallt Emergency Recovery — Executed</h2>
        <p><strong>Executed by:</strong> admin (user_id: ${req.adminUserId})</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        <p><strong>Sessions wiped:</strong> ${wipedSessions.length}</p>
        <p><strong>Pre-reset health:</strong> ${preState.status} (${preState.health_status_raw})</p>
        <p><strong>Active sessions before reset:</strong> ${preState.active_sessions}</p>
        <p><strong>Recovery event ID:</strong> ${event?.id || 'unknown'}</p>
        <p><a href="https://nexaxis.polsia.app/admin/wallt-admin.html">Review in Wallt Admin →</a></p>
      `;
      fetch(EMAIL_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: ADMIN_EMAIL,
          from: 'Wallt <noreply@atlantist.cloud>',
          subject: '[Wallt Emergency Recovery] Reset executed — review required',
          html: htmlBody,
        }),
      }).catch(e => console.warn('[wallt-admin] recovery email failed:', e.message));
    }

    broadcast({ type: 'wallt:admin', data: { action: 'emergency_recovery_executed' } });
    res.json({
      ok: true,
      recovery_event_id: event?.id,
      sessions_wiped:    wipedSessions.length,
      pre_state:          preState.status,
      message:            'Emergency recovery executed. Admin notified by email.',
    });
  } catch (err) {
    console.error('[wallt-admin] emergency-recovery error:', err.message);
    res.status(500).json({ error: 'Emergency recovery failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Memory Status (detailed — session/core/archive breakdown)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/wallt/admin/memory-detailed
router.get('/memory-detailed', requireAdmin, async (req, res) => {
  try {
    const detail = await walltAdmin.getMemoryDetailed();
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;