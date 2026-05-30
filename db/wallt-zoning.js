/**
 * Owns: wallt_zoning_chunks — embedded NYC Zoning Resolution text chunks.
 * Does NOT own: embedding model calls, persona engine, chat logic.
 */
const pool = require('./index');

// ── Embedding utilities ──────────────────────────────────────────────────────

// Cosine similarity between two REAL[] vectors (1536-dim)
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

const upsertChunk = async ({ district, section, heading, text, sourceUrl, verifyFlag = false, embedding = null }) => {
  const embeddingArr = embedding ? `[${embedding.join(',')}]` : null;
  const { rows } = await pool.query(
    `INSERT INTO wallt_zoning_chunks (district, section, heading, text, source_url, verify_flag, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::real[])
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [district, section, heading, text, sourceUrl, verifyFlag, embeddingArr]
  );
  return rows[0];
};

const upsertChunkBatch = async (chunks) => {
  const results = [];
  for (const chunk of chunks) {
    const result = await upsertChunk(chunk);
    results.push(result);
  }
  return results;
};

const getChunkById = async (id) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_zoning_chunks WHERE id = $1`, [id]
  );
  return rows[0] || null;
};

const getChunksByDistrict = async (district) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_zoning_chunks WHERE district = $1 ORDER BY section`, [district]
  );
  return rows;
};

const getChunksNeedingVerification = async () => {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_zoning_chunks WHERE verify_flag = TRUE`
  );
  return rows;
};

const countChunks = async () => {
  const { rows } = await pool.query(`SELECT COUNT(*) as total FROM wallt_zoning_chunks`);
  return parseInt(rows[0].total);
};

// ── Top-k retrieval ──────────────────────────────────────────────────────────
// Uses REAL[] column for vector search when pgvector is available.
// Falls back to JSONB dot-product via unnest when vector extension unavailable.
// topK=4, returns chunks sorted by cosine similarity.

const searchChunks = async (queryEmbedding, topK = 4) => {
  const k = Math.min(topK, 50);

  // Try pgvector L2 distance first (avoids cosine similarity computation)
  // Fall back to manual cosine similarity over JSONB
  let rows;

  try {
    const { rows: vrows } = await pool.query(
      `SELECT id, district, section, heading, text, source_url, verify_flag,
              $1::real[] <=> embedding AS distance
       FROM wallt_zoning_chunks
       WHERE embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT $2`,
      [queryEmbedding, k]
    );
    rows = vrows;
  } catch (_) {
    // pgvector not available — compute cosine similarity manually via JSONB
    // Fetch all embedded chunks and sort
    const { rows: allRows } = await pool.query(
      `SELECT id, district, section, heading, text, source_url, verify_flag, embedding_jsonb
       FROM wallt_zoning_chunks
       WHERE embedding_jsonb IS NOT NULL`
    );

    const scored = allRows
      .map(row => {
        const emb = row.embedding_jsonb;
        const sim = cosineSimilarity(queryEmbedding, emb);
        return { ...row, similarity: sim };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    return scored.map(row => ({
      id: row.id,
      district: row.district,
      section: row.section,
      heading: row.heading,
      text: row.text,
      source_url: row.source_url,
      verify_flag: row.verify_flag,
    }));
  }

  return rows.map(r => ({
    id: r.id,
    district: r.district,
    section: r.section,
    heading: r.heading,
    text: r.text,
    source_url: r.source_url,
    verify_flag: r.verify_flag,
  }));
};

// ── Text-only retrieval (no embedding needed — keyword + district filter) ───
const searchChunksByText = async (query, district = null, topK = 4) => {
  let queryText;
  let params;
  if (district) {
    queryText = `SELECT id, district, section, heading, text, source_url, verify_flag
                 FROM wallt_zoning_chunks
                 WHERE district = $1 AND (text ILIKE '%' || $2 || '%' OR heading ILIKE '%' || $2 || '%')
                 ORDER BY section LIMIT $3`;
    params = [district, query, topK];
  } else {
    queryText = `SELECT id, district, section, heading, text, source_url, verify_flag
                 FROM wallt_zoning_chunks
                 WHERE text ILIKE '%' || $1 || '%' OR heading ILIKE '%' || $1 || '%'
                 ORDER BY district, section LIMIT $2`;
    params = [query, topK];
  }
  const { rows } = await pool.query(queryText, params);
  return rows;
};

// ── Clear all chunks (used by embed script on re-run) ───────────────────────
const clearAllChunks = async () => {
  await pool.query(`DELETE FROM wallt_zoning_chunks`);
};

module.exports = {
  upsertChunk,
  upsertChunkBatch,
  getChunkById,
  getChunksByDistrict,
  getChunksNeedingVerification,
  countChunks,
  searchChunks,
  searchChunksByText,
  clearAllChunks,
};