/**
 * Owns: /api/contributors/* — GitHub OAuth, points, Stripe Connect,
 *       contributor contract, leaderboard, admin point awarding,
 *       and profit distribution runs.
 *
 * Does NOT own: billing subscriptions (see routes/billing.js).
 * Stripe account details and product IDs are managed in @atlantist/core (private).
 */
'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const https   = require('https');

const { authMiddleware } = require('./auth');
const {
  getContributorByUserId,
  getContributorByGithubLogin,
  upsertContributor,
  awardPoints,
  getLeaderboard,
  getTotalPoints,
  getContributorRank,
  getTotalContributors,
  getContributorById,
  // Distribution
  getApprovedContributorsWithStripe,
  createDistribution,
  updateDistributionStatus,
  createPayout,
  completePayout,
  failPayout,
  checkAndFlagTaxThresholds
} = require('../db/contributors');

const stripeDist = require('../services/stripe-distribution');
const {
  calculateDistribution,
  payoutContributor,
  createConnectAccount,
  createOnboardingLink
} = stripeDist;

const { encrypt } = require('../lib/encrypt');
const { canonicalUrl } = require('../lib/canonical-url');
const { getWithholdingRate, needs1099, checkW8BENExpiry } = require('../services/tax-compliance');

// ─── Config ──────────────────────────────────────────────────────────────────

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

const GITHUB_OAUTH_SCOPES  = 'read:user,user:email,public_repo';
const GITHUB_REDIRECT_URI  = canonicalUrl('/api/contributors/github/callback');
const CONTRACT_VERSION     = '1.0';

// ─── Shared auth middleware ───────────────────────────────────────────────────

function requireAuth(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── Tiny JSON-over-HTTPS helpers ────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'Atlantist/1.0', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
        });
      }
    ).on('error', reject);
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Accept':         'application/json',
          'User-Agent':     'Atlantist/1.0',
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── GET /api/contributors/github/connect ─────────────────────────────────────
// Redirect user to GitHub OAuth. Sets CSRF state cookie.

