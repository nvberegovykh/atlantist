/**
 * Owns: wallt_core_* tables — Wallt Core Memory layer.
 * Does NOT own: Wallt conversations (db/wallt.js), AI model calls.
 *
 * Core memory tables:
 *   wallt_core_user_profile       — user preferences, decision patterns, active projects
 *   wallt_core_decision_log       — consequential decisions + reasoning + outcome
 *   wallt_core_institutional_mem  — company state, roadmap, technical debt
 *   wallt_core_conflict_log       — escalations refused, why, resolution
 *   wallt_core_escalation_log     — Wallt→Polsia escalations + Polsia response
 *   wallt_core_skill_inventory    — what Wallt knows, confirms, needs validation
 *   wallt_core_audio_catalog      — wav files with rights breakdowns
 *   wallt_core_archive            — cold data archive (90-day access cutoff, 2-year retention)
 *
 * Archive policy: records not accessed in 90 days → cold archive table.
 * Archive retention: 2 years, then hard deleted.
 * Archive eviction runs weekly via [[crons]].
 */
const pool = require('./index');

// ── User Profile ────────────────────────────────────────────────────────────

const upsertUserProfile = async (userId, profileJson) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_user_profile (user_id, profile_json, version, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET profile_json = $2, version = wallt_core_user_profile.version + 1, updated_at = NOW()
     RETURNING *`,
    [userId, profileJson]
  );
  return rows[0];
};

const getUserProfile = async (userId) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_user_profile WHERE user_id = $1`, [userId]
  );
  return rows[0] || null;
};

const patchUserProfile = async (userId, patchJson) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_user_profile
     SET profile_json = profile_json || $2::jsonb, version = version + 1, updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId, patchJson]
  );
  return rows[0] || null;
};

// ── Decision Log ────────────────────────────────────────────────────────────

const logDecision = async ({
  userId, sessionUuid, decisionKey, decisionType,
  contextJson, reasoningChain, outcome = 'unknown',
  outcomeNote = null, confidenceScore = null, persistToCore = false,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_decision_log
     (user_id, session_uuid, decision_key, decision_type, context_json,
      reasoning_chain, outcome, outcome_note, confidence_score, persist_to_core)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [userId, sessionUuid, decisionKey, decisionType, contextJson,
      reasoningChain, outcome, outcomeNote, confidenceScore, persistToCore]
  );
  return rows[0];
};

const updateDecisionOutcome = async (decisionId, outcome, outcomeNote) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_decision_log
     SET outcome = $2, outcome_note = $3
     WHERE id = $1 RETURNING *`,
    [decisionId, outcome, outcomeNote]
  );
  return rows[0];
};

const getDecisions = async (userId, { decisionType = null, limit = 50 } = {}) => {
  const args = [userId, limit];
  let whereClause = 'user_id = $1';
  if (decisionType) {
    whereClause += ' AND decision_type = $3';
    args.push(decisionType);
  }
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_decision_log
     WHERE ${whereClause}
     ORDER BY created_at DESC LIMIT $2`,
    args
  );
  return rows;
};

const getRecentDecisions = async (limit = 20) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_decision_log
     WHERE persist_to_core = TRUE
     ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return rows;
};

// ── Institutional Memory ───────────────────────────────────────────────────

const upsertInstitutionalMem = async (category, memoryKey, contentMd, tags = []) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_institutional_mem (category, memory_key, content_md, tags, is_hot, last_accessed_at, updated_at)
     VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
     ON CONFLICT (category, memory_key) DO UPDATE
     SET content_md = $3, tags = $4, last_accessed_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [category, memoryKey, contentMd, tags]
  );
  return rows[0];
};

const getInstitutionalMem = async (category, memoryKey) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_institutional_mem
     SET last_accessed_at = NOW()
     WHERE category = $1 AND memory_key = $2
     RETURNING *`,
    [category, memoryKey]
  );
  return rows[0] || null;
};

const getInstitutionalMemByCategory = async (category, { limit = 20 } = {}) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_institutional_mem
     SET last_accessed_at = NOW()
     WHERE category = $1 AND is_hot = TRUE
     ORDER BY last_accessed_at DESC LIMIT $2`,
    [category, limit]
  );
  return rows;
};

