/**
 * Owns: /api/wallt/legal-registry/* — Wallt Legal Registry REST API.
 * Does NOT own: legal engine logic (services/wallt-legal-registry.js).
 * Phase 36L: legal_compliance_check(codes[], jurisdiction, params) → compliance_report.
 */
const router = require('express').Router();
const { optionalAuth } = require('./auth');
const { legal_compliance_check, quickCheck, getSystemInfo } = require('../services/wallt-legal-registry');
const { searchCodes, listCodeSystems } = require('../db/wallt-legal-registry');
const { getReports } = require('../db/wallt-legal-registry');

// GET  /api/wallt/legal-registry/systems          — supported code systems + jurisdictions
// GET  /api/wallt/legal-registry/systems/:system — entries for a specific system
// GET  /api/wallt/legal-registry/search          — keyword search
// GET  /api/wallt/legal-registry/reports         — user's compliance reports
// POST /api/wallt/legal-registry/quick-check     — single code quick-lookup
// POST /api/wallt/legal-registry/check           — full compliance check (main endpoint)

router.get('/systems', optionalAuth, async (req, res) => {
  try {
    const systems = await getSystemInfo();
    res.json({ systems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/systems/:code_system', optionalAuth, async (req, res) => {
  try {
    const { code_system } = req.params;
    const { jurisdiction, version, limit = 50 } = req.query;
    const entries = await searchCodes('', {
      codes: [code_system],
      jurisdiction: jurisdiction || undefined,
      limit: parseInt(limit),
    });
    res.json({ code_system, jurisdiction: jurisdiction || 'all', entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, codes, jurisdiction, limit = 20 } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query q must be at least 2 characters.' });
    }
    const codesList = codes ? codes.split(',').map(c => c.trim()) : [];
    const results = await searchCodes(q, {
      codes: codesList,
      jurisdiction: req.query.jurisdiction || undefined,
      limit: parseInt(limit),
    });
    res.json({ query: q, codes: codesList, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports', optionalAuth, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const reports = await getReports({ user_id: String(req.user.id), limit: 20 });
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/quick-check', optionalAuth, async (req, res) => {
  try {
    const { code, jurisdiction = 'us', parameter, value } = req.body;
    if (!code || !parameter || value === undefined) {
      return res.status(400).json({ error: 'code, parameter, and value are required.' });
    }
    const result = await quickCheck(code, jurisdiction, parameter, value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check', optionalAuth, async (req, res) => {
  try {
    const { codes = [], jurisdiction = 'us', params = {}, project_id, model_snapshot } = req.body;
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: 'codes must be a non-empty array of code system identifiers.' });
    }

    const userId = req.user ? req.user.id : null;
    const ctx = { userId, projectId: project_id || null, modelSnapshot: model_snapshot || null };

    const report = await legal_compliance_check(codes, jurisdiction, params, ctx);
    res.json(report);
  } catch (err) {
    console.error('[wallt-legal-registry] check error:', err);
    res.status(500).json({ error: err.message || 'Compliance check failed.' });
  }
});

module.exports = router;