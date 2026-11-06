// midi.js · Web MIDI in, AV-STANDARD v02 default map. Loaded only after Enable.
//
//   note 36 play/pause · 37 next gen · 38 reset · 41 blackout · 42 panic (toggle)
//   CC 1 BPM 40..160 · CC 4 angle 0..120 deg (active plant) · CC 7 master
//
// Absolute CCs use soft takeover (pickup): a knob acts once it passes the
// current value. The MIDI handler only queues; a 10 ms timer applies the
// queue, capped per tick, inside try/catch, so a flood or a vanished device
// never reaches the keys, the blackout or the draw loop. Learn is later.

export const DEFAULT_MAP = {
  notes: { 36: "play", 37: "nextGen", 38: "reset", 41: "blackout", 42: "panic" },
  cc: { 1: "bpm", 4: "angle", 7: "master" },
};

export async function initMidi({ S, act, setMaster, getMaster }) {
  const state = { access: null, inputs: [], queue: [], cc: new Map(), dropped: 0, handled: 0, errors: 0, devices: [] };
  S.midi = state;
  if (typeof navigator.requestMIDIAccess !== "function") { state.status = "no web midi"; return state; }
  const ranges = {
    bpm: { lo: 40, hi: 160, get: () => S.bpm, set: (v) => act.bpm(v) },
    angle: { lo: 0, hi: 120, get: () => S.angleNow ?? 30, set: (v) => { S.angleNow = v; act.angle(v); } },
    master: { lo: 0, hi: 1, get: () => getMaster(), set: (v) => setMaster(v) },
  };
  const picked = new Map(); // role -> true once the knob met the value
  const latestCC = new Map(); // cc -> [status, cc, value]; a flood of CCs coalesces to the last value
  function onMessage(ev) {
    const d = ev.data;
    if (!d || d.length < 2) return;
    const type = d[0] & 0xf0, role = type === 0x90 && (d[2] ?? 0) > 0 ? DEFAULT_MAP.notes[d[1]] : null;
    // blackout and panic never wait in a queue, so a flood can not drop them
    if (role === "blackout" || role === "panic") {
      try { apply(d[0], d[1], d[2] ?? 0); state.handled++; } catch (e) { state.errors++; }
      return;
    }
    if (type === 0xb0) { try { pickup(d[1], d[2] ?? 0); } catch {} latestCC.set(d[1], [d[0], d[1], d[2] ?? 0]); return; }
    if (state.queue.length > 256) { state.dropped++; return; }
    state.queue.push([d[0], d[1], d[2] ?? 0]);
  }
  function apply(st, d1, d2) {
    const type = st & 0xf0;
    if (type === 0x90 && d2 > 0) {
      const role = DEFAULT_MAP.notes[d1];
      if (!role) return;
      if (S.blackoutOn && role !== "blackout" && role !== "panic") return; // while blacked out only these act
      if (role === "play") act.play();
      else if (role === "nextGen") act.nextGen();
      else if (role === "reset") act.reset();
      else if (role === "blackout") act.blackout();
      else if (role === "panic") act.panic();
    } else if (type === 0xb0) {
      const role = DEFAULT_MAP.cc[d1];
      if (!role || S.blackoutOn) return;
      const r = ranges[role];
      if (picked.get(role)) r.set(r.lo + (d2 / 127) * (r.hi - r.lo));
    }
  }
  // soft takeover, checked on every raw message so coalescing keeps sweeps
  function pickup(d1, d2) {
    const role = DEFAULT_MAP.cc[d1];
    if (!role) return;
    const r = ranges[role];
    if (!picked.get(role)) {
      const target = r.lo + (d2 / 127) * (r.hi - r.lo);
      const cur = r.get();
      const tol = (r.hi - r.lo) * 0.04;
      const prev = state.cc.get(d1);
      const prevV = prev === undefined ? null : r.lo + (prev / 127) * (r.hi - r.lo);
      const crossed = prevV !== null && (prevV - cur) * (target - cur) <= 0;
      if (Math.abs(target - cur) <= tol || crossed) picked.set(role, true);
    }
    state.cc.set(d1, d2);
  }
  setInterval(() => {
    for (const [cc, m] of latestCC) { latestCC.delete(cc); try { apply(m[0], m[1], m[2]); state.handled++; } catch (e) { state.errors++; } }
    let n = 0;
    while (state.queue.length && n++ < 64) {
      const [a, b, c] = state.queue.shift();
      try { apply(a, b, c); state.handled++; } catch (e) { state.errors++; }
    }
  }, 10);
  function bind() {
    try {
      for (const i of state.inputs) { try { i.onmidimessage = null; } catch {} }
      state.inputs = [];
      state.devices = [];
      for (const input of state.access.inputs.values()) {
        input.onmidimessage = onMessage;
        state.inputs.push(input);
        state.devices.push(input.name || "midi in");
      }
      state.status = state.devices.length ? state.devices.join(", ") : "no midi input";
    } catch (e) { state.errors++; state.status = "midi error"; }
  }
  try {
    state.access = await navigator.requestMIDIAccess({ sysex: false });
    bind();
    state.access.onstatechange = () => { try { bind(); } catch {} };
  } catch (e) {
    state.status = "midi refused";
  }
  // tests and the console: feed bytes through the same path
  state.inject = (bytes) => onMessage({ data: bytes });
  return state;
}
