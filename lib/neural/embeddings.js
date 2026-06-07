/**
 * Neural Processor — BIM Element Embedding Pipeline
 *
 * Converts BIM element parameter dictionaries into vector embeddings via
 * OpenAI text-embedding-3-small (1536-dim), stored in pgvector.
 *
 * Pipeline:
 *   param dict → text serialize → embedding API → upsert to object_embeddings
 *
 * Lookup:
 *   query param dict → embed → cosine nearest-neighbor → ranked similar elements
 *
 * Wallt Integration:
 *   buildProjectContext(projectId) → top-50 embeddings as structured JSON
 *   injected into Wallt persona context block (activeModel section)
 *
 * Usage:
 *   const { embedElement, findSimilar, buildProjectContext } = require('./embeddings');
 */
'use strict';

const crypto  = require('crypto');
const db      = require('../../db/index');
const https   = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM   = 1536;
const MAX_TOKENS      = 8191;   // model context limit
const OPENAI_API_URL  = 'https://api.openai.com/v1/embeddings';

// ── Text Serializer ───────────────────────────────────────────────────────────
/**
 * Convert a BIM element's parameter dict to a compact, model-friendly text.
 *
 * Format:
 *   "category:Walls | family:Basic Wall | type:Exterior - Brick | level:Level 1 |
 *    height:3200mm | width:300mm | material:Brick | fire_rating:60min"
 *
 * This format is dense but human-readable, giving the embedding model rich
 * structural context without JSON verbosity.
 */
function serializeParams(element) {
  const {
    name        = '',
    category    = '',
    family_type = '',
    level       = '',
    params      = {},
    source      = '',
  } = element;

  const parts = [];
  if (category)    parts.push(`category:${category}`);
  if (name)        parts.push(`name:${name}`);
  if (family_type) parts.push(`type:${family_type}`);
  if (level)       parts.push(`level:${level}`);
  if (source)      parts.push(`source:${source}`);

  // Flatten params — skip nulls and empty strings
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    // Truncate very long values (e.g. formula strings)
    const val = String(v).slice(0, 120);
    parts.push(`${k}:${val}`);
  }

  // Truncate total text to avoid hitting token limit
  // Rough estimate: 1 token ≈ 4 chars for English text
  return parts.join(' | ').slice(0, MAX_TOKENS * 4);
}

// ── Hash ──────────────────────────────────────────────────────────────────────
function hashParams(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ── OpenAI Embedding Call ─────────────────────────────────────────────────────
/**
 * Call OpenAI /v1/embeddings and return a float[] of length 1536.
 * Throws on API errors (caller should catch + log).
 */
async function callEmbeddingAPI(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set — embeddings disabled');

  const body = JSON.stringify({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`OpenAI API error ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(raw);
          resolve(json.data[0].embedding);
        } catch (e) {
          reject(new Error(`Embedding parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Upsert to DB ──────────────────────────────────────────────────────────────
/**
 * Upsert a single element embedding into object_embeddings.
 * Skips embedding API call if param_hash matches existing row.
 *
 * @param {Object} opts
 * @param {number|null}  opts.projectId   - Atlantist project ID (null for global families)
 * @param {string}       opts.elementId   - Element UUID or Revit GUID
 * @param {string}       opts.category    - Revit category (Walls, Doors, …)
 * @param {string}       opts.source      - 'revit_family'|'ifc_element'|'user_element'|'template'
 * @param {Object}       opts.element     - Element params object (fed to serializeParams)
 * @param {boolean}      [opts.force]     - Re-embed even if hash matches
 * @returns {Promise<{ id: number, skipped: boolean }>}
 */
async function embedElement(opts) {
  const { projectId = null, elementId, category, source = 'user_element', element, force = false } = opts;

  const text      = serializeParams({ category, source, ...element });
  const paramHash = hashParams(text);

  // Check existing hash — skip if unchanged
  if (!force) {
    const existing = await db.query(
      `SELECT id, param_hash FROM object_embeddings
       WHERE element_id = $1 AND (project_id = $2 OR (project_id IS NULL AND $2 IS NULL))
       LIMIT 1`,
      [elementId, projectId]
    );
    if (existing.rows.length > 0 && existing.rows[0].param_hash === paramHash) {
      return { id: existing.rows[0].id, skipped: true };
    }
  }

  // Generate embedding
  const embedding = await callEmbeddingAPI(text);

  // Format as pgvector literal: [0.1, -0.3, ...]
  const vectorLiteral = `[${embedding.join(',')}]`;

  // Upsert
  const res = await db.query(
    `INSERT INTO object_embeddings
       (project_id, element_id, category, source, param_hash, embedding, meta)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
     ON CONFLICT (element_id) WHERE project_id IS NULL
     DO UPDATE SET
       param_hash = EXCLUDED.param_hash,
       embedding  = EXCLUDED.embedding,
       meta       = EXCLUDED.meta,
       updated_at = NOW()
     RETURNING id`,
    [
      projectId,
      elementId,
      category,
      source,
      paramHash,
      vectorLiteral,
      JSON.stringify({ name: element.name, family_type: element.family_type, params: element.params }),
    ]
  );

  return { id: res.rows[0].id, skipped: false };
}

// ── Bulk Embed ────────────────────────────────────────────────────────────────
/**
 * Embed a batch of elements, with rate limiting (OpenAI default: 3000 RPM).
 * Returns { embedded, skipped, errors } counts.
 *
 * @param {Object[]} elements  - Array of opts objects (same shape as embedElement)
 * @param {Object}   [opts]
 * @param {number}   [opts.concurrency=5]  - Max parallel API calls
 * @param {Function} [opts.onProgress]     - Called with (done, total) after each element
 */
async function embedBatch(elements, { concurrency = 5, onProgress } = {}) {
  let embedded = 0, skipped = 0, errors = 0;
  const total = elements.length;

  // Simple semaphore for concurrency control
  const queue = [...elements];
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const result = await embedElement(item);
        if (result.skipped) skipped++; else embedded++;
      } catch (err) {
        errors++;
        console.error(`[embeddings] failed for ${item.elementId}:`, err.message);
      }
      onProgress?.(embedded + skipped + errors, total);
    }
  });

  await Promise.all(workers);
  return { embedded, skipped, errors, total };
}

