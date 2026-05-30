/**
 * Owns: wallt_deploy_sandbox_runs + wallt_deploy_reviews persistence.
 * Does NOT own: sandbox execution logic, validation rules, AI review.
 */
const pool = require('./index');

const toInt = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return v;
  if (typeof v !== 'string') return null;
  const n = parseInt(v, 10);
  return String(n) === v && !isNaN(n) ? n : null;
};

// ── wallt_deploy_sandbox_runs ────────────────────────────────────────────────

async function logSandboxRun(changesetHash, iteration, result, issuesJson, fixSuggestions) {
  const r = await pool.query(
    `INSERT INTO wallt_deploy_sandbox_runs (changeset_hash, iteration, result, issues_json, fix_suggestions)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [changesetHash, iteration, result, JSON.stringify(issuesJson || null), JSON.stringify(fixSuggestions || null)]
  );
  return r.rows[0];
}

async function getRunsByHash(changesetHash) {
  const r = await pool.query(
    `SELECT * FROM wallt_deploy_sandbox_runs
     WHERE changeset_hash = $1
     ORDER BY iteration ASC`,
    [changesetHash]
  );
  return r.rows;
}

async function getLatestRun(changesetHash) {
  const r = await pool.query(
    `SELECT * FROM wallt_deploy_sandbox_runs
     WHERE changeset_hash = $1
     ORDER BY iteration DESC LIMIT 1`,
    [changesetHash]
  );
  return r.rows[0] || null;
}

// ── wallt_deploy_reviews ─────────────────────────────────────────────────────

async function upsertReview(changesetHash, fields) {
  const sets = [];
  const vals = [changesetHash];
  let idx = 2;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${idx++}`);
    vals.push(v);
  }
  sets.push('updated_at = NOW()');
  const r = await pool.query(
    `INSERT INTO wallt_deploy_reviews (changeset_hash, ${Object.keys(fields).join(',')}, updated_at)
     VALUES ($1, ${Object.keys(fields).map((_, i) => `$${i + 2}`).join(',')}, NOW())
     ON CONFLICT (changeset_hash) DO UPDATE SET ${sets.join(',')}, updated_at = NOW()
     RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function getReviewByHash(changesetHash) {
  const r = await pool.query(
    `SELECT * FROM wallt_deploy_reviews WHERE changeset_hash = $1`,
    [changesetHash]
  );
  return r.rows[0] || null;
}

async function getReviewById(id) {
  const nid = toInt(id);
  if (nid === null) return null;
  const r = await pool.query(`SELECT * FROM wallt_deploy_reviews WHERE id = $1`, [nid]);
  return r.rows[0] || null;
}

module.exports = {
  logSandboxRun, getRunsByHash, getLatestRun,
  upsertReview, getReviewByHash, getReviewById,
};