import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./live",
  testMatch: "w03-full-live.spec.ts",
  timeout: 90_000,
  use: { baseURL: "http://127.0.0.1:5175", browserName: "chromium", channel: "chrome" },
});
