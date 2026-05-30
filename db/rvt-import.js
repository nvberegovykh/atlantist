/**
 * Owns: all DB queries for rvt_import_runs and rvt_import_results.
 * Does NOT own: Model Derivative API calls, file upload, element mapping logic.
 */
const pool = require('./index');

// ─── Runs ───────────────────────────────────────────────────────────────────

async function createRun(data) {
  const {
    project_id, file_name, file_size_bytes, revit_version,
    upload_url, derivative_job_id, status = 'pending'
  } = data;
  const res = await pool.query(
    `INSERT INTO rvt_import_runs
      (project_id, file_name, file_size_bytes, revit_version, upload_url, derivative_job_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [project_id, file_name, file_size_bytes || null, revit_version || null,
     upload_url || null, derivative_job_id || null, status]
  );
  return res.rows[0];
}

async function getRunById(id) {
  const res = await pool.query('SELECT * FROM rvt_import_runs WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getRunsByProject(projectId) {
  const res = await pool.query(
    `SELECT * FROM rvt_import_runs
     WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows;
}

async function updateRun(id, data) {
  const fields = [];
  const values = [];
  let idx = 1;
  const settable = [
    'status', 'progress_pct', 'derivative_job_id', 'revit_version',
    'elements_total', 'elements_succeeded', 'elements_failed',
    'wall_layers_created', 'family_instances_created', 'error_log'
  ];
  for (const key of settable) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(key === 'error_log' ? data[key] : data[key]);
    }
  }
  if (fields.length === 0) return getRunById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const res = await pool.query(
    `UPDATE rvt_import_runs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0];
}

async function touchRunStart(id) {
  await pool.query(
    `UPDATE rvt_import_runs SET started_at = NOW() WHERE id = $1 AND started_at IS NULL`,
    [id]
  );
}

async function touchRunComplete(id) {
  await pool.query(
    `UPDATE rvt_import_runs SET completed_at = NOW() WHERE id = $1`,
    [id]
  );
}

async function setRunError(id, message) {
  await pool.query(
    `UPDATE rvt_import_runs
     SET status = 'failed', error_log = $2, completed_at = NOW()
     WHERE id = $1`,
    [id, message]
  );
}

// ─── Results ─────────────────────────────────────────────────────────────────

async function createResult(data) {
  const {
    run_id, category, subcategory, element_name, revit_guid,
    atlantist_element_id, atlantist_element_type, import_status,
    error_message, revit_params, mapped_params
  } = data;
  const res = await pool.query(
    `INSERT INTO rvt_import_results
      (run_id, category, subcategory, element_name, revit_guid,
       atlantist_element_id, atlantist_element_type, import_status,
       error_message, revit_params, mapped_params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [run_id, category, subcategory || null, element_name || null, revit_guid || null,
     atlantist_element_id || null, atlantist_element_type || null, import_status,
     error_message || null, revit_params ? JSON.stringify(revit_params) : null,
     mapped_params ? JSON.stringify(mapped_params) : null]
  );
  return res.rows[0];
}

async function batchCreateResults(rows) {
  if (!rows.length) return;
  const cols = `(run_id, category, subcategory, element_name, revit_guid,
                 atlantist_element_id, atlantist_element_type, import_status,
                 error_message, revit_params, mapped_params)`;
  const vals = rows.map((r, i) => {
    const base = i * 11;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
             $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
  });
  const params = rows.flatMap(r => [
    r.run_id, r.category, r.subcategory || null, r.element_name || null, r.revit_guid || null,
    r.atlantist_element_id || null, r.atlantist_element_type || null, r.import_status,
    r.error_message || null,
    r.revit_params ? JSON.stringify(r.revit_params) : null,
    r.mapped_params ? JSON.stringify(r.mapped_params) : null
  ]);
  await pool.query(
    `INSERT INTO rvt_import_results ${cols} VALUES ${vals.join(', ')}`,
    params
  );
}

async function getResultsByRun(runId) {
  const res = await pool.query(
    `SELECT * FROM rvt_import_results WHERE run_id = $1 ORDER BY id ASC`,
    [runId]
  );
  return res.rows;
}

async function getResultsByCategory(runId, category) {
  const res = await pool.query(
    `SELECT * FROM rvt_import_results WHERE run_id = $1 AND category = $2 ORDER BY id ASC`,
    [runId, category]
  );
  return res.rows;
}

// Aggregate summary for a run
async function getRunSummary(runId) {
  const res = await pool.query(`
    SELECT
      category,
      import_status,
      COUNT(*) AS count
    FROM rvt_import_results
    WHERE run_id = $1
    GROUP BY category, import_status
    ORDER BY category
  `, [runId]);
  return res.rows;
}

module.exports = {
  createRun, getRunById, getRunsByProject, updateRun,
  touchRunStart, touchRunComplete, setRunError,
  createResult, batchCreateResults, getResultsByRun,
  getResultsByCategory, getRunSummary
};