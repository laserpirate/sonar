// bus.js · the sonar bus, sender side. Stands alone: a BroadcastChannel and a message format, no code
// from flora or any other project, so a copy can live in any repo under that repo's own terms.
//
// Channel "sonar-bus" (one origin reaches every tab on the machine). With a bridge link (?ws=) the same
// messages also go out as {path: "/sonarbus/<t>", args} so a second machine or TouchDesigner gets them.
// Absolute state, last write wins. Off until on = true.
//   {t:"note", voice, plant, note, freq, vel, lead}
//   {t:"beat", beat, bar, bpm}
//   {t:"gen", plant, gen, max}
//   {t:"level", rms, peak, bands:[low, mid, high]}        0..1, about 30 a second
//   {t:"state", key, density, forest, setup}
//   {t:"macro", name, value}
// Every message also carries src: "sonar" and at: performance.timeOrigin + performance.now() (ms).

export const BUS_CHANNEL = "sonar-bus";
export const BUS_TYPES = ["note", "beat", "gen", "level", "state", "macro"];
// OSC-shaped args, the order sonar-in.js reads back
export const BUS_ARGS = {
  note: (m) => [m.voice, m.plant, m.note, m.freq, m.vel, m.lead ? 1 : 0],
  beat: (m) => [m.beat, m.bar, m.bpm],
  gen: (m) => [m.plant, m.gen, m.max],
  level: (m) => [m.rms, m.peak, ...m.bands],
  state: (m) => [m.key, m.density, m.forest, m.setup],
  macro: (m) => [m.name, m.value],
};

export function createBus({ link = null } = {}) {
  const ch = typeof BroadcastChannel === "function" ? new BroadcastChannel(BUS_CHANNEL) : null;
  const B = { on: false, sent: Object.fromEntries(BUS_TYPES.map((t) => [t, 0])), errors: 0, channel: !!ch, link };
  const listeners = [];
  B.post = (m) => {
    if (!B.on || !BUS_ARGS[m.t]) return;
    m.src = "sonar"; m.at = performance.timeOrigin + performance.now();
    try { if (ch) ch.postMessage(m); } catch { B.errors++; }
    try { if (B.link && B.link.connected) B.link.send("/sonarbus/" + m.t, BUS_ARGS[m.t](m)); } catch { B.errors++; }
    B.sent[m.t]++;
  };
  B.note = (voice, plant, note, freq, vel, lead) => B.post({ t: "note", voice, plant, note, freq, vel, lead: !!lead });
  B.beat = (beat, bar, bpm) => B.post({ t: "beat", beat, bar, bpm });
  B.gen = (plant, gen, max) => B.post({ t: "gen", plant, gen, max });
  B.level = (rms, peak, bands) => B.post({ t: "level", rms, peak, bands });
  B.state = (key, density, forest, setup) => B.post({ t: "state", key, density, forest, setup });
  B.macro = (name, value) => B.post({ t: "macro", name, value });
  // what other pages put on the channel (not sonar's own): handed to the page's listeners
  B.onIn = (f) => listeners.push(f);
  if (ch) ch.onmessage = (e) => { const m = e.data; if (!m || m.src === "sonar") return; for (const f of listeners) { try { f(m); } catch { B.errors++; } } };
  B.close = () => { try { ch?.close(); } catch {} };
  return B;
}