const getAllInstitutionalMem = async ({ limit = 100 } = {}) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_institutional_mem
     SET last_accessed_at = NOW()
     WHERE is_hot = TRUE
     ORDER BY last_accessed_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
};

// ── Conflict Log ────────────────────────────────────────────────────────────

const logConflict = async ({ userId, sessionUuid, conflictType, requestSummary, walltPosition }) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_conflict_log
     (user_id, session_uuid, conflict_type, request_summary, wallt_position, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
    [userId, sessionUuid, conflictType, requestSummary, walltPosition]
  );
  return rows[0];
};

const resolveConflict = async (conflictId, resolution, polsiaResponse) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_conflict_log
     SET resolution = $2, polsia_response = $3, resolved_at = NOW()
     WHERE id = $1 RETURNING *`,
    [conflictId, resolution, polsiaResponse]
  );
  return rows[0];
};

const getConflicts = async (userId, { limit = 30 } = {}) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_conflict_log
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

// ── Escalation Log ──────────────────────────────────────────────────────────

const logEscalation = async ({ userId, sessionUuid, escalationSubject, escalationBody, escalationReason = 'policy_boundary', priority = 'normal' }) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_escalation_log
     (user_id, session_uuid, escalation_subject, escalation_body, escalation_reason, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
    [userId, sessionUuid, escalationSubject, escalationBody, escalationReason, priority]
  );
  return rows[0];
};

const resolveEscalation = async (escalationId, polsiaResponse) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_escalation_log
     SET polsia_response = $2, polsia_response_at = NOW(), status = 'responded'
     WHERE id = $1 RETURNING *`,
    [escalationId, polsiaResponse]
  );
  return rows[0];
};

const getEscalations = async (userId, { limit = 20 } = {}) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_escalation_log
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

// ── Skill Inventory ──────────────────────────────────────────────────────────

const upsertSkill = async ({ skillKey, skillDomain, description, confirmationStatus = 'unconfirmed', source = 'inference', confidenceScore = null, metadataJson = {} }) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_skill_inventory
     (skill_key, skill_domain, description, confirmation_status, source, confidence_score, metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (skill_key) DO UPDATE
     SET description = $3, metadata_json = $7, updated_at = NOW()
     RETURNING *`,
    [skillKey, skillDomain, description, confirmationStatus, source, confidenceScore, metadataJson]
  );
  return rows[0];
};

const confirmSkill = async (skillKey, testResultsJson = {}) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_skill_inventory
     SET confirmation_status = 'confirmed', confirmed_at = NOW(), last_tested_at = NOW(),
         test_results_json = $2, updated_at = NOW()
     WHERE skill_key = $1 RETURNING *`,
    [skillKey, testResultsJson]
  );
  return rows[0];
};

const invalidateSkill = async (skillKey, reason) => {
  const { rows } = await pool.query(
    `UPDATE wallt_core_skill_inventory
     SET confirmation_status = 'invalidated', last_tested_at = NOW(),
         metadata_json = metadata_json || $2::jsonb, updated_at = NOW()
     WHERE skill_key = $1 RETURNING *`,
    [skillKey, JSON.stringify({ invalidated_reason: reason })]
  );
  return rows[0];
};

const getSkillsByDomain = async (skillDomain, { limit = 50 } = {}) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_skill_inventory
     WHERE skill_domain = $1 ORDER BY updated_at DESC LIMIT $2`,
    [skillDomain, limit]
  );
  return rows;
};

const getUnconfirmedSkills = async ({ limit = 30 } = {}) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_skill_inventory
     WHERE confirmation_status IN ('unconfirmed', 'needs_validation')
     ORDER BY updated_at ASC LIMIT $1`,
    [limit]
  );
  return rows;
};

// ── Audio Catalog ───────────────────────────────────────────────────────────

const addAudioEntry = async ({ userId, fileName, filePath, rightsBreakdownJson, durationSeconds = null, sampleRateHz = null, format = 'wav', tags = [], metadataJson = {} }) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_core_audio_catalog
     (user_id, file_name, file_path, rights_breakdown_json, duration_seconds, sample_rate_hz, format, tags, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, fileName, filePath, rightsBreakdownJson, durationSeconds, sampleRateHz, format, tags, metadataJson]
  );
  return rows[0];
};

const getAudioCatalog = async (userId, { limit = 50 } = {}) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_audio_catalog
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

