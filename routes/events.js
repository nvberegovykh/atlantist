/**
 * Owns: /api/events/* — event ledger query and admin revert.
 * /api/models/:id/history — model-level version history (admins see all, owners see own).
 * /api/models/:id/revert — full model or per-element revert to prior event state.
 * Does NOT own: event creation (each domain module appends via db/events.js).
 */
const router = require('express').Router();
const { appendEvent, getEvents, getEventById, getEventStats, revertElementToBefore,
       getModelHistory, countEventsSince, revertModelToEvent, revertSingleElement } = require('../db/events');
const { authMiddleware, adminMiddleware } = require('./auth');
const { isUserMember, getUserRole, getProjectById } = require('../db/projects');

// ─── Helper: resolve user role from session ───────────────────────────────────
async function resolveUserRole(req) {
  const token = req.cookies?.session_token;
  if (!token) return { role: null, userId: null };
  const { getSessionByToken } = require('../db/auth');
  const session = await getSessionByToken(token);
  if (!session) return { role: null, userId: null };
  const { getUserRole } = require('../db/roles');
  const role = await getUserRole(session.user_id);
  return { role, userId: session.user_id };
}

// POST /api/events — append a new event to the ledger (used by group rotation, etc.)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { entity_type, entity_id, event_type, before_data, after_data } = req.body;
    if (!entity_type || !entity_id || !event_type) {
      return res.status(400).json({ error: 'entity_type, entity_id, and event_type are required' });
    }
    const token = req.cookies?.session_token;
    const { getSessionByToken } = require('../db/auth');
    const session = await getSessionByToken(token);
    const triggered_by = session ? String(session.user_id) : 'user';

    const event = await appendEvent({ entity_type, entity_id, event_type, before_data, after_data, triggered_by });
    res.status(201).json(event);
  } catch (err) {
    console.error('[events] POST', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Model-level history — GET /api/models/:id/history ─────────────────────────
// Admins see all models; non-admins see only owned/collaborated models.
router.get('/models/:id/history', authMiddleware, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid model id' });

    const { role, userId } = await resolveUserRole(req);
    if (!role) return res.status(401).json({ error: 'Not authenticated' });

    // Check access: admin can see any model; others must be a project member
    if (role !== 'admin') {
      const isMember = await isUserMember(projectId, userId);
      if (!isMember) return res.status(403).json({ error: 'Access denied' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const before = req.query.before || null;

    const result = await getModelHistory({ projectId, limit, before });

    // Add human-readable change summaries
    const enriched = result.events.map(e => ({
      ...e,
      summary: deriveChangeSummary(e),
      can_revert: role === 'admin'
    }));

    res.json({ events: enriched, has_more: result.has_more });
  } catch (err) {
    console.error('[events] GET /models/:id/history', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Revert diff preview — GET /api/models/:id/revert/diff?target_event_id ──────
router.get('/models/:id/revert/diff', authMiddleware, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid model id' });

    const { role, userId } = await resolveUserRole(req);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const targetEvent = await getEventById(req.query.target_event_id);
    if (!targetEvent) return res.status(404).json({ error: 'Event not found' });
    if (targetEvent.entity_type !== 'project' || targetEvent.entity_id !== String(projectId)) {
      return res.status(400).json({ error: 'Event does not belong to this model' });
    }

    const diff = await countEventsSince(projectId, targetEvent.created_at);
    res.json({
      undone_event_count: parseInt(diff.count),
      undone_user_count: parseInt(diff.user_count),
      target_event_id: targetEvent.id,
      target_event_type: targetEvent.event_type,
      target_created_at: targetEvent.created_at,
      since: targetEvent.created_at
    });
  } catch (err) {
    console.error('[events] GET /models/:id/revert/diff', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Full model revert — POST /api/models/:id/revert ────────────────────────────
router.post('/models/:id/revert', authMiddleware, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid model id' });

    const { role, userId } = await resolveUserRole(req);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { target_event_id, scope } = req.body;
    if (!target_event_id) return res.status(400).json({ error: 'target_event_id required' });

    let result;
    if (scope) {
      // Per-element revert
      result = await revertSingleElement({ elementId: scope, targetEventId: target_event_id, revertedBy: userId });
    } else {
      // Full model revert
      result = await revertModelToEvent({ projectId, targetEventId: target_event_id, revertedBy: userId });
    }

    // Broadcast to all connected clients via WebSocket
    try {
      const wsServer = require('../services/ws-server');
      wsServer.broadcast({
        type: 'model.snapshot.replaced',
        project_id: projectId,
        reason: 'model.reverted',
        reverted_to_event_id: target_event_id
      });
    } catch (_) { /* ws-server may not be available during tests */ }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[events] POST /models/:id/revert', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admins list — GET /api/models/:id/admins ──────────────────────────────────
router.get('/models/:id/admins', authMiddleware, async (req, res) => {
  try {
    const { role } = await resolveUserRole(req);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { getAllAdmins } = require('../db/roles');
    const admins = await getAllAdmins();
    res.json(admins);
  } catch (err) {
    console.error('[events] GET /models/:id/admins', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Promote to admin — POST /api/models/:id/admins/promote ────────────────────
router.post('/models/:id/admins/promote', authMiddleware, async (req, res) => {
  try {
    const { role, userId } = await resolveUserRole(req);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { user_id, email } = req.body;
    if (!user_id && !email) return res.status(400).json({ error: 'user_id or email required' });

    const { setUserRole } = require('../db/roles');
    const { upsertUser } = require('../db/users');

    let targetId = parseInt(user_id, 10);
    if (!targetId && email) {
      const user = await upsertUser({ email });
      targetId = user.id;
    }

    await setUserRole(targetId, 'admin');

    const { getAllAdmins } = require('../db/roles');
    const admins = await getAllAdmins();
    res.json({ success: true, admins });
  } catch (err) {
    console.error('[events] POST /models/:id/admins/promote', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Demote from admin — POST /api/models/:id/admins/demote ────────────────────
router.post('/models/:id/admins/demote', authMiddleware, async (req, res) => {
  try {
    const { role, userId } = await resolveUserRole(req);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const targetId = parseInt(user_id, 10);
    if (targetId === userId) return res.status(400).json({ error: 'Cannot demote yourself' });

    const { setUserRole } = require('../db/roles');
    await setUserRole(targetId, 'user');

    const { getAllAdmins } = require('../db/roles');
    const admins = await getAllAdmins();
    res.json({ success: true, admins });
  } catch (err) {
    console.error('[events] POST /models/:id/admins/demote', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Original event ledger routes ─────────────────────────────────────────────

// GET /api/events/sync — sync endpoint for offline replay (Phase 34)
// ?project_id=X&since=ISO_TIMESTAMP
// Returns all events for the project's entities that occurred after `since`.
// Used by ws-client.js when reconnecting after a network gap.
router.get('/sync', authMiddleware, async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });

    const since = req.query.since ? new Date(req.query.since) : null;
    const sinceIsValid = since && !isNaN(since.getTime());

    // Check project membership
    const { role, userId } = await resolveUserRole(req);
    if (!role) return res.status(401).json({ error: 'Not authenticated' });
    if (role !== 'admin') {
      const isMember = await isUserMember(parseInt(projectId, 10), userId);
      if (!isMember) return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch events for all entities belonging to this project, after `since`
    // We use the same project-scoped pattern as getModelHistory
    const pool = require('../db/index').pool;
    let sql = `
      WITH eligible_entity_ids AS (
        SELECT id FROM elements WHERE project_id = $1
        UNION SELECT id FROM levels WHERE project_id = $1
        UNION SELECT id::text FROM projects WHERE id = $1
      )
      SELECT el.id, el.entity_type, el.entity_id, el.event_type,
             el.before_data, el.after_data, el.triggered_by, el.created_at
      FROM event_ledger el
      WHERE el.entity_id IN (SELECT id FROM eligible_entity_ids)
        AND el.entity_type IN ('element', 'level', 'project')`;
    const params = [parseInt(projectId, 10)];
    if (sinceIsValid) {
      params.push(since.toISOString());
      sql += ` AND el.created_at > $${params.length}`;
    }
    sql += ` ORDER BY el.created_at ASC, el.lamport_clock ASC LIMIT 500`;

    const result = await pool.query(sql, params);
    res.json({ events: result.rows });
  } catch (err) {
    console.error('[events] GET /sync', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events — read event ledger
// ?limit=100&offset=0&entity_type=wall&entity_id=5
router.get('/', authMiddleware, async (req, res) => {
  try {
    const events = await getEvents({
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
      entity_type: req.query.entity_type,
      entity_id: req.query.entity_id
    });
    res.json(events);
  } catch (err) {
    console.error('[events] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/:id — read a single event
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const event = await getEventById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    console.error('[events] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:id/revert — admin revert an element to a prior event state
router.post('/:id/revert', authMiddleware, async (req, res) => {
  try {
    const role = req.headers['x-user-role'];
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const event = await getEventById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const updated = await revertElementToBefore(event);

    res.json({
      success: true,
      reverted_to_event_id: req.params.id,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      updated
    });
  } catch (err) {
    console.error('[events] POST /:id/revert', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/stats/summary — admin stats
router.get('/stats/summary', authMiddleware, async (req, res) => {
  try {
    const role = req.headers['x-user-role'];
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const stats = await getEventStats();
    res.json(stats);
  } catch (err) {
    console.error('[events] GET /stats/summary', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Change summary derivation ────────────────────────────────────────────────
function deriveChangeSummary(event) {
  const { event_type, entity_type, entity_id, before_data, after_data, triggered_by } = event;

  if (event_type === 'model.reverted') {
    const meta = after_data || {};
    return `Reverted model (${meta.undone_event_count || 0} changes undone)`;
  }
  if (event_type === 'element.reverted') {
    return `Reverted element ${entity_id} to prior state`;
  }
  if (event_type === 'revert') {
    return `Reverted ${entity_type} ${entity_id} to before state`;
  }
  if (event_type === 'created') {
    return `Added ${entity_type} ${entity_id}`;
  }
  if (event_type === 'deleted') {
    return `Deleted ${entity_type} ${entity_id}`;
  }
  if (event_type === 'updated' && before_data && after_data) {
    // Find changed fields
    const changed = [];
    for (const key of Object.keys(after_data)) {
      if (key === 'id' || key === 'updated_at' || key === 'created_at') continue;
      const beforeVal = before_data[key];
      const afterVal = after_data[key];
      if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
        changed.push(key);
      }
    }
    if (changed.length === 0) return `Updated ${entity_type} ${entity_id}`;
    if (changed.length === 1) {
      const v = after_data[changed[0]];
      const old = before_data[changed[0]];
      if (typeof v === 'number' && typeof old === 'number' && !isNaN(v) && !isNaN(old)) {
        return `Updated ${entity_type} ${entity_id}: ${changed[0]} ${old} → ${v}`;
      }
      return `Updated ${entity_type} ${entity_id}: ${changed[0]}`;
    }
    return `Updated ${entity_type} ${entity_id} (${changed.length} fields)`;
  }
  if (event_type === 'renamed') {
    const newName = after_data?.name || entity_id;
    return `Renamed model to "${newName}"`;
  }

  return event_type;
}

module.exports = router;