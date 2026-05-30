/**
 * Owns: Wallt Escalation Protocol — human-in-loop trigger system.
 * Does NOT own: Wallt AI conversation calls, memory cache, personality engine.
 *
 * Escalation types: moral_drift | legal_uncertainty | autonomous_action | user_request | auto_recovery
 * Trigger sources: wallt:moral-drift | wallt:legal-engine | wallt:auto-recovery | wallt:user | wallt:admin
 *
 * Wire points:
 *   - rect-legal-engine.js  → triggerEscalation('legal_uncertainty', 'wallt:legal-engine')
 *   - wallt-memory.js       → triggerEscalation('moral_drift', 'wallt:moral-drift') when score > 0.6
 *   - wallt routes           → triggerEscalation('autonomous_action', 'wallt:admin') on out-of-scope actions
 *   - /api/wallt/escalate    → triggerEscalation('user_request', 'wallt:user')
 *   - auto-recovery service  → triggerEscalation('auto_recovery', 'wallt:auto-recovery')
 */

'use strict';

const pool = require('../db/index');

let walltMem = null;
const walltMemory = () => {
  if (!walltMem) walltMem = require('../db/wallt-memory');
  return walltMem;
};

// ── Slack / Email notification helpers ──────────────────────────────────────

const SLACK_WEBHOOK_URL  = process.env.SLACK_WEBHOOK_URL;
const EMAIL_PROXY_URL    = process.env.EMAIL_PROXY_URL;
const FROM_ADDRESS       = process.env.EMAIL_FROM || 'Wallt <noreply@atlantist.cloud>';
const ADMIN_EMAIL        = process.env.ADMIN_EMAIL || process.env.ATLANTIST_ADMIN_EMAIL;

const PRIORITY_EMOJI = {
  critical: '🚨',
  high:     '⚠️',
  normal:   '📋',
  low:      '🔹',
};

/**
 * Fire-and-forget Slack notification via webhook.
 * Never blocks. Logs failures but continues.
 */
