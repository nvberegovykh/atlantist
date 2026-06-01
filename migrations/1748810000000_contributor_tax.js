/**
 * Migration: contributor_tax
 *
 * Adds tax compliance columns to contributors table and creates:
 *   1. contributor_tax_forms     — W-9 / W-8BEN / W-8BEN-E submissions
 *   2. contributor_tax_summaries — annual 1099 / FATCA reporting ledger
 *
 * Fully idempotent — ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
 */
'use strict';

module.exports = {
  name: '1748810000000_contributor_tax',

  async up(pool) {
    // ── 1. Add tax columns to contributors ───────────────────────────────────

    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS tax_country CHAR(2)`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS tax_form_status VARCHAR(50) DEFAULT 'not_submitted'`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS tax_id_enc TEXT`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS is_us_person BOOLEAN`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS withholding_rate NUMERIC(5,4) DEFAULT 0.00`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS needs_1099 BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS needs_w8ben BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS ytd_payout_cents BIGINT DEFAULT 0`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS tax_year INTEGER DEFAULT EXTRACT(YEAR FROM NOW())::INTEGER`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS us_state CHAR(2)`);
    await pool.query(`ALTER TABLE contributors ADD COLUMN IF NOT EXISTS legal_name TEXT`);

    console.log('[migration] contributor tax columns added');

    // ── 2. contributor_tax_forms ──────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contributor_tax_forms (
        id              SERIAL PRIMARY KEY,
        contributor_id  INTEGER REFERENCES contributors(id) ON DELETE CASCADE,
        form_type       VARCHAR(20) NOT NULL,
        submitted_at    TIMESTAMPTZ DEFAULT NOW(),
        verified_at     TIMESTAMPTZ,
        verified_by     INTEGER REFERENCES app_users(id),
        form_data_enc   TEXT NOT NULL,
        status          VARCHAR(30) DEFAULT 'pending',
        expires_at      TIMESTAMPTZ,
        notes           TEXT
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tax_forms_contributor ON contributor_tax_forms(contributor_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tax_forms_status      ON contributor_tax_forms(status)`);

    console.log('[migration] contributor_tax_forms table created');

    // ── 3. contributor_tax_summaries ─────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contributor_tax_summaries (
        id                  SERIAL PRIMARY KEY,
        contributor_id      INTEGER REFERENCES contributors(id) ON DELETE CASCADE,
        tax_year            INTEGER NOT NULL,
        total_paid_cents    BIGINT DEFAULT 0,
        total_withheld_cents BIGINT DEFAULT 0,
        form_type           VARCHAR(20),
        reported_to_irs     BOOLEAN DEFAULT FALSE,
        reported_at         TIMESTAMPTZ,
        UNIQUE(contributor_id, tax_year)
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tax_summaries_contributor ON contributor_tax_summaries(contributor_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tax_summaries_year        ON contributor_tax_summaries(tax_year)`);

    console.log('[migration] contributor_tax_summaries table created');
  },

  config: { skipTransaction: true }
};
