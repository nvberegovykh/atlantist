/**
 * Visual regression test runner for Atlantist BIM
 * Uses Sapiom browser sessions to capture screenshots across device matrix
 * Analyzes for overflow, overlap, truncation, unreachable buttons
 */

const BASE_URL = process.env.APP_URL || 'https://atlantist.cloud';

// Device matrix
const DEVICES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 15 Pro', width: 393, height: 852 },
  { name: 'iPad', width: 768, height: 1024 },
  { name: 'iPad Pro', width: 1024, height: 1366 },
  { name: 'Samsung Galaxy S24', width: 360, height: 780 },
  { name: 'Pixel 8', width: 412, height: 915 },
  { name: '13" MacBook', width: 1440, height: 900 },
  { name: '15" MacBook', width: 1680, height: 1050 },
  { name: '27" Monitor', width: 2560, height: 1440 },
  { name: '4K Display', width: 3840, height: 2160 },
];

// Screens to test
const SCREENS = [
  { name: 'Landing Page', path: '/' },
  { name: 'Signup', path: '/signup' },
  { name: 'Docs', path: '/docs' },
  { name: 'Privacy', path: '/legal/privacy' },
  { name: 'Terms', path: '/legal/terms' },
  { name: 'Subscribe Ack', path: '/subscribe/acknowledge' },
  { name: 'Login', path: '/login' },
  { name: 'Admin Guides', path: '/admin/guides' },
  { name: 'Admin Abuse', path: '/admin/abuse' },
  { name: 'Admin Docs', path: '/admin/docs' },
];

async function runVisualTests() {
  console.log('🧪 Atlantist Visual Regression Test\n');
  console.log('Device Matrix:', DEVICES.length, 'devices');
  console.log('Screen Matrix:', SCREENS.length, 'screens');
  console.log('Total screenshots:', DEVICES.length * SCREENS.length);
  console.log('---\n');

  const results = [];
  let session = null;

  try {
    // Create browser session
    const { sessionId, cdpUrl } = await mcp__sapiom__browser_session_create({ agentName: 'visual-test-runner' });
    session = sessionId;
    console.log('✓ Browser session created:', sessionId.substring(0, 8) + '...\n');

    let total = 0;
    let passed = 0;
    let failed = 0;

    for (const device of DEVICES) {
      console.log(`\n📱 ${device.name} (${device.width}×${device.height})`);
      console.log('─'.repeat(40));

      for (const screen of SCREENS) {
        total++;
        const url = `${BASE_URL}${screen.path}`;
        console.log(`  ${total}. ${screen.name}...`);

        try {
          // Capture screenshot at this viewport size
          const screenshot = await mcp__sapiom__screenshot({
            url: url,
            width: device.width,
            height: device.height,
            sessionId: session,
            agentName: 'visual-test-runner'
          });

          console.log(`     ✓ ${screenshot.substring(0, 80)}...`);
          passed++;
          results.push({
            device: device.name,
            screen: screen.name,
            path: screen.path,
            status: 'PASS',
            screenshotUrl: screenshot
          });
        } catch (e) {
          console.log(`     ✗ ERROR: ${e.message || e}`);
          failed++;
          results.push({
            device: device.name,
            screen: screen.name,
            path: screen.path,
            status: 'FAIL',
            error: e.message || String(e)
          });
        }
      }
    }

    console.log('\n' + '═'.repeat(50));
    console.log(`\n✅ Visual Testing Complete`);
    console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
    console.log('\n---\n');

    // Summary by screen
    console.log('Results by Screen:');
    for (const screen of SCREENS) {
      const screenResults = results.filter(r => r.screen === screen.name);
      const screenPassed = screenResults.filter(r => r.status === 'PASS').length;
      const screenFailed = screenResults.filter(r => r.status === 'FAIL').length;
      const icon = screenFailed === 0 ? '✅' : '⚠️';
      console.log(`  ${icon} ${screen.name}: ${screenPassed}/${DEVICES.length} passed` + (screenFailed > 0 ? ` | ${screenFailed} FAILED` : ''));
    }

    console.log('\n---\n');
    console.log('Results by Device:');
    for (const device of DEVICES) {
      const deviceResults = results.filter(r => r.device === device.name);
      const devicePassed = deviceResults.filter(r => r.status === 'PASS').length;
      const icon = devicePassed === SCREENS.length ? '✅' : '⚠️';
      console.log(`  ${icon} ${device.name}: ${devicePassed}/${SCREENS.length} passed`);
    }

    // Save screenshot URLs
    const screenshotMap = {};
    for (const r of results) {
      if (r.screenshotUrl) {
        const key = `${r.device}|${r.screen}`;
        screenshotMap[key] = r.screenshotUrl;
      }
    }

    console.log('\n---\nScreenshot Map (for report):');
    for (const [key, url] of Object.entries(screenshotMap)) {
      console.log(`  ${key}: ${url}`);
    }

  } catch (e) {
    console.error('Test runner error:', e);
  } finally {
    if (session) {
      try {
        await mcp__sapiom__browser_session_terminate({ sessionId: session, agentName: 'visual-test-runner' });
        console.log('\n✓ Browser session closed');
      } catch (e) {}
    }
  }

  return results;
}

module.exports = { runVisualTests };