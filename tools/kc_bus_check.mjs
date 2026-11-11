// kc_bus_check.mjs · Tier 7.3 checks of the kc v04 _tmp_ pages (sonar=1, the bus) against their v03 and v02 parents.
// New file beside kc_check.mjs (that one is unchanged and still checks v03).
//   node tools/kc_bus_check.mjs <kodama-cycles dir> <http base serving that dir>
// For kc-01 and kc-03, from file:// and from http:
//   1. selftest=1 PASS on v04, flag off and with sonar=1
//   2. flag off: body DOM (scripts and comments removed), title, console equal to v03 and to v02; no KC_BUS global;
//      canvas pixels against v03 with 90 frames stepped by hand (frozen performance.now, queued rAF), rw=1 and rw=0, and sonar=1 with no message:
//      the gate is the scene state hash (objects, transforms, materials, geometry buffers) and KC.stats(), equal to v03;
//      differing pixels are counted beside a control pair (v03 loaded twice), since swiftshader readback here is not repeatable
//   3. sonar=1: a second page of the same origin posts on BroadcastChannel "sonar-bus":
//      lead note -> ring wave, non-lead note -> none; state density -> drawn rain drops; beats -> Wet / Shed / Dry; silence -> rest, v02 path
//   4. score=1&offline=1 still loads the vendored score and logs notes
// Prints JSON; exit 1 on any failure.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { chromium } from "../../00_shan-shui/shanshui-av/tools/node_modules/playwright/index.mjs";

const [kc, http] = process.argv.slice(2);
if (!kc || !http) { console.error("usage: node tools/kc_bus_check.mjs <kodama-cycles dir> <http base>"); process.exit(2); }
const PAGES = [
  ["kc-01", "02_scenes/C3-E3_kc-01_exuvia-rings_v02.html", "00_share/_tmp_C3-E3_kc-01_exuvia-rings_v03.html", "00_share/_tmp_C3-E3_kc-01_exuvia-rings_v04.html"],
  ["kc-03", "02_scenes/C3-E3_kc-03_rain-cells_v02.html", "00_share/_tmp_C3-E3_kc-03_rain-cells_v03.html", "00_share/_tmp_C3-E3_kc-03_rain-cells_v04.html"],
];
const b = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const url = (base, rel, q) => (base === "file" ? pathToFileURL(join(kc, rel)).href : http.replace(/\/$/, "") + "/" + rel.split("/").map(encodeURIComponent).join("/")) + (q ? "?" + q : "");
// the sender: any page of the same origin (file: the folder listing; http: the server's 404 page)
const senderUrl = (base) => (base === "file" ? pathToFileURL(join(kc, "00_share")).href + "/" : http.replace(/\/$/, "") + "/__sonar_sender__");
// fake: performance.now frozen and requestAnimationFrame queued by an init script, then exactly `wait` frames of 1/60 s stepped by hand
// (Playwright's clock keeps time flowing in a new document until paused, so boot and frame times varied between loads)
const FAKE = () => { let t = 1000; const q = []; performance.now = () => t; window.requestAnimationFrame = (f) => { q.push(f); return q.length; };
  window.__step = (n) => { for (let i = 0; i < n; i++) { t += 1000 / 60; for (const f of q.splice(0)) f(t); } }; };
