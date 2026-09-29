import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["w04-tts.spec.ts", "w05-workflow.spec.ts", "w06-visual.spec.ts"],
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", browserName: "chromium", channel: "chrome" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 30_000 },
});
