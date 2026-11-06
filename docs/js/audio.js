// audio.js · loaded by the Enable click only. AudioContext, master chain,
// the two engine ports, MIDI. Sim notes play the engines; live notes are
// silent unless ?liveaudio=1 (the norns is making the sound).
import { SawEngine } from "./engine-saw.js";
import { RainEngine } from "./engine-rain.js";
import { initMidi } from "./midi.js";

export async function enable({ S, on, act }) {
  const q = new URLSearchParams(location.search);
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  await ctx.resume();
  const master = ctx.createGain();
  master.gain.value = S.master ?? 0.7;
  const mute = ctx.createGain(); // blackout and panic
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 12;
  limiter.attack.value = 0.003; limiter.release.value = 0.15;
  master.connect(mute).connect(limiter).connect(ctx.destination);
  const saw = new SawEngine(ctx, master);
  const rain = new RainEngine(ctx, master, { params: { cutoff: 500 } });
  const A = { ctx, saw, rain, master, engine: q.get("engine") || "saw", played: 0 };
  S.audio = A;

  const setMaster = (v) => { S.master = Math.max(0, Math.min(1, v)); master.gain.setTargetAtTime(S.master, ctx.currentTime, 0.02); const r = document.getElementById("r-master"); if (r) r.value = S.master; };
  const getMaster = () => S.master;
  const muted = () => S.blackoutOn || S.panic;
  window.sonarBlackout.hook((v) => { mute.gain.setTargetAtTime(v || S.panic ? 0 : 1, ctx.currentTime, 0.01); if (v) { saw.allOff(); } });
  on("state", () => {
    mute.gain.setTargetAtTime(muted() ? 0 : 1, ctx.currentTime, 0.01);
    master.gain.setTargetAtTime(S.master, ctx.currentTime, 0.02);
  });

  // flora: random_note_frequency = nf1 (1/1) x bpm / (60 x tempo_scalar_offset 1.5)
  const sawRate = () => S.bpm / 90;
  const liveAudio = q.get("liveaudio") === "1";
  on("note", (n) => {
    if (muted()) return;
    if (S.source.startsWith("live") && !liveAudio) return;
    const when = ctx.currentTime + 0.02;
    const useRain = A.engine === "rain" || (A.engine === "both" && n.plant === 2);
    if (useRain) {
      // raindrops' random_note: length 2..8, pan 0..1, gain 0.3 + rand clamped
      rain.set("release", 2 + Math.floor(Math.random() * 7));
      rain.set("pan", Math.random());
      rain.set("gain", Math.min(1, 0.3 + Math.random()));
      rain.hz(n.freq / 2, when); // flora's cf scalar doubles; raindrops plays the scale note
    } else {
      saw.noteOn(n.note, n.freq, sawRate(), when);
    }
    A.played++;
  });

  // engine toggle in the controls bar
  const hud = document.getElementById("hud");
  const b = document.createElement("button");
  b.id = "b-engine"; b.title = "E"; b.textContent = A.engine;
  const cycle = () => { A.engine = { saw: "rain", rain: "both", both: "saw" }[A.engine] || "saw"; b.textContent = A.engine; };
  b.onclick = cycle;
  hud.insertBefore(b, document.getElementById("b-enable"));
  window.addEventListener("keydown", (e) => { if ((e.key === "e" || e.key === "E") && !e.repeat && !e.ctrlKey && !e.metaKey) cycle(); });

  await initMidi({ S, act, setMaster, getMaster });
  return A;
}
