/**
 * Owns: /api/forum/* endpoints — thread/reply CRUD, moderation, search.
 * Does NOT own: WebSocket broadcast (delegated to ws-server), AI agent.
 */
const router = require('express').Router();
const { authMiddleware, adminMiddleware } = require('./auth');
const { getUserRole } = require('../db/roles');
const { getUserById } = require('../db/users');
const {
  listThreads, getThreadById, createThread, updateThread,
  getRepliesByThread, createReply,
  logStatusChange, getStatusHistory,
  getModerationQueue, restoreContent
} = require('../db/forum');
const { runForumAgent, moderateContent } = require('../services/forum-agent');
const {
  broadcastForumThreadCreated,
  broadcastForumReplyCreated,
  broadcastForumStatusChanged,
} = require('../services/ws-server');

// ─── Shared middleware: require auth ──────────────────────────────────────────
function requireAuth(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Login required' });
    next();
  });
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.app_role !== 'admin') return res.status(403).json({ error: 'Admin required' });
    next();
  });
}

// ─── Thread list (GET /api/forum/threads) ─────────────────────────────────────
router.get('/threads', authMiddleware, async (req, res) => {
  try {
    const { category, status, page = '1', limit = '20', search } = req.query;
    const result = await listThreads({
      category: category || undefined,
      status: status || undefined,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50),
      search: search || undefined
    });
    res.json({ ...result, page: parseInt(page), limit: Math.min(parseInt(limit), 50) });
  } catch (err) {
    console.error('[forum] GET /threads', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single thread + replies (GET /api/forum/threads/:id) ───────────────────
router.get('/threads/:id', authMiddleware, async (req, res) => {
  try {
    const thread = await getThreadById(parseInt(req.params.id));
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const replies = await getRepliesByThread(parseInt(req.params.id));
    const statusHistory = await getStatusHistory(parseInt(req.params.id));
    res.json({ thread, replies, statusHistory });
  } catch (err) {
    console.error('[forum] GET /threads/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create thread (POST /api/forum/threads) ───────────────────────────────────
router.post('/threads', requireAuth, async (req, res) => {
  try {
    const { title, body, category } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title required' });

    // Moderation scan
    const modResult = moderateContent((title || '') + ' ' + (body || ''));
    if (!modResult.safe) {
      return res.status(422).json({
        error: 'Content flagged by auto-moderation',
        reason: modResult.reason
      });
    }

    const VALID_CATEGORIES = ['issues', 'features', 'updates', 'support', 'efficiency', 'general'];
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'general';

    // Check if user is team/admin
    const userRole = req.user.app_role || await getUserRole(req.user.id);
    const isTeam = userRole === 'admin';

    const thread = await createThread({
      title: title.trim(),
      body: body?.trim() || '',
      category: safeCategory,
      author_user_id: req.user.id,
      is_team_post: isTeam
    });

    // Log initial status
    await logStatusChange(thread.id, null, 'open', req.user.id, 'Thread created');

    broadcastForumThreadCreated(thread);

    res.status(201).json({ thread });
  } catch (err) {
    console.error('[forum] POST /threads', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Reply to thread (POST /api/forum/threads/:id/reply) ───────────────────────
router.post('/threads/:id/reply', requireAuth, async (req, res) => {
  try {
    const threadId = parseInt(req.params.id);
    const thread = await getThreadById(threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.locked) return res.status(403).json({ error: 'Thread is locked' });

    const { body, parent_id } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });

    // Moderation scan
    const modResult = moderateContent(body);
    if (!modResult.safe) {
      return res.status(422).json({
        error: 'Content flagged by auto-moderation',
        reason: modResult.reason
      });
    }

    // Check if user is team
    const userRole = req.user.app_role || await getUserRole(req.user.id);
    const isTeam = userRole === 'admin';

    const reply = await createReply({
      thread_id: threadId,
      parent_id: parent_id ? parseInt(parent_id) : null,
      body: body.trim(),
      author_user_id: req.user.id,
      is_team_post: isTeam
    });

    // AI agent bump (if this is human response to AI-escalated thread)
    if (thread.ai_escalated && thread.ai_response_count > 0) {
      await updateThread(threadId, { ai_escalated: false });
    }

    broadcastForumReplyCreated(reply);

    res.status(201).json({ reply });
  } catch (err) {
    console.error('[forum] POST /threads/:id/reply', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update thread status / admin actions (PATCH /api/forum/threads/:id) ────────
router.patch('/threads/:id', requireAuth, async (req, res) => {
  try {
    const threadId = parseInt(req.params.id);
    const thread = await getThreadById(threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { status, pinned, locked, note } = req.body;
    const userRole = req.user.app_role || await getUserRole(req.user.id);
    const isAdmin = userRole === 'admin';

    // Status change — admin or thread owner
    if (status && (isAdmin || req.user.id === thread.author_user_id)) {
      const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'wont_fix'];
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      await updateThread(threadId, { status });
      await logStatusChange(threadId, thread.status, status, req.user.id, note || null);
      broadcastForumStatusChanged(threadId, status);
    }

    // Admin-only actions
    if (isAdmin) {
      if (typeof pinned === 'boolean') await updateThread(threadId, { pinned });
      if (typeof locked === 'boolean') await updateThread(threadId, { locked });
    }

    const updated = await getThreadById(threadId);
    res.json({ thread: updated });
  } catch (err) {
    console.error('[forum] PATCH /threads/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Status history (GET /api/forum/threads/:id/status-history) ───────────────
router.get('/threads/:id/status-history', authMiddleware, async (req, res) => {
  try {
    const history = await getStatusHistory(parseInt(req.params.id));
    res.json({ history });
  } catch (err) {
    console.error('[forum] GET /status-history', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Moderation queue (GET /api/forum/moderation) ─────────────────────────────
router.get('/moderation', requireAdmin, async (req, res) => {
  try {
    const queue = await getModerationQueue();
    res.json(queue);
  } catch (err) {
    console.error('[forum] GET /moderation', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Restore hidden content (POST /api/forum/moderation/:id/restore) ───────────
router.post('/moderation/:id/restore', requireAdmin, async (req, res) => {
  try {
    const { is_thread } = req.body;
    await restoreContent(parseInt(req.params.id), !!is_thread);
    res.json({ success: true });
  } catch (err) {
    console.error('[forum] POST /restore', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Trigger AI agent manually (POST /api/forum/agent/run) ────────────────────
router.post('/agent/run', requireAdmin, async (req, res) => {
  try {
    const result = await runForumAgent();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[forum] POST /agent/run', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Categories list ──────────────────────────────────────────────────────────
router.get('/categories', authMiddleware, async (req, res) => {
  res.json([
    { id: 'issues',    emoji: '🐛', label: 'Issues',        desc: 'Bug reports, broken features' },
    { id: 'features',  emoji: '✨', label: 'Features',      desc: 'Feature requests, suggestions' },
    { id: 'updates',   emoji: '📢', label: 'Updates',        desc: 'Product updates, changelogs' },
    { id: 'support',   emoji: '💬', label: 'Support',       desc: 'Help, how-to, troubleshooting' },
    { id: 'efficiency',emoji: '⚡', label: 'Efficiency',    desc: 'Workflow tips, productivity tricks' },
    { id: 'general',   emoji: '🌍', label: 'General',       desc: 'Industry news, tool debates, design philosophy' },
  ]);
});

module.exports = router;