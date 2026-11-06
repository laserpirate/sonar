// sonar Tier 3: engines render sound offline; Enable starts audio + MIDI;
// default MIDI map; keys and blackout work during a MIDI flood; a vanished
// device does not throw. Web MIDI is faked with an init script (no hardware).
import { test, expect } from "@playwright/test";

const FAKE_MIDI = () => {
  const listeners = [];
  const input = { name: "fake pads", id: "fake-1", onmidimessage: null, state: "connected" };
  const inputs = new Map([["fake-1", input]]);
  const access = { inputs, outputs: new Map(), onstatechange: null, sysexEnabled: false };
  window.__fakeMidi = {
    send(bytes) { if (input.onmidimessage) input.onmidimessage({ data: new Uint8Array(bytes) }); },
    unplug() { inputs.delete("fake-1"); input.state = "disconnected"; if (access.onstatechange) access.onstatechange({ port: input }); },
  };
  navigator.requestMIDIAccess = async () => access;
};

async function blackPixels(page) {
  const shot = await page.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let max = 0; for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
    return max;
  }, shot.toString("base64"));
}

test("e: engines render audible, unclipped sound offline (saw and rain)", async ({ page }) => {
  await page.goto("index.html?seed=3");
  const r = await page.evaluate(async () => {
    const { SawEngine } = await import("./js/engine-saw.js");
    const { RainEngine } = await import("./js/engine-rain.js");
    const out = {};
    for (const kind of ["saw", "rain"]) {
      const ctx = new OfflineAudioContext(2, 48000 * 6, 48000);
      const lim = ctx.createGain();
      lim.connect(ctx.destination);
      const e = kind === "saw" ? new SawEngine(ctx, lim) : new RainEngine(ctx, lim, { params: { cutoff: 500, release: 3 } });
      const notes = [69, 72, 76, 79, 81, 84];
      notes.forEach((n, i) => {
        const f = 440 * 2 ** ((n - 69) / 12);
        if (kind === "saw") e.noteOn(n, f, 120 / 90, i * 0.5); else e.hz(f, i * 0.5);
      });
      const buf = await ctx.startRendering();
      let peak = 0, sum = 0;
      for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; } }
      out[kind] = { peakDb: 20 * Math.log10(peak + 1e-12), rmsDb: 10 * Math.log10(sum / (2 * buf.length) + 1e-12) };
    }
    return out;
  });
  console.log("offline levels", JSON.stringify(r));
  for (const k of ["saw", "rain"]) {
    expect(r[k].peakDb).toBeGreaterThan(-20);
    expect(r[k].peakDb).toBeLessThan(6); // the master limiter catches the rest
    expect(r[k].rmsDb).toBeGreaterThan(-50);
  }
});

test("d: enable, MIDI default map, flood with keys and blackout, unplug", async ({ page }) => {
  await page.addInitScript(FAKE_MIDI);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("index.html?seed=3&bpm=160");
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3);
  expect(await page.evaluate(() => !!window.__sonar.audio)).toBe(false); // nothing before the click
  await page.click("#b-enable");
  await page.waitForFunction(() => window.__sonar.audio && window.__sonar.midi && window.__sonar.midi.devices.length === 1, null, { timeout: 5000 });
  await page.waitForFunction(() => window.__sonar.audio.played > 0, null, { timeout: 6000 });

  // note 37 -> next gen (p13 g1 -> g2)
  const g0 = await page.evaluate(() => window.__sonar.lastGen[1].gen);
  await page.evaluate(() => window.__fakeMidi.send([0x90, 37, 100]));
  await page.waitForFunction((g) => window.__sonar.lastGen[1].gen !== g, g0, { timeout: 2000 });
  // CC 1 with pickup: jump far away does nothing, then sweep through 160 -> takes over
  await page.evaluate(() => window.__fakeMidi.send([0xb0, 1, 0]));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__sonar.bpm)).toBe(160);
  await page.evaluate(() => { for (const v of [120, 124, 127, 126, 100]) window.__fakeMidi.send([0xb0, 1, v]); });
  await page.waitForFunction(() => window.__sonar.bpm < 160, null, { timeout: 2000 });

  // flood: 3000 CC and note messages while B is pressed
  await page.evaluate(() => {
    let i = 0;
    window.__flood = setInterval(() => { for (let k = 0; k < 60; k++) { window.__fakeMidi.send([0xb0, 7, (i++) % 128]); window.__fakeMidi.send([0x90, 60 + (i % 12), 90]); } }, 10);
  });
  await page.waitForTimeout(300);
  await page.keyboard.press("b");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.sonarBlackout.on)).toBe(true);
  expect(await blackPixels(page)).toBe(0);
  await page.keyboard.press("b");
  // note 41 toggles blackout from MIDI during the flood
  await page.evaluate(() => window.__fakeMidi.send([0x90, 41, 127]));
  await page.waitForFunction(() => window.sonarBlackout.on === true, null, { timeout: 2000 });
  await page.evaluate(() => window.__fakeMidi.send([0x90, 41, 127]));
  await page.waitForFunction(() => window.sonarBlackout.on === false, null, { timeout: 2000 });
  // Esc held 1 s during the flood -> panic
  await page.keyboard.down("Escape");
  await page.waitForTimeout(1150);
  await page.keyboard.up("Escape");
  expect(await page.evaluate(() => window.__sonar.panic)).toBe(true);
  await page.evaluate(() => clearInterval(window.__flood));
  // unplug: no throw, frames keep coming
  await page.evaluate(() => window.__fakeMidi.unplug());
  const f0 = await page.evaluate(() => window.__sonar.frames);
  await page.waitForTimeout(300);
  await page.keyboard.down("Escape"); await page.waitForTimeout(1150); await page.keyboard.up("Escape");
  expect(await page.evaluate(() => window.__sonar.panic)).toBe(false);
  await page.waitForFunction((f) => window.__sonar.frames > f + 5, f0, { timeout: 2000 });
  const m = await page.evaluate(() => ({ handled: window.__sonar.midi.handled, dropped: window.__sonar.midi.dropped, errors: window.__sonar.midi.errors, devices: window.__sonar.midi.devices }));
  console.log("midi", JSON.stringify(m));
  expect(m.errors).toBe(0);
  expect(m.devices.length).toBe(0);
  expect(errors).toEqual([]);
});
