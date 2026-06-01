/**
 * Stripe profit distribution.
 * Uses @atlantist/core when installed; built-in fallback otherwise.
 */
'use strict';

let _core = null;
try { _core = require('@atlantist/core').stripe; } catch { /* not installed yet */ }

if (_core) {
  module.exports = _core;
} else {
  const stripe = process.env.STRIPE_SECRET_KEY
    ? require('stripe')(process.env.STRIPE_SECRET_KEY)
    : null;

  module.exports = {
    calculateDistribution({ grossRevenueCents, operatingCostsCents = 0, stripeFeeCents = 0 }) {
      const net = grossRevenueCents - operatingCostsCents - stripeFeeCents;
      if (net <= 0) return { netProfit: net, walltFundCents: 0, contributorPoolCents: 0 };
      const wallt = Math.floor(net * 0.20);
      return { netProfit: net, walltFundCents: wallt, contributorPoolCents: net - wallt };
    },
    async payoutContributor({ stripeAccountId, grossAmountCents, distributionId, contributorId }) {
      if (!stripe) return { skipped: true, reason: 'stripe_not_configured' };
      if (grossAmountCents < 100) return { skipped: true, reason: 'below_minimum' };
      const transfer = await stripe.transfers.create({
        amount: grossAmountCents, currency: 'usd', destination: stripeAccountId,
        transfer_group: `dist_${distributionId}`,
        metadata: { distribution_id: String(distributionId), contributor_id: String(contributorId) },
      });
      return { transfer, grossAmountCents, withheldCents: 0, netCents: grossAmountCents };
    },
    async createConnectAccount({ email, githubLogin }) {
      if (!stripe) throw new Error('STRIPE_SECRET_KEY not configured');
      return await stripe.accounts.create({
        type: 'express', country: 'US', email,
        capabilities: { transfers: { requested: true } },
        metadata: { github_login: githubLogin, platform: 'atlantist' },
      });
    },
    async createOnboardingLink({ stripeAccountId, contributorId }) {
      if (!stripe) throw new Error('STRIPE_SECRET_KEY not configured');
      return await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `https://atlantist.cloud/app?stripe=refresh&cid=${contributorId}`,
        return_url: `https://atlantist.cloud/app?stripe=connected&cid=${contributorId}`,
        type: 'account_onboarding',
      });
    },
    constructWebhookEvent(rawBody, sig, secret) {
      if (!stripe) throw new Error('STRIPE_SECRET_KEY not configured');
      return stripe.webhooks.constructEvent(rawBody, sig, secret);
    },
    recordWalltFundAllocation({ walltFundCents, distributionId }) {
      return { amount_cents: walltFundCents, distribution_id: distributionId, recorded_at: new Date().toISOString() };
    },
    estimateStripeFees(cents) { return Math.ceil(cents * 0.029) + 30; },
  };
}
