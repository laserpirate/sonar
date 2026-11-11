// midi.spec.mjs · Tier 6: learn, soft takeover, note modes, hold to fire, conflicts, maps in files and setups,
// MIDI out and clock, clock in, a flood through the learn path, and a browser without Web MIDI.
// Web MIDI is faked with an init script (no hardware); the fake output records what it is sent.
import { test, expect } from "@playwright/test";

const FAKE_MIDI = () => {
  const input = { name: "fake pads", id: "fake-1", onmidimessage: null, state: "connected" };
  const sent = [];
  const output = { name: "fake out", id: "out-1", state: "connected", send(bytes, t) { sent.push([[...bytes], t ?? performance.now()]); } };
  const inputs = new Map([["fake-1", input]]), outputs = new Map([["out-1", output]]);
  const access = { inputs, outputs, onstatechange: null, sysexEnabled: false };
  window.__fakeMidi = {
    sent,
    send(bytes, timeStamp) { if (input.onmidimessage) input.onmidimessage({ data: new Uint8Array(bytes), timeStamp }); },
  };
  navigator.requestMIDIAccess = async () => access;
};
const boot = async (page, url = "index.html?seed=42") => {
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
};
const enable = async (page) => {
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.midi && window.__sonar.midi.devices.length === 1, null, { timeout: 8000 });
};
const midiPanel = (page) => page.evaluate(() => window.__panels.openPanel("midi")).then(() => page.waitForSelector("#learn-r-flourish"));
const send = (page, bytes) => page.evaluate((b) => window.__fakeMidi.send(b), bytes);

test.beforeEach(async ({ page }) => { await page.addInitScript(FAKE_MIDI); });

test("t6 learn binds the next CC, soft takeover holds a jump, the binding survives a reload", async ({ page }) => {
  await boot(page); await enable(page);
  await page.evaluate(() => window.__sonarAct.flourish(0.5));
  await midiPanel(page);
  await page.click("#learn-r-flourish");
  await expect(page.locator("#learn-r-flourish")).toHaveText("waiting");
  await send(page, [0xb0, 20, 100]);
  await expect(page.locator("#learn-r-flourish")).toHaveText("learn");
  await expect(page.locator("#learn-r-flourish").locator("..").locator("b")).toHaveText("cc 20 ch1 abs");
  await send(page, [0xb0, 20, 127]);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__garden.flourish)).toBe(0.5); // a jump does nothing
  await send(page, [0xb0, 20, 60]);
  await page.waitForFunction(() => Math.abs(window.__garden.flourish - 0.47) < 0.011, null, { timeout: 2000 });
  await page.waitForTimeout(300); // the refresh saves it
  await boot(page);
  expect(await page.evaluate(() => window.__midiMap.bindingOf("r-flourish"))).toMatchObject({ type: "cc", num: 20, ch: 0, mode: "abs" });
});

test("t6 notes: toggle, momentary, and panic fires only after the hold", async ({ page }) => {
  await boot(page); await enable(page);
  await midiPanel(page);
  await page.click("#learn-panic");
  await send(page, [0x90, 50, 100]); await send(page, [0x80, 50, 0]);
  expect(await page.evaluate(() => window.__midiMap.bindingOf("panic"))).toMatchObject({ type: "note", num: 50, mode: "hold", hold_ms: 1000 });
  await send(page, [0x90, 50, 100]); await page.waitForTimeout(300); await send(page, [0x80, 50, 0]); await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__sonar.panic)).toBe(false);
  await send(page, [0x90, 50, 100]); await page.waitForTimeout(1200); await send(page, [0x80, 50, 0]);
  expect(await page.evaluate(() => window.__sonar.panic)).toBe(true);
  await page.evaluate(() => window.__sonarAct.panic(false));
  // momentary blackout and a toggle on kill, loaded as a map
  await page.evaluate(() => { const M = window.__midiMap; M.load([...M.toJSON(), { act: "blackout", type: "note", num: 60, mode: "momentary" }, { act: "b-kill", type: "note", num: 61, mode: "trig" }]); });
  await send(page, [0x90, 60, 90]);
  await page.waitForFunction(() => window.sonarBlackout.on === true, null, { timeout: 2000 });
  await send(page, [0x90, 60, 0]);
  await page.waitForFunction(() => window.sonarBlackout.on === false, null, { timeout: 2000 });
  await send(page, [0x90, 61, 90]);
  await page.waitForFunction(() => window.__sonar.kill === true, null, { timeout: 2000 });
});

