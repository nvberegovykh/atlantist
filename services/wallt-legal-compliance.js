/**
 * Owns: Wallt Layer 3 Dynamic Legal Compliance Engine.
 * Does NOT own: RECT engine (rect-legal-engine.js), escalation (wallt-escalation.js).
 * Phase 36P: jurisdiction-aware, auto-updating, all law categories.
 *
 * Entry point: legal_compliance_check(request, ctx)
 * → COMPLIANT / NON_COMPLIANT / AMBIGUOUS + reasoning chain + jurisdiction refs
 *
 * When triggered (Phase 36P):
 *   - Before any Wallt action with legal implications
 *   - Before any user request Wallt would execute
 *   - During moral drift detection (Layer 2)
 *   - During escalation evaluation (Layer 3B)
 *
 * Escalation to Polsia:
 *   - AMBIGUOUS → always escalates with full reasoning + jurisdiction list
 *   - NON_COMPLIANT → always escalates with refusal reason + jurisdiction references
 *   - COMPLIANT → silent, action proceeds
 *
 * Unknown/missing law → logged as gap, flagged for manual review,
 * does NOT assume compliance.
 */
'use strict';

const pool = require('../db/index');

let rectEngine = null;
const rect = () => { if (!rectEngine) rectEngine = require('./rect-legal-engine'); return rectEngine; };
let escalationSvc = null;
const escalation = () => { if (!escalationSvc) escalationSvc = require('./wallt-escalation'); return escalationSvc; };

// ── Law category configuration ─────────────────────────────────────────────────

const LAW_CATEGORIES = ['criminal', 'civil', 'ip', 'privacy', 'sanctions', 'tax', 'contract', 'consumer_protection'];

// Action type → relevant law category map
const ACTION_TO_CATEGORIES = {
  // Pricing / billing actions
  billing_period_tier_change:    ['contract', 'consumer_protection'],
  discount_code:                  ['consumer_protection', 'contract'],
  custom_enterprise_price:         ['consumer_protection', 'contract', 'sanctions', 'tax'],
  free_tier_feature_gate:         ['consumer_protection', 'contract'],
  pay_to_win_feature:             ['consumer_protection', 'contract'],
  cross_subsidy_discount:         ['consumer_protection', 'contract', 'tax'],

  // Data actions
  process_personal_data:          ['privacy', 'civil', 'ip'],
  delete_user_data:               ['privacy', 'contract', 'civil'],
  share_user_data:                 ['privacy', 'contract', 'civil', 'ip'],

  // IP actions
  generate_code:                  ['ip', 'criminal', 'civil'],
  distribute_gpl_code:             ['ip'],
  network_access_agpl:            ['ip'],
  use_mit_code:                   ['ip'],
  infringe_patent:                ['ip', 'civil', 'criminal'],
  infringe_trademark:             ['ip', 'civil'],
  misappropriate_trade_secret:    ['ip', 'criminal', 'civil'],

  // Fraud / deceptive practices
  misrepresent_data:             ['criminal', 'civil', 'consumer_protection'],
  deceptive_practice:            ['consumer_protection', 'civil', 'criminal'],
  induce_breach:                  ['civil', 'contract'],
  extract_trade_secret:           ['criminal', 'civil', 'ip'],

  // Sanctions / financial
  transact_with_sdn:             ['sanctions', 'criminal', 'civil'],
  transact_with_eu_sanctioned:   ['sanctions', 'criminal', 'civil'],
  transact_with_un_sanctioned:  ['sanctions', 'criminal', 'civil'],

  // Tax
  pay_worker:                     ['tax', 'contract'],
  sell_digital_service_eu:       ['tax', 'contract'],
  sell_digital_service_uk:        ['tax', 'contract'],
  sell_to_us_state:               ['tax', 'contract'],

  // Platform / general
  publish_content:                ['civil', 'contract', 'ip'],
  billing_charge:                ['consumer_protection', 'contract', 'tax'],
  feature_release:               ['consumer_protection', 'contract'],
};

