/**
 * Owns: all DB queries for issues, issue_comments, issue_snapshots.
 * Does NOT own: HTTP routing, WebSocket broadcast, auth, DAG logic.
 */
const pool = require('./index');

async function getAllIssues(documentId = 'default') {
  const res = await pool.query(
    `SELECT i.*,
       (SELECT COUNT(*) FROM issue_comments ic WHERE ic.issue_id = i.id) AS comment_count,
       s.camera_position, s.view_mode, s.visible_layers, s.snapshot_png
     FROM issues i
     LEFT JOIN issue_snapshots s ON s.issue_id = i.id
     WHERE i.document_id = $1
     ORDER BY i.created_at DESC`,
    [documentId]
  );
  return res.rows;
}

async function getIssueById(id) {
  const res = await pool.query(
    `SELECT i.*,
       s.id AS snapshot_id, s.camera_position, s.view_mode, s.visible_layers, s.snapshot_png
     FROM issues i
     LEFT JOIN issue_snapshots s ON s.issue_id = i.id
     WHERE i.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function createIssue({ document_id = 'default', author_user_id, anchor_element_id, status = 'open', priority = 'normal', title, body = '' }) {
  const res = await pool.query(
    `INSERT INTO issues (document_id, author_user_id, anchor_element_id, status, priority, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [document_id, author_user_id, anchor_element_id || null, status, priority, title, body]
  );
  return res.rows[0];
}

async function updateIssueStatus(id, status) {
  const resolvedAt = status === 'resolved' ? 'NOW()' : 'NULL';
  const res = await pool.query(
    `UPDATE issues SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return res.rows[0] || null;
}

async function getIssueComments(issueId) {
  const res = await pool.query(
    `SELECT * FROM issue_comments WHERE issue_id = $1 ORDER BY created_at ASC`,
    [issueId]
  );
  return res.rows;
}

async function addIssueComment({ issue_id, author_user_id, body }) {
  const res = await pool.query(
    `INSERT INTO issue_comments (issue_id, author_user_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [issue_id, author_user_id, body]
  );
  return res.rows[0];
}

async function createSnapshot({ issue_id, camera_position = {}, view_mode = '3d', visible_layers = [], snapshot_png = null }) {
  // Upsert: one snapshot per issue (replace if already exists)
  await pool.query(`DELETE FROM issue_snapshots WHERE issue_id = $1`, [issue_id]);
  const res = await pool.query(
    `INSERT INTO issue_snapshots (issue_id, camera_position, view_mode, visible_layers, snapshot_png)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [issue_id, JSON.stringify(camera_position), view_mode, JSON.stringify(visible_layers), snapshot_png]
  );
  return res.rows[0];
}

async function deleteIssue(id) {
  await pool.query(`DELETE FROM issues WHERE id = $1`, [id]);
}

module.exports = {
  getAllIssues, getIssueById, createIssue, updateIssueStatus,
  getIssueComments, addIssueComment, createSnapshot, deleteIssue
};
