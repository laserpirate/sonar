// score-page.js · ?score=1 on the sonar page: the score runs a synthetic scene (score-sim.js) so it
// can be heard and tested with no shanshui-av or kc page. ?kind=kodama runs the kodama cycle.
// Silent until Enable (AV-STANDARD rule 2). Keys: Space play / stop, R reseed, Esc hold panic,
// B blackout (index.html). The strip shows score.state().
import { Score, createEngines } from "./score.js";
import { ShanshuiSim, KodamaSim } from "./score-sim.js";

export function init({ S, act, q, on }) {
  const kind = q.get("kind") === "kodama" ? "kodama" : "shanshui";
  const seed0 = q.get("seed") || String(Date.now());
  const score = new Score();
  score.seed(seed0);
  const mkSim = () => (kind === "kodama" ? new KodamaSim() : new ShanshuiSim());
  let sim = mkSim();
  S.score = score;
  window.__score = score;   // read by the Playwright tests

  // the page's own garden shows the score's plant (both halves, the score's generation)
  const show = () => { const st = score.state(); const n = Number(st.plant.slice(1)); act.setup(0, n, st.gen); act.setup(1, n, st.gen); };
  act.play(false);          // the page's own sim stays silent and still; the score plays
  show();
  let shown = "";

  // strip: one row of facts
  const hud = document.getElementById("strip");
  const strip = document.createElement("span");
  strip.className = "fact"; strip.id = "f-score";
  hud.insertBefore(strip, hud.querySelector(".spacer"));
  for (const id of ["f-p1", "f-p2", "f-note", "f-bpm"]) { const el = document.getElementById(id); if (el) el.style.display = "none"; }
  const render = () => {
    const st = score.state();
    strip.innerHTML = `score <b>${st.playing ? "on" : "off"}</b> · seed <b>${st.seed}</b> · <b>${st.plant}</b> · gen <b>${st.gen}</b> · bpm <b>${st.bpm}</b>`
      + (kind === "kodama" && st.phase ? ` · phase <b>${["", "W", "S", "D"][st.phase]}</b>` : "");
    document.getElementById("b-play").classList.toggle("on", st.playing);
    const key = st.plant + ":" + st.gen;
    if (key !== shown) { shown = key; show(); }
  };

  let last = performance.now();
  const tick = (now) => {
    requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (S.panic || !score.playing) return;
    const sc = sim.step(dt);
    delete sc.t;              // the score's clock: AudioContext time after Enable, else dt
    sc.dt = dt;
    score.scene(sc);
  };
  requestAnimationFrame(tick);
  setInterval(render, 200);

  const toggle = () => { if (score.playing) score.stop(); else score.play(); render(); };
  const reseed = () => { score.seed(String(Date.now())); sim = mkSim(); render(); };
  document.getElementById("b-play").onclick = toggle;

  // Enable: audio for the score only (the page's audio.js is not loaded in score mode)
  const en = document.getElementById("b-enable");
  en.onclick = async () => {
    en.disabled = true;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
      await ctx.resume();
      const engines = createEngines(ctx);
      const mute = ctx.createGain();
      engines.limiter.disconnect(); engines.limiter.connect(mute).connect(ctx.destination);
      const apply = () => mute.gain.setTargetAtTime(S.blackoutOn || S.panic ? 0 : (S.master ?? 0.7) / 0.7, ctx.currentTime, 0.01);
      window.sonarBlackout.hook(() => apply());
      document.getElementById("r-master").addEventListener("input", apply);
      score.attach(engines);
      S.scoreAudio = engines;
      apply();
      en.classList.add("on"); en.textContent = "enabled";
    } catch (e) { console.warn("score enable", e); en.textContent = "enable failed"; }
    en.disabled = false;
  };

  // keys, called by app.js before its own map; true = handled
  S.scoreKey = (k) => {
    if (k === " ") { toggle(); return true; }
    if (k === "r" || k === "R") { reseed(); return true; }
    return false;
  };
  // panic (Esc hold) silences the score; Space resumes it
  let wasPanic = false;
  on("state", () => { if (S.panic && !wasPanic) { score.panic(); render(); } wasPanic = S.panic; });
  score.play();
  render();
  return score;
}
