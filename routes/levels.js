/**
 * Owns: /api/levels CRUD endpoints.
 * Does NOT own: element queries, DAG solver internals, auth, WebSocket lifecycle.
 */
const router = require('express').Router();
const { getAllLevels, getAllLevelsByProject, getLevelById, createLevel, updateLevel, deleteLevel, getLevelElementCounts } = require('../db/levels');
const { appendEvent } = require('../db/events');
const { recalcElementsForLevel, recalcElementsForLevelAsync, recalcStairsForLevel } = require('../services/dag-solver');
const ws = require('../services/ws-server');
const { isProjectDemo } = require('../db/projects');
const { bindEdge } = require('../db/dag-edges');

// GET /api/levels — requires ?project_id= query param
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const levels = await getAllLevelsByProject(projectId);
    res.json(levels);
  } catch (err) {
    console.error('[levels] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/levels/:id
router.get('/:id', async (req, res) => {
  try {
    const level = await getLevelById(req.params.id);
    if (!level) return res.status(404).json({ error: 'Level not found' });
    const counts = await getLevelElementCounts(req.params.id);
    res.json({ ...level, ...counts });
  } catch (err) {
    console.error('[levels] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/levels
router.post('/', async (req, res) => {
  try {
    if (req.body.project_id && await isProjectDemo(req.body.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }
    const level = await createLevel(req.body);
    await appendEvent({ entity_type: 'level', entity_id: level.id, event_type: 'create', before_data: null, after_data: level });
    ws.broadcastLevelCreated(level);
    res.status(201).json(level);
  } catch (err) {
    console.error('[levels] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/levels/:id
router.patch('/:id', async (req, res) => {
  req._dagStart = Date.now();
  try {
    const before = await getLevelById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Level not found' });

    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    if (req.body.elevation !== undefined && isNaN(parseFloat(req.body.elevation))) {
      return res.status(400).json({ error: 'Elevation must be a number' });
    }

    const updated = await updateLevel(req.params.id, req.body);
    await appendEvent({ entity_type: 'level', entity_id: updated.id, event_type: 'update', before_data: before, after_data: updated });

    const projectId = before.project_id;

    // Elevation changed → trigger DAG recalc + broadcast cascade to same-project clients
    let cascadeUpdated = [];
    let dagElapsed = 0;
    if (req.body.elevation !== undefined && parseFloat(req.body.elevation) !== parseFloat(before.elevation)) {
      dagElapsed = Date.now() - (req._dagStart || Date.now());

      // Async DAG recalc — runs in setImmediate microtask, UI never blocked.
      // Pass projectId so we only touch elements from the current project.
      recalcElementsForLevelAsync(req.params.id, projectId)
        .then(result => {
          console.log(`[dag] level ${req.params.id} elevation recalc: ${result.updated.length} elements in ${result.elapsed}ms`);
          // Broadcast updated elements to same-project clients so their 3D view updates <2s
          ws.broadcastDAGRecalcComplete(projectId, req.params.id, result.updated);
        })
        .catch(err => {
          console.error('[dag] recalc failed for level', req.params.id, err.message);
        });

      // Stairs recalc (async, non-blocking)
      recalcStairsForLevel(req.params.id).catch(err => {
        console.error('[dag] stairs recalc failed for level', req.params.id, err.message);
      });
    }

    const counts = await getLevelElementCounts(req.params.id);
    const responsePayload = { level: { ...updated, ...counts }, cascadeUpdated, dagElapsed, dagAsync: true };

    // Project-scoped broadcast — only clients in the same project receive this
    ws.broadcastToProject(projectId, { type: 'level_updated', payload: responsePayload });
    res.json(responsePayload);
  } catch (err) {
    console.error('[levels] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/levels/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getLevelById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Level not found' });

    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    await deleteLevel(req.params.id);
    await appendEvent({ entity_type: 'level', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    ws.broadcastLevelDeleted(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[levels] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
