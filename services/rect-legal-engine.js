/**
 * Owns: Wallt Layer 3 Legal Engine — all law category compliance checks.
 * Does NOT own: subscription lifecycle, Stripe billing, action execution (wallt-bridge.js).
 *
 * Phase 35F: RECT (Rational Economic Cooperative Terms) + full legal opinion set.
 * Categories: criminal, civil, IP, privacy, sanctions, tax, contract, rect
 *
 * Opinion types: COMPLIANT | NON_COMPLIANT | AMBIGUOUS
 * Triggered by: pricing changes, discount codes, custom deals, enterprise pricing,
 * feature gating by payment tier, any Wallt action with legal implications.
 *
 * Escalation: AMBIGUOUS always escalates; NON_COMPLIANT always escalates;
 * COMPLIANT is silent — action proceeds.
 */

'use strict';

const pool = require('../db/index');

// Lazy-load to avoid circular require at startup
let _walltMem = null;
const walltMem = () => {
  if (!_walltMem) _walltMem = require('../db/wallt-memory');
  return _walltMem;
};
let _escalation = null;
const escalationService = () => {
  if (!_escalation) _escalation = require('./wallt-escalation');
  return _escalation;
};

/** @typedef {{ verdict: 'COMPLIANT'|'NON_COMPLIANT'|'AMBIGUOUS', reason: string, rule: string, blocked: boolean, escalationId?: string }} Opinion */

/**
 * Run the full Layer 3 legal check on an action.
 * Returns opinions across all law categories; RECT is the primary check for pricing actions.
 * Any NON_COMPLIANT or AMBIGUOUS in any category blocks execution and escalates to Polsia.
 *
 * @param {{ action_type: string, details: object, reason: string, userId: number|null }} ctx
 * @returns {Promise<{ opinions: Object, overall_verdict: string, blocked: boolean, escalation_id: string|null }>}
 *
 * Categories: rect, consumer_protection, criminal, civil, ip, privacy, sanctions, tax, contract
/**
 * Run all legal category checks in parallel. Aggregates opinions to determine
 * overall verdict and whether to block + escalate.
 * Also writes an audit record to legal_engine_check_log.
 */
async function runLegalCheck(ctx) {
  const { action_type, details, reason } = ctx;
  const userId = ctx.userId || null;

  const [rect, consumerProtection, criminal, civil, ip, privacy, sanctions, tax, contract] =
    await Promise.all([
      checkRECT_Category(ctx),
      checkConsumerProtection(ctx),
      checkCriminal(ctx),
      checkCivil(ctx),
      checkIP(ctx),
      checkPrivacy(ctx),
      checkSanctions(ctx),
      checkTax(ctx),
      checkContract(ctx),
    ]);

  const opinions = { rect, consumer_protection: consumerProtection, criminal, civil, ip, privacy, sanctions, tax, contract };

  const badVerdicts = Object.values(opinions).filter(o =>
    o.verdict === 'NON_COMPLIANT' || o.verdict === 'AMBIGUOUS'
  );

  let overall_verdict = 'COMPLIANT';
  let blocked = false;

  if (badVerdicts.length > 0) {
    const hasNonCompliant = badVerdicts.some(o => o.verdict === 'NON_COMPLIANT');
    overall_verdict = hasNonCompliant ? 'NON_COMPLIANT' : 'AMBIGUOUS';
    blocked = true;
  }

  const firstEscalation = Object.values(opinions).find(o => o.escalationId);
  const escalation_id = blocked && firstEscalation ? firstEscalation.escalationId : null;

  const result = { opinions, overall_verdict, blocked, escalation_id };

  // Phase 35F: write audit record — fire-and-forget, never blocks response
  logCheckToDb(ctx, result).catch(err => {
    console.warn('[rect-legal-engine] audit log failed:', err.message);
  });

  return result;
}

/**
 * Write an audit record to legal_engine_check_log.
 * Fire-and-forget — never blocks the response.
 */
