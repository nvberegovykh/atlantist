/**
 * Owns: /api/grids CRUD endpoints for structural grids.
 * Does NOT own: element snapping, Three.js rendering, level queries.
 */
const router = require('express').Router();
const {
  getAllGrids, getGridById, createGrid, updateGrid, deleteGrid,
  getLinesByGrid, getAllLinesByProject, generateGridLines,
  snapToGridIntersection, gridIntersectionPosition,
} = require('../db/grids');
const { appendEvent } = require('../db/events');
const {
  broadcast, broadcastGridCreated, broadcastGridUpdated, broadcastGridDeleted,
} = require('../services/ws-server');

// GET /api/grids?project_id=1
router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    // db/grids.js handles UUID→int conversion internally
    const grids = await getAllGrids(projectId);
    // Attach lines to each grid
    const result = await Promise.all(grids.map(async (grid) => {
      const lines = await getLinesByGrid(grid.id);
      return { ...grid, lines };
    }));
    res.json(result);
  } catch (err) {
    console.error('[grids] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/grids/:id
router.get('/:id', async (req, res) => {
  try {
    const grid = await getGridById(req.params.id);
    if (!grid) return res.status(404).json({ error: 'Grid not found' });
    const lines = await getLinesByGrid(grid.id);
    res.json({ ...grid, lines });
  } catch (err) {
    console.error('[grids] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grids — create grid with optional auto-generated lines
// Body: { name, system_type, project_id, origin_x, origin_z, spacing_x, spacing_z,
//         x_labels: ['A','B','C','D','E'], z_labels: ['1','2','3','4','5'] }
router.post('/', async (req, res) => {
  try {
    const { x_labels, z_labels, ...gridData } = req.body;
    const grid = await createGrid(gridData);

    // Auto-generate lines if labels provided
    if (x_labels?.length || z_labels?.length) {
      const xs = x_labels || [];
      const zs = z_labels || [];
      await generateGridLines(grid.id, xs, zs);
    }

    const lines = await getLinesByGrid(grid.id);
    await appendEvent({ entity_type: 'grid', entity_id: grid.id, event_type: 'create', before_data: null, after_data: grid });
    broadcastGridCreated({ ...grid, lines });
    res.status(201).json({ ...grid, lines });
  } catch (err) {
    console.error('[grids] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/grids/:id
router.patch('/:id', async (req, res) => {
  try {
    const before = await getGridById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Grid not found' });

    const updated = await updateGrid(req.params.id, req.body);
    const lines = await getLinesByGrid(updated.id);

    await appendEvent({ entity_type: 'grid', entity_id: updated.id, event_type: 'update', before_data: before, after_data: updated });
    broadcastGridUpdated({ ...updated, lines });
    res.json({ ...updated, lines });
  } catch (err) {
    console.error('[grids] PATCH /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/grids/:id
router.delete('/:id', async (req, res) => {
  try {
    const before = await getGridById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Grid not found' });
    await deleteGrid(req.params.id);
    await appendEvent({ entity_type: 'grid', entity_id: req.params.id, event_type: 'delete', before_data: before, after_data: null });
    broadcastGridDeleted({ id: parseInt(req.params.id, 10) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[grids] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grids/:id/lines — add a single grid line
router.post('/:id/lines', async (req, res) => {
  try {
    const { createGridLine } = require('../db/grids');
    const line = await createGridLine({ grid_id: req.params.id, ...req.body });
    broadcast({ type: 'grid_line.created', data: line });
    res.status(201).json(line);
  } catch (err) {
    console.error('[grids] POST /:id/lines', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/grids/snap — snap a world point to nearest grid intersection
// Query: ?x=10.5&z=7.2&grid_id=1
router.get('/snap/:gridId', async (req, res) => {
  try {
    const { getLinesByGrid } = require('../db/grids');
    const grid = await getGridById(req.params.gridId);
    if (!grid) return res.status(404).json({ error: 'Grid not found' });

    const x = parseFloat(req.query.x || 0);
    const z = parseFloat(req.query.z || 0);
    const lines = await getLinesByGrid(grid.id);
    const xLines = lines.filter(l => l.axis === 'x');
    const zLines = lines.filter(l => l.axis === 'z');

    const snapped = snapToGridIntersection(x, z, xLines, zLines,
      parseFloat(grid.spacing_x), parseFloat(grid.spacing_z),
      parseFloat(grid.origin_x), parseFloat(grid.origin_z));

    res.json({ original: { x, z }, snapped });
  } catch (err) {
    console.error('[grids] GET /snap/:gridId', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;