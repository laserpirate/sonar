// forest.spec.mjs · Tier 4: the 16-plant forest under the conductor, roots and bass, palette, editor, phone pan.
import { test, expect } from "@playwright/test";

const boot = async (page, url = "index.html?seed=42") => {
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
};

test("t4 16 plants, budget 6: voices counted never exceed it, peak at or under -1 dBFS", async ({ page }) => {
  test.setTimeout(180000);
  await boot(page);
  const r = await page.evaluate(async () => {
    const { renderGarden, levels } = await import("./js/garden-offline.js");
    const { maxConcurrent } = await import("./js/player.js");
    const catalog = await (await fetch("./js/catalog.json")).json();
    const a = await renderGarden(catalog, { seed: 42, seconds: 60, bpm: 110, forest: { n: 16, leads: 2, density: 0.8, budget: 6 }, routes: { 2: "rain", 5: "rain", 9: "rain" },
      arps: { saw: { mode: "up", rate: "1/16" }, rain: { mode: "up", rate: "1/8" } }, roots: { 1: { archetype: "taproot" } }, delays: { saw: { amount: 0.4 }, rain: { amount: 0.4 } },
      layers: [{ seed: 7, atBeat: 1 }, { seed: 99, atBeat: 2 }] });
    const lit = new Set(a.log.filter((x) => x.k === "note" || x.k === "loop").map((x) => x.plant));
    return { lv: levels(a.buf), max: maxConcurrent(a.spans), spans: a.spans.length, events: a.log.length, silent: a.log.filter((x) => x.silent).length,
      bass: a.log.filter((x) => x.k === "bass").length, chorus: a.log.filter((x) => x.k === "chorus").length, lit: lit.size };
  });
  console.log("forest", JSON.stringify(r));
  expect(r.max).toBeLessThanOrEqual(6);
  expect(r.lv.peakDb).toBeLessThanOrEqual(-1);
  expect(r.lit).toBeGreaterThanOrEqual(16);   // every plant still lights
  expect(r.silent).toBeGreaterThan(r.spans);  // the eye sees the forest, the ear hears a few
  // both arps at full rate take most of the budget, so the chorus is thin here (SN row); present, not abundant
  expect(r.bass).toBeGreaterThan(10); expect(r.chorus).toBeGreaterThan(0);
});

test("t4 roots: each archetype renders a bass line at or under -1 dBFS", async ({ page }) => {
  test.setTimeout(180000);
  await boot(page);
  const r = await page.evaluate(async () => {
    const { renderGarden, levels } = await import("./js/garden-offline.js");
    const catalog = await (await fetch("./js/catalog.json")).json();
    const out = {};
    for (const a of ["taproot", "plate", "fibrous", "rhizome", "ericaceous"]) {
      const x = await renderGarden(catalog, { seed: 42, seconds: 20, bpm: 90, roots: { 1: { archetype: a } }, bass: { sync: 4 } });
      out[a] = { ...levels(x.buf), bass: x.log.filter((e) => e.k === "bass").length };
    }
    return out;
  });
  console.log("roots", JSON.stringify(r));
  for (const v of Object.values(r)) { expect(v.peakDb).toBeLessThanOrEqual(-1); expect(v.bass).toBeGreaterThan(3); }
});

test("t4 forest on the page: every plant fits on stage, roots and ground line, one plant lights its root tips", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__panels.openPanel("forest"); });
  await page.fill("#r-forest", "16"); await page.dispatchEvent("#r-forest", "input");
  await page.evaluate(() => { window.__sonarAct.roots({ archetype: "rhizome" }); });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const st = window.__stage, cv = document.getElementById("c");
    const boxes = st.items.filter((i) => !i.layer).map((i) => st.boxOf(i));
    const inside = boxes.every((b) => b && b.x0 >= -1 && b.x1 <= cv.width + 1 && b.y0 >= -1 && b.y1 <= cv.height + 1);
    return { n: st.items.filter((i) => !i.layer).length, inside, roots: !!st.items.find((i) => i.id === 1).roots, errors: window.__sonar.errors };
  });
  expect(r).toEqual({ n: 16, inside: true, roots: true, errors: 0 });
});

test("t4 phone portrait: the forest pans so the active plant sits in the middle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.evaluate(() => { window.__sonarAct.forest({ n: 16 }); window.__sonarAct.plant(12); });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const st = window.__stage, cv = document.getElementById("c");
    const b = st.boxOf(st.items.find((i) => i.id === 12));
    return { cx: (b.x0 + b.x1) / 2 / cv.width, h: (b.y1 - b.y0) / cv.height };
  });
  expect(Math.abs(r.cx - 0.5)).toBeLessThan(0.12);
  expect(r.h).toBeGreaterThan(0.08);
});

test("t4 palette: 13 plants and 5 archetypes; a tap assigns; the editor refuses symbols flora lacks and saves a user plant", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__panels.openPanel("plants"));
  expect(await page.locator("#pal-plants .tile").count()).toBe(13);
  expect(await page.locator("#pal-roots .tile").count()).toBe(6);
  await page.click("#pal-p05");
  expect(await page.evaluate(() => window.__garden.instr[window.__sonar.active - 1])).toBe(5);
  await page.click("#pal-plate");
  expect(await page.evaluate(() => window.__garden.roots[window.__sonar.active].archetype)).toBe("plate");
  await page.click("#b-editor");
  await page.fill("#ed-axiom", "F%");
  await expect(page.locator("#ed-note")).toContainText("axiom: only");
  await page.fill("#ed-axiom", "X");
  await page.fill("#ed-a1", "X"); await page.fill("#ed-b1", "F[+X][-X]FX");
  await page.fill("#ed-a2", "F"); await page.fill("#ed-b2", "FF");
  await page.fill("#ed-start", "6"); await page.dispatchEvent("#ed-start", "input");
  await expect(page.locator("#ed-note")).toContainText("capped at 300");
  await page.fill("#ed-name", "mine");
  await page.click("#ed-save");
  await expect(page.locator("#pal-u-mine")).toBeVisible();
  await page.click("#pal-u-mine");
  const g = await page.evaluate(() => { const G = window.__garden, k = window.__sonar.active - 1; return { instr: G.instr[k], axiom: G.plants[k].axiom, setup: G.toSetup().plants[k].custom }; });
  expect(g.instr).toBeGreaterThan(1000); expect(g.axiom).toBe("X"); expect(g.setup.rules).toEqual([["X", "F[+X][-X]FX"], ["F", "FF"]]);
  expect(await page.evaluate(() => window.__sonar.errors)).toBe(0);
});
