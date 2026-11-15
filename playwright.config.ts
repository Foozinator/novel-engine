import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke tests for the packaged Electron app.
 *
 * Run with `npm run test:e2e`, which packages the app first (`electron-forge package`)
 * and then launches the binary under `out/`. Unit tests stay in Vitest (`npm test`);
 * Vitest only collects `src/**` test files, so the two never overlap.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: {
    trace: 'retain-on-failure',
  },
});
