import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://localhost:5173', headless: true, trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: 'app', testIgnore: '**/recording.spec.ts' },
    { name: 'worker', testMatch: '**/recording.spec.ts', use: { baseURL: 'http://127.0.0.1:8787' } },
  ],
  webServer: [
    { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
    { command: 'node tests/fixtures/server.mjs', url: 'http://127.0.0.1:4174/test/requests', reuseExistingServer: !process.env.CI },
    { command: 'node tests/fixtures/worker-dev.mjs', url: 'http://127.0.0.1:8787/api/status', reuseExistingServer: !process.env.CI, timeout: 180000 },
  ],
});
