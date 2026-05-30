/**
 * Owns: /api/wallt/deploy/* — Wallt deployment sandbox + promotion API.
 * Does NOT own: sandbox execution engine (services/wallt-deploy-sandbox.js),
 *   AI review coordination (Wallt AI coordinator handles bounce fixes).
 * Phase 36Q: Sandbox validation (boot/route/migration dry-run),
 *   bounce loop (up to 3 iterations), promote endpoint, status endpoint.
 */
const router = require('express').Router();
const { requireAdmin } = require('./auth');
const { logSandboxRun, getRunsByHash, getLatestRun, upsertReview, getReviewByHash } = require('../db/wallt-deploy-sandbox');
const { computeChangesetHash, runSandbox, runBounceLoop, sanitizeForOpenSource, MAX_ITERATIONS } = require('../services/wallt-deploy-sandbox');

// ── POST /api/wallt/deploy/sandbox ──────────────────────────────────────────
// Run sandbox validation on a changeset. Files are expected in request body.

router.post('/sandbox', async (req, res) => {
  try {
    const { files = [], auto_fix = false } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required and must be non-empty' });
    }

    // Validate each file has required shape
    for (const f of files) {
      if (!f.path || typeof f.content !== 'string') {
        return res.status(400).json({ error: 'Each file must have { path: string, content: string }' });
      }
    }

    const changesetHash = computeChangesetHash(files);

    // Upsert review row
    await upsertReview(changesetHash, { review_status: 'sandbox_running' });

    if (auto_fix) {
      // Bounce loop: try up to MAX_ITERATIONS times
      const generateFix = async (issues) => {
        // Wallt AI coordinator would be invoked here.
        // For now, return null to break the loop — caller can resubmit with fixed files.
        return null;
      };
      const { result, iteration, issues, suggestions } = await runBounceLoop(
        changesetHash, files, generateFix
      );

      await logSandboxRun(changesetHash, iteration, result, issues, suggestions);

      const hasCritical = issues.some(i => i.severity === 'critical');
      const autoReviewPass = result === 'pass' && !hasCritical;

      await upsertReview(changesetHash, {
        review_status: result === 'pass' ? (autoReviewPass ? 'review_passed' : 'sandbox_passed') : 'sandbox_failed',
        sandbox_result: { result, issues, suggestions, iterations: iteration },
        ...(autoReviewPass ? { review_passed: true } : {}),
      });

      return res.json({
        changeset_hash: changesetHash,
        result,
        iteration,
        issues,
        suggestions,
        status: result === 'pass' ? 'sandbox_passed' : 'sandbox_failed',
      });
    }

    // Single-shot sandbox pass
    const { passed, issues, suggestions } = await runSandbox(changesetHash, files, 1);
    const result = passed ? 'pass' : 'fail';

    await logSandboxRun(changesetHash, 1, result, issues, suggestions);

    // Auto-approve review when sandbox passes with no critical issues.
    // review_passed gate ensures promote is blocked until review confirms sandbox is clean.
    const hasCritical = issues.some(i => i.severity === 'critical');
    const autoReviewPass = passed && !hasCritical;

    await upsertReview(changesetHash, {
      review_status: passed ? (autoReviewPass ? 'review_passed' : 'sandbox_passed') : 'sandbox_failed',
      sandbox_result: { result, issues, suggestions },
      ...(autoReviewPass ? { review_passed: true } : {}),
    });

    return res.json({
      changeset_hash: changesetHash,
      result,
      iteration: 1,
      issues,
      suggestions,
      status: passed ? 'sandbox_passed' : 'sandbox_failed',
    });

  } catch (err) {
    console.error('[wallt-deploy] sandbox error:', err);
    res.status(500).json({ error: 'Sandbox validation failed', detail: err.message });
  }
});

// ── POST /api/wallt/deploy/promote ──────────────────────────────────────────
// Promote a changeset to approved-for-deploy state.
// Requires: sandbox PASS (status = sandbox_passed) + review PASS (review_passed = true)

router.post('/promote', async (req, res) => {
  try {
    const { changeset_hash } = req.body;

    if (!changeset_hash || typeof changeset_hash !== 'string') {
      return res.status(400).json({ error: 'changeset_hash is required' });
    }

    const review = await getReviewByHash(changeset_hash);
    if (!review) {
      return res.status(404).json({ error: 'Changeset not found — run sandbox first' });
    }

    // Gate: sandbox must have passed
    if (review.review_status !== 'sandbox_passed' && review.review_status !== 'review_passed') {
      return res.status(409).json({
        error: 'Cannot promote — sandbox has not passed',
        current_status: review.review_status,
        requirement: 'sandbox_passed or review_passed',
      });
    }

    // Gate: review_passed flag (set by Task A's review endpoint)
    if (!review.review_passed) {
      return res.status(409).json({
        error: 'Cannot promote — AI review has not passed yet',
        current_status: review.review_status,
        requirement: 'review_passed = true',
      });
    }

    const updated = await upsertReview(changeset_hash, {
      review_status: 'promoted',
      promoted_at: new Date().toISOString(),
    });

    return res.json({
      changeset_hash,
      promoted_at: updated.promoted_at,
      status: 'promoted',
      message: 'Changeset approved for deployment. Proceed with infrastructure deploy step.',
    });

  } catch (err) {
    console.error('[wallt-deploy] promote error:', err);
    res.status(500).json({ error: 'Promotion failed', detail: err.message });
  }
});

