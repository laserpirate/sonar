// garden.js · the sim garden as one pure, steppable object (no DOM, no audio).
//
// Holds the two base plants (flora semantics), up to MAX_LAYERS seeded loop
// layers (each a plant of its own, recorded for one 4-bar loop and repeated),
// an arpeggiator fed by the notes the plants play, key and scale, pitch, and
// growth (generation breathing on a bar clock). app.js drives it from the
// page clock; garden-offline.js drives it in an OfflineAudioContext for the
// MP3 renders; tests drive it in Node. Same code, same events.
//
// Beat time throughout. A bar is 4 beats; a loop is LOOP_BARS bars.

import { Plant, Sequencer, makeRandom, mtof, ftom, checkPlantPosition } from "./lsys.js";
import { growRoots, ROOT_DEFAULT, BASS_DEFAULT, BASS_SYNCS, bassStep, ARCHETYPES } from "./roots.js";
import { BUILTIN, voiceDefaults, cleanVoice, voiceLen, isSample } from "./voices.js";
export const PITCH_MODES = ["flora", "walk"];
const FX_DEFAULT = () => ({ reverb: { amount: 0, size: 2.5 }, wind: { level: 0, tone: 700 } });

const num = (v, lo, hi, d) => { const n = Number(v); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
export const LOOP_BARS = 4;
export const LOOP_BEATS = LOOP_BARS * 4;
export const MAX_LAYERS = 4;
export const MAX_FOREST = 16;
export const LAYER_ID0 = 101;     // loop layer ids start here; plant ids are 1..16
// seeded 32-bit hash, so forest plants never draw from the base plants' stream
export const hashSeed = (seed, i) => {
  let t = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
};
const h01 = (seed, i) => hashSeed(seed, i) / 4294967296;

// user plants: flora's alphabet only (the symbols the catalog and the turtle use), no new symbols
export const PLANT_ALPHABET = "FGf+-[]!|rABMOPTXYp";
const balanced = (s) => { let n = 0; for (const c of s) { if (c === "[") n++; else if (c === "]" && --n < 0) return false; } return n === 0; };
export function validatePlant(d) {
  const errors = [];
  const inAlpha = (s) => [...s].every((c) => PLANT_ALPHABET.includes(c));
  const axiom = String(d?.axiom ?? "").trim();
  if (!axiom) errors.push("axiom empty");
  else if (axiom.length > 40) errors.push("axiom over 40");
  else if (!inAlpha(axiom)) errors.push("axiom: only " + PLANT_ALPHABET);
  else if (!balanced(axiom)) errors.push("axiom brackets");
  const raw = Array.isArray(d?.rules) ? d.rules : [];
  if (raw.length > 5) errors.push("at most 5 rules");
  const rules = [];
  raw.slice(0, 5).forEach((r, i) => {
    const a = String(r?.[0] ?? "").trim(), b = String(r?.[1] ?? "").trim();
    if (!a && !b) return;
    if (a.length !== 1 || !PLANT_ALPHABET.includes(a) || "[]+-!|".includes(a)) errors.push(`rule ${i + 1}: one letter`);
    else if (b.length > 80) errors.push(`rule ${i + 1} over 80`);
    else if (!inAlpha(b)) errors.push(`rule ${i + 1}: only ` + PLANT_ALPHABET);
    else if (!balanced(b)) errors.push(`rule ${i + 1} brackets`);
    else rules.push([a, b]);
  });
  const def = { axiom, rules, angle: num(d?.angle, -180, 180, 25), length: num(d?.length, 2, 40, 10), start: Math.round(num(d?.start, 0, 6, 2)) };
  return { ok: !errors.length, errors, def };
}
// a user plant in the catalog's shape
export const plantEntry = (def) => ({ id: "u", start_from: [63.5, 60], ruleset: def.rules, axiom: def.axiom, max_generations: Math.max(def.start, 6), length: def.length, angle: def.angle, initial_turtle_rotation: 90, starting_generation: def.start });
export const CUSTOM0 = 1000;      // instr above this is a user plant

// musicutil scale intervals (one octave), the subset the key menu offers
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "major pentatonic": [0, 2, 4, 7, 9],
  "minor pentatonic": [0, 3, 5, 7, 10],
  "whole tone": [0, 2, 4, 6, 8, 10],
};
export const SCALE_NAMES = Object.keys(SCALES);
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

// musicutil.generate_scale_of_length(root, scale, length)
export function scaleOfLength(root, scale, length = 24) {
  const iv = SCALES[scale] || SCALES.dorian;
  const out = [];
  for (let o = 0; out.length < length; o++) for (const i of iv) { if (out.length >= length) break; out.push(root + 12 * o + i); }
  return out;
}

export const ARP_MODES = ["off", "up", "down", "updown", "random"];
export const ARP_RATES = { "1/4": 1, "1/8": 0.5, "1/8t": 1 / 3, "1/16": 0.25 };
export const ARP_ENGINES = ["saw", "rain"];
const ARP_DEFAULT = () => ({ mode: "off", rate: "1/8", octaves: 1, size: 4, gate: 100, steps: 16, pulses: 16, rotation: 0 });
const ARP_SEEDS = { saw: 0x9e37, rain: 0x7f4a };
const newArp = (seed) => ({ ...ARP_DEFAULT(), buf: [], ix: 0, nextT: null, pos: 0, random: makeRandom(seed) });
export const SETUP_VERSION = 1;
const voiceId = (v) => (typeof v === "string" && /^[a-z0-9_-]{1,24}$/.test(v) ? v : null);
export const DELAY_DEFAULT = () => ({ amount: 0, div: "d1/8", feedback: 0.45, lowpass: 2400, pingpong: false });
// Euclidean rhythm: is step i of `steps` a pulse, with `pulses` spread evenly and a rotation
export const euclidHit = (i, steps, pulses, rotation = 0) => {
  if (pulses >= steps) return true;
  if (pulses <= 0) return false;
  const k = (((i + rotation) % steps) + steps) % steps;
  return (k * pulses) % steps < pulses;
};

// which preset a seed lands on, and the second plant's preset
export const presetOfSeed = (seed, n) => (Math.abs(Math.floor(seed)) % n) + 1;

// sentence indices of the F at bracket depth 2 or more; every F when the plant has no such depth
function outerTwigs(s) {
  const deep = [], all = [];
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "[") d++; else if (c === "]") d--;
    else if (c === "F") { all.push(i + 1); if (d >= 2) deep.push(i + 1); }
  }
  return deep.length ? deep : all;
}

