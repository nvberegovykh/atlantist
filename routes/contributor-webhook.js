/**
 * Owns: /api/contributors/webhook/github — GitHub webhook handler for
 *       auto-awarding contribution points on push / PR merge / issue close.
 *
 * Signature verification uses GITHUB_WEBHOOK_SECRET (HMAC-SHA256).
 * Only awards points to contributors with status = 'approved'.
 */
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { getContributorByGithubLogin, awardPoints } = require('../db/contributors');

// ─── Config ──────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

const POINTS = {
  commit: 10,
  pr_merged: 50,
  issue_closed: 20
};

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(secret, rawBody, sigHeader) {
  if (!sigHeader) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

// ─── POST /api/contributors/webhook/github ────────────────────────────────────
// Must be mounted BEFORE the JSON body parser so we can read the raw body.

router.post(
  '/github',
  // Capture raw body for HMAC verification before JSON parsing
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      if (!WEBHOOK_SECRET) {
        console.warn('[contributor-webhook] GITHUB_WEBHOOK_SECRET not set — webhook disabled.');
        return res.status(503).json({ error: 'Webhook not configured.' });
      }

      const rawBody = req.body; // Buffer, thanks to express.raw()
      const sig = req.headers['x-hub-signature-256'];

      if (!verifySignature(WEBHOOK_SECRET, rawBody, sig)) {
        console.warn('[contributor-webhook] Invalid signature from', req.ip);
        return res.status(401).json({ error: 'Invalid webhook signature.' });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON payload.' });
      }

      const event = req.headers['x-github-event'];
      console.log(`[contributor-webhook] Received event: ${event}`);

      // Acknowledge immediately — process async
      res.status(200).json({ ok: true });

      // Process events asynchronously so GitHub doesn't time out
      setImmediate(() => handleEvent(event, payload).catch(
        err => console.error('[contributor-webhook] Handler error:', err)
      ));
    } catch (err) {
      console.error('[contributor-webhook] Unhandled error:', err);
      // Only send response if not already sent
      if (!res.headersSent) {
        res.status(500).json({ error: 'Webhook processing failed.' });
      }
    }
  }
);

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleEvent(event, payload) {
  switch (event) {
    case 'push':
      await handlePush(payload);
      break;
    case 'pull_request':
      await handlePullRequest(payload);
      break;
    case 'issues':
      await handleIssues(payload);
      break;
    default:
      // Unhandled events are silently ignored
      break;
  }
}

/**
 * push event — award 10 points per commit to the committer's contributor account.
 * Identifies contributors by their GitHub login via `commits[].author.username`.
 */
async function handlePush(payload) {
  const commits = payload.commits || [];
  if (commits.length === 0) return;

  // Deduplicate: accumulate points per login before hitting the DB
  const pointsByLogin = new Map();
  for (const commit of commits) {
    const login = commit.author?.username;
    if (!login) continue;
    pointsByLogin.set(login, (pointsByLogin.get(login) || 0) + POINTS.commit);
  }

  for (const [login, totalPoints] of pointsByLogin.entries()) {
    const contributor = await getContributorByGithubLogin(login);
    if (!contributor || contributor.status !== 'approved') continue;

    // Find the commit SHAs for this login (for source_ref)
    const sha = commits
      .filter(c => c.author?.username === login)
      .map(c => c.id)
      .join(',');

    await awardPoints({
      contributor_id: contributor.id,
      points: totalPoints,
      reason: `${commits.filter(c => c.author?.username === login).length} commit(s) pushed to ${payload.repository?.full_name || 'repo'}`,
      source_type: 'github_commit',
      source_ref: sha,
      metadata: {
        repo: payload.repository?.full_name,
        ref: payload.ref,
        commit_count: commits.filter(c => c.author?.username === login).length
      }
    });

    console.log(`[contributor-webhook] Awarded ${totalPoints} points to ${login} for push`);
  }
}

/**
 * pull_request event — award 50 points when a PR is merged.
 */
async function handlePullRequest(payload) {
  const { action, pull_request: pr } = payload;
  if (action !== 'closed' || !pr?.merged) return;

  const login = pr.user?.login;
  if (!login) return;

  const contributor = await getContributorByGithubLogin(login);
  if (!contributor || contributor.status !== 'approved') return;

  await awardPoints({
    contributor_id: contributor.id,
    points: POINTS.pr_merged,
    reason: `PR #${pr.number} merged: "${pr.title}"`,
    source_type: 'github_pr_merged',
    source_ref: pr.html_url,
    metadata: {
      pr_number: pr.number,
      pr_title: pr.title,
      repo: payload.repository?.full_name,
      merged_at: pr.merged_at
    }
  });

  console.log(`[contributor-webhook] Awarded ${POINTS.pr_merged} points to ${login} for merged PR #${pr.number}`);
}

/**
 * issues event — award 20 points when an issue is closed.
 */
async function handleIssues(payload) {
  const { action, issue } = payload;
  if (action !== 'closed' || !issue) return;

  const login = issue.user?.login;
  if (!login) return;

  const contributor = await getContributorByGithubLogin(login);
  if (!contributor || contributor.status !== 'approved') return;

  await awardPoints({
    contributor_id: contributor.id,
    points: POINTS.issue_closed,
    reason: `Issue #${issue.number} closed: "${issue.title}"`,
    source_type: 'github_issue_closed',
    source_ref: issue.html_url,
    metadata: {
      issue_number: issue.number,
      issue_title: issue.title,
      repo: payload.repository?.full_name
    }
  });

  console.log(`[contributor-webhook] Awarded ${POINTS.issue_closed} points to ${login} for closed issue #${issue.number}`);
}

module.exports = router;
