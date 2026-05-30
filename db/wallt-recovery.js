/**
 * Owns: wallt_recovery_events — Wallt Auto-Recovery audit log.
 * Does NOT own: wallt_core_decision_log (decisions), wallt_session_store (sessions).
 *
 * Operations:
 *   logRecoveryEvent       — write a recovery event record
 *   getRecoveryEvents      — fetch events (admin dashboard, audit trail)
 *   getRecoveryEventById   — single event by ID
 *   updateRecoveryStatus   — patch status + verdict after recovery completes
 *   getActiveEvents        — pending/failed events needing attention
 *   getLoopHistory         — recent loop detection events for a session/user
 *   getRecoveryStats       — aggregate stats for admin monitoring
 */
const pool = require('./index');

// ── Log a recovery event ─────────────────────────────────────────────────────

const logRecoveryEvent = async ({
  eventType,
  triggerSource,
  userId          = null,
  sessionUuid     = null,
  conversationId  = null,
  detectedCondition,
  recoveryAction   = null,
  recoveryStatus   = 'pending',
  recoveryDetail   = null,
  stepsTaken       = [],
  verdict          = null,
  verdictReason    = null,
  loopSignature    = null,
  loopCount        = 1,
  loopDecisionKeys = null,
  memoryUsageMb    = null,
  memoryThresholdMb = null,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_recovery_events
     (event_type, trigger_source, user_id, session_uuid, conversation_id,
      detected_condition, recovery_action, recovery_status, recovery_detail,
      steps_taken, verdict, verdict_reason, loop_signature, loop_count,
      loop_decision_keys, memory_usage_mb, memory_threshold_mb,
      detected_at, recovery_started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
     RETURNING *`,
    [
      eventType, triggerSource, userId, sessionUuid, conversationId,
      JSON.stringify(detectedCondition),
      recoveryAction, recoveryStatus,
      recoveryDetail ? JSON.stringify(recoveryDetail) : null,
      JSON.stringify(stepsTaken),
      verdict, verdictReason,
      loopSignature, loopCount,
      loopDecisionKeys ? JSON.stringify(loopDecisionKeys) : null,
      memoryUsageMb, memoryThresholdMb,
    ]
  );
  return rows[0];
};

// ── Fetch recovery events ─────────────────────────────────────────────────────

const getRecoveryEvents = async ({
  userId        = null,
  sessionUuid   = null,
  eventType     = null,
  recoveryStatus = null,
  verdict        = null,
  limit          = 50,
} = {}) => {
  const args = [];
  let where  = 'WHERE 1=1';

  if (userId !== null) {
    args.push(userId);
    where += ` AND user_id = $${args.length}`;
  }
  if (sessionUuid) {
    args.push(sessionUuid);
    where += ` AND session_uuid = $${args.length}`;
  }
  if (eventType) {
    args.push(eventType);
    where += ` AND event_type = $${args.length}`;
  }
  if (recoveryStatus) {
    args.push(recoveryStatus);
    where += ` AND recovery_status = $${args.length}`;
  }
  if (verdict) {
    args.push(verdict);
    where += ` AND verdict = $${args.length}`;
  }
  args.push(limit);

  const { rows } = await pool.query(
    `SELECT
       r.*,
       u.email  AS user_email,
       c.title  AS conversation_title
     FROM wallt_recovery_events r
     LEFT JOIN app_users u ON u.id = r.user_id
     LEFT JOIN wallt_conversations c ON c.id = r.conversation_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${args.length}`,
    args
  );
  return rows;
};

// ── Single event ──────────────────────────────────────────────────────────────

const getRecoveryEventById = async (eventId) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.email AS user_email
     FROM wallt_recovery_events r
     LEFT JOIN app_users u ON u.id = r.user_id
     WHERE r.id = $1`,
    [eventId]
  );
  return rows[0] || null;
};

// ── Update recovery status after self-heal attempts ───────────────────────────

const updateRecoveryStatus = async (eventId, {
  recoveryStatus,
  recoveryDetail    = null,
  stepsTaken        = null,
  verdict            = null,
  verdictReason      = null,
}) => {
  const recoveryCompletedAt = ['success', 'partial', 'failed', 'escalated'].includes(recoveryStatus)
    ? 'NOW()'
    : 'recovery_completed_at';

  const { rows } = await pool.query(
    `UPDATE wallt_recovery_events
     SET recovery_status = $2,
         recovery_detail = COALESCE($3, recovery_detail),
         steps_taken     = COALESCE($4, steps_taken),
         verdict         = COALESCE($5, verdict),
         verdict_reason  = $6,
         recovery_completed_at = ${recoveryCompletedAt}
     WHERE id = $1
     RETURNING *`,
    [
      eventId,
      recoveryStatus,
      recoveryDetail     ? JSON.stringify(recoveryDetail)      : null,
      stepsTaken        ? JSON.stringify(stepsTaken)           : null,
      verdict,
      verdictReason,
    ]
  );
  return rows[0] || null;
};

// ── Active (unresolved) events for monitoring ────────────────────────────────

const getActiveEvents = async ({ limit = 20 } = {}) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.email AS user_email
     FROM wallt_recovery_events r
     LEFT JOIN app_users u ON u.id = r.user_id
     WHERE r.recovery_status IN ('pending', 'failed')
        OR r.verdict IN ('UNHEALTHY', 'UNRECOVERABLE')
     ORDER BY
       CASE r.verdict WHEN 'UNRECOVERABLE' THEN 1 WHEN 'UNHEALTHY' THEN 2 WHEN 'DEGRADED' THEN 3 ELSE 4 END,
       r.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
};

