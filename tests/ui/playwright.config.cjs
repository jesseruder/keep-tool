const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: __dirname, testMatch: '*.spec.cjs', fullyParallel: false, workers: 1,
  timeout: 30000, retries: 0, forbidOnly: Boolean(process.env.CI),
  outputDir: '../../test-results/ui', reporter: [['list']],
  use: { viewport: { width: 1500, height: 950 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
});
