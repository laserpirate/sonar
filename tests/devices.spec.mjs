// devices.spec.mjs · Tier 1: layout per viewport. Runs in the device projects of playwright.config.mjs.
// Rects, stage share, target sizes, no horizontal scroll, tap play, select, reseed, panel; a screenshot per viewport.
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const OUT = new URL("./logs/devices.json", import.meta.url);
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 1));
const ready = (page) => page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3 && !window.__stage.animating, null, { timeout: 20000 });

const measure = (page) => page.evaluate(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
  const vv = { w: window.visualViewport?.width ?? innerWidth, h: window.visualViewport?.height ?? innerHeight };
  const stage = R(document.getElementById("stage")), hud = R(document.getElementById("hud"));
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden"; };
  const small = [];
  for (const el of document.querySelectorAll("#hud button, #hud select, #hud input")) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 44 || r.width < 44) small.push(`${el.id || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const fonts = [...document.querySelectorAll("#hud button, #hud select, #hud label, .fact")].filter(vis).map((el) => parseFloat(getComputedStyle(el).fontSize));
  return { vv, stage, hud, small, minFont: Math.min(...fonts), hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, canvas: R(document.getElementById("c")) };
});
const intersects = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

test("layout, targets, taps", async ({ page, browserName }, info) => {
  const name = info.project.name;
  const touch = !!info.project.use.hasTouch;
  await page.goto("index.html?seed=42");
  await ready(page);
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); };

  let m = await measure(page);
  // open the widest panel state this viewport gets
  await tap("#tab-tempo");
  if (!(await page.locator("#panel-tempo").evaluate((e) => e.classList.contains("open")))) await tap("#tab-tempo");
  await page.waitForTimeout(600);
  m = await measure(page);
  const share = (m.stage.w * m.stage.h) / (m.vv.w * m.vv.h);
  results[name] = { browser: browserName, stageShare: +share.toFixed(3), stageH: Math.round(m.stage.h), stageW: Math.round(m.stage.w), vv: m.vv, minFont: m.minFont, small: m.small.slice(0, 8) };
  save();
  console.log("device", name, JSON.stringify(results[name]));
  mkdirSync(new URL("./logs/shots/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL(`./logs/shots/sonar_${name}_v03.png`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });

  expect(intersects(m.stage, m.hud)).toBe(false);
  expect(m.canvas.w).toBeLessThanOrEqual(m.stage.w + 1);
  expect(m.hscroll).toBeLessThanOrEqual(0);
  if (touch) { expect(m.small).toEqual([]); expect(m.minFont).toBeGreaterThanOrEqual(16); }
  else expect(m.minFont).toBeGreaterThanOrEqual(18);
  if (m.vv.w <= 820 && m.vv.h > m.vv.w) expect(m.stage.h / m.vv.h).toBeGreaterThanOrEqual(0.549);

  // play, select, reseed, a panel, by tap
  const playing = await page.evaluate(() => window.__sonar.playing);
  await tap("#b-play");
  expect(await page.evaluate(() => window.__sonar.playing)).toBe(!playing);
  await tap("#b-play");
  const seed = await page.evaluate(() => window.__sonar.seed);
  await tap("#b-reseed");
  expect(await page.evaluate(() => window.__sonar.seed)).not.toBe(seed);
  await page.waitForTimeout(600);
  await ready(page);
  const b = await page.evaluate(() => {
    const st = window.__stage, r = st.canvas.getBoundingClientRect(), f = r.width / st.canvas.width;
    return st.items.filter((i) => !i.layer).map((i) => { const q = st.boxOf(i); return { id: i.id, x: r.left + ((q.x0 + q.x1) / 2) * f, y: r.top + ((q.y0 + q.y1) / 2) * f }; });
  });
  if (touch) await page.touchscreen.tap(b[1].x, b[1].y); else await page.mouse.click(b[1].x, b[1].y);
  expect(await page.evaluate(() => window.__sonar.active)).toBe(2);
  await tap("#tab-more");
  expect(await page.locator("#b-reset").isVisible()).toBe(true);
  expect(await page.evaluate(() => window.__sonar.errors)).toBe(0);
});

test("gestures: drag turns the angle and the length, two-finger tap is next gen, long press opens the palette", async ({ page }) => {
  await page.goto("index.html?seed=42");
  await ready(page);
  const r = await page.evaluate(async () => {
    const c = document.getElementById("c"), st = window.__stage, cr = c.getBoundingClientRect(), f = cr.width / c.width;
    const it = st.items.find((i) => i.id === 1), b = st.boxOf(it);
    const x = cr.left + ((b.x0 + b.x1) / 2) * f, y = cr.top + ((b.y0 + b.y1) / 2) * f;
    const ev = (t, id, px, py) => c.dispatchEvent(new PointerEvent(t, { pointerId: id, clientX: px, clientY: py, bubbles: true, pointerType: "touch", isPrimary: id === 1 }));
    const P = window.__garden.plants[0], wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { angle0: P.angle };
    ev("pointerdown", 1, x, y); ev("pointermove", 1, x + 40, y); ev("pointermove", 1, x + 80, y); ev("pointerup", 1, x + 80, y);
    out.angle1 = P.angle;
    const l0 = P.userScale ?? 1;
    ev("pointerdown", 1, x, y); ev("pointermove", 1, x, y - 40); ev("pointermove", 1, x, y - 80); ev("pointerup", 1, x, y - 80);
    out.lengthUp = (P.userScale ?? 1) > l0;
    const g0 = P.currentGeneration, m0 = P.maxGenerations;
    window.__garden.reset();
    const gBase = window.__garden.plants[0].currentGeneration;
    ev("pointerdown", 1, x, y); ev("pointerdown", 2, x + 30, y); ev("pointerup", 2, x + 30, y); ev("pointerup", 1, x, y);
    out.gen = [gBase, window.__garden.plants[0].currentGeneration];
    ev("pointerdown", 1, x, y); await wait(700); ev("pointerup", 1, x, y);
    out.plantsOpen = document.getElementById("panel-plants").classList.contains("open");
    return out;
  });
  console.log("gestures", JSON.stringify(r));
  expect(r.angle1).toBe(r.angle0 + 20);
  expect(r.lengthUp).toBe(true);
  expect(r.gen[1]).toBe(r.gen[0] + 1);
  expect(r.plantsOpen).toBe(true);
});