export class Garden {
  // opts: {catalog, seed, bpmRef?: () => bpm}
  constructor(opts) {
    this.catalog = opts.catalog;
    this.D = this.catalog.defaults;
    this.N = this.catalog.plants.length;
    this.key = { root: this.D.root_note, scale: this.D.scale_name || "dorian" };
    this.notes = scaleOfLength(this.key.root, this.key.scale, this.D.scale_length || 24);
    this.bpm = opts.bpm ?? 90;
    this.pitch = 0;            // semitones
    this.growth = 0;           // bars per generation step, 0 = off
    this.growthDir = 1;
    this.nextGrowthBar = null;
    this.arps = { saw: newArp(ARP_SEEDS.saw), rain: newArp(ARP_SEEDS.rain) };
    this.delays = { saw: DELAY_DEFAULT(), rain: DELAY_DEFAULT() };
    this.engineMode = "saw";   // v0.2.0's global engine: saw, rain or both
    this.routes = {};          // plant id -> voice id, overrides engineMode
    this.layerRoute = null;    // voice for all loop layers, overrides engineMode
    this.flourish = 0;         // 0..1: the other voice answers a plant note with a quick rising run
    this.flourishRandom = makeRandom(0x51f3);
    this.future = [];          // notes already decided, due later (flourish runs)
    this.forest = { n: 2, leads: 2, density: 0.6, budget: 6 };
    this.roots = {};           // plant id -> {archetype, depth, spread, density}
    this.bass = BASS_DEFAULT();
    this.customs = [];         // user plant definitions; instr CUSTOM0 + 1 + index
    this.bassWalk = 0; this.bassCount = 0; this.nextBassT = null;
    this.sounding = [];        // conductor: beat at which each admitted note ends
    this._cBar = null; this._roles = new Map(); this._slots = new Map(); this._placed = new Set();
    this.voiceParams = Object.fromEntries([...BUILTIN, "bass"].map((id) => [id, voiceDefaults(id)]));
    this.mix = {};             // voice id -> {solo, mute}
    this.fx = FX_DEFAULT();
    this.plantOpts = {};       // plant id -> {mode, wildness, density}
    this.samples = [];         // [{id, name}]: the sounds a setup refers to
    this.bankName = null; this.randomSeed = null;
    this.layers = [];
    this.active = 1;
    this.playing = true;
    this.simOpts = {};
    this.log = [];
    this.seed(opts.seed ?? 1, opts.instr);
  }

  // ---- base garden ---------------------------------------------------------
  // new seed: new random stream, presets from the seed (unless given), fresh plants
  seed(seed, instr) {
    this.seedValue = seed >>> 0 || 1;
    this.random = makeRandom(this.seedValue);
    this._dens = {}; this._walk = {};
    const p1 = instr?.[0] || presetOfSeed(this.seedValue, this.N);
    const p2 = instr?.[1] || presetOfSeed(Math.floor(this.seedValue / 7) + 3, this.N);
    this.instr = [p1, p2];
    // the array keeps its identity: the page holds a reference to it
    this.plants = this.plants || [];
    this.plants.splice(0, this.plants.length, new Plant(1, { random: this.random, defaults: this.D }), new Plant(2, { random: this.random, defaults: this.D }));
    this.seqs = [null, null];
    this.pending = [null, null];
    this.prand = [this.random, this.random];
    this.t0 = this.t0 ?? 0;
    for (let k = 0; k < 2; k++) this.setup(k, this.instr[k]);
    // forest plants 3..n: each its own stream from the seed, so plants 1 and 2 play as in v0.2.0
    this._growForest(this.forest.n, instr);
    this._clearArps();
    return this.seedValue;
  }
  _growForest(n, instr) {
    n = Math.max(2, Math.min(MAX_FOREST, Math.round(n)));
    this.forest.n = n;
    while (this.plants.length > n) {
      const id = this.plants.length;
      this.plants.pop(); this.instr.pop(); this.seqs.pop(); this.pending.pop(); this.prand.pop();
      delete this.roots[id]; delete this.routes[id];
    }
    for (let k = this.plants.length; k < n; k++) {
      const rr = makeRandom(hashSeed(this.seedValue, k) || 1);
      this.prand[k] = rr;
      this.plants.push(new Plant(k + 1, { random: rr, defaults: this.D }));
      this.seqs[k] = null; this.pending[k] = null;
      this.setup(k, instr?.[k] || presetOfSeed(hashSeed(this.seedValue, k + 100), this.N));
    }
    if (this.active > n) this.active = 1;
    this.sounding = []; this._cBar = null;
  }
  _rnd(k) { return this.prand?.[k] || this.random; }
  _def(instr) { return instr > CUSTOM0 ? plantEntry(this.customs[instr - CUSTOM0 - 1]) : this.catalog.plants[instr - 1]; }
  // a user plant: registered once per definition; returns its instr number
  addCustom(def) {
    const v = validatePlant(def);
    if (!v.ok) throw new Error(v.errors.join(", "));
    const key = JSON.stringify(v.def);
    let i = this.customs.findIndex((c) => JSON.stringify(c) === key);
    if (i < 0) { this.customs.push(v.def); i = this.customs.length - 1; }
    return CUSTOM0 + 1 + i;
  }
  get conducting() { return this.plants.length > 2; }
  setForest(o) {
    const f = this.forest;
    f.leads = Math.round(num(o.leads, 1, 4, f.leads)); f.density = num(o.density, 0, 1, f.density); f.budget = Math.round(num(o.budget, 1, 16, f.budget));
    if (o.n !== undefined && Math.round(o.n) !== this.plants.length) this._growForest(o.n);
  }
  setVoiceParam(id, k, v) { const cur = this.voiceParams[id] || voiceDefaults(id); this.voiceParams[id] = cleanVoice(id, { ...cur, [k]: v }); }
  setMixVoice(id, o) { const m = { ...(this.mix[id] || {}), ...o }; this.mix[id] = { solo: !!m.solo, mute: !!m.mute }; }
  setFx(o) {
    const f = this.fx;
    if (o.reverb) f.reverb = { amount: num(o.reverb.amount, 0, 1, f.reverb.amount), size: num(o.reverb.size, 0.3, 8, f.reverb.size) };
    if (o.wind) f.wind = { level: num(o.wind.level, 0, 1, f.wind.level), tone: num(o.wind.tone, 100, 4000, f.wind.tone) };
  }
  // per plant: pitch mode, wildness (seeded jitter on the drawn branch angle) and density (chance a note sounds)
  setPlantOpt(id, o) {
    const cur = this.plantOpts[id] || { mode: "flora", wildness: 0, density: 1 };
    this.plantOpts[id] = { mode: PITCH_MODES.includes(o.mode) ? o.mode : cur.mode, wildness: num(o.wildness, 0, 0.6, cur.wildness), density: num(o.density, 0, 1, cur.density) };
    delete this._walk[id];
  }
  addSampleRef(id, name) { if (!isSample(id)) return; this.samples = this.samples.filter((x) => x.id !== id).concat([{ id, name: String(name).slice(0, 80) }]); if (!this.voiceParams[id]) this.voiceParams[id] = voiceDefaults(id); }
  removeSampleRef(id) { this.samples = this.samples.filter((x) => x.id !== id); delete this.voiceParams[id]; }
  setRoots(id, o) {
    const R = { ...(this.roots[id] || ROOT_DEFAULT()), ...o };
    R.archetype = ARCHETYPES.includes(R.archetype) ? R.archetype : null;
    for (const k of ["depth", "spread", "density"]) R[k] = num(R[k], 0, 1, 0.5);
    this.roots[id] = R;
    this.nextBassT = null;
  }
  setBass(o) {
    const b = this.bass, d = BASS_DEFAULT();
    b.octave = Math.round(num(o.octave, -3, 1, b.octave ?? d.octave)); b.level = num(o.level, 0, 1, b.level); b.decay = num(o.decay, 0.05, 2, b.decay);
    b.release = num(o.release, 0.05, 4, b.release); b.detune = num(o.detune, 0, 50, b.detune); b.drone = num(o.drone, 0, 1, b.drone);
    if (o.sync !== undefined && BASS_SYNCS.includes(Number(o.sync))) { b.sync = Number(o.sync); this.nextBassT = null; }
  }
  setup(k, instr, gen) {
    this.instr[k] = instr;
    const p = this.plants[k];
    p.resetOffset();
    p.setup(this._def(instr), instr, gen);
    this.seqs[k] = this._seq(p, this._rnd(k), this._now ?? 0);
    this.pending[k] = null;
    this.onGen?.({ plant: k + 1, gen: p.currentGeneration, max: p.maxGenerations, instr, sim: true });
  }
  _seq(plant, random, t) {
    const o = { random, t, notes: this.notes };
    if (this.simOpts.duration) o.duration = this.simOpts.duration;
    if (this.simOpts.cfScalar) o.cfScalars = [this.simOpts.cfScalar];
    return new Sequencer(plant, this.D, o);
  }
  nextGen(k = this.active - 1) {
    const p = this.plants[k];
    if (p.generate(1)) { this.onGen?.({ plant: k + 1, gen: p.currentGeneration, max: p.maxGenerations, instr: this.instr[k], sim: true }); return true; }
    this.setup(k, this.instr[k]);
    return false;
  }
  reset() { for (let k = 0; k < this.plants.length; k++) this.setup(k, this.instr[k]); }
  preset(dir, k = this.active - 1) { this.setup(k, ((this.instr[k] - 1 + dir + this.N) % this.N) + 1); }
  play(v) {
    this.playing = v;
    if (v) for (let k = 0; k < this.plants.length; k++) { this.seqs[k] = this._seq(this.plants[k], this._rnd(k), this._now ?? 0); this.pending[k] = null; }
    this.sounding = [];
  }
  simParams(o) {
    this.simOpts = { ...this.simOpts, ...o };
    for (const s of this.seqs) if (s) { if (o.duration) s.duration = o.duration; if (o.cfScalar) s.cfScalars = [o.cfScalar]; }
  }

