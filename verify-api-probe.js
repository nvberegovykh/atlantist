// Direct API verification — probe all critical endpoints
const https = require('https');

const BASE = 'https://nexaxis.polsia.app';
const results = {};

function httpGet(path) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { body = JSON.parse(body); } catch(e) {}
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body, bodyStr: body.toString().substring(0, 200) });
      });
    });
    req.on('error', e => resolve({ status: 0, ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
  });
}

async function main() {
  console.log('\n=== ATLANTIST FEATURE VERIFICATION ===\n');
  console.log(`Target: ${BASE}\n`);

  // Goal 4: Toolbar endpoints
  console.log('--- GOAL 4: TOOLBAR ---');
  const checks = [
    { name: 'GET /api/catalog/wall-types', path: '/api/catalog/wall-types', key: 'catalog_wall_types' },
    { name: 'GET /api/catalog/column-types', path: '/api/catalog/column-types', key: 'catalog_column_types' },
    { name: 'GET /api/catalog/door-types', path: '/api/catalog/door-types', key: 'catalog_door_types' },
    { name: 'GET /api/catalog/window-types', path: '/api/catalog/window-types', key: 'catalog_window_types' },
    { name: 'GET /api/catalog/floor-types', path: '/api/catalog/floor-types', key: 'catalog_floor_types' },
    { name: 'GET /api/catalog/ceiling-types', path: '/api/catalog/ceiling-types', key: 'catalog_ceiling_types' },
    { name: 'GET /api/catalog/roof-types', path: '/api/catalog/roof-types', key: 'catalog_roof_types' },
    { name: 'GET /api/catalog/stair-types', path: '/api/catalog/stair-types', key: 'catalog_stair_types' },
    { name: 'GET /api/families', path: '/api/families', key: 'families' },
    { name: 'GET /api/levels', path: '/api/levels', key: 'levels' },
    { name: 'GET /api/elements', path: '/api/elements', key: 'elements' },
    { name: 'GET /health', path: '/health', key: 'health' },
    { name: 'GET /', path: '/', key: 'landing' },
    { name: 'GET /app', path: '/app', key: 'app' },
  ];

  for (const c of checks) {
    const r = await httpGet(c.path);
    results[c.key] = r.ok ? 'PASS' : `FAIL: ${r.status}`;
    const icon = r.ok ? '✅' : '❌';
    const preview = r.bodyStr ? ` → ${r.bodyStr}` : '';
    console.log(`  ${icon} ${c.name}: ${r.status}${preview}`);
  }

  console.log('\n--- GOAL 5: DAG ENGINE ---');
  const dagChecks = [
    { name: 'GET /api/dag/edges', path: '/api/dag/edges', key: 'dag_edges' },
    { name: 'GET /api/dag/solve', path: '/api/dag/solve', key: 'dag_solve' },
    { name: 'GET /api/levels (check binding fields)', path: '/api/levels', key: 'levels_binding' },
  ];

  for (const c of dagChecks) {
    const r = await httpGet(c.path);
    results[c.key] = r.ok ? 'PASS' : `FAIL: ${r.status}`;
    const icon = r.ok ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${r.status}`);
    if (r.ok && r.body && typeof r.body === 'object') {
      const keys = Object.keys(r.body).slice(0, 5);
      console.log(`     keys: ${keys.join(', ')}`);
    }
  }

  // WS server check
  const wsCheck = await httpGet('/ws');
  results.ws_server = wsCheck.status !== 404 ? 'PASS' : `FAIL: ${wsCheck.status}`;
  console.log(`  ${wsCheck.status !== 404 ? '✅' : '❌'} WebSocket server at /ws: ${wsCheck.status}`);

  console.log('\n--- GOAL 6: STRUCTURAL ANALYSIS ---');
  const structChecks = [
    { name: 'GET /api/structural/beam-types', path: '/api/structural/beam-types', key: 'beam_types' },
    { name: 'GET /api/structural/members', path: '/api/structural/members', key: 'struct_members' },
    { name: 'GET /api/structural/analyze', path: '/api/structural/analyze', key: 'struct_analyze' },
    { name: 'GET /api/structural-audit/run', path: '/api/structural-audit/run', key: 'struct_audit' },
    { name: 'GET /api/structural-audit/beam-types', path: '/api/structural-audit/beam-types', key: 'struct_audit_beam_types' },
    { name: 'GET /api/structural/stair-types', path: '/api/structural/stair-types', key: 'stair_types' },
  ];

  for (const c of structChecks) {
    const r = await httpGet(c.path);
    results[c.key] = r.ok ? 'PASS' : `FAIL: ${r.status}`;
    const icon = r.ok ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${r.status}`);
  }

  // Check structural routes file exists
  const fs = require('fs');
  const structuralRoutes = fs.existsSync('./routes/structural.js');
  const structuralAuditRoutes = fs.existsSync('./routes/structural-audit.js');
  const structuralEngine = fs.existsSync('./services/structural-engine.js');
  const structuralAuditEngine = fs.existsSync('./services/structural-audit-engine.js');
  results.struct_routes = structuralRoutes ? 'PASS' : 'MISSING';
  results.struct_audit_routes = structuralAuditRoutes ? 'PASS' : 'MISSING';
  results.struct_engine_service = structuralEngine ? 'PASS' : 'MISSING';
  results.struct_audit_engine_service = structuralAuditEngine ? 'PASS' : 'MISSING';
  console.log(`  ${structuralRoutes ? '✅' : '❌'} routes/structural.js`);
  console.log(`  ${structuralAuditRoutes ? '✅' : '❌'} routes/structural-audit.js`);
  console.log(`  ${structuralEngine ? '✅' : '❌'} services/structural-engine.js`);
  console.log(`  ${structuralAuditEngine ? '✅' : '❌'} services/structural-audit-engine.js`);

  console.log('\n--- GOAL 7: CRAFTING SYSTEM ---');
  const craftChecks = [
    { name: 'GET /api/crafting/things', path: '/api/crafting/things', key: 'crafting_things' },
    { name: 'GET /api/crafting/recipes', path: '/api/crafting/recipes', key: 'crafting_recipes' },
    { name: 'GET /api/crafting/workbenches', path: '/api/crafting/workbenches', key: 'crafting_workbenches' },
    { name: 'GET /api/recognizer/sources', path: '/api/recognizer/sources', key: 'recognizer_sources' },
    { name: 'GET /api/sourcing/prices', path: '/api/sourcing/prices', key: 'sourcing_prices' },
  ];

  for (const c of craftChecks) {
    const r = await httpGet(c.path);
    results[c.key] = r.ok ? 'PASS' : `FAIL: ${r.status}`;
    const icon = r.ok ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${r.status}`);
  }

  // Check crafting service files
  const craftingRoutes = fs.existsSync('./routes/crafting.js');
  const recognizerRoutes = fs.existsSync('./routes/recognizer.js');
  const sourcingRoutes = fs.existsSync('./routes/sourcing.js');
  const craftingService = fs.existsSync('./services/crafting-engine.js');
  const recognizerService = fs.existsSync('./services/thing-recognizer.js');
  const sourcingService = fs.existsSync('./services/sourcing-engine.js');
  results.craft_routes = craftingRoutes ? 'PASS' : 'MISSING';
  results.recognizer_routes = recognizerRoutes ? 'PASS' : 'MISSING';
  results.sourcing_routes = sourcingRoutes ? 'PASS' : 'MISSING';
  results.craft_engine_service = craftingService ? 'PASS' : 'MISSING';
  results.recognizer_service = recognizerService ? 'PASS' : 'MISSING';
  results.sourcing_service = sourcingService ? 'PASS' : 'MISSING';
  console.log(`  ${craftingRoutes ? '✅' : '❌'} routes/crafting.js`);
  console.log(`  ${recognizerRoutes ? '✅' : '❌'} routes/recognizer.js`);
  console.log(`  ${sourcingRoutes ? '✅' : '❌'} routes/sourcing.js`);
  console.log(`  ${craftingService ? '✅' : '❌'} services/crafting-engine.js`);
  console.log(`  ${recognizerService ? '✅' : '❌'} services/thing-recognizer.js`);
  console.log(`  ${sourcingService ? '✅' : '❌'} services/sourcing-engine.js`);

  // Check crafting UI files
  const craftingUI = fs.existsSync('./public/js/crafting-ui.js');
  const craftingPalette = fs.existsSync('./public/js/crafting-palette.js');
  results.crafting_ui_js = craftingUI ? 'PASS' : 'MISSING';
  results.crafting_palette_js = craftingPalette ? 'PASS' : 'MISSING';
  console.log(`  ${craftingUI ? '✅' : '❌'} public/js/crafting-ui.js`);
  console.log(`  ${craftingPalette ? '✅' : '❌'} public/js/crafting-palette.js`);

  // Check structural UI
  const structuralPanel = fs.existsSync('./public/js/structural-panel.js');
  const structuralViz = fs.existsSync('./public/js/structural-viz.js');
  results.struct_ui_js = structuralPanel ? 'PASS' : 'MISSING';
  results.struct_viz_js = structuralViz ? 'PASS' : 'MISSING';
  console.log(`  ${structuralPanel ? '✅' : '❌'} public/js/structural-panel.js`);
  console.log(`  ${structuralViz ? '✅' : '❌'} public/js/structural-viz.js`);

  console.log('\n--- SUMMARY ---');
  const passed = Object.entries(results).filter(([k,v]) => v === 'PASS').length;
  const total = Object.keys(results).length;
  const failed = total - passed;
  console.log(`\n  ${passed}/${total} checks PASSED\n`);

  for (const [k, v] of Object.entries(results)) {
    const icon = v === 'PASS' ? '✅' : '❌';
    const cat = k.startsWith('catalog') ? '[G4]' : k.startsWith('dag') || k.startsWith('ws') || k.startsWith('levels') || k.startsWith('elements') ? '[G5]' : k.startsWith('struct') || k.startsWith('stair') || k.startsWith('beam') ? '[G6]' : k.startsWith('craft') || k.startsWith('recognizer') || k.startsWith('sourcing') ? '[G7]' : '[INFO]';
    console.log(`  ${icon} ${cat} ${k}: ${v}`);
  }

  if (failed > 0) {
    console.log(`\n  ⚠️  ${failed} items FAILED — fixing...`);
    return failed;
  } else {
    console.log('\n  🎉 All checks PASSED');
    return 0;
  }
}

main().then(failed => process.exit(failed > 0 ? 1 : 0)).catch(e => {
  console.error(e);
  process.exit(1);
});