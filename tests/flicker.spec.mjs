// flicker.spec.mjs · pixel diffs under Playwright's fake clock. Written before the fix (Tier 0):
//   a  paused: consecutive canvas frames are pixel-identical
//   b  playing: between frames 50 ms apart, changed pixels sit only in the lit-note regions,
//      no frame is blank, no plant moves by more than 0.5 px
//   c  a resize event never leaves a blank canvas between frames
// Numbers go to tests/logs/flicker_<label>.json (FLICKER_LABEL, default "current").
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const LABEL = process.env.FLICKER_LABEL || "current";
const OUT = new URL(`./logs/flicker_${LABEL}.json`, import.meta.url);
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const save = () => { mkdirSync(new URL("./logs/", import.meta.url), { recursive: true }); writeFileSync(OUT, JSON.stringify(results, null, 1)); };

// records the lit overlay (any stroke or fill in the lit colour) on the page's main canvas
const recorder = () => {
  // one raster path from the first frame: Chrome moves a canvas from GPU to CPU after a readback,
  // and the two antialias differently, which would read as a changed frame
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o) { return gc.call(this, t, t === "2d" ? { ...o, willReadFrequently: true } : o); };
  const P = CanvasRenderingContext2D.prototype;
  const lit = []; let path = [];
  window.__lit = lit;
  const isMain = (c) => c.canvas && c.canvas.id === "c";
  const wrap = (name, f) => { const o = P[name]; P[name] = function (...a) { if (isMain(this)) f(this, a); return o.apply(this, a); }; };
  wrap("beginPath", () => { path = []; });
  let last = null;
  wrap("moveTo", (c, a) => { path.push([a[0], a[1], 0]); last = a; });
  wrap("lineTo", (c, a) => { // sample along the segment, so the mask covers the line and not only its ends
    if (last) { const n = Math.ceil(Math.hypot(a[0] - last[0], a[1] - last[1]) / 2); for (let i = 1; i < n; i++) path.push([last[0] + ((a[0] - last[0]) * i) / n, last[1] + ((a[1] - last[1]) * i) / n, 0]); }
    path.push([a[0], a[1], 0]); last = a;
  });
  wrap("arc", (c, a) => path.push([a[0], a[1], a[2]]));
  const isLit = (s) => typeof s === "string" && /159, ?200, ?240|#9fc8f0/i.test(s);
  wrap("stroke", (c) => { if (isLit(c.strokeStyle)) for (const p of path) lit.push([p[0], p[1], p[2] + c.lineWidth]); });
  wrap("fill", (c) => { if (isLit(c.fillStyle)) for (const p of path) lit.push([p[0], p[1], p[2] + 1]); });
  window.__grab = () => {
    const c = document.getElementById("c");
    return { w: c.width, h: c.height, d: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
  };
  // compare two grabs, ignoring lit shapes (dilated) seen since the first grab
  window.__cmp = (A, B, shapes, pad) => {
    if (A.w !== B.w || A.h !== B.h) return { size: true, changed: -1, stray: -1, shift: 1e9, inkA: 0, inkB: 0 };
    const { w, h } = A;
    const mask = new Uint8Array(w * h);
    for (const [x, y, r] of shapes) {
      const R = Math.ceil(r + pad);
      const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(w - 1, Math.ceil(x + R));
      const y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(h - 1, Math.ceil(y + R));
      for (let j = y0; j <= y1; j++) mask.fill(1, j * w + x0, j * w + x1 + 1);
    }
    const sb = [1e9, 1e9, -1, -1]; let sd = 0;
    let changed = 0, stray = 0, inkA = 0, inkB = 0, ax = 0, ay = 0, bx = 0, by = 0, n = 0, nb = 0;
    const ink = (d, i) => d[i] + d[i + 1] + d[i + 2] > 60;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const a = A.d, b = B.d;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
        changed++;
        if (!mask[p]) { stray++; const x = p % w, y = (p / w) | 0; sb[0] = Math.min(sb[0], x); sb[1] = Math.min(sb[1], y); sb[2] = Math.max(sb[2], x); sb[3] = Math.max(sb[3], y); sd = Math.max(sd, Math.abs(a[i] - b[i]), Math.abs(a[i + 2] - b[i + 2])); }
      }
      const ia = ink(a, i), ib = ink(b, i);
      if (ia) inkA++;
      if (ib) inkB++;
      if (mask[p]) continue;
      const x = p % w, y = (p / w) | 0;
      if (ia) { ax += x; ay += y; n++; }
      if (ib) { bx += x; by += y; nb++; }
    }
    const shift = n && nb ? Math.max(Math.abs(ax / n - bx / nb), Math.abs(ay / n - by / nb)) : (n || nb ? 1e9 : 0);
    return { changed, stray, shift: +shift.toFixed(3), inkA, inkB, sb, sd };
  };
};

