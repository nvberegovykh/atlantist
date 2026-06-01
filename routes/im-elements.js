/**
 * Owns: IM (Information Modeling) API endpoints — element types, instances, constraints.
 * Does NOT own: element geometry, DAG solver internals, event ledger.
 */
const router = require('express').Router();
const {
  createElementType, getElementTypeById, getElementTypesByProject,
  getTypeAncestry, getChildTypes, updateElementType, deleteElementType,
  upsertTypeProperty, getTypeProperties, getEffectiveProperties,
  createElementInstance, getElementInstanceByElementId, getInstancesByTypeId,
  getInstancesByProject, getConstraintsByProject,
  updateElementInstance, deleteElementInstance,
  setInstanceOverride, clearInstanceOverride,
  createConstraint, getConstraintsByElementId, updateConstraintBoundValue,
  deleteConstraint, setConstraintsForElement,
  propagateTypeChange,
} = require('../db/im-elements');
const { getIMEvents } = require('../db/events');
const { getElementById, createElement, updateElement } = require('../db/elements');

// Auth guard — skips auth for GET requests on demo projects
const DEMO_IDS = new Set(); // populated at startup (same set as server.js)
(async () => {
  try {
    const pool = require('../db/index');
    const res = await pool.query('SELECT id FROM projects WHERE is_demo = TRUE');
    for (const row of res.rows) DEMO_IDS.add(String(row.id));
  } catch (_) {}
})();

function requireAuth(req, res, next) {
  // Allow demo project reads without auth
  if (req.method === 'GET') {
    const pid = req.params.projectId || req.params.id || req.query.project_id;
    if (pid && DEMO_IDS.has(String(pid))) return next();
  }
  if (!req.user && !req.session) return res.status(401).json({ error: 'Authentication required' });
  next();
}
// Apply auth to all IM routes. All IM data is project-scoped and not public.
router.use(requireAuth);


// ── Project-scoped bulk-load endpoints ────────────────────────────────────────
// Called by IM panel on project init — falls through to SPA catch-all without these.

