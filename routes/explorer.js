/**
 * Atlantist Cloud OS Explorer — backend routes
 * /api/explorer/*
 *
 * Endpoints:
 *   GET  /api/explorer/recent       — last 20 items opened (projects + drive)
 *   GET  /api/explorer/shared       — projects where user is not owner
 *   GET  /api/explorer/templates    — starter project templates
 *   GET  /api/explorer/trash        — soft-deleted projects
 *   GET  /api/explorer/storage      — user storage quota summary
 *   GET  /api/explorer/versions/:id — version history for a project
 *   POST /api/projects/upload       — upload RVT/RFA/IFC/DWG → create project stub
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('./auth');
const { listProjectsForUser, createProject, getProjectById } = require('../db/projects');
const pool = require('../db/index');

// All explorer routes require auth — but resilient: if user not set, return empty
router.use(authMiddleware);

/* GET /api/explorer/recent */
// Returns last 20 projects opened by the user.
router.get('/recent', async (req, res) => {
  try {
    if (!req.user) return res.json({ items: [] });
    const userId = req.user.id;
    let rows = [];
    try {
      // Try with live_sessions subquery
      const result = await pool.query(
        `SELECT p.id, p.name, p.slug, p.project_type,
                COALESCE(p.storage_bytes, 0) as storage_bytes,
                p.created_at, p.updated_at, p.last_opened_at,
                pm.role as my_role,
                (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count,
                (SELECT COUNT(*) FROM live_sessions ls WHERE ls.project_id = p.id AND ls.last_ping > NOW() - INTERVAL '5 minutes') as live_session_count
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = $1
         ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC
         LIMIT 20`,
        [userId]
      );
      rows = result.rows;
    } catch {
      // Fallback without live_sessions (table may not exist yet)
      try {
        const result2 = await pool.query(
          `SELECT p.id, p.name, p.slug, p.project_type,
                  COALESCE(p.storage_bytes, 0) as storage_bytes,
                  p.created_at, p.updated_at, p.last_opened_at,
                  pm.role as my_role,
                  (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count,
                  0 as live_session_count
           FROM projects p
           JOIN project_members pm ON p.id = pm.project_id
           WHERE pm.user_id = $1
           ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC
           LIMIT 20`,
          [userId]
        );
        rows = result2.rows;
      } catch { rows = []; }
    }
    const items = rows.map(p => ({
      id: p.id,
      name: p.name || p.slug,
      type: 'proj',
      source: 'atlantist',
      size: p.storage_bytes || 0,
      modified: p.last_opened_at || p.updated_at || p.created_at,
      isLive: parseInt(p.live_session_count) > 0,
      members: parseInt(p.member_count) || 1,
      meta: p,
    }));
    res.json({ items });
  } catch (err) {
    console.error('[explorer/recent]', err);
    res.json({ items: [] }); // Resilient: empty instead of 500
  }
});

/* GET /api/explorer/shared */
router.get('/shared', async (req, res) => {
  try {
    if (!req.user) return res.json({ items: [] });
    const userId = req.user.id;
    let rows = [];
    try {
      const result = await pool.query(
        `SELECT p.id, p.name, p.slug, p.project_type,
                COALESCE(p.storage_bytes, 0) as storage_bytes,
                p.created_at, p.updated_at, p.last_opened_at,
                pm.role as my_role,
                (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = $1
           AND pm.role != 'owner'
         ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC`,
        [userId]
      );
      rows = result.rows;
    } catch { rows = []; }
    const items = rows.map(p => ({
      id: p.id,
      name: p.name || p.slug,
      type: 'proj',
      source: 'atlantist',
      size: p.storage_bytes || 0,
      modified: p.last_opened_at || p.updated_at || p.created_at,
      members: parseInt(p.member_count) || 1,
      meta: p,
    }));
    res.json({ items });
  } catch (err) {
    console.error('[explorer/shared]', err);
    res.json({ items: [] }); // Resilient: empty instead of 500
  }
});

