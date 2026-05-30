/**
 * Owns: structural_members, structural_load_cases, structural_loads,
 *       structural_analysis_runs, structural_sections table access.
 * Does NOT own: calculation logic (services/structural-engine.js), HTTP routing.
 */
const db = require('./index');

const members = {
  create: async (data) => {
    const { project_id, element_id, name, member_type, material_type, section_name, start_node, end_node, length_m, releases, properties, created_by } = data;
    const r = await db.query(`
      INSERT INTO structural_members (project_id, element_id, name, member_type, material_type, section_name, start_node, end_node, length_m, releases, properties, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [project_id, element_id || null, name, member_type, material_type, section_name || null, JSON.stringify(start_node), JSON.stringify(end_node), length_m || null, JSON.stringify(releases || {}), JSON.stringify(properties || {}), created_by || null]);
    return r.rows[0] || null;
  },

  getById: async (id) => {
    const r = await db.query('SELECT * FROM structural_members WHERE id = $1', [id]);
    return r.rows[0] || null;
  },

  listByProject: async (projectId) => {
    const r = await db.query('SELECT * FROM structural_members WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return r.rows;
  },

  update: async (id, data) => {
    const fields = [];
    const vals = [id];
    let p = 2;
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const val = typeof v === 'object' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${p++}`);
      vals.push(val);
    }
    if (!fields.length) return null;
    fields.push('updated_at = NOW()');
    const r = await db.query(`UPDATE structural_members SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, vals);
    return r.rows[0] || null;
  },

  delete: async (id) => {
    await db.query('DELETE FROM structural_members WHERE id = $1', [id]);
  },
};

const loadCases = {
  create: async ({ project_id, name, load_type, parameters }) => {
    const r = await db.query(`
      INSERT INTO structural_load_cases (project_id, name, load_type, parameters)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [project_id, name, load_type, JSON.stringify(parameters || {})]);
    return r.rows[0] || null;
  },

  listByProject: async (projectId) => {
    const r = await db.query('SELECT * FROM structural_load_cases WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return r.rows;
  },

  delete: async (id) => {
    await db.query('DELETE FROM structural_load_cases WHERE id = $1', [id]);
  },
};

const loads = {
  create: async ({ load_case_id, member_id, load_pattern, magnitude, direction, position, parameters }) => {
    const r = await db.query(`
      INSERT INTO structural_loads (load_case_id, member_id, load_pattern, magnitude, direction, position, parameters)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [load_case_id, member_id || null, load_pattern, magnitude, direction || 'y', position || 0.5, JSON.stringify(parameters || {})]);
    return r.rows[0] || null;
  },

  listByCase: async (caseId) => {
    const r = await db.query('SELECT * FROM structural_loads WHERE load_case_id = $1 ORDER BY created_at', [caseId]);
    return r.rows;
  },

  delete: async (id) => {
    await db.query('DELETE FROM structural_loads WHERE id = $1', [id]);
  },
};

const runs = {
  create: async (data) => {
    const { project_id, name, analysis_type, parameters, load_combos, disclaimer_accepted, created_by } = data;
    const r = await db.query(`
      INSERT INTO structural_analysis_runs (project_id, name, analysis_type, parameters, load_combos, disclaimer_accepted, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [project_id, name || 'Structural Analysis', analysis_type, JSON.stringify(parameters || {}), JSON.stringify(load_combos || []), disclaimer_accepted || false, created_by || null]);
    return r.rows[0] || null;
  },

  updateResults: async (id, results) => {
    const fields = ['status = $2', 'updated_at = NOW()'];
    const vals = [id, 'completed'];
    let p = 3;
    for (const key of ['member_results', 'modal_results', 'seismic_results', 'code_checks', 'opensees_input', 'opensees_output', 'viz_data']) {
      if (results[key] !== undefined) {
        fields.push(`${key} = $${p++}`);
        vals.push(typeof results[key] === 'string' ? results[key] : JSON.stringify(results[key]));
      }
    }
    const r = await db.query(`UPDATE structural_analysis_runs SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, vals);
    return r.rows[0] || null;
  },

  markFailed: async (id, error) => {
    const r = await db.query(`UPDATE structural_analysis_runs SET status = 'failed', parameters = parameters || $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, JSON.stringify({ error })]);
    return r.rows[0] || null;
  },

  getById: async (id) => {
    const r = await db.query('SELECT * FROM structural_analysis_runs WHERE id = $1', [id]);
    return r.rows[0] || null;
  },

  listByProject: async (projectId, type) => {
    let q = 'SELECT * FROM structural_analysis_runs WHERE project_id = $1';
    const vals = [projectId];
    if (type) { q += ' AND analysis_type = $2'; vals.push(type); }
    q += ' ORDER BY created_at DESC';
    const r = await db.query(q, vals);
    return r.rows;
  },

  delete: async (id) => {
    await db.query('DELETE FROM structural_analysis_runs WHERE id = $1', [id]);
  },
};

const sections = {
  list: async (category) => {
    let q = 'SELECT * FROM structural_sections';
    const vals = [];
    if (category) { q += ' WHERE category = $1'; vals.push(category); }
    q += ' ORDER BY name';
    const r = await db.query(q, vals);
    return r.rows;
  },

  getByName: async (category, name) => {
    const r = await db.query('SELECT * FROM structural_sections WHERE category = $1 AND name = $2', [category, name]);
    return r.rows[0] || null;
  },

  upsert: async ({ category, name, properties }) => {
    const r = await db.query(`
      INSERT INTO structural_sections (category, name, properties)
      VALUES ($1, $2, $3)
      ON CONFLICT (category, name) DO UPDATE SET properties = $3
      RETURNING *
    `, [category, name, JSON.stringify(properties)]);
    return r.rows[0] || null;
  },
};

module.exports = { members, loadCases, loads, runs, sections };
