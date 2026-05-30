/**
 * Owns: /api/families CRUD, /api/door-types, /api/window-types, /api/schedules.
 * Does NOT own: element CRUD, DAG solver, WebSocket lifecycle.
 */
const router = require('express').Router();
const {
  getFamilyInstancesByProject, getFamilyInstanceById, createFamilyInstance,
  updateFamilyInstance, deleteFamilyInstance,
  getDoorTypes, getWindowTypes, getDoorSchedule, getWindowSchedule,
} = require('../db/families');
const { appendEvent } = require('../db/events');
const ws = require('../services/ws-server');

// GET /api/families — project-scoped; requires ?project_id= query param
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const instances = await getFamilyInstancesByProject(projectId);
    res.json(instances);
  } catch (err) {
    console.error('[families] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/families/:id
router.get('/:id', async (req, res) => {
  try {
    const f = await getFamilyInstanceById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Family instance not found' });
    res.json(f);
  } catch (err) {
    console.error('[families] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/families — place a door or window on a wall
router.post('/', async (req, res) => {
  try {
    const { family_type, type_name, host_wall_id, host_face_u, mark, parameters, computed } = req.body;

    if (!['door', 'window'].includes(family_type)) {
      return res.status(400).json({ error: 'family_type must be door or window' });
    }
    if (!host_wall_id) {
      return res.status(400).json({ error: 'host_wall_id is required' });
    }

    const f = await createFamilyInstance({ family_type, type_name, host_wall_id, host_face_u: host_face_u || 0.5, mark, parameters, computed });
    await appendEvent({ entity_type: 'family_instance', entity_id: f.id, event_type: 'create', before_data: null, after_data: f });
    ws.broadcastFamilyCreated(f);
    res.status(201).json(f);
  } catch (err) {
    console.error('[families] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/families/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getFamilyInstanceById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Family instance not found' });

    const { type_name, host_face_u, mark, parameters, computed } = req.body;
    const updated = await updateFamilyInstance(req.params.id, { type_name, host_face_u, mark, parameters, computed });
    await appendEvent({ entity_type: 'family_instance', entity_id: req.params.id, event_type: 'update', before_data: before, after_data: updated });
    ws.broadcastFamilyUpdated(updated);
    res.json(updated);
  } catch (err) {
    console.error('[families] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/families/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getFamilyInstanceById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Family instance not found' });
    await deleteFamilyInstance(req.params.id);
    await appendEvent({ entity_type: 'family_instance', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    ws.broadcastFamilyDeleted(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[families] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/door-types
router.get('/types/doors', async (req, res) => {
  try { res.json(await getDoorTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/window-types
router.get('/types/windows', async (req, res) => {
  try { res.json(await getWindowTypes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/schedules/doors — A-400 door schedule
router.get('/schedules/doors', async (req, res) => {
  try { res.json(await getDoorSchedule()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/schedules/windows — A-400 window schedule
router.get('/schedules/windows', async (req, res) => {
  try { res.json(await getWindowSchedule()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;