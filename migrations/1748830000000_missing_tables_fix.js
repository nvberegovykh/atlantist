/**
 * Migration: create missing tables that were never in any migration.
 *
 * These tables exist in db/ query files but were never CREATE'd in a migration:
 *   - issue_comments      (db/issues.js)
 *   - issue_snapshots     (db/issues.js)
 *   - renders             (db/renders.js)
 *
 * Also patches the `issues` table to add columns that the code uses but the
 * core-schema migration omitted (document_id, body, author_user_id, etc.).
 *
 * Also re-ensures session_uuid exists on app_users (defence-in-depth in case
 * 1748690000000 was skipped due to an earlier migration error).
 */
module.exports = {
  name: '1748830000000_missing_tables_fix',

  up: async (client) => {
    // ── 1. issues — patch missing columns used by db/issues.js ───────────────
    await client.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS document_id       VARCHAR(255) DEFAULT 'default'`);
    await client.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS body              TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS author_user_id    VARCHAR(255)`);
    await client.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS anchor_element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_issues_document ON issues(document_id)`);

    // ── 2. issue_comments ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS issue_comments (
        id              SERIAL PRIMARY KEY,
        issue_id        INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author_user_id  VARCHAR(255),
        body            TEXT NOT NULL DEFAULT '',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)`);

    // ── 3. issue_snapshots ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS issue_snapshots (
        id              SERIAL PRIMARY KEY,
        issue_id        INTEGER NOT NULL UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
        camera_position JSONB DEFAULT '{}',
        view_mode       VARCHAR(50) DEFAULT '3d',
        visible_layers  JSONB DEFAULT '[]',
        snapshot_png    TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 4. renders ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS renders (
        id              SERIAL PRIMARY KEY,
        style           VARCHAR(100),
        image_url       TEXT,
        thumbnail_url   TEXT,
        viewpoint_name  VARCHAR(255) DEFAULT 'Unnamed View',
        camera_data     JSONB DEFAULT '{}',
        prompt_used     TEXT,
        source_canvas   VARCHAR(50) DEFAULT '3d',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 5. session_uuid safety net ───────────────────────────────────────────
    // Defence-in-depth: 1748690000000 should have done this, but if the
    // migration runner bailed before reaching it, auth/init will 503.
    await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS session_uuid VARCHAR(36)`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'app_users_session_uuid_key'
        ) THEN
          ALTER TABLE app_users ADD CONSTRAINT app_users_session_uuid_key UNIQUE (session_uuid);
        END IF;
      END$$
    `);

    console.log('[1748830000000] issue_comments, issue_snapshots, renders created; issues + session_uuid patched.');
  }
};
