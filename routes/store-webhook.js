/**
 * Owns: /api/store-webhook/stripe — Stripe webhook for asset store purchases.
 * Does NOT own: billing/subscription webhooks, general webhook ingestion.
 */
const express = require('express');
const router = express.Router();
const { recordStripeAcquisition } = require('../db/assets');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function getStripe() {
  if (!STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
}

// POST /api/store-webhook/stripe — Stripe webhook handler
// Handles payment_intent.succeeded → records asset acquisition, credits creator balance
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    console.error('[store-webhook] STRIPE_SECRET_KEY not set — ignoring webhook');
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    if (WEBHOOK_SECRET && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[store-webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const meta = pi.metadata || {};

      if (!meta.asset_id || !meta.buyer_id) {
        // Not a store purchase (could be subscription)
        return res.json({ received: true, skipped: 'not_store_purchase' });
      }

      const existing = await require('../db/assets').getAcquisition(parseInt(meta.buyer_id, 10), parseInt(meta.asset_id, 10));
      if (existing) {
        return res.json({ received: true, skipped: 'already_recorded' });
      }

      const acquisition = await recordStripeAcquisition({
        asset_id: parseInt(meta.asset_id, 10),
        buyer_id: parseInt(meta.buyer_id, 10),
        seller_id: parseInt(meta.seller_id || 0, 10),
        amount_usd: parseFloat(meta.listing_price_usd || 0),
        platform_commission_usd: parseFloat(meta.platform_commission_usd || 0),
        stripe_fee_usd: parseFloat(meta.stripe_fee_usd || 0),
        creator_payout_usd: parseFloat(meta.creator_payout_usd || 0),
        stripe_payment_id: pi.id,
      });

      console.log(`[store-webhook] Asset acquired: buyer=${meta.buyer_id} asset=${meta.asset_id} amount=${meta.listing_price_usd} pi=${pi.id}`);
      return res.json({ received: true, acquisition_id: acquisition.id });
    }

    res.json({ received: true, type: event.type, handled: false });
  } catch (err) {
    console.error('[store-webhook] Error processing event:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;