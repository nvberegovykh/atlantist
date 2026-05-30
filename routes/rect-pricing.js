/**
 * Owns: /api/rect/* — RECT (Reverse Equilibrium Cooperative Trading) pricing engine.
 * Does NOT own: billing subscription lifecycle, Stripe checkout, per-user cost ledger.
 *
 * RECT principle: equal cost distribution across all users. As the network grows,
 * per-user cost decreases automatically. Formula is public and auditable.
 *
 * Formula: C_per_user = (C_fixed + C_marginal × N_users) / N_users
 *   - C_fixed = Atlantist fixed costs + Polsia platform cost (both shared equally)
 *   - C_marginal = $0.20/user (API, storage, compute)
 *   - Result: $29.20 solo-user ceiling → $0.20 at scale → $5 floor (never below)
 *   - Polsia costs ARE included in the numerator — that's the cooperative model.
 *   - No tiers, no premium versions. Formula is the same for everyone.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const rect = require('../config/plans');

// ── helpers ───────────────────────────────────────────────────────────────────

// Current active paying user count (subs active/trialing, not cancelled/suspended)
async function getActiveUserCount() {
  const res = await pool.query(`
    SELECT COUNT(*) FROM subscriptions
    WHERE status IN ('active', 'trialing')
  `);
  return parseInt(res.rows[0].count, 10) || 1; // min 1 to avoid /0
}

// ── dataset for live graph ──────────────────────────────────────────────────────
function buildCostCurve(maxUsers = 2000) {
  const userCounts = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  return userCounts
    .filter(n => n <= maxUsers)
    .map(n => ({ users: n, cost: rect.rectCost(n) }));
}

// ── endpoints ─────────────────────────────────────────────────────────────────

// GET /api/rect/pricing — public RECT pricing data
router.get('/pricing', async (req, res) => {
  try {
    const nUsers = await getActiveUserCount();
    const currentCost = rect.rectCost(nUsers);

    const milestones = [1, 10, 50, 100, 200, 500, 1000, 2000].map(n => ({
      users: n,
      cost_per_user: rect.rectCost(n),
      below_ceiling: rect.rectCost(n) < rect.ceiling,
      at_floor: rect.rectCost(n) === rect.floor,
    }));

    const curve = buildCostCurve(2000);

    res.json({
      formula: {
        equation: 'C_per_user = (C_fixed + C_marginal × N_users) / N_users',
        breakdown: {
          C_fixed_atlantist: `$${rect.atlantistFixedCost}/mo — Atlantist infrastructure, support, compliance`,
          C_fixed_polisia: `$${rect.polisiaPlatformCost}/mo — Polsia platform base plan (shared across all Atlantist users)`,
          C_marginal: `$${rect.marginalCostPerUser}/user/mo — API calls, storage, compute`,
          total_fixed: `$${rect.fixedCosts}/mo combined (both Atlantist + Polsia fixed costs)`,
          how_it_works: `At N users: cost = $${rect.fixedCosts}/N + $${rect.marginalCostPerUser} per user`,
          solo_user: `N=1 → $${rect.rectCost(1).toFixed(2)}/mo (all fixed costs absorbed, ceiling)`,
          at_scale: `N=1000 → $${rect.rectCost(1000).toFixed(2)}/mo (fixed costs amortized across 1000 users)`,
        },
        rules: {
          floor: `No user pays less than $${rect.floor}/mo (dormant accounts subsidized)`,
          ceiling: `No user pays more than $${rect.ceiling}/mo (break-even at N=1, solo user)`,
        },
        interpretation: `As N_users grows, each user pays less — fixed costs are shared equally.
Both Atlantist ($29/mo) and Polsia ($29/mo) platform costs are included — the cooperative
model distributes the full stack cost across the network. The curve starts at $${rect.ceiling.toFixed(2)}
for a single user and decreases toward $${rect.marginalCostPerUser} (the marginal cost floor) as
the network scales. No extraction, no markup. The formula is the same for every user.`,
      },
      current: {
        n_users: nUsers,
        cost_per_user: currentCost,
        below_ceiling: currentCost < rect.ceiling,
        note: 'Current per-user cost based on active subscriptions in database',
      },
      curve,
      milestones,
      audit: {
        formula_is_public: true,
        verifiable: true,
        no_tiers: true,
        no_premium_versions: true,
        explanation: 'Every user is on the same formula. There are no pricing tiers, no pro add-ons, no hidden fees.',
      },
    });
  } catch (err) {
    console.error('[rect] GET /pricing:', err);
    res.status(500).json({ error: 'Failed to compute RECT pricing' });
  }
});

// GET /api/rect/cost — authenticated: user's current cost position
router.get('/cost', async (req, res) => {
  try {
    const authMiddleware = require('./auth').authMiddleware;
    authMiddleware(req, res, async function onAuth() {
      const userId = req.user.id;
      const nUsers = await getActiveUserCount();
      const currentCost = rect.rectCost(nUsers);

      const { getCurrentMonthCost } = require('../db/cost-ledger');
      const mtd = await getCurrentMonthCost(userId);
      const rawMtd = parseFloat(mtd.total_cost) || 0;

      res.json({
        rect: {
          n_users: nUsers,
          cost_per_user: currentCost,
          fixed_costs_shared: rect.fixedCosts,
          atlantist_fixed: rect.atlantistFixedCost,
          polsia_platform_cost: rect.polisiaPlatformCost,
          marginal_cost_per_user: rect.marginalCostPerUser,
        },
        your_usage_this_month: {
          raw_cost: rawMtd,
          billed: Math.max(rect.floor, parseFloat((rawMtd * 2).toFixed(2))),
        },
        note: 'RECT pricing is network-wide. Your individual usage affects nothing.',
      });
    });
  } catch (err) {
    console.error('[rect] GET /cost:', err);
    res.status(500).json({ error: 'Failed to compute user cost' });
  }
});

module.exports = router;