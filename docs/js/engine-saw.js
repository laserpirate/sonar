// engine-saw.js · WebAudio port of flora's BandSaw (lib/Engine_SonarSaw.sc)
//
// note_on(id, cf, freq) as flora calls it: id = midi note, cf = the note's Hz
// (the band-pass centre), freq = the saw rate, a slow tempo-derived pulse
// (bpm / 90 Hz at flora's defaults). Two saws per voice (L and R), each with
// its own drift: saw rate +-0.2 semitone (LFNoise1 0.5 Hz), centre wandering
// between cfmin and cfmax (cf x 1.008..1.025) at 0.1..0.3 Hz, rq wandering
// between rqmin x 1.01..1.15 and rqmax at 0.1 Hz. Then a low shelf, then the
// multi-node envelope (Env.xyc from the same level, time, curve arrays flora
// sends to set_env_*), then amp. Wow (a sharp periodic bump in cf) as in the
// SynthDef; flutter as a gentle gain wobble. Voice cap 10, oldest stolen.
//
// Not ported: the PitchShift effects bus (flora's default effect_pitchshift is 0).

const MAX_VOICES = 10;

export const SAW_DEFAULTS = {
  // what flora's init sends (read from the norns mock engine log)
  amp: 2,
  rqmin: 0.001,
  rqmax: 0.005,
  cfhzmin: 0.1,
  cfhzmax: 0.3,
  lsf: 200,
  ldb: 0,
  wobble_rpm: 33,
  wobble_amp: 0.01,
  wobble_exp: 39,
  flutter_amp: 0,
  flutter_fixedfreq: 6,
  flutter_variationfreq: 6,
  env_levels: [0, 2, 0],
  env_times: [0, 0, 1.5],
  env_curves: [0, -10, -10],
  // browser-only loudness makeup into the master limiter. A 1.3 Hz saw into a
  // Q 200..1000 band-pass leaves about one harmonic in band, so the voice sits
  // near -38 dBFS at unity (offline render, tests/audio-midi.spec.mjs); +31 dB
  // brings the peak to about -6 dBFS. On the norns this is the output level knob.
  makeup: 200,
};

// SuperCollider Env curve shape for a numeric curve c, x in 0..1
export function curveValue(a, b, c, x) {
  if (Math.abs(c) < 1e-4) return a + (b - a) * x;
  return a + ((b - a) * (1 - Math.exp(c * x))) / (1 - Math.exp(c));
}

// Env.xyc([[time, level, curve], ...]) sampled into a Float32Array
export function envelopeCurve(times, levels, curves, rate = 400) {
  const pts = times.map((t, i) => [Number(t) || 0, Number(levels[i]) || 0, Number(curves[i]) || 0]);
  pts.sort((p, q) => p[0] - q[0]);
  const dur = Math.max(0.01, pts[pts.length - 1][0]);
  const n = Math.max(8, Math.ceil(dur * rate));
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * dur;
    let v = pts[pts.length - 1][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, l0, c0] = pts[i], [t1, l1] = pts[i + 1];
      if (t >= t0 && t <= t1) {
        v = t1 - t0 < 1e-6 ? l1 : curveValue(l0, l1, c0, (t - t0) / (t1 - t0));
        break;
      }
    }
    out[k] = v;
  }
  out[0] = pts[0][1];
  return { curve: out, dur };
}

const exprand = (lo, hi, r = Math.random) => lo * Math.pow(hi / lo, r());
const white = (lo, hi, r = Math.random) => lo + (hi - lo) * r();

