const puppeteer = require('puppeteer');

const screenshots = [
  { name: 'landing-hero', url: 'https://atlantist.cloud' },
  { name: 'landing-pricing', url: 'https://atlantist.cloud/pricing' },
  { name: 'app-launcher', url: 'https://atlantist.cloud' },
];

(async () => {
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: 'wss://connect.anchorbrowser.io/?sessionId=1a49b1e9-21fc-454c-a93f-cdc7e0477a03',
    });
  } catch (e) {
    console.error('Failed to connect:', e.message);
    process.exit(1);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  for (const shot of screenshots) {
    try {
      await page.goto(shot.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));
      await page.screenshot({ path: `public/screenshots/${shot.name}.png`, fullPage: false });
      console.log(`✓ ${shot.name}`);
    } catch (e) {
      console.error(`✗ ${shot.name}: ${e.message}`);
    }
  }

  await browser.disconnect();
  console.log('Done.');
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});