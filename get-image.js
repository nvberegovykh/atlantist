const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=a0232258-2c2c-4e1d-859c-b6cb4446baac');
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto('https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_138239/608bfc7a-69ce-41bc-b278-338f22009355.jpg', { timeout: 30000 });
  console.log('Status:', response.status());
  const buffer = await response.body();
  console.log('Size:', buffer.length);
  const fs = require('fs');
  fs.writeFileSync('public/og/manifesto.png', buffer);
  console.log('Saved!');
  await browser.close();
})();