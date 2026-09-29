import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Database test files share one Postgres and Kysely's migrator introspects every
    // schema, so a file dropping its schema can break another's migration (cr-r0m).
    fileParallelism: false,
    exclude: ['.cerebro/**', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['packages/ui/src/test-setup.ts'],
  },
});
