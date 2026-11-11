// voices.js · the added voices (pluck, sine, water, sampler) and every voice's parameter specs.
// The specs are pure data, read by the garden (note lengths for the conductor), the rail (sliders),
// randomize (bounded ranges) and setups and banks (clean on load). The classes need an AudioContext.
import { makeRandom } from "./lsys.js";

// rlo, rhi: the range randomize may use, inside lo..hi
export const COMMON = {
  level: { lo: 0, hi: 1, def: 1, step: 0.01, rlo: 0.5, rhi: 1 },
  octave: { lo: -2, hi: 2, def: 0, step: 1, rlo: -1, rhi: 1 },
  detune: { lo: -50, hi: 50, def: 0, step: 1, unit: "ct", rlo: -12, rhi: 12 },
  tremolo: { lo: 0, hi: 1, def: 0, step: 0.01, rlo: 0, rhi: 0.4 },
  tremrate: { lo: 0.5, hi: 12, def: 4.5, step: 0.1, unit: "Hz", rlo: 2, rhi: 7 },
};
export const VOICE_SPECS = {
  saw: {}, rain: {}, bass: {},
  pluck: {
    decay: { lo: 0.2, hi: 6, def: 1.8, step: 0.01, unit: "s", rlo: 0.6, rhi: 3.5 },
    bright: { lo: 0, hi: 1, def: 0.6, step: 0.01 },
    body: { lo: 0, hi: 1, def: 0.4, step: 0.01 },
    pick: { lo: 0, hi: 1, def: 0.3, step: 0.01 },
  },
  sine: {
    attack: { lo: 0.001, hi: 1, def: 0.005, step: 0.001, unit: "s", rlo: 0.001, rhi: 0.2 },
    decay: { lo: 0.05, hi: 4, def: 1.2, step: 0.01, unit: "s", rlo: 0.3, rhi: 2.5 },
    sustain: { lo: 0, hi: 1, def: 0, step: 0.01, rlo: 0, rhi: 0.4 },
    release: { lo: 0.05, hi: 4, def: 1.5, step: 0.01, unit: "s", rlo: 0.3, rhi: 2.5 },
    ratio: { lo: 0.5, hi: 8, def: 3.5, step: 0.01, rlo: 1, rhi: 5 },
    index: { lo: 0, hi: 10, def: 3, step: 0.1, rlo: 0.5, rhi: 5 },
    gliss: { lo: 0, hi: 0.5, def: 0, step: 0.01, unit: "s", rlo: 0, rhi: 0.15 },
  },
  water: {
    bursts: { lo: 1, hi: 6, def: 3, step: 1 },
    spread: { lo: 0.02, hi: 0.4, def: 0.12, step: 0.01, unit: "s" },
    q: { lo: 2, hi: 40, def: 14, step: 0.5, rlo: 6, rhi: 30 },
    decay: { lo: 0.02, hi: 0.6, def: 0.15, step: 0.01, unit: "s" },
    drip: { lo: 0, hi: 1, def: 0.4, step: 0.01 },
  },
  sampler: {
    root: { lo: 24, hi: 96, def: 60, step: 1, norand: true },
    start: { lo: 0, hi: 1, def: 0, step: 0.01, rlo: 0, rhi: 0.3 },
    length: { lo: 0.01, hi: 1, def: 1, step: 0.01, rlo: 0.3, rhi: 1 },
    attack: { lo: 0, hi: 0.5, def: 0.005, step: 0.001, unit: "s", rlo: 0, rhi: 0.1 },
    release: { lo: 0.01, hi: 3, def: 0.3, step: 0.01, unit: "s", rlo: 0.05, rhi: 1.2 },
    loop: { bool: true, def: false },
    reverse: { bool: true, def: false },
    tune: { lo: -100, hi: 100, def: 0, step: 1, unit: "ct", rlo: -20, rhi: 20 },
  },
};
export const BUILTIN = ["saw", "rain", "pluck", "sine", "water"];
export const isSample = (id) => /^smp\d{1,3}$/.test(id);
export const specOf = (id) => ({ ...COMMON, ...(isSample(id) ? VOICE_SPECS.sampler : VOICE_SPECS[id] || {}) });
export function voiceDefaults(id) { const o = {}; for (const [k, s] of Object.entries(specOf(id))) o[k] = s.def; return o; }
export function cleanVoice(id, p = {}) {
  const o = voiceDefaults(id);
  for (const [k, s] of Object.entries(specOf(id))) {
    const v = p?.[k];
    if (s.bool) o[k] = !!(v ?? s.def);
    else { const n = Number(v); if (v !== undefined && v !== null && Number.isFinite(n)) o[k] = Math.max(s.lo, Math.min(s.hi, n)); }
  }
  return o;
}

