/**
 * Owns: /api/fire-protection endpoints — NFPA 13 sprinkler, NFPA 101 egress,
 *       NFPA 92 smoke control, fire resistance, FDNY requirements analysis,
 *       FDS input file generation and simulation.
 * Does NOT own: BIM element CRUD, energy simulation, Three.js rendering.
 */
const router = require('express').Router();
const fp = require('../services/fire-protection');
const { createFireRun, updateFireRun, getFireRunById, getAllFireRuns, getLatestFireRun } = require('../db/fire-protection');
const { getAllElements } = require('../db/elements');
const { getAllLevels } = require('../db/levels');
const { getAllFamilyInstances } = require('../db/families');
const { validateInputs, checkCompliance, getCodeReference, renderComplianceSummary, renderDesignGuidance, DISCLAIMER } = require('../services/simulation-guardrails');

async function getModelData() {
  const [elements, levels, familyInstances] = await Promise.all([
    getAllElements(),
    getAllLevels(),
    getAllFamilyInstances(),
  ]);
  return { elements, levels, familyInstances };
}

// POST /api/fire-protection/run
router.post('/run', async (req, res) => {
  try {
    const { occupancy_type = 'office', project_name } = req.body;
    const model = await getModelData();

    const run = await createFireRun({ model_snapshot: model, occupancy_type, status: 'running' });

    const sprinkler_results  = fp.calcSprinkler(model, occupancy_type);
    const egress_results     = fp.calcEgress(model, occupancy_type);
    const smoke_results      = fp.calcSmokeControl(model);
    const resistance_results = fp.calcFireResistance(model, occupancy_type);
    const fdny_results       = fp.calcFDNY(model);

    const updated = await updateFireRun(run.id, {
      sprinkler_results,
      egress_results,
      smoke_results,
      resistance_results,
      fdny_results,
      status: 'complete',
    });

    res.json(updated);
  } catch (err) {
    console.error('[fire-protection] run error:', err.message);
    res.status(500).json({ error: 'Fire protection analysis failed: ' + err.message });
  }
});