async function open(u, { wait = 2500, fake = false } = {}) {
  const p = await ctx.newPage();
  const cons = [];
  p.on("console", (m) => cons.push(m.type() + ": " + m.text().replace(/blob:[^\s)]+/g, "blob:").slice(0, 200)));
  p.on("pageerror", (e) => cons.push("pageerror: " + e.message));
  if (fake) await p.addInitScript(FAKE);
  await p.goto(u, { waitUntil: "domcontentloaded", timeout: 120000 });
  if (fake) { await p.waitForFunction(() => window.__kcReady === true, null, { timeout: 60000, polling: 100 }); await p.evaluate((n) => window.__step(n), wait); }
  else { await p.waitForFunction(() => window.__kcReady === true, null, { timeout: 60000 }); await p.waitForTimeout(wait); }
  return { p, cons };
}
const dom = (p) => p.evaluate(() => {
  const c = document.body.cloneNode(true);
  c.querySelectorAll("script").forEach((s) => s.remove());
  const w = document.createTreeWalker(c, NodeFilter.SHOW_COMMENT); const cm = []; while (w.nextNode()) cm.push(w.currentNode); cm.forEach((n) => n.remove());
  c.querySelectorAll("#s-cyc,#s-phase,#s-level,#s-morph,#cycr,#phasebar,#fps").forEach((e) => { e.textContent = ""; e.removeAttribute("value"); e.removeAttribute("style"); });
  return { title: document.title, body: c.innerHTML.replace(/\s+/g, " ") };
});
const pix = (p) => p.evaluate(() => { window.KC.render(); return document.getElementById("gl").toDataURL("image/png"); });
// differing pixels between two PNG data URLs (any channel), and the largest channel step
let diffPage = null;
async function pxDiff(a, c) {
  if (a === c) return { n: 0, max: 0, bytesEqual: true };
  if (!diffPage) { diffPage = await ctx.newPage(); await diffPage.goto("about:blank"); }
  return diffPage.evaluate(async ([a, c]) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = s; });
    const [A, C] = await Promise.all([load(a), load(c)]);
    const get = (i) => { const cv = document.createElement("canvas"); cv.width = i.width; cv.height = i.height; const g = cv.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const x = get(A), y = get(C); let n = 0, max = 0;
    for (let k = 0; k < x.length; k += 4) { const m = Math.max(Math.abs(x[k] - y[k]), Math.abs(x[k + 1] - y[k + 1]), Math.abs(x[k + 2] - y[k + 2])); if (m) { n++; if (m > max) max = m; } }
    return { n, max, bytesEqual: false, of: x.length / 4 };
  }, [a, c]);
}
// the scene state behind the pixels: every object's type, visibility, transform, render order, material colour and opacity, and an
// FNV hash over the bytes of every geometry position / colour buffer and draw range (deterministic, unlike swiftshader readback here)
const sceneHash = (p) => p.evaluate(() => {
  let h = 2166136261 >>> 0, objs = 0, floats = 0;
  const mix = (x) => { h ^= x & 0xff; h = Math.imul(h, 16777619) >>> 0; h ^= (x >>> 8) & 0xff; h = Math.imul(h, 16777619) >>> 0; h ^= (x >>> 16) & 0xff; h = Math.imul(h, 16777619) >>> 0; h ^= x >>> 24; h = Math.imul(h, 16777619) >>> 0; };
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const num = (v) => { f32[0] = v; mix(u32[0]); floats++; };
  const str = (s) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); };
  const seen = new Set();
  const walk = (o) => { if (seen.has(o)) return; seen.add(o); objs++; str(o.type); mix(o.visible ? 1 : 0); mix(o.renderOrder | 0);
    for (const v of [o.position, o.scale]) { num(v.x); num(v.y); num(v.z); } num(o.rotation.x); num(o.rotation.y); num(o.rotation.z);
    const m = o.material; if (m) { if (m.color) { num(m.color.r); num(m.color.g); num(m.color.b); } num(m.opacity); mix(m.visible ? 1 : 0); }
    const g = o.geometry; if (g) { for (const k of ["position", "color"]) { const a = g.attributes && g.attributes[k]; if (a) { const b = new Uint32Array(a.array.buffer, a.array.byteOffset, a.array.byteLength >> 2); for (let i = 0; i < b.length; i++) mix(b[i]); floats += b.length; } }
      num(g.drawRange.start); num(g.drawRange.count === Infinity ? -1 : g.drawRange.count); }
    for (const c of o.children) walk(c); };
  // the page's top-level `scene` (a global lexical binding of its classic script, visible to evaluated code)
  // eslint-disable-next-line no-undef
  const s = typeof scene !== "undefined" ? scene : null; if (s) walk(s); else return null;
  return { hash: h.toString(16), objs, floats };
});
const stats = (p) => p.evaluate(() => { const s = window.KC.stats(); delete s.self; return s; });
const rainDrawn = (p) => p.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const o = window.KC.rw.rainObj; if (!o || !o.visible) return 0; const a = o.geometry.attributes.position.array; let n = 0; for (let i = 1; i < a.length; i += 6) if (a[i] !== -999) n++; return n; });
const bus = (p) => p.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const B = window.KC_BUS; if (!B) return null;
  const vis = B.waves ? B.waves.grp.children.filter((o) => o.visible).length : 0;
  return { ready: !!B.ready, live: B.live, dens: B.dens, counts: { ...B.counts }, rings: B.ringsActive(), ringLines: vis, phase: window.KC.cyc.phase, T: +window.KC.cyc.T.toFixed(4), t: +window.KC.cyc.t.toFixed(3), cycle: window.KC.cyc.count }; });
