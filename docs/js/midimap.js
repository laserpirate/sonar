// midimap.js · MIDI bindings per AV-STANDARD v02: learn, soft takeover, momentary, toggle, hold to fire,
// conflicts. Pure: no DOM, no Web MIDI. The page hands it `resolve(act)` which returns a target:
//   {kind: "range", lo, hi, step, get, set} | {kind: "select", options, get, set}
//   {kind: "toggle", get, set} | {kind: "act", fire}
// A binding is {act, type: "cc" | "note", ch: 0..15 or -1 (any), num, mode, hold_ms, smooth, curve}.
//   cc modes:   abs (soft takeover), rel (two's complement), trig (crossing the middle upward), hold
//   note modes: trig (note on), toggle, momentary (on / off follow the key), hold (fires after hold_ms)

export const MODES = { cc: ["abs", "rel", "trig", "hold"], note: ["trig", "toggle", "momentary", "hold"] };
export const CURVES = ["lin", "sqrt", "exp"];
export const GATES = ["blackout", "panic"]; // never wait in a queue (AV-STANDARD rule 3)
// v0.2.0's map, the default when nothing is stored; the same as data/midi-maps/sonar_v020-notes_v01.json
export const DEFAULT_V020 = [
  { act: "play", type: "note", ch: -1, num: 36, mode: "trig" }, { act: "nextGen", type: "note", ch: -1, num: 37, mode: "trig" },
  { act: "reseed", type: "note", ch: -1, num: 38, mode: "trig" }, { act: "blackout", type: "note", ch: -1, num: 41, mode: "toggle" },
  { act: "panic", type: "note", ch: -1, num: 42, mode: "toggle" }, { act: "bpm", type: "cc", ch: -1, num: 1, mode: "abs" },
  { act: "angle", type: "cc", ch: -1, num: 4, mode: "abs" }, { act: "r-master", type: "cc", ch: -1, num: 7, mode: "abs" },
];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const curveOf = (c, x) => (c === "sqrt" ? Math.sqrt(x) : c === "exp" ? (Math.exp(4 * x) - 1) / (Math.exp(4) - 1) : x);

export function cleanBinding(b) {
  if (!b || typeof b !== "object" || typeof b.act !== "string" || !b.act || b.act.length > 60) return null;
  const type = b.type === "note" ? "note" : b.type === "cc" ? "cc" : null;
  if (!type) return null;
  const num = Math.round(Number(b.num));
  if (!(num >= 0 && num <= 127)) return null;
  const ch = Number.isInteger(b.ch) && b.ch >= -1 && b.ch <= 15 ? b.ch : -1;
  const mode = MODES[type].includes(b.mode) ? b.mode : MODES[type][0];
  return { act: b.act, type, ch, num, mode, hold_ms: Math.round(clamp(Number(b.hold_ms) || 0, 0, 5000)), smooth: clamp(Number(b.smooth) || 0, 0, 0.95), curve: CURVES.includes(b.curve) ? b.curve : "lin" };
}
export function cleanMap(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 512).map(cleanBinding).filter(Boolean);
}
export const describe = (b) => `${b.type} ${b.num}${b.ch >= 0 ? " ch" + (b.ch + 1) : ""} ${b.mode}${b.mode === "hold" ? " " + b.hold_ms + " ms" : ""}`;
const keyOf = (type, ch, num) => `${type}:${ch}:${num}`;