async function notifySlack(escalation) {
  if (!SLACK_WEBHOOK_URL) return false;
  try {
    const emoji = PRIORITY_EMOJI[escalation.priority] || '📋';
    const msg = {
      text: `${emoji} Wallt Escalation [${escalation.priority?.toUpperCase() || 'NORMAL'}]`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `Wallt Escalation: ${escalation.escalation_type || 'general'}` },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Type:*\n${escalation.escalation_type || 'unknown'}` },
            { type: 'mrkdwn', text: `*Priority:*\n${escalation.priority || 'normal'}` },
            { type: 'mrkdwn', text: `*Source:*\n${escalation.trigger_source || 'unknown'}` },
            { type: 'mrkdwn', text: `*Created:*\n${new Date(escalation.created_at).toISOString()}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Subject:*\n${escalation.escalation_subject || escalation.subject || '(no subject)'}` },
        },
        ...(escalation.escalation_body
          ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Body:*\n${escalation.escalation_body || escalation.body || ''}`.substring(0, 2000) } }]
          : []),
        ...(escalation.wallt_recommendation
          ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Wallt Recommendation:*\n${escalation.wallt_recommendation}` } }]
          : []),
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Review in Wallt Admin' }, action_id: 'review_escalation', url: 'https://nexaxis.polsia.app/app/wallt/admin' },
          ],
        },
      ],
    };

    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return resp.ok;
  } catch (err) {
    console.warn('[wallt-escalation] Slack notify failed:', err.message);
    return false;
  }
}

/**
 * Fire-and-forget email notification.
 * Never blocks. Logs failures but continues.
 */
async function notifyEmail(escalation) {
  if (!EMAIL_PROXY_URL) return false;
  const to = ADMIN_EMAIL || process.env.ATLANTIST_ADMIN_EMAIL;
  if (!to) return false;

  try {
    const priority = escalation.priority?.toUpperCase() || 'NORMAL';
    const htmlBody = `
      <h2>Wallt Escalation — ${priority}</h2>
      <table style="border-collapse:collapse;margin-bottom:16px">
        <tr><td style="padding:4px 8px;font-weight:bold">Type</td><td style="padding:4px 8px">${escalation.escalation_type || 'unknown'}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:bold">Source</td><td style="padding:4px 8px">${escalation.trigger_source || 'unknown'}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:bold">Created</td><td style="padding:4px 8px">${new Date(escalation.created_at).toISOString()}</td></tr>
      </table>
      <h3>Subject</h3>
      <p>${escapeHtml(escalation.escalation_subject || escalation.subject || '(no subject)')}</p>
      ${escalation.escalation_body || escalation.body ? `<h3>Details</h3><pre style="background:#f5f5f5;padding:12px;border-radius:4px">${escapeHtml((escalation.escalation_body || escalation.body || '').substring(0, 2000))}</pre>` : ''}
      ${escalation.wallt_recommendation ? `<h3>Wallt Recommendation</h3><p>${escapeHtml(escalation.wallt_recommendation)}</p>` : ''}
      <p><a href="https://nexaxis.polsia.app/app/wallt/admin">Review in Wallt Admin →</a></p>
    `;

    const resp = await fetch(EMAIL_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from: FROM_ADDRESS,
        subject: `[Wallt Escalation ${priority}] ${escalation.escalation_subject || escalation.subject || 'Escalation Triggered'}`,
        html: htmlBody,
      }),
    });
    return resp.ok;
  } catch (err) {
    console.warn('[wallt-escalation] Email notify failed:', err.message);
    return false;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Core escalation API ──────────────────────────────────────────────────────

/**
 * Create an escalation record, then fire notifications.
 * Always returns the created escalation row.
 *
 * @param {Object} ctx
 * @param {string}  ctx.escalation_type  — moral_drift | legal_uncertainty | autonomous_action | user_request | auto_recovery
 * @param {string}  ctx.trigger_source   — wallt:moral-drift | wallt:legal-engine | wallt:auto-recovery | wallt:user | wallt:admin
 * @param {string}  ctx.reason          — one-line reason summary
 * @param {string}  ctx.context         — full context (JSON string or object)
 * @param {string}  ctx.wallt_recommendation — Wallt's recommended resolution
 * @param {number}  ctx.userId          — associated user (nullable)
 * @param {string}  [ctx.sessionUuid]   — session UUID (nullable)
 * @param {string}  [ctx.priority]      — critical | high | normal | low (default: normal)
 */
async function createEscalation(ctx) {
  const {
    escalation_type,
    trigger_source,
    reason,
    context,
    wallt_recommendation = null,
    userId = null,
    sessionUuid = null,
    priority = 'normal',
  } = ctx;

  const subject = `[${escalation_type?.toUpperCase()}] Wallt requires human review — ${reason?.substring(0, 80) || 'action blocked'}`;
  const body = typeof context === 'string' ? context : JSON.stringify(context || {}, null, 2);

  const escalationId = `wallt-escal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Write to wallt_core_escalation_log via wallt-memory
  const row = await walltMemory().logEscalation({
    userId,
    sessionUuid,
    escalationSubject: subject,
    escalationBody: body,
    escalationReason: `wallt_escalation_protocol:${escalation_type}`,
    priority,
  });

  // Now update with protocol-specific fields
  await pool.query(
    `UPDATE wallt_core_escalation_log
     SET escalation_type = $2, trigger_source = $3, wallt_recommendation = $4
     WHERE id = $1`,
    [row.id, escalation_type, trigger_source, wallt_recommendation]
  );

  // Reload with updated fields
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_escalation_log WHERE id = $1`, [row.id]
  );
  const escalation = rows[0];

  // Fire notifications in parallel — never blocks the response
  const [slackOk, emailOk] = await Promise.all([
    notifySlack(escalation).catch(() => false),
    notifyEmail(escalation).catch(() => false),
  ]);

  // Record notification timestamps
  if (slackOk || emailOk) {
    await pool.query(
      `UPDATE wallt_core_escalation_log
       SET notified_slack_at = CASE WHEN $2::boolean THEN NOW() ELSE notified_slack_at END,
           notified_email_at = CASE WHEN $3::boolean THEN NOW() ELSE notified_email_at END
       WHERE id = $1`,
      [row.id, slackOk, emailOk]
    );
  }

  // ── Audio composition for critical escalations ─────────────────────────────
  // Wire to wallt-audio-engine: only fires on CRITICAL misconceptions.
  // Trigger conditions: moral_drift > 0.6 + irreversible | legal NON_COMPLIANT on
  // core ATLANTIST principle | critical safety gate. NOT routine queries.
  // Audio is admin-panel-only — never published externally.
  if (['critical', 'high'].includes(priority)) {
    const { shouldGenerateAudio, composeEscalationAudio } = require('./wallt-audio-engine');
    const parsedCtx = typeof context === 'string' ? JSON.parse(context || '{}') : (context || {});
    const shouldCompose = shouldGenerateAudio({ escalationType: escalation_type, priority, context: parsedCtx });
    if (shouldCompose) {
      // Fire-and-forget — never blocks escalation response
      composeEscalationAudio({
        escalationId: String(row.id),
        escalationType: escalation_type,
        priority,
        context: parsedCtx,
      }).then(result => {
        pool.query(
          `UPDATE wallt_core_escalation_log
           SET audio_file_ref = $2, audio_reason = $3
           WHERE id = $1`,
          [row.id, result.audioUrl, `wallt_audio_engine:escalation:${escalation_type}`]
        ).catch(e => console.warn('[wallt-escalation] audio attach failed:', e.message));
        // Log to audio catalog with full rights breakdown (Phase 36R escalation protocol)
        // Rights model: all Wallt compositions → rights to Nikita Beregovykh
        // Per-composition breakdown: original attribution + sampled/sourced + AI training + jurisdiction
        const rightsBreakdown = {
          original: {
            holder: 'Nikita Beregovykh',
            rights: 'all-rights-reserved',
            attribution_required: true,
          },
          licensed: [], // no external samples sourced — pure synthesis
          generated: {
            source: 'Wallt Audio Composition Engine (server-side Web Audio API synthesis)',
            training_provenance: 'No training data used — pure algorithmic tone generation',
            jurisdiction: 'US',
            format: 'OGG Vorbis (admin-panel-only, not published externally)',
          },
          escalation_id: String(row.id),
          escalation_type,
          priority,
        };
        return pool.query(
          `INSERT INTO wallt_core_audio_catalog
             (user_id, file_name, file_path, rights_breakdown_json, duration_seconds, sample_rate_hz, format, tags, metadata_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            userId,
            `escal-${row.id}-${Date.now()}.ogg`,
            result.audioUrl,
            JSON.stringify(rightsBreakdown),
            result.durationSeconds || null,
            12000, // SAMPLE_RATE from wallt-audio-engine — hardcoded here, not re-exported
            'ogg',
            ['wallt', 'escalation', escalation_type, priority],
            JSON.stringify({
              source: 'wallt_audio_engine:escalation_protocol',
              escalation_type,
              priority,
              file_size_kb: result.fileSizeKb,
              audio_generated_at: result.generatedAt,
              format: 'OGG Vorbis (not WAV/mp3)',
            }),
          ]
        );
      }).catch(e => console.warn('[wallt-escalation] audio compose failed:', e.message));
    }
  }

  // ── Context Graph wiring: feature:wallt node on escalation ───────────────────
  // Append escalation to feature:wallt node metadata for audit trail visibility.
  // Lazy-load to avoid circular require with wallt-context-graph routes.
  const pool2 = require('../db/index');
  pool2.query(
    `INSERT INTO wallt_context_graph (node_type, content, metadata_json, updated_at)
     VALUES ('feature:wallt', 'Wallt Escalation Protocol active', jsonb_build_object(
       'last_escalation_id', $1,
       'last_escalation_type', $2,
       'last_priority', $3,
       'last_trigger_source', $4,
       'last_audio', $5,
       'escalation_count', 1,
       'updated_at', NOW()::text
     ))
     ON CONFLICT (node_type) DO UPDATE
     SET metadata_json = wallt_context_graph.metadata_json || jsonb_build_object(
       'last_escalation_id', $1,
       'last_escalation_type', $2,
       'last_priority', $3,
       'last_trigger_source', $4,
       'last_audio', $5,
       'escalation_count', COALESCE((wallt_context_graph.metadata_json->>'escalation_count')::int, 0) + 1,
       'updated_at', NOW()::text
     ),
     updated_at = NOW()`,
    [
      String(escalation.id),
      escalation_type,
      priority,
      trigger_source,
      escalation.audio_file_ref || null,
    ]
  ).catch(e => console.warn('[wallt-escalation] context-graph write failed:', e.message));

  return escalation;
}