export class SawEngine {
  constructor(ctx, destination, opts = {}) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(destination);
    this.p = { ...SAW_DEFAULTS, ...(opts.params || {}) };
    this.random = opts.random || Math.random;
    this.voices = [];
    this.out.gain.value = this.p.makeup;
  }
  set(name, v) { this.p[name] = v; if (name === "makeup") this.out.gain.value = v; if (name.startsWith("wobble")) this._wow = null; }
  wowBuffer() {
    if (this._wow) return this._wow;
    const sr = this.ctx.sampleRate, period = 60 / this.p.wobble_rpm;
    const n = Math.max(64, Math.round(period * sr / 8)); // 1/8 rate is plenty for a 0.55 Hz shape
    const b = this.ctx.createBuffer(1, n, sr / 8 >= 3000 ? sr / 8 : 3000);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) { const s = Math.sin((2 * Math.PI * i) / n); const w = Math.pow(s, this.p.wobble_exp); d[i] = w > 0 ? w : 0; }
    return (this._wow = b);
  }
  setEnv(levels, times, curves) { this.p.env_levels = levels.slice(); this.p.env_times = times.slice(); this.p.env_curves = curves.slice(); }

  // flora: engine.note_on(note_to_play, freq, random_note_frequency)
  noteOn(id, cf, frequency, when) {
    const ctx = this.ctx, p = this.p, r = this.random;
    const t0 = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    if (frequency < 0.2) frequency = 0.2;
    // steal: same id, else oldest when full
    let steal = this.voices.find((v) => v.id === id);
    if (!steal && this.voices.length >= MAX_VOICES) steal = this.voices[this.voices.length - 1];
    if (steal) this.kill(steal, t0);

    const { curve, dur } = envelopeCurve(p.env_times, p.env_levels, p.env_curves);
    const end = t0 + dur + 0.05;
    const vca = ctx.createGain();
    vca.gain.value = 0;
    vca.gain.setValueCurveAtTime(curve, t0, dur);
    const amp = ctx.createGain();
    amp.gain.value = p.amp;
    const merger = ctx.createChannelMerger(2);
    merger.connect(amp).connect(vca).connect(this.out);

    const cfmin = cf;
    const cfmax = cf * white(1.008, 1.025, r);
    const rqlo = p.rqmin * exprand(1.01, 1.15, r);
    const rqhi = Math.max(p.rqmax, rqlo * 1.0001);
    const nodes = [];
    // wow: wobble_amp * SinOsc(rpm/60)^wobble_exp, positive half only, times cf,
    // added to the band-pass centre (one looping buffer of the exact shape)
    let wowDepth = null;
    if (p.wobble_amp > 0) {
      const src = ctx.createBufferSource();
      src.buffer = this.wowBuffer();
      src.loop = true;
      wowDepth = ctx.createGain();
      wowDepth.gain.value = cf * p.wobble_amp;
      src.connect(wowDepth);
      src.start(t0, r() * src.buffer.duration);
      src.stop(end);
      nodes.push(src, wowDepth);
    }
    for (let ch = 0; ch < 2; ch++) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = frequency;
      // LFNoise1.kr(0.5, 0.2).midiratio: +-20 cents, new target every 2 s, linear
      osc.detune.setValueAtTime(white(-20, 20, r), t0);
      for (let t = t0 + 2; t < end + 2; t += 2) osc.detune.linearRampToValueAtTime(white(-20, 20, r), t);
      const bpf = ctx.createBiquadFilter();
      bpf.type = "bandpass";
      // centre: LFNoise1 at exprange(cfhzmin, cfhzmax), mapped exp into cfmin..cfmax
      const rate = exprand(p.cfhzmin, p.cfhzmax, r);
      const step = 1 / Math.max(0.05, rate);
      bpf.frequency.setValueAtTime(exprand(cfmin, cfmax, r), t0);
      for (let t = t0 + step; t < end + step; t += step) bpf.frequency.linearRampToValueAtTime(exprand(cfmin, cfmax, r), t);
      // rq: LFNoise1.kr(0.1).exprange(rqmin, rqmax); Q = 1 / rq
      bpf.Q.setValueAtTime(1 / exprand(rqlo, rqhi, r), t0);
      for (let t = t0 + 10; t < end + 10; t += 10) bpf.Q.linearRampToValueAtTime(1 / exprand(rqlo, rqhi, r), t);
      if (wowDepth) wowDepth.connect(bpf.frequency);
      const shelf = ctx.createBiquadFilter();
      shelf.type = "lowshelf";
      shelf.frequency.value = p.lsf;
      shelf.gain.value = p.ldb;
      osc.connect(bpf).connect(shelf).connect(merger, 0, ch);
      osc.start(t0);
      osc.stop(end);
      nodes.push(osc, bpf, shelf);
    }
    // flutter: gentle gain wobble (flora default flutter_amp 0)
    if (p.flutter_amp > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.flutter_fixedfreq;
      const depth = ctx.createGain();
      depth.gain.value = p.flutter_amp * p.amp;
      lfo.connect(depth).connect(amp.gain);
      lfo.start(t0); lfo.stop(end);
      nodes.push(lfo, depth);
    }
    const v = { id, t0, end, vca, amp, merger, nodes };
    this.voices.unshift(v);
    nodes[0].onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      try { merger.disconnect(); amp.disconnect(); vca.disconnect(); } catch {}
    };
    return v;
  }
  kill(v, t) {
    try {
      const g = v.vca.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, 0.01);
      for (const n of v.nodes) if (n.stop) { try { n.stop(t + 0.06); } catch {} }
    } catch {}
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }
  allOff() { const t = this.ctx.currentTime; for (const v of this.voices.slice()) this.kill(v, t); }
}
