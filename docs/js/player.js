// player.js · one audio chain for the page (audio.js) and the offline renders
// (garden-offline.js): master -> mute -> delay send -> limiter -> out, the two
// engine ports, and playNote() which turns a garden event into engine calls
// the way flora's ps.play and raindrops' play() do.
import { SawEngine } from "./engine-saw.js";
import { RainEngine } from "./engine-rain.js";

export const ENGINES = ["saw", "rain", "both"];

// a tempo-synced feedback delay on a send: time = dotted eighth at bpm, feedback 0.45,
// a 2.4 kHz low-pass in the loop so repeats sink into the fog
export function createDelay(ctx, bpm = 90) {
  const send = ctx.createGain(); send.gain.value = 0;
  const delay = ctx.createDelay(4);
  const fb = ctx.createGain(); fb.gain.value = 0.45;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
  const wet = ctx.createGain(); wet.gain.value = 1;
  send.connect(delay).connect(lp).connect(wet);
  lp.connect(fb).connect(delay);
  const d = { send, delay, fb, lp, wet, amount: 0, bpm };
  d.setAmount = (a) => { d.amount = Math.max(0, Math.min(1, a)); send.gain.setTargetAtTime(d.amount, ctx.currentTime, 0.02); };
  d.setBpm = (b) => { d.bpm = b; delay.delayTime.setTargetAtTime(Math.min(3.9, (60 / b) * 0.75), ctx.currentTime, 0.05); };
  d.setBpm(bpm);
  return d;
}

// opts: {master: 0..1, bpm, random, rainParams}
export function createChain(ctx, opts = {}) {
  const master = ctx.createGain();
  master.gain.value = opts.master ?? 0.7;
  const mute = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10; limiter.knee.value = 4; limiter.ratio.value = 20;
  limiter.attack.value = 0.003; limiter.release.value = 0.15;
  const delay = createDelay(ctx, opts.bpm || 90);
  master.connect(mute);
  mute.connect(limiter);
  mute.connect(delay.send);
  delay.wet.connect(limiter);
  // safety: a soft clip after the limiter so a dense arp over loops and delay never hard-clips the file or the DAC
  const clip = ctx.createWaveShaper();
  { const n = 2048, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = 0.89 * Math.tanh(x * 1.6) / Math.tanh(1.6); } clip.curve = c; clip.oversample = "2x"; }
  limiter.connect(clip).connect(opts.destination || ctx.destination);
  const saw = new SawEngine(ctx, master, opts.random ? { random: opts.random } : {});
  const rain = new RainEngine(ctx, master, { params: { cutoff: 500, ...(opts.rainParams || {}) } });
  const C = { ctx, master, mute, limiter, clip, delay, saw, rain, engine: opts.engine || "saw", played: 0, rand: opts.rand || Math.random };
  C.setMaster = (v) => master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.02);
  C.setMute = (m) => mute.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.01);
  C.allOff = () => { saw.allOff(); rain.allOff(); };
  // ev: a garden event {plant, note, freq, dur, arp?, layer?}; bpm for the saw rate; when: ctx time
  C.playNote = (ev, bpm, when) => {
    const useRain = C.engine === "rain" || (C.engine === "both" && (ev.plant === 2 || ev.layer));
    if (ev.arp) {
      // the arpeggiator plays short saw notes: faster saw rate, fixed short envelope via rate
      // id offset so an arp note never steals a plant voice of the same pitch; envelope scaled to the step
      saw.noteOn(1000 + ev.note, ev.freq, Math.max(1.5, (bpm / 90) * 2.5), when, Math.max(0.12, Math.min(1, (ev.dur * 60 / bpm) / 1.2)), 0.45);
    } else if (useRain) {
      rain.set("release", 2 + Math.floor(C.rand() * 7));
      rain.set("pan", C.rand());
      rain.set("gain", Math.min(1, 0.3 + C.rand()));
      rain.hz(ev.freq / 2, when);
    } else {
      saw.noteOn(ev.layer ? 2000 + ev.plant * 128 + ev.note : ev.note, ev.freq, bpm / 90, when, 1, ev.layer ? 0.7 : 1);
    }
    C.played++;
  };
  return C;
}
