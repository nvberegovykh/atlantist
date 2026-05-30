/**
 * Owns: /api/live-sessions/* — shareable collaborative BIM sessions.
 * Does NOT own: WebSocket channel management, WS broadcast frequency.
 * Session expiry cleanup is handled by the DB layer.
 */
const router = require('express').Router();
const { authMiddleware, optionalAuth } = require('./auth');
const { createSession, getSessionByToken, getSessionById, getParticipants, upsertParticipant, removeParticipant } = require('../db/live-sessions');
const { isUserMember } = require('../db/projects');

// POST /api/live-sessions — create a live session (requires auth)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { project_id, mode = 'view', ttl_hours = 24 } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    // Verify user has access to the project
    const isMember = await isUserMember(req.user.id, project_id);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this project' });

    if (mode !== 'view' && mode !== 'edit') {
      return res.status(400).json({ error: 'mode must be view or edit' });
    }
    if (ttl_hours !== 1 && ttl_hours !== 24 && ttl_hours !== 168) {
      return res.status(400).json({ error: 'ttl_hours must be 1, 24, or 168 (7d)' });
    }

    const session = await createSession({
      projectId: project_id,
      hostUserId: req.user.id,
      mode,
      ttlHours: ttl_hours,
    });

    res.status(201).json({
      id: session.id,
      project_id: session.project_id,
      share_token: session.share_token,
      mode: session.mode,
      expires_at: session.expires_at,
      share_url: `/live/${session.share_token}`,
    });
  } catch (err) {
    console.error('[live-sessions] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/live-sessions/:token — get session info (no auth required for token lookup)
router.get('/:token', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    const participants = await getParticipants(session.id);
    const canEdit = session.mode === 'edit' && req.user !== null;

    res.json({
      id: session.id,
      project_id: session.project_id,
      host_user_id: session.host_user_id,
      mode: session.mode,
      expires_at: session.expires_at,
      created_at: session.created_at,
      participants: participants.map(p => ({
        user_id: p.user_id,
        is_guest: p.is_guest,
        guest_handle: p.guest_handle,
        color: p.color,
        joined_at: p.joined_at,
      })),
      can_edit: canEdit,
      is_host: req.user && req.user.id === session.host_user_id,
    });
  } catch (err) {
    console.error('[live-sessions] GET /:token', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/live-sessions/:token/join — join a live session (auto-creates guest if not logged in)
router.get('/:token/join', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    let userId;
    let isGuest = false;
    let guestHandle = null;

    if (req.user) {
      userId = req.user.id;
    } else {
      // Anonymous guest — generate deterministic handle from session_uuid or random
      const uuid = req.cookies?.session_uuid || `anon_${Date.now().toString(36)}`;
      userId = uuid;
      isGuest = true;
      // Generate a memorable guest handle like "Guest 7B2A"
      const rand = uuid.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase() || Math.random().toString(36).slice(2, 6).toUpperCase();
      guestHandle = `Guest ${rand}`;
    }

    // Guests can only join view mode sessions
    if (isGuest && session.mode === 'edit') {
      return res.json({
        can_join: false,
        requires_login: true,
        message: 'Sign in to join this collaborative session',
      });
    }

    // Assign a color based on slot
    const colors = ['#4a90d9', '#e85d4a', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e74c3c', '#3498db'];
    const participants = await getParticipants(session.id);
    const color = colors[participants.length % colors.length];

    await upsertParticipant({
      sessionId: session.id,
      userId,
      isGuest,
      guestHandle,
      color,
    });

    res.json({
      session_id: session.id,
      project_id: session.project_id,
      mode: session.mode,
      user_id: userId,
      is_guest: isGuest,
      guest_handle: guestHandle,
      color,
      share_url: `/live/${session.share_token}`,
    });
  } catch (err) {
    console.error('[live-sessions] GET /:token/join', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/live-sessions/:token/leave — leave a live session
router.delete('/:token/leave', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    const userId = req.user?.id || req.cookies?.session_uuid || null;
    if (userId) {
      await removeParticipant(session.id, userId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[live-sessions] DELETE /:token/leave', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/live-sessions/:token/participants — get participants list
router.get('/:token/participants', async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    const participants = await getParticipants(session.id);
    res.json(participants.map(p => ({
      user_id: p.user_id,
      is_guest: p.is_guest,
      guest_handle: p.guest_handle,
      color: p.color,
      cursor_x: p.cursor_x,
      cursor_y: p.cursor_y,
      last_seen_at: p.last_seen_at,
    })));
  } catch (err) {
    console.error('[live-sessions] GET /:token/participants', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;