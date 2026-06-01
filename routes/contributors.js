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
