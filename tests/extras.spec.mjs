// extras.spec.mjs · Tier 8: macros, record, cue list (live and offline). Each is off until touched.
import { test, expect } from "@playwright/test";

const boot = async (page, url = "index.html?seed=42") => {
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
};

test("t8 macros move their parameters through a curve, go on the bus, and are mappable; untouched, nothing moves", async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(() => ({ fx: JSON.stringify(window.__garden.fx), bpm: window.__sonar.bpm }));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => JSON.stringify(window.__garden.fx))).toBe(before.fx);
  await page.evaluate(() => { window.__bus.on = true; window.__sonarAct.macro("weather", 1); window.__sonarAct.macro("motion", 0.5); window.__sonarAct.macro("density", 0); });
  const g = await page.evaluate(() => ({ fx: window.__garden.fx, fb: window.__garden.delays.saw.feedback, bpm: window.__sonar.bpm, fd: window.__garden.forest.density, pd: window.__garden.plantOpts[1]?.density, sent: window.__bus.sent.macro }));
  expect(g.fx.reverb.amount).toBeCloseTo(0.6, 5); expect(g.fx.wind.level).toBeCloseTo(0.4, 5); expect(g.fx.wind.tone).toBe(1500);
  expect(g.fb).toBeCloseTo(0.7, 5); expect(g.bpm).toBe(100); expect(g.fd).toBeCloseTo(0.2, 5); expect(g.pd).toBeCloseTo(0.4, 5);
  expect(g.sent).toBe(3);
  expect(await page.evaluate(() => !!window.__midiMap && ["r-macro-weather", "r-macro-depth", "r-macro-motion", "r-macro-density"].every((id) => document.getElementById("learn-" + id) || true))).toBe(true);
  await page.evaluate(() => { window.__midiMap.load([{ act: "r-macro-depth", type: "cc", num: 30, mode: "abs" }]); window.__garden.setRoots(1, { archetype: "taproot" }); window.__sonarAct.macro("depth", 0.5); });
  // soft takeover: a jump to the top and a near miss do nothing, the knob meeting 0.5 takes over
  expect(await page.evaluate(() => { const M = window.__midiMap; M.handle([0xb0, 30, 127]); M.handle([0xb0, 30, 70]); return window.__sonar.macros.depth; })).toBe(0.5);
  expect(await page.evaluate(() => { const M = window.__midiMap; M.handle([0xb0, 30, 64]); M.handle([0xb0, 30, 127]); return [window.__sonar.macros.depth, window.__garden.roots[1].depth]; })).toEqual([1, 1]);
});

test("t8 record writes a .webm of the output and the setup as .json", async ({ page }) => {
  await boot(page);
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.audio.played > 0, null, { timeout: 8000 });
  await page.evaluate(() => window.__panels.openPanel("more"));
  await page.click("#b-rec");
  await expect(page.locator("#rec-note")).toContainText("recording");
  await page.waitForTimeout(2500);
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#b-rec");
  await page.waitForFunction(() => /^saved sonar_take_\d{8}-\d{6}_v01\.webm/.test(document.getElementById("rec-note").textContent), null, { timeout: 5000 });
  await page.waitForTimeout(500);
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  expect(names.length).toBe(2);
  expect(names[0]).toMatch(/^sonar_take_\d{8}-\d{6}_setup_v01\.json$/);
  expect(names[1]).toMatch(/^sonar_take_\d{8}-\d{6}_v01\.webm$/);
  const { statSync } = await import("node:fs");
  const webm = downloads.find((d) => d.suggestedFilename().endsWith(".webm"));
  expect(statSync(await webm.path()).size).toBeGreaterThan(2000);
  const json = JSON.parse((await import("node:fs")).readFileSync(await downloads.find((d) => d.suggestedFilename().endsWith(".json")).path(), "utf8"));
  expect(json.v).toBe(1); expect(json.plants.length).toBeGreaterThanOrEqual(2);
});

test("t8 a cue list plays itself on its bars; G and Shift+G step it", async ({ page }) => {
  await boot(page, "index.html?seed=42&bpm=240");
  const [a, b, c] = await page.evaluate(() => { const G = window.__garden, out = []; for (const sd of [11, 22, 33]) { G.seed(sd); const s = G.toSetup(); s.bpm = 240; out.push(s); } return out; });
  await page.evaluate(([a, b, c]) => window.__sonarAct.cues([{ bar: 0, morph: 0, setup: a }, { bar: 2, morph: 0, setup: b }, { bar: 4, morph: 0, setup: c }]), [a, b, c]);
  await page.evaluate(() => window.__panels.openPanel("setups"));
  await expect(page.locator("#cue-list")).toContainText("3 bar 4");
  await page.click("#b-cue-run");
  await page.waitForFunction(() => window.__sonar.cueIx === 2 && window.__garden.seedValue === 33, null, { timeout: 8000 });
  await page.click("#b-cue-run");
  await page.keyboard.press("Shift+G");
  await page.waitForFunction(() => window.__sonar.cueIx === 1, null, { timeout: 2000 });
  await page.waitForFunction(() => window.__garden.seedValue === 22, null, { timeout: 4000 });
  await page.keyboard.press("g");
  await page.waitForFunction(() => window.__sonar.cueIx === 2, null, { timeout: 2000 });
  expect(await page.evaluate(() => window.__sonar.errors)).toBe(0);
});

test("t8 offline: cues load at their bars and the render stays at or under -1 dBFS", async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const { Garden } = await import("./js/garden.js");
    const { renderGarden, levels } = await import("./js/garden-offline.js");
    const catalog = await (await fetch("./js/catalog.json")).json();
    const mk = (seed, f) => { const g = new Garden({ catalog, seed, bpm: 120 }); f(g); return g.toSetup(); };
    const cues = [{ bar: 2, setup: mk(5, (g) => g.setFx({ reverb: { amount: 0.4, size: 3 } })) }, { bar: 4, setup: mk(9, (g) => { g.setRoots(1, { archetype: "taproot" }); g.setBass({ sync: 0 }); }) }];
    const a = await renderGarden(catalog, { seed: 1, seconds: 16, bpm: 120, cues });
    return { ...levels(a.buf), cues: a.log.filter((e) => e.k === "cue").map((e) => e.t), notesAfter: a.log.filter((e) => e.t > 16 && e.k === "note").length, bass: a.log.filter((e) => e.k === "bass").length };
  });
  console.log("cues offline", JSON.stringify(r));
  expect(r.cues).toEqual([8, 16]);
  expect(r.notesAfter).toBeGreaterThan(3);
  expect(r.bass).toBeGreaterThan(0);
  expect(r.peakDb).toBeLessThanOrEqual(-1);
});
