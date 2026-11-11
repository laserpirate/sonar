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

export const LOOP_BARS = 4;
export const LOOP_BEATS = LOOP_BARS * 4;
export const MAX_LAYERS = 4;

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
const num = (v, lo, hi, d) => { const n = Number(v); return v !== null && v !== undefined && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
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
    const p1 = instr?.[0] || presetOfSeed(this.seedValue, this.N);
    const p2 = instr?.[1] || presetOfSeed(Math.floor(this.seedValue / 7) + 3, this.N);
    this.instr = [p1, p2];
    // the array keeps its identity: the page holds a reference to it
    this.plants = this.plants || [];
    this.plants.splice(0, this.plants.length, new Plant(1, { random: this.random, defaults: this.D }), new Plant(2, { random: this.random, defaults: this.D }));
    this.seqs = [null, null];
    this.pending = [null, null];
    this.t0 = this.t0 ?? 0;
    for (let k = 0; k < 2; k++) this.setup(k, this.instr[k]);
    this._clearArps();
    return this.seedValue;
  }
  setup(k, instr, gen) {
    this.instr[k] = instr;
    const p = this.plants[k];
    p.resetOffset();
    p.setup(this.catalog.plants[instr - 1], instr, gen);
    this.seqs[k] = this._seq(p, this.random, this._now ?? 0);
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
  reset() { for (let k = 0; k < 2; k++) this.setup(k, this.instr[k]); }
  preset(dir, k = this.active - 1) { this.setup(k, ((this.instr[k] - 1 + dir + this.N) % this.N) + 1); }
  play(v) {
    this.playing = v;
    if (v) for (let k = 0; k < 2; k++) { this.seqs[k] = this._seq(this.plants[k], this.random, this._now ?? 0); this.pending[k] = null; }
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
  setDelay(engine, o) { Object.assign(this.delays[engine], o); }
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
    const id = 3 + ((this._layerSerial = (this._layerSerial || 0) + 1) % 1000);
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
    // base plants (flora's clock.sync walk)
    for (let k = 0; k < 2; k++) {
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
        if (ev) out.push(ev);
      }
    }
    // notes decided earlier and due now
    if (this.future.length) {
      this.future.sort((a, b) => a.t - b.t);
      while (this.future.length && this.future[0].t <= now) { const ev = this.future.shift(); if (now - ev.t <= 1) { this.log.push(ev); out.push(ev); } }
    }
    return out;
  }
  _emit(ev) {
    ev.engine = this.engineOf(ev.plant, !!ev.layer);
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
    this.log.push(ev);
    if (this.log.length > 5000) this.log.splice(0, 1000);
    if (this.flourish > 0 && !ev.layer) this._flourish(ev);
    return ev;
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
  geometry() {
    this._geom = this._geom || new Map();
    this._rev = this._rev || 0;
    const out = [], seen = new Set();
    const each = (id, plant, layer) => {
      if (!plant.turtle || !plant.lsys) return;
      seen.add(id);
      const t = plant.turtle;
      const key = `${plant.lsys.sentence}|${t.todo === plant.lsys.sentence}|${t.theta}|${t.length}|${plant.initialTurtleRotation}`;
      let c = this._geom.get(id);
      if (!c || c.key !== key) { c = { key, geom: this._still(plant, id), rev: ++this._rev }; this._geom.set(id, c); }
      out.push({ id, plant, layer, geom: c.geom, rev: c.rev });
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
    const g = plant.render();
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
      plants: this.plants.map((p, k) => ({ instr: this.instr[k], gen: p.currentGeneration, lgen: p.lsys.generation, sentence: p.sentence, randomAngles: p.lsys.randomAngles.slice(), angle: p.angle, length: p.userScale ?? 1, engine: this.routes[k + 1] ?? null })),
      layers: this.layers.map((L) => ({ seed: L.seed, serial: L.serial, phase: L.start % LOOP_BEATS, engine: this.routes[L.id] ?? null })),
      layerSerial: this._layerSerial || 0,
      arps: { saw: arp(this.arps.saw), rain: arp(this.arps.rain) },
      delays: { saw: { ...this.delays.saw }, rain: { ...this.delays.rain } },
      sim: { ...this.simOpts }, midi: this.midiRef ?? null,
    };
  }
  // a setup can come from a link or a file: check all of it before anything changes
  _cleanSetup(s) {
    if (!s || typeof s !== "object" || s.v !== SETUP_VERSION) throw new Error("not a sonar setup");
    if (!Array.isArray(s.plants) || s.plants.length < 2) throw new Error("setup has no plants");
    const plants = s.plants.slice(0, 2).map((p) => {
      const instr = Math.round(Number(p?.instr));
      if (!(instr >= 1 && instr <= this.N)) throw new Error("setup names an unknown plant");
      return {
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
      seed: num(s.seed, 1, 4294967295, 1), rng: num(s.rng, 0, 4294967295, undefined), bpm: Math.round(num(s.bpm, 20, 300, 90)), active: s.active === 2 ? 2 : 1,
      root: Math.round(num(s.key?.root, 0, 127, this.D.root_note)), scale: SCALES[s.key?.scale] ? s.key.scale : this.D.scale_name || "dorian",
      pitch: num(s.pitch, -24, 24, 0), growth: num(s.growth, 0, 16, 0), engineMode: ["saw", "rain", "both"].includes(s.engineMode) ? s.engineMode : "saw",
      layerRoute: voiceId(s.layerRoute), flourish: num(s.flourish, 0, 1, 0), plants, layers, layerSerial: num(s.layerSerial, 0, 1e6, undefined),
      arps: { saw: s.arps?.saw || {}, rain: s.arps?.rain || {} }, delays: { saw: delay(s.delays?.saw), rain: delay(s.delays?.rain) }, sim,
      midi: typeof s.midi === "string" ? s.midi.slice(0, 80) : null,
    };
  }
  // load a setup from beat `now`; loop layers keep their place on the 4 bar grid
  fromSetup(raw, now = this._now ?? 0) {
    const s = this._cleanSetup(raw);
    this._now = now;
    this.layers = []; this.future = []; this.routes = {};
    this.bpm = s.bpm; this.active = s.active; this.midiRef = s.midi;
    this.key = { root: s.root, scale: s.scale };
    this.notes = scaleOfLength(s.root, s.scale, this.D.scale_length || 24);
    this.simOpts = s.sim;
    this.seed(s.seed, s.plants.map((p) => p.instr));
    s.plants.forEach((p, k) => {
      const plant = this.plants[k];
      if (p.sentence !== undefined) {
        plant.setSentence(p.sentence);
        plant.lsys.randomAngles = p.randomAngles;
        plant.lsys.generation = p.lgen ?? p.gen ?? 0;
        plant.currentGeneration = p.gen ?? 0;
      } else if (p.gen) this.setup(k, p.instr, p.gen);
      if (p.angle !== undefined) plant.setAngle(p.angle);
      plant.userScale = p.length;
      if (p.engine) this.routes[k + 1] = p.engine;
      this.seqs[k] = this._seq(plant, this.random, now);
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
