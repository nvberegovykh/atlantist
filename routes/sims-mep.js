/**
 * Owns: /api/mep endpoints — HVAC, plumbing, and electrical simulation runs,
 *       MEP panel data, MEP calculation PDF export, MEP schedule data.
 * Does NOT own: Three.js rendering, DAG solver, element/level CRUD.
 */
const router = require('express').Router();
const { runHVAC, DISCLAIMER: HVAC_DISC } = require('../services/mep/hvac-runner');
const { runPlumbing, DISCLAIMER: PLUMB_DISC } = require('../services/mep/plumbing-runner');
const { runElectrical, DISCLAIMER: ELEC_DISC } = require('../services/mep/electrical-runner');
const { createMEPSimulation, updateMEPSimulation, getMEPSimulationById,
        getAllMEPSimulations, getLatestMEPSimulation, getLatestMEPSimulationForProject, getMEPHistory } = require('../db/mep-results');
const { populateFromMEPSimulation } = require('../db/design-book');
const { getAllElementsByProject } = require('../db/elements');
const { getAllLevelsByProject } = require('../db/levels');
const { getFamilyInstancesByProject } = require('../db/families');
const { getAllProjects, getProjectById } = require('../db/projects');
const { validateInputs, checkCompliance, getCodeReference, getDesignGuidance, renderComplianceSummary, renderDesignGuidance, DISCLAIMER } = require('../services/simulation-guardrails');

const DISCLAIMER_HTML = `⚠️ <strong>Atlantist MEP tools are professional design aids.</strong> Results are estimates only. All MEP designs must be reviewed by a licensed professional engineer (PE). Atlantist does not guarantee code compliance or regulatory approval. Responsibility for code compliance rests entirely with the user and their licensed PE.`;

async function getModelData(projectId) {
  const pid = projectId || 1;
  const [elements, levels, familyInstances] = await Promise.all([
    getAllElementsByProject(pid),
    getAllLevelsByProject(pid),
    getFamilyInstancesByProject(pid),
  ]);
  return { elements, levels, familyInstances };
}

