/**
 * Owns: Attachment engine API — module project setup, attachment constraints,
 *       code compliance overlays, load path graph management.
 * Does NOT own: attachment engine logic (services/attachment-engine.js),
 *               code compliance logic (services/code-compliance.js),
 *               load path logic (services/load-path.js),
 *               DB access (db/attachments.js).
 */
const express = require('express');
const router = express.Router();
const attachmentDB = require('../db/attachments');
const attachmentEngine = require('../services/attachment-engine');
const codeCompliance = require('../services/code-compliance');
const loadPathService = require('../services/load-path');
const moduleSystem = require('../services/module-system');
const { appendEvent } = require('../db/events');

// ─── Module Project Setup ──────────────────────────────────────────────────────

// GET /api/attachments/module/:projectId
router.get('/module/:projectId', async (req, res) => {
  try {
    const mp = await attachmentDB.moduleProjects.getByProject(req.params.projectId);
    if (!mp) return res.json({ module_project: null });
    const derived = moduleSystem.getModuleDerived(mp.M_value, { name: mp.system_name, M_input: mp.M_value, label: mp.system_label });
    res.json({ module_project: mp, derived });
  } catch (err) {
    console.error('[attachments] module get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/attachments/module/:projectId
router.put('/module/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const existing = await attachmentDB.moduleProjects.getByProject(projectId);
    if (existing?.is_locked && existing.M_value !== req.body.M_value) {
      return res.status(409).json({
        error: 'Module is locked — unlock first to change M value',
        code: 'MODULE_LOCKED',
        locked_value: existing.M_value,
      });
    }
    const mp = await attachmentDB.moduleProjects.upsert({ project_id: projectId, ...req.body });
    const derived = moduleSystem.getModuleDerived(mp.M_value, { name: mp.system_name, M_input: mp.M_value, label: mp.system_label });
    res.json({ module_project: mp, derived });
  } catch (err) {
    console.error('[attachments] module upsert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/module/:projectId/lock
router.post('/module/:projectId/lock', async (req, res) => {
  try {
    const mp = await attachmentDB.moduleProjects.lock(req.params.projectId, true);
    if (!mp) return res.status(404).json({ error: 'module project not found' });
    res.json({ module_project: mp });
  } catch (err) {
    console.error('[attachments] lock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/module/:projectId/unlock
router.post('/module/:projectId/unlock', async (req, res) => {
  try {
    const { destructive } = req.body;
    if (destructive !== true) {
      return res.status(400).json({
        error: 'Unlock with destructive=true will allow M value changes that may invalidate placed elements. Confirm destructive=true to proceed.',
        code: 'DESTRUCTIVE_CONFIRM_REQUIRED',
      });
    }
    const mp = await attachmentDB.moduleProjects.lock(req.params.projectId, false);
    if (!mp) return res.status(404).json({ error: 'module project not found' });
    res.json({ module_project: mp });
  } catch (err) {
    console.error('[attachments] unlock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/module/:projectId/toggle-multiples
router.post('/module/:projectId/toggle-multiples', async (req, res) => {
  try {
    const { show_multiples } = req.body;
    const mp = await attachmentDB.moduleProjects.toggleMultiples(req.params.projectId, show_multiples);
    if (!mp) return res.status(404).json({ error: 'module project not found' });
    res.json({ module_project: mp });
  } catch (err) {
    console.error('[attachments] toggle multiples error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Connection Types ─────────────────────────────────────────────────────────

// GET /api/attachments/connection-types
router.get('/connection-types', async (req, res) => {
  try {
    const types = await attachmentDB.connectionTypes.list();
    res.json({ connection_types: types });
  } catch (err) {
    console.error('[attachments] connection types error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Attachment Constraints ───────────────────────────────────────────────────

// POST /api/attachments/constraints — create attachment constraint
router.post('/constraints', async (req, res) => {
  try {
    const { host_element_id, attached_element_id, project_id, attachment_type, connection_type_code, connection_metadata, host_face_u, host_face_v, host_face_z, offset_x, offset_y, offset_z, priority } = req.body;
    if (!host_element_id || !attached_element_id || !project_id) {
      return res.status(400).json({ error: 'host_element_id, attached_element_id, project_id required' });
    }
    if (!attachmentEngine.ATTACHMENT_TYPES.includes(attachment_type)) {
      return res.status(400).json({ error: `attachment_type must be one of: ${attachmentEngine.ATTACHMENT_TYPES.join(', ')}` });
    }

    // Cycle detection
    const existing = await attachmentDB.constraints.listByProject(project_id);
    const allConstraints = [...existing, { host_element_id, attached_element_id }];
    if (attachmentEngine.detectCycle(allConstraints)) {
      return res.status(409).json({ error: 'Circular dependency detected — element cannot attach to itself via attachment chain', code: 'CIRCULAR_DEPENDENCY' });
    }

    const constraint = await attachmentDB.constraints.create({
      host_element_id, attached_element_id, project_id, attachment_type,
      connection_type_code: connection_type_code || null,
      connection_metadata: connection_metadata || {},
      host_face_u, host_face_v, host_face_z,
      offset_x, offset_y, offset_z, priority,
    });

    await appendEvent({
      entity_type: 'attachment_constraint',
      entity_id: constraint.id,
      event_type: 'constraint_created',
      before_data: null,
      after_data: { host_element_id, attached_element_id, project_id, attachment_type, connection_type_code },
    });

    res.json({ constraint });
  } catch (err) {
    console.error('[attachments] constraint create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attachments/constraints/:projectId
router.get('/constraints/:projectId', async (req, res) => {
  try {
    const constraints = await attachmentDB.constraints.listByProject(req.params.projectId);
    res.json({ constraints });
  } catch (err) {
    console.error('[attachments] constraints list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attachments/constraints/by-host/:elementId
router.get('/constraints/by-host/:elementId', async (req, res) => {
  try {
    const constraints = await attachmentDB.constraints.getByHost(req.params.elementId);
    res.json({ constraints });
  } catch (err) {
    console.error('[attachments] getByHost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/attachments/constraints/:id/position
router.put('/constraints/:id/position', async (req, res) => {
  try {
    const { computed_x, computed_y, computed_z } = req.body;
    const constraint = await attachmentDB.constraints.updatePosition(req.params.id, { computed_x, computed_y, computed_z });
    if (!constraint) return res.status(404).json({ error: 'constraint not found' });

    // Propagate to downstream elements
    const allConstraints = await attachmentDB.constraints.listByProject(constraint.project_id);
    const mp = await attachmentDB.moduleProjects.getByProject(constraint.project_id);
    const M_mm = mp?.M_value || 1000;
    const updates = attachmentEngine.propagateHostMove(constraint.attached_element_id, { x: computed_x, y: computed_y, z: computed_z }, allConstraints, M_mm);

    res.json({ constraint, propagated_updates: updates });
  } catch (err) {
    console.error('[attachments] position update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/attachments/constraints/:id
router.delete('/constraints/:id', async (req, res) => {
  try {
    const constraint = await attachmentDB.constraints.getById(req.params.id);
    if (!constraint) return res.status(404).json({ error: 'constraint not found' });
    await attachmentDB.constraints.delete(req.params.id);
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error('[attachments] delete constraint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attachments/downstream/:elementId
router.get('/downstream/:elementId', async (req, res) => {
  try {
    const downstream = await attachmentDB.constraints.getDownstream(req.params.elementId);
    res.json({ downstream });
  } catch (err) {
    console.error('[attachments] downstream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Code Compliance Overlays ─────────────────────────────────────────────────

// POST /api/attachments/check/:projectId — run compliance check on all constraints
router.post('/check/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { element_ids } = req.body; // optional filter

    const constraints = await attachmentDB.constraints.listByProject(projectId);
    const moduleProject = await attachmentDB.moduleProjects.getByProject(projectId);
    if (!moduleProject) return res.status(400).json({ error: 'Project module not configured — set M value first' });

    const elements = await attachmentDB.elements.listByProject(projectId, element_ids);

    const results = [];

    for (const constraint of constraints) {
      const hostEl = elements.find(e => e.id === constraint.host_element_id);
      const attachedEl = elements.find(e => e.id === constraint.attached_element_id);
      if (!hostEl || !attachedEl) continue;

      const checks = codeCompliance.checkAttachment(constraint, hostEl, attachedEl, elements, moduleProject);

      for (const check of checks) {
        const overlay = await attachmentDB.overlays.upsert({
          project_id: projectId,
          constraint_id: constraint.id,
          element_id: attachedEl.id,
          verdict: check.verdict,
          category: check.category,
          issue_code: check.issue_code,
          message: check.message,
          code_reference: check.code_reference,
          fix_suggestion: check.fix_suggestion,
        });
        results.push(overlay);
      }
    }

    const stats = await attachmentDB.overlays.getStats(projectId);

    res.json({ overlays: results, stats });
  } catch (err) {
    console.error('[attachments] check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attachments/overlays/:projectId
router.get('/overlays/:projectId', async (req, res) => {
  try {
    const { verdict } = req.query;
    const overlays = await attachmentDB.overlays.listByProject(req.params.projectId, verdict || null);
    const stats = await attachmentDB.overlays.getStats(req.params.projectId);
    res.json({ overlays, stats });
  } catch (err) {
    console.error('[attachments] overlays error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/overlays/:id/resolve
router.post('/overlays/:id/resolve', async (req, res) => {
  try {
    const overlay = await attachmentDB.overlays.resolve(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'overlay not found' });
    res.json({ overlay });
  } catch (err) {
    console.error('[attachments] resolve overlay error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/overlays/:projectId/resolve-all
router.post('/overlays/:projectId/resolve-all', async (req, res) => {
  try {
    const count = await attachmentDB.overlays.resolveByProject(req.params.projectId);
    res.json({ resolved_count: count });
  } catch (err) {
    console.error('[attachments] resolve all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Load Path Graph ───────────────────────────────────────────────────────────

// POST /api/attachments/load-path/:projectId — compute and store load path
router.post('/load-path/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;

    const elements = await attachmentDB.elements.listStructuralByProject(projectId);

    const moduleProject = await attachmentDB.moduleProjects.getByProject(projectId);
    const M_mm = moduleProject?.M_value || 1000;

    // Build load path edges
    const edges = loadPathService.buildLoadPathEdges(elements);

    // Store edges
    for (const edge of edges) {
      await attachmentDB.loadPath.upsertEdge({
        project_id: projectId,
        element_id: edge.from_element_id,
        element_type: loadPathService.classifyElement(elements.find(e => e.id === edge.from_element_id)),
        from_element_id: edge.from_element_id,
        to_element_id: edge.to_element_id,
        load_magnitude_kn: edge.load_magnitude_kn,
        load_type: edge.load_type,
      });
    }

    // Detect missing support
    const missing = loadPathService.detectMissingSupport(elements, edges, M_mm);
    for (const { element } of missing) {
      await attachmentDB.loadPath.upsertEdge({
        project_id: projectId,
        element_id: element.id,
        element_type: loadPathService.classifyElement(element),
        has_missing_support: true,
        level_name: element.level_name,
      });
    }

    // Detect lateral system
    const lateralCheck = loadPathService.detectLateralSystem(elements, M_mm);
    for (const el of lateralCheck.lateralElements) {
      await attachmentDB.loadPath.upsertEdge({
        project_id: projectId,
        element_id: el.id,
        element_type: loadPathService.classifyElement(el),
        is_lateral: true,
        lateral_system_type: lateralCheck.lateralTypes[0] || null,
      });
    }

    const loadPathEdges = await attachmentDB.loadPath.listByProject(projectId);
    const missingElements = await attachmentDB.loadPath.getMissingSupport(projectId);
    const lateralElements = await attachmentDB.loadPath.getLateralElements(projectId);

    res.json({
      edges: loadPathEdges,
      missing_support: missingElements,
      lateral_system: lateralCheck,
      summary: {
        total_edges: edges.length,
        missing_support_count: missing.length,
        has_lateral: lateralCheck.hasLateral,
        lateral_system_types: lateralCheck.lateralTypes,
      },
    });
  } catch (err) {
    console.error('[attachments] load path error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attachments/load-path/:projectId
router.get('/load-path/:projectId', async (req, res) => {
  try {
    const loadPathEdges = await attachmentDB.loadPath.listByProject(req.params.projectId);
    const missingElements = await attachmentDB.loadPath.getMissingSupport(req.params.projectId);
    const lateralElements = await attachmentDB.loadPath.getLateralElements(req.params.projectId);
    res.json({ edges: loadPathEdges, missing_support: missingElements, lateral_elements: lateralElements });
  } catch (err) {
    console.error('[attachments] load path get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/attachments/load-path/:projectId/trace/:elementId
router.get('/load-path/:projectId/trace/:elementId', async (req, res) => {
  try {
    const { projectId, elementId } = req.params;
    const loadPathEdges = await attachmentDB.loadPath.listByProject(projectId);
    const elements = await attachmentDB.elements.getById(elementId);

    const path = loadPathService.traceLoadPath(elementId, elements, loadPathEdges);
    res.json({ trace: path });
  } catch (err) {
    console.error('[attachments] trace error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Snap Helpers ──────────────────────────────────────────────────────────────

// POST /api/attachments/snap — given target position and nearby anchors, return snap point
router.post('/snap', async (req, res) => {
  try {
    const { target_position_mm, anchor_positions_mm, M_mm = 1000, snap_mode = 'fine' } = req.body;
    if (!target_position_mm) return res.status(400).json({ error: 'target_position_mm required' });

    const anchors = anchor_positions_mm || [];
    const result = attachmentEngine.snapToOnCenter(target_position_mm, anchors, M_mm, snap_mode);
    res.json(result);
  } catch (err) {
    console.error('[attachments] snap error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/nearby — spatial index proximity query (octree)
// Returns elements within snap range of a target position
router.post('/nearby', async (req, res) => {
  try {
    const { project_id, position_mm, axis = 'x', range_mm } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    if (!position_mm) return res.status(400).json({ error: 'position_mm required' });

    // Get project module M
    const mp = await attachmentDB.moduleProjects.getByProject(project_id);
    const M_mm = mp?.M_value || 1000;
    const snapRange = range_mm || (M_mm / 8); // default to M/8 fine snap

    const elements = await attachmentDB.elements.listByProjectForSpatial(project_id);

    // Build octree
    const tree = attachmentEngine.buildOctree(elements);

    // Query
    const target = { x: position_mm, y: 0, z: 0 };
    if (axis === 'z') target.z = target.x;
    target.x = axis === 'x' ? position_mm : 0;
    target.y = axis === 'y' ? position_mm : 0;
    target.z = axis === 'z' ? position_mm : 0;

    const nearby = attachmentEngine.queryNearby(tree, target, snapRange);
    res.json({
      nearby: nearby.map(n => ({ id: n.id, type: n.element?.type, type_name: n.element?.type_name })),
      search_range_mm: snapRange,
      M_mm,
      snap_threshold_mm: M_mm / 8,
    });
  } catch (err) {
    console.error('[attachments] nearby error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attachments/validate-metadata — validate connection metadata requirements
router.post('/validate-metadata', async (req, res) => {
  try {
    const { connection_type_code, connection_metadata } = req.body;
    if (!connection_type_code) return res.status(400).json({ error: 'connection_type_code required' });

    const result = attachmentEngine.validateConnectionMetadata(connection_type_code, connection_metadata || {});
    res.json(result);
  } catch (err) {
    console.error('[attachments] validate metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;