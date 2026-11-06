// Dump lsys.js geometry and the first notes for given plants as JSON.
//   node tools/lsys_dump.mjs <plant numbers comma> <generation> [beats]
// Used by tools/identity_lsys.py to compare against flora's Lua running under lupa.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Plant, Sequencer, makeRandom } from "../docs/js/lsys.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "docs", "js", "catalog.json"), "utf8"));
const nums = (process.argv[2] || "1,2,4").split(",").map(Number);
const gen = Number(process.argv[3] || 2);
const beats = Number(process.argv[4] || 16);
const out = {};
for (const n of nums) {
  const random = makeRandom(7);
  const p = new Plant(1, { random, defaults: catalog.defaults });
  p.setup(catalog.plants[n - 1], n, gen);
  const g = p.render();
  const seq = new Sequencer(p, catalog.defaults, { random });
  const evs = seq.run(beats);
  out["p" + String(n).padStart(2, "0")] = {
    generation: p.currentGeneration,
    sentence: p.sentence,
    segments: g.segments.length,
    circles: g.circles.length,
    seg: g.segments.map((s) => [s.i, s.c, +s.x1.toFixed(4), +s.y1.toFixed(4), +s.x2.toFixed(4), +s.y2.toFixed(4)]),
    notes: evs.filter((e) => e.kind === "note").map((e) => [e.t, e.idx, e.note]),
    rests: evs.filter((e) => e.kind === "rest").map((e) => [e.t, e.idx]),
  };
}
process.stdout.write(JSON.stringify(out));
