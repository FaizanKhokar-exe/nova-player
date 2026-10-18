import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@nova/domain',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
