/**
 * Owns: /api/energy endpoints — gbXML export, IDF generation, simulation run,
 *       compliance report (EN-001 through EN-008), simulation history, DOB submission package.
 * Does NOT own: Three.js rendering, DAG solver, element/level CRUD.
 */
const router = require('express').Router();
const { generateGbXML, generateIDF, runSimulation, generateCompliance } = require('../services/energy-sim');
const { generateYearData } = require('../services/energy-year');
const { generateDobPackage } = require('../services/energy-dob-package');
const { createSimulation, updateSimulation, getSimulationById, getAllSimulations, getLatestSimulation, saveEN1WorkbookData, getEN1WorkbookData } = require('../db/energy');
const { createDobPackage, getDobPackagesBySimulation, getLatestDobPackage } = require('../db/energy-dob');
const { getAllElements } = require('../db/elements');
const { getAllLevels } = require('../db/levels');
const { getAllFamilyInstances } = require('../db/families');
const { validateInputs, checkCompliance, getCodeReference, renderComplianceSummary, renderValidationIssues, renderDesignGuidance, DISCLAIMER } = require('../services/simulation-guardrails');

// Assemble model data from DB for the simulation engine
async function getModelData(projectName) {
  const [elements, levels, familyInstances] = await Promise.all([
    getAllElements(),
    getAllLevels(),
    getAllFamilyInstances(),
  ]);
  return { elements, levels, familyInstances, projectName: projectName || 'Atlantist Building' };
}

// POST /api/energy/run — full workflow: export + IDF + simulate + compliance
router.post('/run', async (req, res) => {
  try {
    const { projectName } = req.body;
    const model = await getModelData(projectName);

    // Create pending record
    const sim = await createSimulation({ model_snapshot: model, status: 'running' });

    // Generate gbXML
    const gbxml = generateGbXML(model);

    // Generate IDF
    const idf_text = generateIDF(model);

    // Run JS simulation engine (ASHRAE CLTD/CLF + degree-day method)
    const results = runSimulation(model);

    // Generate EN-001 through EN-008 compliance
    const compliance = generateCompliance(results);

    // Persist results
    const updated = await updateSimulation(sim.id, {
      gbxml,
      idf_text,
      results,
      compliance,
      status: 'complete',
    });

    res.json(updated);
  } catch (err) {
    console.error('[energy] Simulation error:', err.message);
    res.status(500).json({ error: 'Simulation failed: ' + err.message });
  }
});

