/**
 * Owns: DAG edge management — binding, unbinding, dependency queries.
 * Wraps db/dag-edges.js with business-logic helpers.
 * Does NOT own: constraint solving, element persistence, event ledger.
 */
const {
  bindEdge, unbindEdge, getEdgesByParent, getEdgesByChild,
  getDependents, detectCycle, getAllEdges,
  seedFromElements, seedFromStairs, seedFromFloors, seedFromCeilings,
  removeAllEdgesFor,
} = require('../db/dag-edges');

/**
 * Bind an element to a parent (e.g., wall → level, door → wall).
 * Returns the created edge, or throws on cycle.
 */
async function bindChild({ parentId, parentType, childId, childType, constraintType }) {
  return bindEdge({ parentId, parentType, childId, childType, constraintType });
}

/**
 * Unbind a child from its parent.
 */
async function unbindChild(parentId, childId) {
  return unbindEdge(parentId, childId);
}

/**
 * Get all elements that depend on the given element (recursive children).
 * Used for "who gets updated if I change X?"
 */
async function getDependentsOf(elementId) {
  return getDependents(elementId);
}

/**
 * Get all parent edges for an element (who does this element depend on?).
 */
async function getParentDependencies(elementId) {
  return getEdgesByChild(elementId);
}

/**
 * Manually trigger a full DAG solve.
 * Returns { triggered, elapsed } with count of elements updated.
 */
async function triggerSolve() {
  const dagSolver = require('./dag-solver');
  const allEdges = await getAllEdges();

  // Group by parent to batch by trigger
  const parentMap = {};
  for (const edge of allEdges) {
    if (!parentMap[edge.parent_id]) parentMap[edge.parent_id] = [];
    parentMap[edge.parent_id].push(edge);
  }

  const start = Date.now();
  let totalUpdated = 0;

  // Process each parent trigger (typically level elevation changes)
  for (const [parentId, edges] of Object.entries(parentMap)) {
    for (const edge of edges) {
      switch (edge.child_type) {
        case 'wall':
        case 'column':
          await dagSolver.recalcElement(edge.child_id);
          totalUpdated++;
          break;
        case 'stair':
          await dagSolver.recalcStair(edge.child_id);
          totalUpdated++;
          break;
        case 'floor':
          await dagSolver.recalcFloor(edge.child_id);
          totalUpdated++;
          break;
        case 'ceiling':
          await dagSolver.recalcCeiling(edge.child_id);
          totalUpdated++;
          break;
      }
    }
  }

  const elapsed = Date.now() - start;
  return { triggered: totalUpdated, elapsed };
}

/**
 * Seed all DAG edges from existing element data.
 * Call this once after migration to bootstrap the graph.
 */
async function seedAll() {
  const results = {
    elements: await seedFromElements(),
    stairs: await seedFromStairs(),
    floors: await seedFromFloors(),
    ceilings: await seedFromCeilings(),
  };
  return results;
}

/**
 * Remove all DAG edges when an element is deleted.
 * Prevents stale edges pointing to deleted entities.
 */
async function cleanupElement(elementId) {
  return removeAllEdgesFor(elementId);
}

module.exports = {
  bindChild, unbindChild,
  getDependentsOf, getParentDependencies,
  triggerSolve, seedAll, cleanupElement,
};