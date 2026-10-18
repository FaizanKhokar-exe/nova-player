import { defineConfig } from '@playwright/test';

/**
 * Phase 9: smoke test of the PACKAGED app (electron-builder's unpacked output, app.asar and all),
 * not of `out/main/index.js` run from source. Kept out of the default `playwright test` run on
 * purpose: it needs `pnpm --filter @nova/desktop run build:unpack` first. Run it with
 * `xvfb-run -a pnpm exec playwright test -c playwright.packaged.config.ts` (see RELEASING.md).
 */
export default defineConfig({
  testDir: './tests/packaged',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
