/**
 * Owns: user_cost_ledger, billing_predictions, cost_optimization_triggers, monthly_cost_snapshots.
 * Does NOT own: Stripe subscriptions, billing checkout flow.
 */
const pool = require('./index');

// ─── Daily cost ledger ───────────────────────────────────────────────────

/**
 * Upsert a daily cost snapshot for a user.
 */
async function upsertDailyCost({ userId, date, computeCost = 0, storageCost = 0, bandwidthCost = 0, apiCost = 0, hostingAmort = 0, note = null }) {
  const total = parseFloat(computeCost) + parseFloat(storageCost) + parseFloat(bandwidthCost) + parseFloat(apiCost) + parseFloat(hostingAmort);
  const { rows } = await pool.query(`
    INSERT INTO user_cost_ledger (user_id, date, compute_cost, storage_cost, bandwidth_cost, api_cost, hosting_amort, total_cost, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (user_id, date) DO UPDATE SET
      compute_cost   = EXCLUDED.compute_cost,
      storage_cost   = EXCLUDED.storage_cost,
      bandwidth_cost = EXCLUDED.bandwidth_cost,
      api_cost       = EXCLUDED.api_cost,
      hosting_amort  = EXCLUDED.hosting_amort,
      total_cost     = EXCLUDED.total_cost,
      note           = EXCLUDED.note
    RETURNING *
  `, [userId, date, computeCost, storageCost, bandwidthCost, apiCost, hostingAmort, total, note]);
  return rows[0];
}

/**
 * Get a user's daily costs for a given month.
 */
async function getDailyCostsForMonth(userId, yearMonth) {
  const { rows } = await pool.query(`
    SELECT date, compute_cost, storage_cost, bandwidth_cost, api_cost, hosting_amort, total_cost
    FROM user_cost_ledger
    WHERE user_id = $1 AND date >= $2::date AND date < ($2::date + interval '1 month')
    ORDER BY date
  `, [userId, yearMonth]);
  return rows;
}

/**
 * Get current month's total for a user (month-to-date).
 */
async function getCurrentMonthCost(userId) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(compute_cost),0)  AS compute_cost,
           COALESCE(SUM(storage_cost),0)  AS storage_cost,
           COALESCE(SUM(bandwidth_cost),0) AS bandwidth_cost,
           COALESCE(SUM(api_cost),0)      AS api_cost,
           COALESCE(SUM(hosting_amort),0) AS hosting_amort,
           COALESCE(SUM(total_cost),0)     AS total_cost
    FROM user_cost_ledger
    WHERE user_id = $1 AND date >= $2::date
  `, [userId, start.toISOString().slice(0, 10)]);
  return rows[0];
}

/**
 * Get aggregate monthly cost for a specific month (all users combined).
 */
async function getMonthlyAggregateCost(yearMonth) {
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(compute_cost),0)  AS compute_cost,
           COALESCE(SUM(storage_cost),0)  AS storage_cost,
           COALESCE(SUM(bandwidth_cost),0) AS bandwidth_cost,
           COALESCE(SUM(api_cost),0)      AS api_cost,
           COALESCE(SUM(hosting_amort),0) AS hosting_amort,
           COALESCE(SUM(total_cost),0)     AS total_cost
    FROM user_cost_ledger
    WHERE date >= $1::date AND date < ($1::date + interval '1 month')
  `, [yearMonth]);
  return rows[0];
}

/**
 * Get top cost drivers across all users for current month.
 * Returns breakdown by category + per-user top consumer.
 */
async function getTopCostDrivers(yearMonth) {
  const agg = await getMonthlyAggregateCost(yearMonth);
  const total = parseFloat(agg.total_cost) || 0;

  // Per-user breakdown
  const { rows: byUser } = await pool.query(`
    SELECT user_id,
           COALESCE(SUM(total_cost),0) AS total_cost,
           COALESCE(SUM(compute_cost),0) AS compute_cost,
           COALESCE(SUM(storage_cost),0) AS storage_cost,
           COALESCE(SUM(bandwidth_cost),0) AS bandwidth_cost,
           COALESCE(SUM(api_cost),0) AS api_cost,
           COALESCE(SUM(hosting_amort),0) AS hosting_amort
    FROM user_cost_ledger
    WHERE date >= $1::date AND date < ($1::date + interval '1 month')
    GROUP BY user_id
    ORDER BY total_cost DESC
    LIMIT 10
  `, [yearMonth]);

  // Category breakdown
  const categories = [
    { name: 'compute', value: parseFloat(agg.compute_cost) },
    { name: 'storage', value: parseFloat(agg.storage_cost) },
    { name: 'bandwidth', value: parseFloat(agg.bandwidth_cost) },
    { name: 'api', value: parseFloat(agg.api_cost) },
    { name: 'hosting', value: parseFloat(agg.hosting_amort) }
  ].sort((a, b) => b.value - a.value);

  return {
    total,
    categories,
    top_driver: categories[0]?.name || 'compute',
    top_driver_pct: total > 0 ? (categories[0].value / total * 100).toFixed(1) : 0,
    by_user: byUser
  };
}

// ─── Monthly cost snapshots ──────────────────────────────────────────────

