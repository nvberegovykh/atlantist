/**
 * Migration: rvt_ifc_tables
 * Creates rvt_import_runs, rvt_import_results, ifc_import_runs, ifc_export_runs.
 * These were missing entirely from the initial schema.
 */
'use strict';

module.exports = {
  name: 'rvt_ifc_tables',
  skipTransaction: true,

  up: async (client) => {

    // ── RVT import runs ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rvt_import_runs (
        id                  SERIAL PRIMARY KEY,
        project_id          INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        file_name           VARCHAR(512) NOT NULL DEFAULT 'unknown.rvt',
        file_size_bytes     BIGINT,
        revit_version       VARCHAR(50),
        upload_url          TEXT,
        derivative_job_id   VARCHAR(512),
        status              VARCHAR(50) DEFAULT 'pending',
        element_count       INTEGER DEFAULT 0,
        error_message       TEXT,
        summary             JSONB DEFAULT '{}',
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rvt_runs_project ON rvt_import_runs(project_id)`);

    // ── RVT import results (per-element) ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rvt_import_results (
        id            SERIAL PRIMARY KEY,
        run_id        INTEGER NOT NULL REFERENCES rvt_import_runs(id) ON DELETE CASCADE,
        category      VARCHAR(100),
        subcategory   VARCHAR(100),
        element_name  VARCHAR(512),
        revit_guid    VARCHAR(255),
        mapped_type   VARCHAR(50),
        element_id    INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        status        VARCHAR(50) DEFAULT 'ok',
        notes         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rvt_results_run ON rvt_import_results(run_id)`);

    // ── IFC import runs ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ifc_import_runs (
        id              SERIAL PRIMARY KEY,
        project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        file_name       VARCHAR(512) NOT NULL DEFAULT 'import.ifc',
        file_size_bytes BIGINT,
        schema          VARCHAR(50) DEFAULT 'IFC2X3',
        status          VARCHAR(50) DEFAULT 'pending',
        progress_pct    INTEGER DEFAULT 0,
        element_count   INTEGER DEFAULT 0,
        error_message   TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ifc_import_project ON ifc_import_runs(project_id)`);

    // ── IFC export runs ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ifc_export_runs (
        id              SERIAL PRIMARY KEY,
        project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        schema          VARCHAR(50) DEFAULT 'IFC2X3',
        file_name       VARCHAR(512),
        file_content    TEXT,
        status          VARCHAR(50) DEFAULT 'pending',
        error_message   TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ifc_export_project ON ifc_export_runs(project_id)`);

    console.log('[rvt_ifc_tables] RVT + IFC tables created.');
  }
};
