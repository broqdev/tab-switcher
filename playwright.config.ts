import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Playwright clears its output directory. Preserve saved performance profiles.
  outputDir: './test-results/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/e2e/fixture-server.mjs',
    url: 'http://127.0.0.1:4173',
  },
});
