// player.js · one audio chain for the page (audio.js) and the offline renders (garden-offline.js).
//
//   voice bus -> mix -> master -> mute -> limiter -> soft clip -> out
//   voice bus -> its own delay send -> wet -> mix
//
// Every voice implements {id, noteOn(ev, when), allOff(), params, set(), connect(send)}.
// playNote() routes a garden event to the voice named in ev.engine.
import { SawEngine } from "./engine-saw.js";
import { RainEngine } from "./engine-rain.js";

export const ENGINES = ["saw", "rain", "both"];
export const DELAY_DIVS = { "1/16": 0.25, "1/8": 0.5, "d1/8": 0.75, "1/4": 1, "1/2": 2 };
export const DELAY_DEFAULTS = { amount: 0, div: "d1/8", feedback: 0.45, lowpass: 2400, pingpong: false };

// a tempo-synced feedback delay on a send, with a low-pass in the loop so repeats sink into the fog
export function createDelay(ctx, bpm = 90, init = {}) {
  const send = ctx.createGain(); send.gain.value = 0;
  const wet = ctx.createGain(); wet.gain.value = 1;
  // straight path
  const straight = ctx.createGain();
  const delay = ctx.createDelay(4);
  const fb = ctx.createGain();
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
  send.connect(straight).connect(delay).connect(lp).connect(wet);
  lp.connect(fb).connect(delay);
  // ping-pong path: a mono input into the left line, the two lines feeding each other
  const pp = ctx.createGain(); pp.gain.value = 0; pp.channelCount = 1; pp.channelCountMode = "explicit";
  const dl = ctx.createDelay(4), dr = ctx.createDelay(4);
  const lpl = ctx.createBiquadFilter(), lpr = ctx.createBiquadFilter(); lpl.type = lpr.type = "lowpass";
  const fbl = ctx.createGain(), fbr = ctx.createGain();
  const merge = ctx.createChannelMerger(2);
  send.connect(pp).connect(dl).connect(lpl);
  lpl.connect(merge, 0, 0); lpl.connect(fbl).connect(dr).connect(lpr);
  lpr.connect(merge, 0, 1); lpr.connect(fbr).connect(dl);
  merge.connect(wet);
  const d = { send, delay, fb, lp, wet, bpm, ...DELAY_DEFAULTS };
  const now = () => ctx.currentTime;
  const time = () => Math.min(3.9, (60 / d.bpm) * (DELAY_DIVS[d.div] ?? 0.75));
  const applyTime = () => { for (const n of [delay, dl, dr]) n.delayTime.setTargetAtTime(time(), now(), 0.05); };
  d.setAmount = (a) => { d.amount = Math.max(0, Math.min(1, a)); send.gain.setTargetAtTime(d.amount, now(), 0.02); };
  d.setBpm = (b) => { d.bpm = b; applyTime(); };
  d.set = (o) => {
    if (o.amount !== undefined && o.amount !== d.amount) d.setAmount(o.amount);
    if (o.div !== undefined && DELAY_DIVS[o.div] && o.div !== d.div) { d.div = o.div; applyTime(); }
    if (o.feedback !== undefined) { d.feedback = Math.max(0, Math.min(0.85, o.feedback)); for (const n of [fb, fbl, fbr]) n.gain.setTargetAtTime(d.feedback, now(), 0.02); }
    if (o.lowpass !== undefined) { d.lowpass = Math.max(400, Math.min(8000, o.lowpass)); for (const n of [lp, lpl, lpr]) n.frequency.setTargetAtTime(d.lowpass, now(), 0.02); }
    if (o.pingpong !== undefined && !!o.pingpong !== d.pingpong) {
      d.pingpong = !!o.pingpong;
      straight.gain.setTargetAtTime(d.pingpong ? 0 : 1, now(), 0.02); pp.gain.setTargetAtTime(d.pingpong ? 1 : 0, now(), 0.02);
    }
  };
  // start values are set directly, so an offline render begins at them
  const v = { ...DELAY_DEFAULTS, ...init };
  fb.gain.value = fbl.gain.value = fbr.gain.value = d.feedback = v.feedback;
  lp.frequency.value = lpl.frequency.value = lpr.frequency.value = d.lowpass = v.lowpass;
  d.div = v.div; d.pingpong = !!v.pingpong;
  straight.gain.value = d.pingpong ? 0 : 1; pp.gain.value = d.pingpong ? 1 : 0;
  delay.delayTime.value = dl.delayTime.value = dr.delayTime.value = time();
  d.amount = v.amount; send.gain.value = v.amount;
  return d;
}

