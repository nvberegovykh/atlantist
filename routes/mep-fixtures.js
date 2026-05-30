/**
 * Owns: /api/mep-fixtures/* — placement, listing, and clearing of MEP
 *        stub elements (VAV boxes, diffusers, sprinkler heads, panels, etc.)
 *        stored as 'mep_fixture' elements in the elements table.
 * Does NOT own: MEP simulation runs (sims-mep.js), DAG recalc, Three.js rendering.
 */
const router = require('express').Router();
const { createElement, getAllElementsByProject, deleteElement } = require('../db/elements');
const { getMepFixtureTypes } = require('../db/templates');
const { appendEvent } = require('../db/events');
const ws = require('../services/ws-server');

// GET /api/mep-fixtures — list all MEP fixture elements in a project
router.get('/', async (req, res) => {
  try {
    const projectId = parseInt(req.query.project_id) || 1;
    const all = await getAllElementsByProject(projectId);
    const fixtures = all.filter(e => e.type === 'mep_fixture');
    res.json(fixtures);
  } catch (err) {
    console.error('[mep-fixtures] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep-fixtures/catalog — all available fixture types
router.get('/catalog', async (req, res) => {
  try {
    const types = await getMepFixtureTypes();
    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep-fixtures/place — place one or more MEP fixture elements
// Body: { fixture_type_id, position_x, position_z, level_id, quantity, project_id }
router.post('/place', async (req, res) => {
  try {
    const {
      fixture_type_id, position_x = 0, position_z = 0,
      level_id = null, quantity = 1, project_id = 1,
    } = req.body;

    if (!fixture_type_id) return res.status(400).json({ error: 'fixture_type_id required' });
    const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 50); // cap at 50 per request

    // Fetch fixture type definition
    const types = await getMepFixtureTypes();
    const fixDef = types.find(t => t.id === fixture_type_id);
    if (!fixDef) return res.status(404).json({ error: `Fixture type '${fixture_type_id}' not found` });

    // Build parameters from fixture definition
    const defaultParam = JSON.parse(fixDef.default_param || '{}');
    const parameters = {
      discipline: fixDef.discipline,
      category: fixDef.category,
      name: fixDef.name,
      default_width: fixDef.default_width,
      default_height: fixDef.default_height,
      default_depth: fixDef.default_depth,
      ...defaultParam,
    };

    // Place `qty` fixtures — spread them evenly in a grid for qty > 1
    const placed = [];
    for (let i = 0; i < qty; i++) {
      const offsetX = qty > 1 ? (i % 4) * 1.5 : 0;
      const offsetZ = qty > 1 ? Math.floor(i / 4) * 1.5 : 0;
      const el = await createElement({
        type: 'mep_fixture',
        type_name: fixDef.name,
        parameters: {
          ...parameters,
          fixture_type_id,
          position_x: position_x + offsetX,
          position_z: position_z + offsetZ,
        },
        base_level_id: level_id,
        top_level_id: null,
        computed: {
          placed_at: new Date().toISOString(),
          discipline: fixDef.discipline,
          category: fixDef.category,
          mark: `${fixDef.name.replace(/\//g, '-')}-${String(placed.length + 1).padStart(3, '0')}`,
        },
        project_id,
      });
      await appendEvent({
        entity_type: 'mep_fixture',
        entity_id: el.id,
        event_type: 'create',
        before_data: null,
        after_data: el,
      });
      ws.broadcastElementCreated(el);
      placed.push(el);
    }

    res.status(201).json({ placed, count: placed.length });
  } catch (err) {
    console.error('[mep-fixtures] POST /place', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mep-fixtures/clear — clear all MEP fixture elements in a project
router.delete('/clear', async (req, res) => {
  try {
    const projectId = parseInt(req.query.project_id) || 1;
    const all = await getAllElementsByProject(projectId);
    const fixtures = all.filter(e => e.type === 'mep_fixture');
    for (const fix of fixtures) {
      await deleteElement(fix.id);
      await appendEvent({
        entity_type: 'mep_fixture',
        entity_id: fix.id,
        event_type: 'delete',
        before_data: fix,
        after_data: null,
      });
      ws.broadcastElementDeleted(fix.id);
    }
    res.json({ cleared: fixtures.length });
  } catch (err) {
    console.error('[mep-fixtures] DELETE /clear', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;