// app.js · sonar page: renderer + sim + live (OSC over WebSocket) + keys.
// Audio engines and MIDI load only after the Enable click (audio.js, midi.js).
import { Plant, LSystem, Turtle, Sequencer, checkPlantPosition, makeRandom, SCREEN, DRAW } from "./lsys.js";
import { OscWs } from "./osc-ws.js";

const q = new URLSearchParams(location.search);
const catalog = await (await fetch(new URL("./catalog.json", import.meta.url))).json();
const D = catalog.defaults;
const NPRESETS = catalog.plants.length;
const pid = (n) => "p" + String(n).padStart(2, "0");

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
  instr: [Number(q.get("p1")) || D.initial_plant_instructions[0], Number(q.get("p2")) || Number(q.get("p1")) || D.initial_plant_instructions[1]],
  errors: 0,
  hb: 0,
  flags: { shanshui: q.get("shanshui") === "1", kodama: q.get("kodama") === "1" },
  weather: 0,
  flood: 0,
  phase: null,
};
window.__sonar = S; // read by the Playwright tests
S.blackoutOn = window.sonarBlackout.on;
window.sonarBlackout.hook((v) => { S.blackoutOn = v; });

const listeners = { note: [], gen: [], state: [] };
export const on = (ev, f) => listeners[ev].push(f);
const emit = (ev, x) => { for (const f of listeners[ev]) { try { f(x); } catch (e) { S.errors++; console.warn(ev, e); } } };
window.__sonarOn = on;

// ------------------------------------------------------------------ plants
const random = makeRandom(Number(q.get("seed")) || ((Date.now() & 0xffff) + 1));
const plants = [new Plant(1, { random, defaults: D }), new Plant(2, { random, defaults: D })];
const geom = [{ segments: [], circles: [] }, { segments: [], circles: [] }];
const lit = [new Map(), new Map()]; // sentence index -> brightness 0..1
const noteAt = [null, null];          // last played note position per plant (norns mode highlight)
let seqs = [null, null];
let beat0 = performance.now();
const nowBeats = () => ((performance.now() - beat0) / 1000) * (S.bpm / 60);
const simSeqOpts = () => {
  const o = { random, t: nowBeats() };
  if (S.simOpts?.duration) o.duration = S.simOpts.duration;
  if (S.simOpts?.cfScalar) o.cfScalars = [S.simOpts.cfScalar];
  return o;
};

function setupSim(k, instr, gen) {
  S.instr[k] = instr;
  const p = plants[k];
  p.resetOffset();
  p.setup(catalog.plants[instr - 1], instr, gen);
  seqs[k] = new Sequencer(p, D, simSeqOpts());
  pending[k] = null;
  lit[k].clear();
  S.lastGen[k + 1] = { gen: p.currentGeneration, max: p.maxGenerations, instr };
  emit("gen", { plant: k + 1, gen: p.currentGeneration, max: p.maxGenerations, sim: true });
}

// live plants: rebuilt from /sonar/rules + /sonar/gen
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
    lit[k].clear();
  }
  p.axiom = rules.axiom; p.ruleset = rules.ruleset;
  p.angle = angle; p.length = length; p.maxGenerations = maxgen; p.currentGeneration = gen;
  p.initialTurtleRotation = rot0;
  p.startFrom = { x: x0, y: y0 };
  p.instr = { angle };
  p.turtle.theta = (angle * Math.PI) / 180;
  if (truncated || !sentence) {
    // regenerate from the rules (random "!" angles will differ from the device)
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
function noteEvent(plant, idx, note, freq, x, y, dur) {
  const k = plant - 1;
  lit[k].set(idx, 1);
  noteAt[k] = { x, y, idx, t: performance.now() };
  S.notes++;
  S.lastNote = { plant, idx, note, freq };
  emit("note", { plant, idx, note, freq, x, y, dur, active: plant === S.active });
}

// ------------------------------------------------------------------ live (bridge)
let link = null;
const wsUrl = q.get("ws");
function liveMessage(path, a) {
  switch (path) {
    case "/sonar/rules": liveRulesMsg(a); break;
    case "/sonar/gen": liveGenMsg(a); break;
    case "/sonar/note": noteEvent(a[0], a[1], a[2], a[3], a[4], a[5], a[6]); break;
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
    if (up) {
      S.source = "live";
      seqs = [null, null];
      link.send("/sonar/resend", []);
    } else {
      S.source = "live (lost)";
    }
    emit("state", S);
  });
}
const live = () => S.source.startsWith("live");

