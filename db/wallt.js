/**
 * Owns: wallt_conversations, wallt_messages, wallt_context_snapshots.
 * Does NOT own: AI model calls, personality engine, encryption.
 */
const pool = require('./index');

const createConversation = async (userId, contextProjectId, contextMetadata, personaVersion) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_conversations (user_id, context_project_id, context_metadata, persona_version)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, contextProjectId, contextMetadata || {}, personaVersion || '1.0.0']
  );
  return rows[0];
};

const getConversationById = async (id) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_conversations WHERE id = $1`, [id]
  );
  return rows[0] || null;
};

const listConversations = async (userId, limit = 20) => {
  const { rows } = await pool.query(
    `SELECT id, title, created_at, updated_at, is_archived, context_project_id
     FROM wallt_conversations
     WHERE user_id = $1 AND is_archived = FALSE
     ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

const archiveConversation = async (id, userId) => {
  const { rows } = await pool.query(
    `UPDATE wallt_conversations SET is_archived = TRUE, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows[0];
};

const touchConversation = async (id) => {
  await pool.query(
    `UPDATE wallt_conversations SET updated_at = NOW() WHERE id = $1`, [id]
  );
};

const createMessage = async (conversationId, role, content, sources, metadata, styleScore, actionsJson) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_messages (conversation_id, role, content, sources, metadata, style_score, actions_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [conversationId, role, content || '', sources || [], metadata || {}, styleScore != null ? styleScore : null, actionsJson || []]
  );
  return rows[0];
};

const getMessagesByConversation = async (conversationId, limit = 100) => {
  const { rows } = await pool.query(
    `SELECT id, role, content, sources, metadata, actions_json, created_at
     FROM wallt_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, limit]
  );
  return rows;
};

const saveContextSnapshot = async (userId, projectId, snapshotData) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_context_snapshots (user_id, project_id, snapshot_data)
     VALUES ($1, $2, $3) RETURNING id, created_at`,
    [userId, projectId, snapshotData]
  );
  return rows[0];
};

const getLatestContextSnapshot = async (userId) => {
  const { rows } = await pool.query(
    `SELECT snapshot_data, created_at FROM wallt_context_snapshots
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
};

module.exports = {
  createConversation,
  getConversationById,
  listConversations,
  archiveConversation,
  touchConversation,
  createMessage,
  getMessagesByConversation,
  saveContextSnapshot,
  getLatestContextSnapshot,
};