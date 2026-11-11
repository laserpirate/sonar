// app.js · sonar page: renderer + sim garden (garden.js) + live (OSC over WebSocket) + keys + controls.
// Audio engines and MIDI load only after the Enable click (audio.js, midi.js).
import { Plant, LSystem, Turtle, makeRandom, DRAW } from "./lsys.js";
import { Garden, LOOP_BARS, MAX_LAYERS, SCALE_NAMES, ARP_MODES, ARP_RATES, ARP_ENGINES, noteName } from "./garden.js";
import { OscWs } from "./osc-ws.js";
import { Stage } from "./stage.js";
import { addPanel, group, slider, select, buttons, button, note, refreshAll, openPanel, togglePanel, applyDefaultPanels, controls } from "./ui.js";
import { initGestures } from "./gestures.js";
import { setupLabel, encodeSetup, decodeSetup, createStore, exportText, parseImport } from "./setups.js";

const q = new URLSearchParams(location.search);
const catalog = await (await fetch(new URL("./catalog.json", import.meta.url))).json();
const D = catalog.defaults;
const NPRESETS = catalog.plants.length;
const factory = await fetch(new URL("./setups.json", import.meta.url)).then((r) => r.json()).catch(() => []);
const pid = (n) => "p" + String(n).padStart(2, "0");
const newSeed = () => ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) % 1000000 + 1;

// ------------------------------------------------------------------ state
const S = {
  mode: q.get("mode") === "norns" ? "norns" : "wall",
  source: "sim",
  playing: true,
  bpm: Number(q.get("bpm")) || 90,
  active: 1,
  page: 1,
  panic: false,
  frames: 0,
  notes: 0,
  segments: { 1: 0, 2: 0 },
  lastGen: { 1: null, 2: null },
  lastNote: null,
  instr: [0, 0],
  errors: 0,
  hb: 0,
  flags: { shanshui: q.get("shanshui") === "1", kodama: q.get("kodama") === "1" },
  weather: 0,
  flood: 0,
  phase: null,
  delay: Number(q.get("delay")) || 0,
  seed: Number(q.get("seed")) || newSeed(),
  morph: 0,
  factoryIx: -1,
};
window.__sonar = S; // read by the Playwright tests
S.blackoutOn = window.sonarBlackout.on;
window.sonarBlackout.hook((v) => { S.blackoutOn = v; });

const listeners = { note: [], gen: [], state: [] };
export const on = (ev, f) => listeners[ev].push(f);
const emit = (ev, x) => { for (const f of listeners[ev]) { try { f(x); } catch (e) { S.errors++; console.warn(ev, e); } } };
window.__sonarOn = on;

// ------------------------------------------------------------------ garden (sim)
const instrArg = (q.get("p1") || q.get("p2")) ? [Number(q.get("p1")) || D.initial_plant_instructions[0], Number(q.get("p2")) || Number(q.get("p1")) || D.initial_plant_instructions[1]] : null;
const G = new Garden({ catalog, seed: S.seed, bpm: S.bpm, instr: instrArg || (q.get("seed") ? null : D.initial_plant_instructions) });
window.__garden = G;
S.instr = G.instr;
G.onGen = (g) => { S.lastGen[g.plant] = { gen: g.gen, max: g.max, instr: g.instr }; lit.get(g.plant)?.clear(); emit("gen", g); };
for (let k = 0; k < 2; k++) S.lastGen[k + 1] = { gen: G.plants[k].currentGeneration, max: G.plants[k].maxGenerations, instr: G.instr[k] };
G.setAllDelays(S.delay);
if (q.get("pitch")) G.setPitch(Number(q.get("pitch")));
if (q.get("growth")) G.setGrowth(Number(q.get("growth")));
if (q.get("arp")) G.setArp({ mode: q.get("arp"), rate: q.get("arprate") || "1/8", octaves: Number(q.get("arpoct")) || 1 });
if (q.get("key")) { const [r, ...m] = q.get("key").split(","); G.setKey(Number(r) || undefined, m.join(",") || undefined); }

let beat0 = performance.now();
const nowBeats = () => ((performance.now() - beat0) / 1000) * (S.bpm / 60);
const lit = new Map();      // plant id -> Map(sentence index -> brightness)
const noteAt = new Map();   // plant id -> last played note position (norns mode highlight)
const litOf = (id) => { let m = lit.get(id); if (!m) { m = new Map(); lit.set(id, m); } return m; };

