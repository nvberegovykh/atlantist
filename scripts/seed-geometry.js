/**
 * Seed geometry for the NYC Mid-Rise demo project (id: aabbccdd-...).
 * Idempotent — checks existence before each insert.
 * Run: node scripts/seed-geometry.js
 *
 * Current DB state (after initial seed):
 *   elements: 10 walls (L1 perimeter+core), 30 columns (5×6 grid), 28 walls total
 *   floors: 10 (one per level below roof)
 *   stairs: 10 (per-level runs, Entry Stair West, Exit Stair, Main Stair F3–F10)
 *   railings: 16
 *   structural_grids: 1 system ("Main Grid"), 11 grid lines (A-E, 1-6)
 *   rooms: 80 (9 per office floor L2–L9, 9 on L1, 2 on roof)
 *   ceilings: 10
 *
 * This script handles the COLUMNS and UPPER-LEVEL WALLS only (the gaps not seeded by prior runs).
 */
'use strict';

const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const PROJECT_ID = 'aabbccdd-0001-4000-8000-000000000001';

const LEVEL_IDS = {
  L1:  '1f6ef012-2eee-4a3a-b5db-1c11ae73122e',
  L2:  '2fa5498b-86fe-4057-96b6-f6b0215bfbed',
  L3:  '3c38ccfe-24bb-476c-9434-3211c0e3748f',
  L4:  'b870091b-a672-4e2f-843c-6c412fc4678e',
  L5:  '0b564d21-1d01-4010-ad89-b5f4af216968',
  L6:  '8e5d7c8f-63a9-4b5c-8570-5cc554790082',
  L7:  '2e1ddcca-8dda-479f-965e-ed7b3d1cba2c',
  L8:  '7230f638-c7c1-4947-84f4-6fc58b482925',
  L9:  'e20e0922-807f-42bf-bbc2-9cafa3428e49',
  L10: '4f149b4e-6a80-4ac0-8de0-03dc5c379930',
  Roof:'6111e6cd-35cb-429b-b8ca-cf1df9e98d47',
};

// Level pairs for upper-level walls (base → top)
const WALL_LEVEL_PAIRS = [
  [LEVEL_IDS.L2, LEVEL_IDS.L3, 2],
  [LEVEL_IDS.L3, LEVEL_IDS.L4, 3],
  [LEVEL_IDS.L4, LEVEL_IDS.L5, 4],
  [LEVEL_IDS.L5, LEVEL_IDS.L6, 5],
  [LEVEL_IDS.L6, LEVEL_IDS.L7, 6],
  [LEVEL_IDS.L7, LEVEL_IDS.L8, 7],
  [LEVEL_IDS.L8, LEVEL_IDS.L9, 8],
  [LEVEL_IDS.L9, LEVEL_IDS.L10, 9],
  [LEVEL_IDS.L10, LEVEL_IDS.Roof, 10],
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [PROJECT_ID]);
  if (!proj.rows[0]) { console.error('Project not found:', PROJECT_ID); process.exit(1); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let colsSeeded = 0, wallsSeeded = 0;

    // ── COLUMNS (5×6 structural grid) ────────────────────────────────────────
    const colXs = [-7.62, -3.81, 0, 3.81, 7.62];
    const colZs = [-12.7, -7.62, -2.54, 2.54, 7.62, 12.7];
    const xNames = ['A', 'B', 'C', 'D', 'E'];
    const zNames = ['1', '2', '3', '4', '5', '6'];
    for (let xi = 0; xi < colXs.length; xi++) {
      for (let zi = 0; zi < colZs.length; zi++) {
        const cx = colXs[xi], cz = colZs[zi];
        const exists = await client.query(
          `SELECT id FROM elements WHERE project_id=$1 AND type='column' AND parameters->>'x'=$2 AND parameters->>'z'=$3 LIMIT 1`,
          [PROJECT_ID, cx.toFixed(2), cz.toFixed(2)]
        );
        if (exists.rows[0]) { console.log(`  col ${xNames[xi]}${zNames[zi]} at (${cx},${cz}) exists, skipping`); continue; }
        const id = genUuid();
        await client.query(`
          INSERT INTO elements (id,project_id,type,type_name,name,base_level_id,top_level_id,parameters,computed,created_at,updated_at)
          VALUES ($1,$2,'column','ct-w14x48',$3,$4,$5,$6,$7,NOW(),NOW())`,
          [id, PROJECT_ID, `Col ${xNames[xi]}${zNames[zi]}`,
           LEVEL_IDS.L1, LEVEL_IDS.Roof,
           JSON.stringify({ x: cx, z: cz }),
           JSON.stringify({ height: 36.576, section: 'W14x90', structural: true })]
        );
        colsSeeded++;
      }
    }
    console.log(`✓ Columns: ${colsSeeded} seeded`);

    // ── UPPER-LEVEL WALLS (L2–L10) ───────────────────────────────────────────
    const intWall = 'wt-interior-gypsum';
    const extWall = '5b864d29-88b9-4bc9-ac2e-89353fc30758';
    for (const [baseLvl, topLvl, lvlnum] of WALL_LEVEL_PAIRS) {
      // Corridor North wall
      const nExists = await client.query(
        `SELECT id FROM elements WHERE project_id=$1 AND type='wall' AND name=$2 LIMIT 1`,
        [PROJECT_ID, `Corridor North L${lvlnum}`]
      );
      if (!nExists.rows[0]) {
        const id = genUuid();
        await client.query(`
          INSERT INTO elements (id,project_id,type,type_name,name,base_level_id,top_level_id,parameters,computed,created_at,updated_at)
          VALUES ($1,$2,'wall',$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
          [id, PROJECT_ID, intWall, `Corridor North L${lvlnum}`, baseLvl, topLvl,
           JSON.stringify({ startCoord: { x: -1.2, y: -15.24 }, endCoord: { x: 1.2, y: -15.24 }, thickness: 0.152 }),
           JSON.stringify({ height: 3.658, length: 2.4, thickness: 0.152 })]
        );
        wallsSeeded++;
      }
      // Unit divider at x = 5.77
      const uExists = await client.query(
        `SELECT id FROM elements WHERE project_id=$1 AND type='wall' AND name=$2 LIMIT 1`,
        [PROJECT_ID, `Unit Divider X=5.8 L${lvlnum}`]
      );
      if (!uExists.rows[0]) {
        const id = genUuid();
        await client.query(`
          INSERT INTO elements (id,project_id,type,type_name,name,base_level_id,top_level_id,parameters,computed,created_at,updated_at)
          VALUES ($1,$2,'wall',$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
          [id, PROJECT_ID, extWall, `Unit Divider X=5.8 L${lvlnum}`, baseLvl, topLvl,
           JSON.stringify({ startCoord: { x: 5.77, y: -15.24 }, endCoord: { x: 5.77, y: 15.24 }, thickness: 0.305 }),
           JSON.stringify({ height: 3.658, length: 30.48, thickness: 0.305 })]
        );
        wallsSeeded++;
      }
    }
    console.log(`✓ Upper-level walls: ${wallsSeeded} seeded`);

    await client.query('COMMIT');

    const total = await client.query(`SELECT type, COUNT(*) FROM elements WHERE project_id=$1 GROUP BY type`);
    console.log('\n✅ Seed complete for NYC Mid-Rise');
    console.log('  Element counts:', total.rows.map(r => `${r.type}: ${r.count}`).join(', '));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

main().catch(err => { console.error('Seed failed:', err); process.exit(1); });