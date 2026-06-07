/**
 * Migration: object_embeddings
 *
 * Creates the pgvector table for BIM element embeddings (neural processor).
 *
 * Architecture:
 *   RFA/RVT Family → PartAtom XML extract → param dict → text serialize →
 *   text-embedding-3-small (1536-dim) → pgvector store →
 *   nearest-neighbor on import / DAG merge / Wallt context injection
 *
 * Table: object_embeddings
 *   - project_id  → links to projects table (nullable: templates/global families)
 *   - element_id  → Atlantist element UUID or external family GUID
 *   - category    → Revit category string (Walls, Doors, Windows, Structural Columns…)
 *   - source      → 'revit_family' | 'ifc_element' | 'user_element'
 *   - param_hash  → SHA-256 of serialized params (skip re-embedding if unchanged)
 *   - embedding   → vector(1536) — OpenAI text-embedding-3-small
 *   - meta        → JSONB: { name, family_type, level, params, model_stats }
 *
 * Indexes:
 *   - ivfflat on embedding (cosine) — fast ANN for similarity search
 *   - btree on project_id (exact project lookups)
 *   - btree on (project_id, element_id) UNIQUE — prevent duplicate embeddings
 */
'use strict';

module.exports = {
  name: 'object_embeddings',
  skipTransaction: true,  // CREATE INDEX CONCURRENTLY requires autocommit

  up: async (client) => {

    // 1. Ensure pgvector is installed (idempotent)
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    } catch (err) {
      console.warn('[object_embeddings] pgvector not available — embeddings will be disabled:', err.message);
    }

    // 2. Create object_embeddings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_embeddings (
        id              BIGSERIAL PRIMARY KEY,
        project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        element_id      VARCHAR(128) NOT NULL,
        category        VARCHAR(128),
        source          VARCHAR(32) NOT NULL DEFAULT 'user_element'
                          CHECK (source IN ('revit_family','ifc_element','user_element','template')),
        param_hash      CHAR(64),
        embedding       vector(1536),
        meta            JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 3. Unique constraint: one embedding per (project, element)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_emb_project_element
        ON object_embeddings (project_id, element_id)
        WHERE project_id IS NOT NULL
    `);

    // Global families (no project) — unique by element_id alone
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_emb_global_element
        ON object_embeddings (element_id)
        WHERE project_id IS NULL
    `);

    // 4. Fast exact lookup by project
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_obj_emb_project
        ON object_embeddings (project_id)
        WHERE project_id IS NOT NULL
    `);

    // 5. IVFFlat index for ANN cosine similarity search
    //    lists=100 is appropriate for up to ~1M rows; rebuild after bulk loads
    //    Wrapped in try/catch: fails gracefully if pgvector is not available
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_obj_emb_vector_cosine
          ON object_embeddings
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100)
      `);
      console.log('[object_embeddings] IVFFlat cosine index created.');
    } catch (err) {
      console.warn('[object_embeddings] IVFFlat index skipped (pgvector unavailable?):', err.message);
    }

    // 6. Trigger: auto-update updated_at
    await client.query(`
      CREATE OR REPLACE FUNCTION fn_set_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'trg_obj_emb_updated_at'
            AND tgrelid = 'object_embeddings'::regclass
        ) THEN
          CREATE TRIGGER trg_obj_emb_updated_at
            BEFORE UPDATE ON object_embeddings
            FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
        END IF;
      END $$
    `);

    console.log('[object_embeddings] object_embeddings table + indexes created.');
  },
};