// ------------------------------------------------------------------ live plants: rebuilt from /sonar/rules + /sonar/gen
const random = G.random;
const plants = G.plants;
const liveRules = [null, null];
function liveRulesMsg(a) {
  const id = a[0], axiom = String(a[1] ?? ""), n = Number(a[2]) || 0;
  const rs = [];
  for (let i = 0; i < n; i++) rs.push([String(a[3 + 2 * i]), String(a[4 + 2 * i] ?? "")]);
  if (id === 1 || id === 2) liveRules[id - 1] = { axiom, ruleset: rs, fresh: true };
}
function liveGenMsg(a) {
  const [id, gen, maxgen, angle, length, x0, y0, rot0] = a;
  let sentence = typeof a[8] === "string" ? a[8] : "";
  const truncated = Number(a[9]) === 1;
  if (id !== 1 && id !== 2) return;
  const k = id - 1, p = plants[k];
  const rules = liveRules[k] || { axiom: sentence, ruleset: [] };
  const fresh = rules.fresh || !p.lsys || !p.turtle;
  if (fresh) {
    p.lsys = new LSystem(rules.axiom, rules.ruleset, { random, maxLength: D.max_sentence_length });
    p.turtle = new Turtle(rules.axiom, length || 35, (angle * Math.PI) / 180, { random });
    p.resetOffset();
    rules.fresh = false;
    litOf(id).clear();
  }
  p.axiom = rules.axiom; p.ruleset = rules.ruleset;
  p.angle = angle; p.length = length; p.maxGenerations = maxgen; p.currentGeneration = gen;
  p.initialTurtleRotation = rot0;
  p.startFrom = { x: x0, y: y0 };
  p.instr = { angle };
  p.turtle.theta = (angle * Math.PI) / 180;
  if (truncated || !sentence) {
    p.lsys.update(rules.axiom, rules.ruleset);
    for (let i = 0; i < gen; i++) p.lsys.generate(1);
    sentence = p.lsys.sentence;
  }
  p.lsys.sentence = sentence;
  p.turtle.setTodo(sentence);
  S.lastGen[id] = { gen, max: maxgen, instr: S.lastGen[id]?.instr ?? null, truncated };
  emit("gen", { plant: id, gen, max: maxgen, sim: false });
}

// ------------------------------------------------------------------ note events (sim or live)
function noteEvent(ev) {
  const { plant, idx, x, y } = ev;
  if (idx > 0) litOf(plant).set(idx, 1);
  if (!ev.arp && !ev.flourish) noteAt.set(plant, { x, y, idx, t: performance.now() });
  S.notes++;
  S.lastNote = { plant, idx, note: ev.note, freq: ev.freq, arp: !!ev.arp, layer: ev.layer || 0 };
  emit("note", { ...ev, active: plant === S.active });
}

// ------------------------------------------------------------------ live (bridge)
let link = null;
const wsUrl = q.get("ws");
function liveMessage(path, a) {
  switch (path) {
    case "/sonar/rules": liveRulesMsg(a); break;
    case "/sonar/gen": liveGenMsg(a); break;
    case "/sonar/note": noteEvent({ plant: a[0], idx: a[1], note: a[2], freq: a[3], x: a[4], y: a[5], dur: a[6] }); break;
    case "/sonar/rest": break;
    case "/sonar/plant": if (a[0] === 1 || a[0] === 2) S.active = a[0]; break;
    case "/sonar/page": S.page = a[0]; break;
    case "/sonar/hb": S.hb = a[0]; if (a[1] > 0) S.bpm = Math.round(a[1]); break;
    case "/av/weather": if (S.flags.shanshui) S.weather = clamp01(a[0]); break;
    case "/av/flood": if (S.flags.shanshui) S.flood = clamp01(a[0]); break;
    default: break;
  }
}
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
if (wsUrl) {
  link = new OscWs(wsUrl, liveMessage, (up) => {
    if (up) { S.source = "live"; G.play(false); link.send("/sonar/resend", []); }
    else S.source = "live (lost)";
    emit("state", S);
  });
}
const live = () => S.source.startsWith("live");

// ------------------------------------------------------------------ sim clock
function simTick() {
  if (live() || S.panic) return;
  if (pendingSetup && nowBeats() >= pendingSetup.at) { const p = pendingSetup; pendingSetup = null; applySetup(p.s, p.at, p.bars); }
  if (glide) stepGlide();
  for (const ev of G.step(nowBeats())) noteEvent(ev);
}

// a setup lands on a bar line; the continuous parameters then glide for `morph` bars
let pendingSetup = null, glide = null, glideEmit = 0;
const glideKeys = () => [
  [() => S.bpm, (v) => act.bpm(v)],
  ...ARP_ENGINES.flatMap((e) => [
    [() => G.delays[e].amount, (v) => { G.delays[e].amount = v; }],
    [() => G.delays[e].feedback, (v) => { G.delays[e].feedback = v; }],
    [() => G.delays[e].lowpass, (v) => { G.delays[e].lowpass = v; }],
    [() => G.arps[e].gate, (v) => { G.arps[e].gate = Math.round(v); }],
  ]),
  [() => G.flourish, (v) => G.setFlourish(v)],
  ...G.plants.flatMap((_, k) => [[() => G.plants[k].angle, (v) => G.plants[k].setAngle(v)], [() => G.plants[k].userScale ?? 1, (v) => { G.plants[k].userScale = v; }]]),
];
function applySetup(s, at, bars) {
  const keys = glideKeys(), from = keys.map((k) => k[0]());
  G.fromSetup(s, at);
  const to = keys.map((k) => k[0]());
  to[0] = G.bpm;
  S.seed = G.seedValue; S.instr = G.instr; S.active = G.active;
  for (let k = 0; k < 2; k++) S.lastGen[k + 1] = { gen: G.plants[k].currentGeneration, max: G.plants[k].maxGenerations, instr: G.instr[k] };
  lit.clear(); noteAt.clear();
  glide = null;
  if (bars > 0) { keys.forEach((k, i) => k[1](from[i])); glide = { at, len: bars * 4, keys, from, to }; }
  else act.bpm(G.bpm);
  S.delay = G.delays.saw.amount;
  syncUrl();
  emit("state", S);
}
function stepGlide() {
  const g = glide, f = Math.min(1, (nowBeats() - g.at) / g.len);
  g.keys.forEach((k, i) => k[1](f >= 1 ? g.to[i] : g.from[i] + (g.to[i] - g.from[i]) * f));
  if (f >= 1) glide = null;
  const t = performance.now();
  if (f >= 1 || t - glideEmit > 50) { glideEmit = t; emit("state", S); }
}
setInterval(simTick, 5);