  // ---- key, pitch, growth, arp --------------------------------------------
  setKey(root, scale) {
    if (root !== undefined) this.key.root = root;
    if (scale !== undefined && SCALES[scale]) this.key.scale = scale;
    this.notes = scaleOfLength(this.key.root, this.key.scale, this.D.scale_length || 24);
    for (const s of this.seqs) if (s) s.notes = this.notes;
    for (const L of this.layers) this._rerecord(L);
    this._clearArps();
  }
  _clearArps() { for (const A of Object.values(this.arps)) A.buf = []; }
  get arp() { return this.arps.saw; }        // the v0.2.0 name: the saw arp
  get arpBuf() { return this.arps.saw.buf; }
  setPitch(semi) { this.pitch = Math.max(-24, Math.min(24, Math.round(semi))) || 0; }
  setGrowth(bars) { this.growth = Math.max(0, Math.min(16, Math.round(bars))) || 0; this.nextGrowthBar = null; }
  setArp(o, engine = "saw") {
    const A = this.arps[engine];
    if (!A) return;
    Object.assign(A, o);
    if (!ARP_MODES.includes(A.mode)) A.mode = "off";
    if (!ARP_RATES[A.rate]) A.rate = "1/8";
    A.gate = Math.max(10, Math.min(100, A.gate));
    A.steps = Math.max(1, Math.min(16, Math.round(A.steps)));
    A.pulses = Math.max(0, Math.min(A.steps, Math.round(A.pulses)));
    A.rotation = Math.max(0, Math.min(15, Math.round(A.rotation)));
    A.nextT = null;
  }
  setDelay(engine, o) { Object.assign((this.delays[engine] ||= DELAY_DEFAULT()), o); }
  setAllDelays(amount) { for (const d of Object.values(this.delays)) d.amount = amount; }
  setEngineMode(m) { if (["saw", "rain", "both"].includes(m)) this.engineMode = m; }
  setRoute(id, voice) { if (voice) this.routes[id] = voice; else delete this.routes[id]; }
  setLayerRoute(voice) { this.layerRoute = voice || null; }
  setFlourish(a) { this.flourish = Math.max(0, Math.min(1, a)); }
  // which voice a plant plays
  engineOf(id, isLayer) {
    if (isLayer && this.layerRoute) return this.layerRoute;
    if (this.routes[id]) return this.routes[id];
    if (this.engineMode === "both") return id === 2 || isLayer ? "rain" : "saw";
    return this.engineMode;
  }

