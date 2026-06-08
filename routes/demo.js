/**
 * Owns: /api/demo/:slug — public demo project lookup and stats.
 * Does NOT own: auth, BIM element data, project management.
 * These routes are public (no auth required) so anonymous visitors
 * can load the demo project and download the DOB package without an account.
 */
const router = require('express').Router();
const pool = require('../db');
const { getProjectBySlug } = require('../db/projects');
const { generateDobPackage } = require('../services/energy-dob-package');

// SPECIFIC ROUTES FIRST — must precede /:slug wildcard or they'll be shadowed

// GET /api/demo/nyc-midrise/stats — summary stats for the 10-story demo
// Used by the demo landing page and /app demo badge
router.get('/nyc-midrise/stats', async (req, res) => {
  try {
    const projRes = await pool.query(
      `SELECT id, name FROM projects WHERE demo_slug = 'nyc-midrise' AND is_demo = TRUE LIMIT 1`
    );
    if (!projRes.rows[0]) return res.status(404).json({ error: 'NYC Mid-Rise demo not found' });
    const projectId = projRes.rows[0].id;

    const [
      levelRows, structRows, mepRows, roomRows, energyRow,
      structRun, mepSimRow, annotationRows,
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM levels WHERE project_id = $1`, [projectId]),
      pool.query(`SELECT COUNT(*) FROM structural_members WHERE project_id = $1`, [projectId]),
      pool.query(`SELECT COUNT(*) FROM mep_elements WHERE project_id = $1`, [projectId]),
      pool.query(`SELECT COUNT(*) FROM rooms WHERE project_id = $1`, [projectId]),
      pool.query(`SELECT results FROM energy_simulations WHERE project_id = $1 LIMIT 1`, [projectId]),
      pool.query(`SELECT member_results AS results, code_checks AS compliance FROM structural_analysis_runs WHERE project_id = $1 LIMIT 1`, [projectId]),
      pool.query(`SELECT hvac_results, plumbing_results, electrical_results FROM mep_simulation_runs WHERE project_id = $1 LIMIT 1`, [projectId]),
      pool.query(`SELECT COUNT(*) FROM annotations WHERE project_id = $1`, [projectId]),
    ]);

    // WHY: energy.results is TEXT; structural member_results is JSONB (already an object from pg)
    const energy = energyRow.rows[0]?.results
      ? (typeof energyRow.rows[0].results === 'string' ? JSON.parse(energyRow.rows[0].results) : energyRow.rows[0].results)
      : {};
    const struct  = structRun.rows[0];
    const structResults = struct?.results
      ? (typeof struct.results === 'string' ? JSON.parse(struct.results) : struct.results)
      : {};
    const mepSim = mepSimRow.rows[0] || {};

    const memberCount = Object.keys(structResults).length;
    const passCount   = Object.values(structResults).filter(m => m.status === 'PASS').length;

    res.json({
      name: projRes.rows[0].name,
      levels:        parseInt(levelRows.rows[0].count),
      columns:       parseInt(structRows.rows[0].count),
      mep_elements: parseInt(mepRows.rows[0].count),
      rooms:        parseInt(roomRows.rows[0].count),
      annotations:  parseInt(annotationRows.rows[0].count),
      energy: {
        annual_kwh:       energy.annual_electric_kwh,
        peak_cooling_kw:  energy.peak_cooling_kw,
        peak_heating_kw:  energy.peak_heating_kw,
        eui:              energy.total_eui,
        vav_zones:        energy.vav_zones,
      },
      structural: {
        member_count:   memberCount,
        pass_count,
        max_dcr:        Math.max(0, ...Object.values(structResults).map(m => m.dcr || 0)),
        analysis_status: 'complete',
      },
      mep: {
        // WHY: mep_simulation_runs columns are JSONB — pg returns them as objects, not strings
        hvac_zones:        mepSim.hvac_results ? (typeof mepSim.hvac_results === 'string' ? JSON.parse(mepSim.hvac_results) : mepSim.hvac_results).zones : 0,
        sprinkler_heads:   mepSim.plumbing_results ? (typeof mepSim.plumbing_results === 'string' ? JSON.parse(mepSim.plumbing_results) : mepSim.plumbing_results).sprinkler_head_count : 0,
        connected_load_kw: mepSim.electrical_results ? (typeof mepSim.electrical_results === 'string' ? JSON.parse(mepSim.electrical_results) : mepSim.electrical_results).total_connected_load_kw : 0,
      },
      dob_package_status: 'ready',
    });
  } catch (err) {
    console.error('[demo/stats]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/demo/nyc-midrise/dob-package — download pre-computed DOB submission PDF
// Returns a zip of 9 PDFs generated from the pre-seeded energy simulation.
// Works without auth — anonymous visitors can download the demo DOB package.
router.get('/nyc-midrise/dob-package', async (req, res) => {
  try {
    const projRes = await pool.query(
      `SELECT id FROM projects WHERE demo_slug = 'nyc-midrise' AND is_demo = TRUE LIMIT 1`
    );
    if (!projRes.rows[0]) return res.status(404).json({ error: 'NYC Mid-Rise demo not found' });
    const projectId = projRes.rows[0].id;

    const simRow = await pool.query(
      `SELECT * FROM energy_simulations WHERE project_id = $1 AND status = 'complete' LIMIT 1`,
      [projectId]
    );
    if (!simRow.rows[0]) {
      return res.status(404).json({ error: 'No completed energy simulation found.' });
    }
    const sim = simRow.rows[0];
    const { zipBuffer, zipName } = await generateDobPackage(sim, {
      projectName: '425 W 34th St — NYC Mid-Rise Demo',
      address:     '425 W 34th St, Manhattan, NY 10001',
      bin:         '1084889',
      borough:     'Manhattan',
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    console.error('[demo/dob-package]', err);
    res.status(500).json({ error: 'DOB package generation failed: ' + err.message });
  }
});

// POST /api/demo/seed — idempotent geometry seed for demo projects.
// Auto-run on first demo load to ensure BIM data is present.
// Safe to re-run — checks existence before each insert.
router.post('/seed', async (req, res) => {
  try {
    const projRes = await pool.query(
      `SELECT id, name FROM projects WHERE demo_slug = 'nyc-midrise' LIMIT 1`
    );
    if (!projRes.rows[0]) return res.status(404).json({ error: 'Demo project not found' });
    const projectId = projRes.rows[0].id;

    const client = await pool.connect();
    let seeded = [];
    try {
      await client.query('BEGIN');

      // Columns: 5×6 grid (A-E × 1-6), W14x90, base=Level1, top=Roof
      const colXs = [-7.62, -3.81, 0, 3.81, 7.62];
      const colZs = [-12.7, -7.62, -2.54, 2.54, 7.62, 12.7];
      for (const cx of colXs) {
        for (const cz of colZs) {
          const exists = await client.query(
            `SELECT id FROM elements WHERE project_id=$1 AND type='column' AND parameters->>'x'=$2 AND parameters->>'z'=$3 LIMIT 1`,
            [projectId, cx.toFixed(2), cz.toFixed(2)]
          );
          if (exists.rows[0]) continue;
          const id = genUuid();
          await client.query(`
            INSERT INTO elements (id,project_id,type,type_name,name,base_level_id,top_level_id,parameters,computed,created_at,updated_at)
            VALUES ($1,$2,'column','ct-w14x48',$3,'1f6ef012-2eee-4a3a-b5db-1c11ae73122e','6111e6cd-35cb-429b-b8ca-cf1df9e98d47',$4,$5,NOW(),NOW())`,
            [id, projectId, `Col ${colName(cx,cz)}`,
             JSON.stringify({ x: cx, z: cz }),
             JSON.stringify({ height: 36.576, section: 'W14x90', structural: true })]
          );
          seeded.push('col');
        }
      }

      // Upper-level walls: corridor north + unit divider X=5.8 for L2–L10
      const levelPairs = [
        ['2fa5498b','3c38ccfe',2],['3c38ccfe','b870091b',3],['b870091b','0b564d21',4],
        ['0b564d21','8e5d7c8f',5],['8e5d7c8f','2e1ddcca',6],['2e1ddcca','7230f638',7],
        ['7230f638','e20e0922',8],['e20e0922','4f149b4e',9],['4f149b4e','6111e6cd',10],
      ];
      for (const [base8, top8, lvlnum] of levelPairs) {
        const baseLvl = `00000000-0000-0000-0000-000000000${base8}`.replace(/0+$/, base8.padEnd(12,'0'));
        // Reconstruct properly
        const baseId = levelIdFrom8(base8);
        const topId  = levelIdFrom8(top8);

        const nExists = await client.query(
          `SELECT id FROM elements WHERE project_id=$1 AND type='wall' AND name=$2 LIMIT 1`,
          [projectId, `Corridor North L${lvlnum}`]
        );
        if (!nExists.rows[0]) {
          const id = genUuid();
          await client.query(`
            INSERT INTO elements (id,project_id,type,type_name,name,base_level_id,top_level_id,parameters,computed,created_at,updated_at)
            VALUES ($1,$2,'wall','wt-interior-gypsum',$3,$4,$5,$6,$7,NOW(),NOW())`,
            [id, projectId, `Corridor North L${lvlnum}`, baseId, topId,
             JSON.stringify({startCoord:{x:-1.2,y:-15.24},endCoord:{x:1.2,y:-15.24},thickness:0.152}),
             JSON.stringify({height:3.658,length:2.4,thickness:0.152})]
          );
          seeded.push('wall');
        }
        const uExists = await client.query(
          `SELECT id FROM elements WHERE project_id=$1 AND type='wall' AND name=$2 LIMIT 1`,
          [projectId, `Unit Divider X=5.8 L${lvlnum}`]
        );
        if (!uExists.rows[0]) {
          const id = genUuid();
          await client.query(`
            INSERT INTO elements (id,project_id,type,type_name,name,base_level_id,top_level_id,parameters,computed,created_at,updated_at)
            VALUES ($1,$2,'wall','5b864d29-88b9-4bc9-ac2e-89353fc30758',$3,$4,$5,$6,$7,NOW(),NOW())`,
            [id, projectId, `Unit Divider X=5.8 L${lvlnum}`, baseId, topId,
             JSON.stringify({startCoord:{x:5.77,y:-15.24},endCoord:{x:5.77,y:15.24},thickness:0.305}),
             JSON.stringify({height:3.658,length:30.48,thickness:0.305})]
          );
          seeded.push('wall');
        }
      }

      await client.query('COMMIT');
      const counts = await pool.query(
        `SELECT type, COUNT(*) FROM elements WHERE project_id=$1 GROUP BY type`,
        [projectId]
      );
      res.json({ seeded: seeded.length > 0, counts: counts.rows, message: 'Geometry seed complete' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[demo/seed]', err);
    res.status(500).json({ error: err.message });
  }
});

function colName(cx, cz) {
  const xNames = ['A','B','C','D','E'];
  const zNames = ['1','2','3','4','5','6'];
  const xi = xNames[Math.round((cx + 7.62) / 3.81)] || '?';
  const zi = zNames[Math.round((cz + 12.7) / 5.08)] || '?';
  return `${xi}${zi}`;
}

function levelIdFrom8(s) {
  return `00000000-0000-4000-8000-000000000${s}`.replace(/(.+$)/, (_, m) => m.padStart(12,'0'));
}

function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// GET /api/demo/snowdon — Snowdon Visitor Centre demo
// Returns project metadata + seeded geometry (walls, slabs, columns, levels).
// Auto-seeds on first call if elements table is empty for this project.
router.get('/snowdon', async (req, res) => {
  try {
    // Resolve project — prefer snowdon demo slug, fall back to nyc-midrise
    let projRes = await pool.query(
      `SELECT id, name FROM projects WHERE demo_slug = 'snowdon' AND is_demo = TRUE LIMIT 1`
    );
    if (!projRes.rows[0]) {
      projRes = await pool.query(
        `SELECT id, name FROM projects WHERE demo_slug = 'nyc-midrise' AND is_demo = TRUE LIMIT 1`
      );
    }
    if (!projRes.rows[0]) return res.status(404).json({ error: 'Demo project not found' });
    const projectId = projRes.rows[0].id;
    const projectName = projRes.rows[0].name || 'Snowdon Visitor Centre';

    // Ensure levels exist — Ground (0 m) and Roof (3.5 m)
    let lvlRes = await pool.query(
      `SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC`, [projectId]
    );
    let groundId, roofId;
    if (lvlRes.rows.length < 2) {
      // Seed levels idempotently
      const g = await pool.query(
        `INSERT INTO levels (name, elevation, is_building_storey, phase, project_id)
         VALUES ('Ground Floor', 0, true, 'New Construction', $1)
         ON CONFLICT DO NOTHING RETURNING id`, [projectId]
      );
      const r = await pool.query(
        `INSERT INTO levels (name, elevation, is_building_storey, phase, project_id)
         VALUES ('Roof', 3.5, false, 'New Construction', $1)
         ON CONFLICT DO NOTHING RETURNING id`, [projectId]
      );
      lvlRes = await pool.query(
        `SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC`, [projectId]
      );
    }
    groundId = lvlRes.rows[0]?.id;
    roofId   = lvlRes.rows[lvlRes.rows.length - 1]?.id;

    // Check if geometry already seeded
    const elCheck = await pool.query(
      `SELECT COUNT(*) FROM elements WHERE project_id = $1`, [projectId]
    );
    const elCount = parseInt(elCheck.rows[0].count, 10);

    if (elCount === 0 && groundId && roofId) {
      // Seed Snowdon Visitor Centre geometry — 24m x 12m rectangular pavilion
      // Based on Zaha Hadid's Snowdon Visitor Centre programme: single-storey
      // rectilinear volume, flat roof, exposed concrete columns at 6m grid.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const W = 24, D = 12, H = 3.5, THICK = 0.3, COL_H = 3.5;

        // Perimeter walls — 8 segments (corners at 0,0 / 24,0 / 24,12 / 0,12)
        const walls = [
          // South wall
          { name: 'Wall-S1', sx:  0, sy:  0, ex: 12, ey:  0 },
          { name: 'Wall-S2', sx: 12, sy:  0, ex: 24, ey:  0 },
          // East wall
          { name: 'Wall-E1', sx: 24, sy:  0, ex: 24, ey:  6 },
          { name: 'Wall-E2', sx: 24, sy:  6, ex: 24, ey: 12 },
          // North wall
          { name: 'Wall-N1', sx: 24, sy: 12, ex: 12, ey: 12 },
          { name: 'Wall-N2', sx: 12, sy: 12, ex:  0, ey: 12 },
          // West wall
          { name: 'Wall-W1', sx:  0, sy: 12, ex:  0, ey:  6 },
          { name: 'Wall-W2', sx:  0, sy:  6, ex:  0, ey:  0 },
        ];
        for (const w of walls) {
          const ex = await client.query(
            `SELECT id FROM elements WHERE project_id=$1 AND name=$2 LIMIT 1`,
            [projectId, w.name]
          );
          if (!ex.rows[0]) {
            await client.query(`
              INSERT INTO elements
                (project_id, type, type_name, name, base_level_id, top_level_id, parameters, computed, created_at, updated_at)
              VALUES ($1,'wall','wt-concrete-300',$2,$3,$4,$5,$6,NOW(),NOW())`,
              [
                projectId, w.name, groundId, roofId,
                JSON.stringify({ startCoord:{x:w.sx,y:w.sy}, endCoord:{x:w.ex,y:w.ey}, thickness: THICK }),
                JSON.stringify({ height: H, thickness: THICK,
                  length: Math.sqrt((w.ex-w.sx)**2+(w.ey-w.sy)**2) })
              ]
            );
          }
        }

        // Columns — 4×2 grid at 6m spacing (5 cols × 3 rows inner + corners = corners only here)
        const cols = [
          { name:'Col-A1', x: 0, z: 0  }, { name:'Col-B1', x: 6, z: 0  },
          { name:'Col-C1', x:12, z: 0  }, { name:'Col-D1', x:18, z: 0  }, { name:'Col-E1', x:24, z: 0  },
          { name:'Col-A2', x: 0, z: 6  }, { name:'Col-C2', x:12, z: 6  }, { name:'Col-E2', x:24, z: 6  },
          { name:'Col-A3', x: 0, z:12  }, { name:'Col-B3', x: 6, z:12  },
          { name:'Col-C3', x:12, z:12  }, { name:'Col-D3', x:18, z:12  }, { name:'Col-E3', x:24, z:12  },
        ];
        for (const c of cols) {
          const ex = await client.query(
            `SELECT id FROM elements WHERE project_id=$1 AND name=$2 LIMIT 1`,
            [projectId, c.name]
          );
          if (!ex.rows[0]) {
            await client.query(`
              INSERT INTO elements
                (project_id, type, type_name, name, base_level_id, top_level_id, parameters, computed, created_at, updated_at)
              VALUES ($1,'column','ct-concrete-300x300',$2,$3,$4,$5,$6,NOW(),NOW())`,
              [
                projectId, c.name, groundId, roofId,
                JSON.stringify({ x: c.x, z: c.z, section:'300x300' }),
                JSON.stringify({ height: COL_H, section:'300x300' })
              ]
            );
          }
        }

        // Flat roof slab
        const roofEx = await client.query(
          `SELECT id FROM elements WHERE project_id=$1 AND type='roof' LIMIT 1`, [projectId]
        );
        if (!roofEx.rows[0]) {
          await client.query(`
            INSERT INTO elements
              (project_id, type, type_name, name, base_level_id, top_level_id, parameters, computed, created_at, updated_at)
            VALUES ($1,'roof','rt-flat-concrete',$2,$3,$4,$5,$6,NOW(),NOW())`,
            [
              projectId, 'Roof Slab', roofId, roofId,
              JSON.stringify({ roof_style:'flat', width: W, depth: D, thickness: 0.2,
                footprint:[{x:0,y:0},{x:W,y:0},{x:W,y:D},{x:0,y:D}] }),
              JSON.stringify({ height: 0.2 })
            ]
          );
        }

        await client.query('COMMIT');
        console.log('[demo/snowdon] Geometry seeded for project', projectId);
      } catch (seedErr) {
        await client.query('ROLLBACK');
        console.error('[demo/snowdon] Seed error (non-fatal):', seedErr.message);
      } finally {
        client.release();
      }
    }

    // Fetch final elements and levels
    const [elements, levels] = await Promise.all([
      pool.query(`SELECT * FROM elements WHERE project_id = $1 ORDER BY type, id`, [projectId]),
      pool.query(`SELECT * FROM levels WHERE project_id = $1 ORDER BY elevation ASC`, [projectId]),
    ]);

    res.json({
      id:       projectId,
      name:     projectName,
      slug:     'snowdon',
      elements: elements.rows,
      levels:   levels.rows,
    });
  } catch (err) {
    console.error('[demo/snowdon]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/demo/:slug — public demo project lookup (catch-all, must be last)
router.get('/:slug', async (req, res) => {
  try {
    const project = await getProjectBySlug(req.params.slug);
    if (!project) {
      return res.status(404).json({ error: 'Demo project not found' });
    }
    res.json({
      id: project.id,
      name: project.name,
      type: project.type,
      description: project.description,
      is_demo: project.is_demo,
      demo_slug: project.demo_slug,
      settings: project.settings,
    });
  } catch (err) {
    console.error('[demo] GET /:slug', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;