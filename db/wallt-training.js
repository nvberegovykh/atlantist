/**
 * Owns: wallt_training_* tables — Nikita's Personal Training Room.
 * Does NOT own: Wallt AI calls, personality engine, main wallt_conversations.
 */
const pool = require('./index');

// ── Scope Configs ────────────────────────────────────────────────────────────

const getScopeConfig = async (ownerUserId, configKey) => {
  const { rows } = await pool.query(
    `SELECT config_value, created_at FROM wallt_scope_configs
     WHERE owner_user_id = $1 AND config_key = $2
     ORDER BY created_at DESC LIMIT 1`,
    [ownerUserId, configKey]
  );
  return rows[0] || null;
};

const upsertScopeConfig = async (ownerUserId, configKey, configValue, changeReason) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_scope_configs (owner_user_id, config_key, config_value, change_reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [ownerUserId, configKey, configValue, changeReason || null]
  );
  return rows[0];
};

const listScopeConfigs = async (ownerUserId) => {
  // Latest value per key
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (config_key) config_key, config_value, change_reason, created_at
     FROM wallt_scope_configs
     WHERE owner_user_id = $1
     ORDER BY config_key, created_at DESC`,
    [ownerUserId]
  );
  return rows;
};

const getScopeHistory = async (ownerUserId, configKey, limit = 20) => {
  const { rows } = await pool.query(
    `SELECT config_value, change_reason, created_at
     FROM wallt_scope_configs
     WHERE owner_user_id = $1 AND config_key = $2
     ORDER BY created_at DESC LIMIT $3`,
    [ownerUserId, configKey, limit]
  );
  return rows;
};

// ── Training Memory ───────────────────────────────────────────────────────────

const getActiveMemory = async (ownerUserId) => {
  const { rows } = await pool.query(
    `SELECT memory_key, memory_value, source, confidence, updated_at
     FROM wallt_training_memory
     WHERE owner_user_id = $1 AND is_active = TRUE
     ORDER BY created_at DESC`,
    [ownerUserId]
  );
  return rows;
};

const upsertMemory = async (ownerUserId, memoryKey, memoryValue, source = 'training', confidence = 'high') => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_training_memory (owner_user_id, memory_key, memory_value, source, confidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_user_id, memory_key) WHERE is_active = TRUE
     DO UPDATE SET memory_value = $3, updated_at = NOW()
     RETURNING id, created_at, updated_at`,
    [ownerUserId, memoryKey, JSON.stringify(memoryValue), source, confidence]
  );
  return rows[0];
};

const deactivateMemory = async (ownerUserId, memoryKey) => {
  await pool.query(
    `UPDATE wallt_training_memory SET is_active = FALSE, updated_at = NOW()
     WHERE owner_user_id = $1 AND memory_key = $2 AND is_active = TRUE`,
    [ownerUserId, memoryKey]
  );
};

const listMemoryKeys = async (ownerUserId) => {
  const { rows } = await pool.query(
    `SELECT memory_key, memory_value, source, confidence, updated_at
     FROM wallt_training_memory
     WHERE owner_user_id = $1 AND is_active = TRUE
     ORDER BY memory_key`,
    [ownerUserId]
  );
  return rows;
};

// ── Training Sessions ──────────────────────────────────────────────────────────

const startTrainingSession = async (ownerUserId) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_training_sessions (owner_user_id)
     VALUES ($1) RETURNING *`,
    [ownerUserId]
  );
  return rows[0];
};

const endTrainingSession = async (sessionId, summary, topics) => {
  await pool.query(
    `UPDATE wallt_training_sessions
     SET session_ended_at = NOW(), summary = $2, topics_touched = $3, is_closed = TRUE
     WHERE id = $1`,
    [sessionId, summary || null, topics || null]
  );
};

const addTrainingTurn = async (sessionId, turnIndex, role, content, memoryUpdated = false) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_training_turns (session_id, turn_index, role, content, memory_updated)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [sessionId, turnIndex, role, content, memoryUpdated]
  );
  return rows[0];
};

const getSessionTranscript = async (sessionId) => {
  const { rows } = await pool.query(
    `SELECT turn_index, role, content, memory_updated, created_at
     FROM wallt_training_turns
     WHERE session_id = $1
     ORDER BY turn_index ASC`,
    [sessionId]
  );
  return rows;
};

const listTrainingSessions = async (ownerUserId, limit = 20) => {
  const { rows } = await pool.query(
    `SELECT id, session_started_at, session_ended_at, summary, topics_touched, is_closed
     FROM wallt_training_sessions
     WHERE owner_user_id = $1
     ORDER BY session_started_at DESC LIMIT $2`,
    [ownerUserId, limit]
  );
  return rows;
};

const getOpenSession = async (ownerUserId) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_training_sessions
     WHERE owner_user_id = $1 AND is_closed = FALSE
     ORDER BY session_started_at DESC LIMIT 1`,
    [ownerUserId]
  );
  return rows[0] || null;
};

// ── Kill Switch ────────────────────────────────────────────────────────────────

const logKillSwitchStop = async (ownerUserId, reason, stateSnapshotId = null) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_kill_switch_log (owner_user_id, reason, state_snapshot_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [ownerUserId, reason || null, stateSnapshotId]
  );
  return rows[0];
};

const logKillSwitchResume = async (killLogId, how, notes) => {
  await pool.query(
    `UPDATE wallt_kill_switch_log
     SET resumed_at = NOW(), how_resumed = $2, notes = $3
     WHERE id = $1`,
    [killLogId, how, notes || null]
  );
};

