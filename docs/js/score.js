// score.js · sonar · an ambient score for shanshui scrolls and kodama scenes.
//
// ES module, no DOM, no globals. Deterministic from the seed: the same seed and the same scene
// calls give the same event log (plant, generations, notes, drone centre), with or without audio.
//
//   const score = new Score({ engines: createEngines(ctx), osc });   // engines and osc optional
//   score.seed(1792909998082);
//   score.scene({ kind, x, velocity, tags, entered, weather, phase, pu, level, morph, cycle, t, dt });
//   score.play(); score.stop(); score.panic();
//   score.state();   // {seed, plant, gen, genMax, bpm, root, voices, playing, kind, phase, cycle}
//
// Time: scene({t}) in seconds when the caller owns the clock (sims, offline renders); otherwise
// the engines' AudioContext time; otherwise an internal clock advanced by scene({dt}).
// Every number lives in map.js.
import { Plant, Sequencer, makeRandom, mtof, ftom } from "./lsys.js";
import { CATALOG } from "./catalog.js";
import { MAP, dbToGain } from "./map.js";
import { SawEngine } from "./engine-saw.js";
import { RainEngine } from "./engine-rain.js";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r3 = (v) => Math.round(v * 1000) / 1000;
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n) => NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
export const plantId = (n) => "p" + String(n).padStart(2, "0");

