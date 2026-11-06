// score_norns_check.mjs · Tier 5: the score drives fake-norns over the bridge, in real time.
//   node tools/score_norns_check.mjs [seconds=60] [kind=shanshui] [seed=1792909998082]
// Starts bridge.mjs and fake-norns.mjs on spare ports, runs the score on the sim scene with a
// WebSocket client to the bridge (the page's path: ws -> bridge -> UDP -> norns), then compares
// the score's walk (notes played + muted by a rest + skipped by the voice cap) with fake-norns'
// plant 1 /sonar/note count. Pass: they agree within +-1. Also lists every OSC path the score sent.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Score } from "../docs/js/score.js";
import { ShanshuiSim, KodamaSim } from "../docs/js/score-sim.js";

const here = dirname(fileURLToPath(import.meta.url));
const [secArg = "60", kind = "shanshui", seed = "1792909998082"] = process.argv.slice(2);
const seconds = Number(secArg);
const P = { udp: 57220, ws: 8775, norns: 10211 };
const procs = [];
const start = (script, args) => { const p = spawn(process.execPath, [join(here, "..", "bridge", script), ...args], { stdio: ["ignore", "pipe", "pipe"] }); procs.push(p); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = new Score(); probe.seed(seed);
const plantNo = Number(probe.state().plant.slice(1));
start("bridge.mjs", ["--udp", String(P.udp), "--ws", String(P.ws), "--norns", "127.0.0.1", "--norns-port", String(P.norns)]);
const fake = start("fake-norns.mjs", ["--plant", String(plantNo), "--plant2", String(plantNo), "--to", "127.0.0.1:" + P.udp, "--listen", String(P.norns), "--bpm", "36"]);
const deviceNotes = [];
let buf = "";
fake.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(line); if (o.ev === "note") deviceNotes.push(o); } catch {} }
});
await wait(1200);

const sent = new Map();
const ws = new WebSocket(`ws://127.0.0.1:${P.ws}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const osc = { send(path, args) { sent.set(path, (sent.get(path) || 0) + 1); ws.send(JSON.stringify({ path, args })); return true; } };

const score = new Score({ osc });
score.seed(seed);
await wait(300);
const sim = kind === "kodama" ? new KodamaSim() : new ShanshuiSim();
const t0 = performance.now();
let simT = 0, startN = deviceNotes.length;
score.play();
await new Promise((res) => {
  const iv = setInterval(() => {
    const now = (performance.now() - t0) / 1000;
    while (simT + 1 / 30 <= now) { const sc = sim.step(1 / 30); simT = sc.t; score.scene(sc); }
    if (now >= seconds) { clearInterval(iv); res(); }
  }, 10);
});
score.stop();
await wait(400);
for (const p of procs) p.kill();
ws.close();

const cnt = (k) => score.log.filter((e) => e.k === k).length;
const walk = cnt("note") + cnt("mute") + cnt("skip");
const dev1 = deviceNotes.slice(startN).filter((n) => n.plant === 1).length;
const out = {
  seconds, kind, seed, plant: score.state().plant,
  browser: { played: cnt("note"), muted: cnt("mute"), skipped: cnt("skip"), walk, rain: cnt("rain"), gens: cnt("gen") },
  norns: { plant1Notes: dev1, plant2Notes: deviceNotes.slice(startN).filter((n) => n.plant === 2).length },
  diff: dev1 - walk,
  oscSent: Object.fromEntries([...sent.entries()].sort()),
};
out.pass = Math.abs(out.diff) <= 1;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