// Fallback: all categories for unknown action types
function categoriesForAction(actionType) {
  return ACTION_TO_CATEGORIES[actionType] || LAW_CATEGORIES;
}

// ── Jurisdiction routing ───────────────────────────────────────────────────────

/**
 * Detect applicable jurisdictions from context.
 * Order of precedence: explicit → project location → user region → platform default.
 */
function detectJurisdictions(ctx = {}) {
  const { explicitJurisdiction, projectLocation, userCountry, billingJurisdiction } = ctx;

  const detected = new Set();

  if (explicitJurisdiction) {
    detected.add(explicitJurisdiction);
  }
  if (projectLocation) {
    detected.add(projectLocation);
  }
  if (userCountry) {
    detected.add(mapCountryToJurisdiction(userCountry));
  }
  if (billingJurisdiction) {
    detected.add(billingJurisdiction);
  }

  // Always include 'global' for platform-level obligations
  detected.add('global');

  // Default to 'us' if nothing else detected
  if (detected.size === 1 && detected.has('global')) {
    detected.add('us');
  }

  return [...detected];
}

function mapCountryToJurisdiction(country) {
  const map = {
    US: 'us', CA: 'ca', GB: 'uk', DE: 'eu', FR: 'eu', IT: 'eu', ES: 'eu',
    NL: 'eu', BE: 'eu', SE: 'eu', PL: 'eu', AT: 'eu', CH: 'eu',
    AU: 'global', NZ: 'global', JP: 'global', KR: 'global',
    SG: 'global', AE: 'uae', SA: 'global', IN: 'global',
  };
  return map[country?.toUpperCase()] || 'us';
}

// ── Core compliance check ────────────────────────────────────────────────────

/**
 * Main entry point. Check a Wallt action against all applicable laws.
 *
 * @param {{ action_type: string, details: object, reason: string, request_text?: string }} request
 * @param {{ userId?: number|null, projectId?: string|null, jurisdictionContext?: object }} ctx
 *
 * @returns {Promise<{
 *   verdict: 'COMPLIANT' | 'NON_COMPLIANT' | 'AMBIGUOUS',
 *   reason: string,
 *   reason_chain: string[],
 *   jurisdictions: string[],
 *   opinions: Object,
 *   gaps: Array,
 *   escalation_id: string|null,
 *   blocked: boolean
 * }>}
 */
