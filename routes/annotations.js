/**
 * Owns: annotation CRUD endpoints, keynote table, hatching patterns.
 * Does NOT own: Three.js rendering, DAG recalculation.
 */
const router = require('express').Router();
const { getSessionByToken } = require('../db/auth');
const db = require('../db/annotations');
const ws = require('../services/ws-server');

// All routes require auth
async function auth(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const session = await getSessionByToken(token);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    req.userId = session.user_id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Annotations ──────────────────────────────────────────────────────────────

router.get('/', auth, async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const annotations = await db.getAnnotationsByProject(parseInt(projectId));
    res.json(annotations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { projectId, type, data, elementId, roomId, position2d, position3d, style } = req.body;
    if (!projectId || !type || !data) return res.status(400).json({ error: 'projectId, type, data required' });
    const VALID_TYPES = ['linear_dim','aligned_dim','elevation_dim','angular_dim','radius_dim','diameter_dim','area_tag','text','keynote','symbol','filled_region'];
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const annotation = await db.createAnnotation({
      projectId: parseInt(projectId),
      type, data, elementId: elementId ? parseInt(elementId) : null,
      roomId: roomId ? parseInt(roomId) : null,
      position2d, position3d, style, createdBy: req.userId,
    });
    ws.broadcastAnnotationCreated(annotation);
    res.status(201).json(annotation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', auth, async (req, res) => {
  try {
    const annotation = await db.updateAnnotation(parseInt(req.params.id), req.body);
    if (!annotation) return res.status(404).json({ error: 'Not found' });
    ws.broadcastAnnotationUpdated(annotation);
    res.json(annotation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await db.deleteAnnotation(parseInt(req.params.id));
    ws.broadcastAnnotationDeleted(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Keynote Table ────────────────────────────────────────────────────────────

router.get('/keynotes', auth, async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    res.json(await db.getKeynoteTable(parseInt(projectId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/keynotes', auth, async (req, res) => {
  try {
    const { projectId, code, description, category } = req.body;
    if (!projectId || !code || !description) return res.status(400).json({ error: 'projectId, code, description required' });
    res.status(201).json(await db.createKeynote({ projectId: parseInt(projectId), code, description, category }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/keynotes/:id', auth, async (req, res) => {
  try {
    const keynote = await db.updateKeynote(parseInt(req.params.id), req.body);
    if (!keynote) return res.status(404).json({ error: 'Not found' });
    res.json(keynote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/keynotes/:id', auth, async (req, res) => {
  try {
    await db.deleteKeynote(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Hatching Patterns ─────────────────────────────────────────────────────────

router.get('/hatching-patterns', async (_req, res) => {
  try {
    res.json(await db.getHatchingPatterns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;