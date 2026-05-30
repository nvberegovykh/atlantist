/**
 * Owns: /api/mep-elements CRUD endpoints — duct, pipe, cable_tray, RCP fixture management.
 * Does NOT own: MEP simulation (services/mep/), Three.js rendering, element/level CRUD.
 */
const router = require('express').Router();
const {
  getAllMEPElements, getMEPElementById, createMEPElement,
  updateMEPElement, deleteMEPElement, getMEPElementsByType,
} = require('../db/mep-elements');

// GET /api/mep-elements
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    const elements = await getAllMEPElements(projectId);
    res.json(elements);
  } catch (err) {
    console.error('[mep-elements] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep-elements/:id
router.get('/:id', async (req, res) => {
  try {
    const el = await getMEPElementById(req.params.id);
    if (!el) return res.status(404).json({ error: 'MEP element not found' });
    res.json(el);
  } catch (err) {
    console.error('[mep-elements] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep-elements/type/:type
router.get('/type/:type', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    const elements = await getMEPElementsByType(req.params.type, projectId);
    res.json(elements);
  } catch (err) {
    console.error('[mep-elements] GET /type/:type', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep-elements — create duct/pipe/cable_tray
router.post('/', async (req, res) => {
  try {
    const { type } = req.body;
    if (!['duct', 'pipe', 'cable_tray'].includes(type)) {
      return res.status(400).json({ error: 'type must be duct, pipe, or cable_tray' });
    }
    if (typeof req.body.start_x !== 'number' || typeof req.body.start_y !== 'number' ||
        typeof req.body.end_x !== 'number' || typeof req.body.end_y !== 'number') {
      return res.status(400).json({ error: 'start_x, start_y, end_x, end_y are required' });
    }

    const el = await createMEPElement(req.body);
    res.status(201).json(el);
  } catch (err) {
    console.error('[mep-elements] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/mep-elements/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getMEPElementById(req.params.id);
    if (!before) return res.status(404).json({ error: 'MEP element not found' });
    const updated = await updateMEPElement(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('[mep-elements] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mep-elements/:id
router.delete('/:id', async (req, res) => {
  try {
    const el = await getMEPElementById(req.params.id);
    if (!el) return res.status(404).json({ error: 'MEP element not found' });
    await deleteMEPElement(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[mep-elements] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep-elements/generate-hangers/:id — auto-generate hanger positions
router.post('/generate-hangers/:id', async (req, res) => {
  try {
    const el = await getMEPElementById(req.params.id);
    if (!el) return res.status(404).json({ error: 'MEP element not found' });

    // Generate hangers at 2.4m (8ft) intervals along the run
    const dx = el.end_x - el.start_x;
    const dy = el.end_y - el.start_y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.01) return res.status(400).json({ error: 'Zero-length element' });

    const interval = 2.4; // meters
    const count = Math.max(0, Math.floor(length / interval) - 1);
    const hangers = [];
    for (let i = 1; i <= count; i++) {
      const t = i * interval / length;
      if (t >= 1) break;
      hangers.push({ x: el.start_x + dx * t, y: el.start_y + dy * t });
    }

    const updated = await updateMEPElement(req.params.id, { hangers });
    res.json({ hangers, element: updated });
  } catch (err) {
    console.error('[mep-elements] POST /generate-hangers/:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;