// audio.js · loaded by the Enable click only. AudioContext, the player chain
// (player.js: master, mute, tempo-synced delay, limiter, the two engine ports),
// output meter, MIDI. Sim notes play the engines; live notes are silent unless
// ?liveaudio=1 (the norns is making the sound).
import { createChain } from "./player.js";
import { initMidi } from "./midi.js";

export async function enable({ S, on, act }) {
  const q = new URLSearchParams(location.search);
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  await ctx.resume();
  const C = createChain(ctx, { master: S.master ?? 0.7, bpm: S.bpm, engine: q.get("engine") || "saw" });
  C.delay.setAmount(S.delay ?? 0);
  const A = { ctx, chain: C, saw: C.saw, rain: C.rain, master: C.master, get engine() { return C.engine; }, set engine(v) { C.engine = v; }, get played() { return C.played; } };
  S.audio = A;

  const setMaster = (v) => { S.master = Math.max(0, Math.min(1, v)); C.setMaster(S.master); const r = document.getElementById("r-master"); if (r) r.value = S.master; };
  const getMaster = () => S.master;
  const muted = () => S.blackoutOn || S.panic;
  window.sonarBlackout.hook((v) => { C.setMute(v || S.panic); if (v) C.allOff(); });
  on("state", () => {
    C.setMute(muted());
    C.setMaster(S.master);
    C.delay.setAmount(S.delay ?? 0);
    C.delay.setBpm(S.bpm);
    if (S.panic) C.allOff();
  });

  const liveAudio = q.get("liveaudio") === "1";
  on("note", (n) => {
    if (muted()) return;
    if (S.source.startsWith("live") && !liveAudio) return;
    C.playNote(n, S.bpm, ctx.currentTime + 0.02);
  });

  // enable blip: one short note on the root, so a working output is audible at once
  C.saw.noteOn(999, 220, 1, ctx.currentTime + 0.05, 0.3);

  // resume on return: mobile browsers suspend the context when the tab goes to the back
  const resume = () => { if (ctx.state !== "running") ctx.resume().catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
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

  // engine toggle in the controls bar
  const hud = document.getElementById("hud");
  const b = document.createElement("button");
  b.id = "b-engine"; b.title = "E"; b.textContent = C.engine;
  const cycle = () => { C.engine = { saw: "rain", rain: "both", both: "saw" }[C.engine] || "saw"; b.textContent = C.engine; };
  b.onclick = cycle;
  hud.insertBefore(b, document.getElementById("b-enable"));
  window.addEventListener("keydown", (e) => { if ((e.key === "e" || e.key === "E") && !e.repeat && !e.ctrlKey && !e.metaKey) cycle(); });

  await initMidi({ S, act, setMaster, getMaster });
  return A;
}
