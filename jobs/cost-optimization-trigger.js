/**
 * Cost optimization trigger job — runs monthly (declared in polsia.toml).
 * Checks if total monthly infrastructure cost across ALL users hits the $150/mo threshold.
 * If so: identifies top cost driver, generates replacement plan, creates engineering tasks.
 * Manual approval gate: tasks are created but require owner approval before execution.
 *
 * Threshold logic:
 * - < $150/mo: system is healthy, log and exit
 * - >= $150/mo: trigger P0 optimization pipeline (5-10× reduction target)
 */
'use strict';

require('dotenv').config();
const pool = require('../db/index');
const {
  getTopCostDrivers,
  createOptimizationTrigger,
  getPendingTriggers,
  updateTriggerActionPlan,
  markTriggerExecuted,
  verifyTriggerCost
} = require('../db/cost-ledger');

const COST_THRESHOLD = 150; // $150/mo — P0 trigger threshold

const REPLACEMENT_PLANS = {
  compute: {
    name: 'Compute (EnergyPlus / OpenSees / FDS)',
    self_hosted: [
      { tool: 'EnergyPlus standalone binary', url: 'https://energyplus.net/downloads', cost_reduction: '0.7× (eliminates cloud GPU overhead)' },
      { tool: 'OpenSees single-binary', url: 'https://opensees.berkeley.edu/', cost_reduction: '0.6× (local binary, no API)' },
      { tool: 'FDS compiled binary', url: 'https://pages.nist.gov/fds-smv/', cost_reduction: '0.8× (pure compute, no platform fee)' }
    ],
    engineering_effort: 'Medium — requires Docker container + S3 result upload pattern'
  },
  storage: {
    name: 'Storage (PostgreSQL row bloat)',
    self_hosted: [
      { tool: 'pg_repack compression', url: 'https://repack.org/', cost_reduction: '0.5× (compress event_ledger, shadow pages)' },
      { tool: 'Row-level archiving', url: null, cost_reduction: '0.6× (archive 90+ day old events to cold storage)' },
      { tool: 'pg_partman (time-based partitioning)', url: 'https://github.com/pgpartman/pg_partman', cost_reduction: '0.4× (partition event_ledger by month)' }
    ],
    engineering_effort: 'Low — run partition scripts + add archiving cron'
  },
  bandwidth: {
    name: 'Bandwidth (IFC/DXF export)',
    self_hosted: [
      { tool: 'Compress IFC output (gzip)', url: null, cost_reduction: '0.7× (reduce export size 3-5×)' },
      { tool: 'CDN cache for exported files', url: null, cost_reduction: '0.5× (cache热门 exports 24h)' }
    ],
    engineering_effort: 'Low — add compression middleware + CDN headers'
  },
  api: {
    name: '3rd-party API (Autodesk Forge / Veras)',
    self_hosted: [
      { tool: 'IFC-only import (drop Forge dependency)', url: null, cost_reduction: '0.3× (eliminate Forge API entirely)' },
      { tool: 'Result caching + deduplication', url: null, cost_reduction: '0.5× (cache converted models)' },
      { tool: 'Veras: local Stable Diffusion alternative', url: 'https://stability.ai/stable-diffusion', cost_reduction: '0.2× (self-hosted, no per-call fee)' }
    ],
    engineering_effort: 'High — drop Forge, replace with open-source IFC parser + local ML render'
  },
  hosting: {
    name: 'Hosting (Render service cost)',
    self_hosted: [
      { tool: 'Spot instances for batch workloads', url: 'https://render.com/docs/sleep-mode', cost_reduction: '0.6× (spot for simulation workers)' },
      { tool: 'Scale-to-zero on idle (sleep mode)', url: null, cost_reduction: '0.4× (auto-suspend after 30min inactivity)' }
    ],
    engineering_effort: 'Medium — add sleep mode + spot instance config'
  }
};

