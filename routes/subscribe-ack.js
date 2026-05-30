/**
 * Owns: /api/subscribe-ack — acceptable-use acknowledgement before Stripe checkout.
 * Does NOT own: Stripe checkout session creation (routes/billing.js), auth sessions (routes/auth.js).
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const { recordAcceptableUseAck, hasAcceptableUseAck } = require('../db/ban-engine');
const { getSubscriptionByUserId } = require('../db/subscriptions');

// GET /api/subscribe-ack/status — check if current user has acked
router.get('/status', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const acked = await hasAcceptableUseAck(req.user.id);
    res.json({ acknowledged: acked });
  } catch (err) {
    console.error('[subscribe-ack] GET /status', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscribe-ack — record acknowledgement, returns acknowledged: true
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { acknowledged } = req.body;
    if (!acknowledged) {
      return res.status(400).json({ error: 'acknowledged must be true' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    const user_agent = req.headers['user-agent'] || null;

    await recordAcceptableUseAck(req.user.id, { ip, user_agent });

    res.json({ acknowledged: true });
  } catch (err) {
    console.error('[subscribe-ack] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subscribe-ack/gate — blocks billing portal access if user hasn't acked.
// Called by billing.js /portal and /checkout before proceeding.
router.get('/gate', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const acked = await hasAcceptableUseAck(req.user.id);
    // Also check subscription status (gate only applies to subscribers)
    const sub = await getSubscriptionByUserId(req.user.id);
    const isSubscriber = sub && ['active', 'trialing', 'past_due'].includes(sub.status);
    // Returning subscribers who haven't acked are blocked
    if (isSubscriber && !acked) {
      return res.status(403).json({
        error: 'acceptable_use_ack_required',
        message: 'You must acknowledge the Acceptable Use & Safety terms before accessing billing.',
        redirect: '/subscribe/acknowledge'
      });
    }
    res.json({ gate: 'pass' });
  } catch (err) {
    console.error('[subscribe-ack] GET /gate', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
