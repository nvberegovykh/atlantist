# Wallt Reasoner — Data Access Pattern

## Overview

The Reasoner agent performs **deterministic inference** against Atlantist's Data Context Graph (ontology + knowledge graph + semantic layer + metrics). It uses **no LLM calls, no KV cache, and no PagedAttention** — only SQL queries against Neon PostgreSQL.

The access path is optimized via:
- **pgvector HNSW indexes** on `wallt_memory.embedding` for sub-millisecond ANN lookups
- **Pre-materialized views** refreshed on data changes and triggered via `polsia.toml` crons

---

## Data Access Pattern

```
Request
  │
  ├── isViewFresh(view_name)? ──YES──> Query materialized view
  │                                        │
  │                                  Return rows + source='view'
  │
  └── NO (stale > 10 min)
       │
       └── Fall back to live SQL query
                │
            Return rows + source='live_fallback'
```

**Stale threshold:** 10 minutes. If a view's `refreshed_at` in `wallt_view_refresh_log` is older than 10 min, the Reasoner falls back to a live query against the source tables.

---

## Materialized Views

### `mv_wallt_code_quality_metrics`

| Column | Type | Description |
|--------|------|-------------|
| `module_name` | text | Pipeline source: structural_audit, energy_simulation, rvt_import, ifc_import, mep_simulation |
| `total_runs` | int | Total runs across all time |
| `successful_runs` | int | Runs with status = 'completed' |
| `failed_runs` | int | Runs with status = 'failed' |
| `success_rate_pct` | float | successful_runs / total_runs * 100 |
| `avg_red_issues` | float | Avg RED verdict count from structural audits |
| `avg_en001_compliance_pct` | float | Avg EN-001 energy compliance pass rate |
| `avg_import_success_pct` | float | Avg element import success ratio (rvt/ifc) |
| `first_run_at` | timestamptz | Earliest run timestamp |
| `last_run_at` | timestamptz | Most recent run timestamp |
| `computed_at` | timestamptz | When the view was last refreshed |

**Refresh triggers:**
- `structural_audit_runs` INSERT/UPDATE (structural audit completes)
- `energy_simulations` INSERT (energy sim completes)
- `rvt_import_runs` INSERT/UPDATE (RVT import completes)
- `ifc_import_runs` INSERT/UPDATE (IFC import completes)
- `mep_simulation_runs` INSERT/UPDATE (MEP sim completes)

---

### `mv_wallt_deployment_readiness`

| Column | Type | Description |
|--------|------|-------------|
| `computed_at` | timestamptz | Refresh timestamp |
| `pipelines_ok` | int | Pipelines with zero failures |
| `pipelines_warn` | int | Pipelines with 1-3 failures |
| `pipelines_fail` | int | Pipelines with >3 failures |
| `deployment_score` | int | % of pipelines that are ok |
| `unresolved_escalations` | int | Escalations not yet resolved |
| `critical_escalations` | int | Escalations marked critical/P0 |
| `avg_wallt_confidence` | float | Avg decision confidence score (0-1), last 24h |
| `wallt_decisions_24h` | int | Decision log entries in last 24h |
| `open_support_tickets` | int | Open tickets in last 30 days |
| `critical_tickets` | int | Critical-priority tickets |
| `rvt_pipelines_ok` | bool | RVT import pipeline has no failures |
| `ifc_pipelines_ok` | bool | IFC import pipeline has no failures |
| `deploy_gate_status` | text | READY / DEGRADED / BLOCKED |

**Gate logic:**
- `BLOCKED`: unresolved critical escalations > 0
- `DEGRADED`: unresolved escalations > 5 OR pipelines_fail > 0
- `READY`: all clear

**Refresh triggers:**
- Code push event (via `POST /api/wallt-reasoner/refresh`)
- `wallt-view-refresh` cron job (polsia.toml)
- Manual: `POST /api/wallt-reasoner/refresh`

---

### `mv_wallt_test_coverage_map`

