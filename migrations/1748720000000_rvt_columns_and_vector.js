/**
 * Migration: rvt_columns_and_vector
 *
 * 1. Adds missing columns to rvt_import_runs that db/rvt-import.js expects:
 *    progress_pct, elements_total, elements_succeeded, elements_failed,
 *    wall_layers_created, family_instances_created, error_log, started_at, completed_at
 *
 * 2. Adds file_path column to ifc_export_runs for Round 5 download fix.
 *
 * 3. Adds pgvector extension (required for wallt AI vector queries).
 *
 * Fully idempotent — ALTER TABLE ADD COLUMN IF NOT EXISTS throughout.
 */
'use strict';

module.exports = {
  name: 'rvt_columns_and_vector',
  skipTransaction: true,

  up: async (client) => {

    // ── 1. pgvector extension ──────────────────────────────────────────────────
    // Safe to run if extension already installed — IF NOT EXISTS is idempotent.
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      console.log('[rvt_columns_and_vector] pgvector extension enabled.');
    } catch (err) {
      // Extension may not be available on this Postgres instance — non-fatal.
      console.warn('[rvt_columns_and_vector] pgvector not available (skipping):', err.message);
    }

    // ── 2. rvt_import_runs — add columns used by db/rvt-import.js ─────────────
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS progress_pct INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS elements_total INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS elements_succeeded INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS elements_failed INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS wall_layers_created INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS family_instances_created INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS error_log TEXT`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE rvt_import_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);

    // ── 3. ifc_export_runs — add file_path column for temp file serving ────────
    await client.query(`ALTER TABLE ifc_export_runs ADD COLUMN IF NOT EXISTS file_path TEXT`);

    console.log('[rvt_columns_and_vector] rvt_import_runs columns patched, ifc_export_runs.file_path added.');
  }
};
