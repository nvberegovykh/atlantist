/**
 * Owns: Wallt Admin Panel — DB queries for the /app/wallt/admin monitoring dashboard.
 * Does NOT own: UI, API routing, WebSocket server, Wallt AI logic.
 *
 * Data sources:
 *   wallt_core_institutional_mem — graph node count, is_hot, last_accessed_at
 *   wallt_conversations           — active session count (updated < 30min ago)
 *   wallt_core_archive            — archive record count + total bytes
 *   wallt_core_decision_log       — recent AI decisions (all users, admin view)
 *   wallt_core_conflict_log       — conflict history for moral drift scoring
 *   wallt_core_escalation_log     — pending/responded escalations
 *   legal_engine_check_log         — compliance audit trail, active codes
 *   wallt_memory_archive_log      — self-deploy archive job history
 *   app_events                    — wallt-specific deploy/events log
 */
const pool = require('./index');

// ── Panel 1: Memory Status ────────────────────────────────────────────────

const getMemoryStats = async () => {
  const [
    instResult,
    convResult,
    archiveResult,
    cacheResult,
  ] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)                          AS total_nodes,
        COUNT(CASE WHEN is_hot = TRUE    THEN 1 END) AS hot_nodes,
        COUNT(CASE WHEN is_hot = FALSE   THEN 1 END) AS cold_nodes,
        COUNT(DISTINCT category)         AS category_count,
        MAX(last_accessed_at)            AS last_accessed,
        MAX(updated_at)                  AS last_updated
      FROM wallt_core_institutional_mem
    `),
    pool.query(`
      SELECT COUNT(*) AS active_sessions
      FROM wallt_conversations
      WHERE updated_at > NOW() - INTERVAL '30 minutes'
        AND is_archived = FALSE
    `),
    pool.query(`
      SELECT
        COUNT(*)                      AS archive_count,
        pg_size_pretty(SUM(pg_column_size(archived_record))) AS archive_size_pretty,
        MAX(archived_at)              AS last_archived
      FROM wallt_core_archive
    `),
    pool.query(`SELECT COUNT(*) AS cached_entries FROM cache WHERE key LIKE 'wallt:core:%'`),
  ]);

  return {
    totalNodes:     parseInt(instResult.rows[0].total_nodes, 10),
    hotNodes:       parseInt(instResult.rows[0].hot_nodes, 10),
    coldNodes:      parseInt(instResult.rows[0].cold_nodes, 10),
    categoryCount:  parseInt(instResult.rows[0].category_count, 10),
    lastAccessed:   instResult.rows[0].last_accessed,
    lastUpdated:    instResult.rows[0].last_updated,
    activeSessions: parseInt(convResult.rows[0].active_sessions, 10),
    archiveCount:   parseInt(archiveResult.rows[0].archive_count, 10),
    archiveSize:   archiveResult.rows[0].archive_size_pretty,
    lastArchived:   archiveResult.rows[0].last_archived,
    cachedEntries:  parseInt(cacheResult.rows[0].cached_entries, 10),
  };
};

// ── Panel 2: Active Decisions ────────────────────────────────────────────

const getActiveDecisions = async ({ limit = 30 } = {}) => {
  const { rows } = await pool.query(`
    SELECT
      d.id, d.user_id, d.decision_key, d.decision_type,
      d.reasoning_chain, d.outcome, d.outcome_note,
      d.confidence_score, d.persist_to_core, d.created_at,
      u.email AS user_email
    FROM wallt_core_decision_log d
    LEFT JOIN app_users u ON u.id = d.user_id
    ORDER BY d.created_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
};

// ── Panel 3: Moral Drift Score ────────────────────────────────────────────

