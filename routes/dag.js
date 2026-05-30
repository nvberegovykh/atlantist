/**
 * Owns: DAG API endpoints — edge management, dependency queries, manual solve trigger.
 * Does NOT own: element queries, DAG solver internals, event ledger.
 */
const router = require('express').Router();
const {
  getAllEdges, getEdgesByParent, getEdgesByChild,
  bindEdge, unbindEdge, detectCycle, getDependents, getStats,
} = require('../db/dag-edges');
const {
  bindChild, unbindChild, getDependentsOf, getParentDependencies,
  triggerSolve, seedAll,
} = require('../services/dag-edges');

// GET /api/dag/edges — list all DAG edges
router.get('/edges', async (req, res) => {
  try {
    const edges = await getAllEdges();
    res.json({ edges, count: edges.length });
  } catch (err) {
    console.error('[dag] GET /edges', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dag/edges/:elementId — get edges for element (both parent and child sides)
router.get('/edges/:elementId', async (req, res) => {
  try {
    const [asParent, asChild] = await Promise.all([
      getEdgesByParent(req.params.elementId),
      getEdgesByChild(req.params.elementId),
    ]);
    res.json({ as_parent: asParent, as_child: asChild });
  } catch (err) {
    console.error('[dag] GET /edges/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dag/bind — bind child element to parent (creates constraint edge)
router.post('/bind', async (req, res) => {
  try {
    const { parent_id, parent_type, child_id, child_type, constraint_type = 'elevation' } = req.body;
    if (!parent_id || !child_id) {
      return res.status(400).json({ error: 'parent_id and child_id are required' });
    }
    if (!['level','wall','column','grid','family'].includes(parent_type)) {
      return res.status(400).json({ error: 'Invalid parent_type' });
    }
    if (!['wall','column','family','floor','ceiling','stair'].includes(child_type)) {
      return res.status(400).json({ error: 'Invalid child_type' });
    }

    const edge = await bindChild({ parentId: parent_id, parentType: parent_type, childId: child_id, childType: child_type, constraintType: constraint_type });
    res.status(201).json({ edge });
  } catch (err) {
    if (err.code === 'CYCLE_DETECTED') {
      return res.status(409).json({ error: 'Cycle detected', detail: err.message });
    }
    console.error('[dag] POST /bind', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dag/unbind/:parentId/:childId — remove a constraint edge
router.delete('/unbind/:parentId/:childId', async (req, res) => {
  try {
    const removed = await unbindChild(req.params.parentId, req.params.childId);
    if (!removed) return res.status(404).json({ error: 'Edge not found' });
    res.json({ removed });
  } catch (err) {
    console.error('[dag] DELETE /unbind', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dag/dependents/:elementId — elements that depend on this one (recursive children)
router.get('/dependents/:elementId', async (req, res) => {
  try {
    const dependents = await getDependentsOf(req.params.elementId);
    res.json({ element_id: req.params.elementId, dependents, count: dependents.length });
  } catch (err) {
    console.error('[dag] GET /dependents/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dag/cycle-check?parent_id=X&child_id=Y — check if binding would create a cycle
router.get('/cycle-check', async (req, res) => {
  try {
    const { parent_id, child_id } = req.query;
    if (!parent_id || !child_id) {
      return res.status(400).json({ error: 'parent_id and child_id query params required' });
    }
    const cycle = await detectCycle(parent_id, child_id);
    res.json({ parent_id, child_id, would_create_cycle: !!cycle, cycle_path: cycle });
  } catch (err) {
    console.error('[dag] GET /cycle-check', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dag/solve — manually trigger full DAG solve (async, non-blocking)
router.post('/solve', async (req, res) => {
  try {
    // Trigger async solve — respond immediately, solver runs in background
    const solvePromise = triggerSolve();

    // Let solve run async; respond with pending status
    solvePromise.then(result => {
      console.log(`[dag] Manual solve completed: ${result.triggered} elements in ${result.elapsed}ms`);
    }).catch(err => {
      console.error('[dag] Solve failed:', err.message);
    });

    res.json({ status: 'solving', message: 'DAG solve triggered — check logs for completion' });
  } catch (err) {
    console.error('[dag] POST /solve', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dag/stats — DAG graph statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ stats });
  } catch (err) {
    console.error('[dag] GET /stats', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dag/seed — seed DAG edges from existing element data (post-migration bootstrap)
router.post('/seed', async (req, res) => {
  try {
    const results = await seedAll();
    const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    res.json({ seeded: total, breakdown: results });
  } catch (err) {
    console.error('[dag] POST /seed', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;