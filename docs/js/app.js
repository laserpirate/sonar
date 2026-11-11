// app.js · sonar page: renderer + sim garden (garden.js) + live (OSC over WebSocket) + keys + controls.
// Audio engines and MIDI load only after the Enable click (audio.js, midi.js).
import { Plant, LSystem, Turtle, makeRandom, DRAW } from "./lsys.js";
import { Garden, LOOP_BARS, MAX_LAYERS, SCALE_NAMES, ARP_MODES, ARP_RATES, noteName } from "./garden.js";
import { OscWs } from "./osc-ws.js";
import { Stage } from "./stage.js";

const q = new URLSearchParams(location.search);
const catalog = await (await fetch(new URL("./catalog.json", import.meta.url))).json();
const D = catalog.defaults;
const NPRESETS = catalog.plants.length;
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
const G = new Garden({ catalog, seed: S.seed, instr: instrArg || (q.get("seed") ? null : D.initial_plant_instructions) });
window.__garden = G;
S.instr = G.instr;
G.onGen = (g) => { S.lastGen[g.plant] = { gen: g.gen, max: g.max, instr: g.instr }; lit.get(g.plant)?.clear(); emit("gen", g); };
for (let k = 0; k < 2; k++) S.lastGen[k + 1] = { gen: G.plants[k].currentGeneration, max: G.plants[k].maxGenerations, instr: G.instr[k] };
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
  if (!ev.arp) noteAt.set(plant, { x, y, idx, t: performance.now() });
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
  for (const ev of G.step(nowBeats())) noteEvent(ev);
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
  bpm(v) {
    const b = Math.round(Math.max(20, Math.min(300, v)));
    if (b === S.bpm) return;
    const nb = nowBeats(); S.bpm = b; beat0 = performance.now() - (nb / (b / 60)) * 1000; // keep beat phase
    if (live()) link.send("/param/clock_tempo", [b]);
    emit("state", S);
  },
  pitch(semi) { G.setPitch(semi); if (live()) link.send("/param/root_note_offset", [Math.round(semi)]); emit("state", S); },
  delay(a) { S.delay = clamp01(a); emit("state", S); },
  growth(bars) { G.setGrowth(bars); emit("state", S); },
  key(root, scale) { G.setKey(root, scale); if (live()) { if (root !== undefined) link.send("/param/root_note", [root]); } emit("state", S); },
  arp(o) { G.setArp(o); emit("state", S); },
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
};
window.__sonarAct = act;

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
    h: () => toggleHud(), H: () => toggleHud(),
    f: () => fullscreen(), F: () => fullscreen(), "?": () => keysBox.classList.toggle("show"),
    ArrowLeft: () => act.preset(-1), ArrowRight: () => act.preset(1),
    ArrowUp: () => act.bpm(S.bpm + 2), ArrowDown: () => act.bpm(S.bpm - 2),
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
const keysBox = document.getElementById("keys");
const $ = (id) => document.getElementById(id);
$("b-play").onclick = () => act.play();
$("b-gen").onclick = () => act.nextGen();
$("b-reset").onclick = () => act.reset();
$("b-reseed").onclick = () => act.reseed();
$("b-layer").onclick = () => act.addLayer();
$("b-clear").onclick = () => act.clearLayers();
$("b-mode").onclick = () => act.mode();
$("b-keys").onclick = () => keysBox.classList.toggle("show");
for (const b of hud.querySelectorAll("button")) b.addEventListener("keydown", (e) => { if (e.key === " ") e.preventDefault(); });

