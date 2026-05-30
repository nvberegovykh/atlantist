/**
 * Owns: /api/billing/* — Stripe checkout, subscription management, webhook handling.
 * Does NOT own: Polsia Stripe MCP, user auth sessions.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const { getUserById } = require('../db/users');
const { getSubscriptionByUserId, getSubscriptionByCustomerId, getSubscriptionByStripeSubId, upsertSubscription, updateSubscriptionStatus, freezeSubscription, reactivateSubscriptionByUserId } = require('../db/subscriptions');
const { setBillingState } = require('../db/users');

const { CANONICAL_ORIGIN: FRONTEND_URL } = require('../lib/canonical-url');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Lazy-load stripe to avoid crashing if key is absent
function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set. Stripe billing is disabled.');
  }
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
}

// Plan pricing (can be made dynamic based on subscriber count later)
const PLANS = {
  monthly: { unitAmount: 3000, nickname: 'Atlantist Pro — Monthly', priceIdEnv: 'STRIPE_PRICE_MONTHLY' },
  yearly:  { unitAmount: 33000, nickname: 'Atlantist Pro — Yearly',  priceIdEnv: 'STRIPE_PRICE_YEARLY' }
};

function getPriceId(plan) {
  const envKey = PLANS[plan]?.priceIdEnv;
  return envKey ? process.env[envKey] : null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

async function getOrCreateStripeCustomer(user) {
  const stripe = getStripe();
  const existing = await getSubscriptionByUserId(user.id);
  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id;
  }
  // Create customer in Stripe
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.first_name || user.email,
    metadata: { user_id: user.id, atlantist_user_id: user.id }
  });
  // Persist customer ID
  await upsertSubscription({ user_id: user.id, stripe_customer_id: customer.id, plan: 'monthly', status: 'trialing' });
  return customer.id;
}

// ─── POST /api/billing/store-checkout — Create Stripe Checkout for paid asset ─
router.post('/store-checkout', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { asset_id } = req.body;
    if (!asset_id) return res.status(400).json({ error: 'asset_id required' });

    const { getAssetById, getAcquisition } = require('../db/assets');
    const asset = await getAssetById(parseInt(asset_id, 10));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.is_paid || asset.price_usd <= 0) {
      return res.status(400).json({ error: 'Asset is not a paid listing' });
    }
    if (asset.uploader_id === req.user.id) {
      return res.status(400).json({ error: 'Cannot purchase your own asset' });
    }
    if (!asset.is_public || asset.status !== 'published') {
      return res.status(400).json({ error: 'Asset is not available' });
    }
    const existing = await getAcquisition(req.user.id, asset.id);
    if (existing) return res.status(409).json({ error: 'Already acquired', acquisition: existing });

    const user = await getUserById(req.user.id);
    const customerId = await getOrCreateStripeCustomer(user);
    const stripe = getStripe();

    const commission_pct = 10;
    const commission_usd = parseFloat((asset.price_usd * (commission_pct / 100)).toFixed(2));

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(asset.price_usd * 100),
          product_data: {
            name: asset.title,
            description: asset.description || undefined,
            images: asset.preview_url ? [asset.preview_url] : [],
          }
        },
        quantity: 1,
      }],
      metadata: {
        user_id: String(req.user.id),
        asset_id: String(asset.id),
        seller_id: String(asset.uploader_id),
        commission_pct: String(commission_pct),
        commission_usd: String(commission_usd),
      },
      success_url: `${FRONTEND_URL}/app?store_success=1&asset_id=${asset.id}`,
      cancel_url: `${FRONTEND_URL}/app`,
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[billing] POST /store-checkout', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/checkout — Create Stripe Checkout session ────────────
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { plan = 'monthly' } = req.body;
    if (!['monthly', 'yearly'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const stripe = getStripe();
    const customerId = await getOrCreateStripeCustomer(user);

    const priceId = getPriceId(plan);
    if (!priceId) {
      return res.status(500).json({ error: 'Stripe price ID not configured. Set STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY environment variables.' });
    }

    // Check if user already has an active subscription
    const existing = await getSubscriptionByUserId(user.id);
    if (existing?.status === 'active') {
      return res.status(400).json({ error: 'You already have an active subscription' });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // 1-month free trial
      subscription_data: { trial_period_days: 30 },
      success_url: `${FRONTEND_URL}/app?billing=success`,
      cancel_url: `${FRONTEND_URL}/pricing`,
      allow_promotion_codes: true,
      metadata: { user_id: user.id }
    });

    // Upsert pending subscription (will be confirmed by webhook)
    await upsertSubscription({
      user_id: user.id,
      stripe_customer_id: customerId,
      plan,
      status: 'trialing'
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[billing] POST /checkout', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/billing/subscription — Get current user's subscription ─────────
router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const sub = await getSubscriptionByUserId(req.user.id);

    if (!sub) {
      // Beta — everyone gets free access
      return res.json({
        status: 'beta_free',
        plan: null,
        beta_access: true,
        message: 'Free beta access — no subscription required during beta.'
      });
    }

    // Calculate days until scheduled deletion for frozen accounts
    let days_until_delete = null;
    if (sub.status === 'frozen' && sub.scheduled_delete_at) {
      const diff = new Date(sub.scheduled_delete_at) - new Date();
      days_until_delete = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    res.json({
      status: sub.status,
      plan: sub.plan,
      stripe_subscription_id: sub.stripe_subscription_id,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      trial_end: sub.trial_end,
      cancelled_at: sub.cancelled_at,
      frozen_at: sub.frozen_at,
      scheduled_delete_at: sub.scheduled_delete_at,
      days_until_delete,
      cancel_at_period_end: sub.cancel_at_period_end
    });
  } catch (err) {
    console.error('[billing] GET /subscription', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/cancel — Cancel subscription (freeze + 1-year hold) ─
router.post('/cancel', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const sub = await getSubscriptionByUserId(req.user.id);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });

    // Cancel in Stripe first (honor period, then cancel)
    if (sub.stripe_subscription_id && !sub.cancel_at_period_end) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          cancel_at_period_end: true
        });
      } catch (stripeErr) {
        console.error('[billing] Stripe cancel_at_period_end failed:', stripeErr);
      }
    }

    // Freeze locally — models become read-only during hold
    await updateSubscriptionStatus(req.user.id, 'frozen', {
      cancelled_at: new Date(),
      frozen_at: new Date(),
      cancel_at_period_end: true
    });

    // Set scheduled delete to 1 year from now
    const scheduledDeleteAt = new Date();
    scheduledDeleteAt.setFullYear(scheduledDeleteAt.getFullYear() + 1);
    await updateSubscriptionStatus(req.user.id, 'active', { scheduled_delete_at: scheduledDeleteAt, cancel_at_period_end: true });

    res.json({
      success: true,
      message: 'Subscription cancelled. You have full access until the end of your billing period. After that, your account enters a 1-year read-only hold before deletion.'
    });
  } catch (err) {
    console.error('[billing] POST /cancel', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/reactivate — Reactivate a frozen subscription ────────
router.post('/reactivate', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const sub = await getSubscriptionByUserId(req.user.id);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (sub.status !== 'frozen') return res.status(400).json({ error: 'Subscription is not frozen' });

    // Re-enable in Stripe
    if (sub.stripe_subscription_id) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          cancel_at_period_end: false
        });
      } catch (stripeErr) {
        console.error('[billing] Stripe reactivate failed:', stripeErr);
      }
    }

    // Reactivate locally
    await reactivateSubscriptionByUserId(req.user.id);

    res.json({ success: true, message: 'Subscription reactivated. Welcome back!' });
  } catch (err) {
    console.error('[billing] POST /reactivate', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/billing/portal — Create Stripe Customer Portal session ───────
router.get('/portal', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const sub = await getSubscriptionByUserId(req.user.id);
    if (!sub?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${FRONTEND_URL}/app`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] GET /portal', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/billing/invoices — List Stripe invoices for current user ────
router.get('/invoices', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const sub = await getSubscriptionByUserId(req.user.id);
    if (!sub?.stripe_customer_id) {
      return res.json({ invoices: [] });
    }

    const stripe = getStripe();
    const invoices = await stripe.invoices.list({
      customer: sub.stripe_customer_id,
      limit: 24
    });

    res.json({
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amount_paid: inv.amount_paid / 100,
        currency: inv.currency,
        created: new Date(inv.created * 1000).toISOString(),
        hosted_invoice_url: inv.hosted_invoice_url,
        invoice_pdf: inv.invoice_pdf
      }))
    });
  } catch (err) {
    console.error('[billing] GET /invoices', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/webhook — Stripe webhook handler ──────────────────────
// Raw body needed for signature verification
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[billing] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // ── Store asset purchase (mode = payment) ───────────────────────────────
        if (session.mode === 'payment' && session.metadata?.asset_id) {
          const { createAcquisition } = require('../db/assets');
          const assetId = parseInt(session.metadata.asset_id, 10);
          const buyerId = parseInt(session.metadata.user_id, 10);
          const sellerId = parseInt(session.metadata.seller_id, 10);
          const commission_pct = parseFloat(session.metadata.commission_pct || '10');
          const commission_usd = parseFloat(session.metadata.commission_usd || '0');
          const amount_usd = session.amount_total / 100;
          const net_usd = parseFloat((amount_usd - commission_usd).toFixed(2));

          await createAcquisition({
            asset_id: assetId, buyer_id: buyerId, seller_id: sellerId,
            amount_usd, commission_pct, net_usd,
            stripe_payment_id: session.payment_intent,
            status: 'acquired',
          });
          console.log(`[store] Acquisition completed: buyer=${buyerId} asset=${assetId} amount=$${amount_usd}`);
          break;
        }

        // ── Subscription checkout ─────────────────────────────────────────────
        if (session.mode !== 'subscription') break;

        // Find user by customer ID
        const sub = await getSubscriptionByCustomerId(session.customer);
        if (!sub) break;

        // Get subscription details
        const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = stripeSub.items.data[0]?.price.id;
        const plan = getPlanFromPriceId(priceId);

        await updateSubscriptionStatus(sub.user_id, 'active', {
          stripe_subscription_id: session.subscription,
          stripe_price_id: priceId,
          plan,
          current_period_start: new Date(stripeSub.current_period_start * 1000),
          current_period_end: new Date(stripeSub.current_period_end * 1000),
          trial_end: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null
        });
        await setBillingState(sub.user_id, 'active');
        console.log(`[billing] Subscription activated for user ${sub.user_id}`);
        break;
      }

      case 'customer.subscription.updated': {
        const stripeSub = event.data.object;
        const sub = await getSubscriptionByStripeSubId(stripeSub.id);
        if (!sub) break;

        const statusMap = {
          active: 'active',
          trialing: 'trialing',
          past_due: 'past_due',
          canceled: 'cancelled',
          unpaid: 'past_due'
        };

        const newStatus = statusMap[stripeSub.status] || stripeSub.status;
        const priceId = stripeSub.items.data[0]?.price.id;

        await updateSubscriptionStatus(sub.user_id, newStatus, {
          stripe_price_id: priceId,
          plan: getPlanFromPriceId(priceId),
          current_period_start: new Date(stripeSub.current_period_start * 1000),
          current_period_end: new Date(stripeSub.current_period_end * 1000),
          trial_end: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null,
          cancel_at_period_end: stripeSub.cancel_at_period_end
        });
        // Sync billing_state on app_users
        if (newStatus === 'active' || newStatus === 'trialing') {
          await setBillingState(sub.user_id, 'active');
        } else if (newStatus === 'past_due') {
          await setBillingState(sub.user_id, 'past_due');
        } else if (newStatus === 'cancelled') {
          await setBillingState(sub.user_id, 'cancelled');
        }
        console.log(`[billing] Subscription updated: ${sub.user_id} → ${newStatus}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object;
        const sub = await getSubscriptionByStripeSubId(stripeSub.id);
        if (!sub) break;

        // If already frozen locally, mark deleted. Otherwise freeze.
        if (sub.status === 'frozen') {
          await updateSubscriptionStatus(sub.user_id, 'deleted');
        } else {
          await freezeSubscription(sub.user_id);
        }
        await setBillingState(sub.user_id, 'cancelled');
        console.log(`[billing] Subscription deleted: ${sub.user_id}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const sub = await getSubscriptionByCustomerId(invoice.customer);
        if (!sub) break;
        await updateSubscriptionStatus(sub.user_id, 'past_due');
        await setBillingState(sub.user_id, 'past_due');
        console.log(`[billing] Payment failed for user ${sub.user_id}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const sub = await getSubscriptionByCustomerId(invoice.customer);
        if (!sub) break;
        if (sub.status === 'past_due') {
          await updateSubscriptionStatus(sub.user_id, 'active');
        }
        console.log(`[billing] Payment succeeded for user ${sub.user_id}`);
        break;
      }

      default:
        console.log(`[billing] Unhandled webhook event: ${event.type}`);
    }
  } catch (err) {
    console.error(`[billing] Webhook handler error for ${event.type}:`, err);
  }

  res.json({ received: true });
});

// ─── GET /api/billing/plans — Return pricing info (public) ──────────────────
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      {
        id: 'monthly',
        name: 'Monthly',
        price: 30,
        currency: 'usd',
        interval: 'month',
        description: 'Billed monthly. Cancel anytime.',
        trial_days: 30
      },
      {
        id: 'yearly',
        name: 'Yearly',
        price: 330,
        currency: 'usd',
        interval: 'year',
        description: '1 month free — pay 11, get 12.',
        savings: 'Save $30/year',
        trial_days: 30
      }
    ]
  });
});

function getPlanFromPriceId(priceId) {
  const monthly = process.env.STRIPE_PRICE_MONTHLY;
  const yearly = process.env.STRIPE_PRICE_YEARLY;
  if (priceId === monthly) return 'monthly';
  if (priceId === yearly) return 'yearly';
  return 'monthly';
}

module.exports = router;