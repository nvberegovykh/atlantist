/**
 * Migration: Create live_sessions and live_session_participants tables.
 * Required by routes/live-sessions.js and db/live-sessions.js.
 */
module.exports = {
  name: '1748700000000_live_sessions',
  skipTransaction: true,
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_sessions (
        id            SERIAL PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        host_user_id  INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        share_token   VARCHAR(64) UNIQUE NOT NULL,
        mode          VARCHAR(10) NOT NULL DEFAULT 'view' CHECK (mode IN ('view','edit')),
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS live_session_participants (
        id            SERIAL PRIMARY KEY,
        session_id    INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id       VARCHAR(64),
        is_guest      BOOLEAN NOT NULL DEFAULT FALSE,
        guest_handle  VARCHAR(64),
        color         VARCHAR(16) NOT NULL DEFAULT '#4a9eff',
        cursor_x      FLOAT,
        cursor_y      FLOAT,
        joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (session_id, user_id)
      )
    `);

    // Indexes for common lookups
    await client.query(`CREATE INDEX IF NOT EXISTS idx_live_sessions_token     ON live_sessions(share_token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_live_sessions_project   ON live_sessions(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_live_sessions_expires   ON live_sessions(expires_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lsp_session             ON live_session_participants(session_id)`);

    console.log('[1748700000000] live_sessions + live_session_participants created.');
  }
};
