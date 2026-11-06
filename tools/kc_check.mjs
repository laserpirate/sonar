// kc_check.mjs · Tier 4 checks of the kc v03 _tmp_ pages against their v02 parents.
//   node tools/kc_check.mjs <kodama-cycles dir> <http base serving that dir>
// For kc-01 and kc-03, from file:// and from http:
//   1. selftest=1 PASS on v03
//   2. flag off: body DOM (scripts and comments removed), title and console messages equal to v02
//   3. score=1 (online) and score=1&offline=1: after a click the score loads and logs events
// Prints JSON; exit 1 on any failure.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { chromium } from "../../00_shan-shui/shanshui-av/tools/node_modules/playwright/index.mjs";

const [kc, http] = process.argv.slice(2);
if (!kc || !http) { console.error("usage: node tools/kc_check.mjs <kodama-cycles dir> <http base>"); process.exit(2); }
const PAGES = [
  ["kc-01", "02_scenes/C3-E3_kc-01_exuvia-rings_v02.html", "00_share/_tmp_C3-E3_kc-01_exuvia-rings_v03.html"],
  ["kc-03", "02_scenes/C3-E3_kc-03_rain-cells_v02.html", "00_share/_tmp_C3-E3_kc-03_rain-cells_v03.html"],
];
const b = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const url = (base, rel, q) => (base === "file" ? pathToFileURL(join(kc, rel)).href : http.replace(/\/$/, "") + "/" + rel.split("/").map(encodeURIComponent).join("/")) + (q ? "?" + q : "");
async function open(u, wait = 2500) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const cons = [];
  p.on("console", (m) => cons.push(m.type() + ": " + m.text().replace(/blob:[^\s)]+/g, "blob:").slice(0, 200)));
  p.on("pageerror", (e) => cons.push("pageerror: " + e.message));
  await p.goto(u);
  await p.waitForFunction(() => window.__kcReady === true, null, { timeout: 60000 });
  await p.waitForTimeout(wait);
  return { p, cons };
}
const dom = (p) => p.evaluate(() => {
  const c = document.body.cloneNode(true);
  c.querySelectorAll("script").forEach((s) => s.remove());
  const w = document.createTreeWalker(c, NodeFilter.SHOW_COMMENT); const cm = []; while (w.nextNode()) cm.push(w.currentNode); cm.forEach((n) => n.remove());
  c.querySelectorAll("#s-cyc,#s-phase,#s-level,#s-morph,#cycr,#phasebar,#fps").forEach((e) => { e.textContent = ""; e.removeAttribute("value"); e.removeAttribute("style"); });
  return { title: document.title, body: c.innerHTML.replace(/\s+/g, " ") };
});
const res = { ok: true, pages: {} };
const fail = (m) => { res.ok = false; (res.fail ||= []).push(m); };
for (const [id, v2, v3] of PAGES) {
  const r = (res.pages[id] = {});
  for (const base of ["file", "http"]) {
    const R = (r[base] = {});
    // 1. selftest
    { const { p } = await open(url(base, v3, "selftest=1"), 0);
      await p.waitForFunction(() => /^(PASS|FAIL) /.test(document.title), null, { timeout: 120000 }).catch(() => {});
      R.selftest = (await p.title()).split(" ")[0]; await p.close();
      if (R.selftest !== "PASS") fail(`${id} ${base} selftest ${R.selftest}`); }
    // 2. flag off equals v02 (frozen at the same cycle point so the strip text matches)
    { const a = await open(url(base, v2, "freeze=1&phase=2")), c = await open(url(base, v3, "freeze=1&phase=2"));
      const da = await dom(a.p), dc = await dom(c.p);
      R.domEqual = da.body === dc.body; R.titleEqual = da.title === dc.title;
      R.consoleEqual = JSON.stringify(a.cons) === JSON.stringify(c.cons); R.console = c.cons.slice(0, 5);
      R.noScoreGlobal = await c.p.evaluate(() => window.KC_SCORE === undefined);
      if (!R.domEqual || !R.titleEqual || !R.consoleEqual || !R.noScoreGlobal) fail(`${id} ${base} flag-off differs`);
      await a.p.close(); await c.p.close(); }
    // 3. score on, online and offline
    for (const q of ["score=1&cycle=12", "score=1&offline=1&cycle=12"]) {
      const { p, cons } = await open(url(base, v3, q), 500);
      await p.mouse.click(640, 300);
      await p.waitForFunction(() => window.KC_SCORE && window.KC_SCORE.score.log.some((e) => e.k === "note"), null, { timeout: 30000 }).catch(() => {});
      const s = await p.evaluate(() => window.KC_SCORE ? { from: window.KC_SCORE.from, events: window.KC_SCORE.score.log.length, notes: window.KC_SCORE.score.log.filter((e) => e.k === "note").length, phases: window.KC_SCORE.score.log.filter((e) => e.k === "phase").length, strip: window.KC_SCORE.score.strip() } : null);
      const errs = await p.evaluate(() => window.__kcErrors.slice());
      R[q] = { ...s, errors: errs, console: cons.filter((c) => c.startsWith("error")).slice(0, 3) };
      if (!s || !s.notes) fail(`${id} ${base} ${q}: no score notes`);
      await p.close();
    }
  }
}
await b.close();
console.log(JSON.stringify(res, null, 1));
process.exit(res.ok ? 0 : 1);
