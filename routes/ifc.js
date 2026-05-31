/**
 * Owns: IFC import/export REST endpoints.
 * Does NOT own: IFC STEP parsing, geometry conversion, WebSocket.
 *
 * POST /api/ifc/import           — import .ifc file → create elements + levels
 * GET  /api/ifc/import/:id       — get import run status + stats
 * GET  /api/ifc/import/:id/results — element-by-element import results
 * GET  /api/ifc/import/projects/:pid — all import runs for a project
 *
 * POST /api/ifc/export           — export project to .ifc file
 * GET  /api/ifc/export/:id       — get export run status
 * GET  /api/ifc/export/:id/download — download the exported .ifc file
 * GET  /api/ifc/export/projects/:pid — all export runs for a project
 */
const express = require('express');
const router = express.Router();
const ifcDb = require('../db/ifc');
const elementsDb = require('../db/elements');
const levelsDb = require('../db/levels');
const familiesDb = require('../db/families');
const projectsDb = require('../db/projects');
const ifcService = require('../services/ifc-import-export');

// ─── Import ──────────────────────────────────────────────────────────────────

router.post('/import', async (req, res) => {
  try {
    const { project_id, file_content, file_name, file_size_bytes, schema } = req.body;

    if (!project_id) return res.status(400).json({ error: 'project_id is required' });
    if (!file_content) return res.status(400).json({ error: 'file_content is required (base64 or plain text)' });

    const run = await ifcDb.createImportRun({
      project_id,
      file_name: file_name || 'import.ifc',
      file_size_bytes: file_size_bytes || file_content.length,
      schema: schema || 'IFC2X3',
    });

    await ifcDb.updateImportRunStatus(run.id, 'processing', 10);

    // Parse IFC
    let ifcContent = file_content;
    // Support base64-encoded files
    try {
      const decoded = Buffer.from(file_content, 'base64').toString('utf8');
      if (decoded.includes('ISO-10303-21') || decoded.includes('IFC')) {
        ifcContent = decoded;
      }
    } catch {
      // Not base64, use as-is
    }

    await ifcDb.updateImportRunStatus(run.id, 'processing', 30);

    const parsed = ifcService.importIFC(ifcContent, { project_id });

    await ifcDb.updateImportRunStatus(run.id, 'processing', 60);

    // Write to DB
    const projectLevels = await levelsDb.getAllLevelsByProject(project_id);
    const projectElements = await elementsDb.getAllElementsByProject(project_id);

    // Create levels
    const atlantistLevels = {};
    for (const lvl of parsed.levels) {
      // Check for duplicate name
      const existing = projectLevels.find(p => p.name === lvl.name);
      if (existing) {
        atlantistLevels[lvl.name] = existing.id;
      } else {
        const created = await levelsDb.createLevel({ name: lvl.name, elevation: lvl.elevation, project_id });
        atlantistLevels[lvl.name] = created.id;
      }
    }

    // If no levels existed, create the ones from IFC
    if (Object.keys(atlantistLevels).length === 0) {
      const levelIds = await levelsDb.getAllLevelsByProject(project_id);
      if (levelIds.length > 0) {
        atlantistLevels[levelIds[0].name] = levelIds[0].id;
      }
    }

    await ifcDb.updateImportRunStatus(run.id, 'processing', 70);

    // Create elements
    let elementsCreated = 0;
    for (const el of parsed.elements) {
      // Determine base level (closest level below element Z)
      const baseLevelId = Object.values(atlantistLevels)[0] || null;

      await elementsDb.createElement({
        type: el.type,
        type_name: el.type_name,
        parameters: el.parameters,
        base_level_id: baseLevelId,
        top_level_id: baseLevelId,
        computed: el.computed,
        project_id,
        ifc_global_id: el.ifc_global_id,
        ifc_entity_id: el.ifc_entity_id,
        ifc_type: el.ifc_type,
      });
      elementsCreated++;
    }

    await ifcDb.updateImportRunStatus(run.id, 'processing', 85);

    // Create family instances (doors, windows)
    let fiCreated = 0;
    for (const fi of parsed.family_instances) {
      // Find a wall to host on (by proximity)
      const allElements = await elementsDb.getAllElementsByProject(project_id);
      const walls = allElements.filter(e => e.type === 'wall');

      let hostId = null;
      for (const wall of walls) {
        const wPos = wall.computed?.start || { x: 0, y: 0 };
        if (fi.position) {
          const dx = fi.position.x - wPos.x;
          const dy = fi.position.y - wPos.y;
          if (Math.sqrt(dx * dx + dy * dy) < 2) { hostId = wall.id; break; }
        }
      }

      if (hostId) {
        await familiesDb.createFamilyInstance({
          type: fi.type,
          family_type: fi.family_type,
          host_element_id: hostId,
          host_face_u: fi.host_face_u || 0.5,
          parameters: fi.parameters,
          project_id,
          ifc_global_id: fi.ifc_global_id,
          ifc_entity_id: fi.ifc_entity_id,
          ifc_type: fi.ifc_type,
        });
        fiCreated++;
      }
    }

    await ifcDb.updateImportRunStatus(run.id, 'processing', 95);

    await ifcDb.updateImportRunResult(run.id, {
      ...parsed.stats,
      elements: elementsCreated,
      levels: Object.keys(atlantistLevels).length,
      family_instances: fiCreated,
    }, parsed.stats);

    res.json({ run_id: run.id, status: 'completed', stats: parsed.stats,
               elements_created: elementsCreated, levels_created: Object.keys(atlantistLevels).length,
               family_instances_created: fiCreated });
  } catch (err) {
    console.error('[/api/ifc/import]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/import/:id', async (req, res) => {
  try {
    const run = await ifcDb.getImportRunById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Import run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/import/:id/results', async (req, res) => {
  try {
    const run = await ifcDb.getImportRunById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Import run not found' });
    res.json({ stats: run.stats_json, elements_created: run.elements_created,
               levels_created: run.levels_created, family_instances_created: run.family_instances_created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/import/projects/:pid', async (req, res) => {
  try {
    const runs = await ifcDb.getImportRunsByProject(req.params.pid);
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Export ──────────────────────────────────────────────────────────────────

router.post('/export', async (req, res) => {
  try {
    const { project_id, schema } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });

    const run = await ifcDb.createExportRun({
      project_id,
      schema: schema || 'IFC2X3',
      file_name: `atlantist-export-${Date.now()}.ifc`,
    });

    await ifcDb.updateExportRunStatus(run.id, 'processing');

    const project = await projectsDb.getProjectById(project_id);
    const levels = await levelsDb.getAllLevelsByProject(project_id);
    const elements = await elementsDb.getAllElementsByProject(project_id);
    const familyInstances = await familiesDb.getFamilyInstancesByProject(project_id);
    const curvedSurfaces = await require('../db/curved-surfaces').getAllCurvedSurfaces(project_id);

    const ifcContent = ifcService.exportIFC({
      levels,
      elements,
      family_instances: familyInstances,
      curvedSurfaces,
      projectName: project?.name || 'Atlantist BIM Export',
      schema: schema || 'IFC2X3',
    });

    // Write IFC content to /tmp for the download endpoint to serve.
    // Render uses ephemeral /tmp — file survives for the process lifetime.
    const fs = require('fs');
    const tmpPath = `/tmp/ifc-export-${run.id}.ifc`;
    fs.writeFileSync(tmpPath, ifcContent, 'utf8');

    // Store file_path in DB so download endpoint can find the file.
    await ifcDb.updateExportRunStatus(run.id, 'completed', tmpPath);

    // Schedule cleanup after 1h (Render process may restart anyway).
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch (_) {} }, 60 * 60 * 1000);

    res.json({
      run_id: run.id,
      status: 'completed',
      // Also return base64 for direct client-side download as fallback
      ifc_content: Buffer.from(ifcContent, 'utf8').toString('base64'),
      file_name: `atlantist-export-${run.id}.ifc`,
      stats: {
        elements: elements.length,
        levels: levels.length,
        family_instances: familyInstances.length,
        curved_surfaces: curvedSurfaces.length,
      },
    });
  } catch (err) {
    console.error('[/api/ifc/export]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/:id', async (req, res) => {
  try {
    const run = await ifcDb.getExportRunById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Export run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/:id/download', async (req, res) => {
  try {
    const run = await ifcDb.getExportRunById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Export run not found' });

    const fs = require('fs');
    const path = require('path');
    const filePath = run.file_path;

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found — re-run export to regenerate' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${run.file_name || 'export.ifc'}"`);
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/projects/:pid', async (req, res) => {
  try {
    const runs = await ifcDb.getExportRunsByProject(req.params.pid);
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;