// ------------------------------------------------------------------ actions (keys, buttons, MIDI, sliders)
export const act = {
  play(v) {
    S.playing = v === undefined ? !S.playing : !!v;
    if (live()) link.send("/sonar/play", [S.playing ? 1 : 0]);
    else G.play(S.playing);
    emit("state", S);
  },
  nextGen() {
    if (live()) { link.send("/sonar/generate", [S.active, 1]); return; }
    G.active = S.active; G.nextGen();
  },
  reset() {
    if (live()) { link.send("/sonar/reset", []); return; }
    G.reset();
  },
  // new seed for the base garden: new presets, new random angles
  reseed(seed) {
    S.seed = G.seed(seed ?? newSeed());
    S.instr = G.instr;
    clearShareHash();
    for (let k = 0; k < 2; k++) { S.lastGen[k + 1] = { gen: G.plants[k].currentGeneration, max: G.plants[k].maxGenerations, instr: G.instr[k] }; litOf(k + 1).clear(); }
    syncUrl();
    emit("state", S);
  },
  // a seeded loop layer on the next bar line
  addLayer(seed) { if (live()) return null; const L = G.addLayer(seed ?? newSeed(), nowBeats()); emit("state", S); return L; },
  clearLayers() { for (const L of G.layers) { lit.delete(L.id); noteAt.delete(L.id); } G.clearLayers(); emit("state", S); },
  plant(n) {
    if (live()) link.send("/sonar/plant", [n]);
    S.active = n; G.active = n; emit("state", S);
  },
  plantNext() { act.plant((S.active % G.plants.length) + 1); },
  preset(dir) {
    const k = S.active - 1;
    if (live()) { const n = ((S.instr[k] - 1 + dir + NPRESETS) % NPRESETS) + 1; S.instr[k] = n; link.send(`/param/plant${S.active}_instructions`, [n]); return; }
    G.active = S.active; G.preset(dir);
  },
  angle(deg) {
    const k = S.active - 1;
    if (live()) { link.send(`/param/plant${S.active}_angle`, [deg]); return; }
    plants[k].setAngle(deg);
  },
  // drawn length of the active plant, relative to its preset (the device has no param for it)
  length(v) { plants[S.active - 1].userScale = Math.max(0.35, Math.min(1.6, v)); },
  palette() { openPanel("plants"); document.getElementById("palette")?.scrollIntoView?.({ block: "nearest" }); },
  engineCycle() { const A = S.audio; if (!A) return; A.engine = { saw: "rain", rain: "both", both: "saw" }[A.engine] || "saw"; document.getElementById("b-engine").textContent = A.engine; },
  bpm(v) {
    const b = Math.round(Math.max(20, Math.min(300, v)));
    G.bpm = b;
    if (b === S.bpm) return;
    const nb = nowBeats(); S.bpm = b; beat0 = performance.now() - (nb / (b / 60)) * 1000; // keep beat phase
    if (live()) link.send("/param/clock_tempo", [b]);
    emit("state", S);
  },
  pitch(semi) { G.setPitch(semi); if (live()) link.send("/param/root_note_offset", [Math.round(semi)]); emit("state", S); },
  delay(a) { S.delay = clamp01(a); G.setAllDelays(S.delay); emit("state", S); }, // both lines, as v0.2.0's one delay
  delayOf(engine, o) { G.setDelay(engine, o); emit("state", S); },
  route(id, voice) { G.setRoute(id, voice); emit("state", S); },
  layerRoute(voice) { G.setLayerRoute(voice); emit("state", S); },
  flourish(a) { G.setFlourish(a); emit("state", S); },
  growth(bars) { G.setGrowth(bars); emit("state", S); },
  key(root, scale) { G.setKey(root, scale); if (live()) { if (root !== undefined) link.send("/param/root_note", [root]); } emit("state", S); },
  arp(o, engine = "saw") { G.setArp(o, engine); emit("state", S); },
  arpCycle() { const i = ARP_MODES.indexOf(G.arp.mode); G.setArp({ mode: ARP_MODES[(i + 1) % ARP_MODES.length] }); emit("state", S); },
  mode(m) { S.mode = m || (S.mode === "wall" ? "norns" : "wall"); resize(); emit("state", S); },
  blackout(v) { v === undefined ? window.sonarBlackout.toggle() : window.sonarBlackout.set(v); },
  panic(v) {
    S.panic = v === undefined ? !S.panic : !!v;
    document.getElementById("panic").classList.toggle("show", S.panic);
    emit("state", S);
  },
  send(path, args) { if (live()) link.send(path, args); },
  simParams(o) { G.simParams(o); S.simOpts = G.simOpts; },
  isLive: () => live(),
  setup: (k, instr, gen) => G.setup(k, instr, gen), // ?score=1 shows the score's plant
  garden: () => G,
  // o.now: at once, without waiting for the bar line. Sim only: a live garden belongs to the norns
  loadSetup(s, o = {}) {
    if (live()) return false;
    G._cleanSetup(s);
    const bars = o.bars ?? S.morph;
    if (o.now || !S.playing || S.panic) { pendingSetup = null; applySetup(s, nowBeats(), o.now ? 0 : bars); }
    else pendingSetup = { s, at: Math.ceil(nowBeats() / 4) * 4, bars };
    return true;
  },
  setupStep(dir) {
    if (!factory.length) return;
    S.factoryIx = S.factoryIx < 0 ? (dir > 0 ? 0 : factory.length - 1) : (S.factoryIx + dir + factory.length) % factory.length;
    act.loadSetup(factory[S.factoryIx]);
  },
};
window.__sonarAct = act;

