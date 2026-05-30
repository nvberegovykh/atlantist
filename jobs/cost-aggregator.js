/**
 * Cost aggregator job — runs daily via polsia.toml cron.
 * Aggregates infrastructure costs per user per day:
 * - Compute: simulation runs (energy, geotech, fire, MEP) * estimated cost
 * - Storage: approximate row counts from event_ledger, elements, family_instances per user
 * - Bandwidth: IFC/DXF exports, render requests
 * - API: RVT import (Forge), render API calls
 * - Hosting amort: monthly base cost ÷ active users (minimum $3.50 amort/day for dormant)
 *
 * Also recalculates billing predictions at month-end.
 */
'use strict';

require('dotenv').config();
const pool = require('../db/index');
const {
  upsertDailyCost,
  upsertMonthlySnapshot,
  computePrediction,
  upsertPrediction,
  recordActualCost,
  getMonthlyAggregateCost
} = require('../db/cost-ledger');

const MONTHLY_AMORT = parseFloat(process.env.MONTHLY_HOSTING_AMORT || '3.50');
const TODAY = new Date().toISOString().slice(0, 10);
const CURRENT_MONTH = TODAY.slice(0, 7) + '-01';

function toDollars(cents) {
  return parseFloat((cents / 100).toFixed(4));
}

async function aggregateComputeCost(userId) {
  // Compute cost = number of simulation runs * cost per run
  // EnergyPlus ~$0.05/run, OpenSees ~$0.03/run, FDS ~$0.08/run
  const [energy, geo, fire, mep] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM energy_simulations WHERE created_at::date = $1::date AND created_by = $2`, [TODAY, userId]),
    pool.query(`SELECT COUNT(*) FROM geotechnical_runs WHERE created_at::date = $1::date AND created_by = $2`, [TODAY, userId]),
    pool.query(`SELECT COUNT(*) FROM fire_protection_runs WHERE created_at::date = $1::date AND created_by = $2`, [TODAY, userId]),
    pool.query(`SELECT COUNT(*) FROM mep_simulation_runs WHERE created_at::date = $1::date AND user_id = $2`, [TODAY, userId])
  ]);
  const runs = parseInt(energy.rows[0].count) + parseInt(geo.rows[0].count) +
               parseInt(fire.rows[0].count) + parseInt(mep.rows[0].count);
  return runs * 0.05; // $0.05 avg per simulation run
}

async function aggregateStorageCost(userId) {
  // Estimate storage by counting rows across major tables
  const tables = ['elements', 'family_instances', 'event_ledger', 'projects', 'renders'];
  let totalRows = 0;
  for (const table of tables) {
    try {
      // Only count if table has user_id column
      if (table === 'elements' || table === 'projects' || table === 'renders') {
        const r = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE created_by = $1`, [userId]);
        totalRows += parseInt(r.rows[0].count);
      } else if (table === 'family_instances') {
        const r = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE created_by = $1`, [userId]);
        totalRows += parseInt(r.rows[0].count);
      } else {
        // event_ledger — join to projects via project_id
        const r = await pool.query(`SELECT COUNT(*) FROM event_ledger e JOIN projects p ON e.project_id = p.id WHERE p.created_by = $1 AND e.created_at::date = $1::date`, [userId, TODAY]);
        totalRows += parseInt(r.rows[0].count);
      }
    } catch (e) {
      // Table may not exist or have different column — skip
    }
  }
  // ~50 bytes avg per row, $0.25/GB/mo
  return toDollars(Math.ceil(totalRows * 50 / 1_073_741_824 * 0.25 * 100));
}

async function aggregateBandwidthCost(userId) {
  // Estimate bandwidth from IFC exports, DXF exports, render requests today
  const [ifcExports, renders] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM ifc_export_runs WHERE created_at::date = $1::date AND user_id = $2`, [TODAY, userId]),
    pool.query(`SELECT COUNT(*) FROM renders WHERE created_at::date = $1::date AND user_id = $2`, [TODAY, userId])
  ]);
  const exports = parseInt(ifcExports.rows[0].count);
  const renderCalls = parseInt(renders.rows[0].count);
  // Avg IFC export ~5MB, render ~1MB, each worth ~$0.01
  return exports * 0.01 + renderCalls * 0.002;
}

