import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Unit tests must not need the downloaded Electron binary (see tests/stubs/electron.ts).
  resolve: { alias: { electron: fileURLToPath(new URL('../../tests/stubs/electron.ts', import.meta.url)) } },
  test: {
    name: '@nova/infrastructure',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
