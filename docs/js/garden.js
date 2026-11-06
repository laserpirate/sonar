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

// which preset a seed lands on, and the second plant's preset
export const presetOfSeed = (seed, n) => (Math.abs(Math.floor(seed)) % n) + 1;

export class Garden {
  // opts: {catalog, seed, bpmRef?: () => bpm}
  constructor(opts) {
    this.catalog = opts.catalog;
    this.D = this.catalog.defaults;
    this.N = this.catalog.plants.length;
    this.key = { root: this.D.root_note, scale: this.D.scale_name || "dorian" };
    this.notes = scaleOfLength(this.key.root, this.key.scale, this.D.scale_length || 24);
    this.pitch = 0;            // semitones
    this.growth = 0;           // bars per generation step, 0 = off
    this.growthDir = 1;
    this.nextGrowthBar = null;
    this.arp = { mode: "off", rate: "1/8", octaves: 1, size: 4 };
    this.arpBuf = [];          // last distinct scale indices played, newest last
    this.arpIx = 0; this.arpDir = 1; this.nextArpT = null;
    this.arpRandom = makeRandom(0x9e37);
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
    this.plants = [new Plant(1, { random: this.random, defaults: this.D }), new Plant(2, { random: this.random, defaults: this.D })];
    this.seqs = [null, null];
    this.pending = [null, null];
    this.t0 = this.t0 ?? 0;
    for (let k = 0; k < 2; k++) this.setup(k, this.instr[k]);
    this.arpBuf = [];
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
    this.arpBuf = [];
  }
  setPitch(semi) { this.pitch = Math.max(-24, Math.min(24, Math.round(semi))) || 0; }
  setGrowth(bars) { this.growth = Math.max(0, Math.min(16, Math.round(bars))) || 0; this.nextGrowthBar = null; }
  setArp(o) {
    Object.assign(this.arp, o);
    if (!ARP_MODES.includes(this.arp.mode)) this.arp.mode = "off";
    if (!ARP_RATES[this.arp.rate]) this.arp.rate = "1/8";
    this.nextArpT = null;
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
    const L = { id, seed, instr, plant, random, start, events: [], next: 0, loops: 0 };
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
    // arpeggiator on the beat grid
    if (this.arp.mode !== "off" && this.arpBuf.length) {
      const q = ARP_RATES[this.arp.rate];
      if (this.nextArpT === null) this.nextArpT = Math.ceil(now / q) * q;
      for (let guard = 0; guard < 64 && this.nextArpT <= now; guard++) {
        const t = this.nextArpT; this.nextArpT += q;
        if (now - t > 1) continue;
        const ev = this._arpNote(t, q);
        if (ev) out.push(ev);
      }
    }
    return out;
  }
  _emit(ev) {
    // pitch (semitones) applied to everything the garden plays
    if (this.pitch) { ev.note += this.pitch; ev.freq *= 2 ** (this.pitch / 12); }
    // feed the arpeggiator with distinct scale indices, newest last
    if (ev.scaleIndex !== undefined) {
      const si = ev.scaleIndex;
      const i = this.arpBuf.indexOf(si);
      if (i >= 0) this.arpBuf.splice(i, 1);
      this.arpBuf.push(si);
      while (this.arpBuf.length > this.arp.size) this.arpBuf.shift();
    }
    this.log.push(ev);
    if (this.log.length > 5000) this.log.splice(0, 1000);
    return ev;
  }
  _arpNote(t, q) {
    const chord = this.arpBuf.slice().sort((a, b) => a - b);
    const span = chord.length * this.arp.octaves;
    if (!span) return null;
    let ix;
    switch (this.arp.mode) {
      case "up": ix = this.arpIx % span; this.arpIx++; break;
      case "down": ix = span - 1 - (this.arpIx % span); this.arpIx++; break;
      case "updown": {
        const cyc = Math.max(1, 2 * span - 2);
        const m = this.arpIx % cyc; ix = m < span ? m : cyc - m; this.arpIx++; break;
      }
      default: ix = this.arpRandom(span) - 1; break;
    }
    const oct = Math.floor(ix / chord.length), si = chord[ix % chord.length];
    const N = this.notes.length;
    let base = this.notes[Math.max(0, Math.min(N - 1, Math.round(si) - 1))];
    if (base === undefined) return null;
    base += 12 * oct;
    const freq = mtof(base) * 2 ** (this.pitch / 12);
    const ev = { plant: 0, arp: true, idx: 0, note: ftom(freq), freq, x: -1, y: -1, dur: q, t, scaleIndex: undefined };
    this.log.push(ev);
    return ev;
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

  state() {
    return {
      seed: this.seedValue, instr: this.instr.slice(), key: { ...this.key }, pitch: this.pitch, growth: this.growth,
      arp: { ...this.arp }, layers: this.layers.map((L) => ({ id: L.id, seed: L.seed, instr: L.instr, start: L.start, n: L.events.length, loops: L.loops })),
      gens: this.plants.map((p) => ({ gen: p.currentGeneration, max: p.maxGenerations })),
    };
  }
}
