/**
 * Owns: /api/contributors/* — GitHub OAuth, points, Stripe Connect,
 *       contributor contract, leaderboard, and admin point awarding.
 * Does NOT own: billing subscriptions (see routes/billing.js).
 */
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');

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
  getContributorById
} = require('../db/contributors');
const { encrypt } = require('../lib/encrypt');
const { canonicalUrl } = require('../lib/canonical-url');

// ─── Config ──────────────────────────────────────────────────────────────────

const GITHUB_CLIENT_ID      = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET  = process.env.GITHUB_CLIENT_SECRET;
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;

const GITHUB_OAUTH_SCOPES   = 'read:user,user:email,public_repo';
const GITHUB_REDIRECT_URI   = canonicalUrl('/api/contributors/github/callback');
const STRIPE_REDIRECT_URI   = canonicalUrl('/api/contributors/stripe/callback');
const CONTRACT_VERSION      = '1.0';

// Lazy Stripe loader — same pattern as billing.js
function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
}

// ─── Shared auth middleware ───────────────────────────────────────────────────

// Require a logged-in app_users session
function requireAuth(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    next();
  });
}

// Require admin role
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── Tiny JSON-over-HTTPS helper (avoids adding axios) ───────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Atlantist/1.0', ...headers }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
        'User-Agent': 'Atlantist/1.0',
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── POST /api/contributors/github/connect ────────────────────────────────────
// Redirect user to GitHub OAuth authorization page.

router.get('/github/connect', requireAuth, (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(503).json({ error: 'GitHub OAuth is not configured (GITHUB_CLIENT_ID missing).' });
  }

  // CSRF state: random token stored in session
  const state = crypto.randomBytes(16).toString('hex');
  // Store state in a signed cookie (session-level; expires when browser closes)
  res.cookie('gh_oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope: GITHUB_OAUTH_SCOPES,
    state
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// ─── GET /api/contributors/github/callback ───────────────────────────────────
// Exchange OAuth code for token, fetch GitHub profile, upsert contributor.

router.get('/github/callback', requireAuth, async (req, res) => {
  try {
    const { code, state } = req.query;

    // CSRF check
    const storedState = req.cookies?.gh_oauth_state;
    if (!state || state !== storedState) {
      return res.status(400).json({ error: 'Invalid OAuth state — possible CSRF attempt.' });
    }
    res.clearCookie('gh_oauth_state');

    if (!code) {
      return res.status(400).json({ error: 'Missing code parameter.' });
    }

    // Exchange code for access token
    const tokenResponse = await httpsPost(
      'https://github.com/login/oauth/access_token',
      {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI
      }
    );

    if (tokenResponse.error) {
      console.error('[contributors] GitHub OAuth token exchange failed:', tokenResponse);
      return res.status(400).json({ error: tokenResponse.error_description || tokenResponse.error });
    }

    const accessToken = tokenResponse.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'No access token returned from GitHub.' });
    }

    // Fetch GitHub user profile
    const ghUser = await httpsGet('https://api.github.com/user', {
      Authorization: `Bearer ${accessToken}`
    });

    if (!ghUser.login || !ghUser.id) {
      return res.status(502).json({ error: 'Failed to fetch GitHub user profile.' });
    }

    // Encrypt access token before storing
    let encToken = null;
    if (process.env.ENCRYPTION_KEY) {
      encToken = encrypt(accessToken);
    } else {
      console.warn('[contributors] ENCRYPTION_KEY not set — GitHub token will not be stored.');
    }

    // Upsert contributor record
    await upsertContributor({
      user_id: req.user.id,
      github_login: ghUser.login,
      github_id: ghUser.id,
      github_access_token_enc: encToken,
      status: 'pending'
    });

    return res.redirect(canonicalUrl('/app?contributor=connected'));
  } catch (err) {
    console.error('[contributors] GitHub callback error:', err);
    return res.status(500).json({ error: 'GitHub OAuth callback failed.' });
  }
});

// ─── GET /api/contributors/me ─────────────────────────────────────────────────
// Return current user's contributor profile + rank.

router.get('/me', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }

    // Compute rank (only meaningful for approved contributors)
    let rank = null;
    if (contributor.status === 'approved') {
      rank = await getContributorRank(contributor.id);
    }

    // Strip sensitive fields from response
    const { github_access_token_enc: _token, ...safe } = contributor;
    return res.json({ contributor: safe, rank });
  } catch (err) {
    console.error('[contributors] /me error:', err);
    return res.status(500).json({ error: 'Failed to fetch contributor profile.' });
  }
});