| Column | Type | Description |
|--------|------|-------------|
| `module_name` | text | Revit category (e.g., "Walls", "Doors") |
| `submodule` | text | Subcategory (e.g., "Structural", "Architectural") |
| `total_elements` | int | Total elements imported across all runs |
| `success_count` | int | Elements with import_status = 'success' |
| `mapped_count` | int | Elements with import_status = 'mapped' |
| `failure_count` | int | Elements with import_status IN ('failed', 'partial') |
| `skipped_count` | int | Elements with import_status = 'skipped' |
| `coverage_pct` | float | (success + mapped) / total * 100 |
| `runs_covering` | int | Distinct RVT import runs covering this category |
| `projects_covering` | int | Distinct projects using this category |
| `risk_score` | float | Composite: (100 - coverage_pct) * 0.6 + failure_ratio * 0.4 |
| `risk_level` | text | low (≥95%) / medium (≥80%) / high (≥60%) / critical (<60%) |
| `test_status` | text | active / stale / never_tested |

**Ordered by:** risk_score DESC, total_elements DESC, module_name ASC

**Note:** Currently derived from `rvt_import_results` element-level granular data.
When a formal test suite is added, replace with `test_run_results` table.

---

## pgvector Index (HNSW)

**Index:** `idx_wallt_memory_embedding_hnsw` on `wallt_memory(embedding)`
- **Type:** HNSW (hierarchical navigable small world)
- **m:** 16 (neighbors per layer — good default for 1536-dim embeddings)
- **ef_construction:** 64 (build quality vs. speed trade-off)
- **Operator class:** `vector_cosine_ops` (cosine distance)
- **Dimension:** 1536 (OpenAI text-embedding-3-small)
- **Target query time:** <5ms (verified with `EXPLAIN (ANALYZE)`)

**Why HNSW over ivfflat:**
- ivfflat is good for <1M rows with moderate recall requirements
- HNSW has superior query-time performance at the same recall level
- Build is slower (one-time cost), queries are much faster
- Neon PostgreSQL handles HNSW index building well

**Verify:** `EXPLAIN (ANALYZE, BUFFERS) SELECT ... FROM wallt_memory WHERE embedding <=> $1 < 0.2`

**Also indexed:** `idx_wallt_zoning_embedding_hnsw` on `wallt_zoning_chunks(embedding)` for the W3 sector-lookup path.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/wallt-reasoner/code-quality` | Module-level quality metrics |
| GET | `/api/wallt-reasoner/deployment-readiness` | Deployment gate status |
| GET | `/api/wallt-reasoner/test-coverage` | Per-module test coverage map |
| POST | `/api/wallt-reasoner/semantic-search` | pgvector ANN search on wallt_memory |
| GET | `/api/wallt-reasoner/freshness` | View freshness health check |
| POST | `/api/wallt-reasoner/refresh` | Trigger view refresh (internal) |

---

## Refresh Strategy

### view_refresh_log table

```
wallt_view_refresh_log
  view_name     VARCHAR(64) PRIMARY KEY
  refreshed_at  TIMESTAMPTZ
  refresh_ms    INTEGER
  rows_affected INTEGER
```

### Trigger points

| Event | Views to refresh |
|-------|-----------------|
| Structural audit completes | mv_wallt_code_quality_metrics |
| Energy simulation completes | mv_wallt_code_quality_metrics |
| RVT import completes | mv_wallt_code_quality_metrics, mv_wallt_test_coverage_map |
| IFC import completes | mv_wallt_code_quality_metrics, mv_wallt_test_coverage_map |
| Code push (CI webhook) | mv_wallt_deployment_readiness |
| `wallt-view-refresh` cron (every 5 min) | mv_wallt_deployment_readiness |
| Test run completes | mv_wallt_test_coverage_map |

### polsia.toml cron entry (for deployment_readiness polling)

```toml
[[crons]]
name = "wallt-view-refresh"
schedule = "*/5 * * * *"
command = "node jobs/wallt-view-refresh.js"
```

---

## Fallback Behavior

If all 3 views are stale simultaneously (>10 min old), the Reasoner uses live SQL queries:

- `code-quality` → live UNION ALL across 5 source tables
- `deployment-readiness` → live scalar aggregation (may be slow under load)
- `test-coverage` → empty result set (no formal test data yet)

The `freshness` endpoint reports `status: stale` in this scenario. The Reasoner client code should surface this as a warning — it's not an error, just degraded performance.

---

## Adding New Signals

To add a new quality signal to `mv_wallt_code_quality_metrics`:

1. Add the source table's status + quality columns to the UNION ALL in the view definition
2. Ensure the INSERT trigger calls `POST /api/wallt-reasoner/refresh` with `view_name: 'mv_wallt_code_quality_metrics'`
3. Update this document with the new column