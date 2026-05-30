/**
 * routes/app-events.js — Owns: POST /api/app-events for frontend telemetry ingestion.
 * Does NOT own: analytics reads, admin dashboards, or billing.
 */

const express = require('express');
const router = express.Router();
const { insertEvent } = require('../db/app-events');

/**
 * POST /api/app-events
 * Body: { event_name, session_uuid?, properties?, url?, referrer? }
 * Auth: optional — works for logged-out users too (outreach deep-link scenario).
 */
router.post('/', async (req, res) => {
  const { event_name, session_uuid, properties, url, referrer } = req.body || {};

  if (!event_name || typeof event_name !== 'string') {
    return res.status(400).json({ error: 'event_name required' });
  }

  // Resolve user_id from session if present
  const user_id = req.session?.userId || null;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const user_agent = req.headers['user-agent'] || null;

  // Fire-and-forget — always respond 202 so tour JS never blocks
  insertEvent({ event_name, session_uuid, user_id, properties, url, referrer, user_agent, ip });

  return res.status(202).json({ ok: true });
});

module.exports = router;