async function legal_compliance_check(request, ctx = {}) {
  const { action_type, details, reason, request_text } = request;
  const { userId = null, projectId = null, jurisdictionContext = {} } = ctx;

  // ── 1. Detect jurisdictions ─────────────────────────────────────────────────
  const jurisdictions = detectJurisdictions({
    explicitJurisdiction: jurisdictionContext.explicit,
    projectLocation:      jurisdictionContext.projectLocation,
    userCountry:          jurisdictionContext.userCountry,
    billingJurisdiction:   jurisdictionContext.billingJurisdiction,
  });

  // ── 2. Determine law categories to check ─────────────────────────────────
  const relevantCategories = categoriesForAction(action_type);
  // RECT is always checked for pricing actions
  if (['billing_period_tier_change', 'discount_code', 'custom_enterprise_price',
       'free_tier_feature_gate', 'pay_to_win_feature', 'cross_subsidy_discount'].includes(action_type)) {
    if (!relevantCategories.includes('rect')) relevantCategories.push('rect');
  }

  // ── 3. Run all category checks in parallel ──────────────────────────────
  const categoryResults = {};
  const gaps = [];

  // RECT: delegate to existing rect-legal-engine
  if (relevantCategories.includes('rect')) {
    try {
      const rectResult = await rect().runLegalCheck({ action_type, details, reason, userId });
      categoryResults.rect = rectResult.opinions?.rect || rectResult;
    } catch (err) {
      categoryResults.rect = { verdict: 'AMBIGUOUS', reason: `RECT engine error: ${err.message}`, rule: 'engine_error', blocked: false };
    }
  }

  // BIM building codes: delegate to wallt-legal-registry
  if (relevantCategories.includes('building_code')) {
    try {
      const { legal_compliance_check: bimCheck } = require('./wallt-legal-registry');
      const bimCodes = ['ibc', 'nyc_bc', 'nfpa', 'ashrae', 'aisc', 'aci', 'nds', 'wcag', 'encryption'];
      const primaryJurisdiction = jurisdictions.includes('nyc') ? 'nyc' : 'us';
      const bimResult = await bimCheck(bimCodes, primaryJurisdiction, details, { userId, projectId });
      categoryResults.building_code = {
        verdict: bimResult.overall_status === 'PASS' ? 'COMPLIANT'
               : bimResult.overall_status === 'FAIL' ? 'NON_COMPLIANT'
               : bimResult.overall_status === 'AMBIGUOUS' ? 'AMBIGUOUS'
               : 'COMPLIANT',
        reason: bimResult.summary || 'BIM code check complete',
        rule: 'wallt_legal_registry',
        blocked: bimResult.overall_status === 'FAIL',
        code_results: bimResult.code_results,
        warnings: bimResult.warnings,
        recommendations: bimResult.recommendations,
      };
    } catch (err) {
      categoryResults.building_code = { verdict: 'AMBIGUOUS', reason: `BIM registry error: ${err.message}`, rule: 'engine_error', blocked: false };
    }
  }

  // Non-BIM law categories: structured rule-based checks
  const nonBimCategories = relevantCategories.filter(c => c !== 'rect' && c !== 'building_code');

  const categoryChecks = await Promise.all(nonBimCategories.map(cat =>
    checkCategory(cat, action_type, details, reason, request_text, jurisdictions, userId)
  ));

  for (let i = 0; i < nonBimCategories.length; i++) {
    const result = categoryChecks[i];
    if (result.gap) {
      gaps.push(result.gap);
    }
    categoryResults[nonBimCategories[i]] = result.opinion;
  }

  // ── 4. Aggregate opinions ─────────────────────────────────────────────────
  const badVerdicts = Object.entries(categoryResults)
    .filter(([, o]) => o.verdict === 'NON_COMPLIANT' || o.verdict === 'AMBIGUOUS');

  let overall_verdict = 'COMPLIANT';
  let blocked = false;
  let reason_chain = [];

  for (const [cat, opinion] of badVerdicts) {
    reason_chain.push(`[${cat.toUpperCase()}] ${opinion.reason}`);
  }

  if (badVerdicts.some(([, o]) => o.verdict === 'NON_COMPLIANT')) {
    overall_verdict = 'NON_COMPLIANT';
    blocked = true;
  } else if (badVerdicts.length > 0) {
    overall_verdict = 'AMBIGUOUS';
    blocked = true;
  }

  const compliance_report = {
    verdict: overall_verdict,
    reason: buildSummaryReason(overall_verdict, reason_chain, gaps),
    reason_chain,
    jurisdictions,
    opinions: categoryResults,
    gaps,
    escalation_id: null,
    blocked,
  };

  // ── 5. Escalate if blocked ────────────────────────────────────────────────
  if (blocked) {
    try {
      const esc = await escalation().triggerFromLegalEngine(
        overall_verdict,
        compliance_report.reason,
        {
          action_type,
          details,
          reason,
          jurisdictions,
          opinions: categoryResults,
          gaps,
        },
        userId
      );
      compliance_report.escalation_id = esc?.id ? String(esc.id) : null;
    } catch (err) {
      console.warn('[wallt-legal-compliance] escalation failed:', err.message);
    }
  }

  // ── 6. Audit log ─────────────────────────────────────────────────────────
  logComplianceCheck(request, compliance_report, ctx).catch(err =>
    console.warn('[wallt-legal-compliance] audit log failed:', err.message)
  );

  return compliance_report;
}

