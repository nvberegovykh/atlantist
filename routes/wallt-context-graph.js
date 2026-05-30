/**
 * Owns: /api/wallt/context/* — Wallt Context Graph Node API.
 * Does NOT own: Wallt conversations, AI model calls, wallt_core_* memory tables.
 *
 * Node types:
 *   user_context    — current user's profile, preferences, active projects
 *   company_profile — ATLANTIST company state, roadmap, technical debt
 *   feature:{name}  — per-feature product knowledge (30+ feature nodes)
 *   revenue         — revenue metrics, MRR, churn
 *   active_work     — current sprint, in-flight work, blockers
 *   support_history — common issues, resolution patterns, escalation history
 *
 * Endpoints:
 *   POST   /api/wallt/context                — upsert node (create or replace)
 *   GET    /api/wallt/context/:node_type     — read single node
 *   PUT    /api/wallt/context/:id            — update node by id
 *   DELETE /api/wallt/context/:node_type     — delete node by type
 *   GET    /api/wallt/context                — list all nodes (with layered read flag)
 *   GET    /api/wallt/context/features       — list all feature nodes
 *   GET    /api/wallt/context/layered        — layered read: all nodes in precedence order
 */

const router = require('express').Router();
const { optionalAuth, requireAdmin } = require('./auth');
const wcg = require('../db/wallt-context-graph');

const VALID_NODE_TYPES = [
  'user_context',
  'company_profile',
  'feature:node-editor',
  'feature:crafting',
  'feature:wallt-voice',
  'feature:wallt-session',
  'feature:wallt-memory',
  'feature:wallt-moral-drift',
  'feature:wallt-auto-recovery',
  'feature:wallt-legal-registry',
  'feature:energy-analysis',
  'feature:structural-analysis',
  'feature:rvt-import',
  'feature:ifc-import',
  'feature:mep-simulation',
  'feature:fire-protection',
  'feature:geotechnical',
  'feature:design-book',
  'feature:schedules',
  'feature:annotations',
  'feature:grids',
  'feature:rooms',
  'feature:floors',
  'feature:ceilings',
  'feature:curved-surfaces',
  'feature:stairs',
  'feature:railings',
  'feature:store',
  'feature:matching',
  'feature:guides',
  'feature:rect-pricing',
  'feature:wallt',
  'revenue',
  'active_work',
  'support_history',
];

// POST /api/wallt/context — upsert a node by type
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { node_type, content, metadata_json = {} } = req.body;
    if (!node_type || !content) {
      return res.status(400).json({ error: 'node_type and content are required' });
    }
    if (!VALID_NODE_TYPES.includes(node_type)) {
      return res.status(400).json({
        error: `Invalid node_type. Allowed: ${VALID_NODE_TYPES.join(', ')}`,
      });
    }
    const node = await wcg.upsertNode(node_type, content, metadata_json);
    res.status(201).json({ node });
  } catch (err) {
    console.error('[wallt-context-graph] upsert error:', err.message);
    res.status(500).json({ error: 'Failed to save context node' });
  }
});

// GET /api/wallt/context — list all nodes (with ?layered=true for layered read)
router.get('/', optionalAuth, async (req, res) => {
  try {
    if (req.query.layered === 'true') {
      const layered = await wcg.layeredRead();
      return res.json({ nodes: layered, mode: 'layered', count: layered.length });
    }
    const nodes = await wcg.getAllNodes();
    res.json({ nodes, count: nodes.length });
  } catch (err) {
    console.error('[wallt-context-graph] list error:', err.message);
    res.status(500).json({ error: 'Failed to list context nodes' });
  }
});

// GET /api/wallt/context/features — list all feature nodes
router.get('/features', optionalAuth, async (req, res) => {
  try {
    const nodes = await wcg.getFeatureNodes();
    res.json({ nodes, count: nodes.length });
  } catch (err) {
    console.error('[wallt-context-graph] features error:', err.message);
    res.status(500).json({ error: 'Failed to list feature nodes' });
  }
});

// GET /api/wallt/context/layered — layered read: all nodes in precedence order
router.get('/layered', optionalAuth, async (req, res) => {
  try {
    const layered = await wcg.layeredRead();
    res.json({ nodes: layered, mode: 'layered', count: layered.length });
  } catch (err) {
    console.error('[wallt-context-graph] layered read error:', err.message);
    res.status(500).json({ error: 'Failed to load layered context' });
  }
});

// GET /api/wallt/context/:node_type — read single node by type
router.get('/:node_type', optionalAuth, async (req, res) => {
  try {
    const node = await wcg.getNode(req.params.node_type);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    res.json({ node });
  } catch (err) {
    console.error('[wallt-context-graph] get error:', err.message);
    res.status(500).json({ error: 'Failed to get context node' });
  }
});

// PUT /api/wallt/context/:id — update node by id
router.put('/:id', optionalAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { content, metadata_json } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const { rows } = await pool.query(
      `UPDATE wallt_context_graph
       SET content = COALESCE($1, content),
           metadata_json = COALESCE($2, metadata_json),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [content, metadata_json ? JSON.stringify(metadata_json) : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json({ node: rows[0] });
  } catch (err) {
    console.error('[wallt-context-graph] put error:', err.message);
    res.status(500).json({ error: 'Failed to update context node' });
  }
});

// DELETE /api/wallt/context/:node_type
router.delete('/:node_type', optionalAuth, async (req, res) => {
  try {
    const deleted = await wcg.deleteNode(req.params.node_type);
    if (!deleted) return res.status(404).json({ error: 'Node not found' });
    res.json({ deleted: true, node_type: req.params.node_type });
  } catch (err) {
    console.error('[wallt-context-graph] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete context node' });
  }
});

const pool = require('../db/index');

module.exports = router;