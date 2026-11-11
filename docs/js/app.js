// app.js · sonar page: renderer + sim garden (garden.js) + live (OSC over WebSocket) + keys + controls.
// Audio engines and MIDI load only after the Enable click (audio.js, midi.js).
import { Plant, LSystem, Turtle, makeRandom, DRAW } from "./lsys.js";
import { Garden, LOOP_BARS, MAX_LAYERS, MAX_FOREST, SCALE_NAMES, ARP_MODES, ARP_RATES, ARP_ENGINES, noteName, hashSeed, validatePlant, PLANT_ALPHABET } from "./garden.js";
import { ARCHETYPES } from "./roots.js";
import { initPalette } from "./palette.js";
import { BUILTIN, specOf, isSample } from "./voices.js";
import { putSample, listSamples, deleteSample, nextSampleId, persistentSamples, bankFile, readBankFile, AUDIO_EXT } from "./samples.js";
import { OscWs } from "./osc-ws.js";
import { Stage, arrangeForest } from "./stage.js";
import { addPanel, group, slider, select, buttons, button, note, refreshAll, openPanel, togglePanel, applyDefaultPanels, controls, onRefresh, randomize } from "./ui.js";
import { initGestures } from "./gestures.js";
import { setupLabel, encodeSetup, decodeSetup, createStore, exportText, parseImport } from "./setups.js";
import { createMapper, describe, DEFAULT_V020 } from "./midimap.js";
import { createBus } from "./bus.js";
import { parseVanaPath, vanaSlotToRoots, phyllaToPlant } from "./vana.js";

const q = new URLSearchParams(location.search);
const catalog = await (await fetch(new URL("./catalog.json", import.meta.url))).json();
const D = catalog.defaults;
const NPRESETS = catalog.plants.length;
const factory = await fetch(new URL("./setups.json", import.meta.url)).then((r) => r.json()).catch(() => []);
const pid = (n) => (n > 1000 ? "u" + (n - 1000) : "p" + String(n).padStart(2, "0"));
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
  if (idx) litOf(plant).set(idx, 1); // negative: a root tip
  if (!ev.arp && !ev.flourish) noteAt.set(plant, { x, y, idx, t: performance.now() });
  S.notes++;
  S.lastNote = { plant, idx, note: ev.note, freq: ev.freq, arp: !!ev.arp, layer: ev.layer || 0 };
  emit("note", { ...ev, active: plant === S.active });
}

// ------------------------------------------------------------------ live (bridge)
let link = null;
let vanaHook = null; // set by the bus section below: VANA's /phylla/ messages
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
    default: if (vanaHook && path.startsWith("/phylla/")) vanaHook(path, a); break;
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
let onSetupMidi = null; // set by the MIDI panel below: a setup may carry its map
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
  if (onSetupMidi) onSetupMidi();
  syncUrl();
  emit("state", S);
  if (G.samples.length && S.missingSamples) S.missingSamples().then((m) => { if (m.length) say("missing: " + m.map((x) => x.name).join(", ") + "; built-in voices play"); });
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
  // a latching silence: the garden keeps playing and drawing, nothing sounds until it is pressed again
  kill(v) { S.kill = v === undefined ? !S.kill : !!v; emit("state", S); },
  // every control marked random, from one seed; the values land in the setup and its share link
  randomize(seed) {
    if (live()) return;
    const sd = (seed ?? newSeed()) >>> 0;
    randomize(makeRandom(sd));
    G.randomSeed = sd;
    emit("state", S);
    return sd;
  },
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
  // a catalog number or a user plant definition, on the active plant
  assign(x) {
    const k = S.active - 1;
    if (live()) { if (typeof x === "number" && x <= NPRESETS && k < 2) { S.instr[k] = x; link.send(`/param/plant${S.active}_instructions`, [x]); } return; }
    const instr = typeof x === "number" ? x : G.addCustom(x);
    G.setup(k, instr); S.instr = G.instr; litOf(S.active).clear();
    emit("state", S);
  },
  roots(o) { if (live()) return; G.setRoots(S.active, o); emit("state", S); },
  voice(id, k, v) { G.setVoiceParam(id, k, v); emit("state", S); },
  mixVoice(id, o) { G.setMixVoice(id, o); emit("state", S); },
  fx(o) { G.setFx(o); emit("state", S); },
  plantOpt(o) { if (live()) return; G.setPlantOpt(S.active, o); emit("state", S); },
  bass(o) { G.setBass(o); emit("state", S); },
  forest(o) { if (live()) return; G.setForest(o); S.instr = G.instr; if (S.active > G.plants.length) act.plant(1); emit("state", S); },
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
    g: () => act.cueGo?.(), G: () => act.cueBack?.(),
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
slider(pTempo, { id: "r-bpm", label: "bpm", min: 20, max: 300, rlo: 60, rhi: 140, get: () => S.bpm, set: (v) => act.bpm(v) });
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
// sounds stored in this browser stay routable, whatever setup is loaded
let storedRefs = [];
const sampleRefs = () => { const m = new Map(); for (const x of [...storedRefs, ...G.samples]) m.set(x.id, x); return [...m.values()].sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3))); };
const voiceOpts = () => [["", "default"], ...BUILTIN.map((v) => [v, v]), ...sampleRefs().map((x) => [x.id, `smp ${x.id.slice(3)} (${x.name})`])];
const VOICE_OPTS = voiceOpts();
const sRoute = select(pPlants, { id: "s-route", label: "voice", label2: "active plant voice", options: VOICE_OPTS, get: () => G.routes[S.active] ?? "", set: (v) => act.route(S.active, v), random: false });
const sLoopRoute = select(pPlants, { id: "s-route-loops", label: "loop voice", options: VOICE_OPTS, get: () => G.layerRoute ?? "", set: (v) => act.layerRoute(v), random: false });
buttons(pPlants, [
  { id: "b-gen", label: "next gen", title: "N or two-finger tap", fire: () => act.nextGen() },
  { id: "b-palette", label: "palette", title: "long press a plant", fire: () => act.palette(), noMap: true },
  { id: "b-editor", label: "plant editor", fire: () => pal.toggleEditor(), noMap: true },
]);
const plantStore = createStore("sonar.plants.v1");
const palHost = document.createElement("div"); palHost.id = "palette"; pPlants.appendChild(palHost);
const pal = initPalette({ host: palHost, D, catalog, act, store: plantStore, say: (t) => { const n = document.getElementById("setup-note"); if (n) n.textContent = t; },
  state: () => ({ instr: G.instr[S.active - 1], archetype: G.roots[S.active]?.archetype }) });
