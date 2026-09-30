import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./live", testMatch: ["w07-experiment-live.spec.ts", "w07-workflow-live.spec.ts"], timeout: 360000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5182", browserName: "chromium", channel: "chrome", permissions: ["microphone"] },
  webServer: { command: "npm run dev -- --config vite.w05-live.config.ts", url: "http://127.0.0.1:5182/", reuseExistingServer: true, timeout: 30000 },
});
