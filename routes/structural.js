/**
 * Owns: Structural analysis API endpoints — members CRUD, load cases, loads,
 *       analysis runs, section library, code checks, OpenSees .tcl export, DAG extraction.
 * Does NOT own: calculation logic (services/structural-engine.js), DB access (db/structural.js).
 */
const express = require('express');
const router = express.Router();
const engine = require('../services/structural-engine');
const db = require('../db/structural');
const pool = require('../db');
const { generateStructuralPDF } = require('../services/structural-pdf');

// ─── Members ────────────────────────────────────────────────────────────────

router.get('/members', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const members = await db.members.listByProject(project_id);
    res.json({ members });
  } catch (err) {
    console.error('[structural] members list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/members', async (req, res) => {
  try {
    const member = await db.members.create(req.body);
    res.json({ member });
  } catch (err) {
    console.error('[structural] member create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/members/:id', async (req, res) => {
  try {
    const member = await db.members.update(parseInt(req.params.id), req.body);
    if (!member) return res.status(404).json({ error: 'not found' });
    res.json({ member });
  } catch (err) {
    console.error('[structural] member update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/members/:id', async (req, res) => {
  try {
    await db.members.delete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[structural] member delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Load Cases ─────────────────────────────────────────────────────────────

router.get('/load-cases', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const cases = await db.loadCases.listByProject(project_id);
    res.json({ load_cases: cases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/load-cases', async (req, res) => {
  try {
    const lc = await db.loadCases.create(req.body);
    res.json({ load_case: lc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/load-cases/:id', async (req, res) => {
  try {
    await db.loadCases.delete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Loads ──────────────────────────────────────────────────────────────────

router.post('/loads', async (req, res) => {
  try {
    const load = await db.loads.create(req.body);
    res.json({ load });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/loads', async (req, res) => {
  try {
    const { load_case_id } = req.query;
    if (!load_case_id) return res.status(400).json({ error: 'load_case_id required' });
    const loads = await db.loads.listByCase(parseInt(load_case_id));
    res.json({ loads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sections Library ───────────────────────────────────────────────────────

router.get('/sections', async (req, res) => {
  try {
    const { category } = req.query;
    const sections = await db.sections.list(category);
    res.json({ sections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sections/builtin', (_req, res) => {
  res.json({
    steel: Object.keys(engine.AISC_SHAPES),
    wood: Object.keys(engine.WOOD_SECTIONS),
    concrete_grades: Object.keys(engine.CONCRETE_GRADES),
    load_combinations: engine.getLRFDCombinations(),
  });
});

// ─── Individual Code Checks ─────────────────────────────────────────────────

router.post('/check/seismic', (req, res) => {
  try {
    const result = engine.seismicBaseShear(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/wind', (req, res) => {
  try {
    const result = engine.windPressure(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/steel-flexure', (req, res) => {
  try {
    const result = engine.steelFlexuralCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/steel-compression', (req, res) => {
  try {
    const result = engine.steelCompressionCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/steel-shear', (req, res) => {
  try {
    const result = engine.steelShearCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/concrete-flexure', (req, res) => {
  try {
    const result = engine.concreteFlexuralCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/concrete-shear', (req, res) => {
  try {
    const result = engine.concreteShearCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/concrete-column', (req, res) => {
  try {
    const result = engine.concreteColumnCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/wood-flexure', (req, res) => {
  try {
    const result = engine.woodFlexuralCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/wood-compression', (req, res) => {
  try {
    const result = engine.woodCompressionCheck(req.body);
    res.json({ result, disclaimer: engine.DISCLAIMER });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Full Analysis Run ──────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  try {
    const { project_id, name, analysis_type, parameters, disclaimer_accepted, created_by } = req.body;
    if (!project_id || !analysis_type) {
      return res.status(400).json({ error: 'project_id and analysis_type required' });
    }
    if (!disclaimer_accepted) {
      return res.status(400).json({ error: 'Must accept disclaimer before running analysis', disclaimer: engine.DISCLAIMER });
    }

    // Create run record
    const run = await db.runs.create({ project_id, name, analysis_type, parameters, disclaimer_accepted, created_by });

    // Fetch members for this project
    const members = await db.members.listByProject(project_id);
    if (!members.length) {
      await db.runs.markFailed(run.id, 'No structural members defined');
      return res.status(400).json({ error: 'No structural members defined for this project' });
    }

    // Run analysis
    const analysisParams = {
      members: members.map(m => ({
        id: m.id, name: m.name, member_type: m.member_type,
        material_type: m.material_type, section_name: m.section_name,
        start_node: m.start_node, end_node: m.end_node,
        properties: m.properties, releases: m.releases,
      })),
      supports: parameters?.supports || [],
      loads: parameters?.loads || [],
      analysis_type,
      seismic: parameters?.seismic || {},
      num_modes: parameters?.num_modes || 6,
    };

    const results = engine.runAnalysis(analysisParams);

    // Persist
    const updated = await db.runs.updateResults(run.id, results);

    res.json({
      run: updated,
      disclaimer: engine.DISCLAIMER,
    });
  } catch (err) {
    console.error('[structural] analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Analysis Runs ──────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
  try {
    const { project_id, type } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const runs = await db.runs.listByProject(project_id, type);
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const run = await db.runs.getById(parseInt(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json({ run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/structural/runs/:id/pdf — Generate PDF report
router.get('/runs/:id/pdf', async (req, res) => {
  try {
    const run = await db.runs.getById(parseInt(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status !== 'completed') {
      return res.status(400).json({ error: 'Run not completed — cannot generate report' });
    }
    const pdfBytes = await generateStructuralPDF(run);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="atlantist-structural-run-${run.id}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[structural] PDF generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DAG Member Extraction ────────────────────────────────────────────────

/**
 * Walk the DAG (elements + levels) and extract structural members
 * from placed BIM elements. Creates structural_members records for
 * columns, beams, walls tagged as shear walls, and floor slabs.
 */
router.get('/dag-extract', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    // Get levels for elevation binding
    const levelsRes = await pool.query(
      'SELECT id, name, elevation FROM levels WHERE project_id = $1 ORDER BY elevation ASC',
      [project_id]
    );
    const levels = levelsRes.rows;

    // Get columns
    const colsRes = await pool.query(
      `SELECT id, element_type, name, parameters, computed_values, level_id
       FROM elements WHERE project_id = $1 AND element_type = 'column'
       AND parameters->>'structural' != 'false'`,
      [project_id]
    );

    // Get walls (structural/shear walls)
    const wallsRes = await pool.query(
      `SELECT id, element_type, name, parameters, computed_values, level_id
       FROM elements WHERE project_id = $1 AND element_type = 'wall'
       AND (parameters->>'is_shear_wall' = 'true' OR parameters->>'structural' = 'true')
       LIMIT 200`,
      [project_id]
    );

    // Get beams (structural beams)
    const beamsRes = await pool.query(
      `SELECT id, element_type, name, parameters, computed_values, level_id
       FROM elements WHERE project_id = $1 AND element_type IN ('beam','structural_beam')
       LIMIT 200`,
      [project_id]
    );

    // Get floor slabs
    const floorsRes = await pool.query(
      `SELECT id, base_level_id, top_level_id, parameters, name
       FROM floors WHERE project_id = $1 LIMIT 100`,
      [project_id]
    );

    const created = [];
    
    // Extract columns → structural members
    for (const col of colsRes.rows) {
      const params = col.parameters || {};
      const computed = col.computed_values || {};
      const level = levels.find(l => l.id === col.level_id);
      const baseLevel = level;

      // Column spans from base level to next level up
      const topLevel = levels.find(l => l.elevation > (baseLevel?.elevation || 0));
      const startY = baseLevel ? baseLevel.elevation * 1000 : 0; // mm
      const endY = topLevel ? topLevel.elevation * 1000 : (startY + 4000); // default 4m

      // Position from computed values or parameters
      const x = params.x || computed.x || computed.start_coord?.x || 0;
      const z = params.z || computed.z || computed.start_coord?.z || 0;

      const material = params.material_type || 'steel';
      const section = params.section_name || (material === 'steel' ? 'W14x48' : material === 'concrete' ? '18x18' : '6x6');

      const member = await db.members.create({
        project_id,
        element_id: col.id,
        name: col.name || `Column ${col.id}`,
        member_type: 'column',
        material_type: material,
        section_name: section,
        start_node: { x, y: startY, z: 0 },
        end_node: { x, y: endY, z: 0 },
        length_m: computed.height_m || (endY - startY) / 1000,
        properties: {
          Fy: params.Fy || 50,
          KL: params.KL || 15,
          Lb: params.Lb || 10,
          b: params.b || 18,
          h: params.h || 18,
          fc: params.fc || 4000,
          ...params,
        },
      });
      created.push(member);
    }

    // Extract beams → structural members
    for (const beam of beamsRes.rows) {
      const params = beam.parameters || {};
      const computed = beam.computed_values || {};
      const level = levels.find(l => l.id === beam.level_id);
      const y = level ? level.elevation * 1000 : 0;

      const startX = computed.start_coord?.x || params.start_x || 0;
      const startZ = computed.start_coord?.z || params.start_z || 0;
      const endX = computed.end_coord?.x || params.end_x || startX + 6000;
      const endZ = computed.end_coord?.z || params.end_z || startZ;

      const material = params.material_type || 'steel';
      const section = params.section_name || (material === 'steel' ? 'W14x48' : '2x10');

      const member = await db.members.create({
        project_id,
        element_id: beam.id,
        name: beam.name || `Beam ${beam.id}`,
        member_type: 'beam',
        material_type: material,
        section_name: section,
        start_node: { x: startX, y, z: startZ },
        end_node: { x: endX, y, z: endZ },
        length_m: computed.length_m || Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endZ - startZ, 2)) / 1000,
        properties: {
          Fy: params.Fy || 50,
          Lb: params.Lb || 10,
          ...params,
        },
      });
      created.push(member);
    }

    // Extract shear walls → structural members
    for (const wall of wallsRes.rows) {
      const params = wall.parameters || {};
      const computed = wall.computed_values || {};
      const level = levels.find(l => l.id === wall.level_id);
      const y = level ? level.elevation * 1000 : 0;

      const startX = computed.start_coord?.x || params.start_x || 0;
      const startZ = computed.start_coord?.z || params.start_z || 0;
      const endX = computed.end_coord?.x || params.end_x || startX + 3000;
      const endZ = computed.end_coord?.z || params.end_z || startZ;

      const thickness = params.thickness_mm || computed.thickness_mm || 200;
      const material = 'concrete';
      const section = `Wall_${Math.round(thickness)}mm`;

      const member = await db.members.create({
        project_id,
        element_id: wall.id,
        name: wall.name || `Shear Wall ${wall.id}`,
        member_type: 'brace',
        material_type: material,
        section_name: section,
        start_node: { x: startX, y, z: startZ },
        end_node: { x: endX, y, z: endZ },
        length_m: computed.length_m || Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endZ - startZ, 2)) / 1000,
        properties: {
          fc: params.fc || 4000,
          thickness_mm: thickness,
          ...params,
        },
      });
      created.push(member);
    }

    // Extract floor slabs → structural members
    for (const floor of floorsRes.rows) {
      const params = floor.parameters || {};
      const baseLevel = levels.find(l => l.id === floor.base_level_id);
      const topLevel = levels.find(l => l.id === floor.top_level_id);
      const elevation = baseLevel ? baseLevel.elevation * 1000 : 0;
      const boundary = params.boundary_polygon || [];

      if (boundary.length >= 3) {
        // Create slab as a panel member (4 nodes)
        const xs = boundary.map(p => p.x || p[0] || 0);
        const zs = boundary.map(p => p.z || p[1] || 0);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minZ = Math.min(...zs), maxZ = Math.max(...zs);
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;

        const member = await db.members.create({
          project_id,
          element_id: floor.id,
          name: floor.name || `Slab ${floor.id}`,
          member_type: 'beam',
          material_type: 'concrete',
          section_name: params.floor_type || '6" Composite',
          start_node: { x: cx, y: elevation, z: cz },
          end_node: { x: cx + (maxX - minX), y: elevation, z: cz + (maxZ - minZ) },
          length_m: params.area_sqm || 0,
          properties: {
            fc: params.fc || 4000,
            thickness_mm: params.thickness_mm || 150,
            area_sqm: params.area_sqm || 0,
            ...params,
          },
        });
        created.push(member);
      }
    }

    res.json({
      members: created,
      summary: {
        columns: colsRes.rows.length,
        beams: beamsRes.rows.length,
        shear_walls: wallsRes.rows.length,
        slabs: floorsRes.rows.length,
        total_created: created.length,
      },
    });
  } catch (err) {
    console.error('[structural] dag-extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── OpenSees Export ────────────────────────────────────────────────────────

router.post('/opensees-export', async (req, res) => {
  try {
    const { project_id, analysis_type, parameters } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    const members = await db.members.listByProject(project_id);
    const tcl = engine.generateOpenSeesInput({
      members: members.map(m => ({
        id: m.id, name: m.name, member_type: m.member_type,
        material_type: m.material_type, section_name: m.section_name,
        start_node: m.start_node, end_node: m.end_node,
        properties: m.properties,
      })),
      supports: parameters?.supports || [],
      loads: parameters?.loads || [],
      analysis_type: analysis_type || 'linear_static',
      seismic: parameters?.seismic || {},
    });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="atlantist_structural.tcl"');
    res.send(tcl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