// seconds a note sounds on an added voice; never less than the voice really sounds
export function voiceLen(id, p, ev, bpm) {
  const gate = Math.max(0.02, (ev.dur * 60) / bpm) * (ev.gate ?? 1);
  if (id === "pluck") return p.decay + 0.06;
  if (id === "sine") return Math.max(p.attack + p.decay, gate) + p.release + 0.06;
  if (id === "water") return (p.bursts - 1) * p.spread * 1.4 + p.decay * 4 + 0.06;
  if (isSample(id)) return gate + p.release + 0.06;
  return 1.55;
}

// ---- the voices -------------------------------------------------------------------
// each: {id, params, set(name, v), connect(send), allOff(), noteOn(ev, when) -> seconds}
class Base {
  constructor(ctx, bus, id) { this.ctx = ctx; this.bus = bus; this.id = id; this.p = voiceDefaults(id); this.live = new Set(); this.bpm = 90; this.rand = makeRandom(0x3c1 ^ id.length); }
  get params() { return this.p; }
  set(name, v) { if (name in this.p) this.p[name] = v; }
  connect(send) { this.bus.connect(send); }
  _track(v, src) { this.live.add(v); src.onended = () => { this.live.delete(v); try { v.out.disconnect(); } catch (e) { /* gone */ } }; }
  allOff() {
    const t = this.ctx.currentTime;
    for (const v of this.live) { try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.01); for (const s of v.src) s.stop(t + 0.08); } catch (e) { /* already stopped */ } }
    this.live.clear();
  }
  _pan(out) {
    if (!this.ctx.createStereoPanner) return out;
    const pan = this.ctx.createStereoPanner(); pan.pan.value = (this.rand() * 2 - 1) * 0.6; out.connect(pan); return pan;
  }
}