function clearShareHash() { try { if (location.hash.startsWith("#s=")) history.replaceState(null, "", location.pathname + location.search); } catch {} }
function syncUrl() {
  try { const u = new URL(location.href); u.searchParams.set("seed", String(S.seed)); history.replaceState(null, "", u); } catch {}
}
syncUrl();

// keys: handled synchronously, before anything else the page does
let escTimer = null;
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.key !== "Escape") return;
  const k = e.key;
  if (k === "Escape") {
    if (!e.repeat && !escTimer) escTimer = setTimeout(() => { escTimer = null; act.panic(); }, 1000);
    return;
  }
  if (e.repeat && k !== "ArrowLeft" && k !== "ArrowRight") return;
  const map = {
    " ": () => act.play(), n: () => act.nextGen(), N: () => act.nextGen(),
    r: () => (live() ? act.reset() : act.reseed()), R: () => act.reset(), // live: the device has no seed, R resets
    l: () => act.addLayer(), L: () => act.addLayer(), c: () => act.clearLayers(), C: () => act.clearLayers(),
    a: () => act.arpCycle(), A: () => act.arpCycle(),
    "1": () => act.plant(1), "2": () => act.plant(2), Tab: () => act.plantNext(), m: () => act.mode(), M: () => act.mode(),
    h: () => toggleHud(), H: () => toggleHud(), e: () => act.engineCycle(), E: () => act.engineCycle(),
    f: () => fullscreen(), F: () => fullscreen(), "?": () => { openPanel("more"); keysBox.classList.toggle("show"); },
    ArrowLeft: () => act.preset(-1), ArrowRight: () => act.preset(1),
    ArrowUp: () => act.bpm(S.bpm + 2), ArrowDown: () => act.bpm(S.bpm - 2),
    "[": () => act.setupStep(-1), "]": () => act.setupStep(1),
  };
  if (S.scoreKey && S.scoreKey(k)) { e.preventDefault(); return; } // ?score=1 only
  const f = map[k];
  if (f) { e.preventDefault(); try { f(); } catch (err) { S.errors++; console.warn(err); } }
}, true);
window.addEventListener("keyup", (e) => { if (e.key === "Escape" && escTimer) { clearTimeout(escTimer); escTimer = null; } }, true);

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

// ------------------------------------------------------------------ HUD
const hud = document.getElementById("hud");
const $ = (id) => document.getElementById(id);
$("b-play").onclick = () => act.play();
$("b-reseed").onclick = () => act.reseed();
$("b-layer").onclick = () => act.addLayer();
$("b-clear").onclick = () => act.clearLayers();
for (const b of hud.querySelectorAll("button")) b.addEventListener("keydown", (e) => { if (e.key === " ") e.preventDefault(); });
for (const [id, label, fire] of [["b-play", "play", () => act.play()], ["b-reseed", "reseed", () => act.reseed()], ["b-layer", "+ loop", () => act.addLayer()], ["b-clear", "clear loops", () => act.clearLayers()]]) controls.set(id, { id, label, kind: "act", fire, panel: "transport" });

const signed = (x) => (x > 0 ? "+" : "") + x;
const angleOf = () => plants[S.active - 1].angle ?? 0;
const lengthOf = () => plants[S.active - 1].userScale ?? 1;
const pTempo = addPanel("tempo", "tempo", { open: true });
group(pTempo, "tempo and key");
slider(pTempo, { id: "r-bpm", label: "bpm", min: 20, max: 300, get: () => S.bpm, set: (v) => act.bpm(v) });
slider(pTempo, { id: "r-pitch", label: "pitch", min: -24, max: 24, get: () => G.pitch, set: (v) => act.pitch(v), fmt: signed });
const rootOpts = []; for (let n = 33; n <= 60; n++) rootOpts.push([n, noteName(n)]);
select(pTempo, { id: "s-root", label: "root", options: rootOpts, get: () => G.key.root, set: (v) => act.key(v, undefined) });
select(pTempo, { id: "s-scale", label: "scale", options: SCALE_NAMES, get: () => G.key.scale, set: (v) => act.key(undefined, v) });
slider(pTempo, { id: "r-growth", label: "growth", min: 0, max: 8, get: () => G.growth, set: (v) => act.growth(v), fmt: (x) => (x ? x + " bar" : "off") });

