// setups.spec.mjs · Tier 3: factory setups, the local store, files, share links, morph on the bar line.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const boot = async (page, url = "index.html?seed=42") => {
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  await page.evaluate(() => window.__panels.openPanel("setups"));
};
const snap = (page) => page.evaluate(() => window.__garden.toSetup());

test("t3 twelve factory setups: labelled by id and facts, each renders at or under -1 dBFS", async ({ page }) => {
  test.setTimeout(180000);
  await boot(page);
  const opts = await page.locator("#s-factory option").allTextContents();
  expect(opts.length).toBe(13);
  expect(opts[4]).toBe("s04 · p06 p11 · 72 bpm · arp rain 1/8 · rain");
  const r = await page.evaluate(async () => {
    const { renderGarden, levels } = await import("./js/garden-offline.js");
    const catalog = await (await fetch("./js/catalog.json")).json();
    const list = await (await fetch("./js/setups.json")).json();
    const out = [];
    for (const setup of list) { const a = await renderGarden(catalog, { setup, seconds: 30 }); out.push({ id: setup.id, ...levels(a.buf), n: a.log.length }); }
    return out;
  });
  console.log("factory", JSON.stringify(r.map((x) => [x.id, +x.peakDb.toFixed(2), +x.rmsDb.toFixed(1), x.n])));
  for (const x of r) { expect(x.peakDb).toBeLessThanOrEqual(-1); expect(x.peakDb).toBeGreaterThan(-14); expect(x.rmsDb).toBeGreaterThan(-40); expect(x.n).toBeGreaterThan(3); }
});

test("t3 brackets step the factory list on the next bar line", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("]");
  await page.waitForFunction(() => window.__garden.seedValue === 11, null, { timeout: 8000 });
  expect(await page.evaluate(() => [window.__sonar.factoryIx, window.__sonar.bpm, new URL(location.href).searchParams.get("seed")])).toEqual([0, 75, "11"]);
  await page.keyboard.press("[");
  await page.waitForFunction(() => window.__garden.seedValue === 132, null, { timeout: 12000 });
  expect(await page.evaluate(() => window.__sonar.factoryIx)).toBe(11);
});

test("t3 save, load, overwrite, delete with a confirm", async ({ page }) => {
  await boot(page);
  await page.fill("#t-setup-name", "one");
  await page.click("#b-setup-save");
  expect(await page.locator("#setup-note").innerText()).toBe("saved one");
  const saved = await snap(page);
  await page.click("#b-setup-save"); // empty name: the next number
  expect(await page.inputValue("#s-saved")).toBe("1");
  await page.selectOption("#s-saved", "one");
  await page.evaluate(() => { window.__sonarAct.bpm(150); window.__sonarAct.play(false); });
  await page.click("#b-setup-load");
  expect(await page.evaluate(() => window.__sonar.bpm)).toBe(saved.bpm);
  // survives a reload
  await boot(page);
  expect(await page.locator("#s-saved option").count()).toBe(2);
  await page.selectOption("#s-saved", "one");
  await page.click("#b-setup-del");
  expect(await page.locator("#s-saved option").count()).toBe(2);
  expect(await page.locator("#b-setup-del").innerText()).toBe("delete?");
  await page.click("#b-setup-del");
  expect(await page.locator("#s-saved option").count()).toBe(1);
});

test("t3 the page works when localStorage throws", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } }); });
  await boot(page);
  await page.click("#b-setup-save");
  expect(await page.locator("#setup-note").innerText()).toBe("saved 1 for this page only");
  expect(await page.evaluate(() => window.__sonar.errors)).toBe(0);
});

test("t3 export then import brings a setup back", async ({ page }) => {
  await boot(page);
  await page.fill("#t-setup-name", "kept");
  await page.click("#b-setup-save");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#b-setup-export")]);
  expect(dl.suggestedFilename()).toBe("sonar_setup_kept_v01.json");
  const path = await dl.path();
  const text = readFileSync(path, "utf8");
  await page.evaluate(() => localStorage.clear());
  await boot(page);
  expect(await page.locator("#s-saved option").count()).toBe(0);
  await page.setInputFiles("#f-setup-import", { name: "x.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.locator("#setup-note")).toHaveText("imported 1");
  expect(await page.inputValue("#s-saved")).toBe("kept");
  await page.setInputFiles("#f-setup-import", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"v":9}') });
  await expect(page.locator("#setup-note")).toHaveText("imported 0, then a file was not readable");
});

test("t3 a share link restores the setup; a broken link leaves the garden alone; ?seed= still works", async ({ page }) => {
  await boot(page, "index.html?seed=42&bpm=77&arp=up");
  await page.evaluate(() => { window.__garden.setKey(48, "lydian"); window.__garden.nextGen(0); });
  await page.click("#b-setup-share");
  await expect(page.locator("#t-setup-link")).toHaveValue(/#s=z[A-Za-z0-9_-]+$/); // encoding is async
  const url = await page.inputValue("#t-setup-link");
  const want = await snap(page);
  await page.goto("about:blank");
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  await page.waitForFunction(() => window.__garden.seedValue === 42 && window.__sonar.bpm === 77);
  const got = await page.evaluate(() => { const g = window.__garden, s = g.toSetup(); return { key: s.key, bpm: s.bpm, arp: s.arps.saw.mode, sentences: s.plants.map((p) => p.sentence) }; });
  expect(got).toEqual({ key: want.key, bpm: want.bpm, arp: "up", sentences: want.plants.map((p) => p.sentence) });
  await page.goto("about:blank");
  await page.goto("index.html?seed=7#s=zAAAA");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  await expect(page.locator("#setup-note")).toHaveText("link not readable");
  expect(await page.evaluate(() => window.__garden.seedValue)).toBe(7);
});

test("t3 morph: a load waits for the bar line and glides bpm and delay over its bars", async ({ page }) => {
  await boot(page, "index.html?seed=42&bpm=240");
  const r = await page.evaluate(async () => {
    const G = window.__garden, A = window.__sonarAct, S = window.__sonar;
    const target = G.toSetup(); target.bpm = 120; target.seed = 777; delete target.rng; target.delays.saw.amount = 0.8;
    for (const p of target.plants) delete p.sentence;
    A.loadSetup(target, { bars: 1 });
    const seedAtOnce = G.seedValue;
    const seen = [];
    // bounded by time, not by loop count: a loaded machine runs fewer timer turns per second
    const until = performance.now() + 8000;
    while (performance.now() < until && (seen.length < 2 || S.bpm !== 120)) { await new Promise((f) => setTimeout(f, 25)); if (G.seedValue === 777) seen.push([S.bpm, G.delays.saw.amount]); }
    return { seedAtOnce, seen, end: [S.bpm, G.delays.saw.amount, G.seedValue] };
  });
  expect(r.seedAtOnce).toBe(42);
  expect(r.end).toEqual([120, 0.8, 777]);
  const mid = r.seen.filter(([b]) => b > 120 && b < 240);
  expect(mid.length).toBeGreaterThan(3);
  expect(mid.some(([, d]) => d > 0.05 && d < 0.75)).toBe(true);
});
