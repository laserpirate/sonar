// midi.js · Web MIDI in and out, AV-STANDARD v02. Loaded only after Enable.
//
// In: every message goes to the mapper (midimap.js). Blackout and panic bindings, and the one
// message a Learn is waiting for, act at once; CCs coalesce to the last value per controller
// (soft takeover still sees each one); notes wait in a capped queue. A 10 ms timer applies the
// queue inside try/catch, so a flood or a vanished device never reaches the keys, the blackout
// or the draw loop. MIDI clock in (24 ppqn) sets bpm when S.clockIn is on.
// Out (off by default): notes to a chosen output, one channel per voice, and MIDI clock.

export const OUT_CHANNELS = { saw: 0, rain: 1, pluck: 2, sine: 3, water: 4, bass: 5, sampler: 6 };
export const channelOf = (voice) => OUT_CHANNELS[/^smp\d/.test(voice || "") ? "sampler" : voice] ?? 0;

export async function initMidi({ S, act, mapper }) {
  const state = { access: null, inputs: [], outputs: [], queue: [], dropped: 0, handled: 0, errors: 0, devices: [], clockBpm: null, clockTicks: 0, sent: 0, clockSent: 0 };
  S.midi = state;
  if (typeof navigator.requestMIDIAccess !== "function") { state.status = "no web midi"; return state; }
  const latestCC = new Map(); // status:cc -> bytes; a flood of CCs coalesces to the last value
  const ticks = []; // clock-in tick times, the last 25
  function realtime(b, t) {
    if (!S.clockIn) return;
    if (b === 0xf8) {
      ticks.push(t); if (ticks.length > 25) ticks.shift();
      state.clockTicks++;
      if (ticks.length === 25) {
        const bpm = 60000 / (ticks[24] - ticks[0]);
        if (bpm > 15 && bpm < 400) state.clockBpm = state.clockBpm === null ? bpm : state.clockBpm + (bpm - state.clockBpm) * 0.25;
      }
    } else if (b === 0xfa || b === 0xfb) act.play(true);
    else if (b === 0xfc) act.play(false);
  }
  function onMessage(ev) {
    const d = ev.data;
    if (!d || !d.length) return;
    if (d[0] >= 0xf8) { try { realtime(d[0], ev.timeStamp || performance.now()); } catch { state.errors++; } return; }
    if (d.length < 2) return;
    // the gates and a waiting Learn never queue
    if (mapper.learning || mapper.isGate(d)) {
      try { mapper.handle(d); state.handled++; } catch { state.errors++; }
      return;
    }
    if ((d[0] & 0xf0) === 0xb0) { mapper.pickup(d); latestCC.set((d[0] << 8) | d[1], [d[0], d[1], d[2] ?? 0]); return; }
    if (state.queue.length > 256) { state.dropped++; return; }
    state.queue.push([d[0], d[1], d[2] ?? 0]);
  }
  let lastBpmSet = 0;
  setInterval(() => {
    mapper.gateOnly = !!S.blackoutOn;
    for (const [k, m] of latestCC) { latestCC.delete(k); try { mapper.handle(m); state.handled++; } catch { state.errors++; } }
    let n = 0;
    while (state.queue.length && n++ < 64) {
      const m = state.queue.shift();
      try { mapper.handle(m); state.handled++; } catch { state.errors++; }
    }
    try { mapper.tick(); } catch { state.errors++; }
    const t = performance.now();
    if (S.clockIn && state.clockBpm !== null && t - lastBpmSet > 250 && Math.abs(state.clockBpm - S.bpm) >= 0.5) { lastBpmSet = t; act.bpm(state.clockBpm); }
  }, 10);
  function bind() {
    try {
      for (const i of state.inputs) { try { i.onmidimessage = null; } catch {} }
      state.inputs = []; state.devices = []; state.outputs = [];
      for (const input of state.access.inputs.values()) {
        input.onmidimessage = onMessage;
        state.inputs.push(input);
        state.devices.push(input.name || "midi in");
      }
      for (const o of state.access.outputs?.values?.() || []) state.outputs.push(o);
      state.status = state.devices.length ? state.devices.join(", ") : "no midi input";
      if (S.midiOut?.port && !state.outputs.some((o) => o.id === S.midiOut.port)) S.midiOut.port = "";
      state.onPorts?.();
    } catch (e) { state.errors++; state.status = "midi error"; }
  }
  try {
    state.access = await navigator.requestMIDIAccess({ sysex: false });
    bind();
    state.access.onstatechange = () => { try { bind(); } catch {} };
  } catch (e) {
    state.status = "midi refused";
  }
  const out = () => (S.midiOut?.port ? state.outputs.find((o) => o.id === S.midiOut.port) : null);
  // a note the garden played: on now (plus the audio's look-ahead), off after its length
  state.noteOut = (n, voice, seconds) => {
    if (!S.midiOut?.notes) return;
    const o = out(); if (!o) return;
    try {
      const ch = channelOf(voice), note = Math.max(0, Math.min(127, Math.round(n.note))), vel = Math.max(1, Math.min(127, Math.round((n.vel ?? 0.8) * 127)));
      const t = performance.now() + 20;
      o.send([0x90 | ch, note, vel], t);
      o.send([0x80 | ch, note, 0], t + Math.max(30, Math.min(8000, seconds * 1000)));
      state.sent++;
    } catch { state.errors++; }
  };
  // clock out: 24 ppqn, scheduled 60 ms ahead with timestamps, start and stop follow play
  let next = null, wasOn = false;
  setInterval(() => {
    const o = out(), on = !!(S.midiOut?.clock && o && S.playing);
    try {
      if (on && !wasOn) { o.send([0xfa]); next = performance.now(); }
      if (!on && wasOn) { try { (o || state.lastClockOut)?.send([0xfc]); } catch {} next = null; }
      wasOn = on; if (on) state.lastClockOut = o;
      if (!on) return;
      const step = 60000 / (S.bpm * 24), horizon = performance.now() + 60;
      if (next < performance.now() - 200) next = performance.now(); // after a stall, do not burst
      while (next < horizon) { o.send([0xf8], next); next += step; state.clockSent++; }
    } catch { state.errors++; }
  }, 25);
  // tests and the console: feed bytes through the same path
  state.inject = (bytes) => onMessage({ data: bytes });
  return state;
}
