/**
 * Owns: .rvt file upload, import job creation, status polling, result retrieval.
 * Does NOT own: Model Derivative API calls, element mapping logic.
 *
 * POST /api/rvt-import          — upload .rvt file, kick off import job
 * GET  /api/rvt-import/:id      — get run status + summary
 * GET  /api/rvt-import/:id/results — element-by-element results
 * POST /api/rvt-import/:id/validate — run round-trip validation
 * GET  /api/rvt-import/projects/:pid — runs for a project
 */
const express = require('express');
const router = express.Router();
const rvtDb = require('../db/rvt-import');
const elementsDb = require('../db/elements');
const levelsDb = require('../db/levels');
const familiesDb = require('../db/families');
const rvtService = require('../services/rvt-import');

// Simple wrapper that exposes db fns used by rvtService
const db = {
  createElement: elementsDb.createElement,
  updateElement: elementsDb.updateElement,
  setWallLayers: elementsDb.setWallLayers,
  createFamilyInstance: familiesDb.createFamilyInstance,
  createLevel: levelsDb.createLevel,
  getElementById: elementsDb.getElementById,
  getFamilyInstanceById: familiesDb.getFamilyInstanceById,
};

// ─── Upload + kick off import ───────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { project_id, file_name, file_size_bytes, revit_version } = req.body;
    const forgeConfigured = !!(process.env.FORGE_CLIENT_ID && process.env.FORGE_CLIENT_SECRET);

    if (!project_id) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    // Create run record immediately
    const run = await rvtDb.createRun({
      project_id,
      file_name: file_name || 'unknown.rvt',
      file_size_bytes: file_size_bytes || null,
      revit_version: revit_version || null,
      status: 'pending'
    });

    // If Forge not configured, record the run as pending with info message
    if (!forgeConfigured) {
      await rvtDb.updateRun(run.id, {
        status: 'pending',
        error_log: 'FORGE_CLIENT_ID / FORGE_CLIENT_SECRET not configured. ' +
          'Import will run when Forge credentials are added to environment. ' +
          'See docs/rvt-import-compatibility.md for setup instructions.'
      });
      return res.status(202).json({
        run_id: run.id,
        status: 'pending',
        message: 'Forge credentials not configured — job queued, not started.'
      });
    }

    // Kick off async processing
    processImportAsync(run.id, req.body);
    res.status(202).json({ run_id: run.id, status: 'uploading' });
  } catch (err) {
    console.error('[rvt-import] POST /:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get run status ──────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const run = await rvtDb.getRunById(parseInt(req.params.id));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get element-by-element results ─────────────────────────────────────────

router.get('/:id/results', async (req, res) => {
  try {
    const runId = parseInt(req.params.id);
    const { category } = req.query;
    const results = category
      ? await rvtDb.getResultsByCategory(runId, category)
      : await rvtDb.getResultsByRun(runId);
    res.json({ run_id: runId, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Run summary (aggregated) ────────────────────────────────────────────────

router.get('/:id/summary', async (req, res) => {
  try {
    const runId = parseInt(req.params.id);
    const [run, summary] = await Promise.all([
      rvtDb.getRunById(runId),
      rvtDb.getRunSummary(runId)
    ]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ run, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Validate round-trip ────────────────────────────────────────────────────

router.post('/:id/validate', async (req, res) => {
  try {
    const runId = parseInt(req.params.id);
    const run = await rvtDb.getRunById(runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'completed') {
      return res.status(400).json({ error: `Run status is '${run.status}', must be 'completed' first.` });
    }
    const results = await rvtDb.getResultsByRun(runId);
    const importResults = { results };
    const validation = await rvtService.validateRoundTrip(importResults, db);
    res.json({ run_id: runId, validation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Runs by project ─────────────────────────────────────────────────────────

router.get('/projects/:pid', async (req, res) => {
  try {
    const runs = await rvtDb.getRunsByProject(parseInt(req.params.pid));
    res.json({ project_id: parseInt(req.params.pid), count: runs.length, runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Async processing (non-blocking) ────────────────────────────────────────

async function processImportAsync(runId, body) {
  const db = {
    createElement: elementsDb.createElement,
    updateElement: elementsDb.updateElement,
    setWallLayers: elementsDb.setWallLayers,
    createFamilyInstance: familiesDb.createFamilyInstance,
    createLevel: levelsDb.createLevel,
    getElementById: elementsDb.getElementById,
    getFamilyInstanceById: familiesDb.getFamilyInstanceById,
  };

  try {
    await rvtDb.touchRunStart(runId);
    await rvtDb.updateRun(runId, { status: 'uploading', progress_pct: 5 });

    // ossUrn comes from the POST body if the file was already uploaded to Forge OSS,
    // or we need to upload the file to Forge OSS first.
    // For this implementation, we expect the frontend to have already uploaded
    // the .rvt to Forge OSS and provide the resulting URN here.
    const ossUrn = body.oss_urn;
    if (!ossUrn) {
      throw new Error('oss_urn is required in request body. ' +
        'Upload the .rvt file to Forge OSS first and provide the resulting URN.');
    }

    await rvtDb.updateRun(runId, { status: 'converting', progress_pct: 20 });

    // Run the import
    const importResults = await rvtService.importRvtFile(
      { ossUrn, runId, projectId: body.project_id },
      db
    );

    await rvtDb.updateRun(runId, { status: 'mapping', progress_pct: 60 });

    // Batch-insert all element results
    await rvtDb.batchCreateResults(importResults.results);

    await rvtDb.updateRun(runId, {
      status: 'completed',
      progress_pct: 100,
      elements_total: importResults.totalElements,
      elements_succeeded: importResults.results.filter(r => r.import_status === 'success').length,
      elements_failed: importResults.results.filter(r => r.import_status === 'failed').length,
      wall_layers_created: importResults.results.filter(r => r.category === 'OST_Walls').length,
      family_instances_created: importResults.totalFamilyInstances
    });
    await rvtDb.touchRunComplete(runId);

  } catch (err) {
    console.error(`[rvt-import] run ${runId} failed:`, err);
    await rvtDb.setRunError(runId, err.message);
  }
}

module.exports = router;