test("t6 conflicts show, one clears, clear all asks twice", async ({ page }) => {
  await boot(page); await enable(page);
  await midiPanel(page);
  await page.click("#learn-r-reverb"); await send(page, [0xb0, 21, 10]);
  await page.click("#learn-r-wind"); await send(page, [0xb0, 21, 10]);
  await expect(page.locator("#midi-conflicts")).toHaveText("conflict: cc 21 ch1 reverb, wind");
  await expect(page.locator("#learn-r-wind").locator("..")).toHaveClass(/conflict/);
  await page.click("#unbind-r-wind");
  await expect(page.locator("#midi-conflicts")).toHaveText("");
  await page.click("#b-midi-clearall");
  expect(await page.evaluate(() => window.__midiMap.bindings.length)).toBeGreaterThan(0);
  await page.click("#b-midi-clearall");
  expect(await page.evaluate(() => window.__midiMap.bindings.length)).toBe(0);
});

test("t6 the nanoKONTROL map loads from its file, REC held is panic, strip 6 is master; maps ride in setups", async ({ page }) => {
  await boot(page); await enable(page);
  await midiPanel(page);
  await page.selectOption("#s-midimap", "nanokontrol");
  await page.click("#b-midimap-load");
  await expect(page.locator("#midi-note")).toHaveText("loaded nanoKONTROL, verify with the wizard");
  expect(await page.evaluate(() => window.__midiMap.bindings.length)).toBe(11);
  await send(page, [0xb0, 44, 127]); await page.waitForTimeout(1200); await send(page, [0xb0, 44, 0]);
  expect(await page.evaluate(() => window.__sonar.panic)).toBe(true);
  await page.evaluate(() => window.__sonarAct.panic(false));
  // master: 0.7 now; a sweep through it takes over
  for (const v of [80, 90, 100, 110]) await send(page, [0xb0, 9, v]);
  await page.waitForFunction(() => Math.abs(window.__sonar.master - 110 / 127) < 0.011, null, { timeout: 2000 });
  // the map goes into a setup; another map, then the setup brings it back
  const s = await page.evaluate(() => window.__garden.toSetup());
  expect(s.midiMap.length).toBe(11);
  await page.selectOption("#s-midimap", "v020-notes"); await page.click("#b-midimap-load");
  await expect(page.locator("#midi-note")).toHaveText("loaded v0.2.0 notes");
  expect(await page.evaluate(() => window.__midiMap.bindings.length)).toBe(8);
  await page.evaluate((s) => window.__sonarAct.loadSetup(s, { now: true }), s);
  expect(await page.evaluate(() => window.__midiMap.bindings.length)).toBe(11);
  // a setup with no map keeps the current one
  await page.evaluate((s) => { delete s.midiMap; window.__sonarAct.loadSetup(s, { now: true }); }, s);
  expect(await page.evaluate(() => window.__midiMap.bindings.length)).toBe(11);
});

