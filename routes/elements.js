/**
 * Owns: /api/elements CRUD endpoints, /api/wall-types, /api/column-types.
 * Does NOT own: level queries, DAG solver internals, auth, WebSocket lifecycle.
 */
const router = require('express').Router();
const {
  getAllElementsByProject, getElementById, createElement, updateElement, deleteElement,
  getWallLayers, setWallLayers, getRoofLayers, setRoofLayers, getWallTypes, getColumnTypes, getRoofTypes,
} = require('../db/elements');
const { appendEvent } = require('../db/events');
const { recalcElement } = require('../services/dag-solver');
const ws = require('../services/ws-server');
const { bindEdge } = require('../db/dag-edges');
const annotationsDb = require('../db/annotations');
const { isProjectDemo } = require('../db/projects');

// GET /api/elements — requires ?project_id= query param
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const elements = await getAllElementsByProject(projectId);
    const result = await Promise.all(elements.map(async (el) => {
      if (el.type === 'wall') {
        const layers = await getWallLayers(el.id);
        return { ...el, layers };
      }
      if (el.type === 'roof') {
        const layers = await getRoofLayers(el.id);
        return { ...el, layers };
      }
      return el;
    }));
    res.json(result);
  } catch (err) {
    console.error('[elements] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/elements/wall-types — wall type catalog (declared in module header)
router.get('/wall-types', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getWallTypes());
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/elements/column-types — column type catalog (declared in module header)
router.get('/column-types', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getColumnTypes());
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/elements/:id
router.get('/:id', async (req, res) => {
  try {
    const el = await getElementById(req.params.id);
    if (!el) return res.status(404).json({ error: 'Element not found' });
    const layers = el.type === 'wall' ? await getWallLayers(el.id)
                : el.type === 'roof' ? await getRoofLayers(el.id) : [];
    res.json({ ...el, layers });
  } catch (err) {
    console.error('[elements] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/elements
router.post('/', async (req, res) => {
  try {
    const { type, layers: wallLayers, ...data } = req.body;
    if (!['wall', 'column', 'roof'].includes(type)) {
      return res.status(400).json({ error: 'type must be wall, column, or roof' });
    }

    // Demo projects are read-only — block all writes except when forking (project_id != demo id)
    if (data.project_id && await isProjectDemo(data.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    // Validate level binding
    if (data.base_level_id && data.top_level_id) {
      const { getLevelById } = require('../db/levels');
      const base = await getLevelById(data.base_level_id);
      const top = await getLevelById(data.top_level_id);
      if (base && top && parseFloat(top.elevation) <= parseFloat(base.elevation)) {
        return res.status(400).json({ error: 'Top level must be above base level' });
      }
    }

    const el = await createElement({ type, ...data });

    // Set layers if provided
    if (type === 'wall' && wallLayers && wallLayers.length > 0) {
      await setWallLayers(el.id, wallLayers);
    } else if (type === 'roof' && wallLayers && wallLayers.length > 0) {
      await setRoofLayers(el.id, wallLayers);
    }

    // Auto-create DAG edge: element → top_level so level elevation changes cascade to this element
    if (el.top_level_id) {
      bindEdge({
        parentId: el.top_level_id,
        parentType: 'level',
        childId: el.id,
        childType: type,
        constraintType: 'elevation',
      }).catch(err => {
        // Non-fatal: edge may already exist (idempotent ON CONFLICT)
        if (!err.message.includes('CYCLE') && !err.message.includes('ON CONFLICT')) {
          console.error('[dag] auto-bind failed for element', el.id, err.message);
        }
      });
    }

    // Recalculate computed values
    const updated = await recalcElement(el.id);
    const finalLayers = type === 'wall' ? await getWallLayers(el.id)
                       : type === 'roof' ? await getRoofLayers(el.id) : [];

    await appendEvent({ entity_type: 'element', entity_id: el.id, event_type: 'create', before_data: null, after_data: updated });
    const created = { ...updated, layers: finalLayers };
    ws.broadcastElementCreated(created);
    res.status(201).json(created);
  } catch (err) {
    console.error('[elements] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/elements/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getElementById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Element not found' });

    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    const { layers, parameters, ...topLevel } = req.body;

    // Merge parameters
    const mergedParams = parameters
      ? { ...(typeof before.parameters === 'string' ? JSON.parse(before.parameters) : before.parameters), ...parameters }
      : undefined;

    // Validate level binding
    const newBaseId = topLevel.base_level_id ?? before.base_level_id;
    const newTopId = topLevel.top_level_id ?? before.top_level_id;
    if (newBaseId && newTopId) {
      const { getLevelById } = require('../db/levels');
      const base = await getLevelById(newBaseId);
      const top = await getLevelById(newTopId);
      if (base && top && parseFloat(top.elevation) <= parseFloat(base.elevation)) {
        return res.status(400).json({ error: 'Top level must be above base level' });
      }
    }

    const updateData = { ...topLevel };
    if (mergedParams) updateData.parameters = mergedParams;

    await updateElement(req.params.id, updateData);

    // Update layers if provided — uses before.type since element type doesn't change on PATCH
    if (layers && layers.length > 0) {
      if (before.type === 'wall') await setWallLayers(req.params.id, layers);
      else if (before.type === 'roof') await setRoofLayers(req.params.id, layers);
    }

    // Recalculate computed values after any change
    const updated = await recalcElement(req.params.id);
    const finalLayers = updated?.type === 'wall' ? await getWallLayers(req.params.id)
                       : updated?.type === 'roof' ? await getRoofLayers(req.params.id) : [];

    await appendEvent({ entity_type: 'element', entity_id: req.params.id, event_type: 'update', before_data: before, after_data: updated });
    const patched = { ...updated, layers: finalLayers };
    ws.broadcastElementUpdate(patched);
    res.json(patched);
  } catch (err) {
    console.error('[elements] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/elements/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getElementById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Element not found' });

    if (before.project_id && await isProjectDemo(before.project_id)) {
      return res.status(403).json({ error: 'Demo projects are read-only. Fork to create your own copy.' });
    }

    await annotationsDb.deleteAnnotationsByElement(req.params.id);
    await deleteElement(req.params.id);
    await appendEvent({ entity_type: 'element', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    ws.broadcastElementDeleted(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[elements] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/elements/:id/undo — restore to state before last event
router.post('/:id/undo', async (req, res) => {
  try {
    const { getLastEventForEntity } = require('../db/events');
    const event = await getLastEventForEntity('element', req.params.id);
    if (!event || !event.before_data) {
      return res.status(400).json({ error: 'Nothing to undo' });
    }
    const beforeData = typeof event.before_data === 'string' ? JSON.parse(event.before_data) : event.before_data;
    const restored = await updateElement(req.params.id, {
      type_name: beforeData.type_name,
      parameters: beforeData.parameters,
      base_level_id: beforeData.base_level_id,
      top_level_id: beforeData.top_level_id,
      computed: beforeData.computed
    });
    const updated = await recalcElement(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('[elements] POST /:id/undo', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
