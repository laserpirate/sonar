// bus.spec.mjs · Tier 7: the sonar bus between two pages of one browser, counted on both ends; the receiver
// rests when sonar stops; off by default; VANA's /phylla/ values set roots; a Phylla JSON export imports
// only when it fits flora's alphabet.
import { test, expect } from "@playwright/test";

const boot = async (page, url) => {
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
};
// a plain page on the same origin that imports the receiver
const receiver = async (context) => {
  const r = await context.newPage();
  await r.goto("demos/index.html");
  await r.evaluate(async () => {
    const { createSonarIn } = await import("../js/sonar-in.js");
    window.__in = createSonarIn({ stale: 1500 });
    window.__rest = 0; window.__in.on("rest", () => { window.__rest++; });
    window.__maxLevel = 0; window.__in.on("level", (m) => { window.__maxLevel = Math.max(window.__maxLevel, m.rms); });
  });
  return r;
};

test("t7 two pages: the receiver counts the same notes and beats as the sender over 30 s, then rests", async ({ page, context }) => {
  test.setTimeout(90000);
  await boot(page, "index.html?seed=42&bpm=120");
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.audio.played > 0, null, { timeout: 8000 });
  const r = await receiver(context);
  await page.evaluate(() => { window.__panels.openPanel("more"); document.getElementById("b-bus").click(); });
  await page.waitForTimeout(30000);
  await page.evaluate(() => document.getElementById("b-bus").click());
  await page.waitForTimeout(500);
  const sent = await page.evaluate(() => ({ ...window.__bus.sent }));
  const got = await r.evaluate(() => ({ ...window.__in.counts, maxLevel: window.__maxLevel, live: window.__in.live }));
  console.log("bus", JSON.stringify({ sent, got }));
  expect(sent.note).toBeGreaterThan(40);
  expect(sent.beat).toBeGreaterThanOrEqual(58);
  expect(got.note).toBe(sent.note);
  expect(got.beat).toBe(sent.beat);
  expect(got.gen).toBe(sent.gen);
  expect(got.level).toBe(sent.level);
  expect(got.level).toBeGreaterThan(600); // about 30 a second
  expect(got.maxLevel).toBeGreaterThan(0.2);
  await r.waitForFunction(() => window.__in.live === false && window.__rest === 1 && window.__in.level < 0.01, null, { timeout: 4000 });
});

test("t7 the bus is off by default: nothing reaches a receiver", async ({ page, context }) => {
  await boot(page, "index.html?seed=42");
  const r = await receiver(context);
  await page.waitForTimeout(3000);
  expect(await r.evaluate(() => Object.values(window.__in.counts).reduce((a, b) => a + b, 0))).toBe(0);
  expect(await page.evaluate(() => window.__bus.on)).toBe(false);
});

test("t7 VANA on the bus sets roots by slot; prop has no counterpart; off without the toggle", async ({ page, context }) => {
  await boot(page, "index.html?seed=42");
  const vana = await context.newPage();
  await vana.goto("demos/index.html");
  const post = (msgs) => vana.evaluate((msgs) => { const ch = new BroadcastChannel("sonar-bus"); for (const [path, ...args] of msgs) ch.postMessage({ path, args }); ch.close(); }, msgs);
  await post([["/phylla/1/root/archetype", "taproot_heart"]]);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__garden.roots[1]?.archetype ?? null)).toBe(null); // toggle off
  await page.evaluate(() => { window.__panels.openPanel("more"); document.getElementById("b-vana").click(); window.__sonarAct.forest({ n: 4 }); });
  await post([["/phylla/1/root/archetype", "taproot_heart"], ["/phylla/1/root/depth", 1.2], ["/phylla/1/root/spread", 0.8], ["/phylla/1/root", 0.5],
    ["/phylla/3/root/archetype", "rhizomatous_spreader"], ["/phylla/3/root/depth", 50], ["/phylla/3/root/rhizome_reach", 1.6],
    ["/phylla/2/root/archetype", "prop"], ["/phylla/4/root/archetype", "ericaceous_mat"], ["/phylla/9/root/depth", 1]]);
  await page.waitForFunction(() => window.__garden.roots[4]?.archetype === "ericaceous", null, { timeout: 3000 });
  const roots = await page.evaluate(() => ({ r1: window.__garden.roots[1], r3: window.__garden.roots[3], r2: window.__garden.roots[2] ?? null, bass: window.__garden.bass.level, rx: window.__sonar.vana.rx }));
  console.log("vana", JSON.stringify(roots));
  expect(roots.r1).toMatchObject({ archetype: "taproot", depth: 0.6, spread: 0.4 });
  expect(roots.r3).toMatchObject({ archetype: "rhizome", depth: 0.25, spread: 0.8 });
  expect(roots.r2?.archetype ?? null).toBe(null);
  expect(roots.bass).toBe(0.5);
  expect(roots.rx).toBe(9); // slot 9 is not a VANA slot
  await expect(page.locator("#bus-note")).toContainText("slot 2: prop has no counterpart; roots unchanged");
});

test("t7 a Phylla JSON export imports when its word fits flora's alphabet, and says why when it does not", async ({ page }) => {
  await boot(page, "index.html?seed=42");
  await page.evaluate(() => window.__panels.openPanel("setups"));
  const vana3d = { vana_version: "vana-core-v1", species: "quercus_rubra", genome: { theta: 32, root: 0.6, root_archetype: "taproot_heart" },
    word: [{ s: "F", p: [100] }, { s: "[", p: [] }, { s: "+", p: [32] }, { s: "/", p: [2] }, { s: "F", p: [74] }, { s: "]", p: [] }, { s: "[", p: [] }, { s: "^", p: [32] }, { s: "F", p: [74] }, { s: "]", p: [] }] };
  await page.setInputFiles("#f-setup-import", { name: "quercus.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(vana3d)) });
  await expect(page.locator("#setup-note")).toHaveText("Phylla plant uses / ^ outside flora's alphabet; not imported");
  const flat = { ...vana3d, species: "flat_oak", word: ["F", "[", "+", "F", "]", "[", "-", "F", "]", "F"].map((s) => ({ s, p: [] })) };
  await page.setInputFiles("#f-setup-import", { name: "flat.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(flat)) });
  await expect(page.locator("#setup-note")).toHaveText("Phylla plant flat_oak in the palette, roots taproot");
  await expect(page.locator("#pal-u-flat_oak")).toHaveCount(1);
});
