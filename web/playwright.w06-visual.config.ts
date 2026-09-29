import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "w06-visual.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    channel: "chrome",
    viewport: { width: 1080, height: 810 },
    deviceScaleFactor: 1,
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  reporter: "list",
});