async function boot(page, url) {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.addInitScript(recorder);
  await page.goto(url);
  await page.waitForFunction(() => window.__sonar && window.__sonar.frames > 3, null, { timeout: 20000 });
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 2000));
  // after the jump the fake clock holds animation frames for about 2 s; measure only once they flow
  const f0 = await page.evaluate(() => window.__sonar.frames);
  for (let i = 0; i < 80; i++) {
    await page.clock.runFor(100);
    if ((await page.evaluate(() => window.__sonar.frames)) > f0 + 40) break;
  }
}

// diagnostics for each suspect, read from the garden between frames
const probe = (page) => page.evaluate(() => window.__garden.plants.slice(0, 2).map((p) => ({
  theta: p.turtle.theta, length: p.turtle.length, ox: p.offset.x, oy: p.offset.y })));

async function series(page, n, stepMs) {
  const per = [];
  await page.clock.runFor(stepMs);
  await page.evaluate(() => { window.__prev = window.__grab(); window.__prevLit = window.__lit.slice(); window.__lit.length = 0; });
  let p0 = await probe(page), nudges = 0, thetaMoves = 0;
  const hud0 = await page.evaluate(() => document.getElementById("hud").offsetHeight);
  let hudJumps = 0, hudLast = hud0;
  for (let i = 0; i < n; i++) {
    await page.clock.runFor(stepMs);
    const r = await page.evaluate(() => {
      const B = window.__grab();
      const c = window.__cmp(window.__prev, B, window.__prevLit.concat(window.__lit), 6); // lit in either frame
      window.__prev = B;
      // a step can pass with no frame under the fake clock: keep the last frame's shapes until a frame comes
      if (window.__sonar.frames !== window.__lastF) { window.__lastF = window.__sonar.frames; window.__prevLit = window.__lit.slice(); window.__lit.length = 0; }
      return { ...c, hud: document.getElementById("hud").offsetHeight };
    });
    per.push(r);
    if (r.stray > 0 && process.env.FLICKER_SHOT) {
      const info = await page.evaluate(() => ({ url: document.getElementById("c").toDataURL("image/png"), n: window.__lit.length, pn: window.__prevLit.length, f: window.__sonar.frames, last: window.__sonar.lastNote }));
      writeFileSync(process.env.FLICKER_SHOT, Buffer.from(info.url.split(",")[1], "base64"));
      console.log("SHOT", i, JSON.stringify({ ...info, url: 0 }));
    }
    if (r.hud !== hudLast) { hudJumps++; hudLast = r.hud; }
    const p1 = await probe(page);
    for (let k = 0; k < 2; k++) {
      if (p1[k].length !== p0[k].length || p1[k].ox !== p0[k].ox || p1[k].oy !== p0[k].oy) nudges++;
      if (p1[k].theta !== p0[k].theta) thetaMoves++;
    }
    p0 = p1;
  }
  const mx = (f) => Math.max(...per.map(f));
  const inks = per.map((r) => r.inkB);
  return {
    frames: n, changedMax: mx((r) => r.changed), strayMax: mx((r) => r.stray), strayFrames: per.filter((r) => r.stray > 0).length,
    strayAt: per.map((r, i) => (r.stray > 0 ? `${i}:${r.stray}/${r.hud} box ${r.sb} d${r.sd}` : null)).filter(Boolean).slice(0, 12),
    shiftMax: mx((r) => r.shift), blank: inks.filter((v) => v === 0).length, inkMin: Math.min(...inks), inkMax: Math.max(...inks),
    nudges, thetaMoves, hudJumps,
  };
}

