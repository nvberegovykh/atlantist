/**
 * Owns: DB helpers for the contributor system tables.
 * Does NOT own: HTTP handling, auth, business logic.
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

    // Update running totals atomically
    // lifetime_points only increases; GREATEST ensures no decrease on deductions
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

module.exports = {
  getContributorByUserId,
  getContributorByGithubLogin,
  getContributorById,
  upsertContributor,
  awardPoints,
  getLeaderboard,
  getTotalPoints,
  getContributorRank,
  getTotalContributors
};
