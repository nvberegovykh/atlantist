/**
 * Owns: DB queries for mep_simulation_runs table.
 * Does NOT own: HVAC/plumbing/electrical simulation logic — those live in services/mep/.
 */
const pool = require('./index');
const { toInt } = require('./index');

async function createMEPSimulation(data) {
  const {
    project_id, discipline, model_snapshot,
    hvac_results, plumbing_results, electrical_results,
    status = 'pending', disclaimer_accepted = false,
  } = data;
  const res = await pool.query(
    `INSERT INTO mep_simulation_runs
       (project_id, discipline, model_snapshot, hvac_results, plumbing_results,
        electrical_results, status, disclaimer_accepted, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING *`,
    [
      toInt(project_id),
      discipline || 'hvac',
      JSON.stringify(model_snapshot || {}),
      JSON.stringify(hvac_results || {}),
      JSON.stringify(plumbing_results || {}),
      JSON.stringify(electrical_results || {}),
      status,
      disclaimer_accepted,
    ]
  );
  return res.rows[0];
}

async function updateMEPSimulation(id, data) {
  const fields = [];
  const values = [];
  let i = 1;
  if (data.status !== undefined) { fields.push(`status = $${i++}`); values.push(data.status); }
  if (data.hvac_results !== undefined) { fields.push(`hvac_results = $${i++}`); values.push(JSON.stringify(data.hvac_results)); }
  if (data.plumbing_results !== undefined) { fields.push(`plumbing_results = $${i++}`); values.push(JSON.stringify(data.plumbing_results)); }
  if (data.electrical_results !== undefined) { fields.push(`electrical_results = $${i++}`); values.push(JSON.stringify(data.electrical_results)); }
  if (fields.length === 0) return getMEPSimulationById(id);
  values.push(id);
  const res = await pool.query(
    `UPDATE mep_simulation_runs SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function getMEPSimulationById(id) {
  const res = await pool.query(`SELECT * FROM mep_simulation_runs WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function getAllMEPSimulations(projectId) {
  const intId = toInt(projectId);
  const res = await pool.query(
    `SELECT * FROM mep_simulation_runs WHERE project_id = $1 OR project_id IS NULL ORDER BY created_at DESC`,
    [intId]
  );
  return res.rows;
}

async function getLatestMEPSimulation(discipline) {
  const res = await pool.query(
    `SELECT * FROM mep_simulation_runs WHERE discipline = $1 ORDER BY created_at DESC LIMIT 1`,
    [discipline]
  );
  return res.rows[0] || null;
}

async function getMEPHistory(limit = 20, projectId = null) {
  let query;
  if (projectId) {
    const intId = toInt(projectId);
    query = pool.query(
      `SELECT id, discipline, status, created_at, hvac_results, plumbing_results, electrical_results
       FROM mep_simulation_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [intId, limit]
    );
  } else {
    query = pool.query(
      `SELECT id, discipline, status, created_at, hvac_results, plumbing_results, electrical_results
       FROM mep_simulation_runs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
  }
  const res = await query;
  return res.rows;
}

async function getLatestMEPSimulationForProject(discipline, projectId) {
  const intId = toInt(projectId);
  const res = await pool.query(
    `SELECT * FROM mep_simulation_runs
     WHERE discipline = $1 AND (project_id = $2 OR project_id IS NULL)
     ORDER BY created_at DESC LIMIT 1`,
    [discipline, intId]
  );
  return res.rows[0] || null;
}

module.exports = {
  createMEPSimulation,
  updateMEPSimulation,
  getMEPSimulationById,
  getAllMEPSimulations,
  getLatestMEPSimulation,
  getLatestMEPSimulationForProject,
  getMEPHistory,
};