/**
 * Owns: /api/stairs CRUD + /api/stair-types catalog endpoint.
 * Does NOT own: railing queries, DAG solver internals, auth, WebSocket lifecycle.
 */
const router = require('express').Router();
const {
  getAllStairs, getStairById, getStairsByLevelId,
  createStair, updateStair, deleteStair,
  computeStairGeometry,
  getStairTypes,
} = require('../db/stairs');
const { appendEvent } = require('../db/events');
const { recalcStair } = require('../services/dag-solver');
const { broadcastStairCreated, broadcastStairUpdated, broadcastStairDeleted } = require('../services/ws-server');
const { isProjectDemo } = require('../db/projects');

// GET /api/stairs?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const stairs = await getAllStairs(projectId);
    res.json(stairs);
  } catch (err) {
    console.error('[stairs] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stairs/types
router.get('/types', async (req, res) => {
  try {
    const types = await getStairTypes();
    res.json(types);
  } catch (err) {
    console.error('[stairs] GET /types', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stairs/:id
router.get('/:id', async (req, res) => {
  try {
    const stair = await getStairById(req.params.id);
    if (!stair) return res.status(404).json({ error: 'Stair not found' });
    res.json(stair);
  } catch (err) {
    console.error('[stairs] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stairs
router.post('/', async (req, res) => {
  try {
    if (req.body.project_id && await isProjectDemo(req.body.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }
    const stair = await createStair(req.body);

    // Compute geometry from level binding
    if (stair.base_level_id && stair.top_level_id) {
      const computed = await computeStairGeometry(stair.id);
      if (computed) {
        await updateStair(stair.id, {
          total_rise: computed.total_rise,
          riser_height: computed.riser_height,
          number_of_treads: computed.number_of_treads,
          going: computed.going,
          slope_degrees: computed.slope_degrees,
        });
      }
    }

    const saved = await getStairById(stair.id);
    await appendEvent({ entity_type: 'stair', entity_id: saved.id, event_type: 'create', before_data: null, after_data: saved });
    broadcastStairCreated(saved);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[stairs] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/stairs/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getStairById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Stair not found' });
    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    // If level binding changed, recompute geometry
    const hasLevelChange = req.body.base_level_id !== undefined || req.body.top_level_id !== undefined;
    if (hasLevelChange) {
      const { getLevelById } = require('../db/levels');
      const newBaseId = req.body.base_level_id ?? before.base_level_id;
      const newTopId  = req.body.top_level_id  ?? before.top_level_id;
      if (newBaseId && newTopId) {
        const baseL = await getLevelById(newBaseId);
        const topL  = await getLevelById(newTopId);
        if (baseL && topL && parseFloat(topL.elevation) <= parseFloat(baseL.elevation)) {
          return res.status(400).json({ error: 'Top level must be above base level' });
        }
      }
    }

    await updateStair(req.params.id, req.body);

    // Recompute geometry if levels changed
    if (hasLevelChange || req.body.number_of_risers !== undefined) {
      await computeStairGeometry(req.params.id);
    }

    const updated = await getStairById(req.params.id);
    await appendEvent({ entity_type: 'stair', entity_id: req.params.id, event_type: 'update', before_data: before, after_data: updated });
    broadcastStairUpdated(updated);
    res.json(updated);
  } catch (err) {
    console.error('[stairs] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stairs/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getStairById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Stair not found' });
    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }
    await deleteStair(req.params.id);
    await appendEvent({ entity_type: 'stair', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    broadcastStairDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[stairs] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;