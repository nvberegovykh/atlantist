/**
 * Migration: security_hardening
 *
 * 1. magic_tokens: add token_hash column (SHA-256 of raw token)
 *    Raw token is still stored for backward-compat during rollout,
 *    but lookups will migrate to token_hash. Raw column will be nulled
 *    in a future migration once all active tokens have expired (15 min TTL).
 *
 * 2. auth_sessions: add ip_address + user_agent for session binding audit.
 *
 * 3. project_data_keys: per-project AES-256-GCM key envelope
 *    (key encrypted with server-side master key stored in env).
 *    Enables at-rest encryption of BIM element JSON blobs.
 *
 * 4. file_uploads: metadata table for tracking uploaded BIM files with
 *    content hash, owner, encryption status, and virus scan status.
 *
 * 5. auth_rate_limits: persistent rate limit log for magic link requests
 *    (supplement in-memory Redis limiter for multi-instance deployments).
 */
'use strict';

module.exports = {
  name: 'security_hardening',

  up: async (client) => {

    // ── 1. magic_tokens: add token_hash for hashed lookups ──────────────────
    await client.query(`
      ALTER TABLE magic_tokens
        ADD COLUMN IF NOT EXISTS token_hash CHAR(64)
    `);
    // Back-fill existing rows (safe: tokens expire in 15 min anyway)
    await client.query(`
      UPDATE magic_tokens
        SET token_hash = encode(digest(token, 'sha256'), 'hex')
        WHERE token_hash IS NULL AND token IS NOT NULL
    `).catch(() => {
      // pgcrypto may not be available; skip backfill — handled in app layer
      console.warn('[security_hardening] pgcrypto not available; token_hash backfill skipped');
    });

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_magic_tokens_hash
        ON magic_tokens (token_hash)
        WHERE token_hash IS NOT NULL
    `);

    // ── 2. auth_sessions: session binding metadata ───────────────────────────
    await client.query(`
      ALTER TABLE auth_sessions
        ADD COLUMN IF NOT EXISTS ip_address  INET,
        ADD COLUMN IF NOT EXISTS user_agent  TEXT,
        ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ DEFAULT NOW()
    `);

    // ── 3. project_data_keys: per-project encryption key envelope ────────────
    // The actual AES key bytes are never stored; only an encrypted envelope
    // (key XOR'd with HMAC(master_secret, project_id)) is kept here.
    // See lib/crypto/project-keys.js for the key derivation scheme.
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_data_keys (
        project_id   INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        key_version  SMALLINT NOT NULL DEFAULT 1,
        -- HMAC-SHA256(MASTER_KEY, project_id || version) → 32-byte derived key
        -- We store a verification tag so we can detect master key rotation.
        key_tag      CHAR(64) NOT NULL,  -- SHA-256 of derived key (for verification)
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
        sha256        CHAR(64),            -- content hash for integrity verification
        storage_key   TEXT,               -- R2/S3 object key
        encrypted     BOOLEAN DEFAULT FALSE,
        scan_status   VARCHAR(32) DEFAULT 'pending'  -- pending | clean | flagged
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
    // Used alongside in-memory limiter for multi-instance safety.
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        id           BIGSERIAL PRIMARY KEY,
        key          VARCHAR(256) NOT NULL,  -- 'email:<email>' or 'ip:<ip>'
        action       VARCHAR(64)  NOT NULL,  -- 'magic_link' | 'verify' | 'init'
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_rl_key_time
        ON auth_rate_limits (key, created_at)
    `);

    // Auto-purge entries older than 1 hour (TTL housekeeping)
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
