/**
 * Owns: DAG edge CRUD — explicit parent/child constraint graph for BIM elements.
 * Does NOT own: constraint solving, event ledger, element persistence.
 */
const pool = require('./index');

// List all DAG edges (with optional project filter via element join)
async function getAllEdges({ projectId } = {}) {
  let sql = `SELECT * FROM dag_edges ORDER BY id ASC`;
  const res = await pool.query(sql);
  return res.rows;
}

// Get edges where element is a parent (edges propagating OUT from this element)
async function getEdgesByParent(parentId) {
  const res = await pool.query(
    `SELECT * FROM dag_edges WHERE parent_id = $1 ORDER BY id ASC`,
    [parentId]
  );
  return res.rows;
}

// Get edges where element is a child (elements that DEPEND on this element)
async function getEdgesByChild(childId) {
  const res = await pool.query(
    `SELECT * FROM dag_edges WHERE child_id = $1 ORDER BY id ASC`,
    [childId]
  );
  return res.rows;
}

// Create an edge (bind child to parent)
// Rejects if it would create a cycle: A→B→C→A
async function bindEdge({ parentId, parentType, childId, childType, constraintType = 'elevation' }) {
  // Cycle detection via recursive descent through children
  const cycle = await detectCycle(parentId, childId);
  if (cycle) {
    const err = new Error(`Cycle detected: binding would create ${cycle.join(' → ')}`);
    err.code = 'CYCLE_DETECTED';
    throw err;
  }

  const res = await pool.query(
    `INSERT INTO dag_edges (parent_id, parent_type, child_id, child_type, constraint_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (parent_id, child_id) DO UPDATE SET constraint_type = EXCLUDED.constraint_type
     RETURNING *`,
    [parentId, parentType, childId, childType, constraintType]
  );
  return res.rows[0];
}

// Remove a specific edge
async function unbindEdge(parentId, childId) {
  const res = await pool.query(
    `DELETE FROM dag_edges WHERE parent_id = $1 AND child_id = $2 RETURNING *`,
    [parentId, childId]
  );
  return res.rows[0] || null;
}

// Remove all edges for a given element (both parent and child sides)
async function removeAllEdgesFor(elementId) {
  const res = await pool.query(
    `DELETE FROM dag_edges WHERE parent_id = $1 OR child_id = $1 RETURNING *`,
    [elementId]
  );
  return res.rows;
}

// Cascade delete: remove all child edges when parent is deleted
async function removeEdgesByParent(parentId) {
  const res = await pool.query(
    `DELETE FROM dag_edges WHERE parent_id = $1 RETURNING *`,
    [parentId]
  );
  return res.rows;
}

// Detect whether binding parentId→childId would create a cycle
// Returns null if safe, or the found cycle path if unsafe
async function detectCycle(parentId, childId) {
  if (parentId === childId) return [parentId, childId];

  const visited = new Set();
  const path = [];

  async function walk(currentId) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    path.push(currentId);

    // Get all parents of currentId (reverse edges)
    const res = await pool.query(
      `SELECT parent_id FROM dag_edges WHERE child_id = $1`,
      [currentId]
    );

    for (const row of res.rows) {
      const pid = row.parent_id;
      if (pid === parentId) {
        path.push(pid);
        return true; // cycle found
      }
      if (await walk(pid)) return true;
    }

    path.pop();
    return false;
  }

  const cycleFound = await walk(childId);
  return cycleFound ? path : null;
}

// Get all dependents of an element (recursive children)
async function getDependents(elementId) {
  const dependents = new Map(); // id -> { id, edge }
  const queue = [elementId];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const children = await pool.query(
      `SELECT child_id, child_type, constraint_type FROM dag_edges WHERE parent_id = $1`,
      [current]
    );

    for (const row of children.rows) {
      if (!dependents.has(row.child_id)) {
        dependents.set(row.child_id, row);
        queue.push(row.child_id);
      }
    }
  }

  return Array.from(dependents.entries()).map(([id, edge]) => ({
    id, ...edge
  }));
}

// Seed edges from existing element→level bindings
async function seedFromElements() {
  const res = await pool.query(`
    INSERT INTO dag_edges (parent_id, parent_type, child_id, child_type, constraint_type)
    SELECT
      e.top_level_id, 'level', e.id, e.type, 'elevation'
    FROM elements e
    WHERE e.base_level_id IS NOT NULL
      AND e.top_level_id IS NOT NULL
      AND e.type IN ('wall', 'column')
    ON CONFLICT DO NOTHING
    RETURNING *
  `);
  return res.rows;
}

// Seed edges from stairs → levels
async function seedFromStairs() {
  const res = await pool.query(`
    INSERT INTO dag_edges (parent_id, parent_type, child_id, child_type, constraint_type)
    SELECT
      s.top_level_id, 'level', s.id, 'stair', 'elevation'
    FROM stairs s
    WHERE s.base_level_id IS NOT NULL AND s.top_level_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING *
  `);
  return res.rows;
}

// Seed edges from floors → levels
async function seedFromFloors() {
  const res = await pool.query(`
    INSERT INTO dag_edges (parent_id, parent_type, child_id, child_type, constraint_type)
    SELECT f.base_level_id, 'level', f.id, 'floor', 'bound'
    FROM floors f WHERE f.base_level_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING *
  `);
  return res.rows;
}

// Seed edges from ceilings → levels
async function seedFromCeilings() {
  const res = await pool.query(`
    INSERT INTO dag_edges (parent_id, parent_type, child_id, child_type, constraint_type)
    SELECT c.host_level_id, 'level', c.id, 'ceiling', 'bound'
    FROM ceilings c WHERE c.host_level_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING *
  `);
  return res.rows;
}

// Stats
async function getStats() {
  const res = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT parent_id) as parents,
      COUNT(DISTINCT child_id) as children,
      constraint_type,
      COUNT(*) as by_type
    FROM dag_edges
    GROUP BY constraint_type
    ORDER BY by_type DESC
  `);
  return res.rows;
}

module.exports = {
  getAllEdges, getEdgesByParent, getEdgesByChild,
  bindEdge, unbindEdge, removeAllEdgesFor, removeEdgesByParent,
  detectCycle, getDependents,
  seedFromElements, seedFromStairs, seedFromFloors, seedFromCeilings,
  getStats,
};