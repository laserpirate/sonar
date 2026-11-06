// sonar Tier 4 stubs: ?kodama=1 phase keys, ?shanshui=1 weather/flood in, bridge --shanshui /av/midi out.
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = join(here, "..", "bridge");
const start = (s, a) => spawn(process.execPath, [join(bridgeDir, s), ...a], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("f: kodama phases W S D set the sim sequencer", async ({ page }) => {
  await page.goto("index.html?kodama=1&seed=3");
  await page.waitForFunction(() => window.__sonar && window.__sonar.kodama, null, { timeout: 3000 });
  await page.keyboard.press("d");
  expect(await page.evaluate(() => [window.__sonar.phase, window.__sonar.simOpts.duration, window.__sonar.simOpts.cfScalar])).toEqual(["dry", 0.5, 4]);
  await page.keyboard.press("w");
  expect(await page.evaluate(() => window.__sonar.phase)).toBe("wet");
  await expect(page.locator("#f-phase")).toContainText("wet");
});

test("g: shanshui flood and weather in, /av/midi out of the bridge", async ({ page }) => {
  const bridge = start("bridge.mjs", ["--norns", "127.0.0.1", "--shanshui"]);
  await sleep(400);
  const fake = start("fake-norns.mjs", ["--plant", "2", "--bpm", "240", "--quiet"]);
  try {
    await page.goto("index.html?ws=ws://127.0.0.1:8765&shanshui=1&seed=3");
    await page.waitForFunction(() => window.__sonar.source === "live", null, { timeout: 5000 });
    const got = await page.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:8765");
      let midi = null;
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.path === "/av/midi" && !midi) midi = m; };
      ws.onopen = () => {
        ws.send(JSON.stringify({ path: "/av/flood", args: [0.4] }));
        ws.send(JSON.stringify({ path: "/av/weather", args: [0.25] }));
        setTimeout(() => resolve({ midi, flood: window.__sonar.flood, weather: window.__sonar.weather }), 1500);
      };
    }));
    expect(got.flood).toBeCloseTo(0.4, 5);
    expect(got.weather).toBeCloseTo(0.25, 5);
    expect(got.midi && got.midi.midi.type).toBe("note");
  } finally {
    fake.kill(); bridge.kill(); await sleep(200);
  }
});
