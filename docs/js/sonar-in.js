// sonar-in.js · receiver for the sonar bus. Stands alone: no code from flora or any other project, no
// imports, so it can be copied into any page or repo. Listens on BroadcastChannel "sonar-bus" (same
// origin, same machine), or on a bridge WebSocket ({path: "/sonarbus/<t>", args}) when ws is given.
//
//   import { sonarIn } from "https://laserpirate.github.io/sonar/js/sonar-in.js";
//   sonarIn.on("note", (m) => flash(m.note));      // note, beat, gen, level, state, macro, rest
//   draw(() => sonarIn.level);                        // smoothed 0..1; also low, mid, high, pulse
//
// Values ease toward each new reading (attack fast, release slow). When nothing arrives for `stale` ms
// (sonar stopped, the tab closed) everything returns to rest: levels and pulse to 0, live false, a
// "rest" event fires once.

const ARGS = {
  note: (a) => ({ voice: a[0], plant: a[1], note: a[2], freq: a[3], vel: a[4], lead: !!a[5] }),
  beat: (a) => ({ beat: a[0], bar: a[1], bpm: a[2] }),
  gen: (a) => ({ plant: a[0], gen: a[1], max: a[2] }),
  level: (a) => ({ rms: a[0], peak: a[1], bands: [a[2], a[3], a[4]] }),
  state: (a) => ({ key: a[0], density: a[1], forest: a[2], setup: a[3] }),
  macro: (a) => ({ name: a[0], value: a[1] }),
};

export function createSonarIn({ channel = "sonar-bus", ws = null, stale = 2000, attack = 0.5, release = 0.08 } = {}) {
  const R = {
    live: false, level: 0, peak: 0, low: 0, mid: 0, high: 0, pulse: 0, beat: 0, bar: 0, bpm: 0,
    note: 0, freq: 0, lead: false, state: null, macros: {}, counts: { note: 0, beat: 0, gen: 0, level: 0, state: 0, macro: 0 },
  };
  const target = { level: 0, peak: 0, low: 0, mid: 0, high: 0 };
  const listeners = {};
  let last = 0;
  const fire = (t, m) => { for (const f of listeners[t] || []) { try { f(m); } catch (e) { console.warn("sonar-in", t, e); } } };
  function take(m) {
    if (!m || !ARGS[m.t]) return;
    last = performance.now(); R.live = true; R.counts[m.t]++;
    if (m.t === "note") { R.note = m.note; R.freq = m.freq; R.lead = !!m.lead; }
    else if (m.t === "beat") { R.beat = m.beat; R.bar = m.bar; R.bpm = m.bpm; R.pulse = 1; }
    else if (m.t === "level") { target.level = m.rms; target.peak = m.peak; [target.low, target.mid, target.high] = m.bands; }
    else if (m.t === "state") R.state = m;
    else if (m.t === "macro") R.macros[m.name] = m.value;
    fire(m.t, m);
  }
  const ch = typeof BroadcastChannel === "function" ? new BroadcastChannel(channel) : null;
  if (ch) ch.onmessage = (e) => { if (e.data && e.data.src === "sonar") take(e.data); };
  let sock = null;
  if (ws) {
    const open = () => {
      try { sock = new WebSocket(ws); } catch { setTimeout(open, 2000); return; }
      sock.onmessage = (e) => { let j; try { j = JSON.parse(e.data); } catch { return; } const t = typeof j?.path === "string" && j.path.startsWith("/sonarbus/") ? j.path.slice(10) : null; if (t && ARGS[t]) take({ t, ...ARGS[t](j.args || []) }); };
      sock.onclose = () => setTimeout(open, 2000);
    };
    open();
  }
  // ease the levels 30 times a second; rest when stale
  const timer = setInterval(() => {
    if (R.live && performance.now() - last > stale) {
      R.live = false;
      for (const k in target) target[k] = 0;
      fire("rest", {});
    }
    for (const k in target) { const a = target[k] > R[k] ? attack : release; R[k] += (target[k] - R[k]) * a; if (Math.abs(R[k]) < 1e-4) R[k] = 0; }
    R.pulse = R.live ? R.pulse * 0.85 : 0;
  }, 33);
  R.on = (t, f) => { (listeners[t] ||= []).push(f); return R; };
  R.off = (t, f) => { listeners[t] = (listeners[t] || []).filter((g) => g !== f); return R; };
  R.close = () => { clearInterval(timer); try { ch?.close(); } catch {} try { sock?.close(); } catch {} };
  return R;
}

// one shared receiver for the page that imports this file
export const sonarIn = createSonarIn();
