import { defineConfig } from "@playwright/test";

// Uses the installed Google Chrome (channel "chrome"), so no browser download.
// Headless Chrome uses a software GL path; nothing here judges how it looks,
// only counts, pixels non-blank or black, and messages.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  timeout: 45000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "logs/e2e_results.json" }]],
  use: {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 720 },
    baseURL: "http://127.0.0.1:8080/",
  },
  webServer: {
    command: "node ../tools/serve.mjs --port 8080",
    url: "http://127.0.0.1:8080/index.html",
    reuseExistingServer: true,
    timeout: 15000,
  },
});
