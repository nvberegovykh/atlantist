/**
 * Owns: /api/support/* — support tickets, comments, category triage.
 * Does NOT own: email notifications, external escalation integration.
 */
const router = require('express').Router();
const { createTicket, getTicketById, getTicketWithComments, listTickets, updateTicket, addComment, getTicketComments, getTicketCounts, closeResolvedTickets } = require('../db/support');
const { upsertLead } = require('../db/leads');
const { autoTriage } = require('../db/support-triage');
const { authMiddleware } = require('./auth');

const VALID_CATEGORIES = ['billing', 'technical', 'feature_request', 'other'];

// POST /api/support/tickets — Create new support ticket (public endpoint)
router.post('/tickets', async (req, res) => {
  try {
    const { email, subject, description, priority = 'normal', category = 'other', _auto = false } = req.body;
    if (!email || !subject || !description) {
      return res.status(400).json({ error: 'email, subject, and description required' });
    }

    // Smart triage: if no category specified (or _auto=true), run keyword triage
    let safeCategory;
    if (_auto || (!req.body.category && !req.body._user_category)) {
      const triage = await autoTriage(subject, description);
      safeCategory = triage.category;
    } else {
      safeCategory = VALID_CATEGORIES.includes(category) ? category : 'other';
    }

    // Auto-escalate billing to high priority; use triage priority as floor
    const triage = await autoTriage(subject, description);
    const priorityFloor = triage.priority === 'high' ? 'high' : priority;
    const effectivePriority = safeCategory === 'billing' ? 'high' : priorityFloor;

    const ticket = await createTicket({
      user_id: req.user?.id || null,
      email,
      subject,
      description,
      priority: effectivePriority,
      category: safeCategory
    });

    // Track lead from support request
    await upsertLead({ email, source: 'support' });

    res.status(201).json({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      triage_applied: _auto || (!req.body.category),
      triage_confidence: triage.confidence
    });
  } catch (err) {
    console.error('[support] POST /tickets', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support/tickets — List tickets (admin only for all, users see their own)
router.get('/tickets', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    const { status, priority, category, limit = 50, offset = 0 } = req.query;
    const tickets = await listTickets({
      status,
      priority,
      category,
      user_id: req.user.anonymous ? req.user.id : null,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
    res.json(tickets);
  } catch (err) {
    console.error('[support] GET /tickets', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support/tickets/stats — Get ticket statistics (admin only)
router.get('/tickets/stats', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    const counts = await getTicketCounts();
    const stats = {};
    counts.forEach(c => { stats[c.status] = parseInt(c.count, 10); });

    res.json({
      ...stats,
      total: Object.values(stats).reduce((a, b) => a + b, 0)
    });
  } catch (err) {
    console.error('[support] GET /tickets/stats', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support/tickets/:id — Get ticket with comments
router.get('/tickets/:id', async (req, res) => {
  try {
    const ticket = await getTicketWithComments(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    console.error('[support] GET /tickets/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/support/tickets/:id — Update ticket (admin only)
router.patch('/tickets/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    const { status, priority, assigned_to, resolution_notes, category } = req.body;
    const updateData = { status, priority, assigned_to, resolution_notes };
    if (category && VALID_CATEGORIES.includes(category)) updateData.category = category;

    const ticket = await updateTicket(req.params.id, updateData);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    console.error('[support] PATCH /tickets/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/tickets/:id/comments — Add comment to ticket
router.post('/tickets/:id/comments', async (req, res) => {
  try {
    const { author_name, content, is_internal = false } = req.body;
    if (!author_name || !content) return res.status(400).json({ error: 'author_name and content required' });

    const comment = await addComment(req.params.id, {
      user_id: req.user?.id || null,
      author_name,
      content,
      is_internal
    });
    res.status(201).json(comment);
  } catch (err) {
    console.error('[support] POST /tickets/:id/comments', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support/tickets/:id/comments — Get ticket comments
router.get('/tickets/:id/comments', async (req, res) => {
  try {
    const comments = await getTicketComments(req.params.id);
    res.json(comments);
  } catch (err) {
    console.error('[support] GET /tickets/:id/comments', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Support Triage Rules ────────────────────────────────────────────────────

// GET /api/support/triage/rules — list all rules
router.get('/triage/rules', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.app_role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rules = await require('../db/support-triage').listTriageRules();
    res.json({ rules });
  } catch (err) {
    console.error('[support] GET /triage/rules', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/triage/rules — create a rule
router.post('/triage/rules', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.app_role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { keywords, category, priority = 'normal', confidence = 80 } = req.body;
    if (!Array.isArray(keywords) || !keywords.length) {
      return res.status(400).json({ error: 'keywords must be a non-empty array' });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const rule = await require('../db/support-triage').addTriageRule({ keywords, category, priority, confidence });
    res.status(201).json({ rule });
  } catch (err) {
    console.error('[support] POST /triage/rules', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/support/triage/rules/:id — toggle enabled
router.patch('/triage/rules/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.app_role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { enabled } = req.body;
    const rule = await require('../db/support-triage').toggleRule(parseInt(req.params.id), enabled);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule });
  } catch (err) {
    console.error('[support] PATCH /triage/rules/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/support/triage/rules/:id
router.delete('/triage/rules/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.app_role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    await require('../db/support-triage').deleteRule(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error('[support] DELETE /triage/rules/:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;