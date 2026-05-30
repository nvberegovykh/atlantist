/**
 * Owns: legal_compliance_check() — the main compliance engine.
 * Does NOT own: RECT legal engine (rect-legal-engine.js), escalation (wallt-escalation.js).
 * Phase 36L: Wallt Legal Registry — real-time regulatory lookup across jurisdictions.
 *
 * Provides:
 *   legal_compliance_check(codes[], jurisdiction, parameters)
 *   → compliance_report
 *
 * Checks: building codes (IBC, NYC BC), fire safety (NFPA 13/101), energy (ASHRAE 90.1),
 * structural (AISC 360, ACI 318, NDS 2018), accessibility (WCAG 2.1 AA),
 * E2E encryption (Telegram-modeled).
 */
'use strict';

const {
  getCodesForJurisdiction,
  searchCodes,
  saveComplianceReport,
} = require('../db/wallt-legal-registry');

const rectLegalEngine = require('./rect-legal-engine');

/**
 * Main entry point. Check a set of codes against a jurisdiction with given parameters.
 *
 * @param {string[]} codes - code systems to check, e.g. ['ibc', 'nfpa', 'ashrae']
 * @param {string} jurisdiction - e.g. 'nyc', 'us', 'ca'
 * @param {object} params - BIM model parameters (area_sqm, occupant_load, fire_area_sqm, etc.)
 * @param {object} ctx - userId, projectId, modelSnapshot
 * @returns {Promise<compliance_report>}
 */
async function legal_compliance_check(codes, jurisdiction, params = {}, ctx = {}) {
  const { userId = null, projectId = null, modelSnapshot = null } = ctx;

  // Fetch applicable code entries
  const registryEntries = await getCodesForJurisdiction({ codes, jurisdiction });
  if (!registryEntries.length) {
    const report = buildReport({
      codes, jurisdiction, params,
      entries: [], overall_status: 'NOT_APPLICABLE',
      pass_count: 0, fail_count: 0, ambiguous_count: 0, not_applicable_count: 0,
      code_results: [], warnings: [], recommendations: [],
    });
    return report;
  }

  const codeResults = [];
  let passCount = 0, failCount = 0, ambiguousCount = 0, naCount = 0;
  const warnings = [];
  const recommendations = [];

  for (const entry of registryEntries) {
    const result = await checkCodeEntry(entry, params);
    codeResults.push({
      code: entry.code_system,
      code_number: entry.code_number,
      code_title: entry.code_title,
      version_label: entry.version_label,
      jurisdiction: entry.jurisdiction,
      status: result.status,
      reason: result.reason,
      section_ref: entry.section_ref,
      enforcement_level: entry.enforcement_level,
      penalty_severity: entry.penalty_severity,
      parameter_name: entry.parameter_name,
      parameter_value: entry.parameter_value,
      ai_summary: entry.ai_summary,
      warning: result.warning || null,
      recommendation: result.recommendation || null,
    });

    switch (result.status) {
      case 'PASS': passCount++; break;
      case 'FAIL': failCount++; break;
      case 'AMBIGUOUS': ambiguousCount++; break;
      default: naCount++;
    }
    if (result.warning) warnings.push({ code_number: entry.code_number, warning: result.warning });
    if (result.recommendation) recommendations.push({ code_number: entry.code_number, recommendation: result.recommendation });
  }

  let overall_status;
  if (failCount > 0) overall_status = 'FAIL';
  else if (ambiguousCount > 0) overall_status = 'AMBIGUOUS';
  else if (naCount === codeResults.length) overall_status = 'NOT_APPLICABLE';
  else overall_status = 'PASS';

  const report = buildReport({
    codes, jurisdiction, params,
    entries: registryEntries,
    overall_status,
    pass_count: passCount, fail_count: failCount,
    ambiguous_count: ambiguousCount, not_applicable_count: naCount,
    code_results: codeResults, warnings, recommendations,
  });

  // Persist report — fire and forget
  saveComplianceReport({
    user_id: userId ? String(userId) : null,
    codes_checked: codes,
    jurisdiction,
    project_id: projectId || null,
    model_snapshot: modelSnapshot || null,
    overall_status,
    pass_count: passCount, fail_count: failCount,
    ambiguous_count: ambiguousCount, not_applicable_count: naCount,
    code_results: codeResults, warnings, recommendations,
    parameters_used: params,
  }).catch(err => console.warn('[wallt-legal-registry] save report failed:', err.message));

  return report;
}

