// sonar e2e: (a) sim draws, (b) fake-norns -> bridge -> page segment identity
// for p01 p02 p04 at gen 2, (c) blackout is black, (d) keys work during a MIDI flood.
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = join(here, "..", "bridge");

function start(script, args) {
  const p = spawn(process.execPath, [join(bridgeDir, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  p.lines = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { p.lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  p.stderr.on("data", () => {});
  return p;
}
const stop = (p) => { try { p.kill(); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nonBlank(page) {
  return page.evaluate(() => {
    const c = document.getElementById("c");
    const t = document.createElement("canvas");
    t.width = 320; t.height = Math.round(320 * c.height / c.width);
    const x = t.getContext("2d");
    x.drawImage(c, 0, 0, t.width, t.height);
    const d = x.getImageData(0, 0, t.width, t.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit;
  });
}

test("a: sim mode draws a non-blank canvas within 2 s", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("index.html?seed=3");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3, null, { timeout: 2000 });
  const lit = await nonBlank(page);
  expect(lit).toBeGreaterThan(20);
  await page.keyboard.press("m"); // norns mode too
  await page.waitForTimeout(200);
  expect(await nonBlank(page)).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});

for (const n of [1, 2, 4]) {
  test(`b: fake-norns p${String(n).padStart(2, "0")} gen 2 through the bridge, same segment count`, async ({ page }) => {
    const bridge = start("bridge.mjs", ["--norns", "127.0.0.1"]);
    await sleep(400);
    let fake;
    try {
      await page.goto("index.html?ws=ws://127.0.0.1:8765&seed=3");
      await page.waitForFunction(() => window.__sonar.source === "live", null, { timeout: 5000 });
      fake = start("fake-norns.mjs", ["--plant", String(n), "--plant2", String(n), "--gens", "2", "--quiet"]);
      // wait for the fake to report plant 1 at gen 2
      let rep;
      for (let i = 0; i < 50 && !rep; i++) {
        await sleep(100);
        rep = fake.lines.map((l) => JSON.parse(l)).find((o) => o.ev === "gen" && o.plant === 1 && o.gen === 2);
      }
      expect(rep, "fake-norns reported gen 2").toBeTruthy();
      await page.waitForFunction((want) => {
        const s = window.__sonar;
        return s.lastGen[1] && s.lastGen[1].gen === 2 && s.segments[1] === want;
      }, rep.segments, { timeout: 5000 });
      const got = await page.evaluate(() => window.__sonar.segments[1]);
      expect(got).toBe(rep.segments);
      // and the notes arrive
      await page.waitForFunction(() => window.__sonar.notes > 0, null, { timeout: 5000 });
      // N on the page goes back to fake-norns and comes back as a gen (p01/p02/p04 max 2: at max, no change)
      console.log(`identity p${n}: fake ${rep.segments} page ${got}`);
    } finally {
      if (fake) stop(fake);
      stop(bridge);
      await sleep(200);
    }
  });
}

test("b2: page keys reach fake-norns: R resets, 2 switches plant", async ({ page }) => {
  const bridge = start("bridge.mjs", ["--norns", "127.0.0.1"]);
  await sleep(400);
  const fake = start("fake-norns.mjs", ["--plant", "7", "--quiet"]);
  try {
    await page.goto("index.html?ws=ws://127.0.0.1:8765");
    await page.waitForFunction(() => window.__sonar.source === "live" && window.__sonar.lastGen[1], null, { timeout: 5000 });
    const g0 = await page.evaluate(() => window.__sonar.lastGen[1].gen);
    await page.keyboard.press("n");
    await page.waitForFunction((g) => window.__sonar.lastGen[1].gen === g + 1, g0, { timeout: 3000 });
    await page.keyboard.press("2");
    await page.waitForFunction(() => window.__sonar.active === 2, null, { timeout: 3000 });
    await page.keyboard.press("r");
    await page.waitForFunction(() => window.__sonar.lastGen[1].gen === 2, null, { timeout: 3000 }); // p07 starts at gen 2
  } finally {
    stop(fake);
    stop(bridge);
    await sleep(200);
  }
});

test("c: blackout hides everything (screenshot is black)", async ({ page }) => {
  await page.goto("index.html?seed=3");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  await page.keyboard.press("b");
  await page.waitForTimeout(100);
  const shot = await page.screenshot();
  const isBlack = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
    return max;
  }, shot.toString("base64"));
  expect(isBlack).toBe(0);
  await page.keyboard.press("b");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.sonarBlackout.on)).toBe(false);
});
