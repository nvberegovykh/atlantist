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
const pool = require('../db/pool');

// All explorer routes require auth
router.use(authMiddleware);

/* ── GET /api/explorer/recent ─────────────────────────────────────────────── */
// Returns last 20 projects opened by the user, plus recent Drive activity if available.
router.get('/recent', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.slug, p.project_type, p.storage_bytes,
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
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/explorer/shared ─────────────────────────────────────────────── */
router.get('/shared', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.slug, p.project_type, p.storage_bytes,
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
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/explorer/templates ─────────────────────────────────────────── */
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

/* ── GET /api/explorer/trash ──────────────────────────────────────────────── */
router.get('/trash', async (req, res) => {
  try {
    const userId = req.user.id;
    // Check if soft-delete column exists
    let rows = [];
    try {
      const result = await pool.query(
        `SELECT p.id, p.name, p.slug, p.storage_bytes, p.updated_at, pm.role as my_role
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = $1
           AND p.deleted_at IS NOT NULL
         ORDER BY p.deleted_at DESC`,
        [userId]
      );
      rows = result.rows;
    } catch {
      // deleted_at column doesn't exist yet — return empty
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
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/explorer/storage ───────────────────────────────────────────── */
router.get('/storage', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(p.storage_bytes), 0) as used
       FROM projects p
       JOIN project_members pm ON p.id = pm.project_id
       WHERE pm.user_id = $1 AND pm.role = 'owner'`,
      [userId]
    );
    const used = parseInt(rows[0]?.used) || 0;
    const total = 10 * 1024 * 1024 * 1024; // 10 GB beta quota
    res.json({ used, total, pct: Math.round(used / total * 100) });
  } catch (err) {
    console.error('[explorer/storage]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/explorer/versions/:id ──────────────────────────────────────── */
router.get('/versions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Check wallt_state_checkpoints for project snapshots
    let rows = [];
    try {
      const result = await pool.query(
        `SELECT id, checkpoint_type, label, wallt_version, created_at
         FROM wallt_state_checkpoints
         WHERE owner_user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.user.id]
      );
      rows = result.rows;
    } catch {
      // table may not exist in all envs
    }
    res.json({ versions: rows, projectId: id });
  } catch (err) {
    console.error('[explorer/versions]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/projects/upload ────────────────────────────────────────────── */
// Mounted separately at /api/projects/upload (see server.js registration note)
// Creates a new project stub for an uploaded BIM file.
// Actual heavy-lift (Forge/IFC parser) is async; responds with projectId immediately.
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
