/**
 * BIM endpoint smoke test — hits every discipline route with the demo project.
 * Run after deploy: node scripts/smoke-bim-endpoints.js
 * Exits 0 on pass, 1 on any failure.
 */
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';

// Demo project seeded by migrations/1786051000000_demo_10story_seed.js
// Use project_id=1 as fallback (local dev), or pass SMOKE_PROJECT_ID env var
const PROJECT_ID = process.env.SMOKE_PROJECT_ID || '1';

const ENDPOINTS = [
  // Architecture / Core BIM
  { method: 'GET', path: `/api/levels?project_id=${PROJECT_ID}`, name: 'levels list' },
  { method: 'GET', path: `/api/elements?project_id=${PROJECT_ID}`, name: 'elements list' },
  { method: 'GET', path: `/api/families?project_id=${PROJECT_ID}`, name: 'family instances' },

  // Structural
  { method: 'GET', path: `/api/grids?project_id=${PROJECT_ID}`, name: 'structural grids' },
  { method: 'GET', path: `/api/structural/members?project_id=${PROJECT_ID}`, name: 'structural members' },

  // MEP
  { method: 'GET', path: `/api/mep-elements?project_id=${PROJECT_ID}`, name: 'MEP elements' },
  { method: 'GET', path: `/api/mep-fixtures?project_id=${PROJECT_ID}`, name: 'MEP fixtures catalog' },

  // Energy
  { method: 'GET', path: `/api/energy/simulations?project_id=${PROJECT_ID}`, name: 'energy simulations list' },

  // Fire Protection
  { method: 'GET', path: `/api/fire-protection/runs?project_id=${PROJECT_ID}`, name: 'fire protection runs' },

  // Geotechnical
  { method: 'GET', path: `/api/geotechnical/soil-profiles?project_id=${PROJECT_ID}`, name: 'soil profiles' },
  { method: 'GET', path: `/api/geotechnical/runs?project_id=${PROJECT_ID}`, name: 'geotechnical runs' },

  // Floors / Ceilings / Rooms / Stairs / Railings
  { method: 'GET', path: `/api/floors?project_id=${PROJECT_ID}`, name: 'floors' },
  { method: 'GET', path: `/api/ceilings?project_id=${PROJECT_ID}`, name: 'ceilings' },
  { method: 'GET', path: `/api/rooms?project_id=${PROJECT_ID}`, name: 'rooms' },
  { method: 'GET', path: `/api/stairs?project_id=${PROJECT_ID}`, name: 'stairs' },
  { method: 'GET', path: `/api/railings?project_id=${PROJECT_ID}`, name: 'railings' },

  // Annotations / Schedules / Grids
  { method: 'GET', path: `/api/annotations?project_id=${PROJECT_ID}`, name: 'annotations' },
  { method: 'GET', path: `/api/schedules/doors?project_id=${PROJECT_ID}`, name: 'door schedules' },
  { method: 'GET', path: `/api/schedules/windows?project_id=${PROJECT_ID}`, name: 'window schedules' },
  { method: 'GET', path: `/api/schedules/rooms?project_id=${PROJECT_ID}`, name: 'room schedules' },
  { method: 'GET', path: `/api/schedules/finishes?project_id=${PROJECT_ID}`, name: 'finish schedules' },
  // WHY: materials endpoint calls getMaterialTakeoff() which had a bug (doors missing .rows) — keep in smoke
  { method: 'GET', path: `/api/schedules/materials?project_id=${PROJECT_ID}`, name: 'material schedules' },
  { method: 'GET', path: `/api/schedules/all?project_id=${PROJECT_ID}`, name: 'all schedules' },

  // Curved surfaces
  { method: 'GET', path: `/api/curved-surfaces?project_id=${PROJECT_ID}`, name: 'curved surfaces' },

  // Issues
  { method: 'GET', path: `/api/issues?project_id=${PROJECT_ID}`, name: 'issues' },

  // Demo endpoints (public, no auth)
  { method: 'GET', path: '/api/demo/nyc-midrise', name: 'demo project lookup' },
  { method: 'GET', path: '/api/demo/nyc-midrise/stats', name: 'demo stats' },

  // Store search (was throwing SQL syntax error)
  { method: 'GET', path: '/api/store/search?q=door', name: 'store search' },
  { method: 'GET', path: '/api/store?page=1&limit=5', name: 'store browse' },

  // Health
  { method: 'GET', path: '/health', name: 'health check' },
];

async function runSmoke() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log(`\nBIM Smoke Test — ${BASE}\nProject ID: ${PROJECT_ID}\n${'─'.repeat(60)}`);

  for (const ep of ENDPOINTS) {
    const url = `${BASE}${ep.path}`;
    try {
      const res = await fetch(url, { method: ep.method, headers: { Accept: 'application/json' } });
      const ct = res.headers.get('content-type') || '';
      const isJson = ct.includes('application/json') || ct.includes('text/plain');

      let body;
      try { body = await res.json(); } catch { body = null; }

      if (res.status >= 500) {
        const msg = `HTTP ${res.status}: ${body?.error || 'unknown error'}`;
        console.error(`  ✗ FAIL [${res.status}] ${ep.name}: ${msg}`);
        failures.push({ ep, status: res.status, msg });
        failed++;
      } else if (!isJson && !ep.path.startsWith('/health')) {
        const msg = `Non-JSON content-type: ${ct}`;
        console.warn(`  ⚠ WARN [${res.status}] ${ep.name}: ${msg}`);
        // Don't count as hard fail — 401/403 from auth is acceptable in smoke
        passed++;
      } else {
        console.log(`  ✓ PASS [${res.status}] ${ep.name}`);
        passed++;
      }
    } catch (err) {
      const msg = `Network error: ${err.message}`;
      console.error(`  ✗ FAIL [net] ${ep.name}: ${msg}`);
      failures.push({ ep, status: 'net', msg });
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${ENDPOINTS.length} endpoints`);

  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) {
      console.error(`  ${f.ep.method} ${f.ep.path} — ${f.msg}`);
    }
    process.exit(1);
  }

  console.log('\nAll BIM endpoints passed smoke test ✓');
  process.exit(0);
}

runSmoke().catch(err => {
  console.error('Smoke test runner error:', err);
  process.exit(1);
});
