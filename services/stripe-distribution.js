/**
 * Stripe profit distribution — implementation in @atlantist/core (private).
 * Public repo only contains this routing stub.
 */
'use strict';
let _impl;
try {
  _impl = require('@atlantist/core').stripe;
} catch {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[stripe-distribution] @atlantist/core required in production.');
  }
  // Dev stub — returns mock data
  _impl = {
    calculateDistribution: async ({ grossRevenueCents, operatingCostsCents = 0, stripeFeeCents = 0 }) => {
      const netProfit = grossRevenueCents - operatingCostsCents - stripeFeeCents;
      if (netProfit <= 0) return { netProfit, walltFund: 0, contributorPool: 0 };
      const walltFund = Math.floor(netProfit * 0.20);
      return { netProfit, walltFund, contributorPool: netProfit - walltFund };
    },
    payoutContributor: async () => ({ skipped: true, reason: 'dev_stub' }),
    createConnectAccount: async ({ email }) => ({ id: 'acct_dev_stub', email }),
    createOnboardingLink: async () => ({ url: 'https://atlantist.cloud/app?stripe=dev' }),
    constructWebhookEvent: () => { throw new Error('dev stub'); },
    retrieveAccount: async () => ({ details_submitted: false }),
    estimateStripeFees: (grossCents, txnCount = 1) => Math.round(grossCents * 0.029) + txnCount * 30,
  };
}
module.exports = _impl;
