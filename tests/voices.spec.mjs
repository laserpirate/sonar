// voices.spec.mjs · Tier 5: added voices, reverb and wind, sampler, banks, randomize, kill.
import { test, expect } from "@playwright/test";

const boot = async (page, url = "index.html?seed=42") => {
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
};
// a short wav: 16-bit mono, a sine with a decay
function wav(freq = 220, seconds = 0.8, sr = 48000) {
  const n = Math.round(sr * seconds), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / (sr * 0.3)) * 20000), 44 + i * 2);
  return b;
}
const render = (page, opts) => page.evaluate(async (opts) => {
  const { renderGarden, levels } = await import("./js/garden-offline.js");
  const catalog = await (await fetch("./js/catalog.json")).json();
  if (opts.sampleHz) { const sr = 48000, d = new Float32Array(sr); for (let i = 0; i < sr; i++) d[i] = Math.sin(2 * Math.PI * opts.sampleHz * i / sr) * Math.exp(-i / (sr * 0.3)) * 0.6; opts.samples = [{ id: "smp1", sr, channels: [d], name: "test.wav" }]; }
  const a = await renderGarden(catalog, opts);
  const d = a.buf.getChannelData(0);
  let z = 0; for (let i = 1; i < d.length; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) z++;
  return { ...levels(a.buf), zcr: z / (d.length / a.buf.sampleRate), n: a.log.length };
}, opts);

test("t5 each added voice sounds, stays at or under -1 dBFS, and differs from the others", async ({ page }) => {
  test.setTimeout(180000);
  await boot(page);
  const r = {};
  for (const v of ["saw", "rain", "pluck", "sine", "water", "smp1"]) r[v] = await render(page, { seed: 42, seconds: 20, bpm: 90, routes: { 1: v, 2: v }, sampleHz: v === "smp1" ? 220 : 0 });
  console.log("voices", JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, x]) => [k, [+x.peakDb.toFixed(2), +x.rmsDb.toFixed(1), Math.round(x.zcr)]]))));
  for (const x of Object.values(r)) { expect(x.peakDb).toBeLessThanOrEqual(-1); expect(x.rmsDb).toBeGreaterThan(-45); }
  const ids = Object.keys(r);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = r[ids[i]], b = r[ids[j]];
    const apart = Math.abs(a.rmsDb - b.rmsDb) > 1.5 || Math.max(a.zcr, b.zcr) / Math.max(1, Math.min(a.zcr, b.zcr)) > 1.2;
    expect(apart, `${ids[i]} and ${ids[j]}`).toBe(true);
  }
});

test("t5 reverb and wind add level and stay at or under -1 dBFS; octave and tremolo leave the peak bounded", async ({ page }) => {
  test.setTimeout(180000);
  await boot(page);
  const dry = await render(page, { seed: 42, seconds: 20, bpm: 90 });
  const wet = await render(page, { seed: 42, seconds: 20, bpm: 90, fx: { reverb: { amount: 0.7, size: 4 }, wind: { level: 0.4, tone: 900 } } });
  const mod = await render(page, { seed: 42, seconds: 20, bpm: 90, voices: { saw: { octave: 1, tremolo: 0.6, detune: 20 } } });
  console.log("space", JSON.stringify({ dry, wet, mod }));
  expect(wet.peakDb).toBeLessThanOrEqual(-1); expect(mod.peakDb).toBeLessThanOrEqual(-1);
  expect(wet.rmsDb - dry.rmsDb).toBeGreaterThan(1);
  expect(mod.n).toBe(dry.n);
});

test("t5 a sound added by file stays after a reload, plays when a plant is routed to it", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__panels.openPanel("voices"));
  await page.setInputFiles("#f-smp", { name: "tone.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.locator("#smp-note")).toContainText("added 1");
  await boot(page);
  await expect(page.locator("#s-route option[value=smp1]")).toHaveText("smp 1 (tone.wav)");
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.audio.chain.voices.smp1, null, { timeout: 8000 });
  await page.evaluate(() => window.__sonarAct.route(1, "smp1"));
  await page.waitForFunction(() => (window.__sonar.audio.chain.playedBy.smp1 || 0) > 2, null, { timeout: 15000 });
});