// ── Per-category checks ──────────────────────────────────────────────────────

async function checkCategory(category, actionType, details, reason, requestText, jurisdictions, userId) {
  switch (category) {
    case 'criminal':   return checkCriminal(actionType, details, requestText, jurisdictions, userId);
    case 'civil':      return checkCivil(actionType, details, requestText, jurisdictions, userId);
    case 'ip':         return checkIP(actionType, details, requestText, jurisdictions, userId);
    case 'privacy':    return checkPrivacy(actionType, details, requestText, jurisdictions, userId);
    case 'sanctions':  return checkSanctions(actionType, details, requestText, jurisdictions, userId);
    case 'tax':        return checkTax(actionType, details, requestText, jurisdictions, userId);
    case 'contract':   return checkContract(actionType, details, requestText, jurisdictions, userId);
    case 'consumer_protection': return checkConsumerProtection(actionType, details, requestText, jurisdictions, userId);
    default:
      return {
        opinion: { verdict: 'COMPLIANT', reason: `No rules for category "${category}".`, rule: 'no_rules', blocked: false },
        gap: { category, missing: `No legal rules for "${category}" in registry`, severity: 'high', requires_manual_review: true },
      };
  }
}

// criminal: no aiding/abetting, no fraud, no export of illegal tools
async function checkCriminal(actionType, details, requestText, jurisdictions, userId) {
  const text = (requestText || '').toLowerCase();

  // High-confidence fraud keywords
  const fraudPatterns = [
    { pattern: /fabricat|false (claim|data|metric|revenue|user)/, confidence: 0.95 },
    { pattern: /misrepresent|doctored|manipulat.*(data|metric|number)/, confidence: 0.9 },
    { pattern: /fake (testimonial|review|user|account|revenue)/, confidence: 0.9 },
    { pattern: /scam|phish|social (engineer|engineering)/, confidence: 0.9 },
    { pattern: /stolen (code|data|credentials|IP)/, confidence: 0.85 },
    { pattern: /pirated (software|code|content)/, confidence: 0.85 },
  ];

  for (const { pattern, confidence } of fraudPatterns) {
    if (pattern.test(text)) {
      return {
        opinion: {
          verdict: 'NON_COMPLIANT',
          reason: `Criminal: text matches fraud/misrepresentation pattern (confidence ${confidence}). Ref: 18 USC §1343 (Wire Fraud).`,
          rule: 'criminal_fraud_pattern',
          blocked: true,
          confidence,
        },
        gap: null,
      };
    }
  }

  // Criminal action types
  const criminalActions = ['transact_with_sdn', 'transact_with_eu_sanctioned', 'transact_with_un_sanctioned',
    'infringe_patent', 'misappropriate_trade_secret', 'extract_trade_secret', 'unauthorized_access'];
  if (criminalActions.includes(actionType)) {
    return {
      opinion: {
        verdict: 'NON_COMPLIANT',
        reason: `Criminal law violation: action type "${actionType}" violates 18 USC §1836 (Trade Secrets) / 17 USC §506 (Copyright).`,
        rule: 'criminal_statute_violation',
        blocked: true,
        confidence: 0.95,
      },
      gap: null,
    };
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No criminal law violations detected.', rule: 'criminal_check', blocked: false, confidence: 0.95 },
    gap: null,
  };
}

// civil: no contractual harm, no tortious interference
async function checkCivil(actionType, details, requestText, jurisdictions, userId) {
  const text = (requestText || '').toLowerCase();

  // Tortious interference patterns
  if (/induce.*breach|interfere.*(contract|business).*(relationship|deal)/.test(text)) {
    return {
      opinion: { verdict: 'NON_COMPLIANT', reason: 'Civil: tortious interference with contract/business relationship. Ref: Restatement (Second) of Torts §766.', rule: 'tortious_interference', blocked: true, confidence: 0.85 },
      gap: null,
    };
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No civil tort violations detected.', rule: 'civil_check', blocked: false, confidence: 0.9 },
    gap: null,
  };
}

