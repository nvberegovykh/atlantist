/**
 * Client error collection endpoint.
 * Owns: POST /api/client-errors — receives unhandled client-side JS errors.
 * Does NOT own: error processing, alerting, or third-party integrations.
 *
 * POST body: { message, source, lineno, colno, error }
 * Logs to stdout; future: forward to monitoring service.
 */
const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  const { message, source, lineno, colno, error, stack, url, userAgent, timestamp } = req.body;

  // Structured log entry — grep for '[client-error]' in prod logs
  const entry = {
    ts: new Date().toISOString(),
    type: 'client-error',
    message: message || '(no message)',
    source: source || '(no source)',
    lineno: lineno != null ? lineno : '?',
    colno: colno != null ? colno : '?',
    stack: stack || error?.stack || '(no stack)',
    url: url || '(no url)',
    ua: userAgent || req.headers['user-agent'] || '(no ua)',
  };

  console.error('[client-error]', JSON.stringify(entry));
  res.json({ received: true });
});

module.exports = router;