// ── Loop detection history ───────────────────────────────────────────────────

const getLoopHistory = async ({ userId = null, sessionUuid = null, limit = 10 } = {}) => {
  const args = [];
  let where = 'WHERE loop_signature IS NOT NULL';

  if (userId !== null) {
    args.push(userId);
    where += ` AND user_id = $${args.length}`;
  }
  if (sessionUuid) {
    args.push(sessionUuid);
    where += ` AND session_uuid = $${args.length}`;
  }
  args.push(limit);

  const { rows } = await pool.query(
    `SELECT id, event_type, loop_signature, loop_count, loop_decision_keys,
            verdict, recovery_status, detected_at
     FROM wallt_recovery_events
     ${where}
     ORDER BY loop_count DESC, detected_at DESC
     LIMIT $${args.length}`,
    args
  );
  return rows;
};

// ── Aggregate stats for admin panel ─────────────────────────────────────────

const getRecoveryStats = async ({ days = 30 } = {}) => {
  const [byType, byStatus, recent] = await Promise.all([
    pool.query(`
      SELECT event_type,
             COUNT(*)       AS event_count,
             AVG(memory_usage_mb::numeric) AS avg_memory_mb
      FROM wallt_recovery_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY event_type
      ORDER BY event_count DESC
    `, [days]),

    pool.query(`
      SELECT recovery_status,
             COUNT(*) AS count,
             COUNT(CASE WHEN verdict = 'UNRECOVERABLE' THEN 1 END) AS unrecoverable_count
      FROM wallt_recovery_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY recovery_status
    `, [days]),

    pool.query(`
      SELECT DATE(detected_at) AS day,
             COUNT(*)          AS event_count,
             COUNT(CASE WHEN recovery_status = 'success' THEN 1 END) AS success_count,
             COUNT(CASE WHEN recovery_status = 'escalated' THEN 1 END) AS escalated_count,
             AVG(memory_usage_mb::numeric) AS avg_memory_mb
      FROM wallt_recovery_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY 1 ORDER BY 1 DESC
    `, [days]),
  ]);

  const statusMap = {};
  byStatus.rows.forEach(r => { statusMap[r.recovery_status] = {
    count: parseInt(r.count, 10),
    unrecoverable: parseInt(r.unrecoverable_count, 10),
  }; });

  return {
    byEventType: byType.rows.map(r => ({
      eventType:    r.event_type,
      eventCount:  parseInt(r.event_count, 10),
      avgMemoryMb: parseFloat(r.avg_memory_mb || 0),
    })),
    byStatus:     statusMap,
    dailyTrend:    recent.rows.map(r => ({
      day:            r.day,
      eventCount:     parseInt(r.event_count, 10),
      successCount:   parseInt(r.success_count, 10),
      escalatedCount: parseInt(r.escalated_count, 10),
      avgMemoryMb:    parseFloat(r.avg_memory_mb || 0),
    })),
  };
};

// ── Upsert loop event (idempotent — avoid duplicate loops within window) ──────

const getRecentLoopSignature = async (loopSignature, windowMs = 60000) => {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const { rows } = await pool.query(
    `SELECT id, loop_count, verdict, recovery_status, detected_at
     FROM wallt_recovery_events
     WHERE loop_signature = $1
       AND detected_at > $2::timestamptz
     ORDER BY detected_at DESC
     LIMIT 1`,
    [loopSignature, cutoff]
  );
  return rows[0] || null;
};

const bumpLoopCount = async (existingId, loopCount) => {
  const { rows } = await pool.query(
    `UPDATE wallt_recovery_events
     SET loop_count = $2,
         recovery_completed_at = NOW(),
         verdict = CASE WHEN $2 >= 5 THEN 'UNHEALTHY' ELSE 'DEGRADED' END,
         verdict_reason = $3
     WHERE id = $1
     RETURNING *`,
    [existingId, loopCount,
     `Loop count ${loopCount} reached — auto-escalation threshold`]
  );
  return rows[0];
};

module.exports = {
  logRecoveryEvent,
  getRecoveryEvents,
  getRecoveryEventById,
  updateRecoveryStatus,
  getActiveEvents,
  getLoopHistory,
  getRecoveryStats,
  getRecentLoopSignature,
  bumpLoopCount,
};