router.get('/github/connect', requireAuth, (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(503).json({ error: 'GitHub OAuth is not configured (GITHUB_CLIENT_ID missing).' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('gh_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });

  const params = new URLSearchParams({
    client_id:    GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope:        GITHUB_OAUTH_SCOPES,
    state
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// ─── GET /api/contributors/github/callback ────────────────────────────────────
// Exchange OAuth code → token, fetch GitHub profile, upsert contributor.

router.get('/github/callback', requireAuth, async (req, res) => {
  try {
    const { code, state } = req.query;

    const storedState = req.cookies?.gh_oauth_state;
    if (!state || state !== storedState) {
      return res.status(400).json({ error: 'Invalid OAuth state — possible CSRF attempt.' });
    }
    res.clearCookie('gh_oauth_state');

    if (!code) return res.status(400).json({ error: 'Missing code parameter.' });

    const tokenResponse = await httpsPost('https://github.com/login/oauth/access_token', {
      client_id:     GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri:  GITHUB_REDIRECT_URI
    });

    if (tokenResponse.error) {
      console.error('[contributors] GitHub token exchange failed:', tokenResponse);
      return res.status(400).json({ error: tokenResponse.error_description || tokenResponse.error });
    }

    const accessToken = tokenResponse.access_token;
    if (!accessToken) return res.status(400).json({ error: 'No access token returned from GitHub.' });

    const ghUser = await httpsGet('https://api.github.com/user', {
      Authorization: `Bearer ${accessToken}`
    });

    if (!ghUser.login || !ghUser.id) {
      return res.status(502).json({ error: 'Failed to fetch GitHub user profile.' });
    }

    let encToken = null;
    if (process.env.ENCRYPTION_KEY) {
      encToken = encrypt(accessToken);
    } else {
      console.warn('[contributors] ENCRYPTION_KEY not set — GitHub token will not be stored.');
    }

    await upsertContributor({
      user_id:                 req.user.id,
      github_login:            ghUser.login,
      github_id:               ghUser.id,
      github_access_token_enc: encToken,
      status:                  'pending'
    });

    return res.redirect(canonicalUrl('/app?contributor=connected'));
  } catch (err) {
    console.error('[contributors] GitHub callback error:', err);
    return res.status(500).json({ error: 'GitHub OAuth callback failed.' });
  }
});

// ─── GET /api/contributors/me ─────────────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }

    let rank = null;
    if (contributor.status === 'approved') {
      rank = await getContributorRank(contributor.id);
    }

    // Strip sensitive fields
    const { github_access_token_enc: _tok, ...safe } = contributor;
    return res.json({ contributor: safe, rank });
  } catch (err) {
    console.error('[contributors] /me error:', err);
    return res.status(500).json({ error: 'Failed to fetch contributor profile.' });
  }
});

// ─── GET /api/contributors/leaderboard ───────────────────────────────────────
// Public — top 50 by total_points. No PII, no tokens.

router.get('/leaderboard', async (req, res) => {
  try {
    const contributors = await getLeaderboard(50);
    return res.json({ contributors });
  } catch (err) {
    console.error('[contributors] leaderboard error:', err);
    return res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
});

// ─── POST /api/contributors/stripe/connect ────────────────────────────────────
// Create Stripe Connect Express account and return onboarding URL.

router.post('/stripe/connect', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) return res.status(404).json({ error: 'Not registered as a contributor.' });
    if (contributor.status !== 'approved') {
      return res.status(403).json({ error: 'Only approved contributors can connect Stripe.' });
    }

    let accountId = contributor.stripe_account_id;

    if (!accountId) {
      // Use the stripe-distribution service for consistent account creation
      const account = await createConnectAccount({
        email:       req.user.email || null,
        githubLogin: contributor.github_login
      });
      accountId = account.id;

      const dbPool = require('../db/index');
      await dbPool.query(
        `UPDATE contributors
         SET stripe_account_id = $1, stripe_account_status = 'pending', updated_at = NOW()
         WHERE id = $2`,
        [accountId, contributor.id]
      );
    }

    const link = await createOnboardingLink({
      stripeAccountId: accountId,
      contributorId:   contributor.id
    });

    return res.json({ url: link.url });
  } catch (err) {
    console.error('[contributors] stripe connect error:', err);
    return res.status(500).json({ error: 'Failed to initiate Stripe Connect.' });
  }
});

// ─── GET /api/contributors/stripe/callback ────────────────────────────────────

router.get('/stripe/callback', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor || !contributor.stripe_account_id) {
      return res.redirect(canonicalUrl('/app?stripe=error'));
    }

    // Delegate account retrieval to stripe-distribution stub/core — no direct Stripe init here
    const account   = await stripeDist.retrieveAccount(contributor.stripe_account_id);
    const newStatus = account.details_submitted ? 'active' : 'pending';

    const dbPool = require('../db/index');
    await dbPool.query(
      `UPDATE contributors SET stripe_account_status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, contributor.id]
    );

    return res.redirect(canonicalUrl(`/app?stripe=${newStatus}`));
  } catch (err) {
    console.error('[contributors] stripe callback error:', err);
    return res.redirect(canonicalUrl('/app?stripe=error'));
  }
});

// ─── GET /api/contributors/contract ──────────────────────────────────────────

router.get('/contract', requireAuth, async (req, res) => {
  const path = require('path');
  const fs   = require('fs');
  const contractPath = path.join(__dirname, '..', 'public', 'contributor-contract.html');
  if (!fs.existsSync(contractPath)) {
    return res.status(404).json({ error: 'Contract not found.' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(contractPath);
});

// ─── POST /api/contributors/contract/sign ────────────────────────────────────

router.post('/contract/sign', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) return res.status(404).json({ error: 'Not registered as a contributor.' });
    if (contributor.status !== 'approved') {
      return res.status(403).json({ error: 'Only approved contributors can sign the contract.' });
    }
    if (contributor.contract_signed_at) {
      return res.json({ message: 'Contract already signed.', signed_at: contributor.contract_signed_at });
    }

    const dbPool = require('../db/index');
    const { rows } = await dbPool.query(
      `UPDATE contributors
       SET contract_signed_at = NOW(), contract_version = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING contract_signed_at, contract_version`,
      [CONTRACT_VERSION, contributor.id]
    );

    return res.json({
      message:    'Contract signed successfully.',
      signed_at:  rows[0].contract_signed_at,
      version:    rows[0].contract_version
    });
  } catch (err) {
    console.error('[contributors] contract sign error:', err);
    return res.status(500).json({ error: 'Failed to record contract signature.' });
  }
});

// ─── POST /api/contributors/points/award (admin only) ────────────────────────

router.post('/points/award', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { contributor_id, points, reason, source_type, source_ref } = req.body;

    if (!contributor_id || points === undefined || !reason || !source_type) {
      return res.status(400).json({ error: 'contributor_id, points, reason, and source_type are required.' });
    }
    if (typeof points !== 'number' || !Number.isInteger(points) || points === 0) {
      return res.status(400).json({ error: 'points must be a non-zero integer.' });
    }

    const target = await getContributorById(contributor_id);
    if (!target) return res.status(404).json({ error: 'Contributor not found.' });

    const adminContributor = await getContributorByUserId(req.user.id);
    const ledgerEntry = await awardPoints({
      contributor_id,
      points,
      reason,
      source_type,
      source_ref: source_ref || null,
      awarded_by: adminContributor?.id || null,
      metadata:   { admin_user_id: req.user.id }
    });

    return res.json({ success: true, ledger_entry: ledgerEntry });
  } catch (err) {
    console.error('[contributors] points award error:', err);
    return res.status(500).json({ error: 'Failed to award points.' });
  }
});

// ─── POST /api/contributors/tax/w9 ──────────────────────────────────────────
// Submit W-9 information (US persons).

router.post('/tax/w9', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }

    const { legal_name, tax_id, address, city, state, zip } = req.body;
    if (!legal_name || !tax_id || !address || !city || !state || !zip) {
      return res.status(400).json({ error: 'legal_name, tax_id, address, city, state, and zip are required.' });
    }

    // Encrypt tax_id (SSN/EIN/ITIN) and form PII
    const tax_id_enc = process.env.ENCRYPTION_KEY ? encrypt(tax_id) : null;
    const formData = { legal_name, address, city, state, zip, is_us_person: true };
    const form_data_enc = process.env.ENCRYPTION_KEY ? encrypt(JSON.stringify(formData)) : JSON.stringify(formData);

    const pool = require('../db/index');

    // Insert tax form record
    await pool.query(
      `INSERT INTO contributor_tax_forms
         (contributor_id, form_type, form_data_enc, status)
       VALUES ($1, 'W-9', $2, 'pending')`,
      [contributor.id, form_data_enc]
    );

    // Update contributor record
    await pool.query(
      `UPDATE contributors SET
         is_us_person     = TRUE,
         tax_form_status  = 'w9_submitted',
         us_state         = $1,
         legal_name       = $2,
         tax_id_enc       = $3,
         updated_at       = NOW()
       WHERE id = $4`,
      [state.toUpperCase().slice(0, 2), legal_name, tax_id_enc, contributor.id]
    );

    console.log(`[contributors] W-9 submitted by contributor ${contributor.id}`);
    return res.json({ submitted: true, next: 'awaiting_verification' });
  } catch (err) {
    console.error('[contributors] W-9 submission error:', err);
    return res.status(500).json({ error: 'Failed to submit W-9.' });
  }
});

// ─── POST /api/contributors/tax/w8ben ────────────────────────────────────────
// Submit W-8BEN (foreign individuals).

router.post('/tax/w8ben', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }

    const { legal_name, tax_country, foreign_tin, permanent_address, treaty_article, treaty_rate_claimed } = req.body;
    if (!legal_name || !tax_country || !foreign_tin || !permanent_address) {
      return res.status(400).json({ error: 'legal_name, tax_country, foreign_tin, and permanent_address are required.' });
    }
    if (!/^[A-Z]{2}$/i.test(tax_country)) {
      return res.status(400).json({ error: 'tax_country must be a valid ISO 3166-1 alpha-2 code (e.g. GB, DE, CA).' });
    }

    // Encrypt TIN and address
    const tin_enc = process.env.ENCRYPTION_KEY ? encrypt(foreign_tin) : null;
    const formData = { legal_name, tax_country: tax_country.toUpperCase(), permanent_address, treaty_article, treaty_rate_claimed };
    const form_data_enc = process.env.ENCRYPTION_KEY ? encrypt(JSON.stringify(formData)) : JSON.stringify(formData);

    // W-8BEN expires 3 years from now (end of 3rd calendar year)
    const now = new Date();
    const expiryYear = now.getFullYear() + 3;
    const expires_at = new Date(expiryYear, 11, 31).toISOString();

    const pool = require('../db/index');

    await pool.query(
      `INSERT INTO contributor_tax_forms
         (contributor_id, form_type, form_data_enc, status, expires_at)
       VALUES ($1, 'W-8BEN', $2, 'pending', $3)`,
      [contributor.id, form_data_enc, expires_at]
    );

    const countryCode = tax_country.toUpperCase();
    await pool.query(
      `UPDATE contributors SET
         is_us_person     = FALSE,
         tax_form_status  = 'w8ben_submitted',
         tax_country      = $1,
         legal_name       = $2,
         tax_id_enc       = $3,
         needs_w8ben      = TRUE,
         updated_at       = NOW()
       WHERE id = $4`,
      [countryCode, legal_name, tin_enc, contributor.id]
    );

    // Return withholding rate based on current status
    const updated = { ...contributor, is_us_person: false, tax_form_status: 'w8ben_submitted', tax_country: countryCode };
    const withholdingInfo = getWithholdingRate(updated);

    console.log(`[contributors] W-8BEN submitted by contributor ${contributor.id} (country=${countryCode})`);
    return res.json({
      submitted: true,
      next: 'awaiting_verification',
      withholding_rate: withholdingInfo.rate,
      withholding_reason: withholdingInfo.reason
    });
  } catch (err) {
    console.error('[contributors] W-8BEN submission error:', err);
    return res.status(500).json({ error: 'Failed to submit W-8BEN.' });
  }
});

// ─── GET /api/contributors/tax/status ────────────────────────────────────────
// Get the authenticated contributor's own tax compliance status.

router.get('/tax/status', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }

    const withholdingInfo = getWithholdingRate(contributor);
    const needs1099Flag   = needs1099(contributor);
    const w8benExpiry     = contributor.is_us_person === false ? checkW8BENExpiry(contributor) : null;

    return res.json({
      form_status:       contributor.tax_form_status || 'not_submitted',
      is_us_person:      contributor.is_us_person,
      tax_country:       contributor.tax_country,
      withholding_rate:  withholdingInfo.rate,
      withholding_reason: withholdingInfo.reason,
      needs_1099:        needs1099Flag,
      ytd_payout_cents:  contributor.ytd_payout_cents || 0,
      required_action:   withholdingInfo.requiresAction || null,
      w8ben_expiry:      w8benExpiry
    });
  } catch (err) {
    console.error('[contributors] tax status error:', err);
    return res.status(500).json({ error: 'Failed to fetch tax status.' });
  }
});

// ─── GET /api/contributors/tax/summary/:year (admin only) ────────────────────
// Year-end tax summary for 1099 / FATCA reporting.

router.get('/tax/summary/:year', requireAuth, requireAdmin, async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: 'Invalid tax year.' });
    }

    const pool = require('../db/index');
    const { rows } = await pool.query(
      `SELECT
         c.id, c.github_login, c.legal_name, c.is_us_person, c.tax_country,
         c.tax_form_status, c.withholding_rate, c.needs_1099, c.ytd_payout_cents,
         cts.total_paid_cents, cts.total_withheld_cents, cts.form_type,
         cts.reported_to_irs, cts.reported_at
       FROM contributors c
       LEFT JOIN contributor_tax_summaries cts
         ON cts.contributor_id = c.id AND cts.tax_year = $1
       WHERE c.ytd_payout_cents > 0
          OR cts.total_paid_cents > 0
       ORDER BY COALESCE(cts.total_paid_cents, 0) DESC`,
      [year]
    );

    // Flag contributors needing 1099 or FATCA attention
    const annotated = rows.map(r => ({
      ...r,
      needs_1099:   !!(r.is_us_person && (r.total_paid_cents || 0) >= 60000),
      fatca_flag:   !r.is_us_person && (r.total_paid_cents || 0) >= 5000000
    }));

    const summary = {
      tax_year:          year,
      total_contributors: rows.length,
      total_paid_cents:   rows.reduce((s, r) => s + Number(r.total_paid_cents || 0), 0),
      total_withheld_cents: rows.reduce((s, r) => s + Number(r.total_withheld_cents || 0), 0),
      need_1099_count:    annotated.filter(r => r.needs_1099).length,
      fatca_count:        annotated.filter(r => r.fatca_flag).length,
      contributors:       annotated
    };

    return res.json(summary);
  } catch (err) {
    console.error('[contributors] tax summary error:', err);
    return res.status(500).json({ error: 'Failed to fetch tax summary.' });
  }
});

// ─── POST /api/contributors/tax/verify/:contributorId (admin only) ────────────
// Mark a contributor's tax form as verified and recalculate withholding.

router.post('/tax/verify/:contributorId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const contributorId = parseInt(req.params.contributorId, 10);
    const contributor = await getContributorById(contributorId);
    if (!contributor) {
      return res.status(404).json({ error: 'Contributor not found.' });
    }

    const pool = require('../db/index');

    // Update the latest pending tax form to verified
    await pool.query(
      `UPDATE contributor_tax_forms SET
         status       = 'verified',
         verified_at  = NOW(),
         verified_by  = $1
       WHERE contributor_id = $2
         AND status = 'pending'
         AND id = (
           SELECT id FROM contributor_tax_forms
           WHERE contributor_id = $2 AND status = 'pending'
           ORDER BY submitted_at DESC
           LIMIT 1
         )`,
      [req.user.id, contributorId]
    );

    // Compute new withholding rate
    const verifiedContributor = { ...contributor, tax_form_status: 'verified' };
    const withholdingInfo = getWithholdingRate(verifiedContributor);

    // Update contributor record
    await pool.query(
      `UPDATE contributors SET
         tax_form_status  = 'verified',
         withholding_rate = $1,
         updated_at       = NOW()
       WHERE id = $2`,
      [withholdingInfo.rate, contributorId]
    );

    // Notification placeholder — replace with email service when available
    console.log(`[contributors] Tax form verified for contributor ${contributorId} by admin ${req.user.id}. New withholding rate: ${withholdingInfo.rate}`);

    return res.json({
      verified: true,
      contributor_id: contributorId,
      new_withholding_rate: withholdingInfo.rate,
      withholding_reason: withholdingInfo.reason
    });
  } catch (err) {
    console.error('[contributors] tax verify error:', err);
    return res.status(500).json({ error: 'Failed to verify tax form.' });
  }
});

// ─── GET /api/contributors/stats ─────────────────────────────────────────────
// Public aggregate stats.

router.get('/stats', async (req, res) => {
  try {
    const [totalContributors, totalPoints] = await Promise.all([
      getTotalContributors(),
      getTotalPoints()
    ]);

    const now = new Date();
    const nextDistribution = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return res.json({
      total_contributors:    totalContributors,
      total_points:          totalPoints,
      next_distribution_date: nextDistribution.toISOString().split('T')[0]
    });
  } catch (err) {
    console.error('[contributors] stats error:', err);
    return res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// ─── POST /api/contributors/distributions/run (admin only) ────────────────────
//
// Executes a full profit distribution cycle:
//   1. Receive gross_revenue_cents + operating_costs_cents from admin
//   2. Estimate Stripe fees (or accept manual stripe_fees_cents override)
//   3. Calculate net profit, 20% Wallt fund, 80% contributor pool
//   4. Snapshot total approved points
//   5. Create profit_distributions record
//   6. For each approved contributor with stripe_account_status='active':
//      a. Calculate their share of the 80% pool
//      b. Create contributor_payouts record
//      c. Execute Stripe Connect transfer
//      d. Mark payout completed/failed
//   7. Run 1099 / tax threshold checks
//   8. Mark distribution completed
//   9. Return summary

router.post('/distributions/run', requireAuth, requireAdmin, async (req, res) => {
  const {
    period_start,
    period_end,
    gross_revenue_cents,
    operating_costs_cents = 0,
    stripe_fees_cents: manualStripeFeeCents // optional override; estimated if omitted
  } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!period_start || !period_end) {
    return res.status(400).json({ error: 'period_start and period_end are required (YYYY-MM-DD).' });
  }
  if (typeof gross_revenue_cents !== 'number' || gross_revenue_cents <= 0) {
    return res.status(400).json({ error: 'gross_revenue_cents must be a positive integer.' });
  }
  if (typeof operating_costs_cents !== 'number' || operating_costs_cents < 0) {
    return res.status(400).json({ error: 'operating_costs_cents must be >= 0.' });
  }

  // Validate date strings
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(period_start) || !dateRe.test(period_end)) {
    return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
  }
  if (period_start >= period_end) {
    return res.status(400).json({ error: 'period_start must be before period_end.' });
  }

  let distribution = null;

  try {
    // ── Step 1: Calculate net profit + split ─────────────────────────────────
    const { estimateStripeFees } = stripeDist;
    const stripeFeeCents = manualStripeFeeCents != null
      ? manualStripeFeeCents
      : estimateStripeFees(gross_revenue_cents);

    const { netProfit, walltFund, contributorPool } = await calculateDistribution({
      grossRevenueCents:    gross_revenue_cents,
      operatingCostsCents:  operating_costs_cents,
      stripeFeeCents
    });

    if (netProfit <= 0) {
      return res.status(422).json({
        error: 'Net profit is zero or negative after costs — no distribution to run.',
        net_profit_cents: netProfit
      });
    }

    // ── Step 2: Snapshot approved contributor points ──────────────────────────
    const contributors = await getApprovedContributorsWithStripe();
    const totalPointsSnapshot = await getTotalPoints();

    if (totalPointsSnapshot === 0) {
      return res.status(422).json({ error: 'No contributor points to distribute against.' });
    }

    // ── Step 3: Create distribution record ───────────────────────────────────
    distribution = await createDistribution({
      period_start,
      period_end,
      gross_revenue_cents,
      operating_costs_cents,
      stripe_fees_cents:     stripeFeeCents,
      total_profit_cents:    netProfit,
      wallt_fund_cents:      walltFund,
      contributor_pool_cents: contributorPool,
      total_points_snapshot: totalPointsSnapshot
    });

    await updateDistributionStatus(distribution.id, 'processing');

    console.log(
      `[distributions] Run ${distribution.id}: net=${netProfit}¢ wallt=${walltFund}¢ pool=${contributorPool}¢ ` +
      `contributors=${contributors.length} totalPts=${totalPointsSnapshot}`
    );

    // ── Step 4: Pay each contributor ─────────────────────────────────────────
    const payoutSummary = [];
    const paidContributorIds = [];

    for (const contributor of contributors) {
      if (!contributor.total_points || contributor.total_points <= 0) {
        console.log(`[distributions] Skipping ${contributor.github_login}: 0 points`);
        continue;
      }

      const sharePct  = (contributor.total_points / totalPointsSnapshot) * 100;
      const grossAmt  = Math.floor(contributorPool * (contributor.total_points / totalPointsSnapshot));
      const netAmt    = grossAmt; // No automatic withholding — flagged for manual review

      // Create the payout record first (so we have an ID even if transfer fails)
      const payout = await createPayout({
        distribution_id:    distribution.id,
        contributor_id:     contributor.id,
        points_snapshot:    contributor.total_points,
        share_pct:          sharePct,
        gross_amount_cents: grossAmt,
        net_amount_cents:   netAmt
      });

      // Attempt Stripe transfer
      let transferResult;
      try {
        transferResult = await payoutContributor({
          stripeAccountId: contributor.stripe_account_id,
          amountCents:     netAmt,
          distributionId:  distribution.id,
          contributorId:   contributor.id
        });

        if (transferResult.skipped) {
          await failPayout(payout.id, transferResult.reason);
          payoutSummary.push({
            contributor_id:   contributor.id,
            github_login:     contributor.github_login,
            net_amount_cents: netAmt,
            status:           'skipped',
            reason:           transferResult.reason
          });
        } else {
          await completePayout(payout.id, transferResult.id, contributor.id, netAmt);
          paidContributorIds.push(contributor.id);
          payoutSummary.push({
            contributor_id:    contributor.id,
            github_login:      contributor.github_login,
            net_amount_cents:  netAmt,
            share_pct:         sharePct.toFixed(4),
            stripe_transfer_id: transferResult.id,
            status:            'completed'
          });
        }
      } catch (stripeErr) {
        console.error(`[distributions] Stripe transfer failed for ${contributor.github_login}:`, stripeErr.message);
        await failPayout(payout.id, stripeErr.message);
        payoutSummary.push({
          contributor_id:   contributor.id,
          github_login:     contributor.github_login,
          net_amount_cents: netAmt,
          status:           'failed',
          error:            stripeErr.message
        });
      }
    }

    // ── Step 5: Tax threshold checks ─────────────────────────────────────────
    const flagged = paidContributorIds.length > 0
      ? await checkAndFlagTaxThresholds(paidContributorIds)
      : [];

    // ── Step 6: Mark distribution complete ───────────────────────────────────
    await updateDistributionStatus(distribution.id, 'completed');

    return res.json({
      distribution_id:       distribution.id,
      period_start,
      period_end,
      gross_revenue_cents,
      stripe_fees_cents:     stripeFeeCents,
      operating_costs_cents,
      net_profit_cents:      netProfit,
      wallt_fund_cents:      walltFund,
      contributor_pool_cents: contributorPool,
      total_points_snapshot: totalPointsSnapshot,
      payouts:               payoutSummary,
      tax_flagged_count:     flagged.length,
      note: walltFund > 0
        ? `Wallt AI Development Fund reserve: $${(walltFund / 100).toFixed(2)} stays in the platform Stripe account.`
        : undefined
    });
  } catch (err) {
    console.error('[distributions] Run failed:', err);

    // Attempt to mark distribution as failed if it was created
    if (distribution?.id) {
      await updateDistributionStatus(distribution.id, 'failed').catch(() => {});
    }

    return res.status(500).json({ error: 'Distribution run failed: ' + err.message });
  }
});

module.exports = router;
