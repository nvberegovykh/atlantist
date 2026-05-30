/**
 * Owns: webhook handler DB queries (project upsert, event logging, sim queuing).
 * Does NOT own: webhook verification, external API calls, Stripe handling.
 */
const pool = require('./index');

async function verifyWebhookSecret(secret, expectedSecret) {
  return secret === expectedSecret;
}

async function upsertProjectFromFiling({ name, address, borough, bin, job_number, job_type, owner, architect, settings }) {
  const res = await pool.query(
    `INSERT INTO projects (name, address, borough, bin, job_number, job_type, owner, architect, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (bin) DO UPDATE SET
       address = EXCLUDED.address,
       owner = EXCLUDED.owner,
       architect = EXCLUDED.architect,
       updated_at = NOW()
     RETURNING id`,
    [name, address, borough, bin, job_number, job_type, owner, architect, settings]
  );
  return res.rows[0]?.id || null;
}

async function logWebhookEvent(entity_type, entity_id, event_type, after_data, triggered_by) {
  await pool.query(
    `INSERT INTO event_ledger (entity_type, entity_id, event_type, after_data, triggered_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [entity_type, entity_id, event_type, JSON.stringify(after_data), triggered_by]
  );
}

async function queueEnergySimulation(projectId) {
  const res = await pool.query(
    `INSERT INTO energy_simulations (project_id, model_snapshot, status, created_at)
     VALUES ($1, '{}', 'pending', NOW())`,
    [projectId]
  );
  return res.rowCount > 0;
}

async function updateFireProtectionRun(runId, resultsJson) {
  const res = await pool.query(
    `UPDATE fire_protection_runs
     SET results_json = COALESCE(results_json, '{}'::jsonb) || $2,
         status = 'completed',
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [runId, resultsJson]
  );
  return res.rows[0] || null;
}

async function updateGeotechnicalRun(runId, resultsJson) {
  await pool.query(
    `UPDATE geotechnical_runs
     SET bearing_results = COALESCE(bearing_results, '{}'::jsonb) || $2,
         updated_at = NOW()
     WHERE id = $1`,
    [runId, resultsJson]
  );
}

module.exports = {
  verifyWebhookSecret,
  upsertProjectFromFiling,
  logWebhookEvent,
  queueEnergySimulation,
  updateFireProtectionRun,
  updateGeotechnicalRun
};