/**
 * Owns: soil_profiles and geotechnical_runs table access.
 * Does NOT own: geotechnical calculation logic (services/geotechnical.js), HTTP routing.
 */
const db = require('./index');

const soilProfile = {
  create: async ({ project_id, name, soil_layers, groundwater_depth, surface_elevation, spt_blowcounts, cpt_data, lab_tests, notes, created_by }) => {
    const result = await db.query(`
      INSERT INTO soil_profiles (project_id, name, soil_layers, groundwater_depth, surface_elevation, spt_blowcounts, cpt_data, lab_tests, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [project_id, name, JSON.stringify(soil_layers), groundwater_depth, surface_elevation, JSON.stringify(spt_blowcounts), JSON.stringify(cpt_data), JSON.stringify(lab_tests), notes, created_by]);
    return result.rows[0] || null;
  },

  getById: async (id) => {
    const result = await db.query('SELECT * FROM soil_profiles WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  listByProject: async (projectId) => {
    const result = await db.query('SELECT * FROM soil_profiles WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    return result.rows;
  },

  update: async (id, { name, soil_layers, groundwater_depth, surface_elevation, spt_blowcounts, cpt_data, lab_tests, notes }) => {
    const result = await db.query(`
      UPDATE soil_profiles
      SET name = COALESCE($2, name),
          soil_layers = COALESCE($3, soil_layers),
          groundwater_depth = COALESCE($4, groundwater_depth),
          surface_elevation = COALESCE($5, surface_elevation),
          spt_blowcounts = COALESCE($6, spt_blowcounts),
          cpt_data = COALESCE($7, cpt_data),
          lab_tests = COALESCE($8, lab_tests),
          notes = COALESCE($9, notes),
          updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [id, name, soil_layers ? JSON.stringify(soil_layers) : null, groundwater_depth, surface_elevation, spt_blowcounts ? JSON.stringify(spt_blowcounts) : null, cpt_data ? JSON.stringify(cpt_data) : null, lab_tests ? JSON.stringify(lab_tests) : null, notes]);
    return result.rows[0] || null;
  },

  delete: async (id) => {
    await db.query('DELETE FROM soil_profiles WHERE id = $1', [id]);
  },
};

const geotechnicalRun = {
  create: async ({ project_id, soil_profile_id, name, run_type, parameters, created_by }) => {
    const result = await db.query(`
      INSERT INTO geotechnical_runs (project_id, soil_profile_id, name, run_type, parameters, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [project_id, soil_profile_id, name, run_type, JSON.stringify(parameters), created_by]);
    return result.rows[0] || null;
  },

  updateResults: async (id, results, vizData, openseesInput) => {
    const fields = ['status = $2'];
    const vals = [id, 'completed'];
    let p = 3;

    if (results.bearing_results) { fields.push(`bearing_results = $${p++}`); vals.push(JSON.stringify(results.bearing_results)); }
    if (results.settlement_results) { fields.push(`settlement_results = $${p++}`); vals.push(JSON.stringify(results.settlement_results)); }
    if (results.earth_pressure_results) { fields.push(`earth_pressure_results = $${p++}`); vals.push(JSON.stringify(results.earth_pressure_results)); }
    if (results.pile_results) { fields.push(`pile_results = $${p++}`); vals.push(JSON.stringify(results.pile_results)); }
    if (results.slope_results) { fields.push(`slope_results = $${p++}`); vals.push(JSON.stringify(results.slope_results)); }
    if (openseesInput) { fields.push(`opensees_input = $${p++}`); vals.push(openseesInput); }
    if (vizData) { fields.push(`viz_data = $${p++}`); vals.push(JSON.stringify(vizData)); }

    const result = await db.query(
      `UPDATE geotechnical_runs SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
      vals
    );
    return result.rows[0] || null;
  },

  markFailed: async (id) => {
    const result = await db.query(
      "UPDATE geotechnical_runs SET status = 'failed' WHERE id = $1 RETURNING *",
      [id]
    );
    return result.rows[0] || null;
  },

  getById: async (id) => {
    const result = await db.query('SELECT * FROM geotechnical_runs WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  listByProject: async (projectId, runType) => {
    const query = runType
      ? 'SELECT * FROM geotechnical_runs WHERE project_id = $1 AND run_type = $2 ORDER BY created_at DESC'
      : 'SELECT * FROM geotechnical_runs WHERE project_id = $1 ORDER BY created_at DESC';
    const params = runType ? [projectId, runType] : [projectId];
    const result = await db.query(query, params);
    return result.rows;
  },

  listRecent: async (limit = 10) => {
    const result = await db.query(
      'SELECT * FROM geotechnical_runs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  },

  delete: async (id) => {
    await db.query('DELETE FROM geotechnical_runs WHERE id = $1', [id]);
  },
};

module.exports = { soilProfile, geotechnicalRun };