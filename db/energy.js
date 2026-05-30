/**
 * Owns: DB queries for energy_simulations table (simulation results, compliance snapshots).
 * Does NOT own: gbXML generation, IDF generation, simulation logic — those live in services/energy-sim.js.
 */
const pool = require('./index');

async function createSimulation(data) {
  const { model_snapshot, gbxml, idf_text, results, compliance, status = 'pending' } = data;
  const res = await pool.query(
    `INSERT INTO energy_simulations (model_snapshot, gbxml, idf_text, results, compliance, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
    [
      JSON.stringify(model_snapshot || {}),
      gbxml || '',
      idf_text || '',
      JSON.stringify(results || {}),
      JSON.stringify(compliance || {}),
      status,
    ]
  );
  return res.rows[0] || null;
}

async function updateSimulation(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  if (data.status !== undefined) { fields.push(`status = $${idx++}`); values.push(data.status); }
  if (data.results !== undefined) { fields.push(`results = $${idx++}`); values.push(JSON.stringify(data.results)); }
  if (data.compliance !== undefined) { fields.push(`compliance = $${idx++}`); values.push(JSON.stringify(data.compliance)); }
  if (data.gbxml !== undefined) { fields.push(`gbxml = $${idx++}`); values.push(data.gbxml); }
  if (data.idf_text !== undefined) { fields.push(`idf_text = $${idx++}`); values.push(data.idf_text); }
  if (data.en1_workbook_data !== undefined) { fields.push(`en1_workbook_data = $${idx++}`); values.push(JSON.stringify(data.en1_workbook_data)); }
  if (fields.length === 0) return getSimulationById(id);
  values.push(id);
  const res = await pool.query(
    `UPDATE energy_simulations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// Upsert EN-1 workbook data: update most recent sim or create standalone record
async function saveEN1WorkbookData(en1Data) {
  // Try to attach to latest simulation; if none exists, create a bare record
  const latest = await getLatestSimulation();
  if (latest) {
    const res = await pool.query(
      `UPDATE energy_simulations SET en1_workbook_data = $1 WHERE id = $2 RETURNING *`,
      [JSON.stringify(en1Data), latest.id]
    );
    return res.rows[0] || null;
  }
  // No simulation run yet — create a stub record to hold the workbook data
  const res = await pool.query(
    `INSERT INTO energy_simulations (model_snapshot, en1_workbook_data, status, created_at)
     VALUES ('{}', $1, 'pending', NOW()) RETURNING *`,
    [JSON.stringify(en1Data)]
  );
  return res.rows[0] || null;
}

async function getEN1WorkbookData() {
  const sim = await getLatestSimulation();
  if (!sim) return null;
  const raw = sim.en1_workbook_data;
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function getSimulationById(id) {
  const res = await pool.query('SELECT * FROM energy_simulations WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getAllSimulations() {
  const res = await pool.query('SELECT * FROM energy_simulations ORDER BY created_at DESC LIMIT 20');
  return res.rows;
}

async function getLatestSimulation() {
  const res = await pool.query('SELECT * FROM energy_simulations ORDER BY created_at DESC LIMIT 1');
  return res.rows[0] || null;
}

module.exports = { createSimulation, updateSimulation, getSimulationById, getAllSimulations, getLatestSimulation, saveEN1WorkbookData, getEN1WorkbookData };
