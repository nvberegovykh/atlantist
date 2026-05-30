/**
 * Owns: /api/templates/* — template project listing and instantiation.
 * Does NOT own: element CRUD, project settings, BIM rendering.
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const {
  getTemplateProjects, getTemplateData, instantiateTemplate,
  getStairTypes, getRailingTypes, getBeamTypes, getFloorTypes,
  getCeilingTypes, getMepFixtureTypes,
} = require('../db/templates');
const { getWallTypes, getColumnTypes, getRoofTypes } = require('../db/elements');
const { getDoorTypes, getWindowTypes } = require('../db/families');

// GET /api/templates — list all published template projects
router.get('/', async (req, res) => {
  try {
    const templates = await getTemplateProjects();
    res.json(templates);
  } catch (err) {
    console.error('[templates] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/templates/:id/preview — preview template contents (for "Use Template" modal)
router.get('/:id/preview', async (req, res) => {
  try {
    const data = await getTemplateData(req.params.id);
    if (!data.project) return res.status(404).json({ error: 'Template not found' });
    res.json(data);
  } catch (err) {
    console.error('[templates] GET /:id/preview', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates/:id/instantiate — create a new user project from a template
router.post('/:id/instantiate', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const project = await instantiateTemplate(req.params.id, name.trim(), req.user.id);
    res.status(201).json(project);
  } catch (err) {
    console.error('[templates] POST /:id/instantiate', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/templates/catalogs/element-types — all type catalogs in one call
router.get('/catalogs/element-types', async (req, res) => {
  try {
    const [wall_types, column_types, roof_types, door_types, window_types,
           stair_types, railing_types, beam_types, floor_types,
           ceiling_types, mep_fixture_types] = await Promise.all([
      getWallTypes(), getColumnTypes(), getRoofTypes(),
      getDoorTypes(), getWindowTypes(),
      getStairTypes(), getRailingTypes(), getBeamTypes(), getFloorTypes(),
      getCeilingTypes(), getMepFixtureTypes(),
    ]);
    res.json({ wall_types, column_types, roof_types, door_types, window_types,
               stair_types, railing_types, beam_types, floor_types,
               ceiling_types, mep_fixture_types });
  } catch (err) {
    console.error('[templates] GET /catalogs/element-types', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;