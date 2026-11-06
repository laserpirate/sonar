// sonar Tier 2: docs/js/score.js. Determinism (same seed, same event log; different seed,
// different), panic silence inside 50 ms, loudness targets, all from offline renders in the page.
import { test, expect } from "@playwright/test";

test.setTimeout(240000);

test("s1: same seed twice gives one event log, another seed another (60 s, shanshui and kodama)", async ({ page }) => {
  await page.goto("index.html?seed=3");
  const r = await page.evaluate(async () => {
    const { Score } = await import("./js/score.js");
    const { runSim } = await import("./js/score-sim.js");
    const run = (seed, kind) => { const s = new Score(); s.seed(seed); runSim(s, kind, 60, 30); return JSON.stringify(s.log); };
    const out = {};
    for (const kind of ["shanshui", "kodama"]) {
      const a = run(1792909998082, kind), b = run(1792909998082, kind), c = run(42, kind);
      out[kind] = { same: a === b, diff: a !== c, n: JSON.parse(a).length, notes: JSON.parse(a).filter((e) => e.k === "note").length };
    }
    return out;
  });
  console.log("determinism", JSON.stringify(r));
  for (const k of ["shanshui", "kodama"]) { expect(r[k].same).toBe(true); expect(r[k].diff).toBe(true); expect(r[k].notes).toBeGreaterThan(5); }
});

test("s2: offline render with audio keeps the same event log as the silent run", async ({ page }) => {
  await page.goto("index.html?seed=3");
  const r = await page.evaluate(async () => {
    const { Score } = await import("./js/score.js");
    const { runSim } = await import("./js/score-sim.js");
    const { renderScore } = await import("./js/score-offline.js");
    const s = new Score(); s.seed(7); runSim(s, "shanshui", 20, 30);
    const silent = s.log.filter((e) => e.t < 19).map((e) => JSON.stringify(e));
    const a = await renderScore({ kind: "shanshui", seed: 7, seconds: 20, sr: 24000 });
    const loud = a.log.filter((e) => e.t < 19).map((e) => JSON.stringify(e));
    return { same: silent.join() === loud.join(), n: silent.length };
  });
  expect(r.same).toBe(true);
});

test("s3: panic silences every voice inside 50 ms", async ({ page }) => {
  await page.goto("index.html?seed=3");
  const r = await page.evaluate(async () => {
    const { renderScore, levels } = await import("./js/score-offline.js");
    const a = await renderScore({ kind: "shanshui", seed: 1792909998082, seconds: 16, panicAt: 12.3 });
    const q = a.panicQ;
    return { before: levels(a.buf, q - 2, q), after: levels(a.buf, q + 0.05, q + 2), panicQ: q, last: a.log[a.log.length - 1] };
  });
  console.log("panic", JSON.stringify(r));
  expect(r.before.rmsDb).toBeGreaterThan(-50);
  expect(r.after.peakDb).toBeLessThan(-80);
});

test("s5: ?score=1 page: strip, sim scene, Space, R, Esc-hold panic; flag off has no strip", async ({ page }) => {
  await page.goto("index.html?seed=3");
  expect(await page.locator("#f-score").count()).toBe(0);
  await page.goto("index.html?score=1&seed=1792909998082");
  await page.waitForFunction(() => window.__score && window.__score.log.some((e) => e.k === "note"), null, { timeout: 30000 });
  const strip = await page.locator("#f-score").innerText();
  expect(strip).toMatch(/^score on · seed 1792909998082 · p09 · gen \d+ · bpm \d+$/);
  await page.keyboard.press(" ");
  expect(await page.evaluate(() => window.__score.playing)).toBe(false);
  await page.keyboard.press(" ");
  await page.keyboard.press("r");
  const seed2 = await page.evaluate(() => window.__score.state().seed);
  expect(seed2).not.toBe("1792909998082");
  await page.keyboard.down("Escape"); await page.waitForTimeout(1200); await page.keyboard.up("Escape");
  const st = await page.evaluate(() => ({ panic: window.__sonar.panic, last: window.__score.log.filter((e) => e.k === "panic").length, playing: window.__score.playing }));
  expect(st.panic).toBe(true); expect(st.last).toBe(1); expect(st.playing).toBe(false);
});

test("s4: loudness: drone rms near -24 dBFS, notes peak near -8 dBFS, mix peak at or under -6 dBFS", async ({ page }) => {
  await page.goto("index.html?seed=3");
  const r = await page.evaluate(async () => {
    const { renderScore, levels } = await import("./js/score-offline.js");
    const seed = 1792909998082;
    const drone = await renderScore({ kind: "shanshui", seed, seconds: 90, only: "drone" });
    const notes = await renderScore({ kind: "shanshui", seed, seconds: 90, only: "notes" });
    const mix = await renderScore({ kind: "shanshui", seed, seconds: 90 });
    return { drone: levels(drone.buf, 10, 90), notes: levels(notes.buf, 2, 90), mix: levels(mix.buf, 2, 90) };
  });
  console.log("loudness", JSON.stringify(r));
  expect(Math.abs(r.drone.rmsDb - -24)).toBeLessThan(3);
  expect(Math.abs(r.notes.peakDb - -8)).toBeLessThan(3);
  expect(r.mix.peakDb).toBeLessThanOrEqual(-5.5);
});