const pArp = addPanel("arp", "arp", { open: true });
for (const e of ARP_ENGINES) {
  const sfx = e === "saw" ? "" : "-" + e, A = G.arps[e];
  group(pArp, "arp " + e);
  select(pArp, { id: "s-arp" + sfx, label: "mode", label2: `arp ${e} mode`, options: ARP_MODES, get: () => A.mode, set: (v) => act.arp({ mode: v }, e) });
  select(pArp, { id: "s-arprate" + sfx, label: "rate", label2: `arp ${e} rate`, options: Object.keys(ARP_RATES), get: () => A.rate, set: (v) => act.arp({ rate: v }, e) });
  select(pArp, { id: "s-arpoct" + sfx, label: "octaves", label2: `arp ${e} octaves`, options: [[1, "1 oct"], [2, "2 oct"], [3, "3 oct"]], get: () => A.octaves, set: (v) => act.arp({ octaves: v }, e) });
  slider(pArp, { id: "r-arpgate" + sfx, label: "gate", label2: `arp ${e} gate`, min: 10, max: 100, get: () => A.gate, set: (v) => act.arp({ gate: v }, e), fmt: (x) => x + " %" });
  slider(pArp, { id: "r-arpsteps" + sfx, label: "steps", label2: `arp ${e} steps`, min: 1, max: 16, get: () => A.steps, set: (v) => act.arp({ steps: v, pulses: Math.min(A.pulses, v) }, e) });
  slider(pArp, { id: "r-arppulses" + sfx, label: "pulses", label2: `arp ${e} pulses`, min: 0, max: 16, get: () => A.pulses, set: (v) => act.arp({ pulses: v }, e) });
  slider(pArp, { id: "r-arprot" + sfx, label: "rotation", label2: `arp ${e} rotation`, min: 0, max: 15, get: () => A.rotation, set: (v) => act.arp({ rotation: v }, e) });
}
group(pArp, "answer");
slider(pArp, { id: "r-flourish", label: "flourish", min: 0, max: 1, step: 0.01, get: () => G.flourish, set: (v) => act.flourish(v), fmt: (x) => Math.round(x * 100) + " %" });

const pDelay = addPanel("delay", "delay", { open: true });
group(pDelay, "delay, both");
slider(pDelay, { id: "r-delay", label: "amount", label2: "delay both", min: 0, max: 1, step: 0.01, get: () => S.delay, set: (v) => act.delay(v), fmt: (x) => x.toFixed(2) });
for (const e of ARP_ENGINES) {
  const D = G.delays[e];
  group(pDelay, "delay " + e);
  slider(pDelay, { id: "r-damt-" + e, label: "amount", label2: `delay ${e} amount`, min: 0, max: 1, step: 0.01, get: () => D.amount, set: (v) => act.delayOf(e, { amount: v }), fmt: (x) => x.toFixed(2) });
  select(pDelay, { id: "s-ddiv-" + e, label: "time", label2: `delay ${e} time`, options: [["1/16", "1/16"], ["1/8", "1/8"], ["d1/8", "dotted 1/8"], ["1/4", "1/4"], ["1/2", "1/2"]], get: () => D.div, set: (v) => act.delayOf(e, { div: v }) });
  slider(pDelay, { id: "r-dfb-" + e, label: "feedback", label2: `delay ${e} feedback`, min: 0, max: 0.85, step: 0.01, get: () => D.feedback, set: (v) => act.delayOf(e, { feedback: v }), fmt: (x) => x.toFixed(2) });
  slider(pDelay, { id: "r-dlp-" + e, label: "low-pass", label2: `delay ${e} low-pass`, min: 400, max: 8000, step: 10, get: () => D.lowpass, set: (v) => act.delayOf(e, { lowpass: v }), fmt: (x) => Math.round(x) + " Hz" });
  buttons(pDelay, [{ id: "b-dpp-" + e, label: "ping-pong", label2: `delay ${e} ping-pong`, fire: () => act.delayOf(e, { pingpong: !D.pingpong }), on: () => D.pingpong }]);
}

const pPlants = addPanel("plants", "plants", { open: true });
group(pPlants, "plant");
buttons(pPlants, [
  { id: "b-p1", label: "1", title: "1", fire: () => act.plant(1), on: () => S.active === 1, label2: "plant 1" },
  { id: "b-p2", label: "2", title: "2", fire: () => act.plant(2), on: () => S.active === 2, label2: "plant 2" },
  { id: "b-prev", label: "prev", title: "Left", fire: () => act.preset(-1), label2: "preset prev" },
  { id: "b-next", label: "next", title: "Right", fire: () => act.preset(1), label2: "preset next" },
]);
slider(pPlants, { id: "r-angle", label: "angle", min: -360, max: 360, get: () => angleOf(), set: (v) => act.angle(v), fmt: (x) => Math.round(x) + " deg", random: false });
slider(pPlants, { id: "r-length", label: "length", min: 0.35, max: 1.6, step: 0.01, get: () => lengthOf(), set: (v) => act.length(v), fmt: (x) => x.toFixed(2), random: false });
const VOICE_OPTS = [["", "default"], ["saw", "saw"], ["rain", "rain"]];
const sRoute = select(pPlants, { id: "s-route", label: "voice", label2: "active plant voice", options: VOICE_OPTS, get: () => G.routes[S.active] ?? "", set: (v) => act.route(S.active, v), random: false });
const sLoopRoute = select(pPlants, { id: "s-route-loops", label: "loop voice", options: VOICE_OPTS, get: () => G.layerRoute ?? "", set: (v) => act.layerRoute(v), random: false });
buttons(pPlants, [
  { id: "b-gen", label: "next gen", title: "N or two-finger tap", fire: () => act.nextGen() },
  { id: "b-palette", label: "palette", title: "long press a plant", fire: () => act.palette(), noMap: true },
]);

