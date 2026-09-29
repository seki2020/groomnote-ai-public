import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "w05-workflow.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5181",
    browserName: "chromium",
    channel: "chrome",
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: "npm run dev -- --config vite.w05.config.ts",
    url: "http://127.0.0.1:5181/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
