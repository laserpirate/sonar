// lsys.js · sonar · a line-for-line port of flora's L-system core
//
//   lib/rule.lua, lib/l_system.lua      -> Rule, LSystem
//   lib/turtle.lua, lib/vector.lua      -> Turtle
//   lib/plant.lua (setup, generate,
//     redraw_fn, set_node_length)       -> Plant
//   lib/flora_pages.lua
//     check_plant_position              -> checkPlantPosition
//   lib/plant_sounds.lua set_note/play  -> Sequencer
//
// Pure functions and classes, no DOM. Imported by docs/index.html and by
// bridge/fake-norns.mjs, so the browser and the fake norns run one core.
// Lua quirks are kept on purpose (the "!-" vs "!_" polarity split, tonumber()
// returning nil, the sound stack that pushes a nil global, length floor 1),
// because the point is identity with the device, not a cleaner L-system.

export const SCREEN = { w: 127, h: 64 }; // flora lib/globals.lua: vector:new(127,64)
export const DRAW = { w: 128, h: 64 };   // the norns OLED itself

// ---------------------------------------------------------------- lua helpers

// Lua 5.3 tonumber(s) for the strings flora feeds it: nil -> undefined
export function luaToNumber(s) {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && !/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return undefined;
  return Number(t);
}

// Lua string.sub(s, i, j), 1-based, inclusive
export function sub(s, i, j = i) {
  if (j < i) return "";
  return s.slice(Math.max(i, 1) - 1, Math.max(j, 0));
}

// Lua truthiness: only nil and false are false
const truthy = (v) => v !== undefined && v !== null && v !== false;

// seedable PRNG with Lua math.random semantics
export function makeRandom(seed = 1) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // random() -> [0,1); random(m) -> 1..m; random(m, n) -> m..n
  return function random(m, n) {
    const r = next();
    if (m === undefined) return r;
    if (n === undefined) { n = m; m = 1; }
    return m + Math.floor(r * (n - m + 1));
  };
}

// ---------------------------------------------------------------- vector.lua

// vector:rotate_around(c, angle) for the only case flora uses: a point at
// (cx + len, cy). heading = -atan2(y, x); from_angle(a) = (cos a, -sin a).
function rotateAround(cx, cy, px, py, angle) {
  const vx = px - cx, vy = py - cy;
  const m = Math.sqrt(vx * vx + vy * vy);
  const h = -Math.atan2(vy, vx) + angle;
  let fx = Math.cos(h), fy = -Math.sin(h);
  const cm = Math.sqrt(fx * fx + fy * fy);
  fx = fx * m / cm; fy = fy * m / cm; // set_mag
  return [cx + fx, cy + fy];
}

// ---------------------------------------------------------------- rule.lua

export class Rule {
  constructor(a, b) { this.a = a; this.b = b; }
  getA() { return this.a; }
  getB(generation) {
    if (typeof this.b === "string") return this.b;
    let out = "";
    for (const r of this.b) {
      if (generation >= r.starting_generation && generation <= r.ending_generation) out = r.rule;
    }
    return out;
  }
}

// ---------------------------------------------------------------- l_system.lua