// Karplus-Strong, computed into a buffer per note (a DelayNode in a loop cannot go under 128 samples)
export class PluckVoice extends Base {
  constructor(ctx, bus) { super(ctx, bus, "pluck"); this.cache = new Map(); }
  _string(freq) {
    const p = this.p, sr = this.ctx.sampleRate;
    const key = `${freq.toFixed(2)}|${p.decay}|${p.bright}|${p.pick}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const N = Math.max(2, Math.round(sr / freq)), len = Math.ceil(sr * p.decay) + N;
    const buf = this.ctx.createBuffer(1, len, sr), y = buf.getChannelData(0);
    const r = makeRandom(Math.round(freq * 100) || 1);
    // the pick: noise, smoothed more for a soft pick
    let prev = 0;
    for (let i = 0; i < N; i++) { const x = r() * 2 - 1; prev = prev + (1 - p.pick * 0.9) * (x - prev); y[i] = prev; }
    const g = Math.pow(10, -3 / (p.decay * freq)); // -60 dB after `decay` seconds
    const b = 0.5 + 0.5 * p.bright;
    for (let i = N; i < len; i++) y[i] = g * (b * y[i - N] + (1 - b) * 0.5 * (y[i - N] + y[i - N - 1 < 0 ? 0 : i - N - 1]));
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, buf);
    return buf;
  }
  noteOn(ev, when) {
    const ctx = this.ctx, p = this.p;
    const src = ctx.createBufferSource(); src.buffer = this._string(Math.max(30, Math.min(4000, ev.freq)));
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 800 + 7200 * p.body;
    const g = ctx.createGain(); g.gain.value = 0.55;
    src.connect(lp).connect(g);
    const out = this._pan(g); out.connect(this.bus);
    src.start(when); src.stop(when + p.decay + 0.05);
    this._track({ g, src: [src], out }, src);
    return p.decay + 0.05;
  }
}

// a two-operator FM bell with ADSR and a glide from the last note
export class SineVoice extends Base {
  constructor(ctx, bus) { super(ctx, bus, "sine"); this.last = null; }
  noteOn(ev, when) {
    const ctx = this.ctx, p = this.p, f = ev.freq;
    const gate = Math.max(0.02, (ev.dur * 60) / this.bpm) * (ev.gate ?? 1);
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
    car.type = mod.type = "sine";
    if (p.gliss > 0 && this.last) { car.frequency.setValueAtTime(this.last, when); car.frequency.exponentialRampToValueAtTime(f, when + p.gliss); }
    else car.frequency.value = f;
    mod.frequency.value = f * p.ratio;
    mg.gain.setValueAtTime(f * p.index, when); mg.gain.setTargetAtTime(f * p.index * 0.15, when, Math.max(0.02, p.decay / 3));
    mod.connect(mg).connect(car.frequency);
    const peak = 0.3, sus = peak * p.sustain;
    g.gain.value = 0;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + p.attack);
    g.gain.setTargetAtTime(sus, when + p.attack, Math.max(0.01, p.decay / 4));
    const off = when + Math.max(p.attack + p.decay, gate);
    g.gain.setTargetAtTime(0, off, Math.max(0.01, p.release / 4));
    car.connect(g);
    const out = this._pan(g); out.connect(this.bus);
    const end = off + p.release + 0.05;
    car.start(when); mod.start(when); car.stop(end); mod.stop(end);
    this.last = f;
    this._track({ g, src: [car, mod], out }, car);
    return end - when;
  }
}

// band-passed noise bursts tuned to the note, falling a little like a drop: rain on a surface
export class WaterVoice extends Base {
  constructor(ctx, bus) {
    super(ctx, bus, "water");
    const sr = ctx.sampleRate, buf = ctx.createBuffer(1, sr, sr), d = buf.getChannelData(0), r = makeRandom(0x77a7);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    this.noise = buf;
  }
  noteOn(ev, when) {
    const ctx = this.ctx, p = this.p, f = Math.max(80, Math.min(9000, ev.freq * 2));
    const out = ctx.createGain(); out.gain.value = 1;
    const dest = this._pan(out); dest.connect(this.bus);
    const srcs = [];
    let t = when, last = when;
    for (let i = 0; i < p.bursts; i++) {
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = p.q;
      bp.frequency.setValueAtTime(f * (1 + p.drip * 0.5), t); bp.frequency.exponentialRampToValueAtTime(f, t + p.decay);
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(Math.min(1.6, 0.25 * Math.sqrt(p.q)), t + 0.003); g.gain.setTargetAtTime(0, t + 0.003, p.decay);
      src.connect(bp).connect(g).connect(out);
      src.start(t, this.rand() * 0.9); src.stop(t + p.decay * 4);
      srcs.push(src); last = t + p.decay * 4;
      t += p.spread * (0.6 + 0.8 * this.rand());
    }
    this._track({ g: out, src: srcs, out: dest }, srcs[srcs.length - 1]);
    return last - when + 0.05;
  }
}

// one loaded sound, pitched by playback rate from its root note
export class SamplerVoice extends Base {
  constructor(ctx, bus, id, buffer) { super(ctx, bus, id); this.setBuffer(buffer); }
  setBuffer(buffer) { this.buffer = buffer; this.reversed = null; }
  _buf() {
    if (!this.p.reverse) return this.buffer;
    if (!this.reversed) {
      const b = this.buffer, r = this.ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) { const s = b.getChannelData(c), d = r.getChannelData(c); for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i]; }
      this.reversed = r;
    }
    return this.reversed;
  }
  set(name, v) { super.set(name, v); if (name === "reverse") this.reversed = null; }
  noteOn(ev, when) {
    const ctx = this.ctx, p = this.p, buf = this._buf();
    if (!buf) return 0;
    const rate = (ev.freq / (440 * 2 ** ((p.root - 69) / 12))) * 2 ** (p.tune / 1200);
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = Math.max(0.05, Math.min(16, rate));
    const off0 = p.start * buf.duration, len = Math.max(0.005, p.length * (buf.duration - off0));
    if (p.loop) { src.loop = true; src.loopStart = off0; src.loopEnd = off0 + len; }
    const gate = Math.max(0.02, (ev.dur * 60) / this.bpm) * (ev.gate ?? 1);
    const play = p.loop ? gate : Math.min(gate, len / src.playbackRate.value);
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(0.7, when + Math.max(0.002, p.attack));
    g.gain.setValueAtTime(0.7, when + Math.max(0.002, p.attack, play));
    g.gain.setTargetAtTime(0, when + Math.max(0.002, p.attack, play), Math.max(0.005, p.release / 4));
    src.connect(g);
    const out = this._pan(g); out.connect(this.bus);
    const end = when + Math.max(p.attack, play) + p.release + 0.05;
    src.start(when, off0); src.stop(end);
    this._track({ g, src: [src], out }, src);
    return end - when;
  }
}

// a generated room: stereo noise decaying to -60 dB over `size` seconds
export function makeImpulse(ctx, size) {
  const sr = ctx.sampleRate, n = Math.max(1, Math.round(sr * size)), b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c), r = makeRandom(0x5eed + c);
    for (let i = 0; i < n; i++) d[i] = (r() * 2 - 1) * Math.exp((-6.9 * i) / n);
  }
  return b;
}
// pink noise (Paul Kellet's filter), seeded, for the wind bed
export function makePink(ctx, seconds = 4) {
  const sr = ctx.sampleRate, n = Math.round(sr * seconds), b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c), r = makeRandom(0x91d + c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  }
  return b;
}