onRefresh(pal.refresh);

group(pPlants, "active plant");
select(pPlants, { id: "s-pmode", label: "pitch mode", options: [["flora", "flora"], ["walk", "walk"]], get: () => G.plantOpts[S.active]?.mode ?? "flora", set: (v) => act.plantOpt({ mode: v }) });
slider(pPlants, { id: "r-wild", label: "wildness", min: 0, max: 0.6, step: 0.01, get: () => G.plantOpts[S.active]?.wildness ?? 0, set: (v) => act.plantOpt({ wildness: v }), fmt: (x) => Math.round(x * 100) + " %" });
slider(pPlants, { id: "r-pdensity", label: "density", label2: "plant density", min: 0, max: 1, step: 0.01, rlo: 0.5, rhi: 1, get: () => G.plantOpts[S.active]?.density ?? 1, set: (v) => act.plantOpt({ density: v }), fmt: (x) => Math.round(x * 100) + " %" });

// ------------------------------------------------------------------ voices, space, sounds, banks
const pVoices = addPanel("voices", "voices");
S.editVoice = "pluck";
const allVoices = () => [...BUILTIN, ...sampleRefs().map((x) => x.id)];
group(pVoices, "mixer");
for (const id of BUILTIN) group(pVoices, id, {
  solo: { id: `b-solo-${id}`, label: `${id} solo`, get: () => !!G.mix[id]?.solo, set: (v) => act.mixVoice(id, { solo: v }) },
  mute: { id: `b-mute-${id}`, label: `${id} mute`, get: () => !!G.mix[id]?.mute, set: (v) => act.mixVoice(id, { mute: v }) },
});
group(pVoices, "edit");
const sEdit = select(pVoices, { id: "s-voice-edit", label: "voice", options: allVoices(), get: () => S.editVoice, set: (v) => { S.editVoice = v; refreshAll(); }, random: false });
const vRows = [];
const tag = (el, voice) => { const row = el.closest(".ctl, .btns") || el; row.dataset.voice = voice; vRows.push(row); };
for (const id of [...BUILTIN, "smp"]) {
  const spec = specOf(id === "smp" ? "smp1" : id), cur = () => (id === "smp" ? S.editVoice : id);
  for (const [k, sp] of Object.entries(spec)) {
    const sid = `v-${id}-${k}`;
    if (sp.bool) { tag(buttons(pVoices, [{ id: "b-" + sid, label: k, label2: `${id} ${k}`, fire: () => act.voice(cur(), k, !G.voiceParams[cur()]?.[k]), on: () => !!G.voiceParams[cur()]?.[k] }]), id); continue; }
    const fmt = (x) => (sp.step >= 1 ? String(Math.round(x)) : Number(x).toFixed(sp.step < 0.01 ? 3 : 2)) + (sp.unit ? " " + sp.unit : "");
    tag(slider(pVoices, { id: "r-" + sid, label: k, label2: `${id} ${k}`, min: sp.lo, max: sp.hi, step: sp.step, rlo: sp.rlo, rhi: sp.rhi, random: !sp.norand, get: () => G.voiceParams[cur()]?.[k] ?? sp.def, set: (v) => act.voice(cur(), k, v), fmt }), id);
  }
}
// delay for the voice being edited (saw and rain keep their own rows in the delay tab)
const dOf = () => G.delays[S.editVoice] || { amount: 0, div: "d1/8", feedback: 0.45, lowpass: 2400, pingpong: false };
group(pVoices, "delay, edit voice");
slider(pVoices, { id: "r-vdamt", label: "amount", label2: "edit voice delay", min: 0, max: 1, step: 0.01, get: () => dOf().amount, set: (v) => act.delayOf(S.editVoice, { amount: v }), fmt: (x) => x.toFixed(2) });
select(pVoices, { id: "s-vddiv", label: "time", label2: "edit voice delay time", options: [["1/16", "1/16"], ["1/8", "1/8"], ["d1/8", "dotted 1/8"], ["1/4", "1/4"], ["1/2", "1/2"]], get: () => dOf().div, set: (v) => act.delayOf(S.editVoice, { div: v }) });
slider(pVoices, { id: "r-vdfb", label: "feedback", label2: "edit voice delay feedback", min: 0, max: 0.85, step: 0.01, get: () => dOf().feedback, set: (v) => act.delayOf(S.editVoice, { feedback: v }), fmt: (x) => x.toFixed(2) });
onRefresh(() => { const want = isSample(S.editVoice) ? "smp" : S.editVoice; for (const r of vRows) { const h = r.dataset.voice !== want; if (r.hidden !== h) r.hidden = h; } });

group(pVoices, "space");
slider(pVoices, { id: "r-reverb", label: "reverb", min: 0, max: 1, step: 0.01, rlo: 0, rhi: 0.5, get: () => G.fx.reverb.amount, set: (v) => act.fx({ reverb: { amount: v } }), fmt: (x) => x.toFixed(2) });
slider(pVoices, { id: "r-revsize", label: "reverb size", min: 0.3, max: 8, step: 0.1, rlo: 1, rhi: 5, get: () => G.fx.reverb.size, set: (v) => act.fx({ reverb: { size: v } }), fmt: (x) => x.toFixed(1) + " s" });
slider(pVoices, { id: "r-wind", label: "wind", min: 0, max: 1, step: 0.01, rlo: 0, rhi: 0.4, get: () => G.fx.wind.level, set: (v) => act.fx({ wind: { level: v } }), fmt: (x) => x.toFixed(2) });
slider(pVoices, { id: "r-windtone", label: "wind tone", min: 100, max: 4000, step: 10, get: () => G.fx.wind.tone, set: (v) => act.fx({ wind: { tone: v } }), fmt: (x) => Math.round(x) + " Hz" });

