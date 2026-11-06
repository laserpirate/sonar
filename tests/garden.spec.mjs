// garden.spec.mjs · the sim garden controls: reseed, loop layers on the 4-bar grid, clear, arp, key,
// pitch, delay, growth, bpm; keys and sliders; audio chain and meter after Enable.
import { test, expect } from "@playwright/test";

const st = (page) => page.evaluate(() => ({
  seed: window.__sonar.seed, instr: window.__garden.instr.slice(), layers: window.__garden.layers.length,
  arp: window.__garden.arp.mode, key: window.__garden.key, pitch: window.__garden.pitch, growth: window.__garden.growth,
  bpm: window.__sonar.bpm, delay: window.__sonar.delay, notes: window.__sonar.notes, errors: window.__sonar.errors,
  url: location.search, loopsText: document.getElementById("f-loops").innerText,
}));

test("g1: reseed (R, button) changes the seed, the presets and the URL; same seed twice is the same garden", async ({ page }) => {
  await page.goto("index.html?seed=42");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  const a = await st(page);
  expect(a.seed).toBe(42); expect(a.url).toBe("?seed=42");
  await page.mouse.click(640, 300);
  await page.keyboard.press("r");
  const b = await st(page);
  expect(b.seed).not.toBe(42); expect(b.url).toBe("?seed=" + b.seed);
  await page.click("#b-reseed");
  const c = await st(page);
  expect(c.seed).not.toBe(b.seed);
  // deterministic: reload with b's seed gives b's presets
  await page.goto("index.html?seed=" + b.seed);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  expect((await st(page)).instr).toEqual(b.instr);
});

test("g2: loops: L adds a seeded 4 bar layer on the next bar line, max 4, C clears, loop repeats identically", async ({ page }) => {
  await page.goto("index.html?seed=42&bpm=240");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  await page.mouse.click(640, 300);
  for (let i = 0; i < 6; i++) { await page.keyboard.press("l"); await page.waitForTimeout(60); }
  let s = await st(page);
  expect(s.layers).toBe(4);
  expect(s.loopsText).toBe("loops 4/4 · 4 bar");
  const starts = await page.evaluate(() => window.__garden.layers.map((L) => L.start % 4));
  expect(starts.every((x) => x === 0)).toBe(true);
  // at 240 bpm a loop is 4 s: wait two loops and compare the two passes of the first layer
  const L0 = await page.evaluate(() => window.__garden.layers[0].id);
  await page.waitForTimeout(9500);
  const passes = await page.evaluate((id) => {
    const L = window.__garden.layers.find((x) => x.id === id);
    const evs = window.__garden.log.filter((e) => e.layer === id);
    const rel = (e) => +(((e.t - L.start) % 16) + 16) % 16;
    const p1 = evs.filter((e) => e.t < L.start + 16).map((e) => [e.note, rel(e).toFixed(2)]);
    const p2 = evs.filter((e) => e.t >= L.start + 16 && e.t < L.start + 32).map((e) => [e.note, rel(e).toFixed(2)]);
    return { p1, p2, loops: L.loops };
  }, L0);
  expect(passes.p1.length).toBeGreaterThan(0);
  expect(passes.p2).toEqual(passes.p1);
  await page.keyboard.press("c");
  s = await st(page);
  expect(s.layers).toBe(0);
  await page.click("#b-layer"); await page.click("#b-layer"); await page.click("#b-clear");
  expect((await st(page)).layers).toBe(0);
  expect(s.errors).toBe(0);
});

test("g3: sliders and menus: bpm, pitch, delay, growth, key, arp reach the garden; A cycles arp; Up Down change bpm", async ({ page }) => {
  await page.goto("index.html?seed=42");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  const slide = async (id, v) => { await page.fill(id, String(v)); await page.dispatchEvent(id, "input"); await page.dispatchEvent(id, "change"); };
  await slide("#r-bpm", 132); await slide("#r-pitch", 7); await slide("#r-delay", 0.35); await slide("#r-growth", 2);
  await page.selectOption("#s-root", "48"); await page.selectOption("#s-scale", "major pentatonic");
  await page.selectOption("#s-arp", "updown"); await page.selectOption("#s-arprate", "1/16"); await page.selectOption("#s-arpoct", "2");
  let s = await st(page);
  expect(s.bpm).toBe(132); expect(s.pitch).toBe(7); expect(s.delay).toBeCloseTo(0.35, 2); expect(s.growth).toBe(2);
  expect(s.key).toEqual({ root: 48, scale: "major pentatonic" }); expect(s.arp).toBe("updown");
  const notes = await page.evaluate(() => window.__garden.notes.slice(0, 5));
  expect(notes).toEqual([48, 50, 52, 55, 57]);
  await page.mouse.click(640, 300);
  await page.keyboard.press("a");
  expect((await st(page)).arp).toBe("random");
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowDown");
  expect((await st(page)).bpm).toBe(134);
  // arp notes arrive once the plants have fed the buffer
  await page.waitForFunction(() => window.__garden.log.some((e) => e.arp), null, { timeout: 15000 });
  expect((await st(page)).errors).toBe(0);
});

test("g4: enable: chain runs, meter reads a level within 3 s, delay and arp play through it, context survives hide/show", async ({ page }) => {
  await page.goto("index.html?seed=42&delay=0.4&arp=up&arprate=1/16");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.audio.ctx.state === "running", null, { timeout: 5000 });
  await page.waitForFunction(() => window.__sonar.outDb > -60, null, { timeout: 3000 });
  const t = await page.locator("#f-out").innerText();
  expect(t).toMatch(/^out -?\d+ dB$/);
  expect(await page.locator("#f-nosig").isVisible()).toBe(false);
  await page.waitForTimeout(3000);
  const a = await page.evaluate(() => ({ played: window.__sonar.audio.played, delay: window.__sonar.audio.chain.delay.amount, voices: window.__sonar.audio.saw.voices.length, db: window.__sonar.outDb }));
  expect(a.played).toBeGreaterThan(8); expect(a.delay).toBeCloseTo(0.4, 2); expect(a.db).toBeGreaterThan(-40);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  expect(await page.evaluate(() => window.__sonar.audio.ctx.state)).toBe("running");
});

test("g5: a 1 x 1 viewport draws no drawImage warnings for 5 s", async ({ page }) => {
  const warns = [];
  page.on("console", (m) => { if (m.type() === "warning" && /drawImage/.test(m.text())) warns.push(m.text()); });
  await page.setViewportSize({ width: 1, height: 1 });
  await page.goto("index.html?seed=3");
  await page.waitForTimeout(5000);
  expect(warns.length).toBe(0);
  expect(await page.evaluate(() => window.__sonar.errors)).toBe(0);
});
