/**
 * Owns: all DB queries for mep_elements (ducts, pipes, cable_trays, RCP fixtures).
 * Does NOT own: MEP simulation logic (services/mep/), Three.js rendering, routing.
 */
const pool = require('./index');

async function getAllMEPElements(projectId) {
  const res = await pool.query(
    `SELECT * FROM mep_elements WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId]
  );
  return res.rows;
}

async function getMEPElementById(id) {
  const res = await pool.query(`SELECT * FROM mep_elements WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createMEPElement(data) {
  const {
    project_id = 1, type, subtype, name,
    start_x = 0, start_y = 0, end_x = 0, end_y = 0,
    elevation = 0, width, height, diameter, material,
    flow_rate, system_type, fittings = [], hangers = [],
    parameters = {},
  } = data;
  const res = await pool.query(
    `INSERT INTO mep_elements
       (project_id, type, subtype, name, start_x, start_y, end_x, end_y,
        elevation, width, height, diameter, material, flow_rate, system_type,
        fittings, hangers, parameters, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
     RETURNING *`,
    [
      project_id, type, subtype || null, name || null,
      start_x, start_y, end_x, end_y,
      elevation, width || null, height || null, diameter || null,
      material || null, flow_rate || null, system_type || null,
      JSON.stringify(fittings), JSON.stringify(hangers), JSON.stringify(parameters),
    ]
  );
  return res.rows[0];
}

async function updateMEPElement(id, data) {
  const fields = [];
  const values = [];
  let i = 1;
  const map = {
    subtype: v => { fields.push(`subtype = $${i++}`); values.push(v); },
    name: v => { fields.push(`name = $${i++}`); values.push(v); },
    start_x: v => { fields.push(`start_x = $${i++}`); values.push(v); },
    start_y: v => { fields.push(`start_y = $${i++}`); values.push(v); },
    end_x: v => { fields.push(`end_x = $${i++}`); values.push(v); },
    end_y: v => { fields.push(`end_y = $${i++}`); values.push(v); },
    elevation: v => { fields.push(`elevation = $${i++}`); values.push(v); },
    width: v => { fields.push(`width = $${i++}`); values.push(v); },
    height: v => { fields.push(`height = $${i++}`); values.push(v); },
    diameter: v => { fields.push(`diameter = $${i++}`); values.push(v); },
    material: v => { fields.push(`material = $${i++}`); values.push(v); },
    flow_rate: v => { fields.push(`flow_rate = $${i++}`); values.push(v); },
    system_type: v => { fields.push(`system_type = $${i++}`); values.push(v); },
    fittings: v => { fields.push(`fittings = $${i++}`); values.push(JSON.stringify(v)); },
    hangers: v => { fields.push(`hangers = $${i++}`); values.push(JSON.stringify(v)); },
    parameters: v => { fields.push(`parameters = $${i++}`); values.push(JSON.stringify(v)); },
  };
  for (const [k, fn] of Object.entries(map)) {
    if (data[k] !== undefined) fn(data[k]);
  }
  if (fields.length === 0) return getMEPElementById(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const res = await pool.query(
    `UPDATE mep_elements SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteMEPElement(id) {
  await pool.query('DELETE FROM mep_elements WHERE id = $1', [id]);
}

async function getMEPElementsByType(type, projectId = 1) {
  const res = await pool.query(
    `SELECT * FROM mep_elements WHERE type = $1 AND project_id = $2 ORDER BY created_at ASC`,
    [type, projectId]
  );
  return res.rows;
}

module.exports = {
  getAllMEPElements, getMEPElementById, createMEPElement,
  updateMEPElement, deleteMEPElement, getMEPElementsByType,
};