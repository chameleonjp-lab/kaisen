import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests",
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  projects: [
    { name: "webkit-ui", testMatch: /(?:mobile-settings-ui|throttle-lever-ui)\.spec\.ts/, use: { browserName: "webkit", launchOptions: {} } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/browser-results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4176",
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
