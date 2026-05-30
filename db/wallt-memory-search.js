/**
 * Owns: wallt_memory + wallt_memory_archive tables — semantic search and CRUD.
 * Does NOT own: wallt_core_* tables (db/wallt-memory.js), Wallt conversations.
 *
 * Semantic search via pgvector cosine distance.
 * Archive policy: records not accessed in 90 days → cold archive, 2-year hard delete.
 */
const pool = require('./index');

// ── Write — memory write (Wallt logs insights) ─────────────────────────────────

const writeMemory = async ({
  content,
  embedding = null,   // float[] from OpenAI text-embedding-3-small (1536d)
  category = 'general',
  confidence = 0.5,
  metadataJson = {},
  createdByWallt = true,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO wallt_memory (content, embedding, category, confidence, metadata_json, created_by_wallt)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [content, embedding, category, confidence, metadataJson, createdByWallt]
  );
  return rows[0];
};

// ── Read — memory read (context injection) ─────────────────────────────────────

// Get a single memory by ID (updates last_accessed_at)
const getMemoryById = async (id) => {
  const { rows } = await pool.query(
    `UPDATE wallt_memory
     SET last_accessed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0] || null;
};

// List memories for a user/project with optional category filter
const listMemories = async ({ userId = null, projectId = null, category = null, limit = 100 } = {}) => {
  const args = [];
  const conditions = [];

  if (userId) {
    args.push(userId);
    conditions.push(`metadata_json->>'user_id' = $${args.length}`);
  }
  if (projectId) {
    args.push(String(projectId));
    conditions.push(`metadata_json->>'project_id' = $${args.length}`);
  }
  if (category) {
    args.push(category);
    conditions.push(`category = $${args.length}`);
  }

  args.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, content, category, confidence, metadata_json, last_accessed_at, created_by_wallt, created_at
     FROM wallt_memory ${where}
     ORDER BY last_accessed_at DESC LIMIT $${args.length}`,
    args
  );
  return rows;
};

// Get most relevant memories for a project (top N by last access)
const getProjectMemories = async (projectId, { limit = 20 } = {}) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_memory
     WHERE metadata_json->>'project_id' = $1
     ORDER BY last_accessed_at DESC LIMIT $2`,
    [String(projectId), limit]
  );
  return rows;
};

// ── Semantic Search — memory search (semantic) ─────────────────────────────────

// Semantic similarity search using pgvector cosine distance
// Returns memories with content similar to the query text, ranked by cosine similarity
const searchMemories = async ({
  queryEmbedding = null,  // float[] — pre-computed embedding of query text
  queryText = null,      // fallback: raw text to embed inline (requires OpenAI key)
  category = null,
  createdByWallt = null,
  projectId = null,
  limit = 10,
  minSimilarity = 0.0,    // cosine distance threshold (0=exact, 1=broad)
}) => {
  if (!queryEmbedding && !queryText) {
    throw new Error('Either queryEmbedding or queryText must be provided');
  }

  // Build the WHERE clause
  const conditions = [];
  const args = [];
  if (category) {
    args.push(category);
    conditions.push(`category = $${args.length}`);
  }
  if (createdByWallt !== null) {
    args.push(createdByWallt);
    conditions.push(`created_by_wallt = $${args.length}`);
  }
  if (projectId) {
    args.push(String(projectId));
    conditions.push(`metadata_json->>'project_id' = $${args.length}`);
  }

  const whereConditions = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  // If we have a query embedding, use vector similarity search
  if (queryEmbedding) {
    args.push(queryEmbedding);
    const argIdx = args.length;

    // Use <= operator with float (pgvector <-> float comparison)
    const { rows } = await pool.query(
      `SELECT id, content, category, confidence, metadata_json,
              1 - (embedding <=> $${argIdx}::vector) AS similarity,
              last_accessed_at, created_by_wallt, created_at
       FROM wallt_memory
       WHERE embedding IS NOT NULL ${whereConditions}
         AND 1 - (embedding <=> $${argIdx}::vector) >= $${args.length + 1}
       ORDER BY embedding <=> $${argIdx}::vector ASC
       LIMIT $${args.length + 2}`,
      [...args, minSimilarity, limit]
    );
    return rows;
  }

  // No pre-computed embedding — fetch all and do keyword fallback
  const allArgs = args.slice();
  allArgs.push(limit);
  const { rows } = await pool.query(
    `SELECT id, content, category, confidence, metadata_json,
            0.0 AS similarity, last_accessed_at, created_by_wallt, created_at
     FROM wallt_memory
     WHERE 1=1 ${whereConditions}
     ORDER BY last_accessed_at DESC LIMIT $${allArgs.length}`,
    allArgs
  );
  return rows;
};

// Batch index: populate embedding for existing memories (no embedding set yet)
const backfillEmbeddings = async ({ limit = 100 } = {}) => {
  const { rows } = await pool.query(
    `SELECT id, content FROM wallt_memory
     WHERE embedding IS NULL
     LIMIT $1`,
    [limit]
  );
  return rows; // Caller embeds then calls updateEmbedding()
};

const updateEmbedding = async (id, embedding) => {
  const { rows } = await pool.query(
    `UPDATE wallt_memory SET embedding = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [id, embedding]
  );
  return rows[0] || null;
};

