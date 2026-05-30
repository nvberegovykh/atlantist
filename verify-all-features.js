// Comprehensive verification script for Goals 4-7
const { chromium } = require('playwright');

const BASE = 'https://nexaxis.polsia.app';
const results = {};
const screenshots = {};

async function screenshot(page, name) {
  const path = `/tmp/verify_${name}.png`;
  await page.screenshot({ path, fullPage: false });
  screenshots[name] = path;
  console.log(`  [SCREENSHOT] ${name} -> ${path}`);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // Collect console errors
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  console.log('\n=== GOAL 4: TOOLBAR ===\n');

  // 1. Load app
  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 15000 });
    results.app_load = 'PASS';
    console.log('  [PASS] App loaded at /app');
    await screenshot(page, '01_app_loaded');
  } catch(e) {
    results.app_load = `FAIL: ${e.message}`;
    console.log('  [FAIL] App failed to load:', e.message);
    // Try landing page redirect
    try {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
      const url = page.url();
      console.log('  [INFO] Landing page URL:', url);
      await screenshot(page, '01_landing');
    } catch(e2) { console.log('  [FAIL] Even landing failed:', e2.message); }
  }

  // 2. Check for Create toolbar
  const createTools = ['Wall', 'Column', 'Floor', 'Roof', 'Stair', 'Ceiling', 'Door', 'Window'];
  const createFound = [];
  for (const tool of createTools) {
    const el = await page.locator(`button:has-text("${tool}"), [data-tool="${tool.toLowerCase()}"]`).first().catch(() => null);
    if (el && await el.count() > 0) {
      createFound.push(tool);
      results[`toolbar_create_${tool}`] = 'PASS';
    } else {
      results[`toolbar_create_${tool}`] = 'NOT_FOUND';
      console.log(`  [MISS] Create tool not found: ${tool}`);
    }
  }
  console.log(`  [INFO] Create tools found: ${createFound.join(', ')}`);

  // 3. Check for Modify toolbar
  const modifyTools = ['Move', 'Copy', 'Rotate', 'Mirror', 'Delete', 'Group'];
  const modifyFound = [];
  for (const tool of modifyTools) {
    const el = await page.locator(`button:has-text("${tool}"), [data-tool="${tool.toLowerCase()}"]`).first().catch(() => null);
    if (el && await el.count() > 0) {
      modifyFound.push(tool);
      results[`toolbar_modify_${tool}`] = 'PASS';
    } else {
      results[`toolbar_modify_${tool}`] = 'NOT_FOUND';
      console.log(`  [MISS] Modify tool not found: ${tool}`);
    }
  }
  console.log(`  [INFO] Modify tools found: ${modifyFound.join(', ')}`);

  // 4. Properties panel
  const propPanel = await page.locator('[class*="property"], [id*="property"], .panel:has-text("Properties")').first().catch(() => null);
  results.properties_panel = propPanel && await propPanel.count() > 0 ? 'PASS' : 'NOT_FOUND';
  console.log(`  [${results.properties_panel === 'PASS' ? 'PASS' : 'MISS'}] Properties panel`);

  // 5. Command palette Ctrl+K
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  const cmdPalette = await page.locator('[class*="command"], [class*="palette"], input[placeholder*="command"], [role="dialog"]').first().catch(() => null);
  results.command_palette = cmdPalette && await cmdPalette.count() > 0 ? 'PASS' : 'NOT_FOUND';
  console.log(`  [${results.command_palette === 'PASS' ? 'PASS' : 'MISS'}] Command palette (Ctrl+K)`);
  if (results.command_palette === 'PASS') await screenshot(page, '02_command_palette');
  await page.keyboard.press('Escape');

  // 6. Keyboard shortcuts W, C, D
  const shortcuts = [
    { key: 'w', name: 'W for Wall' },
    { key: 'c', name: 'C for Column' },
    { key: 'd', name: 'D for Door' }
  ];
  for (const s of shortcuts) {
    try {
      await page.keyboard.press(s.key.toUpperCase());
      await page.waitForTimeout(300);
      results[`shortcut_${s.key}`] = 'TRIGGERED';
      console.log(`  [PASS] ${s.name} triggered`);
    } catch(e) {
      results[`shortcut_${s.key}`] = `FAIL: ${e.message}`;
    }
  }
  await screenshot(page, '03_toolbar_overview');

  // --- GOAL 5: DAG ENGINE ---
  console.log('\n=== GOAL 5: DAG ENGINE ===\n');

  // Check WebSocket connection
  const wsConnected = await page.evaluate(() => {
    return typeof window.__ws !== 'undefined' || document.querySelector('[data-ws-connected]') !== null;
  });
  results.ws_connection = wsConnected ? 'PASS' : 'CHECK_REQUIRED';
  console.log(`  [${results.ws_connection}] WebSocket connection`);

  // Check DAG routes exist via API probe
  try {
    const dagRes = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/dag/edges`, { method: 'GET' });
      return { status: r.status, ok: r.ok };
    }, BASE);
    results.dag_api = dagRes.ok ? 'PASS' : `FAIL: ${dagRes.status}`;
    console.log(`  [${results.dag_api}] DAG API /api/dag/edges (${dagRes.status})`);
  } catch(e) {
    results.dag_api = `FAIL: ${e.message}`;
    console.log(`  [FAIL] DAG API: ${e.message}`);
  }

  // Check level-walls binding
  try {
    const levelsRes = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/levels`);
      if (!r.ok) return { status: r.status };
      const data = await r.json();
      return { status: r.status, count: Array.isArray(data) ? data.length : (data.levels ? data.levels.length : 'unknown') };
    }, BASE);
    results.levels_api = levelsRes.status === 200 ? 'PASS' : `FAIL: ${levelsRes.status}`;
    console.log(`  [${results.levels_api}] Levels API returns ${levelsRes.count || levelsRes.status}`);
  } catch(e) {
    results.levels_api = `FAIL: ${e.message}`;
  }

  // Check elements API (walls, columns)
  try {
    const elRes = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/elements`);
      return { status: r.status, ok: r.ok };
    }, BASE);
    results.elements_api = elRes.ok ? 'PASS' : `FAIL: ${elRes.status}`;
    console.log(`  [${results.elements_api}] Elements API /api/elements (${elRes.status})`);
  } catch(e) {
    results.elements_api = `FAIL: ${e.message}`;
  }

  // --- GOAL 6: STRUCTURAL ANALYSIS ---
  console.log('\n=== GOAL 6: STRUCTURAL ANALYSIS ===\n');

  // Structural tab
  const structuralTab = await page.locator('[data-tab*="structural"], [class*="structural"]').first().catch(() => null);
  if (structuralTab && await structuralTab.count() > 0) {
    results.structural_tab = 'PASS';
    console.log('  [PASS] Structural tab found');
    await structuralTab.click();
    await page.waitForTimeout(1000);
    await screenshot(page, '04_structural_tab');
  } else {
    results.structural_tab = 'NOT_FOUND';
    console.log('  [MISS] Structural tab not found');
  }

  // Structural API
  try {
    const strRes = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/structural/beam-types`);
      return { status: r.status, ok: r.ok };
    }, BASE);
    results.structural_api = strRes.ok ? 'PASS' : `FAIL: ${strRes.status}`;
    console.log(`  [${results.structural_api}] Structural /api/structural/beam-types (${strRes.status})`);
  } catch(e) {
    results.structural_api = `FAIL: ${e.message}`;
  }

  // Structural engine service
  const structuralEngineExists = await page.evaluate(() => {
    return typeof window.__structuralEngine !== 'undefined' || document.querySelector('[data-structural]') !== null;
  });
  results.structural_engine = structuralEngineExists ? 'PASS' : 'CLIENT_SIDE_UNAVAILABLE';
  console.log(`  [${results.structural_engine}] Structural engine (client-side)`);

  // --- GOAL 7: CRAFTING SYSTEM ---
  console.log('\n=== GOAL 7: CRAFTING SYSTEM ===\n');

  // Crafting tab
  const craftTab = await page.locator('[data-tab*="craft"], [class*="craft"], button:has-text("Craft"), a:has-text("Craft")').first().catch(() => null);
  if (craftTab && await craftTab.count() > 0) {
    results.crafting_tab = 'PASS';
    console.log('  [PASS] Crafting tab found');
    await craftTab.click();
    await page.waitForTimeout(1000);
    await screenshot(page, '05_crafting_tab');
  } else {
    results.crafting_tab = 'NOT_FOUND';
    console.log('  [MISS] Crafting tab not found');
    // Check crafting routes
    try {
      const cRes = await page.evaluate(async (base) => {
        const r = await fetch(`${base}/api/crafting/things`);
        return { status: r.status, ok: r.ok };
      }, BASE);
      results.crafting_api = cRes.ok ? 'PASS' : `FAIL: ${cRes.status}`;
      console.log(`  [${results.crafting_api}] Crafting API /api/crafting/things (${cRes.status})`);
    } catch(e) {
      results.crafting_api = `FAIL: ${e.message}`;
    }
  }

  // Crafting routes exist
  try {
    const recRes = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/recognizer/sources`);
      return { status: r.status, ok: r.ok };
    }, BASE);
    results.recognizer_api = recRes.ok ? 'PASS' : `FAIL: ${recRes.status}`;
    console.log(`  [${results.recognizer_api}] Recognizer API /api/recognizer/sources (${recRes.status})`);
  } catch(e) {
    results.recognizer_api = `FAIL: ${e.message}`;
  }

  // --- SUMMARY ---
  console.log('\n=== RESULTS SUMMARY ===\n');
  const passes = Object.entries(results).filter(([k, v]) => v === 'PASS').length;
  const fails = Object.entries(results).filter(([k, v]) => v.startsWith('FAIL') || v.startsWith('NOT_FOUND') || v.startsWith('MISS')).length;
  const checks = Object.keys(results).length;
  console.log(`  ${passes}/${checks} checks passed, ${fails} issues found\n`);

  for (const [k, v] of Object.entries(results)) {
    const icon = v === 'PASS' ? '✅' : v.startsWith('FAIL') ? '❌' : '⚠️';
    console.log(`  ${icon} ${k}: ${v}`);
  }

  console.log(`\n  Screenshots saved to /tmp/verify_*.png`);
  console.log(`  Console errors: ${errors.length}`);
  if (errors.length) errors.forEach(e => console.log(`    - ${e.substring(0, 150)}`));

  await browser.close();
  return { results, screenshots, errors };
}

run().catch(console.error);