const CASES = [
  { name: "desktop_seed42", vp: { width: 1280, height: 720 }, dpr: 1, url: "index.html?seed=42" },
  { name: "desktop_dpr2_seed7", vp: { width: 1280, height: 720 }, dpr: 2, url: "index.html?seed=7" },
  { name: "phone_seed42", vp: { width: 390, height: 844 }, dpr: 3, url: "index.html?seed=42" },
];

for (const C of CASES) {
  test.describe(C.name, () => {
    test.use({ viewport: C.vp, deviceScaleFactor: C.dpr, contextOptions: { reducedMotion: "reduce" } });

    test(`a paused: consecutive frames identical (${C.name})`, async ({ page }) => {
      await boot(page, C.url);
      await page.evaluate(() => window.__sonarAct.play(false));
      await page.clock.runFor(7000); // lit notes decay away first
      const r = await series(page, 30, 17);
      results[C.name + ":a"] = r; save();
      console.log("flicker a", C.name, JSON.stringify(r));
      expect(r.blank).toBe(0);
      expect(r.changedMax).toBe(0);
    });

    test(`b playing: only lit regions change (${C.name})`, async ({ page }) => {
      await boot(page, C.url);
      await page.clock.runFor(1000);
      await page.evaluate(() => window.__sonarAct.reset()); // the plants start over, as on every preset change
      await page.clock.runFor(100);
      const r = await series(page, 60, 50);
      results[C.name + ":b"] = r; save();
      console.log("flicker b", C.name, JSON.stringify(r));
      expect(r.blank).toBe(0);
      expect(r.strayMax).toBe(0);
      expect(r.shiftMax).toBeLessThanOrEqual(0.5);
    });

    test(`c resize never blanks (${C.name})`, async ({ page }) => {
      await boot(page, C.url);
      await page.clock.runFor(200);
      const ink = await page.evaluate(() => {
        window.dispatchEvent(new Event("resize"));
        const { w, h, d } = window.__grab();
        let n = 0; for (let i = 0; i < w * h * 4; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
        return n;
      });
      results[C.name + ":c"] = { inkRightAfterResize: ink }; save();
      console.log("flicker c", C.name, ink);
      expect(ink).toBeGreaterThan(0);
    });
  });
}

// with the sway on (no reduced motion): the plants move as a slow shear, never by more than 0.5 px per 50 ms; paused stays still
test.describe("sway", () => {
  test.use({ viewport: { width: 1280, height: 720 }, contextOptions: { reducedMotion: "no-preference" } });
  test("d sway: slow while playing, still when paused", async ({ page }) => {
    await boot(page, "index.html?seed=42");
    await page.clock.runFor(1000);
    // how far the top of each plant moves per 50 ms, from the projection itself: a pixel centroid
    // is noisy on antialiased lines in motion
    const tips = () => page.evaluate(() => { const st = window.__stage; return st.items.map((it) => { const b = st.boxOf(it); return st._sway(it.id) * (b.y1 - b.y0); }); });
    let prev = await tips(), maxStep = 0, moved = 0;
    for (let i = 0; i < 40; i++) {
      await page.clock.runFor(50);
      const cur = await tips();
      cur.forEach((v, k) => { maxStep = Math.max(maxStep, Math.abs(v - prev[k])); moved += Math.abs(v - prev[k]); });
      prev = cur;
    }
    const r = { maxStepPx: +maxStep.toFixed(3), totalPx: +moved.toFixed(2) };
    results["sway:b"] = r; save();
    console.log("flicker d", JSON.stringify(r));
    expect(r.totalPx).toBeGreaterThan(0);
    expect(r.maxStepPx).toBeLessThanOrEqual(0.5);
    await page.evaluate(() => window.__sonarAct.play(false));
    await page.clock.runFor(7000);
    const q = await series(page, 20, 17);
    results["sway:a"] = q; save();
    expect(q.changedMax).toBe(0);
  });
});