// GET /api/energy/gbxml — export gbXML for current model (download)
router.get('/gbxml', async (req, res) => {
  try {
    const model = await getModelData(req.query.name);
    const xml = generateGbXML(model);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist_${Date.now()}.gbxml"`);
    res.send(xml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/idf — export .idf file for current model (download)
router.get('/idf', async (req, res) => {
  try {
    const model = await getModelData(req.query.name);
    const idf = generateIDF(model);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist_${Date.now()}.idf"`);
    res.send(idf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/en1 — retrieve saved EN-1 workbook data
router.get('/en1', async (_req, res) => {
  try {
    const data = await getEN1WorkbookData();
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/energy/en1 — save EN-1 workbook data
router.post('/en1', async (req, res) => {
  try {
    const en1Data = req.body;
    if (!en1Data || typeof en1Data !== 'object') {
      return res.status(400).json({ error: 'Invalid EN-1 data' });
    }
    const sim = await saveEN1WorkbookData(en1Data);
    res.json({ ok: true, simulation_id: sim.id });
  } catch (err) {
    console.error('[energy/en1] Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/simulations — list recent simulations
router.get('/simulations', async (_req, res) => {
  try {
    res.json(await getAllSimulations());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/simulations/latest — most recent completed simulation
router.get('/simulations/latest', async (_req, res) => {
  try {
    const sim = await getLatestSimulation();
    if (!sim) return res.status(404).json({ error: 'No simulations yet' });
    res.json(sim);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/simulations/:id — fetch specific simulation
router.get('/simulations/:id', async (req, res) => {
  try {
    const sim = await getSimulationById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'Not found' });
    res.json(sim);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/year-data — animated year visualization data
// Returns 8,760-hourly array, monthly/seasonal aggregates, dashboard summary, HVAC load curve
router.get('/year-data', async (req, res) => {
  try {
    const simId = req.query.simulation_id;
    let sim;
    if (simId) {
      sim = await getSimulationById(simId);
    } else {
      sim = await getLatestSimulation();
    }
    if (!sim) return res.status(404).json({ error: 'No simulation found. Run an energy simulation first.' });

    const results = typeof sim.results === 'string' ? JSON.parse(sim.results) : (sim.results || {});
    const modelSnapshot = typeof sim.model_snapshot === 'string'
      ? JSON.parse(sim.model_snapshot)
      : (sim.model_snapshot || {});

    const yearData = generateYearData(results, modelSnapshot);
    res.json({
      simulationId: sim.id,
      createdAt: sim.created_at,
      ...yearData,
    });
  } catch (err) {
    console.error('[energy/year-data] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/energy/dob-package — generate 9-PDF DOB submission zip for a simulation run
// Body: { simulation_id?, projectName?, address?, bin?, borough? }
router.post('/dob-package', async (req, res) => {
  try {
    const { simulation_id, projectName, address, bin, borough } = req.body || {};

    // Resolve simulation: explicit ID or latest completed
    let sim;
    if (simulation_id) {
      sim = await getSimulationById(simulation_id);
      if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    } else {
      sim = await getLatestSimulation();
      if (!sim) return res.status(404).json({ error: 'No simulation run yet. Run an energy simulation first.' });
    }

    if (sim.status !== 'complete') {
      return res.status(400).json({ error: 'Simulation is not complete. Re-run the energy simulation first.' });
    }

    const meta = { projectName, address, bin, borough };
    const { zipBuffer, zipName } = await generateDobPackage(sim, meta);

    // Persist record — no binary stored in DB, re-generated on each request
    await createDobPackage({
      simulation_id: sim.id,
      zip_name: zipName,
      zip_size_bytes: zipBuffer.length,
      project_name: projectName || '',
      address: address || '',
      bin: bin || '',
      borough: borough || '',
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    console.error('[energy/dob-package] Error:', err.message);
    res.status(500).json({ error: 'DOB package generation failed: ' + err.message });
  }
});

// GET /api/energy/dob-packages — list recent DOB package records
router.get('/dob-packages', async (req, res) => {
  try {
    const simId = req.query.simulation_id;
    let records;
    if (simId) {
      records = await getDobPackagesBySimulation(simId);
    } else {
      const latest = await getLatestDobPackage();
      records = latest ? [latest] : [];
    }
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/energy/simulate — create and run a new energy simulation
router.post('/simulate', async (req, res) => {
  try {
    const { project_id } = req.body || {};
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    const model = await getModelData(req.query.projectName);
    const sim = await createSimulation({
      model_snapshot: model,
      status: 'running'
    });

    // Run simulation asynchronously
    const gbxml = generateGbXML(model);
    const idf_text = generateIDF(model);
    const results = runSimulation(model);
    const compliance = generateCompliance(results);

    const updated = await updateSimulation(sim.id, {
      gbxml, idf_text, results, compliance, status: 'complete'
    });

    res.status(202).json({ simulation_id: updated.id, status: updated.status });
  } catch (err) {
    console.error('[energy] POST /simulate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/compliance-standards — return EN-1 through EN-8 standard definitions
router.get('/compliance-standards', async (_req, res) => {
  const standards = [
    { id: 'en1', name: 'EN-1: Overall Thermal Transfer', description: 'Building envelope U-values and UA calculations' },
    { id: 'en2', name: 'EN-2: Fenestration', description: 'Window SHGC, VT, and solar heat gain' },
    { id: 'en3', name: 'EN-3: Air Leakage', description: 'Building air leakage rate testing' },
    { id: 'en4', name: 'EN-4: Mechanical Systems', description: 'HVAC efficiency and controls' },
    { id: 'en5', name: 'EN-5: Lighting', description: 'Lighting power density and controls' },
    { id: 'en6', name: 'EN-6: Hot Water', description: 'Domestic hot water system efficiency' },
    { id: 'en7', name: 'EN-7: Power', description: 'Onsite renewable energy and power systems' },
    { id: 'en8', name: 'EN-8: Commissioning', description: 'Building commissioning requirements' },
  ];
  res.json(standards);
});

// GET /api/energy/simulations/:id/compliance — get compliance results for a simulation
router.get('/simulations/:id/compliance', async (req, res) => {
  try {
    const sim = await getSimulationById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });

    const compliance = typeof sim.compliance === 'string'
      ? JSON.parse(sim.compliance)
      : (sim.compliance || {});

    res.json(compliance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/simulations/:id/gbxml — download gbXML file
router.get('/simulations/:id/gbxml', async (req, res) => {
  try {
    const sim = await getSimulationById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });

    const gbxml = typeof sim.gbxml === 'string' ? sim.gbxml : (sim.gbxml || '');
    if (!gbxml) return res.status(404).json({ error: 'No gbXML for this simulation' });

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="energy_sim_${req.params.id}.gbxml"`);
    res.send(gbxml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/validate — pre-run input validation and code compliance check
// Returns issues grouped by severity, code references, and design guidance
router.get('/validate', async (req, res) => {
  try {
    const model = await getModelData(req.query.projectName);
    const results = runSimulation(model);
    const inputs = {
      wallUValue: results.avgWallUValue,
      roofUValue: results.roofUValue,
      windowUValue: results.windowUValue,
      windowSHGC: results.windowSHGC,
      wwr: results.wwr,
      lightingPowerDensity: results.lightingPowerDensity,
      infiltrationACH: results.infiltrationACH,
      eui_actual: results.eui,
      eui_target: results.eui_limit,
    };
    const validationIssues = validateInputs('energy', inputs);
    const compliance = checkCompliance('energy', inputs, model);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };
    const designGuidance = getDesignGuidance('energy', guidance);
    res.json({
      validationIssues,
      compliance,
      designGuidance,
      codeReferences: {
        wallUValue: getCodeReference('energy', 'wallUValue'),
        roofUValue: getCodeReference('energy', 'roofUValue'),
        windowUValue: getCodeReference('energy', 'windowUValue'),
        windowSHGC: getCodeReference('energy', 'windowSHGC'),
        wwr: getCodeReference('energy', 'wwr'),
        lightingPowerDensity: getCodeReference('energy', 'lightingPowerDensity'),
        infiltrationACH: getCodeReference('energy', 'infiltrationACH'),
      },
      disclaimer: DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/energy/compliance-summary — get compliance summary HTML for UI
router.get('/compliance-summary', async (req, res) => {
  try {
    const latest = await getLatestSimulation();
    if (!latest) return res.json({ html: '', hasResults: false });
    const results = typeof latest.results === 'string' ? JSON.parse(latest.results) : (latest.results || {});
    const inputs = {
      wallUValue: results.avgWallUValue,
      roofUValue: results.roofUValue,
      windowUValue: results.windowUValue,
      windowSHGC: results.windowSHGC,
      wwr: results.wwr,
      lightingPowerDensity: results.lightingPowerDensity,
      infiltrationACH: results.infiltrationACH,
      eui_actual: results.eui,
      eui_target: results.eui_limit,
    };
    const model = typeof latest.model_snapshot === 'string'
      ? JSON.parse(latest.model_snapshot)
      : (latest.model_snapshot || {});
    const compliance = checkCompliance('energy', inputs, model);
    const html = renderComplianceSummary(compliance, 'energy');
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };
    const designHtml = renderDesignGuidance(getDesignGuidance('energy', guidance));
    res.json({ html, designHtml, hasResults: true, compliance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
