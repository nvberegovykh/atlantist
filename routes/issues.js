/**
 * Owns: /api/issues CRUD, comment threads, snapshot storage, status transitions.
 * Does NOT own: element/level queries, DAG solver, WebSocket lifecycle.
 */
const router = require('express').Router();
const {
  getAllIssues, getIssueById, createIssue, updateIssueStatus,
  getIssueComments, addIssueComment, createSnapshot, deleteIssue
} = require('../db/issues');
const { appendEvent } = require('../db/events');
const ws = require('../services/ws-server');

// GET /api/issues?document_id=default
router.get('/', async (req, res) => {
  try {
    const issues = await getAllIssues(req.query.document_id || 'default');
    res.json(issues);
  } catch (err) {
    console.error('[issues] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/issues/:id
router.get('/:id', async (req, res) => {
  try {
    const issue = await getIssueById(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const comments = await getIssueComments(issue.id);
    res.json({ ...issue, comments });
  } catch (err) {
    console.error('[issues] GET /:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/issues — create issue + optional snapshot
router.post('/', async (req, res) => {
  try {
    const { title, body, priority, anchor_element_id, document_id, author_user_id,
            camera_position, view_mode, visible_layers, snapshot_png } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });

    const userId = author_user_id || req.headers['x-user-id'] || 'anonymous';

    const issue = await createIssue({
      document_id: document_id || 'default',
      author_user_id: userId,
      anchor_element_id,
      priority: priority || 'normal',
      title,
      body: body || ''
    });

    // Attach snapshot if viewport state provided
    let snapshot = null;
    if (camera_position) {
      snapshot = await createSnapshot({
        issue_id: issue.id,
        camera_position,
        view_mode: view_mode || '3d',
        visible_layers: visible_layers || [],
        snapshot_png: snapshot_png || null
      });
    }

    await appendEvent({
      entity_type: 'issue', entity_id: issue.id,
      event_type: 'create', before_data: null,
      after_data: { ...issue, snapshot },
      triggered_by: userId
    });

    const payload = { ...issue, snapshot, comments: [] };
    ws.broadcastIssueCreated(payload);
    res.status(201).json(payload);
  } catch (err) {
    console.error('[issues] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/issues/:id/status — resolve / reopen / wont-fix
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['open', 'resolved', 'wont_fix'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const before = await getIssueById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Issue not found' });

    const updated = await updateIssueStatus(req.params.id, status);

    await appendEvent({
      entity_type: 'issue', entity_id: req.params.id,
      event_type: 'status_change', before_data: { status: before.status },
      after_data: { status }, triggered_by: req.body.user_id || 'user'
    });

    ws.broadcastIssueStatusChanged({ id: updated.id, status: updated.status, resolved_at: updated.resolved_at });
    res.json(updated);
  } catch (err) {
    console.error('[issues] PATCH /:id/status', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/issues/:id/comments
router.get('/:id/comments', async (req, res) => {
  try {
    const comments = await getIssueComments(req.params.id);
    res.json(comments);
  } catch (err) {
    console.error('[issues] GET /:id/comments', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/issues/:id/comments
router.post('/:id/comments', async (req, res) => {
  try {
    const { body, author_user_id } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });

    const userId = author_user_id || req.headers['x-user-id'] || 'anonymous';
    const issue = await getIssueById(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const comment = await addIssueComment({ issue_id: req.params.id, author_user_id: userId, body });

    ws.broadcastIssueComment({ issue_id: req.params.id, comment });
    res.status(201).json(comment);
  } catch (err) {
    console.error('[issues] POST /:id/comments', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/issues/:id
router.delete('/:id', async (req, res) => {
  try {
    const issue = await getIssueById(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    await deleteIssue(req.params.id);
    ws.broadcastIssueDeleted(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[issues] DELETE /:id', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
