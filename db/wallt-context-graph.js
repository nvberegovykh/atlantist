/**
 * Owns: wallt_context_graph CRUD — typed context nodes for Wallt AI.
 * Does NOT own: Wallt conversations, AI model calls, wallt_core_* memory tables.
 */

const pool = require('./index');

/**
 * Upsert a context graph node by type. Creates or replaces.
 * @param {string} nodeType - One of the allowed node_type values
 * @param {string} content - The node content (markdown/plain text)
 * @param {object} metadataJson - Optional metadata
 */
async function upsertNode(nodeType, content, metadataJson = {}) {
  const { rows } = await pool.query(
    `INSERT INTO wallt_context_graph (node_type, content, metadata_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (node_type)
     DO UPDATE SET content = EXCLUDED.content,
                   metadata_json = EXCLUDED.metadata_json,
                   updated_at = NOW()
     RETURNING *`,
    [nodeType, content, JSON.stringify(metadataJson)]
  );
  return rows[0];
}

/**
 * Get node by type. Returns null if not found.
 */
async function getNode(nodeType) {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_context_graph WHERE node_type = $1`,
    [nodeType]
  );
  return rows[0] ?? null;
}

/**
 * Get all context nodes, ordered by type precedence (user_context first).
 * Returns the full layered context stack.
 */
async function getAllNodes() {
  // Type precedence for layered read
  const precedence = {
    user_context: 1,
    company_profile: 2,
    revenue: 3,
    active_work: 4,
    support_history: 5,
  };
  const { rows } = await pool.query(
    `SELECT * FROM wallt_context_graph ORDER BY node_type`
  );
  // Sort: explicit precedence first, then alphabetical
  return rows.sort((a, b) => {
    const pa = precedence[a.node_type] ?? 99;
    const pb = precedence[b.node_type] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.node_type.localeCompare(b.node_type);
  });
}

/**
 * Delete a node by type.
 */
async function deleteNode(nodeType) {
  const { rowCount } = await pool.query(
    `DELETE FROM wallt_context_graph WHERE node_type = $1`,
    [nodeType]
  );
  return rowCount > 0;
}

/**
 * Get all feature nodes (node_type LIKE 'feature:%').
 */
async function getFeatureNodes() {
  const { rows } = await pool.query(
    `SELECT * FROM wallt_context_graph WHERE node_type LIKE 'feature:%' ORDER BY node_type`
  );
  return rows;
}

/**
 * Get a specific feature node by feature name.
 * @param {string} featureName - e.g. "node-editor" for "feature:node-editor"
 */
async function getFeatureNode(featureName) {
  return getNode(`feature:${featureName}`);
}

/**
 * Layered read: returns all context nodes in precedence order.
 * Used by Wallt AI system prompt builder to inject context layers.
 * Order: user_context → company_profile → feature nodes → revenue → active_work → support_history
 */
async function layeredRead() {
  const nodes = await getAllNodes();
  return nodes.map(n => ({
    type: n.node_type,
    content: n.content,
    metadata: n.metadata_json,
    updated_at: n.updated_at,
  }));
}

module.exports = { upsertNode, getNode, getAllNodes, deleteNode, getFeatureNodes, getFeatureNode, layeredRead };