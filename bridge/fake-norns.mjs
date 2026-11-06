#!/usr/bin/env node
// fake-norns: runs the shared core (docs/js/lsys.js) with flora's catalog and
// emits the sonar OSC contract over UDP, so the bridge and the renderer can be
// tested with no hardware. It also listens where a norns would (UDP 10111) and
// obeys /sonar/* and /param/plant{1,2}_angle the way sonar_osc.lua does.
//
//   node fake-norns.mjs [--plant 13] [--plant2 13] [--bpm 90] [--gens N]
//                       [--to 127.0.0.1:57120] [--listen 10111] [--seed 1]
//                       [--auto-gen SECONDS] [--duration SECONDS] [--quiet]
//
// --plant / --plant2  catalog numbers p01..p13 for plant 1 and 2 (flora's default is 13 for both)
// --gens              generation to set up at (default: the catalog's starting_generation)
// --auto-gen          step the active plant one generation every N seconds, reset at max
// stdout              one JSON line per gen: {"ev":"gen","plant":1,"gen":2,"segments":115,...}
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encode, decode } from "./osc-codec.mjs";
import { Plant, Sequencer, checkPlantPosition, makeRandom } from "../docs/js/lsys.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "docs", "js", "catalog.json"), "utf8"));
const D = catalog.defaults;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const P1 = Number(flag("plant", D.initial_plant_instructions[0]));
const P2 = Number(flag("plant2", flag("plant", D.initial_plant_instructions[1])));
let BPM = Number(flag("bpm", 90));
const GENS = flag("gens", null);
const [TO_IP, TO_PORT] = String(flag("to", "127.0.0.1:57120")).split(":");
const LISTEN = Number(flag("listen", 10111));
const SEED = Number(flag("seed", 1));
const AUTO = Number(flag("auto-gen", 0));
const DURATION = Number(flag("duration", 0));
const QUIET = argv.includes("--quiet");

const random = makeRandom(SEED);
const sock = dgram.createSocket("udp4");
const send = (path, args) => sock.send(Buffer.from(encode(path, args)), Number(TO_PORT), TO_IP);
const report = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// ---- garden ----------------------------------------------------------------
const plants = [new Plant(1, { random, defaults: D }), new Plant(2, { random, defaults: D })];
const instrNum = [P1, P2];
let active = 1;
let playing = true;
let page = 1;
let seqs = [];
const t0 = Date.now();
// beat clock: a tempo change keeps the beat phase (as norns' clock does), no jump
let beatBase = 0, tBase = t0;
const nowBeats = () => beatBase + ((Date.now() - tBase) / 1000) * (BPM / 60);
function setTempo(b) { if (!(b > 0) || b === BPM) return; beatBase = nowBeats(); tBase = Date.now(); BPM = b; }
// flora params the score sends (README "score to norns"); unset = flora's defaults from the catalog
const SND = { notes: null, root: D.root_note, mode: D.scale_mode, noteScalar: null, dur: [null, null], cfs: null };
const DORIAN = [2, 1, 2, 2, 2, 1, 2];
function buildScale() {   // MusicUtil.generate_scale_of_length(root, mode, 24); dorian only, other modes keep the catalog notes
  if (SND.mode !== 5) { SND.notes = null; return; }
  const out = [SND.root]; for (let i = 0; out.length < D.scale_length; i++) out.push(out[out.length - 1] + DORIAN[i % 7]);
  SND.notes = out;
}
const seqOpts = (k) => {
  const o = { random, t: nowBeats() };
  if (SND.notes) o.notes = SND.notes;
  if (SND.noteScalar !== null) o.noteScalar = SND.noteScalar;
  if (SND.dur[k] !== null) o.duration = SND.dur[k];
  if (SND.cfs !== null) o.cfScalars = [SND.cfs];
  return o;
};
const applySnd = () => { for (let k = 0; k < 2; k++) if (seqs[k]) { const o = seqOpts(k); if (o.notes) seqs[k].notes = o.notes.slice(); if (o.noteScalar !== undefined) seqs[k].noteScalar = o.noteScalar; if (o.duration !== undefined) seqs[k].duration = o.duration; if (o.cfScalars) seqs[k].cfScalars = o.cfScalars; } };

function geometryOf(p) {
  // the device draws after check_plant_position; count from a fresh render
  return p.render();
}
function sendRules(p) { send("/sonar/rules", p.rulesArgs()); }
function sendGen(p) {
  send("/sonar/gen", p.genArgs());
  const g = geometryOf(p);
  report({ ev: "gen", plant: p.id, instr: instrNum[p.id - 1], gen: p.currentGeneration,
    max: p.maxGenerations, segments: g.segments.length, notes: g.circles.length, len: p.sentence.length });
}
function setupPlant(k, instr, gen) {
  const p = plants[k];
  instrNum[k] = instr;
  p.resetOffset();
  p.setup(catalog.plants[instr - 1], instr, gen);
  seqs[k] = new Sequencer(p, D, seqOpts(k));
  sendRules(p);
  sendGen(p);
}
setupPlant(0, P1, GENS !== null ? Number(GENS) : undefined);
setupPlant(1, P2, GENS !== null ? Number(GENS) : undefined);
send("/sonar/plant", [active]);
send("/sonar/page", [page]);