async function upsertMonthlySnapshot({ userId, month, computeCost = 0, storageCost = 0, bandwidthCost = 0, apiCost = 0, hostingAmort = 0, totalCost = 0, billedAmount = 0, billStatus = 'month_to_date' }) {
  const { rows } = await pool.query(`
    INSERT INTO monthly_cost_snapshots (user_id, month, compute_cost, storage_cost, bandwidth_cost, api_cost, hosting_amort, total_cost, billed_amount, bill_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (user_id, month) DO UPDATE SET
      compute_cost  = EXCLUDED.compute_cost,
      storage_cost  = EXCLUDED.storage_cost,
      bandwidth_cost = EXCLUDED.bandwidth_cost,
      api_cost      = EXCLUDED.api_cost,
      hosting_amort = EXCLUDED.hosting_amort,
      total_cost    = EXCLUDED.total_cost,
      billed_amount = EXCLUDED.billed_amount,
      bill_status   = EXCLUDED.bill_status
    RETURNING *
  `, [userId, month, computeCost, storageCost, bandwidthCost, apiCost, hostingAmort, totalCost, billedAmount, billStatus]);
  return rows[0];
}

async function getMonthlySnapshot(userId, month) {
  const { rows } = await pool.query(`
    SELECT * FROM monthly_cost_snapshots WHERE user_id = $1 AND month = $2::date
  `, [userId, month]);
  return rows[0] || null;
}

// ─── Billing predictions ─────────────────────────────────────────────────

/**
 * Compute weighted-average prediction from last 3 months of actual costs.
 * Recent months weighted more heavily: month1*0.5 + month2*0.3 + month3*0.2
 */
async function computePrediction(userId) {
  const { rows } = await pool.query(`
    SELECT month, actual_cost
    FROM billing_predictions
    WHERE user_id = $1 AND actual_cost IS NOT NULL
    ORDER BY month DESC
    LIMIT 3
  `, [userId]);

  if (rows.length === 0) return null;

  let total = 0, weight = 0;
  const weights = [0.5, 0.3, 0.2];
  rows.forEach((row, i) => {
    const w = weights[i] ?? 0.2;
    total += parseFloat(row.actual_cost) * w;
    weight += w;
  });

  return weight > 0 ? parseFloat((total / weight).toFixed(2)) : null;
}

async function upsertPrediction(userId, month, predictedCost) {
  const { rows } = await pool.query(`
    INSERT INTO billing_predictions (user_id, month, predicted_cost)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, month) DO UPDATE SET predicted_cost = EXCLUDED.predicted_cost
    RETURNING *
  `, [userId, month, predictedCost]);
  return rows[0];
}

async function recordActualCost(userId, month, actualCost) {
  const { rows } = await pool.query(`
    INSERT INTO billing_predictions (user_id, month, actual_cost)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, month) DO UPDATE SET actual_cost = EXCLUDED.actual_cost
    RETURNING *
  `, [userId, month, actualCost]);
  return rows[0];
}

async function getPrediction(userId, month) {
  const { rows } = await pool.query(`
    SELECT * FROM billing_predictions WHERE user_id = $1 AND month = $2::date
  `, [userId, month]);
  return rows[0] || null;
}

async function getPredictionHistory(userId, months = 12) {
  const { rows } = await pool.query(`
    SELECT month, predicted_cost, actual_cost, adjustment_applied
    FROM billing_predictions
    WHERE user_id = $1
    ORDER BY month DESC
    LIMIT $2
  `, [userId, months]);
  return rows;
}

// ─── Cost optimization triggers ──────────────────────────────────────────

async function createOptimizationTrigger({ triggerDate, totalMonthlyCost, topDriver, driverPct, analysis, actionPlan }) {
  const { rows } = await pool.query(`
    INSERT INTO cost_optimization_triggers (trigger_date, total_monthly_cost, top_driver, driver_pct, analysis, action_plan, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending')
    RETURNING *
  `, [triggerDate, totalMonthlyCost, topDriver, driverPct, JSON.stringify(analysis), JSON.stringify(actionPlan)]);
  return rows[0];
}

async function getPendingTriggers() {
  const { rows } = await pool.query(`
    SELECT * FROM cost_optimization_triggers WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5
  `);
  return rows;
}

async function approveTrigger(triggerId, approvedBy) {
  const { rows } = await pool.query(`
    UPDATE cost_optimization_triggers
    SET status = 'approved', approved_at = NOW(), approved_by = $2
    WHERE id = $1
    RETURNING *
  `, [triggerId, approvedBy]);
  return rows[0];
}

async function updateTriggerActionPlan(triggerId, actionPlan, generatedTasks) {
  const { rows } = await pool.query(`
    UPDATE cost_optimization_triggers
    SET action_plan = $2, generated_tasks = $3
    WHERE id = $1
    RETURNING *
  `, [triggerId, JSON.stringify(actionPlan), JSON.stringify(generatedTasks)]);
  return rows[0];
}

async function markTriggerExecuted(triggerId) {
  const { rows } = await pool.query(`
    UPDATE cost_optimization_triggers
    SET status = 'executed', executed_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [triggerId]);
  return rows[0];
}

async function verifyTriggerCost(triggerId, verifiedCost) {
  const { rows } = await pool.query(`
    UPDATE cost_optimization_triggers
    SET status = 'verified', verified_cost = $2, verified_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [triggerId, verifiedCost]);
  return rows[0];
}

async function getTriggerHistory(limit = 20) {
  const { rows } = await pool.query(`
    SELECT * FROM cost_optimization_triggers ORDER BY created_at DESC LIMIT $1
  `, [limit]);
  return rows;
}

module.exports = {
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
};