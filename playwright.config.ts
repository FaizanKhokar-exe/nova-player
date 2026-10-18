import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { actionTimeout: 10_000 }, // an action that cannot happen fails with its location instead of a bare test timeout
  reporter: [['list']],
});
