import { defineConfig } from "@playwright/test";

/**
 * Browser verification for Phase 9's evidence pack: drives the running
 * stack (`docker compose up`, production build on :5173) in the locally
 * installed Chrome, so no browser download is needed. Override the target
 * with E2E_BASE_URL.
 */
export default defineConfig({
  testDir: ".",
  outputDir: "results",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    channel: "chrome",
    headless: true,
  },
});
