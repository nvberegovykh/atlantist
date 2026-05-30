/**
 * routes/node-editor.js — Node Editor graph save/load API
 * Owns: GET/POST /api/node-editor/graph endpoints
 * Does NOT own: DB access (delegated to db/node-editor.js), graph evaluation
 */
const express = require('express');
const router = express.Router();
const db = require('../db/node-editor');

router.get('/graph', async (req, res) => {
  const projectId = parseInt(req.query.project_id);
  if (!projectId || isNaN(projectId)) {
    return res.status(400).json({ error: 'project_id required' });
  }
  try {
    const graph = await db.getGraph(projectId);
    return res.json(graph);
  } catch (err) {
    console.error('[node-editor] GET error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/graph', async (req, res) => {
  const { project_id, nodes, connections } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id required' });
  try {
    await db.saveGraph(project_id, nodes, connections);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[node-editor] POST error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