// sliders and menus (second row)
const r = (id) => $(id);
r("r-bpm").value = S.bpm;
r("r-bpm").oninput = (e) => act.bpm(Number(e.target.value));
r("r-pitch").value = G.pitch;
r("r-pitch").oninput = (e) => act.pitch(Number(e.target.value));
r("r-delay").value = S.delay;
r("r-delay").oninput = (e) => act.delay(Number(e.target.value));
r("r-growth").value = G.growth;
r("r-growth").oninput = (e) => act.growth(Number(e.target.value));
const selRoot = r("s-root"), selScale = r("s-scale"), selArp = r("s-arp"), selRate = r("s-arprate"), selOct = r("s-arpoct");
for (let n = 33; n <= 60; n++) { const o = document.createElement("option"); o.value = n; o.textContent = noteName(n); selRoot.appendChild(o); }
for (const s of SCALE_NAMES) { const o = document.createElement("option"); o.value = s; o.textContent = s; selScale.appendChild(o); }
for (const m of ARP_MODES) { const o = document.createElement("option"); o.value = m; o.textContent = m; selArp.appendChild(o); }
for (const m of Object.keys(ARP_RATES)) { const o = document.createElement("option"); o.value = m; o.textContent = m; selRate.appendChild(o); }
for (const n of [1, 2, 3]) { const o = document.createElement("option"); o.value = n; o.textContent = n + " oct"; selOct.appendChild(o); }
selRoot.onchange = (e) => act.key(Number(e.target.value), undefined);
selScale.onchange = (e) => act.key(undefined, e.target.value);
selArp.onchange = (e) => act.arp({ mode: e.target.value });
selRate.onchange = (e) => act.arp({ rate: e.target.value });
selOct.onchange = (e) => act.arp({ octaves: Number(e.target.value) });
// a control that has been touched gives the keys back to the page
for (const s of [selRoot, selScale, selArp, selRate, selOct]) s.addEventListener("change", () => s.blur());
for (const el of hud.querySelectorAll("input[type=range]")) el.addEventListener("change", () => el.blur());

function hudUpdate() {
  $("f-src").textContent = S.source;
  for (const id of [1, 2]) {
    const g = S.lastGen[id];
    const ins = live() ? (g && g.instr ? pid(g.instr) : "") : pid(G.instr[id - 1]);
    $("f-p" + id).innerHTML = `${id}${S.active === id ? "*" : ""} <b>${ins}</b> g${g ? g.gen : "-"}/${g ? g.max : "-"}`;
  }
  const ln = S.lastNote;
  $("f-note").innerHTML = ln ? `note <b>${ln.note}</b> ${noteName(ln.note)}${ln.arp ? " arp" : ln.layer ? " loop" : ""}` : "note <b>-</b>";
  $("f-bpm").innerHTML = `<b>${S.bpm}</b> bpm`;
  $("f-seed").innerHTML = `seed <b>${S.seed}</b>`;
  $("f-loops").innerHTML = `loops <b>${G.layers.length}</b>/${MAX_LAYERS} · ${LOOP_BARS} bar`;
  const out = S.audio ? (S.outDb > -200 ? `out <b>${Math.max(-99, Math.round(S.outDb))}</b> dB` : "out <b>-</b>") : "";
  $("f-out").innerHTML = out;
  $("f-nosig").classList.toggle("show", !!S.outSilent);
  $("b-play").classList.toggle("on", S.playing);
  $("b-mode").textContent = S.mode;
  $("v-bpm").textContent = S.bpm; $("v-pitch").textContent = (G.pitch > 0 ? "+" : "") + G.pitch;
  $("v-delay").textContent = S.delay.toFixed(2); $("v-growth").textContent = G.growth ? G.growth + " bar" : "off";
  if (document.activeElement !== r("r-bpm")) r("r-bpm").value = S.bpm;
  if (selRoot.value !== String(G.key.root)) selRoot.value = String(G.key.root);
  if (selScale.value !== G.key.scale) selScale.value = G.key.scale;
  if (selArp.value !== G.arp.mode) selArp.value = G.arp.mode;
  if (selRate.value !== G.arp.rate) selRate.value = G.arp.rate;
  if (selOct.value !== String(G.arp.octaves)) selOct.value = String(G.arp.octaves);
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
  return G.geometry().map((d) => ({ ...d, group: d.layer ? 2 - (d.layer.serial % 2) : d.id, dim: d.layer ? 0.55 : 0, scale: d.layer ? 0.8 : 1 }));
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

// tap or click selects the plant under it
canvas.addEventListener("click", (e) => {
  if (S.mode === "norns") return;
  const r = canvas.getBoundingClientRect();
  const id = stage.pick((e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height));
  if (id) act.plant(id);
});

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
$("r-master").oninput = (e) => emit("state", Object.assign(S, { master: Number(e.target.value) }));
S.master = Number($("r-master").value);

// ?kodama=1: phase presets W S D (Tier 4)
// ?score=1: the ambient score on a synthetic scene (score-page.js)
if (q.get("score") === "1") import("./score-page.js").then((m) => m.init({ S, act, q, on })).catch((e) => console.warn("score", e));
if (S.flags.kodama) import("./kodama.js").then((m) => m.init({ S, act })).catch((e) => console.warn("kodama", e));
emit("state", S);