const pSetups = addPanel("setups", "setups");
const store = createStore();
group(pSetups, "factory");
select(pSetups, { id: "s-factory", label: "setup", options: [[-1, "-"], ...factory.map((x, i) => [i, setupLabel(x)])], get: () => S.factoryIx, set: (i) => { S.factoryIx = i; if (i >= 0) act.loadSetup(factory[i]); }, random: false });
buttons(pSetups, [
  { id: "b-setup-prev", label: "prev", title: "[", label2: "setup prev", fire: () => act.setupStep(-1) },
  { id: "b-setup-next", label: "next", title: "]", label2: "setup next", fire: () => act.setupStep(1) },
]);
select(pSetups, { id: "s-morph", label: "morph", options: [[0, "0 bars"], [1, "1 bar"], [2, "2 bars"], [4, "4 bars"], [8, "8 bars"]], get: () => S.morph, set: (v) => { S.morph = v; }, random: false });
group(pSetups, "saved");
const mkField = (id, label, el) => { const row = document.createElement("div"); row.className = "ctl"; const l = document.createElement("label"); l.textContent = label; l.htmlFor = id; el.id = id; row.append(l, el); pSetups.appendChild(row); return el; };
const nameBox = mkField("t-setup-name", "name", Object.assign(document.createElement("input"), { type: "text", maxLength: 40, autocomplete: "off" }));
const savedSel = mkField("s-saved", "saved", document.createElement("select"));
const refillSaved = () => {
  const was = savedSel.value;
  savedSel.textContent = "";
  for (const x of store.list()) { const o = document.createElement("option"); o.value = x.name; o.textContent = `${x.name} · ${setupLabel(x.setup, "")}`; savedSel.appendChild(o); }
  if ([...savedSel.options].some((o) => o.value === was)) savedSel.value = was;
};
const setupNote = note(pSetups, "", "setup-note");
const say = (t) => { setupNote.textContent = t; };
const download = (name, text) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
const safeName = (n) => n.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "setup";
let delArmed = null;
buttons(pSetups, [
  { id: "b-setup-save", label: "save", noMap: true, fire: () => { const n = nameBox.value.trim() || store.nextSlot(); store.put(n, G.toSetup()); nameBox.value = ""; refillSaved(); savedSel.value = n; say(store.persistent() ? `saved ${n}` : `saved ${n} for this page only`); } },
  { id: "b-setup-load", label: "load", noMap: true, fire: () => { const s = store.get(savedSel.value); if (s) { try { act.loadSetup(s); say(`loaded ${savedSel.value}`); } catch (e) { say("not readable"); } } } },
  { id: "b-setup-over", label: "overwrite", noMap: true, fire: () => { if (savedSel.value) { store.put(savedSel.value, G.toSetup()); refillSaved(); say(`saved ${savedSel.value}`); } } },
  { id: "b-setup-del", label: "delete", noMap: true, fire: () => {
    const b = $("b-setup-del"), n = savedSel.value;
    if (!n) return;
    if (delArmed !== n) { delArmed = n; b.textContent = "delete?"; setTimeout(() => { delArmed = null; b.textContent = "delete"; }, 3000); return; }
    delArmed = null; b.textContent = "delete"; store.remove(n); refillSaved(); say(`deleted ${n}`);
  } },
]);
const importBox = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json", multiple: true, id: "f-setup-import" });
importBox.style.display = "none"; pSetups.appendChild(importBox);
async function importFiles(files) {
  let n = 0;
  try {
    for (const f of files) for (const x of parseImport(await f.text())) { G._cleanSetup(x.setup); store.put(x.name || store.nextSlot(), x.setup); n++; }
    say(`imported ${n}`);
  } catch (e) { say(`imported ${n}, then a file was not readable`); }
  refillSaved();
}
importBox.onchange = () => { importFiles([...importBox.files]); importBox.value = ""; };
window.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); } });
const linkBox = mkField("t-setup-link", "link", Object.assign(document.createElement("input"), { type: "text", readOnly: true }));
buttons(pSetups, [
  { id: "b-setup-export", label: "export", noMap: true, fire: () => { const x = store.list().find((y) => y.name === savedSel.value); if (x) download(`sonar_setup_${safeName(x.name)}_v01.json`, exportText([x])); } },
  { id: "b-setup-all", label: "export all", noMap: true, fire: () => download("sonar_setups_all_v01.json", exportText(store.list())) },
  { id: "b-setup-import", label: "import", noMap: true, fire: () => importBox.click() },
  { id: "b-setup-share", label: "share link", noMap: true, fire: async () => {
    const url = location.origin + location.pathname + "#s=" + await encodeSetup(G.toSetup());
    linkBox.value = url;
    try { await navigator.clipboard.writeText(url); say("link copied"); } catch { say("link ready"); }
  } },
]);
refillSaved();

const pMore = addPanel("more", "more");
group(pMore, "output");
slider(pMore, { id: "r-master", label: "vol", min: 0, max: 1, step: 0.01, get: () => S.master ?? 0.7, set: (v) => { S.master = v; emit("state", S); }, fmt: (x) => x.toFixed(2), random: false });
buttons(pMore, [
  { id: "b-engine", label: "saw", title: "E", fire: () => act.engineCycle() },
  { id: "b-reset", label: "reset", title: "Shift+R", fire: () => act.reset() },
  { id: "b-mode", label: "wall", title: "M", fire: () => act.mode(), noMap: true },
  { id: "b-hide", label: "hide", title: "H; tap the empty stage to bring the controls back", fire: () => toggleHud(), noMap: true },
  { id: "b-full", label: "full", title: "F", fire: () => fullscreen(), noMap: true },
  { id: "b-keys", label: "keys", title: "?", fire: () => $("keys").classList.toggle("show"), noMap: true },
]);
const keysBox = document.createElement("div");
keysBox.id = "keys";
const KEY_ROWS = [["Space", "play"], ["N", "next gen"], ["R", "reseed (new seed, new plants)"], ["L", "+ loop: a seeded 4 bar layer from the next bar"], ["C", "clear loops"], ["Shift+R", "reset the plants"], ["A", "arp mode"], ["Up Down", "bpm"], ["1 2 Tab", "plant"], ["Left Right", "preset"], ["M", "norns / wall"], ["B", "blackout"], ["Esc hold 1 s", "panic"], ["H", "hide controls"], ["F", "full screen"], ["W S D", "kodama phase (?kodama=1)"], ["E", "engine"], ["[ ]", "setup"]];
const keysTable = document.createElement("table");
for (const [k, d] of KEY_ROWS) { const tr = keysTable.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = d; }
keysBox.appendChild(keysTable);
pMore.appendChild(keysBox);
const demosLink = document.createElement("div"); demosLink.className = "note";
demosLink.innerHTML = '<a href="demos/">demos</a>';
pMore.appendChild(demosLink);
applyDefaultPanels();
window.__panels = { openPanel, togglePanel };