// ---- screen loop at flora's SCREEN_FRAMERATE (1/15 s) ---------------------
setInterval(() => {
  checkPlantPosition(plants);
  for (const p of plants) p.render();
}, 1000 / 15);

// ---- sequencer: emit due events --------------------------------------------
const nextEv = [null, null];
function pull(k) {
  for (let guard = 0; guard < 2000; guard++) {
    const ev = seqs[k].step();
    if (ev.kind !== "step") return ev;
  }
  return null;
}
let notesSent = 0;
setInterval(() => {
  if (!playing) return;
  const now = nowBeats();
  for (let k = 0; k < 2; k++) {
    if (!seqs[k]) continue;
    if (!nextEv[k] || nextEv[k].seq !== seqs[k]) { const e = pull(k); nextEv[k] = e && { e, seq: seqs[k] }; }
    while (nextEv[k] && nextEv[k].e.t <= now) {
      const e = nextEv[k].e;
      if (e.kind === "note") {
        send("/sonar/note", [k + 1, e.idx, e.note, e.freq, e.x, e.y, e.dur]);
        notesSent++;
        if (!QUIET) report({ ev: "note", plant: k + 1, idx: e.idx, note: e.note, t: +e.t.toFixed(3) });
      } else if (e.kind === "rest") {
        send("/sonar/rest", [k + 1, e.idx]);
      }
      const n = pull(k);
      nextEv[k] = n && { e: n, seq: seqs[k] };
    }
  }
}, 5);

// ---- heartbeat ---------------------------------------------------------------
let seq = 0;
setInterval(() => send("/sonar/hb", [++seq, BPM, "sonar"]), 1000);

// ---- auto generation -----------------------------------------------------------
if (AUTO > 0) {
  setInterval(() => {
    const p = plants[active - 1];
    if (!p.generate(1)) setupPlant(active - 1, instrNum[active - 1]);
    else sendGen(p);
  }, AUTO * 1000);
}

// ---- in: what sonar_osc.lua handles ----------------------------------------------
const listener = dgram.createSocket("udp4");
listener.on("message", (buf) => {
  const m = decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (!m) return;
  const a = m.args;
  const plantArg = (x) => (Number(x) === 2 ? 2 : Number(x) === 1 ? 1 : active);
  switch (m.address) {
    case "/sonar/generate": {
      const p = plants[plantArg(a[0]) - 1];
      if (p.generate(Number(a[1]) === -1 ? -1 : 1)) sendGen(p);
      break;
    }
    case "/sonar/reset":
      for (let k = 0; k < 2; k++) setupPlant(k, instrNum[k]);
      break;
    case "/sonar/plant":
      if ((a[0] === 1 || a[0] === 2) && a[0] !== active) { active = a[0]; send("/sonar/plant", [active]); }
      break;
    case "/sonar/sentence": {
      const p = plants[plantArg(a[0]) - 1];
      if (typeof a[1] === "string") { p.setSentence(a[1]); sendGen(p); }
      break;
    }
    case "/sonar/play":
      playing = Number(a[0] ?? 1) === 1;
      if (playing) for (let k = 0; k < 2; k++) { seqs[k] = new Sequencer(plants[k], D, seqOpts(k)); nextEv[k] = null; }
      break;
    case "/sonar/resend":
      for (const p of plants) { sendRules(p); sendGen(p); }
      send("/sonar/plant", [active]);
      send("/sonar/page", [page]);
      break;
    case "/sonar/instruction": { // sim-only convenience: i:plant i:catalog number
      const k = plantArg(a[0]) - 1, n = Number(a[1]);
      if (n >= 1 && n <= catalog.plants.length) setupPlant(k, n);
      break;
    }
    default: {
      const pm = /^\/param\/plant([12])_angle$/.exec(m.address);
      if (pm) { const p = plants[Number(pm[1]) - 1]; p.setAngle(Number(a[0])); sendGen(p); }
      if (m.address === "/param/clock_tempo") setTempo(Number(a[0]));
      const im = /^\/param\/plant([12])_instructions$/.exec(m.address);
      if (im) { const n = Number(a[0]); if (n >= 1 && n <= catalog.plants.length) setupPlant(Number(im[1]) - 1, n); }
      const dm = /^\/param\/plant_([12])_note_duration$/.exec(m.address);
      if (dm) { const v = D.note_durations[Number(a[0]) - 1]; if (v) { SND.dur[Number(dm[1]) - 1] = v; applySnd(); } }
      if (m.address === "/param/root_note") { SND.root = Number(a[0]); }   // flora: build_scale runs on the scale_mode action
      if (m.address === "/param/scale_mode") { SND.mode = Number(a[0]); buildScale(); applySnd(); }
      if (m.address === "/param/note_scalar") { SND.noteScalar = Number(a[0]); applySnd(); }
      if (m.address === "/param/cfs1") { const v = D.cf_scalars_map[Number(a[0]) - 1]; if (v) { SND.cfs = v; applySnd(); } }
    }
  }
});
listener.bind(LISTEN, "127.0.0.1", () => { if (!QUIET) process.stderr.write(`fake-norns: -> ${TO_IP}:${TO_PORT}, listening 127.0.0.1:${LISTEN}, plants p${P1} p${P2}, ${BPM} bpm\n`); });

if (DURATION > 0) setTimeout(() => { report({ ev: "done", notes: notesSent, hb: seq }); process.exit(0); }, DURATION * 1000);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
