/**
 * Owns: /api/inbound-email — Postmark inbound webhook receiver.
 * Receives POSTs from Postmark when support@atlantist.cloud gets email.
 * Forwards to atlantist@polsia.com and the operator's personal inbox.
 * Does NOT own: outbound transactional email (routes/auth.js, routes/leads.js).
 */
const router = require('express').Router();

const EMAIL_PROXY_URL = process.env.POLSIA_EMAIL_PROXY_URL || process.env.EMAIL_PROXY_URL;
const FROM_ADDRESS = 'Atlantist Support <support@atlantist.cloud>';

// Forward targets — operator personal + Polsia company inbox.
// Both must be set via env vars. If missing, the forward silently skips that target.
// SUPPORT_FORWARD_1 defaults to atlantist@polsia.com (safe — Polsia's own inbox).
// SUPPORT_FORWARD_2 has NO hardcoded fallback — must be explicitly configured.
const FORWARD_TARGETS = [
  process.env.SUPPORT_FORWARD_1 || 'atlantist@polsia.com',
  process.env.SUPPORT_FORWARD_2 || '',
].filter(Boolean);

/**
 * POST /api/inbound-email
 * Postmark inbound webhook. Called when any email lands at support@atlantist.cloud.
 * Postmark docs: https://postmarkapp.com/developer/webhooks/inbound-webhook
 */
router.post('/', async (req, res) => {
  // Acknowledge immediately — Postmark retries on non-2xx
  res.status(200).json({ status: 'ok' });

  if (!EMAIL_PROXY_URL) {
    console.warn('[inbound-email] No EMAIL_PROXY_URL configured — cannot forward');
    return;
  }

  try {
    const {
      From = '(unknown sender)',
      Subject = '(no subject)',
      HtmlBody,
      TextBody,
      Date: sentAt,
      MessageID
    } = req.body;

    const html = HtmlBody || (TextBody ? `<pre>${TextBody}</pre>` : '<p>(no body)</p>');

    const forwardHtml = `
<div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px;background:#f9fafb;margin-bottom:16px;font-family:sans-serif;font-size:13px;color:#6b7280;">
  <strong>Forwarded from support@atlantist.cloud</strong><br>
  <strong>From:</strong> ${From}<br>
  <strong>Subject:</strong> ${Subject}<br>
  <strong>Sent:</strong> ${sentAt || 'n/a'}<br>
  <strong>Message-ID:</strong> ${MessageID || 'n/a'}
</div>
${html}`;

    const forwardSubject = `[Support] ${Subject}`;

    // Forward to all targets in parallel
    const results = await Promise.allSettled(
      FORWARD_TARGETS.map(target =>
        fetch(EMAIL_PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: target,
            from: FROM_ADDRESS,
            reply_to: From,
            subject: forwardSubject,
            html_body: forwardHtml
          })
        }).then(r => ({ target, status: r.status, ok: r.ok }))
      )
    );

    results.forEach(r => {
      if (r.status === 'fulfilled') {
        console.log(`[inbound-email] forwarded to ${r.value.target} — HTTP ${r.value.status}`);
      } else {
        console.error(`[inbound-email] forward failed:`, r.reason?.message || r.reason);
      }
    });
  } catch (err) {
    // Non-fatal — we already responded 200; log for diagnostics
    console.error('[inbound-email] forward error:', err.message);
  }
});

/**
 * GET /api/inbound-email/status — health check for admin verification
 */
router.get('/status', (_req, res) => {
  res.json({
    active: true,
    forward_targets: FORWARD_TARGETS,
    from: FROM_ADDRESS,
    proxy_configured: !!EMAIL_PROXY_URL
  });
});

module.exports = router;