// ── Similarity Search ─────────────────────────────────────────────────────────
/**
 * Find elements most similar to a query element using cosine distance.
 *
 * @param {Object} query         - Element params object (same shape as embedElement)
 * @param {Object} opts
 * @param {number|null} opts.projectId   - Scope to project (null = global scope only)
 * @param {number}      opts.limit       - Max results (default: 10)
 * @param {number}      opts.maxDistance - Max cosine distance 0→2 (default: 0.5)
 * @returns {Promise<Array<{ id, elementId, category, meta, distance }>>}
 */
async function findSimilar(query, { projectId = null, limit = 10, maxDistance = 0.5 } = {}) {
  const text      = serializeParams(query);
  const embedding = await callEmbeddingAPI(text);
  const vectorLit = `[${embedding.join(',')}]`;

  // Search scoped to project AND global families
  const projectFilter = projectId != null
    ? `(project_id = ${parseInt(projectId, 10)} OR project_id IS NULL)`
    : `project_id IS NULL`;

  const res = await db.query(
    `SELECT
       id,
       element_id,
       category,
       source,
       meta,
       1 - (embedding <=> $1::vector) AS similarity
     FROM object_embeddings
     WHERE ${projectFilter}
       AND embedding IS NOT NULL
       AND (embedding <=> $1::vector) < $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLit, maxDistance, limit]
  );

  return res.rows.map(r => ({
    id:         r.id,
    elementId:  r.element_id,
    category:   r.category,
    source:     r.source,
    meta:       r.meta,
    similarity: parseFloat(r.similarity).toFixed(4),
  }));
}

// ── Wallt Context Builder ─────────────────────────────────────────────────────
/**
 * Build a compact JSON context block for Wallt persona injection.
 * Returns the top-50 most recently updated embeddings for a project,
 * grouped by category.
 *
 * @param {number} projectId
 * @returns {Promise<Object>} — structured context for Wallt
 */
async function buildProjectContext(projectId) {
  const res = await db.query(
    `SELECT category, element_id, meta, updated_at
     FROM object_embeddings
     WHERE project_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [projectId]
  );

  const byCategory = {};
  for (const row of res.rows) {
    const cat = row.category || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({
      id:   row.element_id,
      name: row.meta?.name || row.element_id,
      type: row.meta?.family_type,
    });
  }

  return {
    source:         'neural_processor',
    project_id:     projectId,
    element_count:  res.rowCount,
    categories:     byCategory,
    generated_at:   new Date().toISOString(),
  };
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  serializeParams,
  hashParams,
  embedElement,
  embedBatch,
  findSimilar,
  buildProjectContext,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
};