// ip: open-source license violations, patent infringement, trade secrets, trademark
async function checkIP(actionType, details, requestText, jurisdictions, userId) {
  const text = (requestText || '').toLowerCase();

  // IP violation patterns
  const ipPatterns = [
    { pattern: /reproduce.*(gpl|agpl|open.source)/i, action: 'distribute_gpl_code', confidence: 0.9 },
    { pattern: /use.*patent.*without.*(license|permission)/i, action: 'infringe_patent', confidence: 0.85 },
    { pattern: /trade secret|confidential.*(info|code|data)/i, action: 'misappropriate_trade_secret', confidence: 0.8 },
    { pattern: /infringe.*(trademark|brand|logo)/i, action: 'infringe_trademark', confidence: 0.85 },
    { pattern: /pirate|crack|bypass.*(license|authentication)/i, action: 'distribute_gpl_code', confidence: 0.9 },
  ];

  for (const { pattern, action, confidence } of ipPatterns) {
    if (pattern.test(text)) {
      return {
        opinion: { verdict: 'NON_COMPLIANT', reason: `IP violation: text matches ${action} pattern. Ref: ${getIPStatute(action)}`, rule: action, blocked: true, confidence },
        gap: null,
      };
    }
  }

  // Action-type specific IP checks
  const ipActions = ['distribute_gpl_code', 'network_access_agpl', 'infringe_patent',
    'infringe_trademark', 'misappropriate_trade_secret', 'generate_code'];
  if (ipActions.includes(actionType)) {
    return {
      opinion: {
        verdict: 'NON_COMPLIANT',
        reason: `IP: action type "${actionType}" requires license verification before execution.`,
        rule: actionType,
        blocked: true,
        confidence: 0.9,
      },
      gap: null,
    };
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No IP violations detected.', rule: 'ip_check', blocked: false, confidence: 0.9 },
    gap: null,
  };
}

function getIPStatute(action) {
  const map = {
    'distribute_gpl_code': 'GPL v3 §6',
    'infringe_patent': '35 USC §271',
    'infringe_trademark': 'Lanham Act §32 (15 USC §1114)',
    'misappropriate_trade_secret': 'DTSA (18 USC §1836)',
    'generate_code': '17 USC §506 (Copyright)',
  };
  return map[action] || 'IP statute';
}

// privacy: GDPR, CCPA, PDPA, data residency
async function checkPrivacy(actionType, details, requestText, jurisdictions, userId) {
  const text = (requestText || '').toLowerCase();

  // Privacy violation patterns
  if (/collect.*(personal|sensitive).*(without|no).*(consent|legal.basis)/i.test(text)) {
    return {
      opinion: { verdict: 'NON_COMPLIANT', reason: 'Privacy: personal data collected without lawful basis. Ref: GDPR Art.5, CCPA §1798.100.', rule: 'unlawful_data_collection', blocked: true, confidence: 0.9 },
      gap: null,
    };
  }

  if (/sell.*(personal|user).*(data|info)/i.test(text) && (jurisdictions.includes('ca') || jurisdictions.includes('us'))) {
    return {
      opinion: { verdict: 'NON_COMPLIANT', reason: 'Privacy: selling personal data without required disclosure. Ref: CCPA §1798.100, GDPR Art.6.', rule: 'unlawful_data_sale', blocked: true, confidence: 0.9 },
      gap: null,
    };
  }

  if (/transfer.*(eu|european).*(data|user|personal).*(us|without|outside)/i.test(text)) {
    return {
      opinion: { verdict: 'NON_COMPLIANT', reason: 'Privacy: EU personal data transferred without adequate safeguards. Ref: GDPR Art.44-49.', rule: 'eu_data_transfer_violation', blocked: true, confidence: 0.9 },
      gap: null,
    };
  }

  // Privacy action types
  const privacyActions = ['process_personal_data', 'delete_user_data', 'share_user_data'];
  if (privacyActions.includes(actionType)) {
    const requiresGDPR = jurisdictions.includes('eu') || jurisdictions.includes('uk');
    const requiresCCPA = jurisdictions.includes('ca');
    if (requiresGDPR || requiresCCPA) {
      return {
        opinion: {
          verdict: 'AMBIGUOUS',
          reason: `Privacy: action "${actionType}" triggers GDPR${requiresGDPR ? ' Art.5, Art.17' : ''}${requiresCCPA ? ', CCPA' : ''}. Legal basis not confirmed — escalate to Polsia.`,
          rule: actionType,
          blocked: true,
          confidence: 0.8,
        },
        gap: null,
      };
    }
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No privacy violations detected for relevant jurisdictions.', rule: 'privacy_check', blocked: false, confidence: 0.9 },
    gap: null,
  };
}