/**
 * Resolve an escalation (admin action).
 */
async function resolveEscalation(escalationId, polsiaResponse, resolvedByUserId, resolutionAction = 'approved') {
  const { rows } = await pool.query(
    `UPDATE wallt_core_escalation_log
     SET polsia_response = $2,
         polsia_response_at = NOW(),
         status = 'responded',
         resolved_by = $3,
         resolution_action = $4
     WHERE id = $1
     RETURNING *`,
    [escalationId, polsiaResponse, resolvedByUserId, resolutionAction]
  );
  return rows[0] || null;
}

/**
 * Get pending escalations, optionally filtered by type/source.
 */
async function getPendingEscalations({ escalation_type = null, trigger_source = null, limit = 20 } = {}) {
  const args = [limit];
  let where = 'status = $1';
  if (escalation_type) {
    where += ` AND escalation_type = $${args.length + 1}`;
    args.push(escalation_type);
  }
  if (trigger_source) {
    where += ` AND trigger_source = $${args.length + 1}`;
    args.push(trigger_source);
  }
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_escalation_log
     WHERE ${where}
     ORDER BY
       CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       created_at DESC
     LIMIT $1`,
    args
  );
  return rows;
}

/**
 * Check if escalation is due (moral drift score > threshold, legal uncertainty, etc).
 * Returns true if condition met, false otherwise.
 *
 * This is the central trigger-check function called by Wallt AI or other services.
 */
async function checkAndTrigger(ctx) {
  const {
    escalation_type,
    trigger_source,
    reason,
    context,
    wallt_recommendation,
    userId,
    sessionUuid,
    priority,
    auto_escalate = false, // true = auto-trigger without confirmation
  } = ctx;

  if (!auto_escalate) {
    // Human-in-the-loop: just create the escalation (require approval)
    return createEscalation(ctx);
  }

  // For auto-escalation scenarios, trigger directly
  return createEscalation({ ...ctx, priority: priority || 'normal' });
}

// ── Trigger helpers for each escalation type ────────────────────────────────

/**
 * Trigger escalation from moral drift detection.
 * Called when moral_drift_score > 0.6.
 */
async function triggerFromMoralDrift(score, context, userId, sessionUuid) {
  return createEscalation({
    escalation_type: 'moral_drift',
    trigger_source: 'wallt:moral-drift',
    reason: `Moral drift score ${score} exceeds threshold (0.6)`,
    context: typeof context === 'string' ? context : JSON.stringify(context),
    wallt_recommendation: 'Halt autonomous action pending human review. Review decision log and conflict history.',
    userId,
    sessionUuid,
    priority: score > 0.8 ? 'critical' : score > 0.6 ? 'high' : 'normal',
  });
}

/**
 * Trigger escalation from legal engine (confidence < 0.5 on compliance check).
 * Called when rect-legal-engine returns AMBIGUOUS or NON_COMPLIANT verdict.
 */
async function triggerFromLegalEngine(verdict, reason, details, userId) {
  return createEscalation({
    escalation_type: 'legal_uncertainty',
    trigger_source: 'wallt:legal-engine',
    reason: `Legal compliance check returned ${verdict}`,
    context: JSON.stringify({ verdict, details }),
    wallt_recommendation: reason,
    userId,
    priority: 'high',
  });
}

/**
 * Trigger escalation when Wallt takes autonomous action outside user-defined scope.
 * Called from Wallt AI bridge / action execution layer.
 */
async function triggerFromAutonomousAction(actionType, actionDetails, scope, userId, sessionUuid) {
  return createEscalation({
    escalation_type: 'autonomous_action',
    trigger_source: 'wallt:admin',
    reason: `Wallt executed action "${actionType}" outside declared scope`,
    context: JSON.stringify({ action_type: actionType, action_details: actionDetails, declared_scope: scope }),
    wallt_recommendation: `Scope violation detected. User scope: ${JSON.stringify(scope)}. Action: ${actionType}. Awaiting human approval.`,
    userId,
    sessionUuid,
    priority: 'high',
  });
}

/**
 * Trigger escalation when user explicitly asks Wallt to escalate.
 * e.g. user says "escalate to Nikita" or clicks the escalate button.
 */
async function triggerFromUserRequest(reason, context, userId, sessionUuid) {
  return createEscalation({
    escalation_type: 'user_request',
    trigger_source: 'wallt:user',
    reason,
    context: typeof context === 'string' ? context : JSON.stringify(context),
    wallt_recommendation: 'User has requested human review. Please assess and respond.',
    userId,
    sessionUuid,
    priority: 'normal',
  });
}

/**
 * Trigger escalation from auto-recovery system (Wallt encountered unexpected state).
 */
async function triggerFromAutoRecovery(recoveryContext, userId, sessionUuid) {
  return createEscalation({
    escalation_type: 'auto_recovery',
    trigger_source: 'wallt:auto-recovery',
    reason: 'Auto-recovery triggered — Wallt encountered unexpected state requiring human review',
    context: typeof recoveryContext === 'string' ? recoveryContext : JSON.stringify(recoveryContext),
    wallt_recommendation: 'Auto-recovery failed to resolve autonomously. Human review required to assess state and guide recovery.',
    userId,
    sessionUuid,
    priority: 'medium',
  });
}

/**
 * Check moral drift score from wallt-admin DB logic and escalate if threshold exceeded.
 * Threshold: score > 0.6 → escalate. Score > 0.8 → critical.
 *
 * This function is called from the Wallt admin stats endpoint (wallt-admin.js GET /stats)
 * after computing the drift score — it will only escalate once per threshold crossing
 * per user per day (tracked via wallt_core_escalation_log escalation_type = 'moral_drift').
 */
async function checkMoralDriftEscalation() {
  const { getMoralDriftScore } = require('../db/wallt-admin');
  const drift = await getMoralDriftScore();

  if (drift.score <= 60) return null; // below threshold — no escalation

  // Check if we already escalated today for moral drift (prevent spam)
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT id FROM wallt_core_escalation_log
     WHERE escalation_type = 'moral_drift'
       AND DATE(created_at) = $1
     LIMIT 1`,
    [today]
  );
  if (rows.length > 0) {
    // Already escalated today — update existing record with new score
    await pool.query(
      `UPDATE wallt_core_escalation_log
       SET escalation_body = escalation_body || $2::jsonb
       WHERE id = $1`,
      [rows[0].id, JSON.stringify({ updated_drift_score: drift.score, rechecked_at: new Date().toISOString() })]
    );
    return null;
  }

  return triggerFromMoralDrift(
    drift.score,
    {
      score: drift.score,
      verdict: drift.verdict,
      history: drift.history,
      escalated_by: 'wallt:moral-drift-check',
    },
    null, // userId — system-level escalation
    null  // sessionUuid
  );
}

module.exports = {
  createEscalation,
  resolveEscalation,
  getPendingEscalations,
  checkAndTrigger,
  checkMoralDriftEscalation,
  triggerFromMoralDrift,
  triggerFromLegalEngine,
  triggerFromAutonomousAction,
  triggerFromUserRequest,
  triggerFromAutoRecovery,
};