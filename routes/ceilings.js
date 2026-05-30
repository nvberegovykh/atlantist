/**
 * Owns: /api/ceilings CRUD + ceiling_layers multi-layer construction.
 * Does NOT own: Three.js rendering, floor queries, room queries, DAG recalculation.
 */
const router = require('express').Router();
const {
  getAllCeilings, getCeilingById, createCeiling, updateCeiling, deleteCeiling,
  getCeilingLayers, setCeilingLayers, getCeilingTypes,
} = require('../db/ceilings');
const { appendEvent } = require('../db/events');
const { recalcCeiling } = require('../services/dag-solver');
const ws = require('../services/ws-server');

// GET /api/ceilings?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const ceilings = await getAllCeilings(projectId);
    const withLayers = await Promise.all(ceilings.map(async (c) => {
      const layers = await getCeilingLayers(c.id);
      return { ...c, layers };
    }));
    res.json(withLayers);
  } catch (err) {
    console.error('[ceilings] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ceilings/types
router.get('/types', async (req, res) => {
  try {
    res.json(await getCeilingTypes());
  } catch (err) {
    console.error('[ceilings] GET /types', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ceilings/:id
router.get('/:id', async (req, res) => {
  try {
    const c = await getCeilingById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Ceiling not found' });
    const layers = await getCeilingLayers(c.id);
    res.json({ ...c, layers });
  } catch (err) {
    console.error('[ceilings] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ceilings
router.post('/', async (req, res) => {
  try {
    const { layers: ceilingLayers, ...data } = req.body;
    // project_id must be provided by the caller; do not fall back to 1

    const c = await createCeiling(data);
    if (ceilingLayers && ceilingLayers.length > 0) {
      await setCeilingLayers(c.id, ceilingLayers);
    }

    const updated = await recalcCeiling(c.id);
    const finalLayers = await getCeilingLayers(c.id);
    const result = { ...updated, layers: finalLayers };

    await appendEvent({ entity_type: 'ceiling', entity_id: c.id, event_type: 'create', before_data: null, after_data: result });
    ws.broadcastCeilingCreated(result);
    res.status(201).json(result);
  } catch (err) {
    console.error('[ceilings] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ceilings/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getCeilingById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Ceiling not found' });

    const { layers: ceilingLayers, ...fields } = req.body;
    await updateCeiling(req.params.id, fields);

    if (ceilingLayers && ceilingLayers.length > 0) {
      await setCeilingLayers(req.params.id, ceilingLayers);
    }

    const updated = await recalcCeiling(req.params.id);
    const finalLayers = await getCeilingLayers(req.params.id);
    const result = { ...updated, layers: finalLayers };

    await appendEvent({ entity_type: 'ceiling', entity_id: req.params.id, event_type: 'update', before_data: before, after_data: result });
    ws.broadcastCeilingUpdated(result);
    res.json(result);
  } catch (err) {
    console.error('[ceilings] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ceilings/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getCeilingById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Ceiling not found' });
    await deleteCeiling(req.params.id);
    await appendEvent({ entity_type: 'ceiling', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    ws.broadcastCeilingDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ceilings] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;