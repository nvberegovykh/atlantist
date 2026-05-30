import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=fdb4a0f3-b8b0-4005-9569-b7538c111e37');

const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();

const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', err => errors.push('PAGE_ERROR: ' + err.message));

// Test landing page
console.log('=== Landing Page ===');
await page.goto('https://atlantist.cloud/', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2000);
const landingErrors = [...errors];
errors.length = 0;
console.log('Title:', await page.title());
console.log('Errors:', landingErrors.length > 0 ? JSON.stringify(landingErrors) : 'none');
console.log('Body len:', await page.evaluate(() => document.body.innerHTML.length));
const bodyPreview = await page.evaluate(() => document.body.innerText.substring(0, 300));
console.log('Preview:', bodyPreview.replace(/\n/g, ' '));

// Check CTAs
const ctas = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('a[href], button'));
  return btns.slice(0, 15).map(b => ({ text: b.innerText?.trim().substring(0, 40), href: b.href || b.onclick ? 'fn' : 'none' }));
});
console.log('CTAs:', JSON.stringify(ctas));

// Test app page
console.log('\n=== BIM App ===');
await page.goto('https://atlantist.cloud/app', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(3000);
const appErrors = [...errors];
errors.length = 0;
console.log('Title:', await page.title());
console.log('Errors:', appErrors.length > 0 ? JSON.stringify(appErrors) : 'none');
console.log('Body len:', await page.evaluate(() => document.body.innerHTML.length));
const toolbar = await page.evaluate(() => document.getElementById('toolbar') ? 'TOOLBAR FOUND' : 'NO TOOLBAR');
console.log('Toolbar:', toolbar);
const canvas = await page.evaluate(() => document.getElementById('canvas-3d') ? 'CANVAS 3D FOUND' : 'NO CANVAS 3D');
console.log('Canvas3D:', canvas);

// Test contact page
console.log('\n=== Contact ===');
errors.length = 0;
await page.goto('https://atlantist.cloud/contact', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1000);
console.log('Title:', await page.title());
console.log('Errors:', errors.length > 0 ? JSON.stringify(errors) : 'none');
console.log('Body len:', await page.evaluate(() => document.body.innerHTML.length));

await browser.close();
console.log('\n=== Done ===');