test("t5 a bank exports as one .sonarbank and comes back with its sound and its voice settings", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__panels.openPanel("voices"));
  await page.setInputFiles("#f-smp", { name: "tone.wav", mimeType: "audio/wav", buffer: wav(330) });
  await expect(page.locator("#smp-note")).toContainText("added 1");
  await page.evaluate(() => window.__sonarAct.voice("pluck", "decay", 4.2));
  await page.fill("#t-bank-name", "b1");
  await page.click("#b-bank-save");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#b-bank-export")]);
  expect(dl.suggestedFilename()).toBe("sonar_bank_b1_v01.sonarbank");
  const path = await dl.path();
  // a fresh browser state: no sounds, no banks
  await page.evaluate(async () => { localStorage.clear(); await new Promise((f) => { const r = indexedDB.deleteDatabase("sonar-samples"); r.onsuccess = r.onerror = r.onblocked = () => f(); }); });
  await boot(page);
  await page.evaluate(() => window.__panels.openPanel("voices"));
  expect(await page.locator("#s-route option[value=smp1]").count()).toBe(0);
  await page.setInputFiles("#f-bank", path);
  await expect(page.locator("#smp-note")).toHaveText("bank b1");
  expect(await page.evaluate(() => window.__garden.voiceParams.pluck.decay)).toBe(4.2);
  await expect(page.locator("#s-route option[value=smp1]")).toHaveText("smp 1 (tone.wav)");
});

test("t5 a setup naming sounds this browser lacks says which, and the built-in voices play", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const s = window.__garden.toSetup(); s.samples = [{ id: "smp9", name: "gone.wav" }]; s.plants[0].engine = "smp9"; window.__sonarAct.loadSetup(s, { now: true }); });
  await expect(page.locator("#setup-note")).toHaveText("missing: gone.wav; built-in voices play");
});

test("t5 randomize: one seed, the same values; they ride in the setup", async ({ page }) => {
  await boot(page);
  const pick = (s) => JSON.stringify({ v: s.voices, d: s.delays, a: s.arps, f: s.fx, b: s.bpm, k: s.key, r: s.randomSeed });
  const a = await page.evaluate(() => { window.__sonarAct.randomize(1234); return window.__garden.toSetup(); });
  await page.evaluate(() => window.__sonarAct.randomize(99));
  const b = await page.evaluate(() => { window.__sonarAct.randomize(1234); return window.__garden.toSetup(); });
  expect(pick(a)).toBe(pick(b));
  expect(a.randomSeed).toBe(1234);
  expect(a.bpm).toBeGreaterThanOrEqual(60); expect(a.bpm).toBeLessThanOrEqual(140);
  expect(await page.evaluate(() => window.__sonar.errors)).toBe(0);
});

test("t5 kill latches silence while the garden keeps drawing; a second press brings it back", async ({ page }) => {
  await boot(page);
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.outDb > -60, null, { timeout: 8000 });
  await page.evaluate(() => window.__sonarAct.kill());
  await page.waitForTimeout(1500);
  const quiet = await page.evaluate(async () => { let m = -200; for (let i = 0; i < 8; i++) { await new Promise((f) => setTimeout(f, 250)); m = Math.max(m, window.__sonar.outDb); } return { m, frames: window.__sonar.frames }; });
  expect(quiet.m).toBeLessThan(-80);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__sonar.frames)).toBeGreaterThan(quiet.frames);
  await page.evaluate(() => window.__sonarAct.kill());
  await page.waitForFunction(() => window.__sonar.outDb > -60, null, { timeout: 10000 });
});