  // ---- loop layers ---------------------------------------------------------
  // a layer: its own seed, plant and sequencer; LOOP_BEATS of notes recorded
  // from the next bar line, then repeated. The newest layer replaces the oldest
  // past MAX_LAYERS.
  addLayer(seed, now = this._now ?? 0) {
    seed = seed >>> 0 || 1;
    const random = makeRandom(seed);
    const id = LAYER_ID0 + ((this._layerSerial = (this._layerSerial || 0) + 1) % 1000);
    const plant = new Plant(id, { random, defaults: this.D });
    const instr = presetOfSeed(seed, this.N);
    plant.setup(this.catalog.plants[instr - 1], instr);
    // layers sit at their preset's start (plant 1 side for odd serial, plant 2 side for even)
    plant.startFrom.x = this.catalog.plants[instr - 1].start_from[0] + (this._layerSerial % 2 ? -32 : 32);
    const start = Math.ceil(now / 4) * 4; // next bar line
    const L = { id, serial: this._layerSerial, seed, instr, plant, random, start, events: [], next: 0, loops: 0 };
    this._record(L);
    this.layers.push(L);
    while (this.layers.length > MAX_LAYERS) this.layers.shift();
    return L;
  }
  _record(L) {
    const seq = this._seq(L.plant, makeRandom(L.seed ^ 0x5bd1), 0);
    const evs = seq.run(LOOP_BEATS, 20000).filter((e) => e.kind === "note" && e.t < LOOP_BEATS);
    L.events = evs;
    L.next = 0;
  }
  _rerecord(L) { const was = L.loops; this._record(L); L.loops = was; L.next = 0; }
  clearLayers() { this.layers = []; }
  removeLayer(id) { this.layers = this.layers.filter((L) => L.id !== id); }

  // ---- stepping --------------------------------------------------------------
  // advance to beat `now`; returns the note events due since the last call
  step(now) {
    this._now = now;
    const out = [];
    if (!this.playing) return out;
    // base plants (flora's clock.sync walk), then the forest
    for (let k = 0; k < this.plants.length; k++) {
      const seq = this.seqs[k];
      if (!seq) continue;
      for (let guard = 0; guard < 4000; guard++) {
        if (!this.pending[k]) {
          let ev;
          for (let g2 = 0; g2 < 2000; g2++) { ev = seq.step(); if (ev.kind !== "step") break; }
          this.pending[k] = ev;
        }
        const e = this.pending[k];
        if (!e || e.t > now) break;
        this.pending[k] = null;
        if (now - e.t > 2) continue; // tab was asleep: skip, never burst
        if (e.kind === "note") out.push(this._emit({ plant: k + 1, idx: e.idx, note: e.note, freq: e.freq, x: e.x, y: e.y, dur: e.dur, scaleIndex: e.scaleIndex, t: e.t }));
      }
    }
    // layers
    for (const L of this.layers) {
      if (!L.events.length) continue;
      for (let guard = 0; guard < 400; guard++) {
        const e = L.events[L.next];
        const t = L.start + L.loops * LOOP_BEATS + e.t;
        if (t > now) break;
        L.next++;
        if (L.next >= L.events.length) { L.next = 0; L.loops++; }
        if (now - t > 2) continue;
        out.push(this._emit({ plant: L.id, layer: L.id, idx: e.idx, note: e.note, freq: e.freq, x: e.x, y: e.y, dur: e.dur, scaleIndex: e.scaleIndex, t }));
      }
    }
    // growth: breathe generations on the bar clock
    if (this.growth > 0) {
      const bar = Math.floor(now / 4);
      if (this.nextGrowthBar === null) this.nextGrowthBar = bar + this.growth;
      if (bar >= this.nextGrowthBar) {
        this.nextGrowthBar = bar + this.growth;
        const p = this.plants[this.active - 1];
        if (this.growthDir > 0 && p.currentGeneration >= p.maxGenerations) this.growthDir = -1;
        if (this.growthDir < 0 && p.currentGeneration <= 1) this.growthDir = 1;
        if (this.growthDir > 0) p.generate(1); else if (p.currentGeneration > 1) p.generate(-1);
        this.onGen?.({ plant: this.active, gen: p.currentGeneration, max: p.maxGenerations, instr: this.instr[this.active - 1], sim: true, growth: true });
      }
    }
    // arpeggiators on the beat grid, one per engine
    for (const [engine, A] of Object.entries(this.arps)) {
      if (A.mode === "off" || !A.buf.length) continue;
      const q = ARP_RATES[A.rate];
      if (A.nextT === null) A.nextT = Math.ceil(now / q) * q;
      for (let guard = 0; guard < 64 && A.nextT <= now; guard++) {
        const t = A.nextT; A.nextT += q;
        const hit = euclidHit(A.pos++, A.steps, A.pulses, A.rotation);
        if (!hit || now - t > 1) continue;
        const ev = this._arpNote(engine, A, t, q);
        if (ev && this._admit(ev)) out.push(ev);
      }
    }
    // the bass in free time: one note every 2 beats while a plant has roots
    if (this.bass.sync === 0 && this._bassPlant()) {
      if (this.nextBassT === null) this.nextBassT = Math.ceil(now / 2) * 2;
      for (let guard = 0; guard < 16 && this.nextBassT <= now; guard++) {
        const t = this.nextBassT; this.nextBassT += 2;
        if (now - t > 1) continue;
        const b = this._bassNote(t, 1.5);
        if (b && this._admit(b)) { this.log.push(b); out.push(b); }
      }
    }
    // notes decided earlier and due now (flourish runs, chorus notes, bass on the canopy count)
    if (this.future.length) {
      this.future.sort((a, b) => a.t - b.t);
      while (this.future.length && this.future[0].t <= now) {
        const ev = this.future.shift();
        if (now - ev.t > 1 || !this._admit(ev)) continue;
        this.log.push(ev); out.push(ev);
      }
    }
    return out;
  }
  _emit(ev) {
    ev.engine = this.engineOf(ev.plant, !!ev.layer);
    const po = ev.layer ? null : this.plantOpts[ev.plant];
    if (po) {
      if (po.mode === "walk") this._walkNote(ev);
      if (po.density < 1 && (this._dens[ev.plant] ||= makeRandom(hashSeed(this.seedValue, ev.plant + 700) || 1))() > po.density) ev.silent = true;
    }
    // pitch (semitones) applied to everything the garden plays
    if (this.pitch) { ev.note += this.pitch; ev.freq *= 2 ** (this.pitch / 12); }
    // feed the arpeggiator of this plant's engine with distinct scale indices, newest last
    const A = this.arps[ev.engine];
    if (A && ev.scaleIndex !== undefined) {
      const si = ev.scaleIndex;
      const i = A.buf.indexOf(si);
      if (i >= 0) A.buf.splice(i, 1);
      A.buf.push(si);
      while (A.buf.length > A.size) A.buf.shift();
    }
    if (this.conducting) this._conductNote(ev);
    this.log.push(ev);
    if (this.log.length > 5000) this.log.splice(0, 1000);
    if (this.flourish > 0 && !ev.layer && !ev.silent) this._flourish(ev);
    // the bass counts the canopy steps of the plant whose roots it walks
    if (!ev.layer && this.bass.sync > 0 && ev.plant === this._bassPlant() && ++this.bassCount % this.bass.sync === 0) {
      const b = this._bassNote(ev.t, 1.5);
      if (b) this.future.push(b);
    }
    return ev;
  }

