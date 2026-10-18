import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@nova/ui',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
  },
});