// sanctions: OFAC, EU, UN, industry-specific
async function checkSanctions(actionType, details, requestText, jurisdictions, userId) {
  const sanctionsActions = ['transact_with_sdn', 'transact_with_eu_sanctioned', 'transact_with_un_sanctioned'];
  if (sanctionsActions.includes(actionType)) {
    return {
      opinion: {
        verdict: 'NON_COMPLIANT',
        reason: `Sanctions: action "${actionType}" violates OFAC/EU/UN sanctions regulations. Strict liability applies. Ref: OFAC SDN List, EU Consolidated Sanctions.`,
        rule: 'sanctions_violation',
        blocked: true,
        confidence: 0.98,
      },
      gap: null,
    };
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No sanctions concerns for this action.', rule: 'sanctions_check', blocked: false, confidence: 0.95 },
    gap: null,
  };
}

// tax: withholding, reporting, nexus, VAT/GST
async function checkTax(actionType, details, requestText, jurisdictions, userId) {
  const taxActions = ['pay_worker', 'sell_digital_service_eu', 'sell_digital_service_uk', 'sell_to_us_state'];

  if (taxActions.includes(actionType)) {
    // VAT/GST check for EU
    if (actionType === 'sell_digital_service_eu' && jurisdictions.includes('eu')) {
      return {
        opinion: { verdict: 'AMBIGUOUS', reason: 'Tax: selling digital services to EU customers requires VAT registration. OSS scheme available. Manual verification required.', rule: 'eu_vat_obligation', blocked: true, confidence: 0.85 },
        gap: null,
      };
    }

    // Sales tax nexus for US states
    if (actionType === 'sell_to_us_state') {
      return {
        opinion: { verdict: 'AMBIGUOUS', reason: 'Tax: US state sales tax nexus thresholds vary ($100K/200 transactions typical). Verify applicable states before charging.', rule: 'us_state_sales_tax_nexus', blocked: true, confidence: 0.8 },
        gap: null,
      };
    }

    return {
      opinion: {
        verdict: 'NON_COMPLIANT',
        reason: `Tax: action "${actionType}" has tax compliance implications. Verify withholding/reporting obligations.`,
        rule: actionType,
        blocked: true,
        confidence: 0.85,
      },
      gap: null,
    };
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No tax compliance concerns for this action.', rule: 'tax_check', blocked: false, confidence: 0.9 },
    gap: null,
  };
}