/* GET /api/explorer/templates */
router.get('/templates', async (req, res) => {
  // Future: fetch from a templates table. For now return built-in starters.
  res.json({
    items: [
      { id: 'tpl-residential', name: 'Residential House',   type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Residential' } },
      { id: 'tpl-commercial',  name: 'Commercial Office',   type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Commercial'  } },
      { id: 'tpl-industrial',  name: 'Industrial Warehouse', type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Industrial'  } },
      { id: 'tpl-mixed-use',   name: 'Mixed-Use Building',  type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Mixed-Use'   } },
      { id: 'tpl-blank',       name: 'Blank Project',        type: 'proj', source: 'template', size: 0, modified: null, meta: { project_type: 'Custom'      } },
    ]
  });
});

/* GET /api/explorer/trash */
router.get('/trash', async (req, res) => {
  try {
    if (!req.user) return res.json({ items: [] });
    const userId = req.user.id;
    let rows = [];
    try {
      const result = await pool.query(
        `SELECT p.id, p.name, p.slug,
                COALESCE(p.storage_bytes, 0) as storage_bytes,
                p.updated_at, pm.role as my_role
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = $1
           AND p.deleted_at IS NOT NULL
         ORDER BY p.deleted_at DESC`,
        [userId]
      );
      rows = result.rows;
    } catch {
      // deleted_at column may not exist yet — return empty
    }
    const items = rows.map(p => ({
      id: p.id,
      name: p.name || p.slug,
      type: 'proj',
      source: 'atlantist',
      size: p.storage_bytes || 0,
      modified: p.updated_at,
      meta: p,
    }));
    res.json({ items });
  } catch (err) {
    console.error('[explorer/trash]', err);
    res.json({ items: [] }); // Resilient: empty instead of 500
  }
});

/* GET /api/explorer/storage */
router.get('/storage', async (req, res) => {
  const TOTAL = 10 * 1024 * 1024 * 1024; // 10 GB quota
  try {
    if (!req.user) return res.json({ used: 0, total: TOTAL, pct: 0 });
    const userId = req.user.id;
    let used = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(p.storage_bytes), 0) as used
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = $1 AND pm.role = 'owner'`,
        [userId]
      );
      used = parseInt(rows[0]?.used) || 0;
    } catch {
      // storage_bytes column may not exist — return zero usage
    }
    res.json({ used, total: TOTAL, pct: Math.round(used / TOTAL * 100) });
  } catch (err) {
    console.error('[explorer/storage]', err);
    res.json({ used: 0, total: TOTAL, pct: 0 }); // Resilient fallback
  }
});

/* GET /api/explorer/versions/:id */
router.get('/versions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const versions = [];

    // 1. RVT import runs for this project (upload history)
    try {
      const rvtRes = await pool.query(
        `SELECT id, status, source_filename, elements_total, elements_succeeded, started_at, completed_at
         FROM rvt_import_runs
         WHERE project_id = $1
         ORDER BY started_at DESC
         LIMIT 20`,
        [id]
      );
      for (const r of rvtRes.rows) {
        versions.push({
          id:       `rvt-${r.id}`,
          type:     'rvt_import',
          label:    r.source_filename || 'RVT Import',
          status:   r.status,
          elements: r.elements_succeeded || r.elements_total || null,
          created_at: r.started_at || r.completed_at,
        });
      }
    } catch { /* table may not exist */ }

    // 2. IFC export runs
    try {
      const ifcRes = await pool.query(
        `SELECT id, status, created_at FROM ifc_export_runs
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [id]
      );
      for (const r of ifcRes.rows) {
        versions.push({
          id:         `ifc-${r.id}`,
          type:       'ifc_export',
          label:      'IFC Export',
          status:     r.status,
          elements:   null,
          created_at: r.created_at,
        });
      }
    } catch { /* table may not exist */ }

    // 3. Project updated_at as a baseline "last edited" entry
    try {
      const projRes = await pool.query(
        `SELECT updated_at, created_at, name FROM projects WHERE id = $1`,
        [id]
      );
      if (projRes.rows.length > 0) {
        const p = projRes.rows[0];
        versions.push({
          id:         `proj-created-${id}`,
          type:       'created',
          label:      `Created — ${p.name}`,
          status:     'complete',
          elements:   null,
          created_at: p.created_at,
        });
      }
    } catch {}

    // Sort descending
    versions.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    res.json({ versions, projectId: id });
  } catch (err) {
    console.error('[explorer/versions]', err);
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/projects/upload */
// Creates a new project stub for an uploaded BIM file.
router.post('/upload-file', async (req, res) => {
  try {
    const userId  = req.user.id;
    const { fileName, fileSize, mimeType, driveFileId } = req.body;
    const ext = (fileName || '').split('.').pop().toLowerCase();

    const name = (fileName || 'Untitled').replace(/\.[^.]+$/, '');
    const newProject = await createProject({
      name,
      owner_id: userId,
      project_type: 'Custom',
    });

    res.json({ projectId: newProject.id, project: newProject });
  } catch (err) {
    console.error('[explorer/upload-file]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