group(pVoices, "sounds");
note(pVoices, "Files stay in this browser. Nothing is uploaded.", "smp-privacy");
const smpNote = note(pVoices, "", "smp-note");
const smpPick = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aif,.aiff", multiple: true, id: "f-smp" });
smpPick.style.display = "none"; pVoices.appendChild(smpPick);
const refillVoices = async () => {
  try { storedRefs = (await listSamples()).map((x) => ({ id: x.id, name: x.name })); } catch { storedRefs = []; }
  sEdit.refill(allVoices()); sRoute.refill(voiceOpts()); sLoopRoute.refill(voiceOpts()); refreshAll();
};
refillVoices();
async function decodeInto(rec) {
  const A = S.audio;
  if (!A) return;
  try { A.chain.setSample(rec.id, await A.ctx.decodeAudioData(rec.bytes.slice(0))); A.chain.setVoices(G.voiceParams); }
  catch (e) { smpNote.textContent = `${rec.name}: the browser cannot decode it`; }
}
async function addSounds(files) {
  let n = 0;
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { smpNote.textContent = `${f.name}: over 50 MB`; continue; }
    const id = nextSampleId(await listSamples());
    const rec = { id, name: f.name.slice(0, 80), type: f.type, bytes: await f.arrayBuffer() };
    await putSample(rec);
    G.addSampleRef(id, rec.name);
    await decodeInto(rec);
    n++;
  }
  await refillVoices();
  if (n) smpNote.textContent = `added ${n}` + ((await persistentSamples()) ? "" : ", for this page only");
}
smpPick.onchange = () => { addSounds([...smpPick.files]); smpPick.value = ""; };
buttons(pVoices, [
  { id: "b-smp-add", label: "add sounds", noMap: true, fire: () => smpPick.click() },
  { id: "b-smp-remove", label: "remove edit voice", noMap: true, fire: async () => { const id = S.editVoice; if (!isSample(id)) return; await deleteSample(id); G.removeSampleRef(id); S.editVoice = "pluck"; refillVoices(); smpNote.textContent = `removed ${id}`; } },
]);