export class LSystem {
  constructor(axiom, rulesetsRaw, opts = {}) {
    this.random = opts.random || Math.random;
    this.maxLength = opts.maxLength ?? 300;          // MAX_SENTENCE_LENGTH
    this.randomAngleMax = opts.randomAngleMax ?? 90; // RANDOM_ANGLE_MAX
    this.randomAngles = [];
    this.update(axiom, rulesetsRaw);
  }
  update(axiom, rulesetsRaw) {
    this.axiom = axiom;
    this.sentence = axiom;
    this.rulesetsRaw = rulesetsRaw.map((r) => [r[0], r[1]]);
    this.generation = 0;
    this.rulesets = this.rulesetsRaw.map((r) => new Rule(r[0], r[1]));
    this.numRulesets = this.rulesets.length;
  }
  resetRandomAngles() { this.randomAngles = []; }
  getRandomAngle(ix) {
    const have = this.randomAngles[ix - 1];
    if (have !== undefined) return have;
    // math.random(RANDOM_ANGLE_MAX) * math.random(-1, 1); table.insert appends
    const ra = this.random(this.randomAngleMax) * this.random(-1, 1);
    this.randomAngles.push(ra);
    return ra;
  }
  // "!" -> "!045" / "!-045" (sentence pass) or "!_045" (successor pass)
  encodeAngle(ra, negMark) {
    const polarity = ra < 0 ? -1 : 1;
    ra = Math.abs(ra);
    let rep;
    if (ra > -10 && ra < 10) rep = "00" + ra;
    else if (ra > -100 && ra < 100) rep = "0" + ra;
    else rep = String(ra);
    return polarity === -1 ? "!" + negMark + rep : "!" + rep;
  }
  generate(dir) {
    const direction = dir === -1 || dir === 1 ? dir : 1;
    let nextGen = "";
    this.generation += direction;
    let rix = 1;
    const s = this.sentence;
    for (let i = 1; i <= s.length; i++) {
      let replace = sub(s, i);
      if (replace === "!") {
        const after = sub(s, i + 1);
        if (after !== "_" && luaToNumber(after) === undefined) {
          const ra = this.getRandomAngle(rix);
          rix++;
          replace = this.encodeAngle(ra, "-");
        }
      }
      for (const r of this.rulesets) {
        if (r.getA() === replace) {
          replace = r.getB(this.generation);
          [replace, rix] = this.checkForPunct(replace, rix);
          break;
        }
      }
      nextGen += replace;
    }
    this.sentence = nextGen.length < this.maxLength ? nextGen : nextGen.slice(0, this.maxLength);
  }
  checkForPunct(ruleset, rix) {
    let out = "";
    for (let i = 1; i <= ruleset.length; i++) {
      let replace = sub(ruleset, i);
      if (replace === "!") {
        const after = sub(ruleset, i + 1);
        if (after !== "_" && luaToNumber(after) === undefined) {
          const ra = this.getRandomAngle(rix);
          rix++;
          replace = this.encodeAngle(ra, "_");
        }
      }
      out += replace;
    }
    return [out, rix];
  }
}

// ---------------------------------------------------------------- turtle.lua

export class Turtle {
  constructor(sentence, length, theta, opts = {}) {
    this.random = opts.random || Math.random;
    this.todo = sentence;
    this.length = length;
    this.theta = theta;
    this.rotation = 0;
    this.start = { x: 0, y: 0 };
    this.positions = []; // 1-based in Lua; index i-1 here; null where Lua has {}
    this.stack = [];     // matrix_stack, persistent across renders like the Lua object
  }
  push() { this.stack.push([this.start, this.rotation]); }
  pop() {
    if (this.stack.length > 0) {
      const [v, r] = this.stack.pop();
      this.translate(v.x, v.y);
      this.rotation = r;
    }
  }
  translate(x, y) { this.start = { x, y }; }
  rotate(theta, reset) { this.rotation = reset ? theta : this.rotation + theta; }
  setTodo(s) { this.todo = s; }
  changeLength(minLength, pct) {
    const percent = truthy(pct) ? pct : 0.5;
    this.length = this.length * percent > 1 ? this.length * percent : 1;
    if (truthy(minLength) && this.length < minLength) this.length = minLength;
  }
  getPosition(idx) { return this.positions[idx - 1]; }

  // turtle.render: walks the whole sentence. Returns the drawn geometry in
  // norns screen pixels. segments carry the sentence index (1-based) and char.
  render() {
    const segs = [];
    const circles = [];
    const s = this.todo;
    for (let i = 1; i <= s.length; i++) {
      const c = sub(s, i);
      this.positions[i - 1] = null;
      if (c === "F" || c === "G" || c === "f") {
        const sx = this.start.x, sy = this.start.y;
        const [ex, ey] = rotateAround(sx, sy, sx + this.length, sy, this.rotation);
        if (c === "F" || c === "G") {
          segs.push({ i, c, x1: sx, y1: sy, x2: ex, y2: ey });
          if (c === "F") {
            this.positions[i - 1] = { x: ex, y: ey };
            circles.push({ i, x: ex, y: ey });
          }
        }
        this.translate(ex, ey);
      } else if (c === "!") {
        let ra;
        if (sub(s, i + 1) === "_") ra = luaToNumber(sub(s, i + 1, i + 4)); // "_045" -> nil in Lua
        else ra = luaToNumber(sub(s, i + 1, i + 3));
        if (ra !== undefined) this.rotate((ra * Math.PI) / 180);
      } else if (c === "+") {
        this.rotate(this.theta);
      } else if (c === "-") {
        this.rotate(-this.theta);
      } else if (c === "r") {
        const nt = this.theta + this.random() * this.random(-1, 1) * 0.01;
        this.theta = nt > 0 ? nt : this.theta;
      } else if (c === "[") {
        this.push();
      } else if (c === "]") {
        this.pop();
      } else if (c === "|") {
        this.rotate(Math.PI);
      }
    }
    return { segments: segs, circles };
  }
}