async function aggregateApiCost(userId) {
  // RVT import = Forge API calls ($$$), render API = $$/call
  const [rvtImports, renderApi] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM rvt_import_runs WHERE created_at::date = $1::date AND user_id = $2`, [TODAY, userId]),
    pool.query(`SELECT COUNT(*) FROM renders WHERE created_at::date = $1::date AND user_id = $2`, [TODAY, userId])
  ]);
  // Rough costs: RVT import ~$0.20/run (Forge), render ~$0.005/call
  return parseInt(rvtImports.rows[0].count) * 0.20 + parseInt(renderApi.rows[0].count) * 0.005;
}

async function aggregateHostingAmort(userId) {
  // Pro-rated daily amort of monthly hosting cost
  // If user has active subscription, they get hosting included in plan
  // If dormant (< 1 active session this month), charge minimum amort
  const r = await pool.query(`
    SELECT COUNT(*) FROM auth_sessions
    WHERE user_id = $1
      AND last_active >= $2::date
      AND last_active < ($2::date + interval '1 month')
  `, [userId, CURRENT_MONTH]);
  const activeSessions = parseInt(r.rows[0].count);
  // Dormant = < 3 sessions this month → minimum amort
  if (activeSessions < 3) return MONTHLY_AMORT / 30;
  return 0.05; // active users contribute minimally to hosting (base covered by plan)
}

async function getActiveUserIds() {
  // Get users who have auth sessions or project activity this month
  const { rows } = await pool.query(`
    SELECT DISTINCT user_id FROM (
      SELECT created_by AS user_id FROM projects WHERE created_at::date >= $1::date
      UNION
      SELECT user_id FROM auth_sessions WHERE last_active >= $1::date
    ) u
  `, [CURRENT_MONTH]);
  return rows.map(r => r.user_id);
}

async function run() {
  console.log(`[cost-aggregator] Running daily cost aggregation for ${TODAY}`);

  const userIds = await getActiveUserIds();
  console.log(`[cost-aggregator] Found ${userIds.length} active users`);

  for (const userId of userIds) {
    try {
      const [computeCost, storageCost, bandwidthCost, apiCost, hostingAmort] = await Promise.all([
        aggregateComputeCost(userId),
        aggregateStorageCost(userId),
        aggregateBandwidthCost(userId),
        aggregateApiCost(userId),
        aggregateHostingAmort(userId)
      ]);

      await upsertDailyCost({
        userId,
        date: TODAY,
        computeCost,
        storageCost,
        bandwidthCost,
        apiCost,
        hostingAmort,
        note: `Daily aggregate for ${TODAY}`
      });

      console.log(`[cost-aggregator] User ${userId}: c=$${computeCost.toFixed(4)} s=$${storageCost.toFixed(4)} b=$${bandwidthCost.toFixed(4)} a=$${apiCost.toFixed(4)} h=$${hostingAmort.toFixed(4)}`);
    } catch (err) {
      console.error(`[cost-aggregator] Error for user ${userId}:`, err.message);
    }
  }

  // Update monthly snapshots for all users
  await updateMonthlySnapshots();

  // Recalculate predictions for users whose billing month just ended
  await recalculatePredictions();

  console.log(`[cost-aggregator] Daily aggregation complete for ${TODAY}`);
}

async function updateMonthlySnapshots() {
  const { rows } = await pool.query(`
    SELECT user_id,
           COALESCE(SUM(compute_cost),0)  AS compute_cost,
           COALESCE(SUM(storage_cost),0)  AS storage_cost,
           COALESCE(SUM(bandwidth_cost),0) AS bandwidth_cost,
           COALESCE(SUM(api_cost),0)      AS api_cost,
           COALESCE(SUM(hosting_amort),0) AS hosting_amort,
           COALESCE(SUM(total_cost),0)    AS total_cost
    FROM user_cost_ledger
    WHERE date >= $1::date AND date < ($1::date + interval '1 month')
    GROUP BY user_id
  `, [CURRENT_MONTH]);

  for (const row of rows) {
    await upsertMonthlySnapshot({
      userId:     row.user_id,
      month:      CURRENT_MONTH,
      computeCost:  parseFloat(row.compute_cost),
      storageCost:  parseFloat(row.storage_cost),
      bandwidthCost: parseFloat(row.bandwidth_cost),
      apiCost:      parseFloat(row.api_cost),
      hostingAmort: parseFloat(row.hosting_amort),
      totalCost:    parseFloat(row.total_cost),
      billStatus:   'month_to_date'
    });
  }
}

async function recalculatePredictions() {
  // If today is the last day of month (or within 2 days of month end), finalize and predict
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dayDiff = lastDay.getDate() - now.getDate();

  if (dayDiff > 2) {
    console.log('[cost-aggregator] Not month-end — skipping prediction recalc');
    return;
  }

  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);

  // Record actual cost for previous month
  const prevAgg = await pool.query(`
    SELECT COALESCE(SUM(total_cost),0) AS total_cost
    FROM user_cost_ledger
    WHERE date >= $1::date AND date < ($1::date + interval '1 month')
  `, [prevMonth]);

  const allUsers = await getActiveUserIds();
  for (const userId of allUsers) {
    try {
      const userPrev = await pool.query(`
        SELECT COALESCE(SUM(total_cost),0) AS total_cost
        FROM user_cost_ledger
        WHERE user_id = $1 AND date >= $2::date AND date < ($2::date + interval '1 month')
      `, [userId, prevMonth]);

      const actualCost = parseFloat(userPrev.rows[0].total_cost);
      if (actualCost > 0) {
        await recordActualCost(userId, prevMonth, actualCost);
      }

      // Compute new prediction for next month
      const prediction = await computePrediction(userId);
      if (prediction !== null) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
        await upsertPrediction(userId, nextMonth, prediction);
      }
    } catch (err) {
      console.error(`[cost-aggregator] Prediction error for user ${userId}:`, err.message);
    }
  }

  console.log(`[cost-aggregator] Predictions recalculated for ${allUsers.length} users`);
}

// Run if called directly
if (require.main === module) {
  run().then(() => { process.exit(0); }).catch(err => {
    console.error('[cost-aggregator] Fatal:', err);
    process.exit(1);
  });
}

module.exports = { run };