// the two ported engines behind the voice interface
class SawVoice {
  constructor(ctx, bus, opts) { this.id = "saw"; this.bus = bus; this.engine = new SawEngine(ctx, bus, opts.random ? { random: opts.random } : {}); this.bpm = opts.bpm || 90; }
  get params() { return this.engine.p; }
  set(name, v) { this.engine.set(name, v); }
  connect(send) { this.bus.connect(send); }
  allOff() { this.engine.allOff(); }
  // returns the seconds the voice will sound
  noteOn(ev, when) {
    const bpm = this.bpm;
    if (ev.arp || ev.flourish) {
      // short notes: faster saw rate, envelope scaled to the step; id offset so an arp note never steals a plant voice
      const scale = Math.max(0.12, Math.min(1, (ev.dur * 60 / bpm) / 1.2)) * (ev.gate ?? 1);
      this.engine.noteOn(1000 + ev.note, ev.freq, Math.max(1.5, (bpm / 90) * 2.5), when, scale, 0.45);
      return 1.5 * scale + 0.05;
    }
    // in a forest each plant's note has its own voice id, so the conductor's count is the real one
    const id = ev.voiceKey !== undefined ? 3000 + ev.voiceKey : ev.layer ? 2000 + ev.plant * 128 + ev.note : ev.note;
    this.engine.noteOn(id, ev.freq, bpm / 90, when, 1, ev.layer ? 0.7 : 1);
    return 1.55;
  }
}
class RainVoice {
  constructor(ctx, bus, opts) {
    this.id = "rain"; this.bus = bus; this.rand = opts.rand || Math.random; this.bpm = opts.bpm || 90;
    this.engine = new RainEngine(ctx, bus, { params: { cutoff: 500, ...(opts.rainParams || {}) } });
  }
  get params() { return this.engine.p; }
  set(name, v) { this.engine.set(name, v); }
  connect(send) { this.bus.connect(send); }
  allOff() { this.engine.allOff(); }
  noteOn(ev, when) {
    const e = this.engine;
    if (ev.arp || ev.flourish) {
      // rain's own envelope, with the release set from the step and the gate
      const rel = Math.max(0.06, (ev.dur * 60 / this.bpm) * (ev.gate ?? 1) * 1.5);
      e.set("release", rel); e.set("pan", this.rand()); e.set("gain", 0.6);
      e.hz(ev.freq / 2, when, 0.6);
      return rel * 1.2 + 0.06;
    }
    const rel = ev.maxLen ? Math.min(ev.maxLen, 2 + Math.floor(this.rand() * 7)) : 2 + Math.floor(this.rand() * 7);
    e.set("release", rel);
    e.set("pan", this.rand());
    e.set("gain", Math.min(1, 0.3 + this.rand()));
    e.hz(ev.freq / 2, when);
    return rel * 1.2 + 0.06;
  }
}

// the bass under the roots: two detuned triangles and a sub sine, low-passed, panned by the root tip
export class BassVoice {
  constructor(ctx, bus, opts = {}) {
    this.id = "bass"; this.ctx = ctx; this.bus = bus; this.bpm = opts.bpm || 90;
    this.p = { level: 0.6, decay: 0.35, release: 0.6, detune: 6 };
    this.live = new Set();
  }
  get params() { return this.p; }
  set(name, v) { if (name in this.p) this.p[name] = v; }
  connect(send) { this.bus.connect(send); }
  allOff() {
    const t = this.ctx.currentTime;
    for (const v of this.live) { try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.01); for (const o of v.osc) o.stop(t + 0.08); } catch (e) { /* already stopped */ } }
    this.live.clear();
  }
  noteOn(ev, when) {
    const ctx = this.ctx, p = this.p, gate = Math.max(0.05, ev.dur * 60 / this.bpm);
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = Math.min(1400, ev.freq * 6); lp.Q.value = 0.7;
    const sub = ctx.createGain(); sub.gain.value = 0.5;
    const osc = [ctx.createOscillator(), ctx.createOscillator(), ctx.createOscillator()];
    osc[0].type = osc[1].type = "triangle"; osc[2].type = "sine";
    osc[0].frequency.value = osc[1].frequency.value = ev.freq; osc[2].frequency.value = ev.freq / 2;
    osc[0].detune.value = p.detune; osc[1].detune.value = -p.detune;
    osc[0].connect(lp); osc[1].connect(lp); osc[2].connect(sub).connect(lp);
    let out = g;
    lp.connect(g);
    if (ctx.createStereoPanner) { const pan = ctx.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, ev.pan ?? 0)); g.connect(pan); out = pan; }
    out.connect(this.bus);
    const a = 0.012, peak = p.level * 0.5;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + a);
    g.gain.setTargetAtTime(peak * 0.45, when + a, Math.max(0.01, p.decay / 3));
    const off = when + Math.max(a + 0.02, gate);
    g.gain.setTargetAtTime(0, off, Math.max(0.01, p.release / 4));
    const end = off + p.release + 0.05;
    const v = { g, osc };
    for (const o of osc) { o.start(when); o.stop(end); }
    osc[0].onended = () => { this.live.delete(v); try { out.disconnect(); } catch (e) { /* gone */ } };
    this.live.add(v);
    return end - when;
  }
}

