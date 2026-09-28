import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['.cerebro/**', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['packages/ui/src/test-setup.ts'],
  },
});