// ---------------------------------------------------------------- plant.lua

const rad = (d) => (d * Math.PI) / 180;

export class Plant {
  // instr: one catalog entry (catalog.json plants[]); id: 1 or 2
  constructor(id, opts = {}) {
    this.id = id;
    this.random = opts.random || Math.random;
    this.defaults = opts.defaults || {};
    this.offset = { x: 0, y: 0 };
    this.lsys = null;
    this.currentInstruction = null;
    this.currentGeneration = 0;
  }
  setup(instr, instructionNumber, targetGeneration) {
    this.instr = JSON.parse(JSON.stringify(instr));
    const sx = this.instr.start_from[0], sy = this.instr.start_from[1];
    this.startFrom = { x: this.id === 1 ? sx - SCREEN.w / 4 : sx + SCREEN.w / 4, y: sy };
    this.startFrom.x += this.offset.x; this.startFrom.y += this.offset.y;
    this.ruleset = this.instr.ruleset;
    this.axiom = this.instr.axiom;
    this.maxGenerations = this.instr.max_generations;
    this.length = this.instr.length;
    this.angle = this.instr.angle;
    this.initialTurtleRotation = this.instr.initial_turtle_rotation ?? 0;
    targetGeneration = truthy(targetGeneration) ? targetGeneration : this.instr.starting_generation;
    this.startingGeneration = targetGeneration;
    if (this.lsys === null || this.currentInstruction !== instructionNumber) {
      this.lsys = new LSystem(this.axiom, this.ruleset, {
        random: this.random,
        maxLength: this.defaults.max_sentence_length ?? 300,
        randomAngleMax: this.defaults.random_angle_max ?? 90,
      });
      this.lsys.resetRandomAngles();
    } else {
      this.lsys.update(this.axiom, this.ruleset);
    }
    this.currentInstruction = instructionNumber;
    this.currentGeneration = 0;
    this.turtle = new Turtle(this.lsys.sentence, this.length || 35, rad(this.angle || 0), { random: this.random });
    if (truthy(targetGeneration)) {
      for (let i = 1; i <= targetGeneration; i++) this.generate(targetGeneration);
    }
  }
  generate(dir) {
    const direction = dir === -1 || dir === 1 ? dir : 1;
    if (this.currentGeneration >= 0 && this.currentGeneration < this.maxGenerations) {
      this.turtle.push();
      this.lsys.generate(direction);
      this.currentGeneration += direction;
      this.turtle.setTodo(this.lsys.sentence);
      this.turtle.pop();
      return true;
    }
    return false;
  }
  get sentence() { return this.lsys.sentence; }
  setSentence(s) { this.lsys.sentence = s; this.turtle.setTodo(s); }
  setAngle(deg) { this.angle = deg; this.instr.angle = deg; this.turtle.theta = rad(deg); }
  setNodeLength(pct) { this.turtle.changeLength(this.defaults.turtle_min_length ?? 0.2, pct); }
  setOffset(dx, dy) { this.offset.x += dx; this.offset.y += dy; }
  resetOffset() { this.offset = { x: 0, y: 0 }; }
  // plant.redraw_fn
  render() {
    this.turtle.rotate(0, true);
    this.turtle.translate(this.startFrom.x + this.offset.x, this.startFrom.y + this.offset.y);
    this.turtle.rotate(rad(this.initialTurtleRotation));
    return this.turtle.render();
  }
  // values a /sonar/gen message carries
  genArgs(truncateAt = 8000) {
    let s = this.sentence, truncated = 0;
    if (s.length > truncateAt) { s = ""; truncated = 1; }
    return [this.id, this.currentGeneration, this.maxGenerations, this.angle, this.length,
      this.startFrom.x, this.startFrom.y, this.initialTurtleRotation, s, truncated];
  }
  rulesArgs() {
    const args = [this.id, this.axiom, this.ruleset.length];
    for (const r of this.ruleset) args.push(String(r[0]), typeof r[1] === "string" ? r[1] : "");
    return args;
  }
}

