import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 10000,
    hookTimeout: 30000,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Force serial — tests share a database, parallel breaks invariants.
        singleFork: true,
      },
    },
  },
});