  // ---- conductor (forest only) ------------------------------------------------
  // per bar: `leads` plants play every note, the rest are a chorus that may each place one note on a
  // shared eighth-note grid (round robin, seeded, `density` the chance). Over the budget a note is
  // dropped, never stolen. A dropped note still lights its segment.
  _conduct(bar) {
    this._cBar = bar; this._placed.clear(); this._roles.clear(); this._slots.clear();
    const n = this.plants.length, ids = [];
    for (let k = 0; k < n; k++) ids.push(k + 1);
    const rot = ((bar % n) + n) % n;
    const order = ids.slice(rot).concat(ids.slice(0, rot)).filter((id) => id !== this.active);
    const leads = [this.active, ...order].slice(0, this.forest.leads);
    let j = 0;
    for (const id of ids) {
      const lead = leads.includes(id);
      this._roles.set(id, lead ? "lead" : "chorus");
      if (!lead && h01(this.seedValue, bar * 64 + id) < this.forest.density) this._slots.set(id, (j++ + bar) % 8);
    }
  }
  _conductNote(ev) {
    if (ev.engine === "rain") ev.maxLen = 3;   // a rain note's length must be known to count it
    ev.voiceKey = ev.plant * 128 + ev.note;    // its own voice, so no plant steals another's
    if (ev.silent) return;                     // already quiet (density): nothing to count
    if (ev.layer) { if (!this._admit(ev)) ev.silent = true; return; }
    const bar = Math.floor(ev.t / 4);
    if (bar !== this._cBar) this._conduct(bar);
    if (this._roles.get(ev.plant) === "lead") { if (!this._admit(ev)) ev.silent = true; return; }
    ev.silent = true;
    const slot = this._slots.get(ev.plant);
    if (slot === undefined || this._placed.has(ev.plant)) return;
    this._placed.add(ev.plant);
    const tq = Math.max(bar * 4 + slot * 0.5, Math.ceil(ev.t * 2) / 2);
    if (tq < (bar + 1) * 4) this.future.push({ ...ev, silent: false, chorus: true, idx: 0, t: tq });
  }
  // seconds a note will sound, never less than the voice really sounds
  _lenOf(ev) {
    const spb = 60 / this.bpm;
    if (ev.bass) return ev.dur * spb + this.bass.release + 0.05;
    if (ev.arp || ev.flourish) {
      if (ev.engine === "rain") return Math.max(0.06, ev.dur * spb * (ev.gate ?? 1) * 1.5) * 1.2 + 0.06;
      return 1.5 * Math.max(0.12, Math.min(1, (ev.dur * spb) / 1.2)) * (ev.gate ?? 1) + 0.05;
    }
    if (ev.engine === "rain") return (ev.maxLen ?? 8) * 1.2 + 0.06;
    if (ev.engine && ev.engine !== "saw") return voiceLen(ev.engine, this.voiceParams[ev.engine] || voiceDefaults(ev.engine), ev, this.bpm);
    return 1.55;
  }
  // after phylla-arp (SymbiOS, Phylla biome), behaviour reimplemented: the walk pitch mode.
  // + and - move the scale degree by a step that grows with the branch angle, [ opens an octave up
  // and ] closes back, the first segment of a lateral adds a second.
  _walkNote(ev) {
    const k = ev.plant - 1, plant = this.plants[k];
    if (!plant?.lsys || !(ev.idx > 0)) return;
    const s = plant.sentence, N = this.notes.length;
    let W = this._walk[ev.plant];
    if (!W || ev.idx <= W.i || W.s !== s) W = this._walk[ev.plant] = { i: 0, s, d: Math.floor(N / 3), oct: 0, stack: [], lateral: false };
    const step = 1 + Math.floor(Math.abs(plant.angle || 0) / 30);
    let second = false;
    for (let j = W.i + 1; j <= ev.idx; j++) {
      const c = s[j - 1];
      if (c === "+") W.d += step;
      else if (c === "-") W.d -= step;
      else if (c === "[") { W.stack.push([W.d, W.oct]); W.oct = Math.min(2, W.oct + 1); W.lateral = true; }
      else if (c === "]") { const t = W.stack.pop(); if (t) [W.d, W.oct] = t; W.lateral = false; }
      else if (c === "F" && j === ev.idx) { second = W.lateral; W.lateral = false; }
      else if (c === "F") W.lateral = false;
    }
    W.i = ev.idx;
    W.d = ((W.d % N) + N) % N;
    const di = Math.min(N - 1, W.d + (second ? 1 : 0));
    ev.note = this.notes[di] + 12 * W.oct; ev.freq = mtof(ev.note); ev.scaleIndex = di + 1;
  }
  _admit(ev) {
    if (!this.conducting) return true;
    const t = ev.t;
    this.sounding = this.sounding.filter((e) => e > t);
    // one place is kept for the bass line while a plant has roots
    const cap = this.forest.budget - (ev.bass || !this._bassPlant() ? 0 : 1);
    if (this.sounding.length >= Math.max(1, cap)) return false;
    this.sounding.push(t + (this._lenOf(ev) + 0.06) * (this.bpm / 60));
    return true;
  }