// flora_pages.lua check_plant_position: nudges offsets and node length each
// frame so the plants fit their half of the screen. Uses the positions of the
// last render, exactly as flora does (render happens after this call).
export function checkPlantPosition(plants) {
  let dirty = false;
  const n = plants.length;
  for (let k = 0; k < n; k++) {
    const i = k + 1;
    const p = plants[k];
    const pos = p.turtle.positions;
    const left = 40 + (SCREEN.w / n) * (i - 1);
    const right = SCREEN.w / (n / i) - 20;
    const top = 20;
    const bottom = SCREEN.h - 5;
    let l, r, t, b;
    for (const q of pos) {
      if (!q) continue;
      if (l === undefined) { l = r = q.x; t = b = q.y; }
      if (q.x < l) l = q.x;
      if (q.x > r) r = q.x;
      if (q.y < t) t = q.y;
      if (q.y > b) b = q.y;
    }
    if (l === undefined) continue;
    const w = r - l, h = b - t;
    if (w > SCREEN.w / n + 15 || h > SCREEN.h - 30) { dirty = true; p.setNodeLength(0.9); }
    if (w < SCREEN.w / n - 25 && h < SCREEN.h - 45) { dirty = true; p.setNodeLength(1.1); }
    if (l < left) { dirty = true; p.setOffset(0.5, 0); }
    if (t + 3 < top) { dirty = true; p.setOffset(0, 0.5); }
    if (r > right) { dirty = true; p.setOffset(-0.5, 0); }
    if (b + 3 > bottom) { dirty = true; p.setOffset(0, -0.5); }
  }
  return dirty;
}

// ---------------------------------------------------------------- plant_sounds.lua

export const mtof = (n) => 13.75 * 2 ** ((n - 9) / 12);
export const ftom = (f) => Math.min(127, Math.max(0, Math.floor((12 * Math.log(f / 440)) / Math.log(2) + 69.5)));

// norns clock.sync(q): wake at the next multiple of q strictly after t
export function syncTime(t, q) {
  let next = (Math.floor(t / q + 1e-9) + 1) * q;
  if (next <= t) next = t + q;
  return next;
}

// One plant's note walker. step() advances one sentence character and
// returns {t, kind, ...}; kind is "note", "rest" or "step". Time is in beats.
// Defaults are flora's: notes from build_scale(), note_scalar 3, one active
// cf scalar (option 3 -> x2), note duration 1 beat, offsets 0.
export class Sequencer {
  constructor(plant, defaults, opts = {}) {
    this.plant = plant;
    this.random = opts.random || Math.random;
    this.notes = (opts.notes || defaults.notes).slice();
    this.noteScalar = opts.noteScalar ?? defaults.note_scalar;
    this.noteOffset = opts.noteOffset ?? 0;
    this.duration = opts.duration ?? defaults.note_durations[defaults.note_duration_index - 1];
    this.cfScalars = opts.cfScalars || [defaults.cf_scalars_map[defaults.cf_scalar_index - 1]];
    this.t = opts.t ?? 0;
    this.soundStack = [];
    this.restart = false;
    this.lastIndex = undefined;
    this.note = undefined;
    this.globalNote = undefined; // flora pushes the global `note`, which is nil
    this.pending = null;
  }
  reset(t) { this.lastIndex = undefined; this.note = undefined; this.restart = false; if (t !== undefined) this.t = t; }