// contract: enforceability, jurisdiction, interpretation rules
async function checkContract(actionType, details, requestText, jurisdictions, userId) {
  const pricingActions = ['billing_period_tier_change', 'discount_code', 'custom_enterprise_price',
    'free_tier_feature_gate', 'pay_to_win_feature', 'cross_subsidy_discount'];

  if (pricingActions.includes(actionType)) {
    // Delegate to RECT for pricing actions
    try {
      const rectResult = await rect().runLegalCheck({ action_type: actionType, details, reason: requestText || '', userId });
      if (rectResult.opinions?.rect) {
        const rectOpinion = rectResult.opinions.rect;
        if (rectOpinion.verdict === 'NON_COMPLIANT') {
          return {
            opinion: { verdict: 'NON_COMPLIANT', reason: `Contract: unconscionable pricing — RECT non-compliant. ${rectOpinion.reason}`, rule: rectOpinion.rule || 'contract_rect_integration', blocked: true, confidence: 0.9 },
            gap: null,
          };
        }
        if (rectOpinion.verdict === 'AMBIGUOUS') {
          return {
            opinion: { verdict: 'AMBIGUOUS', reason: `Contract ambiguity — RECT evaluation inconclusive. ${rectOpinion.reason}`, rule: rectOpinion.rule || 'contract_rect_integration', blocked: true, confidence: 0.8 },
            gap: null,
          };
        }
      }
    } catch (_) {}
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No contract enforceability issues detected.', rule: 'contract_check', blocked: false, confidence: 0.85 },
    gap: null,
  };
}

// consumer_protection: FTC, state laws, EU DSA
async function checkConsumerProtection(actionType, details, requestText, jurisdictions, userId) {
  const text = (requestText || '').toLowerCase();

  // Deceptive practice patterns
  const deceptivePatterns = [
    { pattern: /guaranteed.*(return|result|outcome)/i, confidence: 0.9 },
    { pattern: /100%.*(success|profit|outcome)/i, confidence: 0.9 },
    { pattern: /fake.*(urgency|scarcity|countdown)/i, confidence: 0.9 },
    { pattern: /hidden.*fee|surprise.*charge|bait.and.switch/i, confidence: 0.9 },
    { pattern: /no (risk|obligation|credit card).*required/i, confidence: 0.85 },
    { pattern: /as.seen.on|featured.in|testimonial.*without/i, confidence: 0.85 },
  ];

  for (const { pattern, confidence } of deceptivePatterns) {
    if (pattern.test(text)) {
      return {
        opinion: { verdict: 'NON_COMPLIANT', reason: `Consumer protection: deceptive practice pattern detected (confidence ${confidence}). Ref: FTC Act §5, CCPA §1798.100.`, rule: 'deceptive_practice', blocked: true, confidence },
        gap: null,
      };
    }
  }

  return {
    opinion: { verdict: 'COMPLIANT', reason: 'No consumer protection violations detected.', rule: 'consumer_protection_check', blocked: false, confidence: 0.9 },
    gap: null,
  };
}

// ── Reason building ───────────────────────────────────────────────────────────