// GET /api/im/:projectId/data — bulk load all IM state for a project
router.get('/:projectId/data', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return res.status(400).json({ error: 'Invalid project_id' });
    const [types, instances, constraints] = await Promise.all([
      getElementTypesByProject(projectId),
      getInstancesByProject(projectId),
      getConstraintsByProject(projectId),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ types, instances, constraints });
  } catch (err) {
    console.error('[im] GET /:projectId/data', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/im/:projectId/events — replay event ledger for a project
router.get('/:projectId/events', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return res.status(400).json({ error: 'Invalid project_id' });
    const events = await getIMEvents(projectId);
    res.set('Cache-Control', 'no-store');
    res.json({ events });
  } catch (err) {
    console.error('[im] GET /:projectId/events', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Type endpoints ────────────────────────────────────────────────────────────

// GET /api/im/types?project_id=1&category=column
router.get('/types', async (req, res) => {
  try {
    const { project_id, category } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const types = await getElementTypesByProject(parseInt(project_id, 10), category || null);
    res.json({ types, count: types.length });
  } catch (err) {
    console.error('[im] GET /types', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/im/types/:id
router.get('/types/:id', async (req, res) => {
  try {
    const type = await getElementTypeById(parseInt(req.params.id, 10));
    if (!type) return res.status(404).json({ error: 'Type not found' });
    const ancestry = await getTypeAncestry(type.id);
    const children = await getChildTypes(type.id);
    res.json({ type, ancestry, children });
  } catch (err) {
    console.error('[im] GET /types/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/im/types — create element type
router.post('/types', async (req, res) => {
  try {
    const { project_id, parent_type_id, element_category, type_name, ...rest } = req.body;
    if (!project_id || !element_category || !type_name) {
      return res.status(400).json({ error: 'project_id, element_category, type_name required' });
    }
    const type = await createElementType({ project_id, parent_type_id, element_category, type_name, ...rest });
    res.status(201).json({ type });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Type already exists for this project/category/name' });
    console.error('[im] POST /types', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/im/types/:id — update element type (propagates to children)
router.put('/types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const type = await getElementTypeById(id);
    if (!type) return res.status(404).json({ error: 'Type not found' });
    const updated = await updateElementType(id, req.body);
    // Propagate changes to child types that don't override these keys
    const changedKeys = Object.keys(req.body).filter(k => !['id'].includes(k));
    if (changedKeys.length > 0) {
      await propagateTypeChange(id, changedKeys);
    }
    res.json({ type: updated });
  } catch (err) {
    console.error('[im] PUT /types/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/im/types/:id
router.delete('/types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deleteElementType(id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[im] DELETE /types/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Type property endpoints ──────────────────────────────────────────────────

// GET /api/im/types/:id/properties
router.get('/types/:id/properties', async (req, res) => {
  try {
    const typeId = parseInt(req.params.id, 10);
    const props = await getTypeProperties(typeId);
    const effective = await getEffectiveProperties(typeId);
    res.json({ properties: props, effective });
  } catch (err) {
    console.error('[im] GET /types/:id/properties', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/im/types/:id/properties/:propertyKey — set a type property
router.put('/types/:id/properties/:propertyKey', async (req, res) => {
  try {
    const typeId = parseInt(req.params.id, 10);
    const { property_key, property_value, override_flag = false, formula = null } = req.body;
    const prop = await upsertTypeProperty(typeId, property_key || req.params.propertyKey, property_value, override_flag, formula);
    res.json({ property: prop });
  } catch (err) {
    console.error('[im] PUT /types/:id/properties/:key', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Instance endpoints ───────────────────────────────────────────────────────

// GET /api/im/instances/:elementId
router.get('/instances/:elementId', async (req, res) => {
  try {
    const inst = await getElementInstanceByElementId(parseInt(req.params.elementId, 10));
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const effective = inst.type_id ? await getEffectiveProperties(inst.type_id) : {};
    res.json({ instance: inst, effective_properties: { ...effective, ...inst.override_values } });
  } catch (err) {
    console.error('[im] GET /instances/:elementId', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/im/instances — register an element as an IM instance
router.post('/instances', async (req, res) => {
  try {
    const { element_id, type_id, override_values = {}, status = 'design', ...rest } = req.body;
    if (!element_id) return res.status(400).json({ error: 'element_id required' });
    const existing = await getElementInstanceByElementId(element_id);
    if (existing) return res.status(409).json({ error: 'Instance already exists for this element' });
    const inst = await createElementInstance({ element_id, type_id, override_values, status, ...rest });
    res.status(201).json({ instance: inst });
  } catch (err) {
    console.error('[im] POST /instances', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/im/instances/:elementId
router.put('/instances/:elementId', async (req, res) => {
  try {
    const inst = await updateElementInstance(parseInt(req.params.elementId, 10), req.body);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    res.json({ instance: inst });
  } catch (err) {
    console.error('[im] PUT /instances/:elementId', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/im/instances/:elementId
router.delete('/instances/:elementId', async (req, res) => {
  try {
    await deleteElementInstance(parseInt(req.params.elementId, 10));
    res.json({ deleted: true });
  } catch (err) {
    console.error('[im] DELETE /instances/:elementId', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/im/instances/:elementId/overrides/:propertyKey — break type inheritance
router.put('/instances/:elementId/overrides/:propertyKey', async (req, res) => {
  try {
    const { value } = req.body;
    const inst = await setInstanceOverride(parseInt(req.params.elementId, 10), req.params.propertyKey, value);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    res.json({ instance: inst });
  } catch (err) {
    console.error('[im] PUT /instances/:elementId/overrides/:key', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/im/instances/:elementId/overrides/:propertyKey — restore type default
router.delete('/instances/:elementId/overrides/:propertyKey', async (req, res) => {
  try {
    const inst = await clearInstanceOverride(parseInt(req.params.elementId, 10), req.params.propertyKey);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    res.json({ instance: inst });
  } catch (err) {
    console.error('[im] DELETE /instances/:elementId/overrides/:key', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Constraint endpoints ────────────────────────────────────────────────────

// GET /api/im/constraints/:elementId
router.get('/constraints/:elementId', async (req, res) => {
  try {
    const constraints = await getConstraintsByElementId(parseInt(req.params.elementId, 10));
    res.json({ constraints });
  } catch (err) {
    console.error('[im] GET /constraints/:elementId', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/im/constraints
router.post('/constraints', async (req, res) => {
  try {
    const { element_id, constraint_key, constraint_category, formula_expression, bound_value, unit } = req.body;
    if (!element_id || !constraint_key || !formula_expression) {
      return res.status(400).json({ error: 'element_id, constraint_key, formula_expression required' });
    }
    const constraint = await createConstraint({ element_id, constraint_key, constraint_category, formula_expression, bound_value, unit });
    res.status(201).json({ constraint });
  } catch (err) {
    console.error('[im] POST /constraints', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/im/constraints/:elementId/:constraintKey — update bound value (called by DAG solver)
router.put('/constraints/:elementId/:constraintKey', async (req, res) => {
  try {
    const { bound_value, unit } = req.body;
    const constraint = await updateConstraintBoundValue(
      parseInt(req.params.elementId, 10), req.params.constraintKey, bound_value, unit
    );
    if (!constraint) return res.status(404).json({ error: 'Constraint not found' });
    res.json({ constraint });
  } catch (err) {
    console.error('[im] PUT /constraints/:elementId/:key', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/im/constraints/:elementId/:constraintKey
router.delete('/constraints/:elementId/:constraintKey', async (req, res) => {
  try {
    await deleteConstraint(parseInt(req.params.elementId, 10), req.params.constraintKey);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[im] DELETE /constraints/:elementId/:key', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/im/constraints/batch — create/update multiple constraints at once
router.post('/constraints/batch', async (req, res) => {
  try {
    const { constraints } = req.body;
    if (!Array.isArray(constraints)) return res.status(400).json({ error: 'constraints array required' });
    const results = [];
    for (const c of constraints) {
      const saved = await createConstraint(c);
      results.push(saved);
    }
    res.json({ constraints: results, count: results.length });
  } catch (err) {
    console.error('[im] POST /constraints/batch', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;