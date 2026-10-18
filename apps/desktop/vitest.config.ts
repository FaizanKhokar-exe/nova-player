import { defineConfig } from 'vitest/config';

// Main-process and preload logic that is written to be Electron-free (the
// IPC handlers, DTO mappers, validation and the preload bridge factory) is
// unit-tested here; the real Electron wiring is covered by the Playwright E2E.
export default defineConfig({
  test: {
    name: '@nova/desktop',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
