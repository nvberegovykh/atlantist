/**
 * Owns: Stripe-level operations for the contributor profit distribution system.
 *
 * Stripe account: acct_1QObHbJfDJuPadAF (Liber Creative LLC — Atlantist master)
 * Live mode: true
 *
 * Products:
 *   Wallt AI Development Fund:        prod_UcdPcDTajwsJ16
 *   Atlantist Contributor Payout Pool: prod_UcdPtje9qCXKvi
 *
 * Profit split (applied to NET profit after Stripe fees + operating costs):
 *   20% → Wallt AI Development Fund  (stays in master Stripe account)
 *   80% → Contributor Payout Pool    (split by total_points, paid via Connect transfers)
 *
 * Does NOT own: DB writes, HTTP layer, authentication.
 */
'use strict';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Stripe product IDs — created in the Liber Creative LLC account
const PRODUCTS = {
  walltFund: 'prod_UcdPcDTajwsJ16',
  contributorPool: 'prod_UcdPtje9qCXKvi'
};

// Minimum payout amount — Stripe requires at least $1 (100 cents)
const MIN_PAYOUT_CENTS = 100;

// Lazy-load stripe to avoid crashing if key is absent at module load time
let _stripe = null;
function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured. Stripe distribution is disabled.');
  }
  if (!_stripe) {
    const Stripe = require('stripe');
    _stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
  }
  return _stripe;
}

// ─── calculateDistribution ────────────────────────────────────────────────────

/**
 * Calculate the 20/80 split for a given period's revenue.
 *
 * @param {object} params
 * @param {number} params.grossRevenueCents      — all Stripe payments received in period
 * @param {number} [params.operatingCostsCents]  — platform costs (hosting, etc.)
 * @param {number} [params.stripeFeeCents]       — Stripe processing fees (~2.9% + 30¢)
 *
 * @returns {{ netProfit: number, walltFund: number, contributorPool: number }}
 *   All values in cents. walltFund + contributorPool = netProfit (integer-safe via Math.floor).
 */
async function calculateDistribution({ grossRevenueCents, operatingCostsCents = 0, stripeFeeCents = 0 }) {
  const netProfit = grossRevenueCents - operatingCostsCents - stripeFeeCents;
  if (netProfit <= 0) {
    return { netProfit, walltFund: 0, contributorPool: 0 };
  }
  const walltFund = Math.floor(netProfit * 0.20);
  const contributorPool = netProfit - walltFund; // remainder avoids rounding loss
  return { netProfit, walltFund, contributorPool };
}

// ─── payoutContributor ────────────────────────────────────────────────────────

/**
 * Execute a Stripe Connect transfer to a single contributor's Express account.
 *
 * Transfers are grouped under `dist_<distributionId>` so the Stripe dashboard
 * shows all transfers for a distribution together.
 *
 * @param {object} params
 * @param {string} params.stripeAccountId   — contributor's Stripe Connect account ID
 * @param {number} params.amountCents       — net amount to transfer (after any tax withholding)
 * @param {number} params.distributionId    — profit_distributions.id
 * @param {number} params.contributorId     — contributors.id
 *
 * @returns {object} Stripe Transfer object, or { skipped: true, reason: string }
 */
async function payoutContributor({ stripeAccountId, amountCents, distributionId, contributorId }) {
  if (amountCents < MIN_PAYOUT_CENTS) {
    console.warn(
      `[stripe-distribution] Skipping payout for contributor ${contributorId}: ` +
      `amount ${amountCents}¢ < minimum ${MIN_PAYOUT_CENTS}¢`
    );
    return { skipped: true, reason: 'below_minimum' };
  }

  const stripe = getStripe();
  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: stripeAccountId,
    transfer_group: `dist_${distributionId}`,
    metadata: {
      distribution_id: String(distributionId),
      contributor_id:  String(contributorId),
      product:         PRODUCTS.contributorPool,
      platform:        'atlantist'
    }
  });

  console.log(
    `[stripe-distribution] Transfer ${transfer.id} → ${stripeAccountId}: ` +
    `${amountCents}¢ for contributor ${contributorId} (dist ${distributionId})`
  );
  return transfer;
}

// ─── createConnectAccount ─────────────────────────────────────────────────────

/**
 * Create a Stripe Connect Express account for a new contributor.
 *
 * @param {object} params
 * @param {string|null} params.email       — contributor's email (optional)
 * @param {string}      params.githubLogin — used in metadata for traceability
 *
 * @returns {object} Stripe Account object
 */
async function createConnectAccount({ email, githubLogin }) {
  const stripe = getStripe();
  return await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: email || undefined,
    capabilities: { transfers: { requested: true } },
    metadata: {
      github_login: githubLogin,
      platform:     'atlantist'
    }
  });
}

// ─── createOnboardingLink ─────────────────────────────────────────────────────

/**
 * Generate a Stripe-hosted onboarding URL for a contributor's Express account.
 *
 * @param {object} params
 * @param {string} params.stripeAccountId — contributor's Stripe account ID
 * @param {number} params.contributorId   — contributors.id (embedded in return URLs)
 *
 * @returns {object} Stripe AccountLink object (has .url property)
 */
async function createOnboardingLink({ stripeAccountId, contributorId }) {
  const stripe = getStripe();
  return await stripe.accountLinks.create({
    account:     stripeAccountId,
    refresh_url: `https://atlantist.cloud/app?stripe=refresh&cid=${contributorId}`,
    return_url:  `https://atlantist.cloud/app?stripe=connected&cid=${contributorId}`,
    type:        'account_onboarding'
  });
}

// ─── estimateStripeFees ───────────────────────────────────────────────────────

/**
 * Estimate Stripe processing fees for a given gross revenue amount.
 * Uses the standard US card rate: 2.9% + $0.30 per transaction.
 * Pass transaction count if known; defaults to 1 (lump-sum estimate).
 *
 * @param {number} grossCents       — gross revenue in cents
 * @param {number} [txnCount=1]     — number of separate transactions
 * @returns {number} estimated fee in cents (rounded up)
 */
function estimateStripeFees(grossCents, txnCount = 1) {
  const variableFee = Math.round(grossCents * 0.029);
  const fixedFee    = txnCount * 30; // 30¢ per transaction
  return variableFee + fixedFee;
}

module.exports = {
  calculateDistribution,
  payoutContributor,
  createConnectAccount,
  createOnboardingLink,
  estimateStripeFees,
  PRODUCTS
};
