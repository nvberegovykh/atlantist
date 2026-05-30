/**
 * Owns: /api/viewport-states — per-user per-project viewport continuity REST endpoints.
 * Does NOT own: project settings, BIM element data, WebSocket broadcasting.
 *
 * GET  /api/viewport-states/:projectId   — load saved state (within 24h)
 * PUT  /api/viewport-states/:projectId   — save state (upsert)
 * DELETE /api/viewport-states/:projectId — discard state ("start fresh")
 */
const router = require('express').Router();
const { upsertViewportState, getViewportState, deleteViewportState } = require('../db/viewport-states');
const { authMiddleware } = require('./auth');
const { isUserMember } = require('../db/projects');

router.use(authMiddleware);

// GET — fetch saved viewport state for this user + project
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    const isMember = await isUserMember(projectId, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a project member' });

    const row = await getViewportState(req.user.id, projectId);
    if (!row) return res.json({ state: null });

    res.json({ state: row.state_json, updated_at: row.updated_at });
  } catch (err) {
    console.error('[viewport-states] GET /:projectId', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT — save (upsert) viewport state
router.put('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    const isMember = await isUserMember(projectId, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a project member' });

    const stateJson = req.body;
    if (!stateJson || typeof stateJson !== 'object') {
      return res.status(400).json({ error: 'Body must be a viewport state object' });
    }

    await upsertViewportState(req.user.id, projectId, stateJson);
    res.json({ ok: true });
  } catch (err) {
    console.error('[viewport-states] PUT /:projectId', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE — discard saved state ("start fresh" chosen at handoff prompt)
router.delete('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    await deleteViewportState(req.user.id, projectId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[viewport-states] DELETE /:projectId', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
