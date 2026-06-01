/**
 * Migration: contributor_system_v2
 *
 * Additive patch on top of 1748800000000_contributor_system:
 *
 *   1. profit_distributions — add wallt_fund_cents, contributor_pool_cents,
 *      operating_costs_cents, stripe_fees_cents columns (all BIGINT DEFAULT 0)
 *
 *   2. contributors — add needs_1099 (US $600 threshold flag),
 *      tax_form_status (W-8BEN / 1099 review state),
 *      yearly_payout_cents (running calendar-year total for threshold tracking)
 *
 *   3. Stripe product constants recorded as a comment / DB-level config row
 *      (no new table — just documented here for reference):
 *        prod_UcdPcDTajwsJ16 — Wallt AI Development Fund
 *        prod_UcdPtje9qCXKvi — Atlantist Contributor Payout Pool
 *      Master Stripe account: acct_1QObHbJfDJuPadAF (Liber Creative LLC)
 *
 *   4. Owner seed — if app_users contains nvberegovykh@liberpict.com,
 *      insert a contributors row for github_login='nvberegovykh' (10 000 founding
 *      points, status='approved', contract_signed). Idempotent ON CONFLICT DO NOTHING.
 *
 * All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS — fully idempotent.
 */
'use strict';

module.exports = {
  name: '1748810000000_contributor_system_v2',

  async up(pool) {
    // ── 1. profit_distributions: new split columns ────────────────────────────
    await pool.query(`
      ALTER TABLE profit_distributions
        ADD COLUMN IF NOT EXISTS wallt_fund_cents        BIGINT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS contributor_pool_cents  BIGINT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS operating_costs_cents   BIGINT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS stripe_fees_cents       BIGINT DEFAULT 0
    `);

    // ── 2. contributors: tax-flag columns + yearly payout tracker ─────────────
    await pool.query(`
      ALTER TABLE contributors
        ADD COLUMN IF NOT EXISTS needs_1099          BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS tax_form_status     VARCHAR(50) DEFAULT 'not_required',
        ADD COLUMN IF NOT EXISTS yearly_payout_cents BIGINT  DEFAULT 0
    `);
    // tax_form_status values: not_required | pending_w8ben | w8ben_received | pending_1099 | 1099_issued

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contributors_needs_1099
        ON contributors(needs_1099) WHERE needs_1099 = TRUE
    `);

    // ── 3. contributor_payouts: track calendar year for 1099 resets ──────────
    await pool.query(`
      ALTER TABLE contributor_payouts
        ADD COLUMN IF NOT EXISTS payout_year SMALLINT GENERATED ALWAYS AS
          (EXTRACT(YEAR FROM created_at)::SMALLINT) STORED
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contributor_payouts_year_contributor
        ON contributor_payouts(payout_year, contributor_id)
    `);

    // ── 4. Owner seed — nvberegovykh founding contributor ─────────────────────
    //
    // Strategy:
    //   a. Find the app_users row for nvberegovykh@liberpict.com
    //   b. If found, insert contributors row (ON CONFLICT DO NOTHING on github_login)
    //   c. If the row was inserted, seed 10 000 founding points in contribution_points
    //      and set contributors.total_points / lifetime_points = 10000
    //
    // github_id for nvberegovykh: we use a sentinel value (-1) if the real
    // GitHub numeric ID is not known at migration time; the GitHub OAuth callback
    // will UPDATE the row to the real ID when the owner first connects.
    // We use a placeholder negative ID so the UNIQUE constraint doesn't block
    // real accounts. The callback uses ON CONFLICT (github_id) DO UPDATE, so
    // once the real ID is known the row will be updated correctly.
    //
    // NOTE: If GITHUB_ID for nvberegovykh is known at seed time, replace -1 below.

    const ownerEmail = 'nvberegovykh@liberpict.com';
    const ownerLogin = 'nvberegovykh';
    const FOUNDING_POINTS = 10000;
    const PLACEHOLDER_GITHUB_ID = -1; // updated when owner completes OAuth

    const { rows: userRows } = await pool.query(
      `SELECT id FROM app_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [ownerEmail]
    );

    if (userRows.length === 0) {
      console.log(`[migration v2] No app_users row for ${ownerEmail} — skipping owner seed.`);
    } else {
      const ownerUserId = userRows[0].id;

      // Insert contributor (idempotent)
      const { rows: inserted } = await pool.query(
        `INSERT INTO contributors
           (user_id, github_login, github_id, status,
            approved_at, contract_signed_at, contract_version,
            total_points, lifetime_points,
            needs_1099, tax_form_status,
            created_at, updated_at)
         VALUES
           ($1, $2, $3, 'approved',
            NOW(), NOW(), '1.0',
            $4, $4,
            FALSE, 'not_required',
            NOW(), NOW())
         ON CONFLICT (github_login) DO NOTHING
         RETURNING id`,
        [ownerUserId, ownerLogin, PLACEHOLDER_GITHUB_ID, FOUNDING_POINTS]
      );

      if (inserted.length > 0) {
        const contributorId = inserted[0].id;
        // Seed the founding points ledger entry
        await pool.query(
          `INSERT INTO contribution_points
             (contributor_id, points, reason, source_type, metadata)
           VALUES
             ($1, $2, 'Founding contributor bonus — platform owner', 'manual',
              '{"seed": true, "note": "Founding 10000-point bonus for nvberegovykh"}')`,
          [contributorId, FOUNDING_POINTS]
        );
        console.log(`[migration v2] Owner contributor seeded: id=${contributorId}, ${FOUNDING_POINTS} founding points.`);
      } else {
        console.log(`[migration v2] Owner contributor already exists — skipping seed.`);
      }
    }

    console.log('[migration v2] contributor_system_v2 complete.');
  },

  config: { skipTransaction: false }
};