// ------------------------------------------------------------------ sim sequencer
const pending = [null, null];
function simTick() {
  if (live() || !S.playing || S.panic) return;
  const now = nowBeats();
  for (let k = 0; k < 2; k++) {
    if (!seqs[k]) continue;
    for (let guard = 0; guard < 4000; guard++) {
      if (!pending[k]) {
        let ev;
        for (let g2 = 0; g2 < 2000; g2++) { ev = seqs[k].step(); if (ev.kind !== "step") break; }
        pending[k] = ev;
      }
      if (!pending[k] || pending[k].t > now) break;
      const e = pending[k];
      pending[k] = null;
      if (now - e.t > 2) continue; // tab was asleep: skip, never burst
      if (e.kind === "note") noteEvent(k + 1, e.idx, e.note, e.freq, e.x, e.y, e.dur);
    }
  }
}
setInterval(simTick, 5);

// ------------------------------------------------------------------ actions (keys, buttons, MIDI)
export const act = {
  play(v) {
    S.playing = v === undefined ? !S.playing : !!v;
    if (live()) link.send("/sonar/play", [S.playing ? 1 : 0]);
    else if (S.playing) { for (let k = 0; k < 2; k++) { seqs[k] = new Sequencer(plants[k], D, simSeqOpts()); pending[k] = null; } }
    emit("state", S);
  },
  nextGen() {
    if (live()) { link.send("/sonar/generate", [S.active, 1]); return; }
    const k = S.active - 1, p = plants[k];
    if (p.generate(1)) { S.lastGen[S.active] = { gen: p.currentGeneration, max: p.maxGenerations, instr: S.instr[k] }; emit("gen", { plant: S.active, gen: p.currentGeneration, sim: true }); }
    else setupSim(k, S.instr[k]);
  },
  reset() {
    if (live()) { link.send("/sonar/reset", []); return; }
    setupSim(0, S.instr[0]); setupSim(1, S.instr[1]);
  },
  plant(n) {
    if (live()) link.send("/sonar/plant", [n]);
    S.active = n; emit("state", S);
  },
  preset(dir) {
    const k = S.active - 1;
    const n = ((S.instr[k] - 1 + dir + NPRESETS) % NPRESETS) + 1;
    if (live()) { S.instr[k] = n; link.send(`/param/plant${S.active}_instructions`, [n]); return; }
    setupSim(k, n);
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
  },
  mode(m) { S.mode = m || (S.mode === "wall" ? "norns" : "wall"); resize(); emit("state", S); },
  blackout(v) { v === undefined ? window.sonarBlackout.toggle() : window.sonarBlackout.set(v); },
  panic(v) {
    S.panic = v === undefined ? !S.panic : !!v;
    document.getElementById("panic").classList.toggle("show", S.panic);
    emit("state", S);
  },
  send(path, args) { if (live()) link.send(path, args); },
  // sim sequencer options (kodama phases): note duration in beats, cf scalar
  simParams(o) {
    S.simOpts = { ...(S.simOpts || {}), ...o };
    for (const s of seqs) if (s) { if (o.duration) s.duration = o.duration; if (o.cfScalar) s.cfScalars = [o.cfScalar]; }
  },
  isLive: () => live(),
  setup: (k, instr, gen) => setupSim(k, instr, gen), // ?score=1 shows the score's plant
};
window.__sonarAct = act;

