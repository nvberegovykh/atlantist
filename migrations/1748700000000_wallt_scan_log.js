/**
 * Migration: wallt_scan_log
 * Creates the wallt_scan_log table referenced by db/wallt-scan-log.js.
 * Also creates wallt_api_audit table referenced by db/wallt-api.js (logAudit).
 * Fully idempotent — CREATE TABLE IF NOT EXISTS throughout.
 */
'use strict';

module.exports = {
  name: 'wallt_scan_log',
  skipTransaction: true,

  up: async (client) => {

    // ── wallt_scan_log — WhatsApp scanner batch audit log ─────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallt_scan_log (
        id                    SERIAL PRIMARY KEY,
        batch_id              VARCHAR(255) NOT NULL,
        total_messages        INTEGER DEFAULT 0,
        classified            JSONB DEFAULT '{}',
        ingested              INTEGER DEFAULT 0,
        skipped_duplicate     INTEGER DEFAULT 0,
        project_key_present   BOOLEAN DEFAULT FALSE,
        scanned_at            TIMESTAMPTZ,
        processed_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallt_scan_log_processed ON wallt_scan_log(processed_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallt_scan_log_batch ON wallt_scan_log(batch_id)`);

    // ── wallt_api_audit — audit log for Wallt API calls ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallt_api_audit (
        id                    BIGSERIAL PRIMARY KEY,
        request_id            VARCHAR(255),
        source                VARCHAR(100),
        user_id               VARCHAR(255),
        sector_hits           JSONB DEFAULT '[]',
        processing_time_ms    INTEGER,
        status_code           INTEGER,
        timeout_flag          BOOLEAN DEFAULT FALSE,
        project_id            VARCHAR(255),
        key_valid             BOOLEAN,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallt_api_audit_created ON wallt_api_audit(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallt_api_audit_request ON wallt_api_audit(request_id)`);

    console.log('[wallt_scan_log] wallt_scan_log + wallt_api_audit tables created.');
  }
};
