// select.spec.mjs · Tier 0: the stage fit, and plant selection by click, tap and key; live mode sends /sonar/plant.
import { test, expect } from "@playwright/test";

const ready = (page) => page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3 && !window.__stage.animating);
const boxes = (page) => page.evaluate(() => {
  const st = window.__stage, r = st.canvas.getBoundingClientRect(), f = r.width / st.canvas.width;
  return st.items.filter((i) => !i.layer).map((i) => { const b = st.boxOf(i); return { id: i.id, x: r.left + ((b.x0 + b.x1) / 2) * f, y: r.top + ((b.y0 + b.y1) / 2) * f, x0: b.x0 * f, y0: b.y0 * f, x1: b.x1 * f, y1: b.y1 * f }; });
});
const active = (page) => page.evaluate(() => window.__sonar.active);

test("fit: plants use the stage: union box inside a 6 percent margin and touching it on one axis", async ({ page }) => {
  await page.goto("index.html?seed=42");
  await ready(page);
  const r = await page.evaluate(() => {
    const st = window.__stage, W = st.canvas.width, H = st.canvas.height;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const i of st.items) { const b = st.boxOf(i); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    return { W, H, x0, y0, x1, y1 };
  });
  const mx = r.W * 0.06, my = r.H * 0.06;
  expect(r.x0).toBeGreaterThanOrEqual(mx - 1); expect(r.x1).toBeLessThanOrEqual(r.W - mx + 1);
  expect(r.y0).toBeGreaterThanOrEqual(my - 1); expect(r.y1).toBeLessThanOrEqual(r.H - my + 1);
  const fillX = (r.x1 - r.x0) / (r.W - 2 * mx), fillY = (r.y1 - r.y0) / (r.H - 2 * my);
  console.log("fit", JSON.stringify({ fillX: +fillX.toFixed(3), fillY: +fillY.toFixed(3) }));
  expect(Math.max(fillX, fillY)).toBeGreaterThan(0.98);
});

test("fit: side by side in landscape, stacked in portrait", async ({ page }) => {
  await page.goto("index.html?seed=42");
  await ready(page);
  let b = await boxes(page);
  expect(b[0].x1).toBeLessThanOrEqual(b[1].x0 + 1);
  await page.setViewportSize({ width: 500, height: 1000 });
  await page.waitForTimeout(700);
  await ready(page);
  b = await boxes(page);
  expect(b[0].y1).toBeLessThanOrEqual(b[1].y0 + 1);
});

test("select by click, key 1 and 2, Tab; Left and Right change the active plant, the strip names it", async ({ page }) => {
  await page.goto("index.html?seed=42");
  await ready(page);
  const b = await boxes(page);
  await page.mouse.click(b[1].x, b[1].y);
  expect(await active(page)).toBe(2);
  await page.mouse.click(b[0].x, b[0].y);
  expect(await active(page)).toBe(1);
  await page.keyboard.press("2");
  expect(await active(page)).toBe(2);
  await page.keyboard.press("1");
  expect(await active(page)).toBe(1);
  await page.keyboard.press("Tab");
  expect(await active(page)).toBe(2);
  const before = await page.evaluate(() => window.__garden.instr.slice());
  await page.keyboard.press("ArrowRight");
  const after = await page.evaluate(() => window.__garden.instr.slice());
  expect(after[0]).toBe(before[0]);
  expect(after[1]).toBe((before[1] % 13) + 1);
  await page.waitForTimeout(300);
  const strip = await page.locator("#f-p2").innerText();
  expect(strip.startsWith(`2* p${String(after[1]).padStart(2, "0")}`)).toBe(true);
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("select by tap", async ({ page }) => {
    await page.goto("index.html?seed=42");
    await ready(page);
    const b = await boxes(page);
    await page.touchscreen.tap(b[1].x, b[1].y);
    expect(await active(page)).toBe(2);
    await page.touchscreen.tap(b[0].x, b[0].y);
    expect(await active(page)).toBe(1);
  });
});