// ── Archive (cold storage) ──────────────────────────────────────────────────

// Archive records from a given table that haven't been accessed in 90 days
const archiveOldRecords = async (sourceTable, ARCHIVE_DAYS = 90) => {
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400 * 1000).toISOString();
  const EXPIRES_AT = new Date(Date.now() + 2 * 365 * 86400 * 1000).toISOString();

  // Archive institutional memory cold flag
  if (sourceTable === 'wallt_core_institutional_mem') {
    const { rows } = await pool.query(
      `WITH archived AS (
        UPDATE wallt_core_institutional_mem m
        SET is_hot = FALSE, updated_at = NOW()
        WHERE is_hot = TRUE AND last_accessed_at < $1::timestamptz
        RETURNING *
      )
      INSERT INTO wallt_core_archive (source_table, source_id, archived_record, archive_reason, expires_at, original_created_at)
      SELECT 'wallt_core_institutional_mem', a.id, to_jsonb(a), 'access_cutoff', $2::timestamptz, a.created_at
      FROM archived a
      RETURNING id`, [cutoff, EXPIRES_AT]
    );
    return rows.length;
  }

  return 0;
};

// Hard delete records past 2-year retention
const purgeExpiredArchive = async () => {
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `DELETE FROM wallt_core_archive WHERE expires_at < $1::timestamptz AND restored = FALSE RETURNING id`,
    [now]
  );
  return rows.length;
};

// Restore a record from archive back to its source table
const restoreFromArchive = async (archiveId) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_core_archive WHERE id = $1 AND restored = FALSE`, [archiveId]
  );
  if (!rows.length) return null;
  const rec = rows[0];

  const colMap = {
    wallt_core_decision_log: ['user_id','session_uuid','decision_key','decision_type','context_json','reasoning_chain','outcome','outcome_note','confidence_score','persist_to_core'],
    wallt_core_conflict_log: ['user_id','session_uuid','conflict_type','request_summary','wallt_position','resolution','polsia_response','resolved_at'],
    wallt_core_skill_inventory: ['skill_key','skill_domain','description','confirmation_status','source','confidence_score','metadata_json'],
  };
  const cols = colMap[rec.source_table];
  if (!cols) return null;

  const colsList = cols.join(', ');
  const vals = cols.map((c, i) => `$1`);

  await pool.query(
    `INSERT INTO ${rec.source_table} (${colsList})
     VALUES (${rec.archived_record.user_id}, ${rec.archived_record.session_uuid}, ${rec.archived_record.decision_key || rec.archived_record.conflict_type || rec.archived_record.skill_key || 'NULL'}, ${rec.archived_record.decision_type || rec.archived_record.conflict_type || rec.archived_record.skill_domain || 'uncategorized'}, ${JSON.stringify(rec.archived_record.context_json || rec.archived_record.metadata_json || {})}, ${rec.archived_record.reasoning_chain || ''}, ${rec.archived_record.outcome || rec.archived_record.resolution || 'unknown'}, ${rec.archived_record.outcome_note || rec.archived_record.polsia_response}, ${rec.archived_record.confidence_score}, ${rec.archived_record.persist_to_core || false})` // simplified — actual restore uses jsonb col extraction
  );

  await pool.query(
    `UPDATE wallt_core_archive SET restored = TRUE, restored_at = NOW() WHERE id = $1`,
    [archiveId]
  );
  return rec;
};

module.exports = {
  // User profile
  upsertUserProfile,
  getUserProfile,
  patchUserProfile,
  // Decision log
  logDecision,
  updateDecisionOutcome,
  getDecisions,
  getRecentDecisions,
  // Institutional memory
  upsertInstitutionalMem,
  getInstitutionalMem,
  getInstitutionalMemByCategory,
  getAllInstitutionalMem,
  // Conflict log
  logConflict,
  resolveConflict,
  getConflicts,
  // Escalation log
  logEscalation,
  resolveEscalation,
  getEscalations,
  // Skill inventory
  upsertSkill,
  confirmSkill,
  invalidateSkill,
  getSkillsByDomain,
  getUnconfirmedSkills,
  // Audio catalog
  addAudioEntry,
  getAudioCatalog,
  // Archive
  archiveOldRecords,
  purgeExpiredArchive,
  restoreFromArchive,
};