/**
 * Owns: DB queries for energy_dob_packages table — DOB submission zip records.
 * Does NOT own: PDF generation logic (services/energy-dob-package.js), simulation queries (db/energy.js).
 */
const pool = require('./index');

async function createDobPackage(data) {
  const { simulation_id, zip_name, zip_size_bytes, project_name, address, bin, borough, status = 'complete' } = data;
  const res = await pool.query(
    `INSERT INTO energy_dob_packages
       (simulation_id, zip_name, zip_size_bytes, project_name, address, bin, borough, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *`,
    [simulation_id || null, zip_name, zip_size_bytes || 0, project_name || '', address || '', bin || '', borough || '', status]
  );
  return res.rows[0];
}

async function getDobPackagesBySimulation(simulation_id) {
  const res = await pool.query(
    'SELECT * FROM energy_dob_packages WHERE simulation_id = $1 ORDER BY created_at DESC',
    [simulation_id]
  );
  return res.rows;
}

async function getLatestDobPackage() {
  const res = await pool.query(
    'SELECT * FROM energy_dob_packages ORDER BY created_at DESC LIMIT 1'
  );
  return res.rows[0] || null;
}

module.exports = { createDobPackage, getDobPackagesBySimulation, getLatestDobPackage };
