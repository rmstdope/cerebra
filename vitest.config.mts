import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['.cerebro/**', '**/node_modules/**', '**/dist/**'],
    // Test files run in parallel against one Postgres; on a busy machine a test
    // that spawns processes or migrates a schema can outlast the 5s default.
    testTimeout: 30_000,
    setupFiles: ['packages/ui/src/test-setup.ts'],
  },
});
