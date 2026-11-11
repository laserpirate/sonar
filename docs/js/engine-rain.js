// engine-rain.js · WebAudio port of raindrops' Snowflake (lib/Engine_SonarRain.sc)
//
// hz(f): Pulse(freq, pw) -> MoogFF(cutoff, gain) -> Env.perc(level amp,
// release) -> Decimator(bits) + ducked pink hiss (HPF 2 kHz, x hiss/500).
// Stand-ins: a 24 dB low-pass (two cascaded 12 dB biquads, resonance from
// MoogFF's gain 0..4) for MoogFF; a WaveShaper staircase for the bit depth;
// the Compander duck as a gain dip on the hiss at each note.
// Pan follows raindrops' engine.pan (the SynthDef ignores it; raindrops
// still sends it, and a stereo field reads better on a wall).

export const RAIN_DEFAULTS = { amp: 0.3, release: 0.5, pan: 0.5, pw: 0.5, cutoff: 1000, gain: 1, bits: 32, hiss: 0, makeup: 1.6 };

const waveCache = new Map();
function pulseWave(ctx, pw) {
  const key = Math.round(pw * 100);
  if (waveCache.has(key)) return waveCache.get(key);
  const N = 96, re = new Float32Array(N), im = new Float32Array(N);
  const d = Math.min(0.99, Math.max(0.01, key / 100));
  for (let n = 1; n < N; n++) {
    // pulse of duty d: a_n = 2 sin(pi n d) / (pi n), cosine terms around the pulse centre
    re[n] = (2 * Math.sin(Math.PI * n * d)) / (Math.PI * n);
  }
  const w = ctx.createPeriodicWave(re, im, { disableNormalization: false });
  waveCache.set(key, w);
  return w;
}

function bitCurve(bits) {
  const n = 4096, c = new Float32Array(n);
  const steps = Math.pow(2, Math.max(1, Math.min(24, bits)) - 1);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
  return c;
}

export class RainEngine {
  constructor(ctx, destination, opts = {}) {
    this.ctx = ctx;
    this.p = { ...RAIN_DEFAULTS, ...(opts.params || {}) };
    this.out = ctx.createGain();
    this.out.gain.value = this.p.makeup;
    this.out.connect(destination);
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissDuck = ctx.createGain();
    this.hissDuck.gain.value = 1;
    this.startHiss();
    this.hissGain.connect(this.hissDuck).connect(this.out);
    this.set("hiss", this.p.hiss);
  }
  startHiss() {
    const ctx = this.ctx, sr = ctx.sampleRate, n = sr * 4;
    const b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    // pink noise (Paul Kellet) plus Dust(5)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      if (Math.random() < 5 / sr) d[i] += Math.random();
    }
    const src = ctx.createBufferSource();
    src.buffer = b; src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 2000;
    src.connect(hp).connect(this.hissGain);
    src.start();
    this.hissSrc = src;
  }
  set(name, v) {
    this.p[name] = v;
    if (name === "hiss") this.hissGain.gain.setTargetAtTime(v / 500, this.ctx.currentTime, 0.05);
    if (name === "makeup") this.out.gain.value = v;
  }
  hz(freq, when, ampScale = 1) {
    const ctx = this.ctx, p = this.p;
    const t0 = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pulseWave(ctx, p.pw));
    osc.frequency.value = freq;
    const q = 0.6 + Math.max(0, Math.min(4, p.gain)) * 2.2; // MoogFF gain 0..4 -> resonance
    const lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter();
    lp1.type = lp2.type = "lowpass";
    lp1.frequency.value = lp2.frequency.value = Math.max(20, Math.min(20000, p.cutoff));
    lp1.Q.value = q * 0.5; lp2.Q.value = q * 0.5;
    const env = ctx.createGain();
    // Env.perc(attack 0.01, release, level amp, curve -4)
    const rel = Math.max(0.02, p.release);
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(p.amp * ampScale, t0 + 0.01);
    env.gain.setTargetAtTime(0, t0 + 0.01, rel / 4.6);
    let tail = env;
    if (p.bits < 24) {
      const ws = ctx.createWaveShaper();
      ws.curve = bitCurve(p.bits);
      env.connect(ws); tail = ws;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, p.pan * 2 - 1));
    osc.connect(lp1).connect(lp2).connect(env);
    tail.connect(pan).connect(this.out);
    osc.start(t0);
    osc.stop(t0 + 0.01 + rel * 1.2 + 0.05);
    osc.onended = () => { try { pan.disconnect(); } catch {} };
    // Compander duck: hiss down under the note, back over 0.1 s
    if (p.hiss > 0) {
      const g = this.hissDuck.gain;
      g.setTargetAtTime(0.35, t0, 0.01);
      g.setTargetAtTime(1, t0 + Math.min(rel, 1), 0.1);
    }
  }
  allOff() { this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02); setTimeout(() => this.out.gain.setTargetAtTime(this.p.makeup, this.ctx.currentTime, 0.05), 200); }
}
