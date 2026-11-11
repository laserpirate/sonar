// garden-offline.js · render the sim garden (garden.js) through the player chain
// (player.js) in an OfflineAudioContext. Browser only. Used by tests and by
// tools/render_garden.mjs for the demo MP3s. A software render, not the norns.
//
// opts: {seed, seconds, sr, bpm, engine, delay, pitch, growth, key: [root, scale],
//        arp: {mode, rate, octaves}, layers: [{seed, atBeat}], instr: [p1, p2],
//        reseedAt: [{beat, seed}], fps, setup, cues: [{bar, setup}]}
// cues load their setup at the bar (no morph glide offline; the render keeps its first bpm)   setup: a Garden setup, loaded first; its bpm and delays win
import { Garden } from "./garden.js";
import { createChain } from "./player.js";
import { makeRandom } from "./lsys.js";

export async function renderGarden(catalog, opts = {}) {
  const seconds = opts.seconds || 60, sr = opts.sr || 48000, bpm = opts.setup?.bpm || opts.bpm || 90, fps = opts.fps || 60;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  const G = new Garden({ catalog, seed: opts.seed ?? 1, instr: opts.instr, bpm });
  if (opts.setup) G.fromSetup(opts.setup, 0);
  const delays = opts.setup ? G.delays : { saw: { amount: opts.delay || 0, ...(opts.delays?.saw || {}) }, rain: { amount: opts.delay || 0, ...(opts.delays?.rain || {}) } };
  const C = createChain(ctx, { master: opts.master ?? 0.7, bpm, random: makeRandom(0x5a3), rand: makeRandom(0x77), delays, countSpans: true });
  if (opts.engine) G.setEngineMode(opts.engine);
  if (opts.routes) for (const [id, v] of Object.entries(opts.routes)) G.setRoute(Number(id), v);
  if (opts.layerRoute) G.setLayerRoute(opts.layerRoute);
  if (opts.arps) for (const [e, o] of Object.entries(opts.arps)) G.setArp(o, e);
  if (opts.flourish) G.setFlourish(opts.flourish);
  if (opts.forest) G.setForest(opts.forest);
  if (opts.roots) for (const [id, o] of Object.entries(opts.roots)) G.setRoots(Number(id), o);
  if (opts.bass) G.setBass(opts.bass);
  if (opts.voices) for (const [id, o] of Object.entries(opts.voices)) for (const [k, v] of Object.entries(o)) G.setVoiceParam(id, k, v);
  if (opts.fx) G.setFx(opts.fx);
  if (opts.mix) for (const [id, o] of Object.entries(opts.mix)) G.setMixVoice(id, o);
  if (opts.plantOpts) for (const [id, o] of Object.entries(opts.plantOpts)) G.setPlantOpt(Number(id), o);
  // samples: [{id, sr, channels: [Float32Array]}]
  for (const x of opts.samples || []) {
    const b = ctx.createBuffer(x.channels.length, x.channels[0].length, x.sr);
    x.channels.forEach((d, c) => b.copyToChannel(d, c));
    C.setSample(x.id, b); G.addSampleRef(x.id, x.name || x.id);
  }
  if (!opts.setup) for (const [id, o] of Object.entries(delays)) G.setDelay(id, o);
  if (opts.voiceDelays) for (const [id, o] of Object.entries(opts.voiceDelays)) G.setDelay(id, o);
  C.setBass(G.bass); C.setVoices(G.voiceParams); C.setMix(G.mix); C.setFx(G.fx); C.setDelays(G.delays);
  let droneAt = -1;
  if (opts.pitch) G.setPitch(opts.pitch);
  if (opts.growth) G.setGrowth(opts.growth);
  if (opts.key) G.setKey(opts.key[0], opts.key[1]);
  if (opts.arp) G.setArp(opts.arp);
  const layers = (opts.layers || []).slice().sort((a, b) => a.atBeat - b.atBeat);
  const reseeds = (opts.reseedAt || []).slice().sort((a, b) => a.beat - b.beat);
  const cues = (opts.cues || []).map((c) => ({ beat: c.bar * 4, setup: c.setup })).sort((a, b) => a.beat - b.beat);
  const bps = bpm / 60;
  const log = [];
  let frame = 0;
  const dt = 1 / fps;
  // drive the garden to audio time `until` (seconds), scheduling notes at their beat time
  const drive = (until) => {
    while ((frame + 1) * dt <= until + 1e-9) {
      frame++;
      const now = frame * dt * bps;
      while (layers.length && layers[0].atBeat <= now) { const L = layers.shift(); G.addLayer(L.seed, now); log.push({ k: "layer", t: now, seed: L.seed }); }
      while (reseeds.length && reseeds[0].beat <= now) { const r = reseeds.shift(); G.seed(r.seed); log.push({ k: "reseed", t: now, seed: r.seed }); }
      while (cues.length && cues[0].beat <= now) {
        const c = cues.shift(); G.fromSetup(c.setup, c.beat); G.bpm = bpm;
        C.setBass(G.bass); C.setVoices(G.voiceParams); C.setMix(G.mix); C.setFx(G.fx); C.setDelays(G.delays);
        log.push({ k: "cue", t: c.beat });
      }
      for (const ev of G.step(now)) {
        const when = ev.t / bps;
        if (!ev.silent) C.playNote(ev, bpm, Math.max(when, frame * dt));
        log.push({ k: ev.arp ? "arp" : ev.flourish ? "flourish" : ev.bass ? "bass" : ev.chorus ? "chorus" : ev.layer ? "loop" : "note", t: ev.t, note: ev.note, plant: ev.plant, engine: ev.engine, silent: !!ev.silent });
      }
      const hz = G.droneHz();
      if (hz !== droneAt) { droneAt = hz; C.setDrone(hz, G.bass.drone); }
    }
  };
  for (let s = 1; s < seconds; s++) ctx.suspend(s).then(() => { drive(s + 1); ctx.resume(); });
  drive(1);
  const buf = await ctx.startRendering();
  return { buf, log, state: G.state(), spans: C.spans };
}

export { levels, pcm16base64 } from "./score-offline.js";