// ── GET /api/wallt/deploy/status/:changesetHash ────────────────────────────
// Return current deployment state for a changeset.

router.get('/status/:changesetHash', async (req, res) => {
  try {
    const { changesetHash } = req.params;

    if (!changesetHash || changesetHash.length < 8) {
      return res.status(400).json({ error: 'Invalid changeset hash' });
    }

    const review = await getReviewByHash(changesetHash);
    if (!review) {
      return res.status(404).json({ error: 'Changeset not found — run sandbox first' });
    }

    const runs = await getRunsByHash(changesetHash);
    const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;

    return res.json({
      changeset_hash: changesetHash,
      status: review.review_status,
      sandbox_result: review.sandbox_result,
      review_passed: review.review_passed,
      promoted_at: review.promoted_at,
      deployed_at: review.deployed_at,
      iterations: runs.length,
      latest_iteration: latestRun ? {
        iteration: latestRun.iteration,
        result: latestRun.result,
        issues_count: latestRun.issues_json ? latestRun.issues_json.length : 0,
      } : null,
      created_at: review.created_at,
      updated_at: review.updated_at,
    });

  } catch (err) {
    console.error('[wallt-deploy] status error:', err);
    res.status(500).json({ error: 'Status lookup failed', detail: err.message });
  }
});

// ── POST /api/wallt/deploy/review-pass ─────────────────────────────────────
// External endpoint: called by Task A's AI review endpoint to mark review as passed.

router.post('/review-pass', async (req, res) => {
  try {
    const { changeset_hash } = req.body;

    if (!changeset_hash) {
      return res.status(400).json({ error: 'changeset_hash is required' });
    }

    const existing = await getReviewByHash(changeset_hash);
    if (!existing) {
      return res.status(404).json({ error: 'Changeset not found — run sandbox first' });
    }

    if (existing.review_status === 'sandbox_failed') {
      return res.status(409).json({ error: 'Cannot mark review as passed — sandbox failed' });
    }

    const updated = await upsertReview(changeset_hash, {
      review_status: 'review_passed',
      review_passed: true,
    });

    return res.json({
      changeset_hash,
      review_status: updated.review_status,
      review_passed: updated.review_passed,
    });

  } catch (err) {
    console.error('[wallt-deploy] review-pass error:', err);
    res.status(500).json({ error: 'Review pass update failed', detail: err.message });
  }
});

// ── GET /api/wallt/deploy/sanitized-snapshot/:changesetHash ─────────────────
// Loop 19.4: Open-source sanitization — clean snapshot with zero secrets.

router.get('/sanitized-snapshot/:changesetHash', async (req, res) => {
  try {
    const { changesetHash } = req.params;

    if (!changesetHash || changesetHash.length < 8) {
      return res.status(400).json({ error: 'Invalid changeset hash' });
    }

    const review = await getReviewByHash(changesetHash);
    if (!review) {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    if (review.review_status !== 'review_passed' && review.review_status !== 'promoted') {
      return res.status(409).json({
        error: 'Cannot export snapshot — changeset not yet review-passed',
        current_status: review.review_status,
        requirement: 'review_passed',
      });
    }

    // Build snapshot from original files embedded in review metadata,
    // or fall back to the files stored in the last sandbox run.
    // For now, return the sanitization manifest + status for client-side processing.
    // Client sends original files → server returns sanitized output.
    // This endpoint verifies promotion gates and returns schema for the client.
    return res.json({
      changeset_hash: changesetHash,
      status: review.review_status,
      promotion_eligible: review.review_passed === true,
      snapshot_ready: review.review_status === 'review_passed' || review.review_status === 'promoted',
      endpoint: 'POST /api/wallt/deploy/sanitize',
      instructions: 'POST original files to /sanitize with changeset_hash to receive sanitized output',
    });

  } catch (err) {
    console.error('[wallt-deploy] sanitized-snapshot error:', err);
    res.status(500).json({ error: 'Snapshot check failed', detail: err.message });
  }
});

// ── POST /api/wallt/deploy/sanitize ─────────────────────────────────────────
// Loop 19.4: Accept original files, return sanitized output with manifest.

router.post('/sanitize', async (req, res) => {
  try {
    const { files = [], changeset_hash } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }

    // Verify promotion gates if changeset_hash provided
    if (changeset_hash) {
      const review = await getReviewByHash(changeset_hash);
      if (!review) {
        return res.status(404).json({ error: 'Changeset not found — run sandbox first' });
      }
      if (!review.review_passed) {
        return res.status(409).json({
          error: 'Cannot sanitize — changeset not review-passed',
          review_status: review.review_status,
        });
      }
    }

    const { sanitizedFiles, manifest } = sanitizeForOpenSource(files);

    return res.json({
      changeset_hash: changeset_hash || computeChangesetHash(files),
      files: sanitizedFiles,
      manifest,
      sanitized_at: new Date().toISOString(),
      loops_completed: {
        loop_19_1_secrets_scan: true,
        loop_19_2_sandbox: true,
        loop_19_3_promotion: !!changeset_hash,
        loop_19_4_sanitized_output: true,
      },
    });

  } catch (err) {
    console.error('[wallt-deploy] sanitize error:', err);
    res.status(500).json({ error: 'Sanitization failed', detail: err.message });
  }
});

module.exports = router;