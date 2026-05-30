/**
 * Owns: /api/wallt/legal-compliance/* — Wallt Layer 3 Dynamic Legal Compliance API.
 * Does NOT own: legal opinion logic (services/wallt-legal-compliance.js).
 * Phase 36P: jurisdiction-aware, all law categories, dynamic updates.
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const {
  legal_compliance_check,
  checkFromMoralDrift,
  listJurisdictions,
  getJurisdictionByCode,
  flagLawGap,
  LAW_CATEGORIES,
} = require('../services/wallt-legal-compliance');

// POST /api/wallt/legal-compliance/check        — main compliance check
// POST /api/wallt/legal-compliance/check-moral — legal check from moral drift
// GET  /api/wallt/legal-compliance/jurisdictions — supported jurisdictions
// GET  /api/wallt/legal-compliance/jurisdictions/:code — specific jurisdiction
// POST /api/wallt/legal-compliance/flag-gap   — flag a law gap for manual review
// GET  /api/wallt/legal-compliance/categories  — supported law categories

// ── POST /api/wallt/legal-compliance/check ──────────────────────────────────────
router.post('/check', optionalAuth, async (req, res) => {
  try {
    const { action_type, details, reason, request_text, jurisdictions } = req.body;
    if (!action_type || !reason) {
      return res.status(400).json({ error: 'action_type and reason are required.' });
    }

    const userId = req.user ? req.user.id : null;

    const ctx = {
      userId,
      projectId: req.body.project_id || null,
      jurisdictionContext: {
        explicit:           req.body.explicit_jurisdiction || null,
        projectLocation:    req.body.project_location      || null,
        userCountry:        req.body.user_country           || null,
        billingJurisdiction: req.body.billing_jurisdiction  || null,
      },
    };

    const report = await legal_compliance_check(
      { action_type, details: details || {}, reason, request_text },
      ctx
    );

    res.json({
      verdict: report.verdict,
      blocked: report.blocked,
      reason: report.reason,
      reason_chain: report.reason_chain,
      jurisdictions: report.jurisdictions,
      escalation_id: report.escalation_id,
      opinions: report.opinions,
      gaps: report.gaps,
      compliance_summary: report.reason,
    });
  } catch (err) {
    console.error('[wallt-legal-compliance] check error:', err.message);
    res.status(500).json({ error: 'Compliance check failed', details: err.message });
  }
});

// ── POST /api/wallt/legal-compliance/check-moral ───────────────────────────────
// Called from moral drift detection — legal check on drifted output
router.post('/check-moral', optionalAuth, async (req, res) => {
  try {
    const { output_text, session_uuid } = req.body;
    if (!output_text || !session_uuid) {
      return res.status(400).json({ error: 'output_text and session_uuid are required.' });
    }

    const userId = req.user ? req.user.id : null;
    const report = await checkFromMoralDrift(output_text, session_uuid, userId);

    res.json({
      verdict: report.verdict,
      blocked: report.blocked,
      reason: report.reason,
      escalation_id: report.escalation_id,
      opinions: report.opinions,
      gaps: report.gaps,
    });
  } catch (err) {
    console.error('[wallt-legal-compliance] moral check error:', err.message);
    res.status(500).json({ error: 'Legal drift check failed', details: err.message });
  }
});

// ── GET /api/wallt/legal-compliance/jurisdictions ─────────────────────────────
router.get('/jurisdictions', optionalAuth, async (req, res) => {
  try {
    const jurisdictions = await listJurisdictions();
    res.json({ jurisdictions, count: jurisdictions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/legal-compliance/jurisdictions/:code ────────────────────────
router.get('/jurisdictions/:code', optionalAuth, async (req, res) => {
  try {
    const j = await getJurisdictionByCode(req.params.code);
    if (!j) return res.status(404).json({ error: `Jurisdiction "${req.params.code}" not found.` });
    res.json({ jurisdiction: j });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/wallt/legal-compliance/flag-gap ───────────────────────────────────
router.post('/flag-gap', optionalAuth, async (req, res) => {
  try {
    const { category, action_type, jurisdictions, missing_reason } = req.body;
    if (!category || !missing_reason) {
      return res.status(400).json({ error: 'category and missing_reason are required.' });
    }

    const row = await flagLawGap({ category, action_type, jurisdictions, missing_reason });
    res.status(201).json({
      ok: true,
      gap_id: row.id,
      message: 'Law gap flagged for manual review.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt/legal-compliance/categories ─────────────────────────────────
router.get('/categories', optionalAuth, async (req, res) => {
  const categories = LAW_CATEGORIES.map(cat => ({
    id: cat,
    label: cat.replace(/_/g, ' ').replace(/\b\//g, m => m[1].toUpperCase()),
    description: CATEGORY_DESCRIPTIONS[cat] || 'Legal compliance category',
  }));

  res.json({
    categories,
    note: 'RCT and building_code checked automatically for applicable action types.',
  });
});

const CATEGORY_DESCRIPTIONS = {
  criminal:         'Criminal law — fraud, IP theft, sanctions violations',
  civil:            'Civil law — tortious interference, contractual harm',
  ip:              'Intellectual property — copyright, patent, trademark, trade secrets, open source licenses',
  privacy:         'Privacy law — GDPR, CCPA, PDPA, data residency',
  sanctions:       'Sanctions law — OFAC, EU, UN, industry-specific restrictions',
  tax:             'Tax law — withholding, reporting, nexus, VAT/GST',
  contract:        'Contract law — enforceability, jurisdiction, interpretation',
  consumer_protection: 'Consumer protection — FTC, state laws, EU DSA',
};

module.exports = router;