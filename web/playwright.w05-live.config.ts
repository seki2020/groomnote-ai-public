import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./live",
  testMatch: "w05-full-live.spec.ts",
  timeout: 300_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5182",
    browserName: "chromium",
    channel: "chrome",
    permissions: ["microphone"],
  },
  webServer: {
    command: "npm run dev -- --config vite.w05-live.config.ts",
    url: "http://127.0.0.1:5182/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
