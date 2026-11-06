// score-offline.js · render the score through the WebAudio engine ports in an OfflineAudioContext.
// Browser only (OfflineAudioContext). The sim is driven one second at a time between suspends, the
// way the real clock drives it with a 0.25 s lookahead. Used by tests/score.spec.mjs and
// tools/render_score.mjs. A software render, not the norns.
import { Score, createEngines } from "./score.js";
import { ShanshuiSim, KodamaSim } from "./score-sim.js";
import { MAP } from "./map.js";

// opts: {kind, seed, seconds, sr, fps, panicAt, only: 'drone' | 'notes' | undefined, map: {path: value}}
export async function renderScore(opts = {}) {
  const kind = opts.kind || "shanshui", seconds = opts.seconds || 60, sr = opts.sr || 48000, fps = opts.fps || 30;
  const saved = [];
  for (const [path, v] of Object.entries(opts.map || {})) {
    const ks = path.split("."); let o = MAP; for (const k of ks.slice(0, -1)) o = o[k];
    saved.push([o, ks[ks.length - 1], o[ks[ks.length - 1]]]); o[ks[ks.length - 1]] = v;
  }
  try {
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
    const engines = createEngines(ctx);
    const score = new Score({ engines });
    if (opts.only === "drone") { score._note = () => {}; score._rainNote = () => {}; }
    if (opts.only === "notes") { score._droneStart = () => {}; }
    score.seed(opts.seed ?? 1);
    const sim = kind === "kodama" ? new KodamaSim() : new ShanshuiSim();
    let frame = 0;
    const dt = 1 / fps;
    const drive = (until) => { while ((frame + 1) * dt <= until + 1e-9) { const sc = sim.step(dt); frame++; score.scene(sc); } };
    score.play();
    for (let s = 1; s < seconds; s++) ctx.suspend(s).then(() => { drive(s + 1); ctx.resume(); });
    if (opts.panicAt !== undefined) {
      // panic exactly at panicAt (its own suspend, quantised to 128 frames)
      const q = Math.round((opts.panicAt * sr) / 128) * 128 / sr;
      ctx.suspend(q).then(() => { score.panic(); ctx.resume(); }).catch(() => {});
      opts.panicQ = q;
    }
    drive(1);
    const buf = await ctx.startRendering();
    return { buf, log: score.log, state: score.state(), panicQ: opts.panicQ };
  } finally {
    for (const [o, k, v] of saved) o[k] = v;
  }
}

// rms and peak (dBFS) of a buffer over [t0, t1)
export function levels(buf, t0 = 0, t1 = buf.duration) {
  const sr = buf.sampleRate, i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(buf.length, Math.floor(t1 * sr));
  let peak = 0, sum = 0, n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = i0; i < i1; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
  }
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -200);
  return { peakDb: db(peak), rmsDb: n ? 10 * Math.log10(sum / n + 1e-30) : -200 };
}

// 16-bit interleaved PCM, base64 (for the render tool)
export function pcm16base64(buf) {
  const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) { out[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; out[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767; }
  const bytes = new Uint8Array(out.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
