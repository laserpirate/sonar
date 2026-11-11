// compare_v020.mjs · saw and rain against the v0.2.0 tag: same offline renders on installed Chrome,
// rms within 0.5 dB. Exports the tag's docs/ into tools/_tmp/v020 (ignored by git), serves both trees.
//   node tools/compare_v020.mjs            writes tests/logs/levels_v020.json, exit 1 when a case is off
import { execSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../tests/node_modules/playwright/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, "tools", "_tmp", "v020");
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
execSync(`git archive v0.2.0 docs | tar -x -C "${tmp.replace(/\\/g, "/")}"`, { cwd: root, shell: "bash" });
const serve = (port, dir) => spawn(process.execPath, [join(root, "tools", "serve.mjs"), "--port", String(port), "--dir", dir], { stdio: "ignore" });
const servers = [serve(8203, join(tmp, "docs")), serve(8204, join(root, "docs"))];
await new Promise((f) => setTimeout(f, 800));

const CASES = [
  { name: "saw", seed: 42, seconds: 30, bpm: 90 },
  { name: "saw delay 0.4", seed: 42, seconds: 30, bpm: 90, delay: 0.4 },
  { name: "rain", seed: 42, seconds: 30, bpm: 90, engine: "rain" },
  { name: "rain delay 0.4", seed: 42, seconds: 30, bpm: 90, engine: "rain", delay: 0.4 },
  { name: "saw seed 7 at 120", seed: 7, seconds: 30, bpm: 120 },
];
const b = await chromium.launch({ channel: "chrome" });
const out = [];
try {
  for (const port of [8203, 8204]) {
    const p = await b.newPage();
    await p.goto(`http://127.0.0.1:${port}/index.html?seed=3`);
    for (const c of CASES) {
      const r = await p.evaluate(async (c) => {
        const { renderGarden, levels } = await import("./js/garden-offline.js");
        const catalog = await (await fetch("./js/catalog.json")).json();
        const a = await renderGarden(catalog, c);
        return { ...levels(a.buf), n: a.log.length };
      }, c);
      out.push({ build: port === 8203 ? "v0.2.0" : "now", ...c, ...r });
    }
    await p.close();
  }
} finally { await b.close(); for (const s of servers) s.kill(); }

const rows = CASES.map((c) => {
  const a = out.find((x) => x.build === "v0.2.0" && x.name === c.name), n = out.find((x) => x.build === "now" && x.name === c.name);
  return { case: c.name, v020: +a.rmsDb.toFixed(2), now: +n.rmsDb.toFixed(2), diff: +(n.rmsDb - a.rmsDb).toFixed(2), events: [a.n, n.n] };
});
const ok = rows.every((r) => Math.abs(r.diff) <= 0.5 && r.events[0] === r.events[1]);
writeFileSync(join(root, "tests", "logs", "levels_v020.json"), JSON.stringify({ browser: "installed Chrome", rows, ok }, null, 1));
for (const r of rows) console.log(r.case.padEnd(20), "v0.2.0", r.v020, "now", r.now, "diff", r.diff, "events", r.events.join("/"));
console.log(ok ? "saw and rain within 0.5 dB of v0.2.0" : "OFF");
process.exit(ok ? 0 : 1);
