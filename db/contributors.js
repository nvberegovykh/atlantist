/**
 * Owns: DB helpers for the contributor system tables.
 * Does NOT own: HTTP handling, auth, business logic, Stripe API calls.
 */
'use strict';

const pool = require('./index');

// ─── contributors ────────────────────────────────────────────────────────────

/**
 * Fetch a contributor record by the platform user_id.
 * @param {number} userId
 */
async function getContributorByUserId(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM contributors WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

/**
 * Fetch a contributor record by GitHub login (case-insensitive).
 * @param {string} githubLogin
 */
async function getContributorByGithubLogin(githubLogin) {
  const { rows } = await pool.query(
    'SELECT * FROM contributors WHERE LOWER(github_login) = LOWER($1) LIMIT 1',
    [githubLogin]
  );
  return rows[0] || null;
}

/**
 * Fetch a contributor record by ID.
 * @param {number} id
 */
async function getContributorById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM contributors WHERE id = $1 LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

/**
 * Insert or update a contributor row.
 * Conflict target: github_id (unique per GitHub account).
 *
 * @param {object} data
 * @param {number|null} data.user_id
 * @param {string}       data.github_login
 * @param {number}       data.github_id
 * @param {string|null}  data.github_access_token_enc
 * @param {string|null}  [data.stripe_account_id]
 * @param {string|null}  [data.stripe_account_status]
 * @param {string|null}  [data.status]
 */
async function upsertContributor(data) {
  const {
    user_id = null,
    github_login,
    github_id,
    github_access_token_enc = null,
    stripe_account_id = null,
    stripe_account_status = 'not_connected',
    status = 'pending'
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO contributors
       (user_id, github_login, github_id, github_access_token_enc,
        stripe_account_id, stripe_account_status, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       user_id                 = EXCLUDED.user_id,
       github_login            = EXCLUDED.github_login,
       github_access_token_enc = COALESCE(EXCLUDED.github_access_token_enc, contributors.github_access_token_enc),
       stripe_account_id       = COALESCE(EXCLUDED.stripe_account_id, contributors.stripe_account_id),
       stripe_account_status   = EXCLUDED.stripe_account_status,
       updated_at              = NOW()
     RETURNING *`,
    [user_id, github_login, github_id, github_access_token_enc,
     stripe_account_id, stripe_account_status, status]
  );
  return rows[0];
}

// ─── contribution_points ledger ──────────────────────────────────────────────

/**
 * Award (or deduct if negative) points to a contributor.
 * Atomically inserts a ledger row and updates contributors.total_points
 * and contributors.lifetime_points (lifetime never decreases).
 *
 * @param {object} data
 * @param {number}  data.contributor_id
 * @param {number}  data.points          — positive = earn, negative = deduct
 * @param {string}  data.reason
 * @param {string}  data.source_type
 * @param {string|null} [data.source_ref]
 * @param {number|null} [data.awarded_by]  — contributor.id of awarding contributor
 * @param {object}  [data.metadata]
 */
async function awardPoints(data) {
  const {
    contributor_id,
    points,
    reason,
    source_type,
    source_ref = null,
    awarded_by = null,
    metadata = {}
  } = data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert ledger entry
    const { rows: ledgerRows } = await client.query(
      `INSERT INTO contribution_points
         (contributor_id, points, reason, source_type, source_ref, awarded_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [contributor_id, points, reason, source_type, source_ref, awarded_by, JSON.stringify(metadata)]
    );

    // Update running totals atomically.
    // lifetime_points only increases; GREATEST ensures no decrease on deductions.
    await client.query(
      `UPDATE contributors SET
         total_points    = total_points + $2,
         lifetime_points = GREATEST(lifetime_points, lifetime_points + $2),
         updated_at      = NOW()
       WHERE id = $1`,
      [contributor_id, points]
    );

    await client.query('COMMIT');
    return ledgerRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── leaderboard / stats ─────────────────────────────────────────────────────

/**
 * Return top N contributors ordered by total_points descending.
 * Only returns public-safe fields — no access tokens, no PII.
 * @param {number} [limit=50]
 */
async function getLeaderboard(limit = 50) {
  const { rows } = await pool.query(
    `SELECT
       id,
       github_login,
       total_points,
       lifetime_points,
       status,
       contract_signed_at IS NOT NULL AS has_signed_contract,
       created_at
     FROM contributors
     WHERE status = 'approved'
     ORDER BY total_points DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Return the sum of total_points across all approved contributors.
 */
async function getTotalPoints() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_points), 0)::BIGINT AS total
     FROM contributors
     WHERE status = 'approved'`
  );
  return Number(rows[0].total);
}

/**
 * Return the 1-based rank of a contributor in the total_points leaderboard.
 * @param {number} contributorId
 */
async function getContributorRank(contributorId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM contributors
     WHERE status = 'approved'
       AND total_points > (
         SELECT total_points FROM contributors WHERE id = $1
       )`,
    [contributorId]
  );
  return Number(rows[0].rank);
}

/**
 * Return total number of approved contributors.
 */
async function getTotalContributors() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT AS count FROM contributors WHERE status = 'approved'`
  );
  return rows[0].count;
}

// ─── Distribution / payout tracking ─────────────────────────────────────────

/**
 * Fetch all approved contributors who have an active Stripe account.
 * Used when executing a profit distribution run.
 */
async function getApprovedContributorsWithStripe() {
  const { rows } = await pool.query(
    `SELECT id, github_login, stripe_account_id, total_points,
            needs_1099, tax_form_status, yearly_payout_cents
     FROM contributors
     WHERE status = 'approved'
       AND stripe_account_status = 'active'
       AND stripe_account_id IS NOT NULL
     ORDER BY total_points DESC`
  );
  return rows;
}

/**
 * Create a profit_distributions record.
 *
 * @param {object} data
 * @param {string} data.period_start
 * @param {string} data.period_end
 * @param {number} data.gross_revenue_cents
 * @param {number} data.operating_costs_cents
 * @param {number} data.stripe_fees_cents
 * @param {number} data.total_profit_cents       — net profit
 * @param {number} data.wallt_fund_cents
 * @param {number} data.contributor_pool_cents
 * @param {number} data.total_points_snapshot
 * @returns {object} Row from profit_distributions
 */
async function createDistribution(data) {
  const {
    period_start,
    period_end,
    gross_revenue_cents,
    operating_costs_cents,
    stripe_fees_cents,
    total_profit_cents,
    wallt_fund_cents,
    contributor_pool_cents,
    total_points_snapshot
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO profit_distributions
       (period_start, period_end,
        total_profit_cents, total_points_snapshot,
        wallt_fund_cents, contributor_pool_cents,
        operating_costs_cents, stripe_fees_cents,
        status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW())
     RETURNING *`,
    [
      period_start, period_end,
      total_profit_cents, total_points_snapshot,
      wallt_fund_cents, contributor_pool_cents,
      operating_costs_cents, stripe_fees_cents
    ]
  );
  return rows[0];
}

/**
 * Update distribution status (pending → processing → completed | failed).
 * @param {number} distributionId
 * @param {string} status
 */
async function updateDistributionStatus(distributionId, status) {
  await pool.query(
    `UPDATE profit_distributions
     SET status = $2, processed_at = CASE WHEN $2 IN ('completed','failed') THEN NOW() ELSE processed_at END
     WHERE id = $1`,
    [distributionId, status]
  );
}

/**
 * Create a contributor_payouts row and return it.
 *
 * @param {object} data
 * @param {number} data.distribution_id
 * @param {number} data.contributor_id
 * @param {number} data.points_snapshot
 * @param {number} data.share_pct           — 0-100, up to 6 decimal places
 * @param {number} data.gross_amount_cents
 * @param {number} data.net_amount_cents
 * @returns {object}
 */
async function createPayout(data) {
  const {
    distribution_id,
    contributor_id,
    points_snapshot,
    share_pct,
    gross_amount_cents,
    net_amount_cents
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO contributor_payouts
       (distribution_id, contributor_id, points_snapshot, share_pct,
        gross_amount_cents, tax_withheld_cents, net_amount_cents, status)
     VALUES ($1,$2,$3,$4,$5,0,$6,'pending')
     RETURNING *`,
    [distribution_id, contributor_id, points_snapshot, share_pct,
     gross_amount_cents, net_amount_cents]
  );
  return rows[0];
}

/**
 * Mark a payout as completed and record the Stripe transfer ID.
 * Also increments the contributor's yearly_payout_cents for 1099 tracking.
 *
 * @param {number} payoutId
 * @param {string} stripeTransferId
 * @param {number} contributorId
 * @param {number} netAmountCents
 */
async function completePayout(payoutId, stripeTransferId, contributorId, netAmountCents) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE contributor_payouts
       SET status = 'completed', stripe_transfer_id = $2
       WHERE id = $1`,
      [payoutId, stripeTransferId]
    );

    // Accumulate yearly payout total on the contributor row
    await client.query(
      `UPDATE contributors
       SET yearly_payout_cents = yearly_payout_cents + $2,
           updated_at = NOW()
       WHERE id = $1`,
      [contributorId, netAmountCents]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a payout as failed (Stripe transfer rejected or below minimum).
 * @param {number} payoutId
 * @param {string} reason — short reason string stored in metadata via direct update
 */
async function failPayout(payoutId, reason) {
  await pool.query(
    `UPDATE contributor_payouts SET status = 'failed' WHERE id = $1`,
    [payoutId]
  );
  console.warn(`[db/contributors] Payout ${payoutId} marked failed: ${reason}`);
}

/**
 * Check and flag contributors who hit the US $600/year 1099-NEC threshold,
 * or who need a W-8BEN (non-US contributors who have received any payment).
 *
 * Call after each distribution run completes. This does NOT auto-withhold —
 * it sets flags for manual review.
 *
 * @param {number[]} contributorIds — IDs to check
 */
async function checkAndFlagTaxThresholds(contributorIds) {
  if (!contributorIds.length) return;

  // Flag US contributors at $600+ yearly for 1099-NEC
  // We don't know country from our data, so we flag anyone above the threshold
  // and let the admin determine US vs non-US for the appropriate form.
  const { rows: flagged } = await pool.query(
    `UPDATE contributors
     SET needs_1099 = TRUE,
         tax_form_status = CASE
           WHEN tax_form_status = 'not_required' THEN 'pending_1099'
           ELSE tax_form_status
         END,
         updated_at = NOW()
     WHERE id = ANY($1)
       AND yearly_payout_cents >= 60000  -- $600 in cents
       AND needs_1099 = FALSE
     RETURNING id, github_login, yearly_payout_cents`,
    [contributorIds]
  );

  for (const row of flagged) {
    console.warn(
      `[tax] Contributor ${row.github_login} (id=${row.id}) has received ` +
      `$${(row.yearly_payout_cents / 100).toFixed(2)} this year — flagged for 1099-NEC review.`
    );
  }

  return flagged;
}

/**
 * Reset yearly_payout_cents to 0 for all contributors at the start of a new year.
 * Call this via a cron job on Jan 1 each year.
 */
async function resetYearlyPayoutTotals() {
  await pool.query(
    `UPDATE contributors SET yearly_payout_cents = 0, updated_at = NOW()`
  );
  console.log('[db/contributors] Yearly payout totals reset for new year.');
}

module.exports = {
  // Core CRUD
  getContributorByUserId,
  getContributorByGithubLogin,
  getContributorById,
  upsertContributor,
  // Points
  awardPoints,
  // Leaderboard / stats
  getLeaderboard,
  getTotalPoints,
  getContributorRank,
  getTotalContributors,
  // Distribution
  getApprovedContributorsWithStripe,
  createDistribution,
  updateDistributionStatus,
  createPayout,
  completePayout,
  failPayout,
  // Tax
  checkAndFlagTaxThresholds,
  resetYearlyPayoutTotals
};