const getMoralDriftScore = async () => {
  // Score = rolling weighted average of recent conflict intensity + refusal rate
  const { rows } = await pool.query(`
    SELECT
      DATE_TRUNC('day', created_at) AS day,
      COUNT(*)                      AS total_decisions,
      COUNT(CASE WHEN outcome = 'reversed' THEN 1 END) AS reversed,
      COUNT(CASE WHEN confidence_score < 0.5 THEN 1 END) AS low_confidence,
      COUNT(CASE WHEN persist_to_core = FALSE THEN 1 END) AS non_persisted
    FROM wallt_core_decision_log
    WHERE created_at > NOW() - INTERVAL '14 days'
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 14
  `);

  const { rows: conflictRows } = await pool.query(`
    SELECT
      DATE_TRUNC('day', created_at) AS day,
      COUNT(*)                      AS conflict_count,
      COUNT(CASE WHEN resolution IS NOT NULL THEN 1 END) AS resolved
    FROM wallt_core_conflict_log
    WHERE created_at > NOW() - INTERVAL '14 days'
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 14
  `);

  // Compute drift score: 0-100, 100 = concerning drift
  const dayCount = rows.length || 1;
  const totalReversed = rows.reduce((s, r) => s + parseInt(r.reversed, 10), 0);
  const totalLowConf  = rows.reduce((s, r) => s + parseInt(r.low_confidence, 0), 0);
  const totalDecisions = rows.reduce((s, r) => s + parseInt(r.total_decisions, 10), 0) || 1;
  const totalConflicts = conflictRows.reduce((s, r) => s + parseInt(r.conflict_count, 10), 0);

  const reversalRate  = totalReversed / totalDecisions;
  const lowConfRate   = totalLowConf / totalDecisions;
  const conflictRate  = totalConflicts / dayCount / 10; // normalize
  const score = Math.min(100, Math.round((reversalRate * 50) + (lowConfRate * 30) + (conflictRate * 20)));

  const verdict = score < 20 ? 'STABLE'
                : score < 50 ? 'WATCHING'
                : score < 75 ? 'DRIFTING'
                : 'CRITICAL';

  return {
    score,
    verdict,
    history: rows.map(r => ({
      day:            r.day,
      totalDecisions: parseInt(r.total_decisions, 10),
      reversed:        parseInt(r.reversed, 10),
      lowConfidence:  parseInt(r.low_confidence, 0),
      conflicts:      parseInt(conflictRows.find(c => c.day === r.day)?.conflict_count || '0', 10),
    })),
  };
};

// ── Panel 4: Escalation Queue ─────────────────────────────────────────────

const getEscalationQueue = async ({ status = null } = {}) => {
  const where = status ? `WHERE status = $2` : '';
  const args  = status ? [limit, status] : [limit];
  const { rows } = await pool.query(`
    SELECT
      e.id, e.subject, e.body, e.reason, e.priority,
      e.status, e.created_at, e.polsia_response, e.polsia_response_at,
      u.email AS user_email
    FROM wallt_core_escalation_log e
    LEFT JOIN app_users u ON u.id = e.user_id
    ${where}
    ORDER BY
      CASE e.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      e.created_at DESC
    LIMIT $1
  `, args);
  return rows;
};

const resolveEscalation = async (escalationId, response) => {
  const { rows } = await pool.query(`
    UPDATE wallt_core_escalation_log
    SET polsia_response = $2, polsia_response_at = NOW(), status = 'responded'
    WHERE id = $1 RETURNING *
  `, [escalationId, response]);
  return rows[0];
};

// ── Panel 5: Legal Compliance Status ──────────────────────────────────────

const getLegalComplianceStatus = async () => {
  const { rows: checkRows } = await pool.query(`
    SELECT
      action_type,
      verdict,
      created_at,
      id,
      proposed_fix
    FROM legal_engine_check_log
    ORDER BY created_at DESC
    LIMIT 50
  `);

  // Aggregate: active codes = distinct action_types with recent non-compliant verdicts
  const { rows: recentCodes } = await pool.query(`
    SELECT DISTINCT ON (action_type)
      action_type,
      verdict,
      created_at,
      id
    FROM legal_engine_check_log
    WHERE created_at > NOW() - INTERVAL '7 days'
    ORDER BY action_type, created_at DESC
  `);

  const compliantCount    = recentCodes.filter(r => r.verdict === 'COMPLIANT').length;
  const nonCompliantCount = recentCodes.filter(r => r.verdict === 'NON_COMPLIANT').length;
  const ambiguousCount     = recentCodes.filter(r => r.verdict === 'AMBIGUOUS').length;

  const { rows: lastAudit } = await pool.query(`
    SELECT MAX(created_at) AS last_audit_at, COUNT(*) AS total_checks_7d
    FROM legal_engine_check_log
    WHERE created_at > NOW() - INTERVAL '7 days'
  `);

  return {
    activeCodes:    recentCodes.map(r => ({ code: r.action_type, verdict: r.verdict, lastChecked: r.created_at })),
    compliantCount,
    nonCompliantCount,
    ambiguousCount,
    totalChecks7d:  parseInt(lastAudit[0].total_checks_7d || '0', 10),
    lastAuditAt:    lastAudit[0].last_audit_at,
    recentChecks:   checkRows.slice(0, 20),
  };
};

