/**
 * Owns: /api/curved-surfaces CRUD endpoints + catalog types.
 * Does NOT own: DAG recalculation, IFC export internals, WebSocket lifecycle.
 */
const router = require('express').Router();
const {
  getAllCurvedSurfaces,
  getCurvedSurfaceById,
  createCurvedSurface,
  updateCurvedSurface,
  deleteCurvedSurface,
} = require('../db/curved-surfaces');
const { appendEvent } = require('../db/events');
const { recalcCurvedSurface } = require('../services/dag-solver');
const {
  broadcastCurvedSurfaceCreated,
  broadcastCurvedSurfaceUpdated,
  broadcastCurvedSurfaceDeleted,
} = require('../services/ws-server');

// GET /api/curved-surfaces?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const surfaces = await getAllCurvedSurfaces(projectId);
    res.json(surfaces);
  } catch (err) {
    console.error('[curved-surfaces] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/curved-surfaces/:id
router.get('/:id', async (req, res) => {
  try {
    const surface = await getCurvedSurfaceById(req.params.id);
    if (!surface) return res.status(404).json({ error: 'Curved surface not found' });
    res.json(surface);
  } catch (err) {
    console.error('[curved-surfaces] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curved-surfaces
router.post('/', async (req, res) => {
  try {
    const { surface_type } = req.body;
    if (!surface_type) {
      return res.status(400).json({ error: 'surface_type is required' });
    }

    // Validate level binding
    if (req.body.base_level_id && req.body.top_level_id) {
      const { getLevelById } = require('../db/levels');
      const base = await getLevelById(req.body.base_level_id);
      const top  = await getLevelById(req.body.top_level_id);
      if (base && top && parseFloat(top.elevation) <= parseFloat(base.elevation)) {
        return res.status(400).json({ error: 'Top level must be above base level' });
      }
    }

    const surface = await createCurvedSurface(req.body);

    // Recalculate computed bounds
    const computed = await recalcCurvedSurface(surface.id);
    if (computed) {
      await updateCurvedSurface(surface.id, { computed });
    }

    const saved = await getCurvedSurfaceById(surface.id);
    await appendEvent({
      entity_type: 'curved_surface', entity_id: saved.id,
      event_type: 'create', before_data: null, after_data: saved,
    });
    broadcastCurvedSurfaceCreated(saved);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[curved-surfaces] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/curved-surfaces/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getCurvedSurfaceById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Curved surface not found' });

    // Validate level binding if being changed
    if (req.body.base_level_id !== undefined || req.body.top_level_id !== undefined) {
      const { getLevelById } = require('../db/levels');
      const baseId = req.body.base_level_id ?? before.base_level_id;
      const topId  = req.body.top_level_id  ?? before.top_level_id;
      if (baseId && topId) {
        const base = await getLevelById(baseId);
        const top  = await getLevelById(topId);
        if (base && top && parseFloat(top.elevation) <= parseFloat(base.elevation)) {
          return res.status(400).json({ error: 'Top level must be above base level' });
        }
      }
    }

    await updateCurvedSurface(req.params.id, req.body);

    // Recalculate if level binding changed
    const needsRecalc = req.body.base_level_id !== undefined ||
                        req.body.top_level_id !== undefined ||
                        req.body.parameters !== undefined;
    if (needsRecalc) {
      const computed = await recalcCurvedSurface(req.params.id);
      if (computed) await updateCurvedSurface(req.params.id, { computed });
    }

    const updated = await getCurvedSurfaceById(req.params.id);
    await appendEvent({
      entity_type: 'curved_surface', entity_id: req.params.id,
      event_type: 'update', before_data: before, after_data: updated,
    });
    broadcastCurvedSurfaceUpdated(updated);
    res.json(updated);
  } catch (err) {
    console.error('[curved-surfaces] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/curved-surfaces/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getCurvedSurfaceById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Curved surface not found' });
    await deleteCurvedSurface(req.params.id);
    await appendEvent({
      entity_type: 'curved_surface', entity_id: req.params.id,
      event_type: 'delete', before_data: before, after_data: null,
    });
    broadcastCurvedSurfaceDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[curved-surfaces] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;