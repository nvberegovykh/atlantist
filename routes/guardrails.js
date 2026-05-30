/**
 * Owns: /api/guardrails endpoints — universal simulation input validation,
 *       code reference lookup, and pre-run feasibility checks.
 * Does NOT own: Simulation engines, DB access, UI rendering, WebSocket broadcast.
 *
 * Provides the public API for the SimulationGuardrails module so any client
 * (browser, mobile, external tool) can check design feasibility before running.
 */
const router = require('express').Router();
const { validateInputs, checkCompliance, getDesignGuidance, getCodeReference,
        renderComplianceSummary, renderValidationIssues, renderDesignGuidance,
        DISCLAIMER } = require('../services/simulation-guardrails');

// POST /api/guardrails/validate — validate inputs for any simulation type
// Body: { simType, inputs }
// Returns: { valid, issues[], summary, severityCounts }
router.post('/validate', (req, res) => {
  try {
    const { simType, inputs = {} } = req.body;
    if (!simType) return res.status(400).json({ error: 'simType required (energy|fire|geotech|structural|mep_hvac|mep_plumbing|mep_electrical)' });

    const issues = validateInputs(simType, inputs);
    const criticals = issues.filter(i => i.severity === 'CRITICAL');
    const warnings = issues.filter(i => i.severity === 'WARNING');
    const infos = issues.filter(i => i.severity === 'INFO');

    const guidance = getDesignGuidance(simType, {
      status: criticals.length ? 'FAIL' : warnings.length ? 'MARGINAL' : 'PASS',
      violations: issues,
    });

    res.json({
      valid: criticals.length === 0,
      issues,
      severityCounts: { critical: criticals.length, warning: warnings.length, info: infos.length },
      summary: guidance.summary,
      status: guidance.status,
      score: guidance.score,
      nextSteps: guidance.nextSteps,
      canProceed: criticals.length === 0,
      disclaimer: DISCLAIMER,
      validationHtml: renderValidationIssues(issues),
      guidanceHtml: renderDesignGuidance(guidance),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/guardrails/check-compliance — deep code compliance scan
// Body: { simType, inputs, model? }
// Returns: { compliance: { critical[], warning[], info[] }, html }
router.post('/check-compliance', (req, res) => {
  try {
    const { simType, inputs = {}, model = null } = req.body;
    if (!simType) return res.status(400).json({ error: 'simType required' });

    const compliance = checkCompliance(simType, inputs, model);
    const html = renderComplianceSummary(compliance, simType);
    const guidance = getDesignGuidance(simType, {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    });
    res.json({
      compliance,
      html,
      status: guidance.status,
      score: guidance.score,
      nextSteps: guidance.nextSteps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guardrails/reference/:simType/:field — get code reference for a field
router.get('/reference/:simType/:field', (req, res) => {
  try {
    const { simType, field } = req.params;
    const ref = getCodeReference(simType, field);
    if (!ref) return res.status(404).json({ error: 'Field not found in validation rules for this simulation type' });
    res.json({ ...ref, disclaimer: DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guardrails/rules/:simType — get all validation rules for a sim type
router.get('/rules/:simType', (req, res) => {
  try {
    const { simType } = req.params;
    const { VALIDATION_RULES, DISCLAIMER } = require('../services/simulation-guardrails');
    const rules = VALIDATION_RULES[simType] || [];
    res.json({ rules, disclaimer: DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guardrails/sim-types — list available simulation types and their rules summary
router.get('/sim-types', (_req, res) => {
  try {
    const { VALIDATION_RULES, DISCLAIMER } = require('../services/simulation-guardrails');
    const types = Object.entries(VALIDATION_RULES).map(([key, rules]) => ({
      simType: key,
      label: LABELS[key] || key,
      ruleCount: rules.length,
      criticalRules: rules.filter(r => r.severity === 'CRITICAL').length,
    }));
    res.json({ types, disclaimer: DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LABELS = {
  energy:        'Energy Analysis (ASHRAE 90.1 / NYECC)',
  fire:          'Fire Protection (NFPA 13/101/92)',
  geotech:       'Geotechnical Analysis (NAVFAC DM 7.01)',
  structural:    'Structural Analysis (AISC 360 / ACI 318)',
  mep_hvac:      'MEP — HVAC (ASHRAE 90.1 / SMACNA)',
  mep_plumbing:  'MEP — Plumbing (IPC / NFPA 13)',
  mep_electrical:'MEP — Electrical (NEC)',
};

module.exports = router;