/**
 * Owns: /api/webhooks/* — external webhook ingestion (DOB filing, fire protection, etc.).
 * Does NOT own: Stripe webhooks (routes/billing.js handles those).
 *
 * Signature verification: callers must sign the raw JSON body with HMAC-SHA256
 * using WEBHOOK_SECRET and send the hex digest in X-Webhook-Signature-256.
 * Falls back to legacy X-Webhook-Secret header check for backward compatibility.
 */
const router = require('express').Router();
const crypto = require('crypto');
const {
  upsertProjectFromFiling,
  logWebhookEvent,
  queueEnergySimulation,
  updateFireProtectionRun,
  updateGeotechnicalRun
} = require('../db/webhooks');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret';

/**
 * Verify webhook authenticity.
 * Prefers X-Webhook-Signature-256 (HMAC-SHA256 of raw body).
 * Falls back to legacy X-Webhook-Secret plaintext header.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyWebhook(req) {
  const sigHeader = req.headers['x-webhook-signature-256'];
  if (sigHeader) {
    // rawBody is set by express.raw() — must be Buffer
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected = 'sha256=' + crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(sigHeader),
        Buffer.from(expected)
      );
    } catch {
      return false;
    }
  }
  // Legacy fallback: plaintext secret header
  const secret = req.headers['x-webhook-secret'];
  if (!secret) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(secret),
      Buffer.from(WEBHOOK_SECRET)
    );
  } catch {
    return false;
  }
}

router.post('/dob', async (req, res) => {
  try {
    const valid = verifyWebhook(req);
    if (!valid) return res.status(401).json({ error: 'Invalid webhook secret' });

    const { filing } = req.body;
    if (!filing) return res.status(400).json({ error: 'Missing filing payload' });

    const {
      job_number, address, borough, bin,
      job_type, owner, architect, energy_report_required,
      fire_protection_required, documents
    } = filing;

    const projectId = await upsertProjectFromFiling({
      name: address || 'NYC Filing',
      address,
      borough,
      bin,
      job_number,
      job_type,
      owner,
      architect,
      settings: JSON.stringify({ energy_required: energy_report_required, fire_protection_required, documents: documents || [] })
    });

    await logWebhookEvent('webhook', projectId || 0, 'dob_filing_received', req.body, 'dob-webhook');

    if (energy_report_required && projectId) {
      await queueEnergySimulation(projectId);
    }

    res.json({
      status: 'received',
      project_id: projectId,
      job_number,
      events_logged: energy_report_required ? ['filing_received', 'energy_sim_queued'] : ['filing_received']
    });
  } catch (err) {
    console.error('[webhooks] POST /dob', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/fire-protection', async (req, res) => {
  try {
    const valid = verifyWebhook(req);
    if (!valid) return res.status(401).json({ error: 'Invalid webhook secret' });

    const { event, run_id, results, pdf_url } = req.body;
    if (!run_id) return res.status(400).json({ error: 'Missing run_id' });

    const run = await updateFireProtectionRun(run_id, JSON.stringify({ webhook_results: results, pdf_url, webhook_event: event }));

    if (!run) {
      return res.json({
        status: 'acknowledged',
        run_id,
        note: 'Fire protection run record not found'
      });
    }

    res.json({ status: 'processed', run_id, results: results || {}, pdf_url });
  } catch (err) {
    console.error('[webhooks] POST /fire-protection', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/geotechnical', async (req, res) => {
  try {
    const valid = verifyWebhook(req);
    if (!valid) return res.status(401).json({ error: 'Invalid webhook secret' });

    const { event, run_id, analysis_type, results } = req.body;
    if (!run_id) return res.status(400).json({ error: 'Missing run_id' });

    await updateGeotechnicalRun(run_id, JSON.stringify({ webhook_event: event, webhook_results: results }));

    res.json({ status: 'processed', run_id });
  } catch (err) {
    console.error('[webhooks] POST /geotechnical', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;