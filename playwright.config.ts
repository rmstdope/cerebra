import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:14545", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec tsx tests/browser-fixture.ts",
    url: "http://127.0.0.1:14545/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