const getKillSwitchHistory = async (ownerUserId, limit = 20) => {
  const { rows } = await pool.query(
    `SELECT k.id, k.stopped_at, k.reason, k.resumed_at, k.how_resumed, k.notes,
            c.checkpoint_type, c.label as checkpoint_label
     FROM wallt_kill_switch_log k
     LEFT JOIN wallt_state_checkpoints c ON k.state_snapshot_id = c.id
     WHERE k.owner_user_id = $1
     ORDER BY k.stopped_at DESC LIMIT $2`,
    [ownerUserId, limit]
  );
  return rows;
};

const isWalltFrozen = async (ownerUserId) => {
  const { rows } = await pool.query(
    `SELECT id FROM wallt_kill_switch_log
     WHERE owner_user_id = $1 AND resumed_at IS NULL
     ORDER BY stopped_at DESC LIMIT 1`,
    [ownerUserId]
  );
  return rows[0] || null;
};

const getWalltFrozenState = async (ownerUserId) => {
  // Returns the freeze record if Wallt is currently stopped
  const { rows } = await pool.query(
    `SELECT k.id, k.stopped_at, k.reason, k.notes,
            c.checkpoint_type, c.label as checkpoint_label, c.checkpoint_data
     FROM wallt_kill_switch_log k
     LEFT JOIN wallt_state_checkpoints c ON k.state_snapshot_id = c.id
     WHERE k.owner_user_id = $1 AND k.resumed_at IS NULL
     ORDER BY k.stopped_at DESC LIMIT 1`,
    [ownerUserId]
  );
  return rows[0] || null;
};

// ── State Checkpoints ─────────────────────────────────────────────────────────

const createCheckpoint = async (ownerUserId, checkpointType, label, checkpointData, version) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_state_checkpoints (owner_user_id, checkpoint_type, label, checkpoint_data, wallt_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ownerUserId, checkpointType, label || null, checkpointData, version || null]
  );
  return rows[0];
};

const listCheckpoints = async (ownerUserId, limit = 30) => {
  const { rows } = await pool.query(
    `SELECT id, checkpoint_type, label, wallt_version, created_at
     FROM wallt_state_checkpoints
     WHERE owner_user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [ownerUserId, limit]
  );
  return rows;
};

const getCheckpointById = async (checkpointId) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_state_checkpoints WHERE id = $1`, [checkpointId]
  );
  return rows[0] || null;
};

const deleteCheckpoint = async (ownerUserId, checkpointId) => {
  const { rows } = await pool.query(
    `DELETE FROM wallt_state_checkpoints
     WHERE id = $1 AND owner_user_id = $2 RETURNING id`,
    [checkpointId, ownerUserId]
  );
  return rows[0];
};

// ── Boundary Events ───────────────────────────────────────────────────────────

const logBoundaryEvent = async (ownerUserId, eventType, description, severity = 'low') => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_boundary_events (owner_user_id, event_type, description, severity)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ownerUserId, eventType, description, severity]
  );
  return rows[0];
};

const listBoundaryEvents = async (ownerUserId, limit = 50) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_boundary_events
     WHERE owner_user_id = $1
     ORDER BY detected_at DESC LIMIT $2`,
    [ownerUserId, limit]
  );
  return rows;
};

const resolveBoundaryEvent = async (ownerUserId, eventId, notes) => {
  await pool.query(
    `UPDATE wallt_boundary_events
     SET resolved = TRUE, resolution_notes = $3
     WHERE id = $1 AND owner_user_id = $2`,
    [eventId, ownerUserId]
  );
};

// ── Live Telemetry ─────────────────────────────────────────────────────────────

const getTrainingStats = async (ownerUserId) => {
  const [memory, sessions, killEvents, checkpoints, boundaryEvents] = await Promise.all([
    pool.query(`SELECT COUNT(*) as cnt FROM wallt_training_memory WHERE owner_user_id = $1 AND is_active = TRUE`, [ownerUserId]),
    pool.query(`SELECT COUNT(*) as cnt FROM wallt_training_sessions WHERE owner_user_id = $1`, [ownerUserId]),
    pool.query(`SELECT COUNT(*) as cnt FROM wallt_kill_switch_log WHERE owner_user_id = $1`, [ownerUserId]),
    pool.query(`SELECT COUNT(*) as cnt FROM wallt_state_checkpoints WHERE owner_user_id = $1`, [ownerUserId]),
    pool.query(`SELECT COUNT(*) as cnt FROM wallt_boundary_events WHERE owner_user_id = $1`, [ownerUserId]),
  ]);
  return {
    activeMemoryEntries: parseInt(memory.rows[0].cnt, 10),
    totalSessions: parseInt(sessions.rows[0].cnt, 10),
    killSwitchEvents: parseInt(killEvents.rows[0].cnt, 10),
    checkpoints: parseInt(checkpoints.rows[0].cnt, 10),
    boundaryEvents: parseInt(boundaryEvents.rows[0].cnt, 10),
  };
};

module.exports = {
  getScopeConfig, upsertScopeConfig, listScopeConfigs, getScopeHistory,
  getActiveMemory, upsertMemory, deactivateMemory, listMemoryKeys,
  startTrainingSession, endTrainingSession, addTrainingTurn, getSessionTranscript, listTrainingSessions, getOpenSession,
  logKillSwitchStop, logKillSwitchResume, getKillSwitchHistory, isWalltFrozen, getWalltFrozenState,
  createCheckpoint, listCheckpoints, getCheckpointById, deleteCheckpoint,
  logBoundaryEvent, listBoundaryEvents, resolveBoundaryEvent,
  getTrainingStats,
};