  // set_note: read the next character and build node_obj
  setNote(lastIndex, lastNote) {
    const s = this.plant.sentence;
    const N = this.notes.length;
    this.note = truthy(lastNote) ? lastNote : N / 2;
    let i = truthy(lastIndex) ? lastIndex + 1 : 1;
    if (i > s.length) i = 1; // the sentence shrank under us; flora restarts via s_id
    const l = sub(s, i);
    const node = { s, i, duration: this.duration };
    this.restart = i === s.length;
    const theta = this.plant.turtle.theta;
    const ns = this.noteScalar;
    if (l === "F") node.note = this.note;
    else if (l === "G") node.rest = 1;
    else if (l === "[") { if (truthy(this.globalNote)) this.soundStack.push(this.globalNote); }
    else if (l === "]") { this.note = this.soundStack.length ? this.soundStack.pop() : undefined; }
    else if (l === "+" && truthy(this.note)) {
      const nn = this.note + Math.ceil(ns * theta);
      this.note = nn <= N ? this.note + Math.ceil(ns * theta) : 1 + (nn - N);
    } else if (l === "-" && truthy(this.note)) {
      const nn = this.note + Math.ceil(ns * -theta);
      this.note = nn > 1 ? this.note + Math.ceil(ns * -theta) : N - nn;
    } else if (l === "!" && truthy(this.note)) {
      let ra;
      if (sub(s, i + 1) === "_") {
        ra = luaToNumber("-" + sub(s, i + 2, i + 4));
        ra = ra === undefined ? NaN : rad(ra); // math.rad(nil) errors in Lua; flora never hits it
      } else {
        ra = luaToNumber(sub(s, i + 1, i + 3));
        ra = ra !== undefined ? rad(ra) : 0;
      }
      const nn = this.note + Math.ceil(ns * ra);
      if (nn > N) this.note = 1 + (nn - N);
      else if (nn < 1) this.note = N - nn;
      else this.note = this.note + Math.ceil(ns * ra);
    }
    return node;
  }

  // one ps.play(node_obj) call: returns the event it produces
  step() {
    const node = this.setNote(this.restart ? undefined : this.lastIndex, this.restart ? undefined : this.note);
    let ev;
    if (truthy(node.note)) {
      this.t = syncTime(this.t, node.duration);
      const pos = this.plant.turtle.getPosition(node.i);
      const N = this.notes.length;
      let n = node.note + this.noteOffset;
      n = n > 0 ? n : N + n;
      n = n <= N ? n : n - N;
      const base = this.notes[n - 1]; // undefined for a fractional or out-of-range index
      if (base !== undefined) {
        const cf = this.cfScalars[this.random(this.cfScalars.length) - 1];
        const freq = mtof(base) * cf;
        ev = { t: this.t, kind: "note", idx: node.i, note: ftom(freq), freq,
          x: pos ? pos.x : -1, y: pos ? pos.y : -1, dur: node.duration, scaleIndex: node.note };
      } else {
        ev = { t: this.t, kind: "step", idx: node.i };
      }
    } else {
      this.t = syncTime(this.t, 0.001);
      if (node.rest) {
        ev = { t: this.t, kind: "rest", idx: node.i };
        this.t = syncTime(this.t, node.duration);
      } else {
        ev = { t: this.t, kind: "step", idx: node.i };
      }
    }
    this.lastIndex = node.i;
    return ev;
  }

  // advance until beat `until`; returns the note and rest events in order
  run(until, max = 100000) {
    const out = [];
    let guard = 0;
    while (this.t < until && guard++ < max) {
      const ev = this.step();
      if (ev.kind !== "step") out.push(ev);
    }
    return out;
  }
}

// ---------------------------------------------------------------- helpers

export function segmentCount(geom) { return geom.segments.length; }

// a 2-plant flora garden at its defaults, as init() leaves it
export function makeGarden(catalog, opts = {}) {
  const d = catalog.defaults;
  const random = opts.random || makeRandom(opts.seed ?? 1);
  const instr = opts.instructions || d.initial_plant_instructions;
  const plants = [1, 2].map((id) => new Plant(id, { random, defaults: d }));
  plants.forEach((p, k) => p.setup(catalog.plants[instr[k] - 1], instr[k], opts.gens ? opts.gens[k] : undefined));
  return { plants, random, defaults: d };
}