// only write the strip when its text changed: no layout work at rest
const setHtml = (id, html) => { const el = $(id); if (el && el.__h !== html) { el.innerHTML = html; el.__h = html; } };
function hudUpdate() {
  if ($("f-src").textContent !== S.source) $("f-src").textContent = S.source;
  for (const id of [1, 2]) {
    const g = S.lastGen[id];
    const ins = live() ? (g && g.instr ? pid(g.instr) : "") : pid(G.instr[id - 1]);
    setHtml("f-p" + id, `${id}${S.active === id ? "*" : ""} <b>${ins}</b> g${g ? g.gen : "-"}/${g ? g.max : "-"}`);
  }
  const ln = S.lastNote;
  setHtml("f-note", ln ? `note <b>${ln.note}</b> ${noteName(ln.note)}${ln.arp ? " arp" : ln.layer ? " loop" : ""}` : "note <b>-</b>");
  setHtml("f-bpm", `<b>${S.bpm}</b> bpm`);
  setHtml("f-seed", `seed <b>${S.seed}</b>`);
  setHtml("f-loops", `loops <b>${G.layers.length}</b>/${MAX_LAYERS} · ${LOOP_BARS} bar`);
  setHtml("f-out", S.audio ? (S.outDb > -200 ? `out <b>${Math.max(-99, Math.round(S.outDb))}</b> dB` : "out <b>-</b>") : "");
  $("f-nosig").classList.toggle("show", !!S.outSilent);
  $("b-play").classList.toggle("on", S.playing);
  if ($("b-play").textContent !== (S.playing ? "stop" : "play")) $("b-play").textContent = S.playing ? "stop" : "play";
  if ($("b-mode").textContent !== S.mode) $("b-mode").textContent = S.mode;
  if ($("b-engine").textContent !== G.engineMode) $("b-engine").textContent = G.engineMode;
  const m = S.outDb > -60 ? (S.outDb + 60) / 60 : 0;
  $("meter").firstChild.style.transform = `scaleY(${S.audio ? Math.min(1, m).toFixed(3) : 0})`;
  refreshAll();
}
setInterval(hudUpdate, 200);

// ------------------------------------------------------------------ drawing
const canvas = $("c");
const ctx = canvas.getContext("2d");
const small = document.createElement("canvas"); // 128 x 64 norns OLED
small.width = DRAW.w; small.height = DRAW.h;
const sctx = small.getContext("2d");
const lastGood = document.createElement("canvas");
let lastGoodAt = 0;
let drawn = []; // [{id, geom, layer?}] from the last render

const stage = new Stage(canvas);
const stageEl = $("stage");
window.__stage = stage;
function resize() {
  const r = stageEl.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w, h, cssW, cssH;
  if (S.mode === "norns") {
    const s = Math.max(1, Math.floor(Math.min(W / DRAW.w, H / DRAW.h)));
    w = Math.round(DRAW.w * s * dpr); h = Math.round(DRAW.h * s * dpr); cssW = DRAW.w * s; cssH = DRAW.h * s;
    S.scale = s;
  } else {
    w = Math.round(W * dpr); h = Math.round(H * dpr); cssW = W; cssH = H;
    S.scale = null;
  }
  canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
  // only a real size change touches the canvas (assigning width clears it), and it redraws in the same task,
  // so the iOS address bar showing and hiding never leaves a blank frame
  if (stage.setSize(w, h, dpr)) {
    lastGood.width = Math.max(1, w); lastGood.height = Math.max(1, h);
    if (!S.panic) { try { paint(performance.now()); } catch (e) { S.errors++; } }
  }
}
function toggleHud() { hud.classList.toggle("hidden"); resize(); }

