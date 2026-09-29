import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./live",
  testMatch: "w03-ai-live.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5174", browserName: "chromium", channel: "chrome" },
});
