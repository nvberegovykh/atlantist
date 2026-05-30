/**
 * Owns: /api/floors CRUD + floor_layers multi-layer construction.
 * Does NOT own: Three.js rendering, DAG recalculation trigger, ceiling queries.
 */
const router = require('express').Router();
const {
  getAllFloors, getFloorById, createFloor, updateFloor, deleteFloor,
  getFloorLayers, setFloorLayers, getFloorTypes,
} = require('../db/floors');
const { appendEvent } = require('../db/events');
const { recalcFloor } = require('../services/dag-solver');
const ws = require('../services/ws-server');
const { isProjectDemo } = require('../db/projects');

// GET /api/floors?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const floors = await getAllFloors(projectId);
    const withLayers = await Promise.all(floors.map(async (f) => {
      const layers = await getFloorLayers(f.id);
      return { ...f, layers };
    }));
    res.json(withLayers);
  } catch (err) {
    console.error('[floors] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/floors/types
router.get('/types', async (req, res) => {
  try {
    res.json(await getFloorTypes());
  } catch (err) {
    console.error('[floors] GET /types', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/floors/:id
router.get('/:id', async (req, res) => {
  try {
    const f = await getFloorById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Floor not found' });
    const layers = await getFloorLayers(f.id);
    res.json({ ...f, layers });
  } catch (err) {
    console.error('[floors] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/floors
router.post('/', async (req, res) => {
  try {
    const { layers: floorLayers, ...data } = req.body;
    if (data.project_id && await isProjectDemo(data.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    const f = await createFloor(data);
    if (floorLayers && floorLayers.length > 0) {
      await setFloorLayers(f.id, floorLayers);
    }

    const updated = await recalcFloor(f.id);
    const finalLayers = await getFloorLayers(f.id);
    const result = { ...updated, layers: finalLayers };

    await appendEvent({ entity_type: 'floor', entity_id: f.id, event_type: 'create', before_data: null, after_data: result });
    ws.broadcastFloorCreated(result);
    res.status(201).json(result);
  } catch (err) {
    console.error('[floors] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/floors/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getFloorById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Floor not found' });
    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    const { layers: floorLayers, ...fields } = req.body;
    await updateFloor(req.params.id, fields);

    if (floorLayers && floorLayers.length > 0) {
      await setFloorLayers(req.params.id, floorLayers);
    }

    const updated = await recalcFloor(req.params.id);
    const finalLayers = await getFloorLayers(req.params.id);
    const result = { ...updated, layers: finalLayers };

    await appendEvent({ entity_type: 'floor', entity_id: req.params.id, event_type: 'update', before_data: before, after_data: result });
    ws.broadcastFloorUpdated(result);
    res.json(result);
  } catch (err) {
    console.error('[floors] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/floors/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getFloorById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Floor not found' });
    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }
    await deleteFloor(req.params.id);
    await appendEvent({ entity_type: 'floor', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    ws.broadcastFloorDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[floors] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;