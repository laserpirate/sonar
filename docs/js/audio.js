// audio.js · loaded by the Enable click only. AudioContext, the player chain
// (player.js: master, mute, tempo-synced delay, limiter, the two engine ports),
// output meter, MIDI. Sim notes play the engines; live notes are silent unless
// ?liveaudio=1 (the norns is making the sound).
import { createChain } from "./player.js";
import { initMidi } from "./midi.js";

export async function enable({ S, on, act }) {
  const q = new URLSearchParams(location.search);
  // iOS: "playback" keeps Web Audio sounding with the mute switch on; set before the context starts
  S.audioSession = "absent";
  try { if (navigator.audioSession) { navigator.audioSession.type = "playback"; S.audioSession = navigator.audioSession.type; } } catch (e) { S.audioSession = "refused"; }
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  await ctx.resume();
  const G = act.garden();
  const C = createChain(ctx, { master: S.master ?? 0.7, bpm: S.bpm, delays: G.delays });
  if (q.get("engine")) G.setEngineMode(q.get("engine"));
  const A = { ctx, chain: C, saw: C.saw, rain: C.rain, master: C.master, get engine() { return G.engineMode; }, set engine(v) { G.setEngineMode(v); }, get played() { return C.played; } };
  S.audio = A;

  const muted = () => S.blackoutOn || S.panic || S.kill; // kill: a latching silence; the garden keeps drawing
  window.sonarBlackout.hook((v) => { C.setMute(v || S.panic || S.kill); if (v) C.allOff(); });
  C.setVoices(G.voiceParams); C.setMix(G.mix); C.setFx(G.fx);
  on("state", () => {
    C.setMute(muted());
    C.setMaster(S.master);
    C.setDelays(G.delays);
    C.setBpm(S.bpm);
    C.setBass(G.bass);
    C.setDrone(muted() ? 0 : G.droneHz(), G.bass.drone);
    C.setVoices(G.voiceParams); C.setMix(G.mix); C.setFx(G.fx);
    if (S.panic || S.kill) C.allOff();
  });

  const liveAudio = q.get("liveaudio") === "1";
  on("note", (n) => {
    if (muted() || n.silent) return;
    if (S.source.startsWith("live") && !liveAudio) return;
    const r = C.playNote(n, S.bpm, ctx.currentTime + 0.02);
    if (S.midi?.noteOut) S.midi.noteOut(n, r.voice, r.len || 0.25);
  });

  // enable blip: one short note on the root, so a working output is audible at once
  C.saw.noteOn(999, 220, 1, ctx.currentTime + 0.05, 0.3);

  // resume on return: mobile browsers suspend the context when the tab goes to the back
  const resume = () => { if (ctx.state !== "running") ctx.resume().catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  window.addEventListener("pageshow", resume);
  window.addEventListener("pointerdown", resume, true);
  window.addEventListener("keydown", resume, true);

  // output meter: peak at the limiter output, 4 times a second, into the strip
  const an = ctx.createAnalyser(); an.fftSize = 1024;
  C.clip.connect(an);
  const buf = new Float32Array(an.fftSize);
  let silentSince = ctx.currentTime;
  S.outDb = -200;
  const meter = () => {
    an.getFloatTimeDomainData(buf);
    let peak = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    const db = peak > 0 ? 20 * Math.log10(peak) : -200;
    S.outDb = db;
    if (db > -60) silentSince = ctx.currentTime;
    S.outSilent = ctx.currentTime - silentSince > 2 && S.playing && !muted();
    S.ctxState = ctx.state;
  };
  setInterval(meter, 250);

  document.getElementById("b-engine").textContent = G.engineMode;

  await initMidi({ S, act, mapper: act.midiMapper() });
  return A;
}
