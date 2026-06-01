/**
 * Migration: contributor_system
 *
 * Creates tables for the Atlantist community ownership / contributor system:
 *   1. contributors            — registered contributors with GitHub & Stripe links
 *   2. contribution_points     — ledger of all point events (earned / deducted)
 *   3. profit_distributions    — periodic profit-sharing runs
 *   4. contributor_payouts     — per-contributor payout rows within a distribution
 *
 * Fully idempotent — CREATE TABLE IF NOT EXISTS throughout.
 */
'use strict';

module.exports = {
  name: '1748800000000_contributor_system',

  async up(pool) {
    // ── 1. contributors ──────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contributors (
        id                      SERIAL PRIMARY KEY,
        user_id                 INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
        github_login            VARCHAR(255) UNIQUE NOT NULL,
        github_id               BIGINT UNIQUE NOT NULL,
        github_access_token_enc TEXT,
        stripe_account_id       VARCHAR(255),
        stripe_account_status   VARCHAR(50)  DEFAULT 'not_connected',
        status                  VARCHAR(50)  DEFAULT 'pending',
        approved_at             TIMESTAMPTZ,
        approved_by             INTEGER REFERENCES app_users(id),
        contract_signed_at      TIMESTAMPTZ,
        contract_version        VARCHAR(20),
        total_points            BIGINT       DEFAULT 0,
        lifetime_points         BIGINT       DEFAULT 0,
        created_at              TIMESTAMPTZ  DEFAULT NOW(),
        updated_at              TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributors_user_id      ON contributors(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributors_github_login  ON contributors(github_login)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributors_status        ON contributors(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributors_total_points  ON contributors(total_points DESC)`);

    // ── 2. contribution_points ledger ────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contribution_points (
        id              SERIAL PRIMARY KEY,
        contributor_id  INTEGER REFERENCES contributors(id) ON DELETE CASCADE,
        points          BIGINT       NOT NULL,
        reason          VARCHAR(500) NOT NULL,
        source_type     VARCHAR(100) NOT NULL,
        source_ref      VARCHAR(500),
        awarded_by      INTEGER REFERENCES contributors(id),
        metadata        JSONB        DEFAULT '{}',
        created_at      TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contribution_points_contributor ON contribution_points(contributor_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contribution_points_source_type ON contribution_points(source_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contribution_points_created_at  ON contribution_points(created_at DESC)`);

    // ── 3. profit_distributions ──────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profit_distributions (
        id                      SERIAL PRIMARY KEY,
        period_start            DATE        NOT NULL,
        period_end              DATE        NOT NULL,
        total_profit_cents      BIGINT      NOT NULL,
        total_points_snapshot   BIGINT      NOT NULL,
        status                  VARCHAR(50) DEFAULT 'pending',
        processed_at            TIMESTAMPTZ,
        created_at              TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_profit_distributions_status ON profit_distributions(status)`);

    // ── 4. contributor_payouts ───────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contributor_payouts (
        id                    SERIAL PRIMARY KEY,
        distribution_id       INTEGER REFERENCES profit_distributions(id),
        contributor_id        INTEGER REFERENCES contributors(id),
        points_snapshot       BIGINT         NOT NULL,
        share_pct             NUMERIC(10,6)  NOT NULL,
        gross_amount_cents    BIGINT         NOT NULL,
        tax_withheld_cents    BIGINT         DEFAULT 0,
        net_amount_cents      BIGINT         NOT NULL,
        stripe_transfer_id    VARCHAR(255),
        status                VARCHAR(50)    DEFAULT 'pending',
        created_at            TIMESTAMPTZ    DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributor_payouts_distribution  ON contributor_payouts(distribution_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributor_payouts_contributor   ON contributor_payouts(contributor_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributor_payouts_status        ON contributor_payouts(status)`);

    console.log('[migration] contributor_system tables created');
  },

  config: { skipTransaction: false }
};