export function createMapper({ resolve, now = () => performance.now() }) {
  const M = { bindings: [], learning: null, learned: 0, fired: 0, errors: 0, last: null };
  const st = new Map(); // binding -> {picked, prev, target, cur, armedAt, on}
  const S = (b) => { let s = st.get(b); if (!s) st.set(b, (s = { picked: false, prev: null, target: null, armedAt: null, on: false })); return s; };
  const matches = (b, type, ch, num) => b.type === type && b.num === num && (b.ch < 0 || b.ch === ch);

  M.load = (list) => { M.bindings = cleanMap(list); st.clear(); return M; };
  M.toJSON = () => M.bindings.map((b) => ({ ...b }));
  M.bindingOf = (act) => M.bindings.find((b) => b.act === act) || null;
  M.clear = (act) => { M.bindings = M.bindings.filter((b) => b.act !== act); };
  M.clearAll = () => { M.bindings = []; st.clear(); };
  M.learn = (act) => { M.learning = act || null; };
  // a setup or a jump elsewhere moved the values: every knob picks up again
  M.resetPickup = () => { for (const s of st.values()) { s.picked = false; s.prev = null; } };
  // one message bound to more than one act
  M.conflicts = () => {
    const by = new Map();
    for (const b of M.bindings) { const k = keyOf(b.type, b.ch, b.num); if (!by.has(k)) by.set(k, []); by.get(k).push(b.act); }
    // a channel-less binding collides with every channel of the same number
    for (const b of M.bindings) if (b.ch < 0) for (const [k, acts] of by) { const [t, c, n] = k.split(":"); if (t === b.type && Number(n) === b.num && Number(c) >= 0 && !acts.includes(b.act)) acts.push(b.act); }
    return [...by.entries()].filter(([, a]) => a.length > 1).map(([k, acts]) => ({ key: k, acts }));
  };
  const parse = (d) => {
    const s = d[0] & 0xf0, ch = d[0] & 0x0f;
    if (s === 0xb0) return { type: "cc", ch, num: d[1], v: d[2] ?? 0 };
    if (s === 0x90) return { type: "note", ch, num: d[1], v: d[2] ?? 0, on: (d[2] ?? 0) > 0 };
    if (s === 0x80) return { type: "note", ch, num: d[1], v: 0, on: false };
    return null;
  };
  // is this message bound to blackout or panic? Then the caller applies it at once
  M.isGate = (d) => { const m = parse(d); return !!m && M.bindings.some((b) => GATES.includes(b.act) && matches(b, m.type, m.ch, m.num)); };
  M.gateOnly = false; // set while blacked out: only the gates act

  function defaultMode(act, type) {
    const t = resolve(act);
    if (act === "panic") return { mode: "hold", hold_ms: 1000 };
    if (type === "cc") return { mode: t && (t.kind === "range" || t.kind === "select") ? "abs" : "trig" };
    return { mode: t && t.kind === "toggle" ? "toggle" : "trig" };
  }
  function learnFrom(m) {
    if (m.type === "note" && !m.on) return false; // bind on the press, not the release
    const act = M.learning;
    M.learning = null;
    M.clear(act);
    const b = cleanBinding({ act, type: m.type, ch: m.ch, num: m.num, ...defaultMode(act, m.type) });
    M.bindings.push(b);
    if (b.type === "cc") { const s = S(b); s.prev = m.v; }
    M.learned++;
    return true;
  }
  const fire = (t, b, v) => {
    if (t.kind === "act") t.fire();
    else if (t.kind === "toggle") t.set(v === undefined ? !t.get() : v);
    else if (t.kind === "range") t.set(v === undefined ? (t.get() >= (t.lo + t.hi) / 2 ? t.lo : t.hi) : v);
    else if (t.kind === "select") { const i = t.options.indexOf(t.get()); t.set(t.options[(i + 1) % t.options.length]); }
    M.fired++;
  };
  // soft takeover sees every raw CC (cheap), while the caller coalesces the flood and applies only the last
  M.pickup = (d) => {
    try {
      const m = parse(d);
      if (!m || m.type !== "cc" || M.learning) return;
      for (const b of M.bindings) if (b.mode === "abs" && matches(b, "cc", m.ch, m.num)) { const t = resolve(b.act); if (t && t.kind !== "toggle") absolute(b, t, m, true); }
    } catch (e) { M.errors++; }
  };
  function absolute(b, t, m, only) {
    const s = S(b), x = m.v / 127;
    if (t.kind === "toggle") { if (s.prev === null || (s.prev < 64) !== (m.v < 64)) t.set(m.v >= 64); s.prev = m.v; return; }
    let target, cur, tol;
    if (t.kind === "select") { const n = t.options.length; target = Math.min(n - 1, Math.floor(x * n)); cur = t.options.indexOf(t.get()); tol = 0; }
    else { target = t.lo + curveOf(b.curve, x) * (t.hi - t.lo); cur = t.get(); tol = (t.hi - t.lo) * 0.04; }
    if (!s.picked) {
      const prevT = s.prev === null ? null : t.kind === "select" ? Math.min(t.options.length - 1, Math.floor((s.prev / 127) * t.options.length)) : t.lo + curveOf(b.curve, s.prev / 127) * (t.hi - t.lo);
      if (Math.abs(target - cur) <= tol || (prevT !== null && (prevT - cur) * (target - cur) <= 0)) s.picked = true;
    }
    s.prev = m.v;
    if (!s.picked || only) return;
    if (t.kind === "select") { if (target !== cur) { t.set(t.options[target]); M.fired++; } return; }
    if (b.smooth > 0) { s.target = target; return; } // the tick glides toward it
    t.set(t.step ? Math.round(target / t.step) * t.step : target); M.fired++;
  }
  function apply(b, m) {
    const t = resolve(b.act);
    if (!t) return;
    if (M.gateOnly && !GATES.includes(b.act)) return;
    const s = S(b);
    if (b.type === "cc") {
      if (b.mode === "abs") return absolute(b, t, m);
      if (b.mode === "rel") {
        if (t.kind !== "range") { if (m.v !== 0) fire(t, b); return; }
        const d = m.v >= 64 ? m.v - 128 : m.v, step = Math.max(t.step || 0, (t.hi - t.lo) / 128);
        t.set(clamp(t.get() + d * step, t.lo, t.hi)); M.fired++; return;
      }
      const up = m.v >= 64, was = s.on; s.on = up;
      if (b.mode === "trig") { if (up && !was) fire(t, b); return; }
      if (b.mode === "hold") { s.armedAt = up && !was ? now() : up ? s.armedAt : null; return; }
      return;
    }
    // notes
    if (b.mode === "trig") { if (m.on) fire(t, b); return; }
    if (b.mode === "toggle") { if (m.on) fire(t, b); return; }
    if (b.mode === "momentary") { if (t.kind === "act") { if (m.on) fire(t, b); } else fire(t, b, t.kind === "range" ? (m.on ? t.hi : t.lo) : m.on); return; }
    if (b.mode === "hold") { s.armedAt = m.on ? now() : null; return; }
  }
  // returns true when the message was used
  M.handle = (d) => {
    try {
      const m = parse(d);
      if (!m) return false;
      M.last = m;
      if (M.learning) return learnFrom(m);
      let used = false;
      for (const b of M.bindings) if (matches(b, m.type, m.ch, m.num)) { apply(b, m); used = true; }
      return used;
    } catch (e) { M.errors++; return false; }
  };
  // every few ms: holds that have waited long enough fire, smoothed knobs glide
  M.tick = () => {
    const t0 = now();
    for (const b of M.bindings) {
      const s = st.get(b);
      if (!s) continue;
      try {
        if (s.armedAt !== null && t0 - s.armedAt >= b.hold_ms) {
          s.armedAt = null;
          const t = resolve(b.act);
          if (t && (!M.gateOnly || GATES.includes(b.act))) fire(t, b);
        }
        if (s.target !== null && b.smooth > 0) {
          const t = resolve(b.act);
          if (!t || t.kind !== "range" || (M.gateOnly && !GATES.includes(b.act))) { s.target = null; continue; }
          const cur = t.get(), nx = cur + (s.target - cur) * (1 - b.smooth);
          const done = Math.abs(s.target - nx) <= (t.step || (t.hi - t.lo) / 1000) / 2;
          const r = (x) => (t.step ? Math.round(x / t.step) * t.step : x);
          // a glide smaller than one step would never arrive: land on the target
          if (done || r(nx) === cur) { t.set(r(s.target)); s.target = null; } else t.set(r(nx));
        }
      } catch (e) { M.errors++; }
    }
  };
  return M;
}
