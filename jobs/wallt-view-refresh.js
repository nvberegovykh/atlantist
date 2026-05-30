/**
 * wallt-view-refresh.js — polsia.toml cron: "wallt-view-refresh"
 * Refreshes materialized views for the Reasoner agent.
 *
 * Every 5 min: refresh mv_wallt_deployment_readiness (low cost, always fresh)
 * Every 30 min: refresh code-quality + test-coverage MVs (heavier, safe on lower freq)
 *
 * Uses CONCURRENTLY so the app stays up during refresh.
 * Updates wallt_view_refresh_log so the Reasoner knows freshness age.
 */

const pool = require('../db/index');

const EVERY_5_MIN = [
  'mv_wallt_deployment_readiness',
];

const EVERY_30_MIN = [
  'mv_wallt_code_quality_metrics',
  'mv_wallt_test_coverage_map',
];

async function refreshView(viewName) {
  const start = Date.now();
  const client = await pool.connect();
  try {
    await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
    const ms = Date.now() - start;

    const { rows } = await client.query(
      `SELECT COUNT(*) AS cnt FROM ${viewName}`
    );

    await client.query(
      `INSERT INTO wallt_view_refresh_log (view_name, refreshed_at, refresh_ms, rows_affected)
       VALUES ($1, NOW(), $2, $3)
       ON CONFLICT (view_name) DO UPDATE SET
         refreshed_at = NOW(), refresh_ms = EXCLUDED.refresh_ms,
         rows_affected = EXCLUDED.rows_affected`,
      [viewName, ms, parseInt(rows[0].cnt, 10)]
    );

    console.log(`[wallt-view-refresh] ${viewName}: OK in ${ms}ms, ${rows[0].cnt} rows`);
    return { view: viewName, status: 'ok', refresh_ms: ms };
  } catch (e) {
    console.error(`[wallt-view-refresh] ${viewName}: ERROR — ${e.message}`);
    return { view: viewName, status: 'error', error: e.message };
  } finally {
    client.release();
  }
}

async function main() {
  const minute = new Date().getUTCMinutes();
  const is30 = minute % 30 === 0;

  const views = [...EVERY_5_MIN, ...(is30 ? EVERY_30_MIN : [])];

  console.log(`[wallt-view-refresh] Running at minute ${minute} — refreshing ${views.join(', ')}`);

  const results = await Promise.all(views.map(refreshView));
  const failed = results.filter(r => r.status === 'error');

  if (failed.length) {
    console.error(`[wallt-view-refresh] ${failed.length} view(s) failed:`, failed.map(f => f.view).join(', '));
    process.exit(1);
  }

  console.log(`[wallt-view-refresh] Done — ${results.length} view(s) refreshed.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[wallt-view-refresh] Unhandled error:', err);
  process.exit(1);
});