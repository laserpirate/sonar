// midimap_check.mjs · the binding logic without a browser: modes, soft takeover, curves, smoothing, conflicts, bad input.
//   node tools/midimap_check.mjs
import { readFileSync } from "node:fs";
import { createMapper, cleanMap, DEFAULT_V020 } from "../docs/js/midimap.js";

let clock = 0;
const v = { r: 0.5, sel: 1, tog: false, fired: 0 };
const T = {
  r: { kind: "range", lo: 0, hi: 1, step: 0.01, get: () => v.r, set: (x) => { v.r = x; } },
  sel: { kind: "select", options: [0, 1, 2, 4], get: () => v.sel, set: (x) => { v.sel = x; } },
  tog: { kind: "toggle", get: () => v.tog, set: (x) => { v.tog = x; } },
  go: { kind: "act", fire: () => { v.fired++; } },
  panic: { kind: "toggle", get: () => v.tog, set: (x) => { v.tog = x; } },
};
const M = createMapper({ resolve: (id) => T[id] || null, now: () => clock });
const out = {};
// learn: the next CC binds, abs for a range; a note release does not bind
M.learn("r"); M.handle([0x80, 60, 0]); const stillLearning = M.learning === "r"; M.handle([0xb3, 20, 100]);
out.learn = { stillLearning, b: M.bindingOf("r"), learning: M.learning };
// soft takeover: 127 does nothing (value 0.5, knob came from 100), 60 crosses and takes over
M.handle([0xb3, 20, 127]); const held = v.r; M.handle([0xb3, 20, 60]);
out.takeover = { held, after: v.r };
// another channel does not reach a channel-bound binding
M.handle([0xb0, 20, 0]); out.otherChannel = v.r;
// rel: +3 and -2 steps
M.load([{ act: "r", type: "cc", ch: -1, num: 30, mode: "rel" }]); v.r = 0.5; M.handle([0xb0, 30, 3]); const up = v.r; M.handle([0xb0, 30, 126]);
out.rel = { up, down: v.r };
// curve exp at the middle sits low
M.load([{ act: "r", type: "cc", ch: -1, num: 31, mode: "abs", curve: "exp", step: 0 }]); v.r = 0.12; M.handle([0xb0, 31, 64]); out.expMid = v.r;
// smoothing glides and lands
M.load([{ act: "r", type: "cc", ch: -1, num: 32, mode: "abs", smooth: 0.8 }]); v.r = 0; M.handle([0xb0, 32, 0]); M.handle([0xb0, 32, 127]);
const first = v.r; let n = 0; while (v.r !== 1 && n < 500) { M.tick(); n++; }
out.smooth = { first, ticks: n, landed: v.r };
// select: takeover at the current option, then steps
M.load([{ act: "sel", type: "cc", ch: -1, num: 33, mode: "abs" }]); M.handle([0xb0, 33, 120]); const selHeld = v.sel; M.handle([0xb0, 33, 40]); M.handle([0xb0, 33, 127]);
out.select = { selHeld, end: v.sel };
// notes: toggle, momentary, hold
M.load([{ act: "tog", type: "note", ch: -1, num: 40, mode: "toggle" }, { act: "go", type: "note", ch: -1, num: 41, mode: "trig" }, { act: "panic", type: "note", ch: -1, num: 42, mode: "hold", hold_ms: 1000 }]);
v.tog = false; M.handle([0x90, 40, 100]); M.handle([0x80, 40, 0]); const tog1 = v.tog;
v.tog = false; M.handle([0x90, 42, 100]); clock = 500; M.tick(); M.handle([0x90, 42, 0]); clock = 2000; M.tick(); const holdShort = v.tog;
M.handle([0x90, 42, 100]); clock = 3100; M.tick(); const holdLong = v.tog;
M.load([{ act: "tog", type: "note", ch: -1, num: 43, mode: "momentary" }]); v.tog = false; M.handle([0x90, 43, 90]); const mOn = v.tog; M.handle([0x90, 43, 0]);
out.notes = { tog1, holdShort, holdLong, mOn, mOff: v.tog };
// cc trig fires once per upward crossing
M.load([{ act: "go", type: "cc", ch: -1, num: 50, mode: "trig" }]); v.fired = 0; for (const x of [0, 127, 127, 0, 127, 10]) M.handle([0xb0, 50, x]); out.ccTrig = v.fired;
// gate only while blacked out
M.load([{ act: "go", type: "note", ch: -1, num: 41, mode: "trig" }, { act: "panic", type: "note", ch: -1, num: 42, mode: "toggle" }]); M.gateOnly = true; v.fired = 0; v.tog = false;
M.handle([0x90, 41, 100]); M.handle([0x90, 42, 100]); out.gateOnly = { fired: v.fired, panic: v.tog, isGate: M.isGate([0x90, 42, 1]), notGate: M.isGate([0x90, 41, 1]) }; M.gateOnly = false;
// conflicts, including a channel-less binding against a channel one
M.load([{ act: "r", type: "cc", ch: -1, num: 9 }, { act: "sel", type: "cc", ch: 2, num: 9 }, { act: "go", type: "note", ch: -1, num: 9 }]);
out.conflicts = M.conflicts();
// bad input is dropped, never thrown
out.clean = cleanMap([null, { act: "x" }, { act: "r", type: "cc", num: 300 }, { act: "r", type: "sysex", num: 1 }, { act: "r", type: "cc", num: 5, mode: "weird", hold_ms: 99999 }, "x"]);
let threw = false; try { for (const d of [[], [0xb0], [0xf0, 1, 2], [0x90, 200, 300], null]) M.handle(d || []); } catch { threw = true; }
out.noThrow = !threw && M.errors === 0;
// the shipped v0.2.0 file equals the built-in default
const file = JSON.parse(readFileSync(new URL("../docs/data/midi-maps/sonar_v020-notes_v01.json", import.meta.url)));
out.v020Same = JSON.stringify(cleanMap(file.bindings)) === JSON.stringify(cleanMap(DEFAULT_V020));
const nano = JSON.parse(readFileSync(new URL("../docs/data/midi-maps/sonar_nanokontrol_v01.json", import.meta.url)));
out.nano = { n: cleanMap(nano.bindings).length, of: nano.bindings.length, verify: /verify with the wizard/.test(nano.verify) };
console.log(JSON.stringify(out, null, 1));
const ok = out.learn.stillLearning && out.learn.b?.type === "cc" && out.learn.b.ch === 3 && out.learn.b.mode === "abs" && out.learn.learning === null &&
  out.takeover.held === 0.5 && Math.abs(out.takeover.after - 0.47) < 0.011 && out.otherChannel === out.takeover.after &&
  Math.abs(out.rel.up - 0.53) < 0.011 && Math.abs(out.rel.down - 0.51) < 0.011 && out.expMid < 0.2 &&
  out.smooth.first === 0 && out.smooth.landed === 1 && out.smooth.ticks > 3 && out.smooth.ticks < 60 &&
  out.select.selHeld === 1 && out.select.end === 4 &&
  out.notes.tog1 === true && out.notes.holdShort === false && out.notes.holdLong === true && out.notes.mOn === true && out.notes.mOff === false &&
  out.ccTrig === 2 && out.gateOnly.fired === 0 && out.gateOnly.panic === true && out.gateOnly.isGate && !out.gateOnly.notGate &&
  out.conflicts.length === 1 && out.conflicts[0].acts.length === 2 && out.clean.length === 1 && out.clean[0].mode === "abs" && out.clean[0].hold_ms === 5000 &&
  out.noThrow && out.v020Same && out.nano.n === out.nano.of && out.nano.verify;
console.log(ok ? "OK" : "FAIL"); process.exit(ok ? 0 : 1);
