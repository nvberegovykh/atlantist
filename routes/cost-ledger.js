/**
 * Owns: /api/cost/* — cost ledger read/write, prediction, optimization trigger management.
 * Does NOT own: billing checkout, subscription lifecycle, Stripe.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const {
  upsertDailyCost,
  getDailyCostsForMonth,
  getCurrentMonthCost,
  getMonthlyAggregateCost,
  getTopCostDrivers,
  upsertMonthlySnapshot,
  getMonthlySnapshot,
  computePrediction,
  upsertPrediction,
  recordActualCost,
  getPrediction,
  getPredictionHistory,
  createOptimizationTrigger,
  getPendingTriggers,
  approveTrigger,
  updateTriggerActionPlan,
  markTriggerExecuted,
  verifyTriggerCost,
  getTriggerHistory
} = require('../db/cost-ledger');

// ─── Internal helpers ────────────────────────────────────────────────────

const MONTHLY_AMORT = parseFloat(process.env.MONTHLY_HOSTING_AMORT || '3.50');
const COST_MULTIPLIER = 2; // 100% markup

// Billing floor — minimum $5/mo to cover dormant accounts
const MINIMUM_BILL = 5;

// Configurable tax rate (env var or JSON array for per-jurisdiction rates).
// Default 0 → no change from previous behavior.
// Format examples:
//   TAX_RATE=0.08              → 8% applied to infra_cost
//   TAX_RATE=[{"jurisdiction":"NY","rate":0.08875},{"jurisdiction":"CA","rate":0.0725}]
// Accepts decimal float or JSON array string; invalid input silently falls back to 0.
let TAX_RATE = 0;
(function() {
  const raw = process.env.TAX_RATE;
  if (!raw) return;
  try { TAX_RATE = JSON.parse(raw); } catch { TAX_RATE = parseFloat(raw) || 0; }
})();

// Compute applicable taxes on a raw cost. Supports flat rate (float) or
// per-jurisdiction array. Extension point for future multi-jurisdiction logic.
function computeTaxes(rawCost, rate) {
  if (!rate || rate === 0) return 0;
  if (typeof rate === 'number') return parseFloat((rawCost * rate).toFixed(4));
  // Array: for now average all rates; future work would match user jurisdiction
  if (Array.isArray(rate)) {
    if (rate.length === 0) return 0;
    const avg = rate.reduce((s, r) => s + (typeof r.rate === 'number' ? r.rate : 0), 0) / rate.length;
    return parseFloat((rawCost * avg).toFixed(4));
  }
  return 0;
}

// Markup a raw cost, with taxes included in base before multiplier.
// New formula: bill = max($5, (infra_cost + applicable_taxes) × 2)
// Edge case: if taxes are 0/undefined, degrades to existing behavior.
function applyPricing(rawCost) {
  const taxes = computeTaxes(rawCost, TAX_RATE);
  const taxedBase = rawCost + taxes;
  return Math.max(MINIMUM_BILL, parseFloat((taxedBase * COST_MULTIPLIER).toFixed(2)));
}

// ─── GET /api/cost/me — current user's cost snapshot ─────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const mtd = await getCurrentMonthCost(req.user.id);
    const prediction = await computePrediction(req.user.id);
    const currentMonth = new Date().toISOString().slice(0, 7) + '-01';
    const pred = await getPrediction(req.user.id, currentMonth);

    const raw = parseFloat(mtd.total_cost) || 0;
    const taxes = computeTaxes(raw, TAX_RATE);
    const billed = applyPricing(raw);
    const predictionBilled = prediction ? applyPricing(prediction) : null;

    res.json({
      month_to_date: {
        compute_cost:   parseFloat(mtd.compute_cost) || 0,
        storage_cost:   parseFloat(mtd.storage_cost) || 0,
        bandwidth_cost: parseFloat(mtd.bandwidth_cost) || 0,
        api_cost:       parseFloat(mtd.api_cost) || 0,
        hosting_amort:  parseFloat(mtd.hosting_amort) || 0,
        infra_cost:     raw,
        taxes_applicable: taxes,
        raw_total:      raw,
        your_bill:      billed,
        billing_floor:  MINIMUM_BILL
      },
      prediction: {
        predicted_cost:  prediction || null,
        predicted_bill:  predictionBilled,
        next_month_estimate: predictionBilled
      },
      formula: {
        multiplier: COST_MULTIPLIER,
        description: 'your_bill = max($5, (infra_cost + taxes) × 2)',
        tax_rate: TAX_RATE,
        philosophy: 'You pay exactly what it costs us to run your workspace — plus 100% so we can keep building. No hidden fees, no overcharging.'
      }
    });
  } catch (err) {
    console.error('[cost-ledger] GET /me', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/cost/history — prediction history ─────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const history = await getPredictionHistory(req.user.id, 12);
    res.json({
      history: history.map(h => ({
        month:           h.month,
        predicted_cost:  parseFloat(h.predicted_cost),
        actual_cost:     h.actual_cost ? parseFloat(h.actual_cost) : null,
        predicted_bill:  h.actual_cost ? applyPricing(parseFloat(h.actual_cost)) : applyPricing(parseFloat(h.predicted_cost)),
        actual_bill:     h.actual_cost ? applyPricing(parseFloat(h.actual_cost)) : null
      }))
    });
  } catch (err) {
    console.error('[cost-ledger] GET /history', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/cost/daily — daily cost breakdown for current month ────────
router.get('/daily', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const daily = await getDailyCostsForMonth(req.user.id, currentMonth);

    res.json({
      month: currentMonth,
      days: daily.map(d => ({
        date:           d.date,
        compute_cost:   parseFloat(d.compute_cost),
        storage_cost:   parseFloat(d.storage_cost),
        bandwidth_cost: parseFloat(d.bandwidth_cost),
        api_cost:       parseFloat(d.api_cost),
        hosting_amort:  parseFloat(d.hosting_amort),
        raw_total:      parseFloat(d.total_cost),
        daily_bill:     applyPricing(parseFloat(d.total_cost))
      }))
    });
  } catch (err) {
    console.error('[cost-ledger] GET /daily', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cost/record — record a cost event ──────────────────────────
router.post('/record', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { date, computeCost, storageCost, bandwidthCost, apiCost, hostingAmort, note } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

    const record = await upsertDailyCost({
      userId:       req.user.id,
      date,
      computeCost:  computeCost || 0,
      storageCost:  storageCost || 0,
      bandwidthCost: bandwidthCost || 0,
      apiCost:      apiCost || 0,
      hostingAmort: hostingAmort || MONTHLY_AMORT / 30,
      note
    });

    res.json({ success: true, record });
  } catch (err) {
    console.error('[cost-ledger] POST /record', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/cost/admin/summary — all-users aggregate (admin only) ────
router.get('/admin/summary', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    // Role check — require admin
    const { getUserRole } = require('../db/roles');
    const role = await getUserRole(req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const drivers = await getTopCostDrivers(currentMonth);

    const pending = await getPendingTriggers();
    const history = await getTriggerHistory(10);

    res.json({
      current_month: currentMonth,
      aggregate: {
        compute_cost:   parseFloat(drivers.aggregate?.compute_cost || 0),
        storage_cost:   parseFloat(drivers.aggregate?.storage_cost || 0),
        bandwidth_cost: parseFloat(drivers.aggregate?.bandwidth_cost || 0),
        api_cost:       parseFloat(drivers.aggregate?.api_cost || 0),
        hosting_amort:  parseFloat(drivers.aggregate?.hosting_amort || 0),
        total:          drivers.total
      },
      drivers: {
        top_driver:   drivers.top_driver,
        top_pct:      drivers.top_driver_pct,
        categories:  drivers.categories,
        by_user:      drivers.by_user
      },
      optimization_triggers: {
        pending,
        recent: history
      }
    });
  } catch (err) {
    console.error('[cost-ledger] GET /admin/summary', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cost/admin/trigger — manually trigger optimization analysis ─
router.post('/admin/trigger', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { getUserRole } = require('../db/roles');
    const role = await getUserRole(req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const drivers = await getTopCostDrivers(currentMonth);

    const trigger = await createOptimizationTrigger({
      triggerDate:     new Date(),
      totalMonthlyCost: parseFloat(drivers.total.toFixed(2)),
      topDriver:       drivers.top_driver,
      driverPct:       parseFloat(drivers.top_driver_pct),
      analysis:        { category_breakdown: drivers.categories, by_user: drivers.by_user },
      actionPlan:      {}
    });

    res.json({ success: true, trigger });
  } catch (err) {
    console.error('[cost-ledger] POST /admin/trigger', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cost/admin/approve/:id — approve an optimization trigger ─
router.post('/admin/approve/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { getUserRole } = require('../db/roles');
    const role = await getUserRole(req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const updated = await approveTrigger(parseInt(req.params.id), req.user.id);
    if (!updated) return res.status(404).json({ error: 'Trigger not found' });

    res.json({ success: true, trigger: updated });
  } catch (err) {
    console.error('[cost-ledger] POST /admin/approve', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cost/admin/update-plan/:id — update action plan ────────────
router.post('/admin/update-plan/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { getUserRole } = require('../db/roles');
    const role = await getUserRole(req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { actionPlan, generatedTasks } = req.body;
    const updated = await updateTriggerActionPlan(
      parseInt(req.params.id),
      actionPlan || {},
      generatedTasks || []
    );
    res.json({ success: true, trigger: updated });
  } catch (err) {
    console.error('[cost-ledger] POST /admin/update-plan', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/cost/calculator — static cost model for public pricing page ─
router.get('/calculator', (req, res) => {
  res.json({
    cost_multiplier: COST_MULTIPLIER,
    billing_floor: MINIMUM_BILL,
    tax_rate: TAX_RATE,
    formula: 'your_bill = max($5, (infra_cost + taxes) × 2)',
    formula_backward_compatible: TAX_RATE === 0,
    cost_categories: [
      { key: 'compute',   label: 'Compute',  description: 'EnergyPlus, OpenSees, FDS simulation runtime (CPU-seconds per run)' },
      { key: 'storage',   label: 'Storage',  description: 'PostgreSQL row/byte usage — event ledger, shadow pages, model data' },
      { key: 'bandwidth', label: 'Bandwidth', description: 'WebSocket data transfer, file exports (IFC/DXF/DWG/gbXML), .rvt imports' },
      { key: 'api',       label: '3rd-party APIs', description: 'Autodesk Model Derivative calls, Veras render API — tracked per-call' },
      { key: 'hosting',   label: 'Hosting',  description: 'Render service cost amortized across active users (base floor)' }
    ],
    estimator_defaults: {
      simulations_per_month: 5,
      storage_gb: 0.5,
      team_size: 1,
      api_calls: 10
    },
    estimator_rates: {
      compute_per_sim: 0.05,     // $0.05 per simulation (avg EnergyPlus run ~5 CPU-min)
      storage_per_gb: 0.25,      // $0.25/GB/mo
      bandwidth_per_user: 0.15,  // $0.15/user/mo average
      api_per_call: 0.002        // $0.002 per API call
    }
  });
});

module.exports = router;