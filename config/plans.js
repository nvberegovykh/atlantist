/**
 * Owns: Polsia platform costs and Atlantist base costs for RECT pricing.
 * Does NOT own: user-specific cost ledger, Stripe subscription amounts.
 *
 * RECT Cost Model:
 *   C_per_user = (C_fixed + C_marginal × N_users) / N_users
 *   C_fixed = Atlantist fixed (infra, support, compliance) + Polsia base platform cost
 *   C_marginal = per-user marginal (API, storage, compute)
 *
 * Polsia bills Atlantist a flat $29/mo base plan. That cost is shared across all
 * Atlantist users via the RECT formula, just like Atlantist's own fixed costs.
 * C_platform (the Polsia cost) IS included in C_fixed — that's the whole point.
 *
 * Ceiling = solo-user break-even: $29.20 (all fixed + marginal absorbed by one user)
 * Floor = $5/mo (dormant accounts subsidized; no user pays less)
 */
module.exports = {
  // ── RECT constants ────────────────────────────────────────────────────────────
  atlantistFixedCost: 29,          // $/mo — Atlantist infra, support, compliance
  polsiaPlatformCost: 29,         // $/mo — Polsia base plan (Polsia's cost to Atlantist)
  marginalCostPerUser: 0.20,      // $/mo — API calls, storage, compute per active user

  get fixedCosts() {
    return this.atlantistFixedCost + this.polisiaPlatformCost;
  },

  // ── RECT boundaries ─────────────────────────────────────────────────────────────
  floor: 5,                      // $/mo — no user pays less
  ceiling: 29.20,                 // $/mo — solo-user break-even (all fixed + marginal)

  // ── helpers ───────────────────────────────────────────────────────────────────

  rectCost(nUsers) {
    if (nUsers <= 0) return this.ceiling;
    const raw = (this.fixedCosts + this.marginalCostPerUser * nUsers) / nUsers;
    return Math.max(this.floor, Math.min(this.ceiling, parseFloat(raw.toFixed(2))));
  },

  buildCostCurve(maxUsers = 2000) {
    const userCounts = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    return userCounts
      .filter(n => n <= maxUsers)
      .map(n => ({ users: n, cost: this.rectCost(n) }));
  },
};