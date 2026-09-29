import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests", testMatch: "w04-tts.spec.ts", timeout: 90_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5176", browserName: "chromium", channel: "chrome" },
});