// ── Panel 6: Self-Deploy Log ──────────────────────────────────────────────

const getSelfDeployLog = async ({ limit = 30 } = {}) => {
  // app_events with event_name LIKE 'wallt:%' or 'deploy:%'
  const { rows: walltEvents } = await pool.query(`
    SELECT
      id, event_name, metadata_json, created_at, user_id
    FROM app_events
    WHERE event_name LIKE 'wallt:%'
       OR event_name LIKE 'deploy:%'
       OR event_name LIKE 'wallt-admin:%'
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  // wallt memory archive log
  const { rows: archiveLogs } = await pool.query(`
    SELECT
      id, archived_count, purged_count, evicted_count,
      cache_size_bytes, created_at, archived_table
    FROM wallt_memory_archive_log
    ORDER BY created_at DESC
    LIMIT 20
  `);

  return { walltEvents, archiveLogs };
};

// ── Section 1: Concern / Escalation Log ─────────────────────────────────
// Filterable by date range, type (moral/legal/both), resolution status.
// Each entry: timestamp, Wallt reasoning chain, wav player, Polsia eval, resolution.
// Status badges: PENDING / APPROVED / REFUSED / RECORRECTED.
const getConcernLog = async ({
  startDate   = null,
  endDate     = null,
  concernType = null,  // 'moral' | 'legal' | 'both'
  status      = null,  // 'pending' | 'responded' | 'approved' | 'refused' | 'recorrected'
  limit       = 50,
} = {}) => {
  const args = [];
  const conditions = [];

  if (startDate) {
    args.push(startDate);
    conditions.push(`e.created_at >= $${args.length}`);
  }
  if (endDate) {
    args.push(endDate);
    conditions.push(`e.created_at <= $${args.length}`);
  }
  if (concernType === 'moral') {
    conditions.push(`e.escalation_type = 'moral_drift'`);
  } else if (concernType === 'legal') {
    conditions.push(`e.escalation_type = 'legal_uncertainty'`);
  }
  // 'both' = include both moral and legal
  if (status) {
    args.push(status);
    conditions.push(`e.status = $${args.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  args.push(limit);

  const { rows } = await pool.query(`
    SELECT
      e.id,
      e.escalation_type,
      e.subject,
      e.body,
      e.wallt_recommendation,
      e.polsia_response,
      e.polsia_response_at,
      e.status,
      e.priority,
      e.trigger_source,
      e.created_at,
      e.audio_file_ref,
      e.resolution_action,
      u.email AS user_email
    FROM wallt_core_escalation_log e
    LEFT JOIN app_users u ON u.id = e.user_id
    ${where}
    ORDER BY e.created_at DESC
    LIMIT $${args.length}
  `, args);

  return rows;
};

const resolveConcern = async (escalationId, resolution, resolvedByUserId) => {
  const valid = ['approved', 'refused', 'recorrected', 'acknowledged'];
  const res = valid.includes(resolution) ? resolution : 'acknowledged';
  const { rows } = await pool.query(`
    UPDATE wallt_core_escalation_log
    SET status             = 'responded',
        polsia_response   = $3,
        polsia_response_at = NOW(),
        resolved_by        = $2,
        resolution_action  = $4
    WHERE id = $1 RETURNING *
  `, [escalationId, resolvedByUserId, resolution, res]);
  return rows[0] || null;
};

// ── Section 2: Audio Composition Library ─────────────────────────────────
// Admin-only asset library — not published externally.
// Filter by: date, concern type, rights breakdown completeness.
const getAudioCatalogAdmin = async ({
  startDate   = null,
  endDate     = null,
  concernType = null,
  rightsComplete = null,  // true = rights_breakdown_json has all 3 keys
  limit       = 50,
  offset      = 0,
} = {}) => {
  const args = [];
  const conditions = [];

  if (startDate) {
    args.push(startDate);
    conditions.push(`a.created_at >= $${args.length}`);
  }
  if (endDate) {
    args.push(endDate);
    conditions.push(`a.created_at <= $${args.length}`);
  }
  if (concernType) {
    args.push(concernType);
    conditions.push(`$${args.length} = ANY(a.tags)`);
  }
  if (rightsComplete === true) {
    conditions.push(
      `a.rights_breakdown_json ? 'original' AND a.rights_breakdown_json ? 'licensed' AND a.rights_breakdown_json ? 'generated'`
    );
  } else if (rightsComplete === false) {
    conditions.push(
      `NOT (a.rights_breakdown_json ? 'original' AND a.rights_breakdown_json ? 'licensed' AND a.rights_breakdown_json ? 'generated')`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  args.push(limit, offset);

  const { rows } = await pool.query(`
    SELECT
      a.id, a.user_id, a.file_name, a.file_path,
      a.rights_breakdown_json, a.duration_seconds, a.sample_rate_hz,
      a.format, a.tags, a.metadata_json, a.created_at,
      u.email AS uploader_email
    FROM wallt_core_audio_catalog a
    LEFT JOIN app_users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT $${args.length - 1} OFFSET $${args.length}
  `, args);

  // Total count for pagination
  const countArgs = args.slice(0, -2);
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS total FROM wallt_core_audio_catalog a ${where}`,
    countArgs
  );

  return { tracks: rows, total: parseInt(countRows[0].total, 10) };
};

const getAudioById = async (id) => {
  const { rows } = await pool.query(
    `SELECT a.*, u.email AS uploader_email
     FROM wallt_core_audio_catalog a
     LEFT JOIN app_users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [id]
  );
  return rows[0] || null;
};

// ── Section 3: Wallt Health Status ─────────────────────────────────────
// Live: ONLINE/DEGRADED/OFFLINE/ERROR, last check, active sessions, recovery attempts.
const getWalltHealthStatus = async () => {
  const { getSystemHealth } = require('../services/wallt-auto-recovery');
  const health = await getSystemHealth();

  // Active session count from conversations updated in last 30 min
  const { rows: sessionRows } = await pool.query(`
    SELECT COUNT(*) AS active_sessions
    FROM wallt_conversations
    WHERE updated_at > NOW() - INTERVAL '30 minutes'
      AND is_archived = FALSE
  `);

  // Recovery attempts: current session (in_flight) + all-time recent
  const { rows: recoveryRows } = await pool.query(`
    SELECT COUNT(*) AS recovery_attempts
    FROM wallt_recovery_events
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);

  // Last 10 errors
  const { rows: errorRows } = await pool.query(`
    SELECT id, event_type, detected_condition_json, recovery_action, verdict, created_at
    FROM wallt_recovery_events
    WHERE verdict IN ('UNHEALTHY', 'UNRECOVERABLE', 'failed')
    ORDER BY created_at DESC
    LIMIT 10
  `);

  const statusMap = {
    HEALTHY:   'ONLINE',
    DEGRADED:  'DEGRADED',
    UNHEALTHY: 'OFFLINE',
  };
  const liveStatus = statusMap[health.status] || 'ERROR';

  return {
    status:                liveStatus,
    health_status_raw:     health.status,
    last_check:            new Date().toISOString(),
    active_sessions:       parseInt(sessionRows[0].active_sessions, 10),
    in_flight_calls:       health.in_flight_calls,
    recovery_attempts_24h: parseInt(recoveryRows[0].recovery_attempts, 10),
    errors:                errorRows.map(e => ({
      id:                  e.id,
      event_type:          e.event_type,
      detected_condition:  e.detected_condition_json,
      recovery_action:    e.recovery_action,
      verdict:             e.verdict,
      created_at:          e.created_at,
    })),
    memory:                health.memory,
    thresholds:            health.thresholds,
  };
};

// ── Section 5: Detailed Memory Status ────────────────────────────────────
// Session memory (size, TTL), Core memory (records, cleanup), Archive status.
const getMemoryDetailed = async () => {
  const [inst, conv, archive, cache, archiveLog] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)                            AS total_nodes,
        COUNT(CASE WHEN is_hot = TRUE  THEN 1 END) AS hot_nodes,
        COUNT(CASE WHEN is_hot = FALSE THEN 1 END) AS cold_nodes,
        MAX(last_accessed_at)              AS last_accessed,
        MAX(updated_at)                    AS last_updated,
        pg_size_pretty(SUM(pg_column_size(content))) AS content_size
      FROM wallt_core_institutional_mem
    `),
    pool.query(`
      SELECT
        COUNT(*)                       AS total_conversations,
        COUNT(CASE WHEN is_archived = FALSE AND updated_at > NOW() - INTERVAL '30 minutes'
          THEN 1 END)                   AS active_sessions,
        MAX(updated_at)                 AS last_session_update
      FROM wallt_conversations
    `),
    pool.query(`
      SELECT
        COUNT(*)                      AS archived_records,
        pg_size_pretty(SUM(pg_column_size(archived_record))) AS archived_size,
        MIN(archived_at)              AS oldest_record,
        MAX(archived_at)              AS newest_record
      FROM wallt_core_archive
    `),
    pool.query(`
      SELECT
        COUNT(*)                       AS total_entries,
        MAX(last_accessed_at)          AS last_accessed,
        SUM(pg_column_size(content))   AS total_content_bytes
      FROM wallt_memory
    `),
    pool.query(`
      SELECT
        MAX(run_at)            AS last_cleanup,
        MAX(next_scheduled_at) AS next_cleanup
      FROM wallt_memory_archive_log
    `),
  ]);

  return {
    session: {
      active_sessions:    parseInt(conv.rows[0].active_sessions, 10),
      total_conversations: parseInt(conv.rows[0].total_conversations, 10),
      last_update:        conv.rows[0].last_session_update,
    },
    core: {
      total_nodes:       parseInt(inst.rows[0].total_nodes, 10),
      hot_nodes:         parseInt(inst.rows[0].hot_nodes, 10),
      cold_nodes:        parseInt(inst.rows[0].cold_nodes, 10),
      last_accessed:     inst.rows[0].last_accessed,
      last_updated:      inst.rows[0].last_updated,
      content_size:      inst.rows[0].content_size || '0 B',
    },
    semantic: {
      total_entries:    parseInt(cache.rows[0].total_entries, 10),
      content_bytes:    parseInt(cache.rows[0].total_content_bytes || '0', 10),
      last_accessed:    cache.rows[0].last_accessed,
    },
    archive: {
      records_archived: parseInt(archive.rows[0].archived_records, 10),
      archived_size:   archive.rows[0].archived_size || '0 B',
      oldest_record:   archive.rows[0].oldest_record,
      newest_record:   archive.rows[0].newest_record,
      next_cleanup:    archiveLog.rows[0].next_cleanup,
    },
    cleanup: {
      last_cleanup: archiveLog.rows[0].last_cleanup,
    },
  };
};

module.exports = {
  getMemoryStats,
  getActiveDecisions,
  getMoralDriftScore,
  getEscalationQueue,
  resolveEscalation,
  getLegalComplianceStatus,
  getSelfDeployLog,
  // Section 1 — Concern / Escalation Log
  getConcernLog,
  resolveConcern,
  // Section 2 — Audio Library
  getAudioCatalogAdmin,
  getAudioById,
  // Section 3 — Health Status
  getWalltHealthStatus,
  // Section 5 — Memory Status (detailed)
  getMemoryDetailed,
};