window.addEventListener("resize", resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe(stageEl);

// norns screen levels 0..15 shown with a light gamma so level 1 and 3 read on a projector
const level = (l) => { const v = Math.round(255 * Math.pow(l / 15, 0.5)); return `rgb(${v},${v},${v})`; };

function drawNorns() {
  sctx.fillStyle = "#000"; sctx.fillRect(0, 0, DRAW.w, DRAW.h);
  sctx.lineWidth = 1;
  for (const d of drawn) {
    if (d.id > 2) continue; // the device draws its two plants only
    const g = d.geom;
    const lv = d.id === S.active ? 3 : 1; // flora plant1/2_screen_level
    sctx.strokeStyle = level(lv);
    sctx.beginPath();
    for (const s of g.segments) { sctx.moveTo(s.x1, s.y1); sctx.lineTo(s.x2, s.y2); }
    for (const c of g.circles) { sctx.moveTo(c.x + 1, c.y); sctx.arc(c.x, c.y, 1, 0, Math.PI * 2); }
    sctx.stroke();
    const n = noteAt.get(d.id);
    if (n && n.x >= 0 && performance.now() - n.t < 1500) {
      const b = 10 + Math.floor(5 * Math.max(0, 1 - (performance.now() - n.t) / 1500));
      sctx.strokeStyle = level(b);
      sctx.beginPath(); sctx.arc(n.x, n.y, 1, 0, Math.PI * 2); sctx.stroke();
    }
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
}

const reduceMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
function stageItems() {
  return G.geometry().map((d) => ({ ...d, group: d.layer ? 2 - (d.layer.serial % 2) : d.id, dim: d.layer ? 0.55 : 0, scale: d.layer ? 0.8 : 1, size: d.layer ? undefined : d.plant.userScale ?? 1 }));
}
function drawWall(t) {
  const W = canvas.width, H = canvas.height;
  if (S.playing && !reduceMotion) stage.swayT += Math.min(100, Math.max(0, t - (S.swayLast ?? t)));
  S.swayLast = t;
  stage.swayAmp = reduceMotion ? 0 : (S.sway ?? 0.012);
  stage.update(stageItems(), t);
  stage.draw(S.active, lit);
  const lw = stage.lineWidth();
  if (S.flags.shanshui && S.flood > 0) {
    const wy = H * (1 - S.flood);
    ctx.fillStyle = "rgba(46, 74, 140, 0.35)"; ctx.fillRect(0, wy, W, H - wy);
    ctx.strokeStyle = "#9FC8F0"; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(0, wy); ctx.lineTo(W, wy); ctx.stroke();
  }
  // arpeggiator: a pulse along the bottom edge
  if (G.arp.mode !== "off" && S.lastNote?.arp) {
    const age = (performance.now() - (S.lastArpAt || 0)) / 1000;
    const a = Math.max(0, 1 - age * 4);
    if (a > 0) { ctx.fillStyle = `rgba(159, 200, 240, ${(a * 0.6).toFixed(3)})`; ctx.fillRect(0, H - lw * 2, W * Math.min(1, (S.lastNote.note % 24) / 24), lw); }
  }
  if (S.flags.shanshui && S.weather > 0) {
    ctx.fillStyle = `rgba(159, 200, 240, ${(S.weather * 0.45).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
}
on("note", (n) => { if (n.arp) S.lastArpAt = performance.now(); else if (n.idx > 0) stage.addMark(n.plant, n.idx); });

function decay(dt) {
  const f = Math.exp(-dt / 0.45);
  for (const L of lit.values()) for (const [i, b] of L) { const nb = b * f; if (nb < 0.02) L.delete(i); else L.set(i, nb); }
}

let lastT = performance.now();
let frameIx = 0;
function paint(t) {
  if (S.mode === "norns") {
    // the device view keeps flora's redraw: check_plant_position, then the plants, at 15 fps
    if (frameIx++ % 4 === 0 || !drawn.length) {
      drawn = G.render();
      for (const d of drawn) if (d.id <= 2) S.segments[d.id] = d.geom.segments.length;
    }
    drawNorns();
  } else {
    drawWall(t);
    for (const d of stage.items) if (d.id <= 2) S.segments[d.id] = d.geom.segments.length;
  }
}
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (t - lastT) / 1000); lastT = t;
  if (canvas.width === 0 || canvas.height === 0) { resize(); return; }
  if (S.panic) {
    if (lastGood.width > 0 && lastGood.height > 0) ctx.drawImage(lastGood, 0, 0);
    return;
  }
  try {
    decay(dt);
    paint(t);
    S.frames++;
    if (t - lastGoodAt > 1000 && canvas.width > 0 && canvas.height > 0) { lastGood.getContext("2d").drawImage(canvas, 0, 0); lastGoodAt = t; }
  } catch (e) {
    S.errors++;
    if (S.errors < 5) console.warn("frame", e);
    try { if (lastGood.width > 0) ctx.drawImage(lastGood, 0, 0); } catch {}
  }
}

initGestures({ canvas, pick: (x, y) => stage.pick(x, y), act, S, angleOf, lengthOf,
  onLongPress: () => act.palette(),
  onEmptyTap: () => { if (hud.classList.contains("hidden")) toggleHud(); } });

// ------------------------------------------------------------------ start
if (wsUrl) S.source = "connecting"; // until the bridge answers, show the sim garden still
resize();
requestAnimationFrame(frame);

// Enable: audio + MIDI, only on click (AV-STANDARD rule 2)
$("b-enable").onclick = async () => {
  $("b-enable").disabled = true;
  try {
    const m = await import("./audio.js");
    await m.enable({ S, on, act, catalog });
    $("b-enable").classList.add("on");
    $("b-enable").textContent = "enabled";
  } catch (e) {
    console.warn("enable", e);
    $("b-enable").textContent = "enable failed";
  }
  $("b-enable").disabled = false;
};
S.master = S.master ?? 0.7;

// ?kodama=1: phase presets W S D (Tier 4)
// ?score=1: the ambient score on a synthetic scene (score-page.js)
if (q.get("score") === "1") import("./score-page.js").then((m) => m.init({ S, act, q, on })).catch((e) => console.warn("score", e));
if (S.flags.kodama) import("./kodama.js").then((m) => m.init({ S, act })).catch((e) => console.warn("kodama", e));
emit("state", S);

// a share link: #s=<base64url of the compressed setup>
async function loadFromHash() {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return;
  try { act.loadSetup(await decodeSetup(m[1]), { now: true }); say("link loaded"); }
  catch (e) { say("link not readable"); }
}
window.addEventListener("hashchange", loadFromHash);
await loadFromHash();
