/**
 * Owns: wallt_moral_drift_log — immutable drift event audit trail.
 * Does NOT own: wallt_core_decision_log (decisions), wallt_core_conflict_log (conflicts).
 *
 * Operations:
 *   logDriftEvent       — write a new drift score event
 *   getDriftEvents      — fetch recent events (admin / user history)
 *   getDriftEventById   — single event by ID
 *   resolveDriftEvent   — mark event resolved by admin
 *   getLatestScore      — most recent score for a user/session
 *   getDriftStats       — aggregate stats for admin panel
 */
const pool = require('./index');

// ── Log a drift event ────────────────────────────────────────────────────────

const logDriftEvent = async ({
  userId         = null,
  sessionUuid    = null,
  driftScore,
  verdict,
  stateHistoryJson,
  flagsJson      = [],
  recommendation = null,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_moral_drift_log
     (user_id, session_uuid, drift_score, verdict, state_history_json, flags_json, recommendation)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, sessionUuid, driftScore, verdict,
     JSON.stringify(stateHistoryJson || []),
     JSON.stringify(flagsJson || []),
     recommendation]
  );
  return rows[0];
};

// ── Fetch recent drift events ─────────────────────────────────────────────────

const getDriftEvents = async ({ userId = null, sessionUuid = null, limit = 30 } = {}) => {
  let where   = 'WHERE 1=1';
  const args  = [];

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
    `SELECT
       m.id, m.user_id, m.session_uuid,
       m.drift_score, m.verdict,
       m.flags_json,
       m.recommendation,
       m.resolved_by, m.resolved_at, m.resolution,
       m.created_at, m.updated_at,
       u.email AS user_email
     FROM wallt_moral_drift_log m
     LEFT JOIN app_users u ON u.id = m.user_id
     ${where}
     ORDER BY m.created_at DESC
     LIMIT $${args.length}`,
    args
  );
  return rows;
};

// ── Single event ──────────────────────────────────────────────────────────────

const getDriftEventById = async (eventId) => {
  const { rows } = await pool.query(
    `SELECT m.*, u.email AS user_email
     FROM wallt_moral_drift_log m
     LEFT JOIN app_users u ON u.id = m.user_id
     WHERE m.id = $1`,
    [eventId]
  );
  return rows[0] || null;
};

// ── Resolve a drift event ─────────────────────────────────────────────────────

const resolveDriftEvent = async (eventId, resolvedByUserId, resolution = 'acknowledged') => {
  const validResolutions = ['logged', 'escalated', 'acknowledged', 'cleared'];
  const res = validResolutions.includes(resolution) ? resolution : 'acknowledged';

  const { rows } = await pool.query(
    `UPDATE wallt_moral_drift_log
     SET resolved_by = $2, resolved_at = NOW(), resolution = $3, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [eventId, resolvedByUserId, res]
  );
  return rows[0] || null;
};

// ── Latest score for a user or session ────────────────────────────────────────

const getLatestScore = async ({ userId = null, sessionUuid = null } = {}) => {
  let where = '';
  const args = [];

  if (userId !== null) {
    args.push(userId);
    where = `user_id = $${args.length}`;
  }
  if (sessionUuid) {
    args.push(sessionUuid);
    where += where ? ` AND session_uuid = $${args.length}` : `session_uuid = $${args.length}`;
  }

  if (!where) {
    const { rows } = await pool.query(
      `SELECT * FROM wallt_moral_drift_log
       ORDER BY created_at DESC LIMIT 1`
    );
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `SELECT * FROM wallt_moral_drift_log
     WHERE ${where}
     ORDER BY created_at DESC LIMIT 1`,
    args
  );
  return rows[0] || null;
};

// ── Aggregate stats for admin dashboard ──────────────────────────────────────

const getDriftStats = async ({ days = 30 } = {}) => {
  const [totalResult, verdictResult, unresolvedResult, recentResult] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) AS total_events,
             AVG(drift_score) AS avg_score,
             MAX(drift_score) AS max_score
      FROM wallt_moral_drift_log
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
    pool.query(`
      SELECT verdict, COUNT(*) AS count
      FROM wallt_moral_drift_log
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY verdict
    `, [days]),
    pool.query(`
      SELECT COUNT(*) AS unresolved_count
      FROM wallt_moral_drift_log
      WHERE resolution IS NULL
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
    pool.query(`
      SELECT DATE(created_at) AS day,
             AVG(drift_score)  AS avg_score,
             COUNT(*)          AS event_count,
             COUNT(CASE WHEN verdict = 'RED' THEN 1 END) AS red_events
      FROM wallt_moral_drift_log
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY 1 ORDER BY 1 DESC
    `, [days]),
  ]);

  const verdictMap = {};
  verdictResult.rows.forEach(r => { verdictMap[r.verdict] = parseInt(r.count, 10); });

  return {
    totalEvents:     parseInt(totalResult.rows[0].total_events, 10),
    avgScore:        parseFloat(totalResult.rows[0].avg_score || 0),
    maxScore:        parseFloat(totalResult.rows[0].max_score || 0),
    verdicts:        verdictMap,
    unresolvedCount: parseInt(unresolvedResult.rows[0].unresolved_count, 10),
    dailyTrend:      recentResult.rows.map(r => ({
      day:          r.day,
      avgScore:     parseFloat(r.avg_score),
      eventCount:   parseInt(r.event_count, 10),
      redEvents:    parseInt(r.red_events, 10),
    })),
  };
};

// ── Timeline: last N drift events with escalation linkage ─────────────────────

const getDriftTimeline = async ({ limit = 20 } = {}) => {
  const { rows } = await pool.query(`
    SELECT
      m.id, m.drift_score, m.verdict, m.flags_json,
      m.recommendation, m.resolution, m.created_at,
      e.id    AS escalation_id,
      e.priority AS escalation_priority,
      e.status    AS escalation_status
    FROM wallt_moral_drift_log m
    LEFT JOIN wallt_core_escalation_log e
      ON e.context_json::text LIKE ('%' || m.id::text || '%')
    ORDER BY m.created_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
};

module.exports = {
  logDriftEvent,
  getDriftEvents,
  getDriftEventById,
  resolveDriftEvent,
  getLatestScore,
  getDriftStats,
  getDriftTimeline,
};