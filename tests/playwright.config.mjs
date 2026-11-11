import { defineConfig, devices } from "@playwright/test";

// The main suite uses the installed Google Chrome (channel "chrome"), so no browser download.
// Headless Chrome uses a software GL path; nothing here judges how it looks,
// only counts, pixels non-blank or black, and messages. The device suite runs in
// Playwright's WebKit (an iPhone-like engine on Windows, not iOS Safari).
const channel = process.env.PW_CHANNEL === undefined ? "chrome" : (process.env.PW_CHANNEL || undefined); // PW_CHANNEL="" uses the bundled Chromium
const device = (d) => ({ ...d, defaultBrowserType: "webkit", channel: undefined });
export default defineConfig({
  testDir: ".",
  timeout: 45000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "logs/e2e_results.json" }]],
  use: {
    headless: true,
    baseURL: process.env.SONAR_BASE || "http://127.0.0.1:8080/",
  },
  projects: [
    { name: "chrome", testMatch: /.*\.spec\.mjs/, testIgnore: /devices\.spec\.mjs/,
      use: { channel, viewport: { width: 1280, height: 720 }, launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } } },
    { name: "iphone13-portrait", testMatch: /devices\.spec\.mjs/, use: device(devices["iPhone 13"]) },
    { name: "iphone13-landscape", testMatch: /devices\.spec\.mjs/, use: device(devices["iPhone 13 landscape"]) },
    { name: "ipad", testMatch: /devices\.spec\.mjs/, use: device(devices["iPad (gen 7)"]) },
    { name: "desktop-1280", testMatch: /devices\.spec\.mjs/, use: { channel, viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: "node ../tools/serve.mjs --port 8080",
    url: "http://127.0.0.1:8080/index.html",
    reuseExistingServer: true,
    timeout: 15000,
  },
});
