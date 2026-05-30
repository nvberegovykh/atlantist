/**
 * Owns: viewport_states table — per-user per-project viewport continuity records.
 * Does NOT own: project settings, element data, or camera logic.
 */
const pool = require('./index');

/**
 * Upsert viewport state for a user+project.
 * state_json: { layout, panes, cameras, selectedIds, activeTool, capturedAt }
 */
async function upsertViewportState(userId, projectId, stateJson) {
  const res = await pool.query(
    `INSERT INTO viewport_states (user_id, project_id, state_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, project_id)
     DO UPDATE SET state_json = $3, updated_at = NOW()
     RETURNING *`,
    [userId, projectId, JSON.stringify(stateJson)]
  );
  return res.rows[0];
}

/**
 * Get the most recent viewport state for a user+project.
 * Returns null if no row exists or the state is older than maxAgeMs.
 */
async function getViewportState(userId, projectId, maxAgeMs = 24 * 60 * 60 * 1000) {
  const res = await pool.query(
    `SELECT * FROM viewport_states
     WHERE user_id = $1 AND project_id = $2
     AND updated_at > NOW() - ($3 || ' milliseconds')::INTERVAL`,
    [userId, projectId, maxAgeMs]
  );
  return res.rows[0] || null;
}

/**
 * Delete viewport state for a user+project (e.g. on explicit "start fresh").
 */
async function deleteViewportState(userId, projectId) {
  await pool.query(
    'DELETE FROM viewport_states WHERE user_id = $1 AND project_id = $2',
    [userId, projectId]
  );
}

module.exports = { upsertViewportState, getViewportState, deleteViewportState };