const res = { ok: true, pages: {} };
const fail = (m) => { res.ok = false; (res.fail ||= []).push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("uncaughtException", (e) => { fail("crash: " + e.message.split("\n")[0]); console.log(JSON.stringify(res, null, 1)); process.exit(1); });
for (const [id, v2, v3, v4] of PAGES) {
  const r = (res.pages[id] = {});
  for (const base of ["file", "http"]) {
    const R = (r[base] = {});
    // 1. selftest, flag off and sonar=1
    for (const q of ["selftest=1", "selftest=1&sonar=1"]) {
      const { p } = await open(url(base, v4, q), { wait: 0 });
      await p.waitForFunction(() => /^(PASS|FAIL) /.test(document.title), null, { timeout: 120000 }).catch(() => {});
      R[q] = (await p.title()).split(" ")[0]; await p.close();
      if (R[q] !== "PASS") fail(`${id} ${base} ${q} ${R[q]}`);
    }
    // 2a. flag off: DOM, title, console against v03 and v02 (real clock, frozen, as kc_check.mjs)
    { const a2 = await open(url(base, v2, "freeze=1&phase=2")), a3 = await open(url(base, v3, "freeze=1&phase=2")), c = await open(url(base, v4, "freeze=1&phase=2"));
      const d2 = await dom(a2.p), d3 = await dom(a3.p), dc = await dom(c.p);
      R.flagOff = { domEqV03: d3.body === dc.body, domEqV02: d2.body === dc.body, titleEqV03: d3.title === dc.title, titleEqV02: d2.title === dc.title,
        consoleEqV03: JSON.stringify(a3.cons) === JSON.stringify(c.cons), consoleEqV02: JSON.stringify(a2.cons) === JSON.stringify(c.cons),
        noBusGlobal: await c.p.evaluate(() => window.KC_BUS === undefined), noScoreGlobal: await c.p.evaluate(() => window.KC_SCORE === undefined), console: c.cons.slice(0, 5) };
      if (!Object.entries(R.flagOff).every(([k, v]) => k === "console" || v === true)) fail(`${id} ${base} flag-off differs`);
      for (const x of [a2, a3, c]) await x.p.close(); }
    // 2b. pixels and stats under a fake clock: v03 vs v04 flag off, v03 vs v04 sonar=1 with no message
    // control: v03 against a second v03 load (the harness's own noise); v04 passes when its diff to v03 is no larger than the control's
    R.pixels = {};
    for (const [lab, q3, q4] of [["rw1_run", "", ""], ["rw0_run", "rw=0", "rw=0"], ["rw1_phase2", "phase=2", "phase=2"], ["sonar_idle", "", "sonar=1"]]) {
      const A = await open(url(base, v3, q3), { wait: 90, fake: true }), A2 = await open(url(base, v3, q3), { wait: 90, fake: true }), C = await open(url(base, v4, q4), { wait: 90, fake: true });
      const ha = await sceneHash(A.p), ha2 = await sceneHash(A2.p), hc = await sceneHash(C.p);
      const pa = await pix(A.p), pa2 = await pix(A2.p), pc = await pix(C.p), sa = await stats(A.p), sa2 = await stats(A2.p), sc = await stats(C.p);
      const ctl = await pxDiff(pa, pa2), d = await pxDiff(pa, pc);
      R.pixels[lab] = { sceneEqV04: !!ha && JSON.stringify(ha) === JSON.stringify(hc), sceneEqControl: !!ha && JSON.stringify(ha) === JSON.stringify(ha2), scene: hc,
        pxV04: d, pxControl: ctl, statsEqV04: JSON.stringify(sa) === JSON.stringify(sc), statsEqControl: JSON.stringify(sa) === JSON.stringify(sa2), T: sc.T, phase: sc.phase };
      if (!R.pixels[lab].sceneEqV04 || !R.pixels[lab].statsEqV04 || d.n > ctl.n) fail(`${id} ${base} ${lab}: scene state, stats or pixels differ from v03`);
      for (const x of [A, A2, C]) await x.p.close();
    }
    // 3. the bus: sender page of the same origin
    { const { p } = await open(url(base, v4, "sonar=1&phase=1&cycle=600"), { wait: 800 });
      await p.waitForFunction(() => window.KC_BUS && window.KC_BUS.ready, null, { timeout: 10000 }).catch(() => {});
      const S = await ctx.newPage(); await S.goto(senderUrl(base));
      await S.evaluate(() => { window.__ch = new BroadcastChannel("sonar-bus"); window.post = (m) => window.__ch.postMessage({ ...m, src: "sonar", at: performance.timeOrigin + performance.now() }); });
      const post = (m) => S.evaluate((m) => window.post(m), m);
      const B = (R.bus = { before: await bus(p), rainBefore: await rainDrawn(p) });
      // lead note and a non-lead note
      await post({ t: "note", voice: "saw", plant: "p0", note: 62, freq: 293.66, vel: 0.4, lead: false }); await sleep(250);
      B.afterNonLead = await bus(p);
      await post({ t: "note", voice: "saw", plant: "p0", note: 60, freq: 261.63, vel: 0.9, lead: true }); await sleep(250);
      B.afterLead = await bus(p);
      for (let i = 0; i < 5; i++) { await post({ t: "note", voice: "saw", plant: "p1", note: 55 + i * 3, freq: 200, vel: 0.7, lead: true }); await sleep(60); }
      await sleep(200); B.afterLead5 = await bus(p);
      // density: 0.2 then 0.9 (the page holds Wet: phase=1, cycle=600, no beat yet)
      await post({ t: "state", key: "D dorian", density: 0.2, forest: 2, setup: "" }); await sleep(300); B.rainD02 = await rainDrawn(p);
      await post({ t: "state", key: "D dorian", density: 0.9, forest: 2, setup: "" }); await sleep(300); B.rainD09 = await rainDrawn(p);
      B.rainN = await p.evaluate(() => window.KC.rw.rainN);
      // beats: every beat of one 10 bar cycle, 40 ms apart, at bpm 6 so the ease between beats stays under 0.05 beat; phase read after two frames
      const seq = []; const t0 = Date.now();
      for (let beat = 0; beat <= 44; beat++) { await post({ t: "beat", beat, bar: Math.floor(beat / 4), bpm: 6 }); await sleep(40); const s = await bus(p); seq.push([beat, s.phase, s.T]); }
      // and 8 beats in real time at 120 bpm (0.5 s apart): the cycle position eases forward between beats
      const rt = []; for (let beat = 100; beat < 108; beat++) { await post({ t: "beat", beat, bar: Math.floor(beat / 4), bpm: 120 }); await sleep(250); rt.push((await bus(p)).T); await sleep(220); rt.push((await bus(p)).T); }
      B.realtimeT = rt; B.realtimeMonotonic = rt.every((x, i) => !i || x >= rt[i - 1]);
      B.beatMs = Date.now() - t0;
      const ph = seq.map((x) => x[1]); const steps = []; for (let i = 0; i < ph.length; i++) if (!i || ph[i] !== ph[i - 1]) steps.push([seq[i][0], ph[i]]);
      B.phaseSteps = steps; B.afterBeats = await bus(p);
      const split = await p.evaluate(() => window.KC.cyc.split.slice());
      const first = (x) => { for (let k = 0; k <= 40; k++) if ((k + 0.004) / 40 >= x) return k; return -1; };   // the beat where a phase starts
      B.split = split; B.expect = [[0, 1], [first(split[0]), 2], [first(split[0] + split[1]), 3], [40, 1]];
      await post({ t: "beat", beat: 44, bar: 11, bpm: 6 }); await sleep(100); B.beforeRest = await bus(p);   // back to Wet so the rain compares with rainBefore
      // silence -> rest (stale 2000 ms)
      const tRest = await p.evaluate(() => window.KC.cyc.t); await sleep(2800);
      B.afterRest = await bus(p); B.rainAfterRest = await rainDrawn(p);
      B.ownClockMoves = (await p.evaluate(() => window.KC.cyc.t)) !== tRest;
      B.errors = await p.evaluate(() => window.__kcErrors.slice());
      await S.close(); await p.close();
      const okSteps = JSON.stringify(steps) === JSON.stringify(B.expect);
      const checks = {
        connected: B.before && B.before.ready && !B.before.live,
        nonLeadNoRing: B.afterNonLead.counts.note === 1 && B.afterNonLead.rings === 0,
        leadRing: B.afterLead.counts.lead === 1 && B.afterLead.rings === 1 && B.afterLead.ringLines > 0,
        lead5: B.afterLead5.counts.ring === 6,
        density: B.rainD02 > 0 && B.rainD09 > B.rainD02 && Math.abs(B.rainD02 - Math.floor(B.rainN * 0.2)) <= 1 && Math.abs(B.rainD09 - Math.floor(B.rainN * 0.9)) <= 1,
        beats: okSteps && B.afterBeats.cycle >= 1 && B.realtimeMonotonic,
        rest: B.afterRest.counts.rest === 1 && !B.afterRest.live && B.afterRest.rings === 0 && B.afterRest.dens === null && B.rainAfterRest === B.rainBefore && B.ownClockMoves,
        errors: B.errors.length === 0,
      };
      B.checks = checks;
      for (const [k, v] of Object.entries(checks)) if (!v) fail(`${id} ${base} bus ${k}`);
    }
    // 3b. sonarClock=0: beats do not move the cycle
    { const { p } = await open(url(base, v4, "sonar=1&sonarClock=0&phase=1&cycle=600"), { wait: 800 });
      await p.waitForFunction(() => window.KC_BUS && window.KC_BUS.ready, null, { timeout: 10000 }).catch(() => {});
      const S = await ctx.newPage(); await S.goto(senderUrl(base));
      await S.evaluate(() => { const ch = new BroadcastChannel("sonar-bus"); window.post = (m) => ch.postMessage({ ...m, src: "sonar" }); });
      await S.evaluate(() => window.post({ t: "beat", beat: 30, bar: 7, bpm: 100 })); await sleep(300);
      const s = await bus(p); R.clockOff = { beats: s.counts.beat, phase: s.phase };
      if (s.counts.beat !== 1 || s.phase !== 1) fail(`${id} ${base} sonarClock=0 moved the cycle`);
      await S.close(); await p.close(); }
    // 4. score still loads (vendored)
    { const { p } = await open(url(base, v4, "score=1&offline=1&sonar=1&cycle=12"), { wait: 500 });
      await p.mouse.click(640, 300);
      await p.waitForFunction(() => window.KC_SCORE && window.KC_SCORE.score.log.some((e) => e.k === "note"), null, { timeout: 30000 }).catch(() => {});
      R.score = await p.evaluate(() => window.KC_SCORE ? { from: window.KC_SCORE.from, notes: window.KC_SCORE.score.log.filter((e) => e.k === "note").length } : null);
      if (!R.score || !R.score.notes) fail(`${id} ${base} score: no notes`);
      await p.close(); }
  }
}
await b.close();
console.log(JSON.stringify(res, null, 1));
process.exit(res.ok ? 0 : 1);