  // ---- roots and the bass ------------------------------------------------------
  // one bass line: the active plant's roots, else a lead's, else the first plant with roots
  _bassPlant() {
    const has = (id) => !!this.roots[id]?.archetype && id <= this.plants.length;
    if (has(this.active)) return this.active;
    for (let id = 1; id <= this.plants.length; id++) if (has(id) && (!this.conducting || this._roles.get(id) === "lead")) return id;
    for (let id = 1; id <= this.plants.length; id++) if (has(id)) return id;
    return 0;
  }
  _bassNote(t, dur) {
    const id = this._bassPlant(), R = id && this.rootsOf(id - 1);
    if (!R || !R.tips.length) return null;
    const b = bassStep(this.bassWalk++, R, this.key, SCALES[this.key.scale] || SCALES.dorian, this.bass.octave);
    const note = b.note + this.pitch;
    const wide = this.roots[id].archetype === "rhizome" ? 1 : 0.6;
    return { plant: id, bass: true, engine: "bass", idx: -(b.tip + 1), note, freq: mtof(note), pan: b.pan * wide, x: -1, y: -1, dur, t, gate: 1, scaleIndex: undefined };
  }
  // the drone: the scale root an octave under the bass, while any plant has roots and the garden plays
  droneHz() {
    if (!this.playing || !this._bassPlant()) return 0;
    return mtof(this.key.root + 12 * (this.bass.octave - 1) + this.pitch);
  }
  // the root system of plant k, in its plant coordinates, cached
  rootsOf(k) {
    const id = k + 1, R = this.roots[id], plant = this.plants[k];
    if (!R?.archetype || !plant?.turtle || !plant.lsys) return null;
    const g = this._geomOf(id, plant), b = g.box;
    const h = b ? Math.max(12, b.y1 - b.y0, (b.x1 - b.x0) * 0.6) : 20;
    const foot = { x: plant.startFrom.x + plant.offset.x, y: plant.startFrom.y + plant.offset.y };
    const key = `${R.archetype}|${R.depth}|${R.spread}|${R.density}|${h.toFixed(3)}|${foot.x}|${foot.y}|${this.seedValue}`;
    this._roots = this._roots || new Map();
    let c = this._roots.get(id);
    if (!c || c.key !== key) { c = { key, roots: growRoots(R, foot, h, hashSeed(this.seedValue, id + 500)), rev: ++this._rev }; this._roots.set(id, c); }
    c.roots.rev = c.rev;
    return c.roots;
  }
  _arpNote(engine, A, t, q) {
    const chord = A.buf.slice().sort((a, b) => a - b);
    const span = chord.length * A.octaves;
    if (!span) return null;
    let ix;
    switch (A.mode) {
      case "up": ix = A.ix % span; A.ix++; break;
      case "down": ix = span - 1 - (A.ix % span); A.ix++; break;
      case "updown": {
        const cyc = Math.max(1, 2 * span - 2);
        const m = A.ix % cyc; ix = m < span ? m : cyc - m; A.ix++; break;
      }
      default: ix = A.random(span) - 1; break;
    }
    const oct = Math.floor(ix / chord.length), si = chord[ix % chord.length];
    const N = this.notes.length;
    let base = this.notes[Math.max(0, Math.min(N - 1, Math.round(si) - 1))];
    if (base === undefined) return null;
    base += 12 * oct;
    const freq = mtof(base) * 2 ** (this.pitch / 12);
    const ev = { plant: 0, arp: true, engine, gate: A.gate / 100, idx: 0, note: ftom(freq), freq, x: -1, y: -1, dur: q, t, scaleIndex: undefined };
    this.log.push(ev);
    return ev;
  }
  // after phylla-arp (SymbiOS, Phylla biome), behaviour reimplemented: the other voice answers with a
  // quick rising run of 2 to 5 scale notes, faster as the amount rises, its marks on outer twigs
  _flourish(ev) {
    const a = this.flourish, R = this.flourishRandom;
    if (R() > 0.3 + a * 0.6 || ev.scaleIndex === undefined) return;
    const other = ev.engine === "rain" ? "saw" : "rain";
    const n = 2 + Math.round(a * 3), sp = 0.25 - 0.125 * a;
    const N = this.notes.length, k = ev.plant - 1;
    const twigs = this.plants[k] ? outerTwigs(this.plants[k].sentence) : [];
    for (let i = 0; i < n; i++) {
      const si = Math.max(0, Math.min(N - 1, Math.round(ev.scaleIndex) - 1 + i));
      const base = this.notes[si] + 12;
      const freq = mtof(base) * 2 ** (this.pitch / 12);
      this.future.push({ plant: ev.plant, flourish: true, engine: other, gate: 0.5, idx: twigs.length ? twigs[Math.floor(R() * twigs.length)] : 0,
        note: ftom(freq), freq, x: -1, y: -1, dur: sp, t: ev.t + (i + 1) * sp, scaleIndex: undefined });
    }
  }

  // ---- geometry ------------------------------------------------------------
  // render all plants: [{plant, geom, layer?}] (base first)
  render() {
    const out = [];
    if (this.plants[0].turtle && this.plants[1].turtle) checkPlantPosition(this.plants);
    for (let k = 0; k < 2; k++) if (this.plants[k].turtle) out.push({ id: k + 1, plant: this.plants[k], geom: this.plants[k].render() });
    for (const L of this.layers) out.push({ id: L.id, layer: L, plant: L.plant, geom: L.plant.render() });
    return out;
  }