group(pVoices, "banks");
const bankStore = createStore("sonar.banks.v1");
const bankName = Object.assign(document.createElement("input"), { type: "text", maxLength: 40, autocomplete: "off", id: "t-bank-name" });
{ const row = document.createElement("div"); row.className = "ctl"; const l = document.createElement("label"); l.textContent = "name"; l.htmlFor = bankName.id; row.append(l, bankName); pVoices.appendChild(row); }
const bankSel = document.createElement("select"); bankSel.id = "s-bank";
{ const row = document.createElement("div"); row.className = "ctl"; const l = document.createElement("label"); l.textContent = "saved"; l.htmlFor = bankSel.id; row.append(l, bankSel); pVoices.appendChild(row); }
const refillBanks = () => { const was = bankSel.value; bankSel.textContent = ""; for (const x of bankStore.list()) { const o = document.createElement("option"); o.value = o.textContent = x.name; bankSel.appendChild(o); } if ([...bankSel.options].some((o) => o.value === was)) bankSel.value = was; };
const bankNow = (name) => ({ sonar_bank: 1, name, voices: JSON.parse(JSON.stringify(G.voiceParams)), samples: G.samples.map((x) => ({ ...x })) });
async function missingSamples() { const have = new Set((await listSamples()).map((x) => x.id)); return G.samples.filter((x) => !have.has(x.id)); }
async function useBank(b) {
  for (const [id, p] of Object.entries(b.voices || {})) for (const [k, v] of Object.entries(p)) G.setVoiceParam(id, k, v);
  for (const x of b.samples || []) G.addSampleRef(x.id, x.name);
  G.bankName = b.name ?? null;
  const miss = await missingSamples();
  smpNote.textContent = miss.length ? "missing: " + miss.map((x) => x.name).join(", ") : `bank ${b.name ?? ""}`;
  refillVoices(); emit("state", S);
}
const bankPick = Object.assign(document.createElement("input"), { type: "file", accept: ".sonarbank,.zip", id: "f-bank" });
bankPick.style.display = "none"; pVoices.appendChild(bankPick);
async function importBank(file) {
  try {
    const { bank, audio } = await readBankFile(await file.arrayBuffer());
    const have = await listSamples(), remap = {};
    const samples = [];
    for (const x of bank.samples || []) {
      const bytes = audio.get(x.file);
      if (!bytes) continue;
      const id = nextSampleId([...have, ...samples]);
      remap[x.id] = id;
      await putSample({ id, name: String(x.name).slice(0, 80), type: "", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      samples.push({ id, name: String(x.name).slice(0, 80) });
    }
    const voices = {};
    for (const [id, p] of Object.entries(bank.voices || {})) voices[remap[id] || id] = p;
    const b = { sonar_bank: 1, name: String(bank.name || file.name).slice(0, 40), voices, samples };
    bankStore.put(b.name, b); refillBanks(); bankSel.value = b.name;
    await useBank(b);
    for (const x of samples) { const rec = (await listSamples()).find((r) => r.id === x.id); if (rec) await decodeInto(rec); }
  } catch (e) { smpNote.textContent = "bank not readable"; }
}
bankPick.onchange = () => { if (bankPick.files[0]) importBank(bankPick.files[0]); bankPick.value = ""; };
buttons(pVoices, [
  { id: "b-bank-save", label: "save", noMap: true, fire: () => { const n = bankName.value.trim() || bankStore.nextSlot(); bankStore.put(n, bankNow(n)); G.bankName = n; bankName.value = ""; refillBanks(); bankSel.value = n; smpNote.textContent = `saved bank ${n}`; } },
  { id: "b-bank-load", label: "load", noMap: true, fire: () => { const b = bankStore.get(bankSel.value); if (b) useBank(b); } },
  { id: "b-bank-export", label: "export", noMap: true, fire: async () => { const b = bankStore.get(bankSel.value) || bankNow(G.bankName || "bank"); const blob = await bankFile(b); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sonar_bank_${safeName(b.name || "bank")}_v01.sonarbank`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } },
  { id: "b-bank-import", label: "import", noMap: true, fire: () => bankPick.click() },
]);
refillBanks();
S.missingSamples = missingSamples;

const pRoots = addPanel("roots", "roots");
group(pRoots, "roots, active plant");
select(pRoots, { id: "s-roots", label: "archetype", label2: "roots archetype", options: [["", "none"], ...ARCHETYPES], get: () => G.roots[S.active]?.archetype ?? "", set: (v) => act.roots({ archetype: v || null }), random: false });
for (const k of ["depth", "spread", "density"]) slider(pRoots, { id: "r-root-" + k, label: k, label2: "roots " + k, min: 0, max: 1, step: 0.01, get: () => G.roots[S.active]?.[k] ?? 0.5, set: (v) => act.roots({ [k]: v }), fmt: (x) => x.toFixed(2) });
group(pRoots, "bass");
select(pRoots, { id: "s-bass-oct", label: "octave", label2: "bass octave", options: [[-3, "-3"], [-2, "-2"], [-1, "-1"], [0, "0"], [1, "+1"]], get: () => G.bass.octave, set: (v) => act.bass({ octave: v }) });
slider(pRoots, { id: "r-bass-level", label: "level", label2: "bass level", min: 0, max: 1, step: 0.01, get: () => G.bass.level, set: (v) => act.bass({ level: v }), fmt: (x) => x.toFixed(2) });
slider(pRoots, { id: "r-bass-decay", label: "decay", label2: "bass decay", min: 0.05, max: 2, step: 0.01, get: () => G.bass.decay, set: (v) => act.bass({ decay: v }), fmt: (x) => x.toFixed(2) + " s" });
slider(pRoots, { id: "r-bass-release", label: "release", label2: "bass release", min: 0.05, max: 4, step: 0.01, get: () => G.bass.release, set: (v) => act.bass({ release: v }), fmt: (x) => x.toFixed(2) + " s" });
slider(pRoots, { id: "r-bass-detune", label: "detune", label2: "bass detune", min: 0, max: 50, step: 1, get: () => G.bass.detune, set: (v) => act.bass({ detune: v }), fmt: (x) => x + " ct" });
select(pRoots, { id: "s-bass-sync", label: "sync", label2: "bass sync", options: [[4, "every 4th step"], [6, "every 6th step"], [8, "every 8th step"], [0, "free"]], get: () => G.bass.sync, set: (v) => act.bass({ sync: v }) });
slider(pRoots, { id: "r-drone", label: "drone", label2: "bass drone", min: 0, max: 1, step: 0.01, get: () => G.bass.drone, set: (v) => act.bass({ drone: v }), fmt: (x) => x.toFixed(2) });

const pForest = addPanel("forest", "forest");
group(pForest, "forest");
slider(pForest, { id: "r-forest", label: "plants", label2: "forest size", min: 2, max: MAX_FOREST, get: () => G.plants.length, set: (v) => act.forest({ n: v }), random: false });
slider(pForest, { id: "r-leads", label: "leads", label2: "forest leads", min: 1, max: 4, get: () => G.forest.leads, set: (v) => act.forest({ leads: v }) });
slider(pForest, { id: "r-fdensity", label: "density", label2: "forest density", min: 0, max: 1, step: 0.01, get: () => G.forest.density, set: (v) => act.forest({ density: v }), fmt: (x) => x.toFixed(2) });
slider(pForest, { id: "r-budget", label: "voices", label2: "forest voice budget", min: 1, max: 16, get: () => G.forest.budget, set: (v) => act.forest({ budget: v }) });

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
// a Phylla JSON export (VANA): a user plant when its word fits flora's alphabet; otherwise say why
function importPhylla(j) {
  const r = phyllaToPlant(j, { alphabet: PLANT_ALPHABET });
  const rootsTxt = r.roots?.roots?.archetype ? `, roots ${r.roots.roots.archetype}` : r.roots?.unmapped ? `, roots ${r.roots.unmapped} have no counterpart` : "";
  if (!r.ok) return r.why;
  const v = validatePlant(r.def);
  if (!v.ok) return "Phylla plant: " + v.errors.join(", ") + "; not imported";
  plantStore.put(r.name, v.def);
  return `Phylla plant ${r.name} in the palette${rootsTxt}`;
}
async function importFiles(files) {
  let n = 0, phyllaMsg = "";
  try {
    for (const f of files) {
      const text = await f.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      if (j && !Array.isArray(j) && Array.isArray(j.word)) { phyllaMsg = importPhylla(j); continue; }
      const list = parseImport(text);
      for (const x of list) { G._cleanSetup(x.setup); store.put(x.name || store.nextSlot(), x.setup); n++; }
      for (const pl of list.plants) { const v = validatePlant(pl.def); if (v.ok) plantStore.put(pl.name || "u" + (plantStore.list().length + 1), v.def); }
    }
    pal.fillUsers();
    say(phyllaMsg && !n ? phyllaMsg : `imported ${n}` + (phyllaMsg ? "; " + phyllaMsg : ""));
  } catch (e) { say(`imported ${n}, then a file was not readable`); }
  refillSaved();
}
importBox.onchange = () => { importFiles([...importBox.files]); importBox.value = ""; };
window.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  const fs = [...(e.dataTransfer?.files || [])];
  if (!fs.length) return;
  e.preventDefault();
  const audio = fs.filter((f) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name)), banks = fs.filter((f) => /\.(sonarbank|zip)$/i.test(f.name));
  if (audio.length) addSounds(audio);
  for (const b of banks) importBank(b);
  const rest = fs.filter((f) => !audio.includes(f) && !banks.includes(f));
  if (rest.length) importFiles(rest);
});
const linkBox = mkField("t-setup-link", "link", Object.assign(document.createElement("input"), { type: "text", readOnly: true }));
buttons(pSetups, [
  { id: "b-setup-export", label: "export", noMap: true, fire: () => { const x = store.list().find((y) => y.name === savedSel.value); if (x) download(`sonar_setup_${safeName(x.name)}_v01.json`, exportText([x], plantStore.list())); } },
  { id: "b-setup-all", label: "export all", noMap: true, fire: () => download("sonar_setups_all_v01.json", exportText(store.list(), plantStore.list())) },
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
  { id: "b-kill", label: "kill", title: "a latching silence; press again to sound", fire: () => act.kill(), on: () => !!S.kill },
  { id: "b-randomize", label: "randomize", fire: () => { const sd = act.randomize(); const n = document.getElementById("setup-note"); if (n && sd !== undefined) n.textContent = `randomized ${sd}`; } },
]);
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
const KEY_ROWS = [["Space", "play"], ["N", "next gen"], ["R", "reseed (new seed, new plants)"], ["L", "+ loop: a seeded 4 bar layer from the next bar"], ["C", "clear loops"], ["Shift+R", "reset the plants"], ["A", "arp mode"], ["Up Down", "bpm"], ["1 2 Tab", "plant"], ["Left Right", "preset"], ["M", "norns / wall"], ["B", "blackout"], ["Esc hold 1 s", "panic"], ["H", "hide controls"], ["F", "full screen"], ["W S D", "kodama phase (?kodama=1)"], ["E", "engine"], ["[ ]", "setup"], ["G, Shift+G", "cue go, back"]];
const keysTable = document.createElement("table");
for (const [k, d] of KEY_ROWS) { const tr = keysTable.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = d; }
keysBox.appendChild(keysTable);
pMore.appendChild(keysBox);
const demosLink = document.createElement("div"); demosLink.className = "note";
demosLink.innerHTML = '<a href="demos/">demos</a> · <a href="card/">key card</a>';
pMore.appendChild(demosLink);
// ------------------------------------------------------------------ bus: sonar drives the visuals (bus.js), VANA drives the roots (vana.js)
const bus = createBus({ link });
window.__bus = bus;
bus.on = q.get("bus") === "1";
S.vanaIn = q.get("vana") === "1";
const isLead = (ev) => !ev.arp && !ev.chorus && !ev.bass && !ev.layer && !ev.flourish;
on("note", (ev) => { if (bus.on && !ev.silent && !S.panic) bus.note(ev.engine || "saw", ev.plant, ev.note, ev.freq, ev.vel ?? 0.8, isLead(ev)); });
on("gen", (g) => { if (bus.on) bus.gen(g.plant, g.gen, g.max); });
let busBeat = null, busState = "";
setInterval(() => {
  if (!bus.on) { busBeat = null; return; }
  if (S.playing && !S.panic) {
    const b = Math.floor(nowBeats());
    if (busBeat === null) busBeat = b;
    else if (b !== busBeat) { busBeat = b; bus.beat(b, Math.floor(b / 4), S.bpm); }
  } else busBeat = null;
}, 5);
setInterval(() => { if (bus.on && S.audio?.levels) { const L = S.audio.levels(); bus.level(L.rms, L.peak, L.bands); } }, 33);
const busStateNow = () => {
  if (!bus.on) return;
  const key = `${noteName(G.key.root).replace(/-?\d+$/, "")} ${G.key.scale}`, setup = S.factoryIx >= 0 && factory[S.factoryIx] ? setupLabel(factory[S.factoryIx]) : "";
  const sig = JSON.stringify([key, G.forest.density, G.plants.length, setup]);
  if (sig !== busState) { busState = sig; bus.state(key, G.forest.density, G.plants.length, setup); }
};
on("state", busStateNow);
setInterval(busStateNow, 1000);
// VANA: /phylla/<slot>/root... on the bridge or on the bus, gathered per slot, applied ten times a second
const vanaRaw = { 1: {}, 2: {}, 3: {}, 4: {} }, vanaPending = new Set();
S.vana = { rx: 0, applied: 0, note: "" };
const vanaIn = (path, args) => {
  if (!S.vanaIn) return;
  const p = parseVanaPath(path);
  if (!p) return;
  vanaRaw[p.slot][p.key] = args[0]; vanaPending.add(p.slot); S.vana.rx++;
};
vanaHook = vanaIn;
bus.onIn((m) => { if (m && typeof m.path === "string" && m.path.startsWith("/phylla/")) vanaIn(m.path, Array.isArray(m.args) ? m.args : []); });
setInterval(() => {
  if (!vanaPending.size || live()) return;
  for (const slot of vanaPending) {
    if (slot > G.plants.length) continue;
    const r = vanaSlotToRoots({ ...vanaRaw[slot], current: G.roots[slot]?.archetype });
    if (r.roots === null) { S.vana.note = `slot ${slot}: ${r.unmapped} has no counterpart; roots unchanged`; continue; }
    if (Object.keys(r.roots).length) G.setRoots(slot, r.roots);
    if (r.bass !== undefined) G.setBass({ level: r.bass });
    S.vana.applied++;
  }
  vanaPending.clear();
  emit("state", S);
}, 100);
group(pMore, "bus");
buttons(pMore, [
  { id: "b-bus", label: "bus", title: "send notes, beats and levels to other tabs (sonar-bus)", noMap: true, fire: () => { bus.on = !bus.on; busState = ""; busStateNow(); }, on: () => bus.on },
  { id: "b-vana", label: "vana in", title: "VANA's /phylla/<slot>/root values set the roots of plants 1 to 4", noMap: true, fire: () => { S.vanaIn = !S.vanaIn; }, on: () => !!S.vanaIn },
]);
const busNote = note(pMore, "", "bus-note");
onRefresh(() => {
  const t = (bus.on ? `sent ${bus.sent.note} notes, ${bus.sent.beat} beats` : "bus off") + (S.vanaIn ? ` · vana ${S.vana.rx} in` + (S.vana.note ? `; ${S.vana.note}` : "") : "");
  if (busNote.textContent !== t) busNote.textContent = t;
});

// ------------------------------------------------------------------ Tier 8: macros, record, cue list (each off until touched)
// macros: one control moves several parameters through a curve; sent on the bus; MIDI-mappable like any slider
const curve = { lin: (v) => v, sqrt: (v) => Math.sqrt(v), sq: (v) => v * v };
const MACROS = {
  weather: [
    ["reverb", "sqrt", (x) => act.fx({ reverb: { amount: 0.6 * x } })],
    ["wind", "sq", (x) => act.fx({ wind: { level: 0.4 * x } })],
    ["wind tone", "lin", (x) => act.fx({ wind: { tone: 400 + 1100 * x } })],
    ["delay feedback", "lin", (x) => { for (const e of ARP_ENGINES) G.setDelay(e, { feedback: 0.3 + 0.4 * x }); }],
  ],
  depth: [
    ["roots depth", "lin", (x) => { for (const [id, R] of Object.entries(G.roots)) if (R?.archetype) G.setRoots(Number(id), { depth: 0.2 + 0.8 * x }); }],
    ["bass level", "sqrt", (x) => G.setBass({ level: 0.3 + 0.7 * x })],
    ["drone", "sq", (x) => G.setBass({ drone: 0.5 * x })],
  ],
  motion: [
    ["bpm", "lin", (x) => act.bpm(60 + 80 * x)],
    ["flourish", "sq", (x) => G.setFlourish(0.6 * x)],
    ["arp gate", "lin", (x) => { for (const e of ARP_ENGINES) G.setArp({ gate: Math.round(30 + 60 * x) }, e); }],
  ],
  density: [
    ["forest density", "lin", (x) => G.setForest({ density: 0.2 + 0.8 * x })],
    ["plant density", "sqrt", (x) => { for (let id = 1; id <= G.plants.length; id++) G.setPlantOpt(id, { density: 0.4 + 0.6 * x }); }],
  ],
};
S.macros = { weather: 0, depth: 0, motion: 0, density: 0 };
const setMacro = (name, v) => {
  if (live()) return;
  S.macros[name] = Math.max(0, Math.min(1, v));
  for (const [, c, f] of MACROS[name]) f(curve[c](S.macros[name]));
  bus.macro(name, S.macros[name]);
  emit("state", S);
};
act.macro = setMacro;
group(pMore, "macros");
for (const name of Object.keys(MACROS)) slider(pMore, { id: "r-macro-" + name, label: name, label2: "macro " + name, min: 0, max: 1, step: 0.01, get: () => S.macros[name], set: (v) => setMacro(name, v), fmt: (x) => Math.round(x * 100) + " %", random: false });
note(pMore, Object.entries(MACROS).map(([n, l]) => `${n}: ${l.map((x) => x[0]).join(", ")}`).join(" · "), "macro-note");

// record: the output (and optionally the stage) to a file, the setup beside it
group(pMore, "record");
const stampNow = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const pickMime = (list) => list.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "";
const recNote = note(pMore, "", "rec-note");
let rec = null;
function recordToggle(video) {
  if (rec) { rec.r.stop(); return; }
  if (!S.audio?.recordStream || typeof MediaRecorder === "undefined") { recNote.textContent = typeof MediaRecorder === "undefined" ? "no MediaRecorder in this browser" : "enable first"; return; }
  const audio = S.audio.recordStream();
  const stream = video ? new MediaStream([...$("c").captureStream(30).getVideoTracks(), ...audio.getAudioTracks()]) : audio;
  const mime = video ? pickMime(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) : pickMime(["audio/webm;codecs=opus", "audio/webm"]);
  const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), chunks = [], stamp = stampNow(), setup = G.toSetup(), t0 = performance.now();
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.onstop = () => {
    const kind = video ? "video" : "take", blob = new Blob(chunks, { type: mime || "audio/webm" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sonar_${kind}_${stamp}_v01.webm`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    download(`sonar_${kind}_${stamp}_setup_v01.json`, JSON.stringify(setup));
    recNote.textContent = `saved sonar_${kind}_${stamp}_v01.webm, ${(blob.size / 1e6).toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    rec = null; refreshAll();
  };
  r.start(1000);
  rec = { r, t0, video };
  recNote.textContent = "recording";
}
buttons(pMore, [
  { id: "b-rec", label: "rec", title: "record the output to a .webm, with the setup as .json", fire: () => recordToggle(false), on: () => !!rec && !rec.video },
  { id: "b-rec-video", label: "rec video", title: "the stage and the output to a .webm", fire: () => recordToggle(true), on: () => !!rec && rec.video },
]);
onRefresh(() => { if (rec) { const t = `recording ${((performance.now() - rec.t0) / 1000).toFixed(0)} s`; if (recNote.textContent !== t) recNote.textContent = t; } });

// cue list: setups pinned to bars, each with its morph; run plays it, go and back step it
const CUE_KEY = "sonar.cues.v1";
let cues = [];
try { const c = JSON.parse(localStorage.getItem(CUE_KEY) || "[]"); if (Array.isArray(c)) cues = c.filter((x) => x && Number.isFinite(x.bar) && x.setup).slice(0, 64); } catch {}
const saveCues = () => { try { localStorage.setItem(CUE_KEY, JSON.stringify(cues)); } catch {} };
S.cueRun = false; S.cueIx = -1;
let cueBar0 = 0;
group(pSetups, "cues");
const cueBar = mkField("n-cue-bar", "at bar", Object.assign(document.createElement("input"), { type: "number", min: 0, max: 9999, step: 1, value: 0 }));
const cueList = note(pSetups, "", "cue-list");
const showCues = () => { cueList.textContent = cues.length ? cues.map((c, i) => `${i === S.cueIx ? "> " : ""}${i + 1} bar ${c.bar}${c.morph ? ` morph ${c.morph}` : ""} ${setupLabel(c.setup, "")}`.trim()).join(" · ") : "no cues"; };
const cueGo = (dir) => {
  if (!cues.length) return;
  S.cueIx = Math.max(0, Math.min(cues.length - 1, S.cueIx + dir));
  const c = cues[S.cueIx];
  act.loadSetup(c.setup, { bars: c.morph });
  showCues();
};
act.cueGo = () => cueGo(1);
act.cueBack = () => cueGo(-1);
act.cues = (list) => { if (list) { cues = list.slice(0, 64).sort((a, b) => a.bar - b.bar); saveCues(); showCues(); } return cues; };
let cueClear = false;
buttons(pSetups, [
  { id: "b-cue-add", label: "add cue", noMap: true, fire: () => { const bar = Math.max(0, Math.round(Number(cueBar.value) || 0)); cues = cues.filter((c) => c.bar !== bar); cues.push({ bar, morph: S.morph, setup: G.toSetup() }); cues.sort((a, b) => a.bar - b.bar); saveCues(); showCues(); cueBar.value = bar + 8; } },
  { id: "b-cue-run", label: "run", title: "play the cue list from the next bar", fire: () => { S.cueRun = !S.cueRun; if (S.cueRun) { cueBar0 = Math.ceil(nowBeats() / 4); S.cueIx = -1; if (!S.playing) act.play(true); } showCues(); }, on: () => S.cueRun },
  { id: "b-cue-go", label: "go", title: "G: the next cue", fire: () => cueGo(1) },
  { id: "b-cue-back", label: "back", title: "Shift+G: the cue before", fire: () => cueGo(-1) },
]);
buttons(pSetups, [
  { id: "b-cue-clear", label: "clear cues", noMap: true, fire: () => { const b = $("b-cue-clear"); if (!cueClear) { cueClear = true; b.textContent = "clear cues?"; setTimeout(() => { cueClear = false; b.textContent = "clear cues"; }, 3000); return; } cueClear = false; b.textContent = "clear cues"; cues = []; S.cueIx = -1; saveCues(); showCues(); } },
  { id: "b-cue-export", label: "export cues", noMap: true, fire: () => download("sonar_cues_v01.json", JSON.stringify({ format: "sonar cues", v: 1, cues }, null, 1)) },
]);
showCues();
setInterval(() => {
  if (!S.cueRun || !cues.length || live()) return;
  // armed half a beat early: loadSetup lands on the next bar line, which is then the cue's own bar
  const b = nowBeats() + 0.5;
  while (S.cueIx + 1 < cues.length && (cueBar0 + cues[S.cueIx + 1].bar) * 4 <= b) { S.cueIx++; act.loadSetup(cues[S.cueIx].setup, { bars: cues[S.cueIx].morph }); showCues(); }
}, 20);

// ------------------------------------------------------------------ MIDI: bindings, learn, maps, out, clock (AV-STANDARD v02)
// acts the page has beyond the panels' controls; bpm and angle keep v0.2.0's CC ranges
const MIDI_CORE = {
  play: { label: "play", kind: "act", fire: () => act.play() },
  stop: { label: "stop", kind: "act", fire: () => act.play(false) },
  nextGen: { label: "next gen", kind: "act", fire: () => act.nextGen() },
  reseed: { label: "reseed", kind: "act", fire: () => act.reseed() },
  addLayer: { label: "+ loop", kind: "act", fire: () => act.addLayer() },
  clearLayers: { label: "clear loops", kind: "act", fire: () => act.clearLayers() },
  plantNext: { label: "next plant", kind: "act", fire: () => act.plantNext() },
  arpCycle: { label: "arp mode", kind: "act", fire: () => act.arpCycle() },
  blackout: { label: "blackout", kind: "toggle", get: () => !!S.blackoutOn, set: (v) => act.blackout(!!v) },
  panic: { label: "panic", kind: "toggle", get: () => !!S.panic, set: (v) => act.panic(!!v) },
  bpm: { label: "bpm 40-160", kind: "range", lo: 40, hi: 160, step: 0, get: () => S.bpm, set: (v) => act.bpm(v) },
  angle: { label: "angle 0-120", kind: "range", lo: 0, hi: 120, step: 0, get: () => S.angleNow ?? 30, set: (v) => { S.angleNow = v; act.angle(v); } },
};
const midiTarget = (id) => {
  if (MIDI_CORE[id]) return MIDI_CORE[id];
  const c = controls.get(id);
  if (!c) return null;
  if (c.kind === "range") return { kind: "range", lo: c.lo, hi: c.hi, step: c.step, get: c.get, set: c.set };
  if (c.kind === "select") return { kind: "select", options: c.options, get: c.get, set: c.set };
  if (c.kind === "toggle") return { kind: "toggle", get: c.get, set: c.set };
  if (c.kind === "act") return { kind: "act", fire: c.fire };
  return null;
};
const mapper = createMapper({ resolve: midiTarget });
act.midiMapper = () => mapper;
window.__midiMap = mapper;
const MIDI_KEY = "sonar-midi-v1" + (new URLSearchParams(location.search).get("i") ? "-" + new URLSearchParams(location.search).get("i").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) : "");
const saveMidi = () => { G.midiMap = mapper.toJSON(); try { localStorage.setItem(MIDI_KEY, JSON.stringify(G.midiMap)); } catch {} };
{
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(MIDI_KEY) || "null"); } catch {}
  mapper.load(Array.isArray(stored) ? stored : DEFAULT_V020);
  G.midiMap = mapper.toJSON();
}
// a setup that carries a map brings it; one that does not keeps the current map
onSetupMidi = () => { if (G.midiMap) { mapper.load(G.midiMap); saveMidi(); } else G.midiMap = mapper.toJSON(); mapper.resetPickup(); renderMidi(); };

const pMidi = addPanel("midi", "midi");
const midiNote = note(pMidi, typeof navigator.requestMIDIAccess === "function" ? "MIDI starts with enable." : "Web MIDI is not in this browser; everything else works.", "midi-status");
onRefresh(() => { const m = S.midi; if (m && m.status && typeof navigator.requestMIDIAccess === "function") { const t = `MIDI: ${m.status}`; if (midiNote.textContent !== t) midiNote.textContent = t; } });
group(pMidi, "maps");
const MAP_FILES = [["v020-notes", "v0.2.0 notes", "data/midi-maps/sonar_v020-notes_v01.json"], ["nanokontrol", "nanoKONTROL, verify with the wizard", "data/midi-maps/sonar_nanokontrol_v01.json"]];
let mapPick = "v020-notes";
select(pMidi, { id: "s-midimap", label: "map", options: MAP_FILES.map((x) => [x[0], x[1]]), get: () => mapPick, set: (v) => { mapPick = v; }, random: false });
const midiSay = note(pMidi, "", "midi-note");
let clearArmed = false;
const midiFile = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json", id: "f-midimap" });
midiFile.style.display = "none"; pMidi.appendChild(midiFile);
buttons(pMidi, [
  { id: "b-midimap-load", label: "load", noMap: true, fire: async () => {
    const f = MAP_FILES.find((x) => x[0] === mapPick);
    try { const j = await (await fetch(f[2])).json(); mapper.load(j.bindings); saveMidi(); renderMidi(); midiSay.textContent = `loaded ${f[1]}`; } catch { midiSay.textContent = "map not readable"; }
  } },
  { id: "b-midi-clearall", label: "clear all", noMap: true, fire: () => {
    const b = $("b-midi-clearall");
    if (!clearArmed) { clearArmed = true; b.textContent = "clear all?"; setTimeout(() => { clearArmed = false; b.textContent = "clear all"; }, 3000); return; }
    clearArmed = false; b.textContent = "clear all"; mapper.clearAll(); saveMidi(); renderMidi(); midiSay.textContent = "cleared";
  } },
  { id: "b-midi-export", label: "export", noMap: true, fire: () => download("av-bindings_sonar_v01.json", JSON.stringify({ format: "sonar midi map", v: 1, bindings: mapper.toJSON() }, null, 1)) },
  { id: "b-midi-import", label: "import", noMap: true, fire: () => midiFile.click() },
]);
midiFile.onchange = async () => {
  const f = midiFile.files[0]; midiFile.value = "";
  if (!f) return;
  try { const j = JSON.parse(await f.text()); const list = Array.isArray(j) ? j : j.bindings; if (!Array.isArray(list)) throw 0; mapper.load(list); saveMidi(); renderMidi(); midiSay.textContent = `imported ${mapper.bindings.length}`; } catch { midiSay.textContent = "not a midi map"; }
};
group(pMidi, "out and clock");
S.midiOut = { port: "", notes: false, clock: false };
const outSel = select(pMidi, { id: "s-midiout", label: "output", options: [["", "none"]], get: () => S.midiOut.port, set: (v) => { S.midiOut.port = v; }, random: false });
const fillPorts = () => outSel.refill([["", "none"], ...(S.midi?.outputs || []).map((o) => [o.id, o.name || o.id])]);
buttons(pMidi, [
  { id: "b-midiout-notes", label: "notes out", noMap: true, fire: () => { S.midiOut.notes = !S.midiOut.notes; }, on: () => S.midiOut.notes },
  { id: "b-midiout-clock", label: "clock out", noMap: true, fire: () => { S.midiOut.clock = !S.midiOut.clock; }, on: () => S.midiOut.clock },
  { id: "b-midi-clockin", label: "clock in", noMap: true, fire: () => { S.clockIn = !S.clockIn; }, on: () => !!S.clockIn },
]);
note(pMidi, "out channels: saw 1, rain 2, pluck 3, sine 4, water 5, bass 6, sounds 7");
group(pMidi, "bindings");
const conflictNote = note(pMidi, "", "midi-conflicts");
const mtab = document.createElement("div"); mtab.id = "midi-table"; mtab.className = "mtab"; pMidi.appendChild(mtab);
const midiActs = () => [...Object.entries(MIDI_CORE).map(([id, t]) => [id, t.label]), ...[...controls.values()].map((c) => [c.id, c.label])];
let shownLearn = -1, shownLearning = null;
function renderMidi() {
  if (!pMidi.classList.contains("open")) { shownLearn = -1; return; }
  shownLearn = mapper.learned; shownLearning = mapper.learning;
  const conflicts = mapper.conflicts(), inConflict = new Set(conflicts.flatMap((c) => c.acts));
  conflictNote.textContent = conflicts.length ? "conflict: " + conflicts.map((c) => { const [t, ch, n] = c.key.split(":"); const names = new Map(midiActs()); return `${t} ${n}${Number(ch) >= 0 ? " ch" + (Number(ch) + 1) : ""} ${c.acts.map((a) => names.get(a) || a).join(", ")}`; }).join("; ") : "";
  mtab.textContent = "";
  for (const [id, label] of midiActs()) {
    const row = document.createElement("div"); row.className = "mrow" + (inConflict.has(id) ? " conflict" : "");
    const l = document.createElement("span"); l.textContent = label;
    const bs = mapper.bindings.filter((b) => b.act === id);
    const v = document.createElement("b"); v.textContent = bs.length ? bs.map(describe).join(" · ") : "-";
    const lb = document.createElement("button"); lb.id = "learn-" + id; lb.textContent = mapper.learning === id ? "waiting" : "learn";
    lb.classList.toggle("on", mapper.learning === id);
    lb.onclick = () => { mapper.learn(mapper.learning === id ? null : id); renderMidi(); };
    const cb = document.createElement("button"); cb.id = "unbind-" + id; cb.textContent = "clear"; cb.disabled = !bs.length;
    cb.onclick = () => { mapper.clear(id); saveMidi(); renderMidi(); };
    row.append(l, v, lb, cb); mtab.appendChild(row);
  }
}
let savedLearned = 0;
onRefresh(() => {
  if (mapper.learned !== savedLearned) { savedLearned = mapper.learned; saveMidi(); }
  if (mapper.learned !== shownLearn || mapper.learning !== shownLearning) renderMidi();
  if (S.midi && !S.midi.onPorts) { S.midi.onPorts = fillPorts; fillPorts(); }
});
$("tab-midi").addEventListener("click", () => setTimeout(renderMidi, 0));
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
  const forest = G.plants.length > 2;
  return G.geometry().map((d) => {
    // forest plants 3..16 stand at a seeded depth: smaller and dimmer further back
    const depth = forest && !d.layer && d.id > 2 ? 0.2 + 0.8 * (hashSeed(S.seed, d.id + 900) / 4294967296) : 0;
    return { ...d, depth, group: d.layer ? 2 - (d.layer.serial % 2) : d.id, dim: d.layer ? 0.55 : depth * 0.6, scale: d.layer ? 0.8 : 1, size: d.layer ? undefined : d.plant.userScale ?? 1 };
  });
}
function drawWall(t) {
  const W = canvas.width, H = canvas.height;
  if (S.playing && !reduceMotion) stage.swayT += Math.min(100, Math.max(0, t - (S.swayLast ?? t)));
  S.swayLast = t;
  stage.swayAmp = reduceMotion ? 0 : (S.sway ?? 0.012);
  const forest = G.plants.length > 2, compact = H > W;
  stage.groundAll = forest;
  stage.arrangeKey = forest ? `forest|${S.seed}|${compact ? S.active : ""}` : "";
  stage.update(stageItems(), t, forest ? (it, w, h) => arrangeForest(it, w, h, { seed: S.seed, active: S.active, compact }) : undefined);
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
on("note", (n) => { if (n.arp) S.lastArpAt = performance.now(); else if (n.idx) stage.addMark(n.plant, n.idx); });

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
    for (const rec of await listSamples()) { if (!G.samples.some((x) => x.id === rec.id)) G.addSampleRef(rec.id, rec.name); await decodeInto(rec); }
    refillVoices();
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