// ── Archive — memory archive (cold storage) ────────────────────────────────────

// Archive memories not accessed in 90 days
const archiveOldMemories = async (DAYS = 90) => {
  const cutoff = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const EXPIRES_AT = new Date(Date.now() + 2 * 365 * 86400 * 1000).toISOString();

  const { rows } = await pool.query(
    `WITH archived AS (
       DELETE FROM wallt_memory
       WHERE last_accessed_at < $1::timestamptz
         AND id NOT IN (SELECT unnest(COALESCE(
           (SELECT metadata_json->'pinned_ids' FROM wallt_memory LIMIT 1),
           ('[]')::jsonb
         )::int[]))
       RETURNING *
     )
     INSERT INTO wallt_memory_archive
       (source_id, content, embedding, category, confidence, metadata_json,
        archived_at, original_created_at, expires_at)
     SELECT a.id, a.content, a.embedding, a.category, a.confidence, a.metadata_json,
            NOW(), a.created_at, $2::timestamptz
     FROM archived a
     RETURNING id`,
    [cutoff, EXPIRES_AT]
  );
  return rows.length;
};

// Hard delete archive records past 2-year retention
const purgeExpiredArchive = async () => {
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `DELETE FROM wallt_memory_archive
     WHERE expires_at < $1::timestamptz AND restored = FALSE
     RETURNING id`,
    [now]
  );
  return rows.length;
};

// Restore an archived memory back to wallt_memory
const restoreFromArchive = async (archiveId) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_memory_archive WHERE id = $1 AND restored = FALSE`,
    [archiveId]
  );
  if (!rows.length) return null;
  const rec = rows[0];

  const { rows: inserted } = await pool.query(
    `INSERT INTO wallt_memory
       (content, embedding, category, confidence, metadata_json, created_by_wallt, created_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, $6)
     RETURNING id`,
    [rec.content, rec.embedding, rec.category, rec.confidence, rec.metadata_json, rec.original_created_at]
  );

  await pool.query(
    `UPDATE wallt_memory_archive SET restored = TRUE, restored_at = NOW() WHERE id = $1`,
    [archiveId]
  );

  return inserted[0];
};

// ── Context Graph wiring ────────────────────────────────────────────────────────

// Get recent wallt memories for a user (used in read_context_graph node: wallt_memory)
const getMemoriesForUser = async (userId, { limit = 20 } = {}) => {
  const { rows } = await pool.query(
    `SELECT id, content, category, confidence, metadata_json, last_accessed_at, created_at
     FROM wallt_memory
     WHERE metadata_json->>'user_id' = $1
        OR created_by_wallt = TRUE
     ORDER BY last_accessed_at DESC, created_at DESC
     LIMIT $2`,
    [String(userId), limit]
  );
  return rows;
};

module.exports = {
  // Write
  writeMemory,
  // Read
  getMemoryById,
  listMemories,
  getProjectMemories,
  // Semantic search
  searchMemories,
  backfillEmbeddings,
  updateEmbedding,
  // Archive
  archiveOldMemories,
  purgeExpiredArchive,
  restoreFromArchive,
  // Context Graph
  getMemoriesForUser,
};