/**
 * Owns: /api/updates/* — What's New / changelog, update seen tracking.
 * Does NOT own: UI banner rendering, push notifications.
 */
const router = require('express').Router();
const { authMiddleware } = require('./auth');
const {
  getLatestUnseenForUser,
  getRecentUpdates,
  markUpdateSeen,
  createUpdate,
  listUpdates,
} = require('../db/updates');

// GET /api/updates/latest — for authenticated users: unseen updates + count
router.get('/latest', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.anonymous) {
      return res.json({ updates: [], unread_count: 0 });
    }
    const updates = await getLatestUnseenForUser(req.user.id, 5);
    res.json({ updates, unread_count: updates.length });
  } catch (err) {
    console.error('[updates] GET /latest', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/updates — all recent updates (public)
router.get('/', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const updates = await getRecentUpdates(parseInt(limit, 10));
    res.json({ updates });
  } catch (err) {
    console.error('[updates] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/updates/:id/seen — mark update as read
router.post('/:id/seen', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.anonymous) {
      return res.status(403).json({ error: 'Sign up to track read updates' });
    }
    await markUpdateSeen(parseInt(req.params.id), req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[updates] POST /:id/seen', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin ────────────────────────────────────────────────────────────────────

function adminOnly(req, res, next) {
  if (!req.user || req.user.app_role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// GET /api/updates/admin/list — paginated update list
router.get('/admin/list', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category, limit = 20, offset = 0 } = req.query;
    const updates = await listUpdates({ category, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
    res.json({ updates });
  } catch (err) {
    console.error('[updates] GET /admin/list', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/updates/admin — create a new update (What's New entry)
router.post('/admin', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { title, body, version, category = 'feature', badge, action_url, action_label } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });
    const update = await createUpdate({ title, body, version, category, badge, action_url, action_label });
    res.status(201).json({ update });
  } catch (err) {
    console.error('[updates] POST /admin', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;