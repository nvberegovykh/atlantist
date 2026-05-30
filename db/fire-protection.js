/**
 * Owns: DB queries for fire_protection_runs table — NFPA 13/101/92 simulation records.
 * Does NOT own: NFPA calculation logic (services/fire-protection.js), route handling.
 */
const pool = require('./index');

async function createFireRun(data) {
  const {
    model_snapshot = {},
    occupancy_type = 'office',
    sprinkler_results = {},
    egress_results = {},
    smoke_results = {},
    resistance_results = {},
    fdny_results = {},
    status = 'pending',
  } = data;
  const res = await pool.query(
    `INSERT INTO fire_protection_runs
       (model_snapshot, occupancy_type, sprinkler_results, egress_results,
        smoke_results, resistance_results, fdny_results, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
    [
      JSON.stringify(model_snapshot),
      occupancy_type,
      JSON.stringify(sprinkler_results),
      JSON.stringify(egress_results),
      JSON.stringify(smoke_results),
      JSON.stringify(resistance_results),
      JSON.stringify(fdny_results),
      status,
    ]
  );
  return res.rows[0];
}

async function updateFireRun(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  const jsonFields = ['sprinkler_results', 'egress_results', 'smoke_results', 'resistance_results', 'fdny_results', 'model_snapshot'];
  for (const key of jsonFields) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(JSON.stringify(data[key]));
    }
  }
  if (data.status !== undefined) { fields.push(`status = $${idx++}`); values.push(data.status); }
  if (fields.length === 0) return getFireRunById(id);
  values.push(id);
  const res = await pool.query(
    `UPDATE fire_protection_runs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function getFireRunById(id) {
  const res = await pool.query('SELECT * FROM fire_protection_runs WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getAllFireRuns() {
  const res = await pool.query('SELECT * FROM fire_protection_runs ORDER BY created_at DESC LIMIT 20');
  return res.rows;
}

async function getLatestFireRun() {
  const res = await pool.query("SELECT * FROM fire_protection_runs WHERE status='complete' ORDER BY created_at DESC LIMIT 1");
  return res.rows[0] || null;
}

module.exports = { createFireRun, updateFireRun, getFireRunById, getAllFireRuns, getLatestFireRun };
