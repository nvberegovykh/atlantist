/**
 * Embeddings API — Neural Processor endpoints
 *
 * POST /api/embeddings/element        Embed a single element
 * POST /api/embeddings/batch          Embed a batch of elements (async, returns job_id)
 * POST /api/embeddings/similar        Find similar elements by query params
 * GET  /api/embeddings/context/:pid   Wallt context block for project
 * GET  /api/embeddings/status         Check if embeddings are available (OPENAI_API_KEY set)
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const { authMiddleware } = require('./auth');

// Inline requireAuth — same pattern as routes/projects.js
function requireAuth(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
  });
}

let _emb; // lazy-load to avoid crash if OPENAI_API_KEY not set at boot
function getEmb() {
  if (!_emb) _emb = require('../lib/neural/embeddings');
  return _emb;
}

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const available = !!process.env.OPENAI_API_KEY;
  res.json({
    available,
    model:  available ? 'text-embedding-3-small' : null,
    dim:    available ? 1536 : null,
    reason: available ? null : 'OPENAI_API_KEY not configured',
  });
});

// ── Single element embed ──────────────────────────────────────────────────────
router.post('/element', requireAuth, async (req, res) => {
  try {
    const { projectId, elementId, category, source, element, force } = req.body;
    if (!elementId || !element) {
      return res.status(400).json({ error: 'elementId and element are required' });
    }

    // Verify user owns project
    if (projectId) {
      const proj = await db.query(
        `SELECT id FROM projects WHERE id = $1 AND owner_id = $2`,
        [projectId, req.user.id]
      );
      if (proj.rowCount === 0) return res.status(403).json({ error: 'Not your project' });
    }

    const result = await getEmb().embedElement({ projectId, elementId, category, source, element, force });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[embeddings] POST /element:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Batch embed ───────────────────────────────────────────────────────────────
// Fire-and-forget: returns immediately, processes in background
router.post('/batch', requireAuth, async (req, res) => {
  try {
    const { projectId, elements } = req.body;
    if (!Array.isArray(elements) || elements.length === 0) {
      return res.status(400).json({ error: 'elements[] required' });
    }
    if (elements.length > 500) {
      return res.status(400).json({ error: 'Max 500 elements per batch' });
    }

    // Verify ownership
    if (projectId) {
      const proj = await db.query(
        `SELECT id FROM projects WHERE id = $1 AND owner_id = $2`,
        [projectId, req.user.id]
      );
      if (proj.rowCount === 0) return res.status(403).json({ error: 'Not your project' });
    }

    // Accept immediately, process async
    const jobId = `emb_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    res.json({ ok: true, job_id: jobId, count: elements.length, status: 'processing' });

    // Background processing (non-blocking)
    setImmediate(async () => {
      try {
        const emb = getEmb();
        const enriched = elements.map(el => ({ ...el, projectId: el.projectId || projectId }));
        const result = await emb.embedBatch(enriched, { concurrency: 3 });
        console.log(`[embeddings] batch ${jobId} done:`, result);
      } catch (err) {
        console.error(`[embeddings] batch ${jobId} error:`, err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Similarity search ─────────────────────────────────────────────────────────
router.post('/similar', requireAuth, async (req, res) => {
  try {
    const { query, projectId, limit = 10, maxDistance = 0.5 } = req.body;
    if (!query) return res.status(400).json({ error: 'query element required' });

    const results = await getEmb().findSimilar(query, { projectId, limit, maxDistance });
    res.json({ ok: true, results, count: results.length });
  } catch (err) {
    console.error('[embeddings] POST /similar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Wallt project context ─────────────────────────────────────────────────────
router.get('/context/:projectId', requireAuth, async (req, res) => {
  try {
    const pid = parseInt(req.params.projectId, 10);
    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid project ID' });

    const context = await getEmb().buildProjectContext(pid);
    res.json({ ok: true, context });
  } catch (err) {
    console.error('[embeddings] GET /context:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
