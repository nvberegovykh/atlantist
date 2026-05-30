/**
 * Owns: geotechnical analysis API endpoints (soil profiles, bearing capacity,
 *       settlement, earth pressure, pile, slope stability, OpenSees input export).
 * Does NOT own: calculation logic (services/geotechnical.js), DB access (db/geotechnical.js).
 */
const express = require('express');
const router = express.Router();
const geo = require('../services/geotechnical');
const db = require('../db/geotechnical');
const { validateInputs, checkCompliance, getCodeReference, getDesignGuidance, renderComplianceSummary, renderDesignGuidance, DISCLAIMER } = require('../services/simulation-guardrails');

// GET /api/geotechnical/soil-profiles?project_id=:id
router.get('/soil-profiles', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const profiles = await db.soilProfile.listByProject(parseInt(project_id));
    res.json({ profiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/geotechnical/soil-profiles
router.post('/soil-profiles', async (req, res) => {
  try {
    const { project_id, name, soil_layers, groundwater_depth, surface_elevation, spt_blowcounts, cpt_data, lab_tests, notes, created_by } = req.body;
    if (!project_id || !name) return res.status(400).json({ error: 'project_id and name required' });
    const profile = await db.soilProfile.create({ project_id, name, soil_layers: soil_layers || [], groundwater_depth, surface_elevation, spt_blowcounts, cpt_data, lab_tests, notes, created_by });
    res.json({ profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/geotechnical/soil-profiles/:id
router.put('/soil-profiles/:id', async (req, res) => {
  try {
    const profile = await db.soilProfile.update(parseInt(req.params.id), req.body);
    if (!profile) return res.status(404).json({ error: 'not found' });
    res.json({ profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/geotechnical/soil-profiles/:id
router.delete('/soil-profiles/:id', async (req, res) => {
  try {
    await db.soilProfile.delete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geotechnical/runs?project_id=:id&type=:type
router.get('/runs', async (req, res) => {
  try {
    const { project_id, type } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const runs = await db.geotechnicalRun.listByProject(parseInt(project_id), type);
    res.json({ runs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/geotechnical/analyze — run a calculation and persist the run
router.post('/analyze', async (req, res) => {
  try {
    const { project_id, soil_profile_id, name, run_type, parameters, created_by } = req.body;
    if (!project_id || !run_type || !parameters) {
      return res.status(400).json({ error: 'project_id, run_type, and parameters required' });
    }

    // Create run record with pending status
    const run = await db.geotechnicalRun.create({
      project_id: parseInt(project_id),
      soil_profile_id: soil_profile_id ? parseInt(soil_profile_id) : null,
      name: name || `Geo ${run_type} — ${new Date().toLocaleDateString()}`,
      run_type,
      parameters,
      created_by: created_by ? parseInt(created_by) : null,
    });

    // Load soil profile if provided
    let soilProfile = null;
    if (soil_profile_id) {
      const sp = await db.soilProfile.getById(parseInt(soil_profile_id));
      if (sp) {
        const layers = sp.soil_layers || [];
        soilProfile = {
          c: extractCohesion(layers),
          phi: extractFrictionAngle(layers),
          gamma: extractUnitWeight(layers),
          E: extractModulus(layers),
          layers,
        };
      }
    }

    // Run the analysis
    const rawResults = geo.runGeotechnicalAnalysis({ levels: [] }, { ...parameters, run_type, soil_profile: soilProfile });

    if (rawResults.error) {
      await db.geotechnicalRun.markFailed(run.id);
      return res.status(400).json({ error: rawResults.error, run_id: run.id });
    }

    // Restructure results to match DB column schema (bearing_results, settlement_results, etc.)
    const results = restructureResults(rawResults, run_type, parameters);

    // Build visualization data
    const vizData = geo.buildVizData(soilProfile || { layers: [] }, parameters);

    // Get OpenSees input if applicable
    let openseesInput = null;
    if (run_type === 'opensees' && rawResults.opensees_input) {
      openseesInput = rawResults.opensees_input;
    }

    // Update run with results
    const updated = await db.geotechnicalRun.updateResults(run.id, results, vizData, openseesInput);
    res.json({ run: updated, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geotechnical/runs/:id
router.get('/runs/:id', async (req, res) => {
  try {
    const run = await db.geotechnicalRun.getById(parseInt(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json({ run });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geotechnical/runs/:id/opensees — download OpenSees .tcl file
router.get('/runs/:id/opensees', async (req, res) => {
  try {
    const run = await db.geotechnicalRun.getById(parseInt(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!run.opensees_input) return res.status(404).json({ error: 'No OpenSees input for this run' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="opensees_${run.id}.tcl"`);
    res.send(run.opensees_input);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/geotechnical/runs/:id
router.delete('/runs/:id', async (req, res) => {
  try {
    await db.geotechnicalRun.delete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geotechnical/calculate — quick calculation without persisting (for preview)
router.get('/calculate', async (req, res) => {
  try {
    const { run_type, B, D, c, phi, gamma, q, FOS, method, H_wall, wall_type, H_pile, alpha, cu, H_slope, beta } = req.query;

    const params = { run_type, B, D, c, phi, gamma, q, FOS, method, H_wall, wall_type, H_pile, alpha, cu, H_slope, beta };
    // remove nulls
    Object.keys(params).forEach(k => { if (params[k] === null || params[k] === undefined || params[k] === '') delete params[k]; });
    // coerce numbers
    for (const k of ['B','D','c','phi','gamma','q','FOS','H_wall','H_pile','alpha','cu','H_slope','beta']) {
      if (params[k] !== undefined) params[k] = parseFloat(params[k]);
    }

    const result = geo.runGeotechnicalAnalysis({}, { ...params, run_type });
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractCohesion(layers) {
  const clayLayer = layers.find(l => ['Clay', 'Silty Clay', 'Sandy Clay', 'Silt', 'Organic'].includes(l.type));
  return clayLayer ? (clayLayer.cohesion || clayLayer.c || 20) : 10;
}

function extractFrictionAngle(layers) {
  const sandLayer = layers.find(l => ['Sand', 'Silty Sand', 'Gravel'].includes(l.type));
  return sandLayer ? (sandLayer.frictionAngle || sandLayer.phi || 32) : 28;
}

function extractUnitWeight(layers) {
  const topLayer = layers[0];
  return topLayer ? (topLayer.unitWeight || topLayer.gamma || 18) : 18;
}

// ─── Result Restructuring ──────────────────────────────────────────────────────

/**
 * runGeotechnicalAnalysis returns flat objects per method.
 * db.updateResults expects keyed sub-objects: bearing_results, settlement_results, etc.
 * This function maps the raw result into the correct shape.
 */
function restructureResults(raw, runType, params) {
  switch (runType) {
    case 'bearing_capacity':
      return {
        bearing_results: { ...raw },
        settlement_results: {
          settlement_mm: 0, method: 'N/A',
          soil_modulus: params.E_s || params.E || 25000,
          settlement_profile: [],
        },
        earth_pressure_results: geo.earthPressure({
          phi: params.phi || 28,
          c: params.c || 10,
          gamma: params.gamma || 18,
          H: params.H_wall || 3,
          wall_type: 'retaining',
        }),
        pile_results: { Q_ult_kN: 0, Q_allow_kN: 0, Q_side_kN: 0, Q_tip_kN: 0, t_z_curves: [], p_y_curve: [], method: 'N/A' },
        slope_results: { fellenius: { FOS: 999, method: 'N/A' }, bishop: { FOS: 999, method: 'N/A' } },
      };

    case 'settlement':
      return {
        bearing_results: { q_ult: 0, q_all: 0, method: 'N/A', factors: { Nq: 0, Nc: 0, Ngamma: 0 } },
        settlement_results: { ...raw },
        earth_pressure_results: geo.earthPressure({
          phi: params.phi || 28,
          c: params.c || 10,
          gamma: params.gamma || 18,
          H: params.H_wall || 3,
          wall_type: 'retaining',
        }),
        pile_results: { Q_ult_kN: 0, Q_allow_kN: 0, Q_side_kN: 0, Q_tip_kN: 0, t_z_curves: [], p_y_curve: [], method: 'N/A' },
        slope_results: { fellenius: { FOS: 999, method: 'N/A' }, bishop: { FOS: 999, method: 'N/A' } },
      };

    case 'lateral_earth_pressure':
      return {
        bearing_results: { q_ult: 0, q_all: 0, method: 'N/A', factors: { Nq: 0, Nc: 0, Ngamma: 0 } },
        settlement_results: { settlement_mm: 0, method: 'N/A', soil_modulus: params.E_s || 25000, settlement_profile: [] },
        earth_pressure_results: { ...raw },
        pile_results: { Q_ult_kN: 0, Q_allow_kN: 0, Q_side_kN: 0, Q_tip_kN: 0, t_z_curves: [], p_y_curve: [], method: 'N/A' },
        slope_results: { fellenius: { FOS: 999, method: 'N/A' }, bishop: { FOS: 999, method: 'N/A' } },
      };

    case 'pile_capacity':
      return {
        bearing_results: { q_ult: 0, q_all: 0, method: 'N/A', factors: { Nq: 0, Nc: 0, Ngamma: 0 } },
        settlement_results: { settlement_mm: 0, method: 'N/A', soil_modulus: params.E_s || 25000, settlement_profile: [] },
        earth_pressure_results: geo.earthPressure({
          phi: params.phi || 28,
          c: params.c || 10,
          gamma: params.gamma || 18,
          H: params.H_wall || 3,
          wall_type: 'retaining',
        }),
        pile_results: { ...raw },
        slope_results: { fellenius: { FOS: 999, method: 'N/A' }, bishop: { FOS: 999, method: 'N/A' } },
      };

    case 'slope_stability':
      return {
        bearing_results: { q_ult: 0, q_all: 0, method: 'N/A', factors: { Nq: 0, Nc: 0, Ngamma: 0 } },
        settlement_results: { settlement_mm: 0, method: 'N/A', soil_modulus: params.E_s || 25000, settlement_profile: [] },
        earth_pressure_results: geo.earthPressure({
          phi: params.phi || 28,
          c: params.c || 10,
          gamma: params.gamma || 18,
          H: params.H_wall || 3,
          wall_type: 'retaining',
        }),
        pile_results: { Q_ult_kN: 0, Q_allow_kN: 0, Q_side_kN: 0, Q_tip_kN: 0, t_z_curves: [], p_y_curve: [], method: 'N/A' },
        slope_results: { ...raw },
      };

    case 'opensees':
      return {
        bearing_results: { q_ult: 0, q_all: 0, method: 'N/A', factors: { Nq: 0, Nc: 0, Ngamma: 0 } },
        settlement_results: { settlement_mm: 0, method: 'N/A', soil_modulus: params.E_s || 25000, settlement_profile: [] },
        earth_pressure_results: geo.earthPressure({
          phi: params.phi || 28,
          c: params.c || 10,
          gamma: params.gamma || 18,
          H: params.H_wall || 3,
          wall_type: 'retaining',
        }),
        pile_results: { Q_ult_kN: 0, Q_allow_kN: 0, Q_side_kN: 0, Q_tip_kN: 0, t_z_curves: [], p_y_curve: [], method: 'N/A' },
        slope_results: { fellenius: { FOS: 999, method: 'N/A' }, bishop: { FOS: 999, method: 'N/A' } },
      };

    default:
      // Try to auto-detect from raw keys
      const result = {};
      if (raw.q_ult !== undefined) result.bearing_results = { ...raw };
      else if (raw.settlement_mm !== undefined) result.settlement_results = { ...raw };
      else if (raw.Ka !== undefined) result.earth_pressure_results = { ...raw };
      else if (raw.Q_ult_kN !== undefined) result.pile_results = { ...raw };
      else if (raw.FOS !== undefined) result.slope_results = { fellenius: { ...raw }, bishop: raw.bishop || { FOS: 999, method: 'N/A' } };
      return result;
  }
}

function extractModulus(layers) {
  // Use weighted average over first 5m
  const topLayers = layers.filter(l => l.depthTop < 5);
  if (!topLayers.length) return 25000;
  const totalDepth = topLayers.reduce((s, l) => s + (Math.min(l.depthBottom, 5) - l.depthTop), 0);
  const weightedE = topLayers.reduce((s, l) => s + (Math.min(l.depthBottom, 5) - l.depthTop) * (l.modulusE || l.E || 25000), 0);
  return Math.round(weightedE / Math.max(0.1, totalDepth));
}

// GET /api/geotechnical/validate — pre-analysis validation and code compliance check
router.get('/validate', async (req, res) => {
  try {
    const {
      c, phi, gamma, E,
      B, D,
      settlement_mm, groundwater_depth,
      sptBlowcount, foundationWidth, foundationDepth, allowableBearingPressure,
    } = req.query;

    const inputs = {
      cohesion: c ? parseFloat(c) : undefined,
      frictionAngle: phi ? parseFloat(phi) : undefined,
      unitWeight: gamma ? parseFloat(gamma) : undefined,
      elasticModulus: E ? parseFloat(E) : undefined,
      foundationWidth: B ? parseFloat(B) : undefined,
      foundationDepth: D ? parseFloat(D) : undefined,
      settlement: settlement_mm ? parseFloat(settlement_mm) : undefined,
      groundwaterDepth: groundwater_depth ? parseFloat(groundwater_depth) : undefined,
      sptBlowcount: sptBlowcount ? parseFloat(sptBlowcount) : undefined,
      depth: D ? parseFloat(D) : undefined,
      allowableBearingPressure: allowableBearingPressure ? parseFloat(allowableBearingPressure) : undefined,
    };

    const validationIssues = validateInputs('geotech', inputs);
    const compliance = checkCompliance('geotech', inputs, null);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };

    res.json({
      validationIssues,
      compliance,
      designGuidance: getDesignGuidance('geotech', guidance),
      codeReferences: {
        cohesion: getCodeReference('geotech', 'cohesion'),
        frictionAngle: getCodeReference('geotech', 'frictionAngle'),
        unitWeight: getCodeReference('geotech', 'unitWeight'),
        depth: getCodeReference('geotech', 'depth'),
        elasticModulus: getCodeReference('geotech', 'elasticModulus'),
        foundationWidth: getCodeReference('geotech', 'foundationWidth'),
        foundationDepth: getCodeReference('geotech', 'foundationDepth'),
        sptBlowcount: getCodeReference('geotech', 'sptBlowcount'),
        groundwaterDepth: getCodeReference('geotech', 'groundwaterDepth'),
        settlement: getCodeReference('geotech', 'settlement'),
        allowableBearingPressure: getCodeReference('geotech', 'allowableBearingPressure'),
      },
      nycReference: {
        frostDepth: '0.81 m (32 in) per NYC BC §1804.1',
        maxAllowablePressure: 'See NYC BC Table 1804.2 by soil type',
        maxSettlement: '25 mm total, 19 mm differential per NYC BC §1804.3',
        geotechStamp: 'Required for bearing capacity > 150 kPa per NYC BC §111.4.2',
      },
      disclaimer: DISCLAIMER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geotechnical/compliance-summary — HTML compliance summary for UI
router.get('/compliance-summary', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const runs = await db.geotechnicalRun.listByProject(parseInt(project_id));
    const latest = runs[0];
    if (!latest) return res.json({ html: '', hasResults: false });

    const params = latest.parameters || {};
    const inputs = {
      cohesion: parseFloat(params.c) || 0,
      frictionAngle: parseFloat(params.phi) || 0,
      unitWeight: parseFloat(params.gamma) || 0,
      elasticModulus: parseFloat(params.E_s) || 0,
      foundationWidth: parseFloat(params.B) || 0,
      foundationDepth: parseFloat(params.D) || 0,
      settlement: (latest.bearing_results || latest.settlement_results || {}).settlement_mm || 0,
      groundwaterDepth: parseFloat(params.groundwater_depth) || 0,
      sptBlowcount: parseFloat(params.spt_blowcount) || 0,
    };

    const compliance = checkCompliance('geotech', inputs, null);
    const guidance = {
      status: compliance.critical.length ? 'FAIL' : compliance.warning.length ? 'MARGINAL' : 'PASS',
      violations: [...compliance.critical, ...compliance.warning, ...compliance.info],
    };
    const html = renderComplianceSummary(compliance, 'geotech');
    const designHtml = renderDesignGuidance(getDesignGuidance('geotech', guidance));
    res.json({ html, designHtml, hasResults: true, compliance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;