// POST /api/mep/run — Run one or all MEP simulations
router.post('/run', async (req, res) => {
  try {
    const { disciplines = ['hvac', 'plumbing', 'electrical'],
            projectId = 1, projectName, disclaimerAccepted = false } = req.body;

    if (!disclaimerAccepted) {
      return res.status(400).json({ error: 'Disclaimer must be accepted before running MEP simulation.', disclaimer: DISCLAIMER_HTML });
    }

    const model = await getModelData(projectId);
    const results = {};
    const record = await createMEPSimulation({
      project_id: projectId,
      model_snapshot: model,
      discipline: disciplines[0],
      disclaimer_accepted: true,
      status: 'running',
    });

    for (const disc of disciplines) {
      let result;
      if (disc === 'hvac') result = runHVAC(model, req.body.hvacOptions || {});
      else if (disc === 'plumbing') result = runPlumbing(model, req.body.plumbingOptions || {});
      else if (disc === 'electrical') result = runElectrical(model, req.body.electricalOptions || {});
      results[disc] = result;
    }

    await updateMEPSimulation(record.id, {
      status: 'completed',
      hvac_results: results.hvac || {},
      plumbing_results: results.plumbing || {},
      electrical_results: results.electrical || {},
    });

    res.json({ id: record.id, projectId, disclaimer: DISCLAIMER_HTML, results });
  } catch (err) {
    console.error('[/api/mep/run]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/run-hvac — HVAC only
router.post('/run-hvac', async (req, res) => {
  try {
    const { projectId = 1, spaceType, infiltACH, disclaimerAccepted } = req.body;
    if (!disclaimerAccepted) return res.status(400).json({ error: 'Accept disclaimer first.', disclaimer: DISCLAIMER_HTML });
    const model = await getModelData(projectId);
    const result = runHVAC(model, { spaceType: spaceType || 'office', infiltACH: parseFloat(infiltACH) || 0.35 });
    const record = await createMEPSimulation({
      project_id: projectId,
      discipline: 'hvac',
      model_snapshot: model,
      hvac_results: result,
      disclaimer_accepted: true,
      status: 'completed',
    });
    res.json({ id: record.id, projectId, result, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/run-plumbing — Plumbing only
router.post('/run-plumbing', async (req, res) => {
  try {
    const { projectId = 1, occupancyType, material, disclaimerAccepted } = req.body;
    if (!disclaimerAccepted) return res.status(400).json({ error: 'Accept disclaimer first.', disclaimer: DISCLAIMER_HTML });
    const model = await getModelData(projectId);
    const result = runPlumbing(model, { occupancyType: occupancyType || 'office', material: material || 'copper' });
    const record = await createMEPSimulation({
      project_id: projectId,
      discipline: 'plumbing',
      model_snapshot: model,
      plumbing_results: result,
      disclaimer_accepted: true,
      status: 'completed',
    });
    res.json({ id: record.id, projectId, result, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/run-electrical — Electrical only
router.post('/run-electrical', async (req, res) => {
  try {
    const { projectId = 1, voltage, phase, ambientTempF, disclaimerAccepted } = req.body;
    if (!disclaimerAccepted) return res.status(400).json({ error: 'Accept disclaimer first.', disclaimer: DISCLAIMER_HTML });
    const model = await getModelData(projectId);
    const result = runElectrical(model, {
      voltage: parseInt(voltage) || 208,
      phase: phase || '3phase',
      ambientTempF: parseInt(ambientTempF) || 90,
    });
    const record = await createMEPSimulation({
      project_id: projectId,
      discipline: 'electrical',
      model_snapshot: model,
      electrical_results: result,
      disclaimer_accepted: true,
      status: 'completed',
    });
    res.json({ id: record.id, projectId, result, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/history — Simulation history (project-scoped)
router.get('/history', async (req, res) => {
  try {
    const { projectId, limit = 20 } = req.query;
    const history = await getMEPHistory(parseInt(limit) || 20, projectId ? parseInt(projectId) : null);
    res.json({ history, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/latest/:discipline — Get latest results for a discipline per project
router.get('/latest/:discipline', async (req, res) => {
  try {
    const projectId = req.query.projectId ? parseInt(req.query.projectId) : null;
    const latest = projectId
      ? await getLatestMEPSimulationForProject(req.params.discipline, projectId)
      : await getLatestMEPSimulation(req.params.discipline);
    res.json({ result: latest, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/:id — Get specific simulation by ID
router.get('/:id', async (req, res) => {
  try {
    const sim = await getMEPSimulationById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    res.json({ result: sim, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/epanet-download/:id — Download EPANET .inp file for a simulation run
router.get('/epanet-download/:id', async (req, res) => {
  try {
    const sim = await getMEPSimulationById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    const plumbing = sim.plumbing_results || {};
    const epanet = plumbing.epanet;
    if (!epanet || !epanet.content) return res.status(404).json({ error: 'No EPANET file in this simulation' });
    const fileName = epanet.fileName || 'atlantist_water_distribution.inp';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(epanet.content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/epanet-import — Parse uploaded EPANET .rpt results and store in DB
router.post('/epanet-import', async (req, res) => {
  try {
    const { runId, rptContent } = req.body;
    if (!rptContent || typeof rptContent !== 'string') {
      return res.status(400).json({ error: 'rptContent (raw text from EPANET .rpt file) is required' });
    }
    const parsed = parseEPANETRPT(rptContent);
    if (!runId) {
      return res.json({ parsed, warning: 'No runId — results not persisted. Pass runId to save to DB.' });
    }
    const sim = await getMEPSimulationById(parseInt(runId));
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    const existing = sim.plumbing_results || {};
    const updated = {
      ...existing,
      epanetResults: parsed,
      epanetResultsImportedAt: new Date().toISOString(),
    };
    await updateMEPSimulation(sim.id, { plumbing_results: updated });
    res.json({ success: true, runId: sim.id, parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Parse EPANET .rpt text output into structured results.
 * Handles EN-2 format (EPANET 2.x) and EN-1 format.
 */
function parseEPANETRPT(rptText) {
  const lines = rptText.split('\n');
  const result = {
    status: 'UNKNOWN',
    nodes: [],
    links: [],
    energy: {},
    errors: [],
    rawWarnings: [],
  };

  // Detect run status
  for (const line of lines) {
    if (/Status:\n|Status: .+|Network Status:/.test(line.trim())) {
      if (/error|failed|not converged/i.test(line)) result.status = 'ERROR';
      else if (/complete|ok|success/i.test(line)) result.status = 'COMPLETE';
    }
  }

  // Parse Energy section
  let inEnergy = false;
  for (const line of lines) {
    if (line.includes('Energy')) { inEnergy = true; continue; }
    if (inEnergy && line.includes('Link')) break;
    if (inEnergy && line.trim()) {
      const parts = line.trim().split(/\t| {2,}/).filter(Boolean);
      if (parts.length >= 5) {
        result.energy[parts[0]] = {
          avgFlow: parseFloat(parts[1]) || 0,
          peakUsage: parseFloat(parts[3]) || 0,
        };
      }
    }
  }

  // Parse Node results (Demand, Pressure, Quality)
  let inNodeTable = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/Node Results|Node Demand|Node Pressure/i.test(l)) { inNodeTable = true; continue; }
    if (l.startsWith('Link') || l.startsWith('Time')) { inNodeTable = false; }
    if (inNodeTable && /^[A-Z][A-Z0-9]*/.test(l)) {
      const parts = l.split(/\t| {2,}/).filter(Boolean);
      if (parts.length >= 3) {
        result.nodes.push({
          id: parts[0],
          demand: parseFloat(parts[1]) || 0,
          pressure: parseFloat(parts[2]) || 0,
          quality: parseFloat(parts[3]) || 0,
        });
      }
    }
  }

  // Parse Link results (Flow, Velocity, Headloss)
  let inLinkTable = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/Link Results|Link Flow/i.test(l)) { inLinkTable = true; continue; }
    if (l.startsWith('Time') || l.startsWith('===')) { inLinkTable = false; }
    if (inLinkTable && /^[A-Z][A-Z0-9]*/.test(l)) {
      const parts = l.split(/\t| {2,}/).filter(Boolean);
      if (parts.length >= 3) {
        result.links.push({
          id: parts[0],
          flow: parseFloat(parts[1]) || 0,
          velocity: parseFloat(parts[2]) || 0,
          headloss: parseFloat(parts[3]) || 0,
          status: parts[4] || 'OPEN',
        });
      }
    }
  }

  // Detect warnings
  for (const line of lines) {
    if (/WARNING|warning/i.test(line) && line.length < 300) {
      result.rawWarnings.push(line.trim());
    }
  }

  // Summary metrics
  if (result.links.length > 0) {
    const velocities = result.links.map(l => Math.abs(l.velocity));
    result.velocityStats = {
      max: Math.max(...velocities),
      avg: velocities.reduce((a, b) => a + b, 0) / velocities.length,
      exceeding8fps: result.links.filter(l => Math.abs(l.velocity) > 8).length,
    };
  }
  if (result.nodes.length > 0) {
    const pressures = result.nodes.map(n => n.pressure);
    result.pressureStats = {
      max: Math.max(...pressures),
      min: Math.min(...pressures),
      avg: pressures.reduce((a, b) => a + b, 0) / pressures.length,
    };
  }

  return result;
}

// GET /api/mep/schedule — Auto-populated MEP schedule from model elements
router.get('/schedule', async (req, res) => {
  try {
    const projectId = req.query.projectId ? parseInt(req.query.projectId) : 1;
    const model = await getModelData(projectId);
    const schedule = buildMEPSchedule(model);
    res.json({ schedule, projectId, disclaimer: DISCLAIMER_HTML });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildMEPSchedule(model) {
  const { elements, familyInstances } = model;
  const walls = elements.filter(e => e.type === 'wall');
  const columns = elements.filter(e => e.type === 'column');

  // Count ducts/registers from family instances ( MEP duct nodes)
  const ducts = familyInstances.filter(fi => fi.family_type === 'duct' || fi.family_type === 'register');
  const diffusers = familyInstances.filter(fi => fi.family_type === 'diffuser' || fi.family_type === 'grille');

  return {
    hvac: {
      totalWalls: walls.length,
      totalZones: Math.max(1, Math.ceil(walls.length / 4)),
      estimatedDuctRuns: Math.max(1, Math.ceil((ducts.length || 4) * 2)),
      supplyDiffusers: diffusers.length || Math.max(1, Math.ceil(walls.length / 2)),
      returnGrilles: Math.max(1, Math.ceil((diffusers.length || walls.length / 2) / 2)),
    },
    plumbing: {
      totalWalls: walls.length,
      estimatedFixtures: familyInstances.filter(fi =>
        ['water-closet', 'lavatory', 'kitchen-sink', 'bathtub', 'shower'].includes(fi.family_type)
      ).length || Math.max(2, Math.ceil(walls.length / 3)),
      estimatedPipeRuns: Math.max(1, Math.ceil(walls.length / 2)),
    },
    electrical: {
      totalWalls: walls.length,
      estimatedCircuits: Math.max(4, Math.ceil(walls.length / 2)),
      estimatedOutlets: Math.max(8, walls.length * 2),
      estimatedSwitches: Math.max(4, walls.length),
    },
    generatedAt: new Date().toISOString(),
  };
}

// GET /api/mep/codes — Reference standards list
router.get('/codes/reference', (_req, res) => {
  res.json({
    codes: [
      { name: 'ASHRAE 90.1', edition: '2019', description: 'Energy Efficiency in Buildings', applicability: 'HVAC' },
      { name: 'ASHRAE 62.1', edition: '2019', description: 'Ventilation for Acceptable Indoor Air Quality', applicability: 'HVAC' },
      { name: 'ASHRAE 55', edition: '2017', description: 'Thermal Environmental Conditions for Human Occupancy', applicability: 'HVAC' },
      { name: 'IMC', edition: '2021', description: 'International Mechanical Code', applicability: 'HVAC' },
      { name: 'Manual J', edition: '8th', description: 'Residential Load Calculation', applicability: 'HVAC' },
      { name: 'IPC', edition: '2021', description: 'International Plumbing Code', applicability: 'Plumbing' },
      { name: 'NYC PC', edition: '2020', description: 'NYC Plumbing Code', applicability: 'Plumbing' },
      { name: 'NFPA 13', edition: '2019', description: 'Standard for Installation of Sprinkler Systems', applicability: 'Plumbing/Fire' },
      { name: 'NEC', edition: '2023', description: 'National Electrical Code', applicability: 'Electrical' },
      { name: 'NFPA 70', edition: '2023', description: 'National Electrical Code (same as NEC)', applicability: 'Electrical' },
    ],
    disclaimer: DISCLAIMER_HTML,
  });
});

// GET /api/mep/validate — pre-run validation and code compliance for MEP discipline
router.get('/validate', async (req, res) => {
  try {
    const { discipline = 'hvac', projectId, ductVelocity, pipeVelocity, conduitFill, circuitAmpacity, voltageDrop, panelLoad } = req.query;
    const pid = projectId ? parseInt(projectId) : 1;
    const model = await getModelData(pid);

    let simType, inputs;
    if (discipline === 'hvac') {
      simType = 'mep_hvac';
      inputs = {
        ductVelocity: ductVelocity ? parseFloat(ductVelocity) : undefined,
        coolingAirflow: 500,
        supplyAirTemp: 55,
        heatingCapacity: 500000,
        coolingCapacity: 500000,
      };
    } else if (discipline === 'plumbing') {
      simType = 'mep_plumbing';
      inputs = {
        pipeVelocity: pipeVelocity ? parseFloat(pipeVelocity) : undefined,
        minPipeSize: 0.5,
        fixtureUnitTotal: 50,
        sprinklerSpacing: 130,
      };
    } else if (discipline === 'electrical') {
      simType = 'mep_electrical';
      inputs = {
        conduitFill: conduitFill ? parseFloat(conduitFill) : undefined,
        circuitAmpacity: circuitAmpacity ? parseFloat(circuitAmpacity) : undefined,
        voltageDrop: voltageDrop ? parseFloat(voltageDrop) : undefined,
        panelLoad: panelLoad ? parseFloat(panelLoad) : undefined,
      };
    }

    const validationIssues = validateInputs(simType, inputs);
    const compliance = checkCompliance(simType, inputs, model);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };

    const codeFieldMap = {
      hvac: ['ductVelocity', 'coolingAirflow', 'supplyAirTemp'],
      plumbing: ['pipeVelocity', 'minPipeSize', 'fixtureUnitTotal', 'sprinklerSpacing'],
      electrical: ['conduitFill', 'circuitAmpacity', 'voltageDrop', 'panelLoad'],
    };

    res.json({
      discipline,
      validationIssues,
      compliance,
      designGuidance: getDesignGuidance(simType, guidance),
      codeReferences: (codeFieldMap[discipline] || []).reduce((acc, f) => {
        acc[f] = getCodeReference(simType, f);
        return acc;
      }, {}),
      smacnaRules: discipline === 'hvac' ? {
        maxVelocityMain: '1200 fpm',
        maxVelocityBranch: '800 fpm',
        highPressureMax: '2500 fpm',
        noiseThreshold: 'NC 35 for offices',
      } : null,
      necReference: discipline === 'electrical' ? {
        wireAmpacityTable: 'NEC Table 310.16 (60°C column for NM cable)',
        conduitFillTable: 'NEC Chapter 9 Table 1 (40% max for 3+ wires)',
        voltageDrop: 'NEC §210.19 recommends ≤5% total',
        panelSizing: 'NEC §220.87 allows 80% for demand loads, 100% for continuous',
      } : null,
      disclaimer: DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/compliance-summary — HTML compliance summary for latest run
router.get('/compliance-summary', async (req, res) => {
  try {
    const { discipline = 'hvac', projectId } = req.query;
    const pid = projectId ? parseInt(projectId) : null;
    const latest = pid
      ? await getLatestMEPSimulationForProject(discipline, pid)
      : await getLatestMEPSimulation(discipline);
    if (!latest) return res.json({ html: '', hasResults: false });

    let simType, results;
    if (discipline === 'plumbing') {
      simType = 'mep_plumbing';
      results = latest.plumbing_results || {};
    } else if (discipline === 'electrical') {
      simType = 'mep_electrical';
      results = latest.electrical_results || {};
    } else {
      simType = 'mep_hvac';
      results = latest.hvac_results || {};
    }

    const inputs = {
      ductVelocity: results.maxDuctVelocity || 0,
      pipeVelocity: results.maxVelocity || 0,
      conduitFill: results.conduitFill || 0,
      circuitAmpacity: results.ampacity || 0,
      voltageDrop: results.voltageDrop || 0,
      panelLoad: results.panelLoad || 0,
      coolingCapacity: results.coolingCapacity || 0,
    };

    const compliance = checkCompliance(simType, inputs, null);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };
    const html = renderComplianceSummary(compliance, simType);
    const designHtml = renderDesignGuidance(getDesignGuidance(simType, guidance));
    res.json({ html, designHtml, hasResults: true, compliance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/push-to-design-book — Push latest MEP results to Design Book
router.post('/push-to-design-book', async (req, res) => {
  try {
    const { projectId = 1 } = req.body;
    const pid = parseInt(projectId) || 1;

    // Fetch latest simulations per discipline
    const [hvacSim, plumbSim, elecSim] = await Promise.all([
      getLatestMEPSimulationForProject('hvac', pid),
      getLatestMEPSimulationForProject('plumbing', pid),
      getLatestMEPSimulationForProject('electrical', pid),
    ]);

    // Also fetch latest fire protection run
    const fpRuns = require('../db/fire-protection');
    const fireSim = await fpRuns.getLatestFireRun();

    const mepResults = {
      hvac: hvacSim?.hvac_results || null,
      plumbing: plumbSim?.plumbing_results || null,
      electrical: elecSim?.electrical_results || null,
      fire: fireSim ? {
        sprinkler_results: fireSim.sprinkler_results,
        egress_results: fireSim.egress_results,
        smoke_results: fireSim.smoke_results,
        resistance_results: fireSim.resistance_results,
        fdny_results: fireSim.fdny_results,
      } : null,
    };

    const hasResults = mepResults.hvac || mepResults.plumbing || mepResults.electrical;
    if (!hasResults) {
      return res.status(400).json({ error: 'No MEP simulation results found. Run at least one simulation first.' });
    }

    const result = await populateFromMEPSimulation(pid, mepResults);

    res.json({
      success: true,
      bookId: result.bookId,
      placeholdersCreated: result.placeholders.length,
      productsCreated: result.products.length,
      placeholders: result.placeholders.map(p => ({
        id: p.id,
        type: p.placeholder_type,
        title: p.title,
      })),
      disclaimer: DISCLAIMER_HTML,
    });
  } catch (err) {
    console.error('[/api/mep/push-to-design-book]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/design-book-status — Check if MEP results have been pushed to Design Book
router.get('/design-book-status', async (req, res) => {
  try {
    const { projectId = 1 } = req.query;
    const pid = parseInt(projectId) || 1;
    const db = require('../db/design-book');
    const book = await db.getOrCreateBook(pid);
    if (!book) return res.json({ pushed: false });

    const placeholders = await db.getPlaceholders(book.id);
    const mepPlaceholders = placeholders.filter(p =>
      ['hvac', 'plumbing', 'electrical', 'fire_protection', 'mep-summary'].includes(p.placeholder_type)
    );
    res.json({
      pushed: mepPlaceholders.length > 0,
      bookId: book.id,
      mepPlaceholders: mepPlaceholders.map(p => ({
        id: p.id,
        type: p.placeholder_type,
        title: p.title,
        status: p.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/openfoam-download/:id — Download OpenFOAM case file (.zip)
router.get('/openfoam-download/:id', async (req, res) => {
  try {
    const sim = await getMEPSimulationById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    const hvac = sim.hvac_results || {};
    if (!hvac.openfoam) return res.status(404).json({ error: 'No OpenFOAM case in this simulation' });

    const ofCase = hvac.openfoam;
    // Build a simple case directory text as downloadable content
    let content = `# Atlantist MEP → OpenFOAM CFD case
# Case: ${ofCase.caseName || 'atlantist_duct_cfd'}
# Generated: ${new Date().toISOString()}

[Mesh]
Cell size: ${ofCase.mesh?.cellSize || 0.1} m
Bounds: x=${ofCase.mesh?.bounds?.x?.join(',')} y=${ofCase.mesh?.bounds?.y?.join(',')} z=${ofCase.mesh?.bounds?.z?.join(',')}

[Boundary Conditions]
Inlet: ${ofCase.boundaryConditions?.inlet?.type || 'fixedVelocity'} @ ${ofCase.boundaryConditions?.inlet?.value || '5'} m/s
Outlet: ${ofCase.boundaryConditions?.outlet?.type || 'zeroGradient'}
Walls: ${ofCase.boundaryConditions?.walls?.type || 'noSlip'}

[Turbulence] ${ofCase.turbulenceModel || 'kEpsilon'}
[Solver] ${ofCase.solver || 'simpleFoam'}

[Duct Segments]
${(ofCase.segments || []).map(s => `${s.id}: ${s.cfm} CFM, ${s.widthIn}"x${s.heightIn}" at ${s.velocityFPM} FPM`).join('\n')}

[Run Instructions]
1. mkdir -p $FOAM_RUN/${ofCase.caseName}
2. blockMesh
3. topoSet
4. snappyHexMesh -overwrite
5. simpleFoam
6. paraFoam  # view results

Notes: ${ofCase.notes || ''}
`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist_openfoam_${sim.id}.txt"`);
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/run-all — Run HVAC + Plumbing + Electrical simultaneously
router.post('/run-all', async (req, res) => {
  try {
    const { projectId = 1, spaceType = 'office', occupancyType = 'office',
            material = 'copper', voltage = 208, phase = '3phase',
            infiltACH = 0.35, ambientTempF = 86, disclaimerAccepted = false } = req.body;

    if (!disclaimerAccepted) {
      return res.status(400).json({ error: 'Accept disclaimer first.', disclaimer: DISCLAIMER_HTML });
    }

    const model = await getModelData(projectId);
    const runRecord = await createMEPSimulation({
      project_id: projectId,
      discipline: 'hvac',
      model_snapshot: model,
      disclaimer_accepted: true,
      status: 'running',
    });

    // Run all three disciplines
    const [hvacResult, plumbResult, elecResult] = await Promise.all([
      Promise.resolve(runHVAC(model, { spaceType, infiltACH })),
      Promise.resolve(runPlumbing(model, { occupancyType, material })),
      Promise.resolve(runElectrical(model, { voltage: parseInt(voltage), phase, ambientTempF: parseInt(ambientTempF) })),
    ]);

    await updateMEPSimulation(runRecord.id, {
      status: 'completed',
      hvac_results: hvacResult,
      plumbing_results: plumbResult,
      electrical_results: elecResult,
    });

    res.json({
      id: runRecord.id,
      projectId,
      disclaimer: DISCLAIMER_HTML,
      hvac: hvacResult,
      plumbing: plumbResult,
      electrical: elecResult,
    });
  } catch (err) {
    console.error('[/api/mep/run-all]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mep/schedule-pdf/:projectId — Generate MEP schedule PDF
router.get('/schedule-pdf/:projectId', async (req, res) => {
  try {
    const pid = parseInt(req.params.projectId) || 1;
    const model = await getModelData(pid);

    // Build schedule data
    const hvacSim = await getLatestMEPSimulationForProject('hvac', pid);
    const plumbSim = await getLatestMEPSimulationForProject('plumbing', pid);
    const elecSim = await getLatestMEPSimulationForProject('electrical', pid);

    const hvac = hvacSim?.hvac_results || {};
    const plumb = plumbSim?.plumbing_results || {};
    const elec = elecSim?.electrical_results || {};

    const scheduleData = buildMEPSchedule(model);

    // Build HTML for PDF
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MEP Schedule</title>
<style>
body{font-family:Arial,sans-serif;margin:24px;color:#222}
h1{font-size:18px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:16px}
h2{font-size:14px;background:#f0f0f0;padding:6px 10px;margin:16px 0 8px}
table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px}
th,td{padding:6px 8px;text-align:left;border:1px solid #ccc}
th{background:#333;color:#fff}
tr:nth-child(even){background:#f9f9f9}
.badge{background:#065f46;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px}
.warn{background:#7f1d1d;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px}
.footer{margin-top:24px;font-size:10px;color:#666;border-top:1px solid #ccc;padding-top:8px}
</style></head><body>
<h1>MEP Systems Schedule — Atlantist BIM</h1>
<p style="font-size:12px;color:#666">Project ID: ${pid} | Generated: ${new Date().toISOString()}</p>

<h2>🅰️ HVAC Systems</h2>
<table>
<tr><th>Parameter</th><th>Value</th><th>Units</th></tr>
<tr><td>Floor Area</td><td>${hvac.floorAreaM2?.toLocaleString() || '—'}</td><td>m²</td></tr>
<tr><td>Heating Load</td><td>${hvac.heatingLoadBtuH?.toLocaleString() || '—'}</td><td>Btu/h</td></tr>
<tr><td>Cooling Load</td><td>${hvac.coolingLoadBtuH?.toLocaleString() || '—'}</td><td>Btu/h</td></tr>
<tr><td>Ventilation CFM</td><td>${hvac.ventilationCFM || '—'}</td><td>CFM</td></tr>
<tr><td>Max Duct Velocity</td><td>${hvac.maxDuctVelocity || '—'}</td><td>FPM</td></tr>
<tr><td>Wall U-Value</td><td>${hvac.wallU || '—'}</td><td>W/m²K</td></tr>
<tr><td>ASHRAE 90.1 EUI</td><td>${hvac.compliance?.euiBtuSqftYr || '—'}</td><td>Btu/ft²/yr</td></tr>
<tr><td>Compliance Status</td><td>${hvac.compliance?.status || '—'}</td><td></td></tr>
<tr><td>OpenFOAM Case</td><td>${hvac.openfoam ? 'Generated (download from simulation)' : '—'}</td><td></td></tr>
</table>

<h2>🅱️ Plumbing Systems</h2>
<table>
<tr><th>Parameter</th><th>Value</th><th>Units</th></tr>
<tr><td>Floor Area</td><td>${plumb.floorAreaSqM?.toLocaleString() || '—'}</td><td>m²</td></tr>
<tr><td>Total Fixture Units (DFU)</td><td>${plumb.totalDFU || '—'}</td><td>DFU</td></tr>
<tr><td>Main Line Size</td><td>${plumb.mainLineSizeIn || '—'}</td><td>in</td></tr>
<tr><td>Branch Line Size</td><td>${plumb.branchLineSizeIn || '—'}</td><td>in</td></tr>
<tr><td>Water Hammer</td><td>${plumb.supplyPipe?.waterHammer?.status || '—'}</td><td></td></tr>
<tr><td>Sprinkler Heads</td><td>${plumb.sprinkler?.headCount || '—'}</td><td></td></tr>
<tr><td>Hot Water Recirc Pipe</td><td>${plumb.hotWaterRecirc?.returnPipeDiamIn || '—'}</td><td>in</td></tr>
<tr><td>IPC Compliance</td><td>${plumb.compliance?.status || '—'}</td><td></td></tr>
<tr><td>EPANET Network</td><td>${plumb.epanet ? `${plumb.epanet.nodeCount} nodes, ${plumb.epanet.linkCount} pipes` : '—'}</td><td></td></tr>
</table>

<h2>⚡ Electrical Systems</h2>
<table>
<tr><th>Parameter</th><th>Value</th><th>Units</th></tr>
<tr><td>Recommended Panel</td><td>${elec.panel?.recommendedPanelAmps || '—'}</td><td>A</td></tr>
<tr><td>Service Voltage</td><td>${elec.panel?.voltage || '—'}</td><td>V</td></tr>
<tr><td>Phase</td><td>${elec.panel?.phase || '—'}</td><td></td></tr>
<tr><td>Total Load</td><td>${elec.panel?.totalKW || '—'}</td><td>kW</td></tr>
<tr><td>Calculated Amps</td><td>${elec.panel?.calculatedAmps || '—'}</td><td>A</td></tr>
<tr><td>Wire Size (100 ft)</td><td>#${elec.wiring?.awg || '—'} AWG</td><td></td></tr>
<tr><td>Voltage Drop (100 ft)</td><td>${elec.wiring?.voltageDropPct || '—'}</td><td>%</td></tr>
<tr><td>Conduit Size</td><td>${elec.conduit?.type || 'EMT'} ${elec.conduit?.size || '—'}</td><td>in</td></tr>
<tr><td>Conduit Fill</td><td>${elec.conduit?.fillPct || '—'}</td><td>%</td></tr>
<tr><td>NEC 2023 Compliance</td><td>${elec.compliance?.status || '—'}</td><td></td></tr>
</table>

<h2>📊 Model Schedule</h2>
<table>
<tr><th>Discipline</th><th>Walls</th><th>Zones/Fixtures/Circuits</th><th>Runs/Outlets/Switches</th></tr>
<tr><td>HVAC</td><td>${scheduleData.hvac?.totalWalls || '—'}</td><td>${scheduleData.hvac?.totalZones || '—'} zones</td><td>${scheduleData.hvac?.estimatedDuctRuns || '—'} duct runs</td></tr>
<tr><td>Plumbing</td><td>${scheduleData.plumbing?.totalWalls || '—'}</td><td>${scheduleData.plumbing?.estimatedFixtures || '—'} fixtures</td><td>${scheduleData.plumbing?.estimatedPipeRuns || '—'} pipe runs</td></tr>
<tr><td>Electrical</td><td>${scheduleData.electrical?.totalWalls || '—'}</td><td>${scheduleData.electrical?.estimatedCircuits || '—'} circuits</td><td>${scheduleData.electrical?.estimatedOutlets || '—'} outlets</td></tr>
</table>

<div class="footer">
⚠️ DISCLAIMER: This MEP schedule is an estimate only. All MEP designs must be reviewed and stamped by a licensed professional engineer (PE). Atlantist does not guarantee code compliance or regulatory approval. Responsibility for code compliance rests entirely with the user and their licensed PE. Verify all results against applicable codes: ASHRAE 90.1, IPC 2021, NEC 2023, NFPA 13.
</div></body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist_mep_schedule_${pid}.html"`);
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mep/google-drive-import — Import MEP data from Google Drive exported content
router.post('/google-drive-import', async (req, res) => {
  try {
    const { projectId = 1, mepData, fileName } = req.body;
    if (!mepData || typeof mepData !== 'object') {
      return res.status(400).json({ error: 'mepData object is required. Export from Google Drive as JSON.' });
    }

    // Parse MEP content from Google Drive export
    // Supports: HVAC zone data, plumbing fixture counts, electrical panel schedules
    const parsed = parseGoogleDriveMEP(mepData, fileName || 'google-drive-import');

    // Run simulations from imported data
    const record = await createMEPSimulation({
      project_id: projectId,
      discipline: parsed.discipline || 'hvac',
      model_snapshot: { source: 'google-drive', fileName, imported: true },
      hvac_results: parsed.hvac || {},
      plumbing_results: parsed.plumbing || {},
      electrical_results: parsed.electrical || {},
      status: 'completed',
      disclaimer_accepted: true,
    });

    res.json({
      success: true,
      runId: record.id,
      disciplines: parsed.disciplines,
      itemCount: parsed.itemCount,
      notes: parsed.notes,
      disclaimer: DISCLAIMER_HTML,
    });
  } catch (err) {
    console.error('[/api/mep/google-drive-import]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Parse MEP data exported from Google Drive (Revit exports, Spreadsheets, IFC).
 * Returns normalized MEP results that can be stored in mep_simulation_runs.
 */
function parseGoogleDriveMEP(data, source) {
  const result = { disciplines: [], itemCount: 0, notes: [] };
  const items = [];

  // HVAC data: zone names, loads, CFM, duct sizes from Revit schedules
  if (data.hvacZones || data.zones || data.hvac) {
    const hvacData = data.hvacZones || data.zones || data.hvac;
    const zones = Array.isArray(hvacData) ? hvacData : [hvacData];
    result.hvac = {
      zone: zones[0]?.zoneName || 'imported',
      floorAreaM2: zones.reduce((s, z) => s + (parseFloat(z.area) || 0), 0),
      heatingLoadW: zones.reduce((s, z) => s + (parseFloat(z.heatingLoad) || 0), 0),
      coolingLoadW: zones.reduce((s, z) => s + (parseFloat(z.coolingLoad) || 0), 0),
      ventilationCFM: zones.reduce((s, z) => s + (parseFloat(z.cfm) || 0), 0),
      compliance: { code: 'ASHRAE 90.1-2019', status: 'IMPORTED (verify)', euiBtuSqftYr: 'N/A' },
    };
    result.disciplines.push('hvac');
    result.itemCount += zones.length;
    result.notes.push(`Imported ${zones.length} HVAC zones from ${source}`);
  }

  // Plumbing data: fixture unit counts from Revit or spreadsheet
  if (data.plumbingFixtures || data.fixtures || data.plumbing) {
    const fixData = data.plumbingFixtures || data.fixtures || data.plumbing;
    const fixtures = Array.isArray(fixData) ? fixData : [fixData];
    const fixtureCount = {};
    for (const f of fixtures) {
      const type = (f.type || f.fixtureType || 'unknown').toLowerCase().replace(/\//g, '-');
      fixtureCount[type] = { units: parseInt(f.count) || parseInt(f.quantity) || 1, dfu: parseFloat(f.dfu) || 1 };
    }
    const totalDFU = Object.values(fixtureCount).reduce((s, f) => s + f.units * f.dfu, 0);
    result.plumbing = {
      totalDFU: Math.round(totalDFU * 10) / 10,
      fixtureCount,
      compliance: { code: 'IPC 2021', status: 'IMPORTED (verify)' },
    };
    result.disciplines.push('plumbing');
    result.itemCount += fixtures.length;
    result.notes.push(`Imported ${fixtures.length} plumbing fixtures from ${source}`);
  }

  // Electrical data: panel schedules from Revit
  if (data.electricalPanels || data.panels || data.electrical) {
    const panelData = data.electricalPanels || data.panels || data.electrical;
    const panels = Array.isArray(panelData) ? panelData : [panelData];
    const panel = panels[0] || {};
    result.electrical = {
      panel: {
        recommendedPanelAmps: parseInt(panel.panelAmps) || 100,
        voltage: parseInt(panel.voltage) || 208,
        phase: panel.phase || '3phase',
        totalKW: parseFloat(panel.totalKW) || 0,
        calculatedAmps: parseFloat(panel.calculatedAmps) || 0,
        generalLightingKW: parseFloat(panel.lightingKW) || 0,
        receptacleKW: parseFloat(panel.receptacleKW) || 0,
      },
      wiring: {
        awg: panel.wireSize || 12,
        ampacity: parseInt(panel.wireAmpacity) || 20,
        voltageDropPct: parseFloat(panel.voltageDrop) || 2,
      },
      conduit: {
        type: panel.conduitType || 'EMT',
        size: panel.conduitSize || 0.75,
        fillPct: parseFloat(panel.conduitFill) || 30,
      },
      compliance: { code: 'NEC 2023', status: 'IMPORTED (verify)' },
    };
    result.disciplines.push('electrical');
    result.itemCount += panels.length;
    result.notes.push(`Imported ${panels.length} electrical panels from ${source}`);
  }

  if (result.disciplines.length === 0) {
    result.notes.push('No recognizable MEP data found. Supported formats: HVAC zones, plumbing fixtures, electrical panels.');
  }

  result.discipline = result.disciplines[0] || 'hvac';
  return result;
}

module.exports = router;