// seed -> non-negative integer: digit strings and numbers as themselves (to 2^53), anything else FNV-1a
export function seedNumber(s) {
  if (typeof s === "number" && Number.isFinite(s)) return Math.abs(Math.floor(s));
  const str = String(s ?? "").trim();
  if (/^\d{1,15}$/.test(str)) return Number(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mix(...ns) {
  let h = 0x9e3779b9;
  for (const n of ns) {
    h ^= n >>> 0; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  }
  return h >>> 0;
}

// master chain and the two engine ports, for hosts that have no audio of their own
export function createEngines(ctx, destination) {
  const master = ctx.createGain();
  master.gain.value = dbToGain(MAP.master.gainDb);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = MAP.master.limiterDb; limiter.knee.value = 3; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.2;
  master.connect(limiter).connect(destination || ctx.destination);
  const saw = new SawEngine(ctx, master, { random: makeRandom(0x5a3) });
  const rain = new RainEngine(ctx, master, { params: { cutoff: MAP.rain.cutoff, amp: MAP.rain.amp, release: MAP.rain.releaseS } });
  return { ctx, saw, rain, master, limiter };
}

// two detuned saws through one band-pass on the root, a low shelf, a slow envelope
class Drone {
  constructor(ctx, dest) {
    this.ctx = ctx;
    const D = MAP.drone;
    this.bpf = ctx.createBiquadFilter(); this.bpf.type = "bandpass";
    this.shelf = ctx.createBiquadFilter(); this.shelf.type = "lowshelf"; this.shelf.frequency.value = MAP.weather.shelfHz;
    this.vca = ctx.createGain(); this.vca.gain.value = 0;
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.37;
    this.lfoDepth = ctx.createGain(); this.lfoDepth.gain.value = 0;
    this.lfo.connect(this.lfoDepth);
    this.oscs = [-1, 1].map((s) => {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.detune.value = s * D.detuneCents;
      this.lfoDepth.connect(o.detune);
      o.connect(this.bpf); return o;
    });
    this.bpf.connect(this.shelf).connect(this.vca).connect(dest);
    this.started = false;
  }
  start(t, f, cf, rq, level) {
    if (!this.started) { for (const o of this.oscs) o.start(t); this.lfo.start(t); this.started = true; }
    this.setRoot(f, cf, t, 0.01); this.setRq(rq, t);
    const g = this.vca.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(level, t + MAP.drone.attackS);
    this.until = t + MAP.drone.attackS;
  }
  setLevel(level, t) { if (t < (this.until || 0)) return; this.vca.gain.setTargetAtTime(level, t, 0.5); }
  release(t, dur) { const g = this.vca.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + dur); }
  setRoot(f, cf, t, glide) {
    for (const o of this.oscs) { o.frequency.cancelScheduledValues(t); o.frequency.setTargetAtTime(f, t, glide / 3); }
    this.bpf.frequency.cancelScheduledValues(t); this.bpf.frequency.setTargetAtTime(cf, t, glide / 3);
  }
  drift(cf, t, dur) { this.bpf.frequency.cancelScheduledValues(t); this.bpf.frequency.setValueAtTime(this.bpf.frequency.value, t); this.bpf.frequency.linearRampToValueAtTime(cf, t + dur); }
  setRq(rq, t) { this.bpf.Q.setTargetAtTime(1 / Math.max(0.01, rq), t, 0.5); }
  setShelf(db, t) { this.shelf.gain.setTargetAtTime(db, t, 0.5); }
  setWow(cents, t) { this.lfoDepth.gain.setTargetAtTime(cents, t, 0.5); }
}

export class Score {
  constructor({ engines, osc, clock, catalog } = {}) {
    this.cat = catalog || CATALOG;
    this.D = this.cat.defaults;
    this.osc = osc || null;
    this.clock = clock || null;
    this.log = [];
    this.playing = false;
    this.kind = "shanshui";
    this.t = 0;
    this.beat = 0;
    this.bpm = MAP.tempo.bpmMin;
    this.moving = false;
    this.phase = null;
    this.weather = { rain: 0, wind: 0, water: 0, fog: 0, light: 1 };
    this.voices = [];
    this.E = null; this.ctx = null; this.drone = null;
    if (engines) this.attach(engines);
    this.seed(1);
  }

  // engines can arrive later (after an Enable click)
  attach(engines) {
    this.E = engines;
    this.ctx = engines.ctx || engines.saw?.ctx || null;
    if (!this.ctx) return;
    const s = engines.saw;
    if (s) { s.set("amp", MAP.note.gain); s.setEnv([0, 1, 0], [0, MAP.note.attackS, MAP.note.attackS + MAP.note.releaseS], [0, -2, -4]); }
    this.drone = new Drone(this.ctx, engines.master || this.ctx.destination);
    this.t = Math.max(this.t, this.ctx.currentTime);
    this._applied = null;
    if (this.playing) this._droneStart(this.t);
  }

  now(sc) {
    if (sc && Number.isFinite(sc.t)) return sc.t;
    if (this.clock) return this.clock();
    if (this.ctx) return this.ctx.currentTime;
    return this.t + (sc ? (Number.isFinite(sc.dt) ? sc.dt : 1 / 60) : 0);
  }
  _ev(e) { this.log.push(e); if (this.log.length > MAP.logMax) this.log.splice(0, this.log.length - MAP.logMax); if (this.onEvent) { try { this.onEvent(e); } catch {} } }
  _osc(path, args) { if (this.osc && this.osc.send) { try { this.osc.send(path, args); } catch {} } }

  stream(k, cycle = 0) { return makeRandom(mix(this.sLo, this.sHi, k, cycle) || 1); }

  seed(n) {
    const s = seedNumber(n);
    this.seedValue = String(n);
    this.s = s; this.sLo = s >>> 0; this.sHi = Math.floor(s / 4294967296) >>> 0;
    this.plantNo = (s % MAP.seed.plants) + 1;
    this.root = MAP.seed.rootLo + (Math.floor(s / MAP.seed.plants) % MAP.seed.rootSpan);
    this.rngD = this.stream(2); this.rngR = this.stream(3); this.rngS = this.stream(4);
    this.cycle = 0;
    this.instr = this.cat.plants[this.plantNo - 1];
    this._newPlant(this.stream(1, 0), undefined);
    this.genMin = this.plant.currentGeneration;
    this.genMax = this.plant.maxGenerations;
    this.genDir = 1;
    this.shift = Math.round(clamp01(this.weather.water) * MAP.drone.waterSemis);
    this.seq = new Sequencer(this.plant, this.D, { random: this.rngS, notes: this.scale(), noteScalar: this.D.note_scalar, duration: MAP.note.durationBeats, cfScalars: [1], t: this.beat });
    this.pend = null;
    this.lastGenT = -Infinity; this.restUntil = -Infinity; this.nextDrift = this.t; this.cfMul = 1;
    this.lastBeatInt = Math.floor(this.beat);
    this._ev({ t: r3(this.t), k: "seed", seed: this.seedValue, plant: this.plantNo, root: this.root, gen: this.plant.currentGeneration });
    this._sendPlant();
    if (this.playing && this.drone) this._droneStart(this.t);
    return this.state();
  }
  _newPlant(rng, gen) {
    this.rngL = rng;
    const p = new Plant(1, { random: rng, defaults: this.D });
    p.setup(this.instr, this.plantNo, gen);
    this.plant = p;
    if (this.seq) { this.seq.plant = p; this.seq.reset(this.seq.t); this.pend = null; }
  }
  rootNow() { return this.root - this.shift; }
  scale() {
    const sc = MAP.seed.scale, out = [];
    for (let i = 0; i < MAP.seed.scaleLength; i++) out.push(this.rootNow() + 12 * Math.floor(i / sc.length) + sc[i % sc.length]);
    return out;
  }

  // ------------------------------------------------------------------ scene
  scene(sc = {}) {
    const t = this.now(sc);
    const dt = Math.max(0, Math.min(0.5, t - this.t));
    this.t = t;
    if (sc.kind === "shanshui" || sc.kind === "kodama") this.kind = sc.kind;
    if (sc.weather) for (const k of Object.keys(this.weather)) if (Number.isFinite(sc.weather[k])) this.weather[k] = clamp01(sc.weather[k]);
    const T = MAP.tempo;
    let target = this.bpm;
    if (this.kind === "kodama") { target = T.kodamaBpm; }
    else if (Number.isFinite(sc.velocity)) {
      const v = Math.abs(sc.velocity);
      this.moving = v >= T.vStop;
      target = T.bpmMin + (T.bpmMax - T.bpmMin) * clamp01(v / T.vFull);
    }
    this.bpm += (target - this.bpm) * (1 - Math.exp(-dt / T.smoothS));
    if (!this.playing) return;
    if (this.kind === "kodama" && sc.phase) this._kodama(sc, t);
    if (Array.isArray(sc.entered)) for (const tag of sc.entered) this._entered(tag, t);
    this._weatherApply(t);
    this._drift(t);
    this._advance(t, dt);
  }

  _entered(tag, t) {
    const G = MAP.gen, role = G.alias[tag] || tag;
    if (G.stepTags.includes(role)) this._breath(t);
    else if (G.restTags.includes(role)) { if (this.beat >= this.restUntil) { this.restUntil = this.beat + G.restBeats; this._ev({ t: r3(t), k: "rest", until: r3(this.restUntil) }); } }
    else if (G.rainTags.includes(role)) this._rainNote(t, "boat");
  }
  _breath(t) {
    if (t - this.lastGenT < MAP.gen.minGapS) return;
    this.lastGenT = t;
    const g = this.plant.currentGeneration;
    if (this.genDir > 0 && g >= this.genMax) this.genDir = -1;
    else if (this.genDir < 0 && g <= this.genMin) this.genDir = 1;
    this._setGen(g + this.genDir, t);
  }
  _setGen(g, t) {
    g = Math.max(this.genMin, Math.min(this.genMax, g));
    const cur = this.plant.currentGeneration;
    if (g === cur) return;
    if (g === cur + 1) this.plant.generate(1);
    else this.plant.setup(this.instr, this.plantNo, g);
    this.pend = null;
    this._ev({ t: r3(t), k: "gen", g: this.plant.currentGeneration, len: this.plant.sentence.length });
    this._osc("/sonar/generate", [1, g > cur ? 1 : -1]);
  }
  _kodama(sc, t) {
    const p = Math.max(1, Math.min(3, Math.round(sc.phase))), pu = clamp01(sc.pu ?? 0);
    if (Number.isFinite(sc.cycle) && sc.cycle !== this.cycle) {
      this.cycle = sc.cycle;
      this._newPlant(this.stream(1, this.cycle), this.plant.currentGeneration);
      this._ev({ t: r3(t), k: "cycle", c: this.cycle });
    }
    if (p !== this.phase) {
      this.phase = p;
      this.seq.duration = MAP.note.durationBeats * (p === 2 ? MAP.note.shedDurationX : 1);
      this._ev({ t: r3(t), k: "phase", p });
      this._osc("/param/plant_1_note_duration", [p === 2 ? 7 : 5]);
    }
    const span = this.genMax - this.genMin;
    this.moving = p !== 3;
    if (p === 1) this._setGen(this.genMin + Math.round(pu * span), t);
    else if (p === 2) this._setGen(this.genMax - Math.round(pu * span), t);
    // Dry: drone and fog only
    this.weather.fog = p === 3 ? 0.6 * Math.sin(Math.PI * Math.min(1, pu * 1.1)) + 0.2 : 0.2;
  }

  _weatherApply(t) {
    const w = this.weather, W = MAP.weather;
    const shift = Math.round(w.water * MAP.drone.waterSemis);
    if (shift !== this.shift) {
      this.shift = shift;
      this.seq.notes = this.scale();
      this._ev({ t: r3(t), k: "root", r: this.rootNow() });
      this._osc("/param/root_note", [this.rootNow()]);
      if (this.drone && this.playing) this.drone.setRoot(mtof(this.rootNow()), mtof(this.rootNow()) * this.cfMul, t, MAP.drone.glideS);
    }
    if (!this.ctx) return;
    const a = this._applied || {};
    const near = (k, v, e) => a[k] !== undefined && Math.abs(a[k] - v) < e;
    const rq = MAP.drone.rqDry + (MAP.drone.rqFog - MAP.drone.rqDry) * w.fog;
    const shelf = (1 - w.light) * W.shelfDbDark;
    if (!near("rq", rq, 0.01)) { a.rq = rq; this.drone?.setRq(rq, t); this.E.saw?.set("rqmax", 0.005 + w.fog * W.fogRqNotes * 0.01); }
    if (!near("shelf", shelf, 0.2)) { a.shelf = shelf; this.drone?.setShelf(shelf, t); }
    // keep the drone at its rms target as the shelf and the fog band open (SN-33)
    const lvl = this.droneLevel();
    if (!near("lvl", lvl, lvl * 0.03) && this.drone && this.playing && !this.panicked) { a.lvl = lvl; this.drone.setLevel(lvl, t); }
    if (!near("wind", w.wind, 0.05)) { a.wind = w.wind; this.drone?.setWow(w.wind * 12, t); this.E.saw?.set("wobble_amp", w.wind * W.wowMax); this.E.saw?.set("flutter_amp", w.wind * W.flutterMax); }
    this._applied = a;
  }
  _drift(t) {
    if (t < this.nextDrift) return;
    const D = MAP.drone;
    this.cfMul = 1 + (this.rngD() * 2 - 1) * D.driftSpan;
    this.nextDrift = t + D.driftS;
    const cf = mtof(this.rootNow()) * this.cfMul;
    this._ev({ t: r3(t), k: "drone", cf: r3(cf) });
    if (this.drone && this.playing) this.drone.drift(cf, t, D.driftS);
  }

  _advance(t, dt) {
    if (!this.moving || dt <= 0) return;
    const bps = this.bpm / 60;
    this.beat += dt * bps;
    // rain: one chance per beat, scaled by weather.rain
    while (this.lastBeatInt < Math.floor(this.beat)) {
      this.lastBeatInt++;
      const r = this.rngR();
      if (r < this.weather.rain * MAP.rain.perBeat) this._rainNote(t, "rain");
    }
    const horizon = this.beat + MAP.lookaheadS * bps;
    if (this.seq.t < this.beat - 4) { this.seq.t = this.beat; this.pend = null; }   // after a hold: no burst
    for (let guard = 0; guard < 2000; guard++) {
      if (!this.pend) {
        let ev;
        for (let g2 = 0; g2 < 2000; g2++) { ev = this.seq.step(); if (ev.kind !== "step") break; }
        this.pend = ev;
      }
      const e = this.pend;
      if (!e || e.t > horizon) break;
      this.pend = null;
      if (e.kind !== "note") continue;
      const te = t + Math.max(0, (e.t - this.beat) / bps);
      if (e.t < this.restUntil) continue;
      this._note(te, e);
    }
  }
  _voiceFree(t, extra) {
    this.voices = this.voices.filter((v) => v > t);
    const drone = this.playing ? 2 : 0;
    return this.voices.length + drone + extra <= MAP.note.maxVoices;
  }
  _note(t, e) {
    if (!this._voiceFree(t, 1)) { this._ev({ t: r3(t), k: "skip", n: e.note }); return; }
    this.voices.push(t + MAP.note.attackS + MAP.note.releaseS);
    this._ev({ t: r3(t), k: "note", n: e.note, f: r3(e.freq), g: this.plant.currentGeneration });
    if (this.E?.saw) this.E.saw.noteOn(e.note, e.freq, MAP.note.sawRate, t);
  }
  _rainNote(t, src) {
    if (!this._voiceFree(t, 1)) { this._ev({ t: r3(t), k: "skip", src }); return; }
    const notes = this.seq.notes;
    const i = 7 + Math.floor(this.rngR() * 7);
    const n = notes[Math.min(notes.length - 1, i)] + MAP.rain.octave;
    const pan = this.rngR();
    this.voices.push(t + 0.01 + MAP.rain.releaseS * 1.2);
    this._ev({ t: r3(t), k: "rain", n, src });
    if (this.E?.rain) { const R = this.E.rain; R.set("release", MAP.rain.releaseS); R.set("pan", pan); R.set("gain", 0.6); R.hz(mtof(n), t); }
  }
  droneLevel() {
    const D = MAP.drone, W = MAP.weather, w = this.weather;
    const rq = D.rqDry + (D.rqFog - D.rqDry) * w.fog, shelf = (1 - w.light) * W.shelfDbDark;
    return D.gain * dbToGain(-shelf * W.shelfComp) * Math.pow(D.rqDry / rq, W.rqComp);
  }
  _droneStart(t) {
    if (!this.drone) return;
    const f = mtof(this.rootNow());
    this.drone.start(t, f, f * this.cfMul, MAP.drone.rqDry + (MAP.drone.rqFog - MAP.drone.rqDry) * this.weather.fog, this.droneLevel());
  }
  _sendPlant() {
    this._osc("/param/plant1_instructions", [this.plantNo]);
    this._osc("/param/root_note", [this.rootNow()]);
  }

  // ------------------------------------------------------------------ transport
  play() {
    if (this.playing) return;
    const t = this.now();
    this.t = Math.max(this.t, t);
    this.playing = true;
    if (this.panicked && this.E) { for (const e of [this.E.saw, this.E.rain]) if (e?.out) { const g = e.out.gain; g.cancelScheduledValues(this.t); g.setValueAtTime(0, this.t); g.linearRampToValueAtTime(e.p.makeup, this.t + 0.05); } }
    this.panicked = false;
    this._droneStart(this.t);
    this._ev({ t: r3(this.t), k: "play" });
    this._osc("/sonar/play", [1]);
  }
  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.drone) this.drone.release(this.now(), MAP.drone.releaseS);
    this._ev({ t: r3(this.now()), k: "stop" });
    this._osc("/sonar/play", [0]);
  }
  panic() {
    const t = this.now();
    this.playing = false; this.panicked = true;
    this.voices = []; this.pend = null;
    const ramp = MAP.panicRampS;
    if (this.drone) { const g = this.drone.vca.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + ramp); }
    if (this.E) {
      for (const e of [this.E.saw, this.E.rain]) if (e?.out) { const g = e.out.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + ramp); }
      try { this.E.saw?.allOff(); } catch {}
    }
    this._ev({ t: r3(t), k: "panic" });
    this._osc("/sonar/play", [0]);
  }

  state() {
    const p = this.plant;
    return {
      seed: this.seedValue, plant: plantId(this.plantNo), gen: p.currentGeneration, genMax: p.maxGenerations,
      bpm: Math.round(this.bpm), root: this.rootNow(), rootName: noteName(this.rootNow()),
      voices: this.voices.filter((v) => v > this.t).length + (this.playing ? 2 : 0),
      playing: this.playing, kind: this.kind, phase: this.phase, cycle: this.cycle,
    };
  }
  strip() {
    const s = this.state();
    return `score ${s.playing ? "on" : "off"} · seed ${s.seed} · ${s.plant} · gen ${s.gen} · bpm ${s.bpm}`;
  }
}