async function run() {
  console.log(`[cost-optimization] Running monthly threshold check`, new Date().toISOString());

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  // Get aggregate across all users
  const drivers = await getTopCostDrivers(currentMonth);
  const totalMonthlyCost = parseFloat(drivers.total) || 0;

  console.log(`[cost-optimization] Total monthly cost: $${totalMonthlyCost.toFixed(2)}, threshold: $${COST_THRESHOLD}`);

  if (totalMonthlyCost < COST_THRESHOLD) {
    console.log(`[cost-optimization] Below threshold — no action needed. (Current: $${totalMonthlyCost.toFixed(2)} / $${COST_THRESHOLD})`);
    return;
  }

  // P0 TRIGGER — cost exceeds threshold
  console.error(`[cost-optimization] ⚠️  P0 TRIGGER — Monthly cost $${totalMonthlyCost.toFixed(2)} exceeds $${COST_THRESHOLD} threshold!`);
  console.error(`[cost-optimization] Top cost driver: ${drivers.top_driver} (${drivers.top_driver_pct}%)`);

  // Check if we already have a pending trigger for this month (avoid duplicates)
  const pending = await getPendingTriggers();
  const existing = pending.find(t => t.trigger_date?.slice(0, 7) === currentMonth.slice(0, 7));

  if (existing) {
    console.log(`[cost-optimization] Pending trigger already exists for ${currentMonth.slice(0, 7)} — skipping duplicate`);
    return;
  }

  // Create the trigger
  const plan = REPLACEMENT_PLANS[drivers.top_driver] || REPLACEMENT_PLANS.compute;
  const actionPlan = {
    top_driver: drivers.top_driver,
    driver_name: plan.name,
    recommendations: plan.self_hosted,
    engineering_effort: plan.engineering_effort,
    estimated_cost_reduction: plan.self_hosted[0]?.cost_reduction || '0.5×',
    category_breakdown: drivers.categories
  };

  const trigger = await createOptimizationTrigger({
    triggerDate:      new Date(),
    totalMonthlyCost: parseFloat(totalMonthlyCost.toFixed(2)),
    topDriver:        drivers.top_driver,
    driverPct:        parseFloat(drivers.top_driver_pct),
    analysis: {
      total_cost: totalMonthlyCost,
      top_driver: drivers.top_driver,
      top_pct: drivers.top_driver_pct,
      categories: drivers.categories,
      by_user: drivers.by_user.slice(0, 5) // top 5 users by cost
    },
    actionPlan
  });

  console.log(`[cost-optimization] ✅ Created optimization trigger #${trigger.id} for ${drivers.top_driver}`);
  console.log(`[cost-optimization] Recommendations: ${plan.self_hosted.map(r => r.tool).join(', ')}`);
  console.log(`[cost-optimization] Owner approval required — trigger is PENDING. Tasks will be generated but not auto-executed.`);

  // Create engineering tasks automatically
  await generateEngineeringTasks(trigger.id, plan, drivers.top_driver, totalMonthlyCost, drivers);
}

async function generateEngineeringTasks(triggerId, plan, topDriver, totalMonthlyCost, drivers) {
  const topPct = parseFloat(drivers.top_driver_pct) || 50;
  const tasks = plan.self_hosted.map((rec) => ({
    title: `Cost optimization: Replace ${topDriver} — ${rec.tool}`,
    description: `Migrate ${topDriver} cost center to ${rec.tool}. Target: ${rec.cost_reduction}. ` +
      `Current monthly spend: ~$${(totalMonthlyCost * topPct / 100).toFixed(2)}. ` +
      `Engineering effort: ${plan.engineering_effort}. Reference: ${rec.url || 'internal'}. ` +
      `Owner must approve before execution.`,
    type: 'engineering',
    priority: 'high',
    tag: 'engineering',
    complexity: topDriver === 'api' ? 8 : topDriver === 'compute' ? 7 : 4,
    estimated_hours: topDriver === 'api' ? 12 : topDriver === 'compute' ? 8 : 4,
    reason: `P0: Monthly infrastructure cost $${totalMonthlyCost.toFixed(2)} exceeds $150 threshold. ${topDriver} is ${topPct}% of spend.`,
    source: 'agent_generated',
    executability_type: 'needs_new_connection',
    task_category: 'engineering',
    task_type: 'feature',
    suggestion_reasoning: `Autonomous cost optimization triggered — ${rec.tool} reduces ${topDriver} costs to ${rec.cost_reduction}`,
    assets: []
  }));

  await updateTriggerActionPlan(triggerId, plan, tasks);
  console.log(`[cost-optimization] Generated ${tasks.length} engineering tasks for trigger #${triggerId}`);
}

// Run if called directly
if (require.main === module) {
  run().then(() => { process.exit(0); }).catch(err => {
    console.error('[cost-optimization] Fatal:', err);
    process.exit(1);
  });
}

module.exports = { run };