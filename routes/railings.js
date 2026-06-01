/**
 * Owns: /api/railings CRUD + /api/railing-types catalog endpoint.
 * Does NOT own: stair queries, DAG solver, auth, WebSocket lifecycle.
 */
const router = require('express').Router();
const {
  getAllRailings, getRailingsByStairId, getRailingById,
  createRailing, updateRailing, deleteRailing,
  getRailingTypes,
} = require('../db/railings');
const { appendEvent } = require('../db/events');
const { broadcastRailingCreated, broadcastRailingUpdated, broadcastRailingDeleted } = require('../services/ws-server');
const { isProjectDemo } = require('../db/projects');

// GET /api/railings?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const railings = await getAllRailings(projectId);
    res.json(railings);
  } catch (err) {
    console.error('[railings] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/railings/types
router.get('/types', async (req, res) => {
  try {
    const types = await getRailingTypes();
    res.json(types);
  } catch (err) {
    console.error('[railings] GET /types', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/railings/stair/:stairId
router.get('/stair/:stairId', async (req, res) => {
  try {
    const railings = await getRailingsByStairId(req.params.stairId);
    res.json(railings);
  } catch (err) {
    console.error('[railings] GET /stair/:stairId', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/railings/:id
router.get('/:id', async (req, res) => {
  try {
    const railing = await getRailingById(req.params.id);
    if (!railing) return res.status(404).json({ error: 'Railing not found' });
    res.json(railing);
  } catch (err) {
    console.error('[railings] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/railings
router.post('/', async (req, res) => {
  try {
    const { host_stair_id, project_id } = req.body;
    if (!host_stair_id) return res.status(400).json({ error: 'host_stair_id required' });
    if (project_id && await isProjectDemo(project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    const {
      name, railing_type, height, top_rail_width,
      baluster_spacing, glass_thickness, side, material, glass_finish,
    } = req.body;
    const railing = await createRailing({
      project_id: project_id || 1,
      host_stair_id,
      name, railing_type, height, top_rail_width,
      baluster_spacing, glass_thickness, side, material, glass_finish,
    });
    await appendEvent({ entity_type: 'railing', entity_id: railing.id, event_type: 'create', before_data: null, after_data: railing });
    broadcastRailingCreated(railing);
    res.status(201).json(railing);
  } catch (err) {
    console.error('[railings] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/railings/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getRailingById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Railing not found' });
    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    await updateRailing(req.params.id, req.body);
    const updated = await getRailingById(req.params.id);
    await appendEvent({ entity_type: 'railing', entity_id: req.params.id, event_type: 'update', before_data: before, after_data: updated });
    broadcastRailingUpdated(updated);
    res.json(updated);
  } catch (err) {
    console.error('[railings] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/railings/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getRailingById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Railing not found' });
    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }
    await deleteRailing(req.params.id);
    await appendEvent({ entity_type: 'railing', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    broadcastRailingDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[railings] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;