/**
 * db/node-editor.js — Node editor graph persistence
 * Owns: CRUD for node_editor_graphs table (per-project node/connection JSON)
 * Does NOT own: route handling, visual scripting evaluation logic
 */
const { pool } = require('./index');

/**
 * Load the saved node graph for a project.
 * Returns { nodes: [], connections: [] } if no graph saved yet.
 */
async function getGraph(projectId) {
  const result = await pool.query(
    'SELECT nodes, connections, updated_at FROM node_editor_graphs WHERE project_id = $1',
    [projectId]
  );
  if (result.rows.length === 0) {
    return { nodes: [], connections: [] };
  }
  const row = result.rows[0];
  return {
    nodes: row.nodes || [],
    connections: row.connections || [],
    updatedAt: row.updated_at,
  };
}

/**
 * Upsert a node graph for a project. Creates or replaces the existing graph.
 */
async function saveGraph(projectId, nodes, connections) {
  await pool.query(
    `INSERT INTO node_editor_graphs (project_id, nodes, connections, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (project_id) DO UPDATE SET
       nodes = EXCLUDED.nodes,
       connections = EXCLUDED.connections,
       updated_at = NOW()`,
    [projectId, JSON.stringify(nodes || []), JSON.stringify(connections || [])]
  );
}

module.exports = { getGraph, saveGraph };
