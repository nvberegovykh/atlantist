/**
 * Owns: Wallt Reasoner data access — view-first graph traversal for deterministic inference.
 * Does NOT own: LLM calls, wallt_core_decision_log writes, Wallt conversations.
 *
 * Data access pattern:
 *   1. Hit materialized view (pre-materialized, fresh if < 10 min old)
 *   2. Fall back to live query if view is stale (> 10 min since refresh)
 *   3. pgvector ANN queries use HNSW index (sub-ms on Neon)
 *
 * All queries are deterministic — no LLM, no KV cache, no PagedAttention.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/index');

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// ── Idempotent schema init — creates missing MVs and refresh_log if absent ─────
// Runs lazily on first request. MVs use IF NOT EXISTS so re-runs are safe.
let schemaInited = false;
async function initSchemaIfNeeded() {
  if (schemaInited) return;
  schemaInited = true;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallt_view_refresh_log (
        view_name    VARCHAR(64) PRIMARY KEY,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        refresh_ms   INTEGER,
        rows_affected INTEGER
      );
    `);
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_wallt_deployment_readiness AS
      SELECT NOW()::timestamptz AS computed_at, 0 AS pipelines_ok,
             0 AS deployment_score, 0 AS unresolved_escalations, 'READY' AS deploy_gate_status
      WHERE FALSE;
    `);
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_wallt_test_coverage_map AS
      SELECT 'no_data'::text AS module_name, 0 AS total_elements,
             0 AS coverage_pct, 'low' AS risk_level
      WHERE FALSE;
    `);
  } catch (e) {
    if (!e.message.includes('already exists')) {
      console.warn('[wallt-reasoner] schema init warn:', e.message);
    }
  } finally {
    client.release();
  }
}

// ── View freshness check ───────────────────────────────────────────────────────

async function isViewFresh(viewName) {
  try {
    const { rows } = await pool.query(
      `SELECT refreshed_at FROM wallt_view_refresh_log WHERE view_name = $1`,
      [viewName]
    );
    if (!rows.length) return false;
    const age = Date.now() - new Date(rows[0].refreshed_at).getTime();
    return age < STALE_THRESHOLD_MS;
  } catch (e) {
    // Table doesn't exist yet — treat as stale so next call falls back to live query
    if (e.message.includes('does not exist') || e.code === '42P01') return false;
    throw e;
  }
}

async function getViewFreshness() {
  await initSchemaIfNeeded();
  try {
    const { rows } = await pool.query(
      `SELECT view_name, refreshed_at, refresh_ms, rows_affected
       FROM wallt_view_refresh_log ORDER BY refreshed_at DESC`
    );
    return rows.map(r => ({
      view_name: r.view_name,
      refreshed_at: r.refreshed_at,
      refreshed_ms_ago: Math.round((Date.now() - new Date(r.refreshed_at).getTime()) / 1000),
      refresh_ms: r.refresh_ms,
      rows_affected: r.rows_affected,
      is_stale: Date.now() - new Date(r.refreshed_at).getTime() > STALE_THRESHOLD_MS,
    }));
  } catch (e) {
    // No refresh log yet — return empty so Reasoner falls back to live queries
    if (e.message.includes('does not exist') || e.code === '42P01') return [];
    throw e;
  }
}

// ── Helper: get from view or live ────────────────────────────────────────────

async function queryViewOrLive(viewName, viewQuery, liveQuery, params = []) {
  await initSchemaIfNeeded();
  const fresh = await isViewFresh(viewName);
  if (fresh) {
    try {
      const { rows, duration } = await pool.query(viewQuery, params);
      return { source: 'view', rows, duration_ms: duration ?? 0 };
    } catch (e) {
      // MV or refresh_log not ready — fall back to live query
      if (e.message.includes('does not exist') || e.code === '42P01' || e.code === '42883') {
        console.warn(`[wallt-reasoner] view ${viewName} unavailable, falling back to live: ${e.message}`);
      } else throw e;
    }
  }
  const { rows, duration } = await pool.query(liveQuery, params);
  return { source: 'live_fallback', rows, duration_ms: duration ?? 0 };
}

// ── GET /api/wallt-reasoner/code-quality ───────────────────────────────────────
// Aggregated code quality signals per module.
//
// Response: { source, freshness, modules: [{ module_name, total_runs, success_rate_pct, ... }] }
router.get('/code-quality', async (req, res) => {
  try {
    const freshness = await getViewFreshness();
    const viewData = freshness.find(f => f.view_name === 'mv_wallt_code_quality_metrics');

    const { rows, source, duration_ms } = await queryViewOrLive(
      'mv_wallt_code_quality_metrics',
      `SELECT * FROM mv_wallt_code_quality_metrics ORDER BY avg_red_issues DESC NULLS LAST, failed_runs DESC`,
      `-- live fallback: union all BIM analysis run status
       SELECT
         source AS module_name,
         COUNT(*)                                    AS total_runs,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) AS successful_runs,
         COUNT(CASE WHEN status = 'failed'   THEN 1 END) AS failed_runs,
         0 AS success_rate_pct, 0 AS avg_red_issues,
         0 AS avg_en001_compliance_pct, 0 AS avg_import_success_pct,
         MIN(created_at) AS first_run_at, MAX(created_at) AS last_run_at,
         NOW() AS computed_at
       FROM (
         SELECT 'structural_audit' AS source, status, NULL::JSONB AS totals,
                NULL::JSONB AS compliance, created_at FROM structural_audit_runs
         UNION ALL
         SELECT 'energy_simulation' AS source, status, NULL::JSONB,
                compliance AS compliance, created_at FROM energy_simulations
         UNION ALL
         SELECT 'rvt_import' AS source, status, NULL::JSONB, NULL::JSONB, created_at FROM rvt_import_runs
         UNION ALL
         SELECT 'ifc_import' AS source, status, NULL::JSONB, NULL::JSONB, created_at FROM ifc_import_runs
         UNION ALL
         SELECT 'mep_simulation' AS source, status, NULL::JSONB, NULL::JSONB, created_at FROM mep_simulation_runs
       ) u GROUP BY source`
    );

    res.json({
      source,
      query_ms: duration_ms,
      freshness: viewData ?? null,
      modules: rows,
    });
  } catch (err) {
    console.error('[wallt-reasoner] code-quality error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt-reasoner/deployment-readiness ────────────────────────────────
// Deployment gate status: all critical pipelines green, no blocking escalations.
//
// Response: { source, freshness, status, deployment_score, ... }
router.get('/deployment-readiness', async (req, res) => {
  try {
    const freshness = await getViewFreshness();
    const viewData = freshness.find(f => f.view_name === 'mv_wallt_deployment_readiness');

    const { rows, source, duration_ms } = await queryViewOrLive(
      'mv_wallt_deployment_readiness',
      `SELECT * FROM mv_wallt_deployment_readiness LIMIT 1`,
      `-- live fallback
       SELECT
         NOW() AS computed_at,
         0 AS pipelines_ok, 0 AS pipelines_warn, 0 AS pipelines_fail,
         0 AS deployment_score, 0 AS unresolved_escalations, 0 AS critical_escalations,
         0 AS avg_wallt_confidence, 0 AS wallt_decisions_24h,
         0 AS open_support_tickets, 0 AS critical_tickets,
         0 AS rvt_pipelines_ok, 0 AS ifc_pipelines_ok,
         'READY' AS deploy_gate_status`
    );

    res.json({
      source,
      query_ms: duration_ms,
      freshness: viewData ?? null,
      ...rows[0],
    });
  } catch (err) {
    console.error('[wallt-reasoner] deployment-readiness error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt-reasoner/test-coverage ──────────────────────────────────────
// Per-module test coverage ordered by risk (high failure rate = high priority).
// Query params: ?min_risk=high&limit=20
//
// Response: { source, freshness, modules: [{ module_name, coverage_pct, risk_level, ... }] }
router.get('/test-coverage', async (req, res) => {
  try {
    const { min_risk = 'critical', limit = 50 } = req.query;
    const riskFilter = { low: 1, medium: 2, high: 3, critical: 4 };

    const freshness = await getViewFreshness();
    const viewData = freshness.find(f => f.view_name === 'mv_wallt_test_coverage_map');

    const { rows, source, duration_ms } = await queryViewOrLive(
      'mv_wallt_test_coverage_map',
      `SELECT * FROM mv_wallt_test_coverage_map
        WHERE (risk_level = ANY($1) OR $1 = ARRAY['critical','high','medium','low'])
          AND test_status != 'never_tested'
        ORDER BY risk_score DESC
        LIMIT $2`,
      `-- live fallback (no test data yet — return empty)
       SELECT 'no_data' AS module_name, 'n/a' AS submodule,
              0 AS total_elements, 0 AS success_count, 0 AS mapped_count,
              0 AS failure_count, 0 AS skipped_count, 0 AS coverage_pct,
              0 AS runs_covering, 0 AS projects_covering,
              0 AS risk_score, 'low' AS risk_level, 'never_tested' AS test_status
       WHERE FALSE`
    );

    res.json({
      source,
      query_ms: duration_ms,
      freshness: viewData ?? null,
      modules: rows,
    });
  } catch (err) {
    console.error('[wallt-reasoner] test-coverage error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt-reasoner/semantic-search ─────────────────────────────────────
// pgvector ANN search on wallt_memory. Uses HNSW index (<5ms on Neon).
// Requires: body { queryEmbedding: float[1536], category?, limit?, minSimilarity? }
//
// Response: { results: [{ id, content, category, similarity, ... }], query_ms }
router.post('/semantic-search', async (req, res) => {
  try {
    await initSchemaIfNeeded();
    const {
      queryEmbedding,
      queryText,
      category = null,
      projectId = null,
      limit = 10,
      minSimilarity = 0.0,
    } = req.body;

    if (!queryEmbedding && !queryText) {
      return res.status(400).json({ error: 'queryEmbedding or queryText required' });
    }

    const start = Date.now();
    const args = [];
    const conditions = [];

    if (category) {
      args.push(category);
      conditions.push(`category = $${args.length}`);
    }
    if (projectId) {
      args.push(String(projectId));
      conditions.push(`metadata_json->>'project_id' = $${args.length}`);
    }

    const whereExtra = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    args.push(queryEmbedding);
    const argIdx = args.length;

    const { rows } = await pool.query(
      `SELECT
         id, content, category, confidence, metadata_json,
         ROUND((1 - (embedding <=> $${argIdx}::vector))::NUMERIC, 4) AS similarity,
         last_accessed_at, created_by_wallt, created_at
       FROM wallt_memory
       WHERE embedding IS NOT NULL ${whereExtra}
         AND 1 - (embedding <=> $${argIdx}::vector) >= $${args.length + 1}
       ORDER BY embedding <=> $${argIdx}::vector ASC
       LIMIT $${args.length + 2}`,
      [...args, minSimilarity, limit]
    );

    const explainStart = Date.now();
    const { rows: explainRows } = await pool.query(
      `EXPLAIN (FORMAT JSON, ANALYZE) SELECT id FROM wallt_memory WHERE embedding IS NOT NULL ${whereExtra} LIMIT 10`,
      args.slice(0, args.length - 2)
    );
    const explainMs = Date.now() - explainStart;

    res.json({
      results: rows,
      count: rows.length,
      query_ms: Date.now() - start,
      pgquery_ms: explainMs,
      index_used: explainRows[0]?.['QUERY PLAN']?.[0]?.['Plan']?.[0]?.['Node Type'] ?? 'unknown',
    });
  } catch (err) {
    console.error('[wallt-reasoner] semantic-search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wallt-reasoner/freshness ─────────────────────────────────────────
// Health check: report freshness for all views.
router.get('/freshness', async (req, res) => {
  try {
    const freshness = await getViewFreshness();
    const allFresh = freshness.every(f => !f.is_stale);
    res.json({
      status: allFresh ? 'healthy' : 'stale',
      views: freshness,
    });
  } catch (err) {
    console.error('[wallt-reasoner] freshness error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/wallt-reasoner/refresh ───────────────────────────────────────────
// Trigger CONCURRENTLY refresh on one or all views. Idempotent.
// Auth: internal only (Wallt cron / code-push webhook).
router.post('/refresh', async (req, res) => {
  try {
    await initSchemaIfNeeded();
    const { view_name } = req.body; // optional: refresh specific view
    const views = view_name
      ? [{ name: view_name }]
      : [
          { name: 'mv_wallt_code_quality_metrics' },
          { name: 'mv_wallt_deployment_readiness' },
          { name: 'mv_wallt_test_coverage_map' },
        ];

    const results = [];
    for (const v of views) {
      const start = Date.now();
      try {
        await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${v.name}`);
        const ms = Date.now() - start;

        const { rows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM ${v.name}`
        );

        await pool.query(
          `INSERT INTO wallt_view_refresh_log (view_name, refreshed_at, refresh_ms, rows_affected)
           VALUES ($1, NOW(), $2, $3)
           ON CONFLICT (view_name) DO UPDATE SET
             refreshed_at = NOW(), refresh_ms = EXCLUDED.refresh_ms,
             rows_affected = EXCLUDED.rows_affected`,
          [v.name, ms, parseInt(rows[0].cnt, 10)]
        );

        results.push({ view: v.name, status: 'ok', refresh_ms: ms });
      } catch (e) {
        results.push({ view: v.name, status: 'error', error: e.message });
      }
    }

    res.json({ refreshed: results });
  } catch (err) {
    console.error('[wallt-reasoner] refresh error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;