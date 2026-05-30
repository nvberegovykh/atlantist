// screenshot-all-features.js
// Uses Anchor browser CDP session for screenshots (no npm playwright binary needed)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'wss://connect.anchorbrowser.io/?sessionId=8be3e514-c5a6-468d-92c6-fde4db5e3161';
const BASE_URL = 'https://atlantist.cloud';
const OUT_DIR = path.join(__dirname, 'feature-screenshots');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const screenshots = [];
let page;

async function screenshot(name, description) {
  const filename = `${name}.png`;
  const filepath = path.join(OUT_DIR, filename);
  await page.screenshot({ path: filepath });
  const size = fs.statSync(filepath).size;
  screenshots.push({ name, description, filename, size: `${(size/1024).toFixed(0)}KB` });
  console.log(`  ✓ ${name}`);
}

async function run() {
  console.log('Connecting to Anchor CDP session...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    // 1. LANDING PAGE
    console.log('\n[1] Landing Page');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await screenshot('landing-hero', 'Atlantist hero section');
    await screenshot('landing-features', 'Feature grid');
    await screenshot('landing-pricing', 'Pricing tiers');
    await screenshot('landing-footer', 'Footer');

    // 2. APP CORE
    console.log('\n[2] App Core');
    try {
      await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);
      const url = page.url();
      if (url.includes('login') || url.includes('auth')) {
        await screenshot('app-login', 'Login page');
      } else {
        await screenshot('app-project-launcher', 'Project launcher');
        await screenshot('app-canvas-toolbar', 'BIM canvas with toolbar');
        await screenshot('app-viewport-grid', '2x2 viewport layout');
      }
    } catch (e) {
      console.log(`  → ${e.message}`);
    }

    // 3. ARCHITECTURE TOOLS
    console.log('\n[3] Architecture Tools');
    const archRoutes = [
      { path: '/app?tool=wall', name: 'wall-tool' },
      { path: '/app?tool=door', name: 'door-placement' },
      { path: '/app?tool=floor', name: 'floor-slab-tool' },
      { path: '/app?tool=stair', name: 'stair-tool' },
    ];
    for (const r of archRoutes) {
      try {
        await page.goto(`${BASE_URL}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1000);
        await screenshot(r.name, r.desc || r.name);
      } catch(e) {}
    }

    // 4. STRUCTURAL / OPENSEES
    console.log('\n[4] Structural Simulation');
    const structRoutes = [
      { path: '/opensees', name: 'structural-opensees' },
      { path: '/opensees?mode=deflection', name: 'structural-deflection' },
      { path: '/opensees?mode=results', name: 'structural-code-check' },
    ];
    for (const r of structRoutes) {
      try {
        await page.goto(`${BASE_URL}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);
        await screenshot(r.name, r.name);
      } catch(e) {}
    }

    // 5. MEP SIMULATION
    console.log('\n[5] MEP Simulation');
    for (const name of ['mep-hvac', 'mep-plumbing', 'mep-electrical', 'mep-fire-protection']) {
      try {
        await page.goto(`${BASE_URL}/${name}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);
        await screenshot(name, name);
      } catch(e) {}
    }

    // 6. ENERGY SIMULATION
    console.log('\n[6] Energy Simulation');
    for (const name of ['energy-results', 'energy-timeline', 'energy-compliance', 'energy-workbook']) {
      try {
        await page.goto(`${BASE_URL}/${name}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);
        await screenshot(name, name);
      } catch(e) {}
    }

    // 7. FIRE PROTECTION
    console.log('\n[7] Fire Protection');
    try {
      await page.goto(`${BASE_URL}/fire-protection`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(2000);
      await screenshot('fire-protection-fds', 'FDS panel');
      await screenshot('fire-protection-nfpa', 'NFPA compliance');
    } catch(e) {}

    // 8. DOCUMENTATION & EXPORT
    console.log('\n[8] Documentation & Export');
    for (const name of ['design-book', 'design-book-procurement', 'dob-package', 'export-ifc', 'export-dxf']) {
      try {
        await page.goto(`${BASE_URL}/${name}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);
        await screenshot(name, name);
      } catch(e) {}
    }

    // 9. IMPORT
    console.log('\n[9] Import');
    for (const name of ['rvt-import', 'ifc-export', 'gbxml-export']) {
      try {
        await page.goto(`${BASE_URL}/${name}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);
        await screenshot(name, name);
      } catch(e) {}
    }

  } finally {
    await browser.close();
  }

  // Write manifest
  const manifest = { date: '2026-05-26', baseUrl: BASE_URL, total: screenshots.length, screenshots };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n✓ Captured ${screenshots.length} screenshots`);
  for (const s of screenshots) console.log(`  ${s.filename} — ${s.size} — ${s.description}`);
}

run().catch(e => { console.error(e.message); process.exit(1); });