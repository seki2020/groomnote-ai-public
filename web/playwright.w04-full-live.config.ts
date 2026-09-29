import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./live", testMatch: "w04-full-live.spec.ts", timeout: 180_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5178", browserName: "chromium", channel: "chrome" },
});