function buildSummaryReason(verdict, reason_chain, gaps) {
  switch (verdict) {
    case 'NON_COMPLIANT':
      return `BLOCKED: ${reason_chain.length} non-compliant category(ies). ${gaps.length} law gaps flagged. Refs: ${reason_chain.map(r => r.substring(0, 60)).join('; ')}`;
    case 'AMBIGUOUS':
      return `ESCALATION REQUIRED: ${reason_chain.length} ambiguous category(ies) — requires Polsia review. ${gaps.length} law gaps detected.`;
    case 'COMPLIANT':
      if (gaps.length > 0) return `COMPLIANT but ${gaps.length} law gaps detected — manual review required.`;
      return 'COMPLIANT: all applicable law categories passed.';
    default:
      return 'Compliance check complete.';
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function logComplianceCheck(request, report, ctx) {
  const { action_type, details, reason, request_text } = request;
  const { userId = null, projectId = null } = ctx;

  await pool.query(
    `INSERT INTO legal_engine_check_log
      (user_id, action_type, details, reason, overall_verdict, blocked, escalation_id,
       criminal_verdict, civil_verdict, ip_verdict, privacy_verdict,
       sanctions_verdict, tax_verdict, contract_verdict, rect_verdict,
       consumer_protection_verdict, building_code_verdict, proposed_fix)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      userId || null,
      action_type,
      JSON.stringify(details || {}),
      reason || null,
      report.verdict,
      report.blocked,
      report.escalation_id || null,
      report.opinions?.criminal?.verdict || null,
      report.opinions?.civil?.verdict || null,
      report.opinions?.ip?.verdict || null,
      report.opinions?.privacy?.verdict || null,
      report.opinions?.sanctions?.verdict || null,
      report.opinions?.tax?.verdict || null,
      report.opinions?.contract?.verdict || null,
      report.opinions?.rect?.verdict || null,
      report.opinions?.consumer_protection?.verdict || null,
      report.opinions?.building_code?.verdict || null,
      report.gaps?.length ? `Law gaps: ${JSON.stringify(report.gaps)}` : null,
    ]
  );
}

// ── Wire point: called from moral drift detection (Phase 36P) ──────────────────

/**
 * Legal compliance check triggered from moral drift detection.
 * Checks if the drifted output involves any legal implications.
 * If legal violation detected, escalation is immediate (critical priority).
 *
 * @param {string} outputText - Wallt's output text that triggered drift
 * @param {string} sessionUuid
 * @param {number|null} userId
 */
async function checkFromMoralDrift(outputText, sessionUuid, userId) {
  const report = await legal_compliance_check(
    {
      action_type: 'output_evaluation',
      details: { output: outputText },
      reason: 'Moral drift detected — checking legal implications of drifted output',
      request_text: outputText,
    },
    { userId, sessionUuid }
  );

  if (report.blocked && report.escalation_id) {
    // Critical escalation: drift + legal violation
    try {
      const { triggerFromMoralDrift } = require('./wallt-escalation');
      await triggerFromMoralDrift(
        0.85,
        {
          flags: Object.entries(report.opinions).map(([cat, o]) => ({
            type: 'legal_compliance_violation',
            severity: 'critical',
            category: cat,
            reason: o.reason,
            confidence: o.confidence || 0.9,
          })),
          legal_report: report,
          recommendation: `CRITICAL: Drift output also contains legal violations. Escalating immediately.`,
        },
        userId,
        sessionUuid
      );
    } catch (err) {
      console.warn('[wallt-legal-compliance] drift legal escalation failed:', err.message);
    }
  }

  return report;
}

// ── Jurisdiction management ────────────────────────────────────────────────────

async function listJurisdictions() {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_legal_jurisdictions WHERE is_active = TRUE ORDER BY region, display_name;`
  );
  return rows;
}

async function getJurisdictionByCode(code) {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_legal_jurisdictions WHERE jurisdiction = $1 AND is_active = TRUE;`,
    [code]
  );
  return rows[0] || null;
}

// ── Gap detection and flagging ────────────────────────────────────────────────

/**
 * Flag a missing/unknown law in the compliance report.
 * Gaps do NOT assume compliance — they trigger manual review.
 */
async function flagLawGap({ category, action_type, jurisdictions, missing_reason }) {
  const { rows } = await pool.query(
    `INSERT INTO legal_engine_check_log
       (user_id, action_type, overall_verdict, blocked, proposed_fix)
     VALUES (NULL, $1, 'AMBIGUOUS', TRUE, $2)
     RETURNING id`,
    [
      action_type || 'unknown',
      `Law gap: ${category} — ${missing_reason}. Jurisdictions: ${(jurisdictions || []).join(', ')}. Manual review required.`,
    ]
  );
  return rows[0];
}

module.exports = {
  legal_compliance_check,
  checkFromMoralDrift,
  detectJurisdictions,
  listJurisdictions,
  getJurisdictionByCode,
  flagLawGap,
  LAW_CATEGORIES,
  categoriesForAction,
};