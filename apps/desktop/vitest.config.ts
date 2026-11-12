import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Main-process and preload logic that is written to be Electron-free (the
// IPC handlers, DTO mappers, validation and the preload bridge factory) is
// unit-tested here; the real Electron wiring is covered by the Playwright E2E.
export default defineConfig({
  // Unit tests must not need the downloaded Electron binary (see tests/stubs/electron.ts).
  resolve: { alias: { electron: fileURLToPath(new URL('../../tests/stubs/electron.ts', import.meta.url)) } },
  test: {
    name: '@nova/desktop',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