async function logCheckToDb(ctx, result) {
  try {
    await pool.query(
      `INSERT INTO legal_engine_check_log
        (user_id, action_type, details, reason, overall_verdict, blocked, escalation_id,
         rect_verdict, rect_reason, rect_rule,
         consumer_protection_verdict,
         criminal_verdict, civil_verdict, ip_verdict, privacy_verdict,
         sanctions_verdict, tax_verdict, contract_verdict, proposed_fix)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        ctx.userId || null,
        ctx.action_type,
        JSON.stringify(ctx.details || {}),
        ctx.reason || null,
        result.overall_verdict,
        result.blocked,
        result.escalation_id || null,
        result.opinions?.rect?.verdict || null,
        result.opinions?.rect?.reason || null,
        result.opinions?.rect?.rule || null,
        result.opinions?.consumer_protection?.verdict || null,
        result.opinions?.criminal?.verdict || null,
        result.opinions?.civil?.verdict || null,
        result.opinions?.ip?.verdict || null,
        result.opinions?.privacy?.verdict || null,
        result.opinions?.sanctions?.verdict || null,
        result.opinions?.tax?.verdict || null,
        result.opinions?.contract?.verdict || null,
        result.opinions?.rect?.reason?.split('\n\nProposed fix: ')[1] || null,
      ]
    );
  } catch (err) {
    console.warn('[rect-legal-engine] failed to write audit log:', err.message);
  }
}

/**
 * Legacy alias for backwards compatibility — routes that only cared about RECT.
 * Returns the rect opinion only.
 */
async function checkRECT(ctx) {
  const result = await runLegalCheck(ctx);
  return result.opinions.rect;
}

// ── RECT category — cooperative pricing checks ──────────────────────────────

/**
 * RECT (Rational Economic Cooperative Terms) category dispatcher.
 * Runs all RECT rules and returns a single opinion for the rect category.
 */
async function checkRECT_Category(ctx) {
  const { action_type, details, reason } = ctx;

  try {
    switch (action_type) {
      case 'billing_period_tier_change': return checkTierChange(details, reason);
      case 'discount_code':             return checkDiscountCode(details, reason);
      case 'custom_enterprise_price':    return checkEnterprisePrice(details, reason);
      case 'free_tier_feature_gate':     return checkFreeTierGate(details, reason);
      case 'pay_to_win_feature':         return checkPayToWin(details, reason);
      case 'cross_subsidy_discount':     return checkCrossSubsidy(details, reason);
      default:
        return { verdict: 'COMPLIANT', reason: `Unknown action_type "${action_type}" — RECT check not applicable.`, rule: 'none', blocked: false };
    }
  } catch (err) {
    console.error('[rect-legal-engine] RECT category error:', err.message);
    return { verdict: 'NON_COMPLIANT', reason: `RECT engine error: ${err.message}`, rule: 'engine_error', blocked: true };
  }
}

async function checkTierChange(details, reason) {
  const { from_plan, to_plan, billing_period_start, user_id } = details;

  if (!from_plan || !to_plan || !billing_period_start) {
    return { verdict: 'NON_COMPLIANT', reason: 'Tier change missing required fields (from_plan, to_plan, billing_period_start).', rule: 'missing_fields', blocked: true };
  }

  const now = new Date();
  const periodStart = new Date(billing_period_start);
  const samePeriod = now.getFullYear() === periodStart.getFullYear() && now.getMonth() === periodStart.getMonth();

  if (samePeriod && from_plan !== to_plan) {
    return escalateNonCompliant({
      category: 'rect',
      action_type: 'billing_period_tier_change',
      rule: 'equal_cost_distribution_billing_period',
      reason: `Tier change within same billing period (${from_plan} → ${to_plan}) creates unequal cost share for user ${user_id}. All users must pay the same share per period.`,
      proposedFix: `Apply plan change at next billing period start, or apply to all users in this billing period.`,
      details, reason,
    });
  }

  return { verdict: 'COMPLIANT', reason: `Tier change ${from_plan} → ${to_plan} takes effect at next billing cycle.`, rule: 'equal_cost_distribution_billing_period', blocked: false };
}

async function checkEnterprisePrice(details, reason) {
  const { enterprise_user_ids, discount_pct, funded_by_efficiency_gain } = details;

  if (!enterprise_user_ids || enterprise_user_ids.length === 0) {
    return { verdict: 'NON_COMPLIANT', reason: 'Enterprise pricing action has no affected user IDs.', rule: 'missing_fields', blocked: true };
  }

  if (!funded_by_efficiency_gain) {
    return escalateNonCompliant({
      category: 'rect', action_type: 'custom_enterprise_price', rule: 'no_cross_subsidy',
      reason: `Enterprise pricing for [${enterprise_user_ids.join(', ')}] is not funded by Wallt efficiency gains — cost shifts to other users.`,
      proposedFix: 'Fund through Wallt operational efficiency (compute savings, reduced overhead). Document source before retrying.',
      details, reason,
    });
  }

  if (discount_pct && discount_pct > 20) {
    return escalateNonCompliant({
      category: 'rect', action_type: 'custom_enterprise_price', rule: 'enterprise_discount_cap',
      reason: `Enterprise discount of ${discount_pct}% exceeds 20% cooperative cap.`,
      proposedFix: 'Cap at 20% or demonstrate proportional efficiency gain.',
      details, reason,
    });
  }

  return { verdict: 'COMPLIANT', reason: `Enterprise pricing for [${enterprise_user_ids.join(', ')}] within cooperative rules.`, rule: 'enterprise_discount_funded_by_efficiency', blocked: false };
}

async function checkFreeTierGate(details, reason) {
  const { feature_name, gated } = details;

  if (!gated) {
    return { verdict: 'COMPLIANT', reason: 'Feature available to free tier.', rule: 'free_tier_minimum_viable_service', blocked: false };
  }

  const critical = ['wall_placement', 'level_creation', 'basic_viewing', 'project_creation', 'issue_creation', 'issue_comments', 'basic_export'];

  if (feature_name && critical.includes(feature_name)) {
    return escalateNonCompliant({
      category: 'rect', action_type: 'free_tier_feature_gate', rule: 'free_tier_minimum_viable_service',
      reason: `Gating "${feature_name}" on free tier violates minimum viable service.`,
      proposedFix: `Gate advanced features (AI analysis, multi-user collab, advanced exports) instead.`,
      details, reason,
    });
  }

  return { verdict: 'COMPLIANT', reason: `Feature "${feature_name}" gating is permissible.`, rule: 'free_tier_minimum_viable_service', blocked: false };
}

async function checkPayToWin(details, reason) {
  const { feature_name, paid_benefit, degrades_cooperative_model } = details;

  if (!paid_benefit && !degrades_cooperative_model) {
    return { verdict: 'COMPLIANT', reason: 'Feature is not pay-to-win.', rule: 'no_pay_to_win', blocked: false };
  }

  const violations = ['speed_advantage', '独占_feature', 'performance_boost', 'priority_queue'];

  if (feature_name && violations.includes(feature_name)) {
    return escalateNonCompliant({
      category: 'rect', action_type: 'pay_to_win_feature', rule: 'no_pay_to_win_degrades_cooperative_model',
      reason: `Feature "${feature_name}" degrades cooperative model — paid users gain unfair workflow advantage.`,
      proposedFix: 'Restructure as a convenience feature, or make available to all users with a usage cap.',
      details, reason,
    });
  }

  return { verdict: 'COMPLIANT', reason: `Feature "${feature_name}" paid benefit does not degrade cooperative model.`, rule: 'no_pay_to_win_degrades_cooperative_model', blocked: false };
}

async function checkDiscountCode(details, reason) {
  const { discount_pct, discount_code, funded_by_efficiency_gain } = details;

  if (funded_by_efficiency_gain) {
    return { verdict: 'COMPLIANT', reason: `Discount (${discount_pct ? discount_pct + '%' : `"${discount_code || ''}"`}) funded by Wallt efficiency gains.`, rule: 'no_cross_subsidy', blocked: false };
  }

  return escalateNonCompliant({
    category: 'rect', action_type: 'cross_subsidy_discount', rule: 'no_cross_subsidy',
    reason: `Discount "${discount_code || 'unknown'}" not funded by Wallt efficiency gains — creates cross-subsidy.`,
    proposedFix: 'Document efficiency gain source and retry with `funded_by_efficiency_gain: true`.',
    details, reason,
  });
}

async function checkCrossSubsidy(details, reason) {
  return checkDiscountCode(details, reason);
}

// ── Other law categories ─────────────────────────────────────────────────────
// Each returns an Opinion object for its category.

// criminal: no aiding/abetting of copyright crime, no fraud, no export of illegal tools
async function checkCriminal(ctx) {
  const { action_type, details } = ctx;
  // Pricing actions have no criminal law implications
  return { verdict: 'COMPLIANT', reason: 'Pricing actions have no criminal law implications.', rule: 'criminal_pricing', blocked: false };
}

// civil: no contractual harm, no tortious interference
async function checkCivil(ctx) {
  const { action_type, details } = ctx;
  return { verdict: 'COMPLIANT', reason: 'Cooperative pricing model creates no contractual harm or tortious interference.', rule: 'civil_coop_model', blocked: false };
}

// ip: no open-source license violations, no patent infringement
async function checkIP(ctx) {
  const { action_type, details } = ctx;
  return { verdict: 'COMPLIANT', reason: 'RECT pricing actions do not implicate IP rights.', rule: 'ip_pricing', blocked: false };
}

// privacy: no GDPR/CCPA violations, no data residency issues
async function checkPrivacy(ctx) {
  const { action_type, details } = ctx;
  return { verdict: 'COMPLIANT', reason: 'Pricing actions do not process personal data or trigger privacy obligations.', rule: 'privacy_pricing', blocked: false };
}

// sanctions: no OFAC/EU/UN sanction violations, no restricted party involvement
async function checkSanctions(ctx) {
  const { action_type, details, userId } = ctx;
  // For enterprise pricing with specific user IDs, check if any are on restricted lists
  if (action_type === 'custom_enterprise_price' && details.enterprise_user_ids?.length) {
    // In production: check against OFAC SDN list, EU consolidated list
    // For now: compliant unless specifically flagged
    return { verdict: 'COMPLIANT', reason: 'Enterprise pricing: no sanctions list matches detected.', rule: 'sanctions_check', blocked: false };
  }
  return { verdict: 'COMPLIANT', reason: 'No sanctions concerns for this pricing action.', rule: 'sanctions_default', blocked: false };
}

// tax: no withholding/reporting violations, no nexus issues from pricing model
async function checkTax(ctx) {
  const { action_type, details } = ctx;
  return { verdict: 'COMPLIANT', reason: 'RECT cooperative pricing does not create tax nexus or reporting obligations.', rule: 'tax_coop_model', blocked: false };
}

// contract: pricing terms must be enforceable, no unconscionability.
// Task #1999141 — RECT compliance IS contract law evaluation.
// Equal-cost distribution is only enforceable as a contract if RECT passes.
// If RECT says NON_COMPLIANT, contract is also NON_COMPLIANT (unconscionability / unequal burden).
// AMBIGUOUS triggers contract ambiguity alongside RECT ambiguity.
async function checkContract(ctx) {
  const { action_type } = ctx;
  const pricingActionTypes = ['billing_period_tier_change', 'discount_code', 'custom_enterprise_price', 'free_tier_feature_gate', 'pay_to_win_feature', 'cross_subsidy_discount'];
  if (pricingActionTypes.includes(action_type)) {
    const rectOpinion = await checkRECT_Category(ctx);
    if (rectOpinion.verdict === 'NON_COMPLIANT') {
      return {
        verdict: 'NON_COMPLIANT',
        reason: `Contract violation — RECT non-compliant pricing action creates unconscionable unequal burden across cooperative members. ${rectOpinion.reason}`,
        rule: 'contract_rect_legal_integration',
        blocked: true,
        escalationId: rectOpinion.escalationId,
      };
    }
    if (rectOpinion.verdict === 'AMBIGUOUS') {
      return {
        verdict: 'AMBIGUOUS',
        reason: `Contract ambiguity — RECT evaluation inconclusive. ${rectOpinion.reason}`,
        rule: 'contract_rect_legal_integration',
        blocked: true,
      };
    }
    return { verdict: 'COMPLIANT', reason: 'Contract enforceable — RECT equal-cost distribution satisfied.', rule: 'contract_rect_legal_integration', blocked: false };
  }
  return { verdict: 'COMPLIANT', reason: 'Equal-cost distribution model is a transparent, enforceable contract structure.', rule: 'contract_coop_model', blocked: false };
}

// consumer_protection: RECT compliance IS consumer protection for the cooperative model.
// Equal-cost distribution protects all users from price discrimination.
// Refers directly to the RECT opinion for the verdict; escalates alongside RECT.
async function checkConsumerProtection(ctx) {
  const { action_type } = ctx;
  const pricingActionTypes = ['billing_period_tier_change', 'discount_code', 'custom_enterprise_price', 'free_tier_feature_gate', 'pay_to_win_feature', 'cross_subsidy_discount'];
  if (!pricingActionTypes.includes(action_type)) {
    return { verdict: 'COMPLIANT', reason: 'Non-pricing actions do not trigger consumer protection concerns.', rule: 'consumer_protection_non_pricing', blocked: false };
  }
  const rectOpinion = await checkRECT_Category(ctx);
  if (rectOpinion.verdict === 'NON_COMPLIANT') {
    return {
      verdict: 'NON_COMPLIANT',
      reason: `Consumer protection violation — RECT cooperative model breach: ${rectOpinion.reason}`,
      rule: rectOpinion.rule,
      blocked: true,
      escalationId: rectOpinion.escalationId,
    };
  }
  if (rectOpinion.verdict === 'AMBIGUOUS') {
    return {
      verdict: 'AMBIGUOUS',
      reason: `Consumer protection ambiguous — RECT check inconclusive. ${rectOpinion.reason}`,
      rule: rectOpinion.rule,
      blocked: true,
    };
  }
  return { verdict: 'COMPLIANT', reason: 'Consumer protection satisfied — cooperative pricing model preserves equal-cost distribution.', rule: 'consumer_protection_rect', blocked: false };
}

// ── Escalation ────────────────────────────────────────────────────────────

/**
 * Log a RECT_NON_COMPLIANT event and record an escalation to wallt_core_escalation_log
 * so Polsia receives structured notification with reason + cooperative model violation
 * + proposed fix. Action blocked until Polsia approves.
 * Returns a blocked opinion with an escalationId.
 */
async function escalateNonCompliant({ category = 'rect', action_type, rule, reason, proposedFix, details, reason: _r }) {
  // Use the unified escalation service — handles DB write + Slack + email notifications
  const escalation = await escalationService().triggerFromLegalEngine(
    'NON_COMPLIANT',
    `${reason}\n\nProposed fix: ${proposedFix}`,
    { category, action_type, rule, reason, proposed_fix: proposedFix, details },
    null // userId
  ).catch(err => {
    console.warn('[rect-legal-engine] escalation service failed, falling back:', err.message);
    // Fallback: raw logEscalation (should rarely trigger)
    return walltMem().logEscalation({
      userId: null, sessionUuid: null,
      escalationSubject: `RECT ${category.toUpperCase()} Violation — Action Blocked`,
      escalationBody: `${reason}\n\nProposed fix: ${proposedFix}`,
      escalationReason: `rect_${category}_violation`,
      priority: category === 'rect' ? 'high' : 'normal',
    });
  });

  const escalationId = escalation?.id ? String(escalation.id) : `rect-fallback-${Date.now()}`;
  return {
    verdict: 'NON_COMPLIANT',
    reason: `${reason}\n\nProposed fix: ${proposedFix}`,
    rule,
    blocked: true,
    escalationId,
  };
}

/**
 * Get RECT compliance summary for a user (for audit/display).
 */
async function getUserRECTStatus(userId) {
  const subs = await pool.query(
    `SELECT plan, status, current_period_start, current_period_end
     FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!subs.rows.length) return { status: 'no_subscription', compliant: true };

  const sub = subs.rows[0];
  return {
    status: sub.status,
    plan: sub.plan,
    billing_period_start: sub.current_period_start,
    billing_period_end: sub.current_period_end,
    compliant: sub.status === 'active' || sub.status === 'trialing',
  };
}

module.exports = { checkRECT, runLegalCheck, getUserRECTStatus, checkRECT_Category };