// keys: handled synchronously, before anything else the page does
let escTimer = null;
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === "Escape") {
    if (!e.repeat && !escTimer) escTimer = setTimeout(() => { escTimer = null; act.panic(); }, 1000);
    return;
  }
  if (e.repeat && k !== "ArrowLeft" && k !== "ArrowRight") return;
  const map = {
    " ": () => act.play(), n: () => act.nextGen(), N: () => act.nextGen(), r: () => act.reset(), R: () => act.reset(),
    "1": () => act.plant(1), "2": () => act.plant(2), m: () => act.mode(), M: () => act.mode(),
    h: () => hud.classList.toggle("hidden"), H: () => hud.classList.toggle("hidden"),
    f: () => fullscreen(), F: () => fullscreen(), "?": () => keysBox.classList.toggle("show"),
    ArrowLeft: () => act.preset(-1), ArrowRight: () => act.preset(1),
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
$("b-mode").onclick = () => act.mode();
$("b-keys").onclick = () => keysBox.classList.toggle("show");
for (const b of hud.querySelectorAll("button")) b.addEventListener("keydown", (e) => { if (e.key === " ") e.preventDefault(); });
const noteName = (n) => ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][n % 12] + (Math.floor(n / 12) - 1);
function hudUpdate() {
  $("f-src").textContent = S.source;
  for (const id of [1, 2]) {
    const g = S.lastGen[id];
    const ins = live() ? (g && g.instr ? pid(g.instr) : "") : pid(S.instr[id - 1]);
    $("f-p" + id).innerHTML = `${id}${S.active === id ? "*" : ""} <b>${ins}</b> g${g ? g.gen : "-"}/${g ? g.max : "-"}`;
  }
  $("f-note").innerHTML = S.lastNote ? `note <b>${S.lastNote.note}</b> ${noteName(S.lastNote.note)}` : "note <b>-</b>";
  $("f-bpm").innerHTML = `<b>${S.bpm}</b> bpm`;
  $("b-play").classList.toggle("on", S.playing);
  $("b-mode").textContent = S.mode;
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

function resize() {
  const W = window.innerWidth, H = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (S.mode === "norns") {
    const s = Math.max(1, Math.floor(Math.min(W / DRAW.w, H / DRAW.h)));
    // integer multiple of 128 x 64 in CSS pixels; backing store matches the device pixels
    canvas.width = Math.round(DRAW.w * s * dpr); canvas.height = Math.round(DRAW.h * s * dpr);
    canvas.style.width = DRAW.w * s + "px"; canvas.style.height = DRAW.h * s + "px";
    S.scale = s;
  } else {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    S.scale = null;
  }
  lastGood.width = canvas.width; lastGood.height = canvas.height;
}
window.addEventListener("resize", resize);
resize();

// norns screen levels 0..15 shown with a light gamma so level 1 and 3 read on a projector
const level = (l) => { const v = Math.round(255 * Math.pow(l / 15, 0.5)); return `rgb(${v},${v},${v})`; };

function drawNorns() {
  sctx.fillStyle = "#000"; sctx.fillRect(0, 0, DRAW.w, DRAW.h);
  sctx.lineWidth = 1;
  for (let k = 0; k < 2; k++) {
    const g = geom[k];
    const lv = (k + 1) === S.active ? 3 : 1; // flora plant1/2_screen_level
    sctx.strokeStyle = level(lv);
    sctx.beginPath();
    for (const s of g.segments) { sctx.moveTo(s.x1, s.y1); sctx.lineTo(s.x2, s.y2); }
    for (const c of g.circles) { sctx.moveTo(c.x + 1, c.y); sctx.arc(c.x, c.y, 1, 0, Math.PI * 2); }
    sctx.stroke();
    const n = noteAt[k];
    if (n && n.x >= 0 && performance.now() - n.t < 1500) {
      const b = 10 + Math.floor(5 * Math.max(0, 1 - (performance.now() - n.t) / 1500));
      sctx.strokeStyle = level(b);
      sctx.beginPath(); sctx.arc(n.x, n.y, 1, 0, Math.PI * 2); sctx.stroke();
    }
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
}

function drawWall() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#07090e"; ctx.fillRect(0, 0, W, H);
  // keep the drawing clear of the controls bar while it shows (H hides it)
  const hudH = hud.classList.contains("hidden") ? 0 : hud.offsetHeight * (W / window.innerWidth);
  const AH = H - hudH;
  const s = Math.min(W / DRAW.w, AH / DRAW.h) * 0.94;
  const ox = (W - DRAW.w * s) / 2, oy = (AH - DRAW.h * s) / 2;
  const X = (x) => ox + x * s, Y = (y) => oy + y * s;
  const lw = Math.max(1, s * 0.12);
  ctx.lineCap = "round";
  // ?shanshui=1: water level line and fog from /av/flood and /av/weather
  if (S.flags.shanshui && S.flood > 0) {
    const wy = Y(DRAW.h * (1 - S.flood));
    ctx.fillStyle = "rgba(46, 74, 140, 0.35)"; ctx.fillRect(0, wy, W, H - wy);
    ctx.strokeStyle = "#9FC8F0"; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(0, wy); ctx.lineTo(W, wy); ctx.stroke();
  }
  for (let k = 0; k < 2; k++) {
    const g = geom[k];
    const act1 = (k + 1) === S.active;
    ctx.strokeStyle = act1 ? "#2E4A8C" : "#3e466b";
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const sg of g.segments) { ctx.moveTo(X(sg.x1), Y(sg.y1)); ctx.lineTo(X(sg.x2), Y(sg.y2)); }
    ctx.stroke();
    // segments being played: lit and decaying
    const L = lit[k];
    if (L.size) {
      ctx.lineWidth = lw * 2.2;
      for (const sg of g.segments) {
        const b = L.get(sg.i);
        if (!b) continue;
        ctx.strokeStyle = `rgba(159, 200, 240, ${b.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(X(sg.x1), Y(sg.y1)); ctx.lineTo(X(sg.x2), Y(sg.y2)); ctx.stroke();
        ctx.fillStyle = `rgba(159, 200, 240, ${b.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(X(sg.x2), Y(sg.y2), lw * 2.4 * b + lw, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  if (S.flags.shanshui && S.weather > 0) {
    ctx.fillStyle = `rgba(159, 200, 240, ${(S.weather * 0.45).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function decay(dt) {
  const f = Math.exp(-dt / 0.45);
  for (const L of lit) for (const [i, b] of L) { const nb = b * f; if (nb < 0.02) L.delete(i); else L.set(i, nb); }
}

let lastT = performance.now();
let frameIx = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (t - lastT) / 1000); lastT = t;
  if (S.panic) {
    ctx.drawImage(lastGood, 0, 0);
    return;
  }
  try {
    // flora redraws at 15 fps: check_plant_position, then draw both plants
    if (frameIx++ % 4 === 0 || !geom[0].segments.length) {
      if (plants[0].turtle && plants[1].turtle) checkPlantPosition(plants);
      for (let k = 0; k < 2; k++) if (plants[k].turtle) { geom[k] = plants[k].render(); S.segments[k + 1] = geom[k].segments.length; }
    }
    decay(dt);
    if (S.mode === "norns") drawNorns(); else drawWall();
    S.frames++;
    if (t - lastGoodAt > 1000) { lastGood.getContext("2d").drawImage(canvas, 0, 0); lastGoodAt = t; }
  } catch (e) {
    S.errors++;
    if (S.errors < 5) console.warn("frame", e);
    try { ctx.drawImage(lastGood, 0, 0); } catch {}
  }
}

// ------------------------------------------------------------------ start
if (!wsUrl) { setupSim(0, S.instr[0]); setupSim(1, S.instr[1]); }
else {
  // until the bridge answers, show the sim garden still (not playing)
  setupSim(0, S.instr[0]); setupSim(1, S.instr[1]);
  S.source = "connecting";
}
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
