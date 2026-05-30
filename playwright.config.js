/**
 * playwright.config.js
 *
 * Playwright end-to-end test configuration.
 * Run with: npx playwright test
 *
 * Target: https://atlantist.cloud (staging in CI)
 */
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },

  // Run tests in sequence to avoid race conditions in shared state
  workers: 1,
  fullyParallel: false,

  // Reporter
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/e2e/reports/html', open: 'never' }],
    ['json', { outputFile: 'tests/e2e/reports/results.json' }]
  ],

  use: {
    baseURL: process.env.APP_URL || 'https://atlantist.cloud',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    ignoreHTTPSErrors: true,
    headless: true
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],

  webServer: process.env.CI ? undefined : {
    command: 'npm start',
    port: 3000,
    timeout: 30000,
    reuseExistingServer: true
  }
});