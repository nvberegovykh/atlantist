/**
 * Migration: security_hardening
 *
 * IMPORTANT: skipTransaction = true — each statement runs in autocommit.
 * Reason: the pgcrypto backfill (step 1b) may fail if pgcrypto is not
 * installed. With a wrapping transaction, that failure aborts the entire
 * block (25P02). In autocommit mode each statement is independent, so a
 * failure on the backfill does not prevent the subsequent ALTER / CREATE
 * statements from running.
 *
 * 1. magic_tokens: add token_hash column (SHA-256 of raw token)
 * 2. auth_sessions: add ip_address + user_agent + last_active
 * 3. project_data_keys: per-project AES-256-GCM key envelope
 * 4. file_uploads: metadata table for uploaded BIM files
 * 5. auth_rate_limits: persistent magic link rate-limit log
 */
'use strict';

module.exports = {
  name: 'security_hardening',
  skipTransaction: true,   // <-- autocommit: pgcrypto failure won't abort block

  up: async (client) => {

    // ── 1a. magic_tokens: add token_hash column ──────────────────────────────
    await client.query(`
      ALTER TABLE magic_tokens
        ADD COLUMN IF NOT EXISTS token_hash CHAR(64)
    `);

    // ── 1b. Back-fill existing rows using pgcrypto digest() ──────────────────
    // Runs in its own try/catch — safe to skip if pgcrypto unavailable.
    // Tokens expire in 15 min; app layer handles hashing going forward.
    try {
      await client.query(`
        UPDATE magic_tokens
          SET token_hash = encode(digest(token, 'sha256'), 'hex')
          WHERE token_hash IS NULL AND token IS NOT NULL
      `);
    } catch (_) {
      console.warn('[security_hardening] pgcrypto not available; token_hash backfill skipped (app layer handles hashing)');
    }

    // ── 1c. Index on token_hash ───────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_magic_tokens_hash
        ON magic_tokens (token_hash)
        WHERE token_hash IS NOT NULL
    `);

    // ── 2. auth_sessions: session binding metadata ───────────────────────────
    await client.query(`
      ALTER TABLE auth_sessions
        ADD COLUMN IF NOT EXISTS ip_address  INET
    `).catch(e => { if (!e.message.includes('already exists')) throw e; });

    await client.query(`
      ALTER TABLE auth_sessions
        ADD COLUMN IF NOT EXISTS user_agent  TEXT
    `).catch(e => { if (!e.message.includes('already exists')) throw e; });

    await client.query(`
      ALTER TABLE auth_sessions
        ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ DEFAULT NOW()
    `).catch(e => { if (!e.message.includes('already exists')) throw e; });

    // ── 3. project_data_keys: per-project encryption key envelope ────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_data_keys (
        project_id   INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        key_version  SMALLINT NOT NULL DEFAULT 1,
        key_tag      CHAR(64) NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        rotated_at   TIMESTAMPTZ
      )
    `);

    // ── 4. file_uploads: BIM file metadata + integrity ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS file_uploads (
        id            BIGSERIAL PRIMARY KEY,
        project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        owner_id      INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        filename      TEXT NOT NULL,
        content_type  VARCHAR(128),
        size_bytes    BIGINT,
        sha256        CHAR(64),
        storage_key   TEXT,
        encrypted     BOOLEAN DEFAULT FALSE,
        scan_status   VARCHAR(32) DEFAULT 'pending'
                        CHECK (scan_status IN ('pending','clean','flagged','skipped')),
        scan_at       TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_uploads_project
        ON file_uploads (project_id)
        WHERE project_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_uploads_owner
        ON file_uploads (owner_id)
    `);

    // ── 5. auth_rate_limits: persistent magic link request log ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        id           BIGSERIAL PRIMARY KEY,
        key          VARCHAR(256) NOT NULL,
        action       VARCHAR(64)  NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_rl_key_time
        ON auth_rate_limits (key, created_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION fn_cleanup_auth_rl() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM auth_rate_limits WHERE created_at < NOW() - INTERVAL '1 hour';
        RETURN NULL;
      END; $$
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cleanup_auth_rl'
        ) THEN
          CREATE TRIGGER trg_cleanup_auth_rl
            AFTER INSERT ON auth_rate_limits
            FOR EACH STATEMENT EXECUTE FUNCTION fn_cleanup_auth_rl();
        END IF;
      END $$
    `);

    console.log('[security_hardening] migration complete.');
  },
};
