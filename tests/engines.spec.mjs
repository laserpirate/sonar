// engines.spec.mjs · Tier 2: per-engine delays and arps, offline, densest case first; v0.2.0 links still work.
import { test, expect } from "@playwright/test";

const render = (page, opts) => page.evaluate(async (opts) => {
  const { renderGarden, levels } = await import("./js/garden-offline.js");
  const catalog = await (await fetch("./js/catalog.json")).json();
  const a = await renderGarden(catalog, opts);
  const count = (k, e) => a.log.filter((x) => x.k === k && (!e || x.engine === e)).length;
  return { lv: levels(a.buf), arpSaw: count("arp", "saw"), arpRain: count("arp", "rain"), notes: count("note"), loops: count("loop") };
}, opts);

const DENSE = { seed: 42, seconds: 40, bpm: 120, routes: { 2: "rain" }, delays: { saw: { amount: 0.6, feedback: 0.85 }, rain: { amount: 0.6, feedback: 0.85, pingpong: true } },
  arps: { saw: { mode: "up", rate: "1/16", octaves: 3 }, rain: { mode: "up", rate: "1/16", octaves: 3 } },
  layers: [{ seed: 7, atBeat: 1 }, { seed: 99, atBeat: 2 }, { seed: 1234, atBeat: 3 }, { seed: 31337, atBeat: 4 }] };

test("t2 dense first: both arps 1/16, both delays 0.6, four loops: peak at or under -1 dBFS", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("index.html?seed=3");
  const r = await render(page, DENSE);
  console.log("dense", JSON.stringify(r));
  expect(r.lv.peakDb).toBeLessThanOrEqual(-1);
  expect(r.arpSaw).toBeGreaterThan(50); expect(r.arpRain).toBeGreaterThan(50);
  expect(r.loops).toBeGreaterThan(10);
});

test("t2 sparse cases keep their level", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("index.html?seed=3");
  const base = await render(page, { seed: 42, seconds: 30, bpm: 90 });
  const rain = await render(page, { seed: 42, seconds: 30, bpm: 90, engine: "rain" });
  const arpRain = await render(page, { seed: 42, seconds: 30, bpm: 90, routes: { 1: "rain", 2: "rain" }, arps: { rain: { mode: "up", rate: "1/8", gate: 40 } } });
  console.log("sparse", JSON.stringify({ base: base.lv, rain: rain.lv, arpRain: arpRain.lv }));
  for (const x of [base, rain, arpRain]) { expect(x.lv.peakDb).toBeLessThanOrEqual(-1); expect(x.lv.rmsDb).toBeGreaterThan(-45); }
  expect(arpRain.arpRain).toBeGreaterThan(10);
});

test("t2 delays are separate: a delay on rain only does not touch a saw-only render", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("index.html?seed=3");
  const dry = await render(page, { seed: 42, seconds: 20, bpm: 90 });
  const rainOnly = await render(page, { seed: 42, seconds: 20, bpm: 90, delays: { rain: { amount: 0.8 } } });
  const sawDelay = await render(page, { seed: 42, seconds: 20, bpm: 90, delays: { saw: { amount: 0.8 } } });
  console.log("separate", JSON.stringify({ dry: dry.lv, rainOnly: rainOnly.lv, sawDelay: sawDelay.lv }));
  expect(Math.abs(rainOnly.lv.rmsDb - dry.lv.rmsDb)).toBeLessThan(0.05);
  expect(sawDelay.lv.rmsDb - dry.lv.rmsDb).toBeGreaterThan(0.3);
});

test("t2 page: v0.2.0 ?delay and ?arp still work, panels reach each engine, routing", async ({ page }) => {
  await page.goto("index.html?seed=42&delay=0.4&arp=up&arprate=1/16");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  const a = await page.evaluate(() => ({ d: window.__garden.delays, s: window.__sonar.delay, arp: window.__garden.arps.saw.mode, rate: window.__garden.arps.saw.rate, rain: window.__garden.arps.rain.mode }));
  expect(a.d.saw.amount).toBeCloseTo(0.4, 3); expect(a.d.rain.amount).toBeCloseTo(0.4, 3); expect(a.arp).toBe("up"); expect(a.rate).toBe("1/16"); expect(a.rain).toBe("off");
  const slide = async (id, v) => { await page.fill(id, String(v)); await page.dispatchEvent(id, "input"); await page.dispatchEvent(id, "change"); };
  await slide("#r-damt-rain", 0.7); await slide("#r-dfb-saw", 0.2); await slide("#r-arpgate-rain", 30);
  await page.selectOption("#s-ddiv-rain", "1/4"); await page.selectOption("#s-arp-rain", "down"); await page.selectOption("#s-route", "rain");
  await page.click("#b-dpp-saw");
  const b = await page.evaluate(() => ({ d: window.__garden.delays, A: window.__garden.arps.rain, route: window.__garden.routes[1] }));
  expect(b.d.rain.amount).toBeCloseTo(0.7, 3); expect(b.d.saw.amount).toBeCloseTo(0.4, 3); expect(b.d.saw.feedback).toBeCloseTo(0.2, 3); expect(b.d.rain.div).toBe("1/4"); expect(b.d.saw.pingpong).toBe(true);
  expect(b.A.mode).toBe("down"); expect(b.A.gate).toBe(30); expect(b.route).toBe("rain");
});