// GET /api/fire-protection/runs — list recent runs
router.get('/runs', async (_req, res) => {
  try {
    res.json(await getAllFireRuns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fire-protection/runs/latest
router.get('/runs/latest', async (_req, res) => {
  try {
    const run = await getLatestFireRun();
    if (!run) return res.status(404).json({ error: 'No fire protection runs yet' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fire-protection/runs/:id
router.get('/runs/:id', async (req, res) => {
  try {
    const run = await getFireRunById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FDS Simulation Endpoints ─────────────────────────────────────────────────

/**
 * POST /api/fire-protection/fds/simulate
 * Run FDS-like fire simulation in JavaScript (NIST fire formula approximations).
 * Returns time-series results for Three.js visualization.
 */
router.post('/fds/simulate', async (req, res) => {
  try {
    const {
      hrr_peak_kw   = 3000,
      growth_alpha  = 0.12,
      fire_location = null,   // [x, y, z] meters
      fire_x        = null,
      fire_y        = null,
      simulation_time_s = 300,
      occupancy_type    = 'office',
    } = req.body;

    const model = await getModelData();
    const fireLoc = fire_x != null && fire_y != null
      ? [parseFloat(fire_x), parseFloat(fire_y), 0.3]
      : (fire_location || null);

    const result = fp.runFDSSimulation(model, {
      hrr_peak_kw:       parseFloat(hrr_peak_kw),
      growth_alpha:      parseFloat(growth_alpha),
      fire_location:     fireLoc,
      simulation_time_s: parseInt(simulation_time_s) || 300,
    });

    // Include occupancy context in the result
    const egressResult = fp.calcEgress(model, occupancy_type);
    const sprinklerResult = fp.calcSprinkler(model, occupancy_type);

    res.json({
      fds: result,
      occupancy_context: {
        occupant_load: egressResult.occupant_load_per_floor,
        exit_count: egressResult.exits_provided,
        sprinkler_k_factor: sprinklerResult.k_factor,
        hazard_type: sprinklerResult.hazard_type,
      },
    });
  } catch (err) {
    console.error('[fds/simulate] error:', err.message);
    res.status(500).json({ error: 'FDS simulation failed: ' + err.message });
  }
});

/**
 * GET /api/fire-protection/fds/export
 * Generate and download an FDS (.fds) input file for offline simulation in NIST FDS/Smokeview.
 * Query params: fire_x, fire_y, fire_z, hrr_peak, growth_alpha, duration_min, mesh_res
 */
router.get('/fds/export', async (req, res) => {
  try {
    const model = await getModelData();
    const options = {
      fire_location: req.query.fire_x != null
        ? [parseFloat(req.query.fire_x), parseFloat(req.query.fire_y), parseFloat(req.query.fire_z || 0.3)]
        : null,
      fire_hrr_peak:        parseFloat(req.query.hrr_peak) || 3000,
      fire_growth_t_alpha: parseFloat(req.query.growth_alpha) || 0.12,
      fire_duration_min:   parseInt(req.query.duration_min) || 30,
      mesh_resolution:     parseFloat(req.query.mesh_res) || 0.5,
      sprinkler_activation_temp: parseInt(req.query.sprinkler_temp) || 74,
    };

    const fdsContent = fp.generateFDSInput(model, options);
    const filename  = `atlantist_fds_${Date.now()}.fds`;

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fdsContent);
  } catch (err) {
    console.error('[fds/export] error:', err.message);
    res.status(500).json({ error: 'FDS export failed: ' + err.message });
  }
});

/**
 * POST /api/fire-protection/fds/parse
 * Parse FDS output files (slice CSV, boundary JSON) uploaded by the user
 * after running their simulation offline. Returns standardized results for Three.js viz.
 * Expects: JSON body with { slice_csv?: string, boundary_json?: string }
 */
router.post('/fds/parse', async (req, res) => {
  try {
    const { slice_csv, boundary_json } = req.body;
    if (!slice_csv && !boundary_json) {
      return res.status(400).json({ error: 'Provide slice_csv or boundary_json data' });
    }

    let gridData = null;
    if (slice_csv) {
      gridData = fp.parseFDSSliceCSV(slice_csv);
    }

    res.json({
      status: 'parsed',
      grid: gridData,
      boundary: boundary_json ? JSON.parse(boundary_json) : null,
      note: 'Results ready for Three.js visualization. Upload to Smokeview for full 3D rendering.',
    });
  } catch (err) {
    console.error('[fds/parse] error:', err.message);
    res.status(500).json({ error: 'FDS parse failed: ' + err.message });
  }
});

// GET /api/fire-protection/validate — pre-run validation and code compliance for fire
router.get('/validate', async (req, res) => {
  try {
    const { occupancy_type = 'office', sprinklered = true } = req.query;
    const model = await getModelData();

    const egressResults = fp.calcEgress(model, occupancy_type);
    const inputs = {
      occupantLoadFactor: 100,
      egressWidthPerOccupant: (egressResults.exit_aggr_width_in || 24) / (egressResults.occupant_load_per_floor || 1),
      travelDistance: 100,
      exitAccessTravelDistance: 75,
      sprinklerCoverageArea: 150,
      fireResistanceHours: 2,
      smokeControlPressure: 25,
      sprinklered,
      occupancy_type,
    };

    const validationIssues = validateInputs('fire', inputs);
    const compliance = checkCompliance('fire', inputs, model);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };

    res.json({
      validationIssues,
      compliance,
      designGuidance: getDesignGuidance('fire', guidance),
      codeReferences: {
        occupantLoadFactor: getCodeReference('fire', 'occupantLoadFactor'),
        egressWidthPerOccupant: getCodeReference('fire', 'egressWidthPerOccupant'),
        travelDistance: getCodeReference('fire', 'travelDistance'),
        sprinklerCoverageArea: getCodeReference('fire', 'sprinklerCoverageArea'),
        fireResistanceHours: getCodeReference('fire', 'fireResistanceHours'),
      },
      occupancyInfo: {
        required: occupancy_type,
        sprinklerRequired: ['assembly', 'educational', 'hotel', 'hospital', 'high_storage'].includes(occupancy_type),
        maxTravelDistanceByOccupancy: {
          office: '100 ft / 200 ft with sprinkler',
          assembly: '75 ft / 150 ft with sprinkler',
          educational: '75 ft / 150 ft with sprinkler',
          mercantile: '100 ft / 200 ft with sprinkler',
          residential: '125 ft / 200 ft with sprinkler',
          hotel: '125 ft / 200 ft with sprinkler',
          hospital: '150 ft / 200 ft with sprinkler',
          industrial: '150 ft',
          storage: '200 ft',
        },
      },
      disclaimer: DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fire-protection/compliance-summary — HTML compliance summary for UI
router.get('/compliance-summary', async (req, res) => {
  try {
    const latest = await getLatestFireRun();
    if (!latest) return res.json({ html: '', hasResults: false });
    const inputs = {
      occupancy_type: latest.occupancy_type || 'office',
      sprinklered: latest.sprinkler_results ? true : false,
    };
    const model = typeof latest.model_snapshot === 'string'
      ? JSON.parse(latest.model_snapshot)
      : (latest.model_snapshot || {});
    const compliance = checkCompliance('fire', inputs, model);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };
    const html = renderComplianceSummary(compliance, 'fire');
    const designHtml = renderDesignGuidance(getDesignGuidance('fire', guidance));
    res.json({ html, designHtml, hasResults: true, compliance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