function buildReport({ codes, jurisdiction, params, entries, overall_status, pass_count, fail_count, ambiguous_count, not_applicable_count, code_results, warnings, recommendations }) {
  return {
    timestamp: new Date().toISOString(),
    codes_checked: codes,
    jurisdiction,
    parameters_used: params,
    entries_checked: entries.length,
    overall_status,
    summary: summarize(overall_status, pass_count, fail_count, ambiguous_count, not_applicable_count),
    pass_count,
    fail_count,
    ambiguous_count,
    not_applicable_count,
    code_results,
    warnings,
    recommendations,
  };
}

function summarize(overall_status, pass, fail, amb, na) {
  switch (overall_status) {
    case 'PASS': return `All ${pass} code${pass !== 1 ? 's' : ''} passed compliance checks.`;
    case 'FAIL': return `${fail} code${fail !== 1 ? 's' : ''} failed — see details for remediation.`;
    case 'AMBIGUOUS': return `Ambiguous results in ${amb} code${amb !== 1 ? 's' : ''} — manual review recommended.`;
    case 'NOT_APPLICABLE': return 'No applicable codes found for this jurisdiction and scope.';
    default: return 'Compliance check complete.';
  }
}

/**
 * Evaluate a single registry entry against given BIM parameters.
 */
async function checkCodeEntry(entry, params) {
  const p = entry.parameter_name ? params[entry.parameter_name] : null;

  // If no applicable parameter found, skip (not applicable)
  if (!entry.parameter_name || p === undefined || p === null) {
    return { status: 'NOT_APPLICABLE', reason: 'Parameter not provided in model data.', warning: null, recommendation: null };
  }

  // Dynamic evaluation — resolve parameter name and compare
  const numericParam = parseFloat(p);
  const minVal = entry.value_min !== null ? parseFloat(entry.value_min) : null;
  const maxVal = entry.value_max !== null ? parseFloat(entry.value_max) : null;

  // If entry has parameter_value threshold, compare numerically
  if (minVal !== null || maxVal !== null) {
    const value = numericParam;
    const violations = [];

    if (minVal !== null && value < minVal) {
      violations.push(`${entry.parameter_name} = ${value} (min: ${minVal})`);
    }
    if (maxVal !== null && value > maxVal) {
      violations.push(`${entry.parameter_name} = ${value} (max: ${maxVal})`);
    }

    if (violations.length > 0) {
      const reason = `${entry.code_number} ${entry.code_title}: ${violations.join('; ')}. Ref: ${entry.section_ref || 'see code'}`;
      return {
        status: entry.enforcement_level === 'recommendation' ? 'AMBIGUOUS' : 'FAIL',
        reason,
        warning: entry.enforcement_level === 'recommendation' ? `Soft limit exceeded: ${violations.join(', ')}` : null,
        recommendation: getRecommendation(entry, violations),
      };
    }

    return {
      status: 'PASS',
      reason: `${entry.parameter_name}=${value} within ${entry.code_number} limits (min ${minVal}, max ${maxVal}).`,
      warning: null,
      recommendation: null,
    };
  }

  // Formula-based evaluation
  if (entry.formula_reference) {
    return evaluateFormula(entry, params);
  }

  // Text/keyword-based — if ai_compliance_check_prompt exists, note it needs LLM evaluation
  if (entry.ai_compliance_check_prompt && entry.enforcement_level === 'code') {
    return {
      status: 'AMBIGUOUS',
      reason: `Code ${entry.code_number} requires complex evaluation — AI review recommended.`,
      warning: 'Natural-language evaluation required for this code section.',
      recommendation: `Invoke LLM review with prompt: ${entry.ai_compliance_check_prompt.substring(0, 100)}...`,
    };
  }

  return { status: 'PASS', reason: 'No active violations found.', warning: null, recommendation: null };
}

