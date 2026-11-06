// Note events for a demo render, from the shared core (docs/js/lsys.js).
//   node tools/demo_events.mjs <plant> <seconds> <bpm> <seed> [gen_every_beats]
// Both plants run the same catalog entry, as flora starts them (both on one
// instruction). Every `gen_every_beats` the plants step one generation until
// max, as a player turning e/k through a set. Writes JSON to stdout.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Plant, Sequencer, checkPlantPosition, makeRandom } from "../docs/js/lsys.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "docs", "js", "catalog.json"), "utf8"));
const D = catalog.defaults;
const [plantNum, seconds, bpm, seed, genEvery] = [Number(process.argv[2] || 1), Number(process.argv[3] || 90),
  Number(process.argv[4] || 90), Number(process.argv[5] || 1), Number(process.argv[6] || 32)];
const random = makeRandom(seed);
const plants = [new Plant(1, { random, defaults: D }), new Plant(2, { random, defaults: D })];
for (const p of plants) p.setup(catalog.plants[plantNum - 1], plantNum);
const seqs = plants.map((p) => new Sequencer(p, D, { random, t: 0 }));
const beats = (seconds * bpm) / 60;
const events = [];
const gens = [];
// run in 1-beat slices so generation steps and the screen fit loop interleave like the device
for (let b = 0; b < beats; b++) {
  for (let f = 0; f < 4; f++) { checkPlantPosition(plants); for (const p of plants) p.render(); }
  if (b > 0 && genEvery > 0 && b % genEvery === 0) {
    for (const p of plants) if (p.generate(1)) gens.push({ t: (b * 60) / bpm, plant: p.id, gen: p.currentGeneration });
  }
  for (let k = 0; k < 2; k++) {
    for (const e of seqs[k].run(b + 1)) {
      if (e.kind === "note") events.push({ t: (e.t * 60) / bpm, plant: k + 1, note: e.note, freq: e.freq, idx: e.idx });
    }
  }
}
process.stdout.write(JSON.stringify({ plant: plantNum, bpm, seconds, seed, sawRate: bpm / 90, events, gens }));
