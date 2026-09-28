import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['.cerebro/**', '**/node_modules/**', '**/dist/**'],
  },
});
