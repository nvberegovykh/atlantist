/**
 * Stripe distribution service — handles profit-share payouts to contributors
 * via Stripe Connect transfers.
 *
 * Platform Stripe account: acct_1QObHbJfDJuPadAF
 * Withheld amounts remain in the platform account; the platform remits to IRS.
 */
'use strict';

const pool = require('../db/index');
const { getWithholdingRate, calculateNetPayout, needs1099 } = require('./tax-compliance');

const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY;
const PLATFORM_ACCOUNT_ID  = 'acct_1QObHbJfDJuPadAF';

function getStripe() {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.');
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
}

/**
 * Transfer the net payout amount to a contributor's Stripe Connect account.
 * Withheld amount stays in the platform account.
 *
 * @param {object} opts
 * @param {string}  opts.stripeAccountId
 * @param {number}  opts.grossAmountCents
 * @param {number}  opts.distributionId
 * @param {number}  opts.contributorId
 * @param {number}  [opts.withholdingRate=0]
 * @returns {Promise<object>}
 */
async function payoutContributor({ stripeAccountId, grossAmountCents, distributionId, contributorId, withholdingRate = 0 }) {
  const { withheldCents, netCents } = calculateNetPayout(grossAmountCents, withholdingRate);

  if (netCents < 100) {
    return { skipped: true, reason: 'below_minimum_after_withholding', grossAmountCents, withheldCents, netCents };
  }

  const stripe = getStripe();

  const transfer = await stripe.transfers.create({
    amount: netCents,
    currency: 'usd',
    destination: stripeAccountId,
    transfer_group: `dist_${distributionId}`,
    metadata: {
      distribution_id:    String(distributionId),
      contributor_id:     String(contributorId),
      gross_amount_cents: String(grossAmountCents),
      withheld_cents:     String(withheldCents),
      withholding_rate:   String(withholdingRate)
    }
  });

  // Withheld amount stays in platform Stripe account (PLATFORM_ACCOUNT_ID).
  // Platform is responsible for remitting withheld taxes to IRS / state.
  console.log(`[stripe-distribution] Transfer ${transfer.id}: gross=${grossAmountCents}¢ withheld=${withheldCents}¢ net=${netCents}¢ (rate=${withholdingRate}) → ${stripeAccountId}`);

  return { transfer, grossAmountCents, withheldCents, netCents };
}

/**
 * Run a full profit distribution.
 * For each eligible contributor:
 *   1. Compute their share of the distribution pool
 *   2. Apply tax withholding via getWithholdingRate()
 *   3. Transfer net amount via Stripe
 *   4. Update ytd_payout_cents and needs_1099 flag
 *   5. Insert/upsert contributor_tax_summaries for year-end reporting
 *
 * @param {object} distribution - Row from profit_distributions
 * @param {Array}  contributors  - Array of approved contributor rows with stripe_account_id
 * @returns {Promise<Array>} Array of payout result objects
 */
async function runDistribution(distribution, contributors) {
  const results = [];
  const currentYear = new Date().getFullYear();

  for (const contributor of contributors) {
    try {
      if (!contributor.stripe_account_id || contributor.stripe_account_status !== 'active') {
        results.push({ contributorId: contributor.id, skipped: true, reason: 'no_active_stripe_account' });
        continue;
      }

      // Calculate share
      const sharePct = distribution.total_points_snapshot > 0
        ? contributor.total_points / distribution.total_points_snapshot
        : 0;
      const grossCents = Math.floor(distribution.total_profit_cents * sharePct);

      if (grossCents <= 0) {
        results.push({ contributorId: contributor.id, skipped: true, reason: 'zero_share' });
        continue;
      }

      // Determine withholding
      const withholdingInfo = getWithholdingRate(contributor);
      const withholdingRate = withholdingInfo.rate;

      // Execute transfer
      const payoutResult = await payoutContributor({
        stripeAccountId: contributor.stripe_account_id,
        grossAmountCents: grossCents,
        distributionId: distribution.id,
        contributorId: contributor.id,
        withholdingRate
      });

      if (payoutResult.skipped) {
        results.push({ contributorId: contributor.id, ...payoutResult });
        continue;
      }

      const { withheldCents, netCents, transfer } = payoutResult;

      // Record payout row
      await pool.query(
        `INSERT INTO contributor_payouts
           (distribution_id, contributor_id, points_snapshot, share_pct,
            gross_amount_cents, tax_withheld_cents, net_amount_cents,
            stripe_transfer_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed')`,
        [
          distribution.id, contributor.id, contributor.total_points,
          sharePct, grossCents, withheldCents, netCents, transfer.id
        ]
      );

      // Update ytd_payout_cents and withholding_rate on contributor
      const newYtd = (contributor.ytd_payout_cents || 0) + grossCents;
      const updatedContributor = { ...contributor, ytd_payout_cents: newYtd };
      const needsFlag = needs1099(updatedContributor);

      await pool.query(
        `UPDATE contributors
         SET ytd_payout_cents = ytd_payout_cents + $1,
             withholding_rate = $2,
             needs_1099       = $3,
             updated_at       = NOW()
         WHERE id = $4`,
        [grossCents, withholdingRate, needsFlag, contributor.id]
      );

      // Upsert annual tax summary
      await pool.query(
        `INSERT INTO contributor_tax_summaries
           (contributor_id, tax_year, total_paid_cents, total_withheld_cents, form_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (contributor_id, tax_year) DO UPDATE SET
           total_paid_cents     = contributor_tax_summaries.total_paid_cents + EXCLUDED.total_paid_cents,
           total_withheld_cents = contributor_tax_summaries.total_withheld_cents + EXCLUDED.total_withheld_cents`,
        [
          contributor.id,
          currentYear,
          grossCents,
          withheldCents,
          needsFlag ? '1099-NEC' : (contributor.is_us_person === false ? 'W-8BEN-reported' : null)
        ]
      );

      results.push({
        contributorId: contributor.id,
        transferId: transfer.id,
        grossCents,
        withheldCents,
        netCents,
        withholdingRate,
        withholdingReason: withholdingInfo.reason,
        needs1099: needsFlag
      });

      console.log(`[stripe-distribution] Contributor ${contributor.id} paid: gross=${grossCents}¢ withheld=${withheldCents}¢ net=${netCents}¢`);
    } catch (err) {
      console.error(`[stripe-distribution] Error processing contributor ${contributor.id}:`, err.message);
      results.push({ contributorId: contributor.id, error: err.message });
    }
  }

  return results;
}

module.exports = { payoutContributor, runDistribution, PLATFORM_ACCOUNT_ID };
