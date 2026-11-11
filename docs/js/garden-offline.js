// garden-offline.js · render the sim garden (garden.js) through the player chain
// (player.js) in an OfflineAudioContext. Browser only. Used by tests and by
// tools/render_garden.mjs for the demo MP3s. A software render, not the norns.
//
// opts: {seed, seconds, sr, bpm, engine, delay, pitch, growth, key: [root, scale],
//        arp: {mode, rate, octaves}, layers: [{seed, atBeat}], instr: [p1, p2],
//        reseedAt: [{beat, seed}], fps, setup}   setup: a Garden setup, loaded first; its bpm and delays win
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
  C.setBass(G.bass);
  let droneAt = -1;
  if (opts.pitch) G.setPitch(opts.pitch);
  if (opts.growth) G.setGrowth(opts.growth);
  if (opts.key) G.setKey(opts.key[0], opts.key[1]);
  if (opts.arp) G.setArp(opts.arp);
  const layers = (opts.layers || []).slice().sort((a, b) => a.atBeat - b.atBeat);
  const reseeds = (opts.reseedAt || []).slice().sort((a, b) => a.beat - b.beat);
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