test("t6 MIDI out: notes on the voice's channel, clock at the tempo; clock in sets the tempo", async ({ page }) => {
  await boot(page, "index.html?seed=42&bpm=90"); await enable(page);
  await midiPanel(page);
  await page.waitForFunction(() => document.querySelector("#s-midiout option[value='out-1']"));
  await page.selectOption("#s-midiout", "out-1");
  await page.click("#b-midiout-notes");
  await page.evaluate(() => window.__sonarAct.route(2, "rain"));
  await page.waitForFunction(() => window.__fakeMidi.sent.filter((x) => (x[0][0] & 0xf0) === 0x90).length > 6, null, { timeout: 15000 });
  const chans = await page.evaluate(() => [...new Set(window.__fakeMidi.sent.filter((x) => (x[0][0] & 0xf0) === 0x90).map((x) => x[0][0] & 0x0f))].sort());
  expect(chans).toEqual([0, 1]); // saw on 1, rain on 2
  expect(await page.evaluate(() => window.__fakeMidi.sent.filter((x) => (x[0][0] & 0xf0) === 0x80).length)).toBeGreaterThan(3);
  await page.click("#b-midiout-notes");
  await page.evaluate(() => { window.__fakeMidi.sent.length = 0; });
  await page.click("#b-midiout-clock");
  await page.waitForTimeout(2200);
  const clk = await page.evaluate(() => { const t = window.__fakeMidi.sent.filter((x) => x[0][0] === 0xf8).map((x) => x[1]); return { n: t.length, start: window.__fakeMidi.sent.some((x) => x[0][0] === 0xfa), per: (t[t.length - 1] - t[0]) / (t.length - 1) }; });
  expect(clk.start).toBe(true);
  expect(Math.abs(clk.per - 60000 / (90 * 24))).toBeLessThan(0.5); // 27.8 ms at 90 bpm
  await page.click("#b-midiout-clock");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__fakeMidi.sent.some((x) => x[0][0] === 0xfc))).toBe(true);
  // clock in at 120: 24 ticks per beat, timestamps exact
  await page.click("#b-midi-clockin");
  await page.evaluate(() => { const t0 = performance.now(); for (let i = 0; i < 24 * 8; i++) window.__fakeMidi.send([0xf8], t0 + i * (60000 / (120 * 24))); });
  await page.waitForFunction(() => window.__sonar.bpm === 120, null, { timeout: 3000 });
});

test("t6 a flood through learn: learn takes one message, the gates still act, nothing throws", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await boot(page); await enable(page);
  await midiPanel(page);
  await page.evaluate(() => {
    let i = 0;
    window.__flood = setInterval(() => { for (let k = 0; k < 60; k++) { window.__fakeMidi.send([0xb0, 7, (i++) % 128]); window.__fakeMidi.send([0x90, 60 + (i % 12), 90]); window.__fakeMidi.send([0x80, 60 + (i % 12), 0]); } }, 10);
  });
  await page.waitForTimeout(200);
  await page.click("#learn-r-flourish");
  await page.waitForFunction(() => window.__midiMap.learning === null && window.__midiMap.bindingOf("r-flourish"), null, { timeout: 2000 });
  const b = await page.evaluate(() => window.__midiMap.bindingOf("r-flourish"));
  expect(["cc 7", "note"].some((x) => `${b.type} ${b.num}`.startsWith(x))).toBe(true);
  expect(await page.evaluate(() => window.__midiMap.bindings.filter((x) => x.act === "r-flourish").length)).toBe(1);
  // a second learn during the flood on a toggle, and the gates
  await page.click("#learn-b-kill");
  await page.waitForFunction(() => window.__midiMap.learning === null, null, { timeout: 2000 });
  await send(page, [0x90, 41, 127]);
  await page.waitForFunction(() => window.sonarBlackout.on === true, null, { timeout: 2000 });
  await send(page, [0x90, 41, 127]);
  await page.waitForFunction(() => window.sonarBlackout.on === false, null, { timeout: 2000 });
  await page.keyboard.press("b");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.sonarBlackout.on)).toBe(true);
  await page.keyboard.press("b");
  await page.evaluate(() => clearInterval(window.__flood));
  const f0 = await page.evaluate(() => window.__sonar.frames);
  await page.waitForFunction((f) => window.__sonar.frames > f + 5, f0, { timeout: 3000 });
  const m = await page.evaluate(() => ({ errors: window.__sonar.midi.errors, mapErrors: window.__midiMap.errors, handled: window.__sonar.midi.handled, dropped: window.__sonar.midi.dropped }));
  console.log("flood", JSON.stringify(m));
  expect(m.errors).toBe(0); expect(m.mapErrors).toBe(0);
  expect(errors).toEqual([]);
});

test("t6 without Web MIDI the panel says so in one line and everything else works", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { Object.defineProperty(Navigator.prototype, "requestMIDIAccess", { value: undefined, configurable: true }); } catch {} });
  await boot(page);
  await page.evaluate(() => window.__panels.openPanel("midi"));
  await expect(page.locator("#midi-status")).toHaveText("Web MIDI is not in this browser; everything else works.");
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.audio.played > 0, null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__sonar.midi.status)).toBe("no web midi");
  await expect(page.locator("#midi-status")).toHaveText("Web MIDI is not in this browser; everything else works.");
  await ctx.close();
});
