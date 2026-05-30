/**
 * Owns: all DB queries for IFC import/export runs.
 * Does NOT own: IFC parsing logic, HTTP routing, file handling.
 */
const pool = require('./index');

// ─── Import runs ─────────────────────────────────────────────────────────────

async function createImportRun(data) {
  const { project_id, file_name, file_size_bytes, schema } = data;
  const res = await pool.query(
    `INSERT INTO ifc_import_runs (project_id, file_name, file_size_bytes, schema, status, progress_pct)
     VALUES ($1, $2, $3, $4, 'pending', 0) RETURNING *`,
    [project_id, file_name, file_size_bytes, schema || 'IFC2X3']
  );
  return res.rows[0];
}

async function updateImportRunStatus(id, status, progress_pct) {
  const res = await pool.query(
    `UPDATE ifc_import_runs SET status = $2, progress_pct = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, status, progress_pct]
  );
  return res.rows[0];
}

async function updateImportRunResult(id, stats, stats_json) {
  const res = await pool.query(
    `UPDATE ifc_import_runs
     SET status = 'completed', progress_pct = 100, stats_json = $2,
         elements_created = $3, levels_created = $4, family_instances_created = $5, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(stats), stats.elements || 0, stats.levels || 0, stats.family_instances || 0]
  );
  return res.rows[0];
}

async function getImportRunById(id) {
  const res = await pool.query(`SELECT * FROM ifc_import_runs WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function getImportRunsByProject(projectId) {
  const res = await pool.query(
    `SELECT * FROM ifc_import_runs WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows;
}

// ─── Export runs ─────────────────────────────────────────────────────────────

async function createExportRun(data) {
  const { project_id, schema, file_name } = data;
  const res = await pool.query(
    `INSERT INTO ifc_export_runs (project_id, schema, file_name, status)
     VALUES ($1, $2, $3, 'pending') RETURNING *`,
    [project_id, schema || 'IFC2X3', file_name || 'export.ifc']
  );
  return res.rows[0];
}

async function updateExportRunStatus(id, status, file_path) {
  const res = await pool.query(
    `UPDATE ifc_export_runs
     SET status = $2, file_path = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, status, file_path]
  );
  return res.rows[0];
}

async function getExportRunById(id) {
  const res = await pool.query(`SELECT * FROM ifc_export_runs WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function getExportRunsByProject(projectId) {
  const res = await pool.query(
    `SELECT * FROM ifc_export_runs WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows;
}

module.exports = {
  createImportRun,
  updateImportRunStatus,
  updateImportRunResult,
  getImportRunById,
  getImportRunsByProject,
  createExportRun,
  updateExportRunStatus,
  getExportRunById,
  getExportRunsByProject,
};