// ─── GET /api/contributors/leaderboard ───────────────────────────────────────
// Public — top 50 contributors by total_points. No PII, no tokens.

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
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }
    if (contributor.status !== 'approved') {
      return res.status(403).json({ error: 'Only approved contributors can connect Stripe.' });
    }

    const stripe = getStripe();

    // Create or reuse Stripe account
    let accountId = contributor.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: req.user.email || undefined,
        metadata: { contributor_id: String(contributor.id), github_login: contributor.github_login }
      });
      accountId = account.id;

      // Persist the new Stripe account ID
      const pool = require('../db/index');
      await pool.query(
        `UPDATE contributors SET stripe_account_id = $1, stripe_account_status = 'pending', updated_at = NOW() WHERE id = $2`,
        [accountId, contributor.id]
      );
    }

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: canonicalUrl('/api/contributors/stripe/connect'),
      return_url: STRIPE_REDIRECT_URI,
      type: 'account_onboarding'
    });

    return res.json({ url: accountLink.url });
  } catch (err) {
    console.error('[contributors] stripe connect error:', err);
    return res.status(500).json({ error: 'Failed to initiate Stripe Connect.' });
  }
});

// ─── GET /api/contributors/stripe/callback ────────────────────────────────────
// Stripe returns user here after onboarding. Check account status.

router.get('/stripe/callback', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor || !contributor.stripe_account_id) {
      return res.redirect(canonicalUrl('/app?stripe=error'));
    }

    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(contributor.stripe_account_id);
    const newStatus = account.details_submitted ? 'active' : 'pending';

    const pool = require('../db/index');
    await pool.query(
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
// Return the contributor contract (served from public/contributor-contract.html).

router.get('/contract', requireAuth, async (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const contractPath = path.join(__dirname, '..', 'public', 'contributor-contract.html');
  if (!fs.existsSync(contractPath)) {
    return res.status(404).json({ error: 'Contract not found.' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(contractPath);
});

// ─── POST /api/contributors/contract/sign ────────────────────────────────────
// Record that the authenticated contributor signed the contract.

router.post('/contract/sign', requireAuth, async (req, res) => {
  try {
    const contributor = await getContributorByUserId(req.user.id);
    if (!contributor) {
      return res.status(404).json({ error: 'Not registered as a contributor.' });
    }
    if (contributor.status !== 'approved') {
      return res.status(403).json({ error: 'Only approved contributors can sign the contract.' });
    }
    if (contributor.contract_signed_at) {
      return res.json({ message: 'Contract already signed.', signed_at: contributor.contract_signed_at });
    }

    const pool = require('../db/index');
    const { rows } = await pool.query(
      `UPDATE contributors
       SET contract_signed_at = NOW(), contract_version = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING contract_signed_at, contract_version`,
      [CONTRACT_VERSION, contributor.id]
    );

    return res.json({
      message: 'Contract signed successfully.',
      signed_at: rows[0].contract_signed_at,
      version: rows[0].contract_version
    });
  } catch (err) {
    console.error('[contributors] contract sign error:', err);
    return res.status(500).json({ error: 'Failed to record contract signature.' });
  }
});

// ─── POST /api/contributors/points/award (admin only) ────────────────────────
// Manually award or deduct points.

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
    if (!target) {
      return res.status(404).json({ error: 'Contributor not found.' });
    }

    // Find the awarding admin's contributor record (if any)
    const adminContributor = await getContributorByUserId(req.user.id);

    const ledgerEntry = await awardPoints({
      contributor_id,
      points,
      reason,
      source_type,
      source_ref: source_ref || null,
      awarded_by: adminContributor?.id || null,
      metadata: { admin_user_id: req.user.id }
    });

    return res.json({ success: true, ledger_entry: ledgerEntry });
  } catch (err) {
    console.error('[contributors] points award error:', err);
    return res.status(500).json({ error: 'Failed to award points.' });
  }
});

// ─── GET /api/contributors/stats ─────────────────────────────────────────────
// Public aggregate stats — no PII.

router.get('/stats', async (req, res) => {
  try {
    const [totalContributors, totalPoints] = await Promise.all([
      getTotalContributors(),
      getTotalPoints()
    ]);

    // Next distribution: first day of next month (simple heuristic — adjust as needed)
    const now = new Date();
    const nextDistribution = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return res.json({
      total_contributors: totalContributors,
      total_points: totalPoints,
      next_distribution_date: nextDistribution.toISOString().split('T')[0]
    });
  } catch (err) {
    console.error('[contributors] stats error:', err);
    return res.status(500).json({ error: 'Failed to load stats.' });
  }
});

module.exports = router;
