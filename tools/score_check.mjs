// score_check.mjs · determinism of docs/js/score.js with no audio, in Node.
//   node tools/score_check.mjs [seconds]
// Same seed twice -> identical event log; different seed -> different; prints a summary as JSON.
import { Score } from "../docs/js/score.js";
import { runSim } from "../docs/js/score-sim.js";

const secs = Number(process.argv[2] || 60);
function logFor(seed, kind) {
  const s = new Score();
  s.seed(seed);
  runSim(s, kind, secs, 30);
  return { log: s.log, state: s.state() };
}
const count = (log, k) => log.filter((e) => e.k === k).length;
const out = { seconds: secs, cases: {} };
let ok = true;
for (const kind of ["shanshui", "kodama"]) {
  const a = logFor(1792909998082, kind), b = logFor(1792909998082, kind), c = logFor(42, kind);
  const same = JSON.stringify(a.log) === JSON.stringify(b.log);
  const diff = JSON.stringify(a.log) !== JSON.stringify(c.log);
  ok = ok && same && diff;
  out.cases[kind] = {
    same, diff, events: a.log.length, notes: count(a.log, "note"), rain: count(a.log, "rain"), gens: count(a.log, "gen"),
    rests: count(a.log, "rest"), drone: count(a.log, "drone"), skips: count(a.log, "skip"), phases: count(a.log, "phase"),
    state: a.state, other: { plant: c.state.plant, root: c.state.root, notes: count(c.log, "note") },
  };
}
out.ok = ok;
console.log(JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