  // the wall view's geometry, computed once per generation or parameter change.
  // No checkPlantPosition here: the stage fits the plants itself. The draw uses
  // its own fixed random stream and leaves the turtle as it found it, so two
  // calls on one sentence give one drawing and never advance the garden's RNG.
  _geomOf(id, plant) {
    this._geom = this._geom || new Map();
    this._rev = this._rev || 0;
    const t = plant.turtle;
    const key = `${plant.lsys.sentence}|${t.todo === plant.lsys.sentence}|${t.theta}|${t.length}|${plant.initialTurtleRotation}|${plant.startFrom.x},${plant.startFrom.y}|${this.plantOpts[id]?.wildness || 0}`;
    let c = this._geom.get(id);
    if (!c || c.key !== key) {
      const geom = this._still(plant, id);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of geom.segments) { x0 = Math.min(x0, q.x1, q.x2); x1 = Math.max(x1, q.x1, q.x2); y0 = Math.min(y0, q.y1, q.y2); y1 = Math.max(y1, q.y1, q.y2); }
      c = { key, geom, rev: ++this._rev, box: x0 === Infinity ? null : { x0, y0, x1, y1 } };
      this._geom.set(id, c);
    }
    return c;
  }
  geometry() {
    this._geom = this._geom || new Map();
    this._rev = this._rev || 0;
    const out = [], seen = new Set();
    const each = (id, plant, layer) => {
      if (!plant.turtle || !plant.lsys) return;
      seen.add(id);
      const c = this._geomOf(id, plant);
      const roots = layer ? null : this.rootsOf(id - 1);
      out.push({ id, plant, layer, geom: c.geom, rev: roots ? `${c.rev}.${roots.rev}` : c.rev, roots });
    };
    for (let k = 0; k < this.plants.length; k++) each(k + 1, this.plants[k]);
    for (const L of this.layers) each(L.id, L.plant, L);
    for (const id of [...this._geom.keys()]) if (!seen.has(id)) this._geom.delete(id);
    return out;
  }
  _still(plant, id) {
    const t = plant.turtle, theta = t.theta, rnd = t.random;
    t.random = makeRandom((this.seedValue ^ Math.imul(id, 0x9e3779b1)) >>> 0 || 1);
    t.stack = [];
    const w = this.plantOpts[id]?.wildness || 0;
    if (w > 0) {
      // wildness: each turn of the turtle off by up to w of itself, seeded; the drawing only
      const jr = makeRandom(hashSeed(this.seedValue, id + 800) || 1), turtleRender = t.render;
      t.render = function () {
        this.rotate = function (th, reset) { return Object.getPrototypeOf(this).rotate.call(this, reset ? th : th * (1 + w * (2 * jr() - 1)), reset); };
        try { return turtleRender.call(this); } finally { delete this.rotate; }
      };
      try { var g = plant.render(); } finally { delete t.render; }
    } else var g = plant.render();
    t.theta = theta; t.random = rnd; t.stack = [];
    return g;
  }

  // ---- setups ---------------------------------------------------------------
  // everything needed to play this garden again: exact sentences and the random stream's position
  toSetup() {
    const arp = (A) => ({ mode: A.mode, rate: A.rate, octaves: A.octaves, size: A.size, gate: A.gate, steps: A.steps, pulses: A.pulses, rotation: A.rotation });
    return {
      v: SETUP_VERSION, seed: this.seedValue, rng: this.random.state(), bpm: this.bpm, active: this.active,
      key: { ...this.key }, pitch: this.pitch, growth: this.growth, engineMode: this.engineMode, layerRoute: this.layerRoute, flourish: this.flourish,
      plants: this.plants.map((p, k) => ({ instr: this.instr[k], custom: this.instr[k] > CUSTOM0 ? { ...this.customs[this.instr[k] - CUSTOM0 - 1] } : undefined, gen: p.currentGeneration, lgen: p.lsys.generation, sentence: p.sentence, randomAngles: p.lsys.randomAngles.slice(), angle: p.angle, length: p.userScale ?? 1, engine: this.routes[k + 1] ?? null, roots: this.roots[k + 1]?.archetype ? { ...this.roots[k + 1] } : null, rng: k >= 2 ? this.prand[k].state() : undefined, opts: this.plantOpts[k + 1] ? { ...this.plantOpts[k + 1] } : null })),
      forest: { leads: this.forest.leads, density: this.forest.density, budget: this.forest.budget }, bass: { ...this.bass },
      voices: JSON.parse(JSON.stringify(this.voiceParams)), mix: JSON.parse(JSON.stringify(this.mix)), fx: JSON.parse(JSON.stringify(this.fx)),
      samples: this.samples.map((x) => ({ ...x })), bank: this.bankName, randomSeed: this.randomSeed,
      layers: this.layers.map((L) => ({ seed: L.seed, serial: L.serial, phase: L.start % LOOP_BEATS, engine: this.routes[L.id] ?? null })),
      layerSerial: this._layerSerial || 0,
      arps: { saw: arp(this.arps.saw), rain: arp(this.arps.rain) },
      delays: Object.fromEntries(Object.entries(this.delays).map(([k, d]) => [k, { ...d }])),
      sim: { ...this.simOpts }, midi: this.midiRef ?? null,
    };
  }
  // a setup can come from a link or a file: check all of it before anything changes
  _cleanSetup(s) {
    if (!s || typeof s !== "object" || s.v !== SETUP_VERSION) throw new Error("not a sonar setup");
    if (!Array.isArray(s.plants) || s.plants.length < 2) throw new Error("setup has no plants");
    const plants = s.plants.slice(0, MAX_FOREST).map((p) => {
      let instr = Math.round(Number(p?.instr)), custom;
      if (p?.custom) { const v = validatePlant(p.custom); if (!v.ok) throw new Error("setup has a plant outside flora's alphabet"); custom = v.def; instr = CUSTOM0 + 1; }
      else if (!(instr >= 1 && instr <= this.N)) throw new Error("setup names an unknown plant");
      const R = p?.roots && ARCHETYPES.includes(p.roots.archetype) ? { archetype: p.roots.archetype, depth: num(p.roots.depth, 0, 1, 0.6), spread: num(p.roots.spread, 0, 1, 0.5), density: num(p.roots.density, 0, 1, 0.5) } : null;
      const O = p?.opts && typeof p.opts === "object" ? { mode: PITCH_MODES.includes(p.opts.mode) ? p.opts.mode : "flora", wildness: num(p.opts.wildness, 0, 0.6, 0), density: num(p.opts.density, 0, 1, 1) } : null;
      return {
        custom, roots: R, opts: O, rng: num(p?.rng, 0, 4294967295, undefined),
        instr, gen: num(p.gen, 0, 64, undefined), lgen: num(p.lgen, -64, 64, undefined),
        sentence: typeof p.sentence === "string" && p.sentence.length <= 20000 ? p.sentence : undefined,
        randomAngles: Array.isArray(p.randomAngles) ? p.randomAngles.slice(0, 4000).map((x) => num(x, -360, 360, 0)) : [],
        angle: num(p.angle, -3600, 3600, undefined), length: num(p.length, 0.35, 1.6, 1), engine: voiceId(p.engine),
      };
    });
    const layers = (Array.isArray(s.layers) ? s.layers : []).slice(-MAX_LAYERS).map((L, i) => ({ seed: num(L?.seed, 1, 4294967295, 1), serial: Math.round(num(L?.serial, 1, 1e6, i + 1)), phase: num(L?.phase, 0, LOOP_BEATS - 1, 0), engine: voiceId(L?.engine) }));
    const delay = (d = {}) => { const b = DELAY_DEFAULT(); return { amount: num(d.amount, 0, 1, b.amount), div: ["1/16", "1/8", "d1/8", "1/4", "1/2"].includes(d.div) ? d.div : b.div, feedback: num(d.feedback, 0, 0.85, b.feedback), lowpass: num(d.lowpass, 400, 8000, b.lowpass), pingpong: !!d.pingpong }; };
    const sim = {};
    for (const k of ["duration", "cfScalar"]) { const v = num(s.sim?.[k], 0, 1e6, undefined); if (v !== undefined) sim[k] = v; }
    return {
      seed: num(s.seed, 1, 4294967295, 1), rng: num(s.rng, 0, 4294967295, undefined), bpm: Math.round(num(s.bpm, 20, 300, 90)), active: Math.round(num(s.active, 1, MAX_FOREST, 1)),
      root: Math.round(num(s.key?.root, 0, 127, this.D.root_note)), scale: SCALES[s.key?.scale] ? s.key.scale : this.D.scale_name || "dorian",
      pitch: num(s.pitch, -24, 24, 0), growth: num(s.growth, 0, 16, 0), engineMode: ["saw", "rain", "both"].includes(s.engineMode) ? s.engineMode : "saw",
      layerRoute: voiceId(s.layerRoute), flourish: num(s.flourish, 0, 1, 0), plants, layers, layerSerial: num(s.layerSerial, 0, 1e6, undefined),
      arps: { saw: s.arps?.saw || {}, rain: s.arps?.rain || {} }, sim,
      delays: Object.fromEntries([["saw", delay(s.delays?.saw)], ["rain", delay(s.delays?.rain)], ...Object.entries(s.delays && typeof s.delays === "object" ? s.delays : {}).filter(([k]) => k !== "saw" && k !== "rain" && ([...BUILTIN, "bass"].includes(k) || isSample(k))).slice(0, 80).map(([k, d]) => [k, delay(d)])]),
      midi: typeof s.midi === "string" ? s.midi.slice(0, 80) : null,
      forest: { leads: Math.round(num(s.forest?.leads, 1, 4, 2)), density: num(s.forest?.density, 0, 1, 0.6), budget: Math.round(num(s.forest?.budget, 1, 16, 6)) },
      bass: s.bass && typeof s.bass === "object" ? s.bass : {},
      voices: Object.fromEntries(Object.entries(s.voices && typeof s.voices === "object" ? s.voices : {}).filter(([id]) => [...BUILTIN, "bass"].includes(id) || isSample(id)).slice(0, 80).map(([id, v]) => [id, cleanVoice(id, v)])),
      mix: Object.fromEntries(Object.entries(s.mix && typeof s.mix === "object" ? s.mix : {}).filter(([id]) => [...BUILTIN, "bass"].includes(id) || isSample(id)).slice(0, 80).map(([id, v]) => [id, { solo: !!v?.solo, mute: !!v?.mute }])),
      fx: { reverb: { amount: num(s.fx?.reverb?.amount, 0, 1, 0), size: num(s.fx?.reverb?.size, 0.3, 8, 2.5) }, wind: { level: num(s.fx?.wind?.level, 0, 1, 0), tone: num(s.fx?.wind?.tone, 100, 4000, 700) } },
      samples: (Array.isArray(s.samples) ? s.samples : []).filter((x) => isSample(x?.id)).slice(0, 64).map((x) => ({ id: x.id, name: String(x.name ?? x.id).slice(0, 80) })),
      bank: typeof s.bank === "string" ? s.bank.slice(0, 40) : null,
      randomSeed: num(s.randomSeed, 0, 4294967295, null),
    };
  }
  // load a setup from beat `now`; loop layers keep their place on the 4 bar grid
  fromSetup(raw, now = this._now ?? 0) {
    const s = this._cleanSetup(raw);
    this._now = now;
    this.layers = []; this.future = []; this.routes = {};
    this.bpm = s.bpm; this.active = Math.min(s.active, s.plants.length); this.midiRef = s.midi;
    this.key = { root: s.root, scale: s.scale };
    this.notes = scaleOfLength(s.root, s.scale, this.D.scale_length || 24);
    this.simOpts = s.sim;
    this.customs = [];
    const instrs = s.plants.map((p) => (p.custom ? this.addCustom(p.custom) : p.instr));
    this.roots = {};
    Object.assign(this.forest, s.forest, { n: s.plants.length });
    this.bass = BASS_DEFAULT(); this.setBass(s.bass);
    this.bassWalk = 0; this.bassCount = 0; this.nextBassT = null; this.sounding = []; this._cBar = null;
    this.voiceParams = Object.fromEntries([...BUILTIN, "bass"].map((id) => [id, voiceDefaults(id)]));
    Object.assign(this.voiceParams, s.voices);
    this.mix = s.mix; this.fx = s.fx; this.samples = s.samples; this.bankName = s.bank; this.randomSeed = s.randomSeed;
    for (const x of this.samples) if (!this.voiceParams[x.id]) this.voiceParams[x.id] = voiceDefaults(x.id);
    this.plantOpts = {};
    this.seed(s.seed, instrs);
    s.plants.forEach((p, k) => {
      const plant = this.plants[k];
      if (p.sentence !== undefined) {
        plant.setSentence(p.sentence);
        plant.lsys.randomAngles = p.randomAngles;
        plant.lsys.generation = p.lgen ?? p.gen ?? 0;
        plant.currentGeneration = p.gen ?? 0;
      } else if (p.gen) this.setup(k, instrs[k], p.gen);
      if (p.angle !== undefined) plant.setAngle(p.angle);
      plant.userScale = p.length;
      if (p.engine) this.routes[k + 1] = p.engine;
      if (p.roots) this.roots[k + 1] = { ...p.roots };
      if (p.opts) this.plantOpts[k + 1] = { ...p.opts };
      if (k >= 2 && p.rng !== undefined) this.prand[k].restore(p.rng);
      this.seqs[k] = this._seq(plant, this._rnd(k), now);
      this.pending[k] = null;
    });
    this.pitch = s.pitch; this.growthDir = 1; this.setGrowth(s.growth);
    this.engineMode = s.engineMode; this.layerRoute = s.layerRoute; this.flourish = s.flourish;
    this.flourishRandom = makeRandom(0x51f3);
    for (const e of ARP_ENGINES) {
      const A = this.arps[e];
      this.setArp({ ...ARP_DEFAULT(), ...s.arps[e] }, e);
      A.size = Math.round(num(A.size, 1, 16, 4)); A.octaves = Math.round(num(A.octaves, 1, 3, 1));
      A.buf = []; A.ix = 0; A.pos = 0; A.nextT = null; A.random = makeRandom(ARP_SEEDS[e]);
      Object.assign(this.delays[e], s.delays[e]);
    }
    for (const k of Object.keys(this.delays)) if (!ARP_ENGINES.includes(k)) delete this.delays[k];
    for (const [k, d] of Object.entries(s.delays)) if (!ARP_ENGINES.includes(k)) this.delays[k] = { ...d };
    for (const l of s.layers) {
      this._layerSerial = l.serial - 1;
      const L = this.addLayer(l.seed, now);
      const base = Math.ceil(now / 4) * 4;
      L.start = base + ((((l.phase - base) % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS);
      if (now > 0 && L.start > base) {
        // already under way: join the loop where it is rather than waiting for its top
        L.start -= LOOP_BEATS;
        const i = L.events.findIndex((e) => L.start + e.t >= now);
        if (i >= 0) L.next = i; else { L.next = 0; L.loops = 1; }
      }
      if (l.engine) this.routes[L.id] = l.engine;
    }
    this._layerSerial = s.layerSerial ?? (s.layers.length ? s.layers[s.layers.length - 1].serial : 0);
    if (s.rng !== undefined) this.random.restore(s.rng);
    return this;
  }

  state() {
    return {
      seed: this.seedValue, instr: this.instr.slice(), key: { ...this.key }, pitch: this.pitch, growth: this.growth,
      arp: { mode: this.arp.mode, rate: this.arp.rate, octaves: this.arp.octaves }, layers: this.layers.map((L) => ({ id: L.id, seed: L.seed, instr: L.instr, start: L.start, n: L.events.length, loops: L.loops })),
      gens: this.plants.map((p) => ({ gen: p.currentGeneration, max: p.maxGenerations })),
    };
  }
}