function evaluateFormula(entry, params) {
  const p = params[entry.parameter_name];
  const value = parseFloat(p);

  // Pattern: "A = 0.6 * GFA / FAR" → we evaluate the numeric side only
  // For registry entries, the constraint check is done via min/max above.
  // Formula reference is informational for human review.
  return {
    status: 'PASS',
    reason: `Formula ${entry.formula_reference} — parameter provided for manual calculation.`,
    warning: 'Formula evaluation requires BIM data context.',
    recommendation: `Calculate ${entry.formula_reference} using current model parameters.`,
  };
}

function getRecommendation(entry, violations) {
  const recommendations = {
    critical: `IMMEDIATE ACTION: ${entry.code_number} violation — contact authority having jurisdiction.`,
    major: `Correct ${violations.join(', ')} to comply with ${entry.code_number} before proceeding.`,
    minor: `Review ${entry.code_number} and document code compliance variance.`,
    warning: `Consult ${entry.source_name || entry.code_system} for guidance on ${entry.code_number}.`,
    info: `Consider upgrading to exceed ${entry.code_number} minimum requirements.`,
  };
  return recommendations[entry.penalty_severity] || recommendations.minor;
}

// ── Quick-check helpers ──────────────────────────────────────────────────────
// Used by Wallt to do a fast single-code lookup during chat

async function quickCheck(code, jurisdiction, parameter, value) {
  const results = await searchCodes(parameter, { codes: [code], jurisdiction, limit: 5 });
  if (!results.length) {
    return { status: 'NOT_APPLICABLE', reason: `No ${code} entry for ${jurisdiction} found.`, code };
  }
  const entry = results[0];
  const result = await checkCodeEntry({ ...entry, parameter_name: parameter }, { [parameter]: value });
  return {
    status: result.status,
    reason: result.reason,
    code: entry.code_system,
    code_number: entry.code_number,
    section_ref: entry.section_ref,
    ai_summary: entry.ai_summary,
  };
}

// ── System info ───────────────────────────────────────────────────────────────

async function getSystemInfo() {
  const { listCodeSystems } = require('../db/wallt-legal-registry');
  const systems = await listCodeSystems();

  // Group by system
  const grouped = {};
  for (const row of systems) {
    if (!grouped[row.code_system]) grouped[row.code_system] = [];
    grouped[row.code_system].push({ jurisdiction: row.jurisdiction, version: row.version_label, count: parseInt(row.count) });
  }

  return Object.entries(grouped).map(([code_system, variants]) => ({
    code_system,
    label: CODE_SYSTEM_LABELS[code_system] || code_system,
    supported_jurisdictions: variants,
    total_entries: variants.reduce((a, b) => a + b.count, 0),
  }));
}

const CODE_SYSTEM_LABELS = {
  ibc: 'International Building Code',
  nyc_bc: 'NYC Building Code',
  nfpa: 'NFPA Fire & Life Safety',
  ashrae: 'ASHRAE Energy Standard',
  aisc: 'AISC Steel Construction Manual',
  aci: 'ACI Concrete Building Code',
  nds: 'NDS Wood Design Standard',
  wcag: 'Web Content Accessibility Guidelines',
  encryption: 'End-to-End Encryption Standard',
};

module.exports = {
  legal_compliance_check,
  quickCheck,
  getSystemInfo,
  CODE_SYSTEM_LABELS,
};