// opts: {master: 0..1, bpm, random, rand, rainParams, delays: {saw, rain}}
export function createChain(ctx, opts = {}) {
  const mix = ctx.createGain();
  const master = ctx.createGain();
  master.gain.value = opts.master ?? 0.7;
  const mute = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10; limiter.knee.value = 4; limiter.ratio.value = 20;
  limiter.attack.value = 0.003; limiter.release.value = 0.15;
  mix.connect(master).connect(mute).connect(limiter);
  // safety: a soft clip after the limiter so a dense arp over loops and delay never hard-clips the file or the DAC
  const clip = ctx.createWaveShaper();
  { const n = 2048, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = 0.88 * Math.tanh(x * 1.6) / Math.tanh(1.6); } clip.curve = c; clip.oversample = "2x"; }
  limiter.connect(clip).connect(opts.destination || ctx.destination);

  const bpm = opts.bpm || 90;
  const C = { ctx, mix, master, mute, limiter, clip, delays: {}, voices: {}, played: 0, bpm, rand: opts.rand || Math.random, spans: [], countSpans: !!opts.countSpans };
  C.addVoice = (name, make) => {
    const bus = ctx.createGain();
    bus.connect(mix);
    const v = make(bus);
    C.voices[name] = v;
    const d = createDelay(ctx, C.bpm, (opts.delays || {})[name]);
    C.delays[name] = d;
    v.connect(d.send);
    d.wet.connect(mix);
    return v;
  };
  C.addVoice("saw", (bus) => new SawVoice(ctx, bus, { random: opts.random, bpm }));
  C.addVoice("rain", (bus) => new RainVoice(ctx, bus, { rand: C.rand, rainParams: opts.rainParams, bpm }));
  C.addVoice("bass", (bus) => new BassVoice(ctx, bus, { bpm }));
  C.saw = C.voices.saw.engine; C.rain = C.voices.rain.engine;
  C.setBass = (b) => { for (const k of ["level", "decay", "release", "detune"]) if (b[k] !== undefined) C.voices.bass.set(k, b[k]); };
  // the drone: two sines a hair apart on the scale root, shared by every plant with roots
  let drone = null;
  C.setDrone = (hz, level) => {
    const t = ctx.currentTime, on = hz > 0 && level > 0;
    if (!drone && !on) return;
    if (!drone) {
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 220;
      const o = [ctx.createOscillator(), ctx.createOscillator()];
      o[0].frequency.value = hz; o[1].frequency.value = hz * 1.003;
      for (const x of o) { x.connect(lp); x.start(); }
      lp.connect(g).connect(mix);
      drone = { g, o, hz };
    }
    if (on && hz !== drone.hz) { drone.hz = hz; drone.o[0].frequency.setTargetAtTime(hz, t, 0.3); drone.o[1].frequency.setTargetAtTime(hz * 1.003, t, 0.3); }
    drone.g.gain.setTargetAtTime(on ? level * 0.12 : 0, t, 0.4);
  };
  // the v0.2.0 single delay: both lines at once
  C.delay = {
    get amount() { return C.delays.saw.amount; },
    setAmount(a) { for (const d of Object.values(C.delays)) d.setAmount(a); },
    setBpm(b) { C.setBpm(b); },
  };
  C.setBpm = (b) => { C.bpm = b; for (const d of Object.values(C.delays)) d.setBpm(b); for (const v of Object.values(C.voices)) v.bpm = b; };
  C.setDelays = (o) => { for (const k of Object.keys(o)) C.delays[k]?.set(o[k]); };
  C.setMaster = (v) => master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.02);
  C.setMute = (m) => mute.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.01);
  C.allOff = () => { for (const v of Object.values(C.voices)) v.allOff(); };
  // ev: a garden event {plant, note, freq, dur, engine, arp?, layer?}; when: ctx time
  C.playNote = (ev, bpm2, when) => {
    if (bpm2 && bpm2 !== C.bpm) { C.bpm = bpm2; for (const v of Object.values(C.voices)) v.bpm = bpm2; }
    const v = C.voices[ev.engine] || C.voices.saw;
    const len = v.noteOn(ev, when);
    if (C.countSpans) C.spans.push([when, when + (len || 0), v.id]);
    C.played++;
  };
  return C;
}

// the most voices sounding at once, from recorded [start, end] spans
export function maxConcurrent(spans) {
  const ev = [];
  for (const [a, b] of spans) { ev.push([a, 1], [b, -1]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, m = 0;
  for (const [, d] of ev) { n += d; if (n > m) m = n; }
  return m;
}
