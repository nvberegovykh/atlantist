/**
 * Owns: Real-time overlay check API — fast drag-frame evaluation, batch overlays.
 * Does NOT own: overlay rendering (public/js/overlay-service.js),
 *               compliance engine (services/overlay-check.js).
 *
 * Two modes:
 *   POST /api/overlay-check/realtime — called every drag frame (lightweight, no DB writes)
 *   POST /api/overlay-check/batch    — called on placement (writes overlays to DB)
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const overlayEngine = require('../services/overlay-check');
const codeCompliance = require('../services/code-compliance');

// ─── POST /api/overlay-check/realtime ─────────────────────────────────────────
// Fast path — evaluated in memory from current element positions.
// Called on every requestAnimationFrame drag frame. No DB writes.
// Body: { elements, moduleProject, draggingId, includeGreen }
router.post('/realtime', async (req, res) => {
  try {
    const { elements, moduleProject, draggingId, includeGreen } = req.body;
    if (!elements || !Array.isArray(elements)) {
      return res.status(400).json({ error: 'elements array required' });
    }

    const overlays = overlayEngine.evaluateOverlays(elements, moduleProject || {}, {
      includeGreen: includeGreen !== false,
      includeAmber: true,
      draggingId,
    });

    // Stats for counters
    const stats = { RED: 0, AMBER: 0, GREEN: 0 };
    for (const ov of overlays) {
      stats[ov.verdict] = (stats[ov.verdict] || 0) + 1;
    }

    res.json({ overlays, stats, count: overlays.length });
  } catch (err) {
    console.error('[overlay-check] realtime error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/overlay-check/quick ─────────────────────────────────────────────
// Ultra-fast single-element check. For drag frames during element placement.
// Body: { element, hostElement, allElements, moduleProject }
router.post('/quick', async (req, res) => {
  try {
    const { element, hostElement, allElements, moduleProject } = req.body;
    if (!element) return res.status(400).json({ error: 'element required' });

    const results = overlayEngine.quickCheck(
      element,
      hostElement || null,
      allElements || [],
      moduleProject || {}
    );

    const verdict = overlayEngine.aggregateVerdict(results);
    const stats = { [verdict]: results.length };
    if (verdict === 'GREEN' && results.length === 0) {
      stats.GREEN = 1;
    }

    res.json({
      checks: results,
      verdict,
      stats,
      hasIssues: verdict !== 'GREEN',
    });
  } catch (err) {
    console.error('[overlay-check] quick error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/overlay-check/batch ─────────────────────────────────────────────
// Full batch evaluation + DB persist. Called when element placement is confirmed.
// Body: { projectId, moduleProject, elements }
router.post('/batch', async (req, res) => {
  try {
    const { projectId, moduleProject, elements } = req.body;
    if (!projectId || !elements) {
      return res.status(400).json({ error: 'projectId and elements required' });
    }

    const M_mm = moduleProject?.M_value || 1000;
    const is_nyc = moduleProject?.is_nyc || false;
    const { overlay } = require('../services/module-system').getModuleDerived(M_mm);

    const overlays = overlayEngine.evaluateOverlays(elements, moduleProject, {
      includeGreen: false,
      includeAmber: true,
    });

    // Persist to attachment_overlays
    const saved = [];
    for (const ov of overlays) {
      const row = await pool.query(`
        INSERT INTO attachment_overlays
          (project_id, element_id, verdict, category, issue_code, code_reference,
           message, fix_suggestion, overlay_type, overlay_data, is_resolved, resolved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,NULL)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        projectId,
        ov.element_id || null,
        ov.verdict,
        ov.category,
        ov.issue_code,
        ov.code_reference,
        ov.message,
        ov.fix_suggestion,
        ov.type,
        JSON.stringify({
          color: ov.color,
          opacity: ov.opacity,
          delta_mm: ov.delta_mm,
          target_mm: ov.target_mm,
          actual_mm: ov.actual_mm,
          auto_dismiss_ms: ov.auto_dismiss_ms,
        }),
      ]);
      if (row.rows[0]) saved.push(row.rows[0].id);
    }

    const stats = { RED: 0, AMBER: 0, GREEN: 0 };
    for (const ov of overlays) stats[ov.verdict] = (stats[ov.verdict] || 0) + 1;

    res.json({
      overlays,
      saved_count: saved.length,
      stats,
      project_id: projectId,
    });
  } catch (err) {
    console.error('[overlay-check] batch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/overlay-check/stats/:projectId ───────────────────────────────────
router.get('/stats/:projectId', async (req, res) => {
  try {
    const { verdict } = req.query;
    let sql = `SELECT verdict, count(*) as count FROM attachment_overlays WHERE project_id = $1 AND is_resolved = FALSE`;
    const params = [req.params.projectId];
    if (verdict) { sql += ` AND verdict = $2`; params.push(verdict); }
    sql += ` GROUP BY verdict`;

    const rows = await pool.query(sql, params);
    const stats = { RED: 0, AMBER: 0, GREEN: 0 };
    for (const r of rows.rows) stats[r.verdict] = parseInt(r.count);
    res.json(stats);
  } catch (err) {
    console.error('[overlay-check] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;