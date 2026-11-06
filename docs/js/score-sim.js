// score-sim.js · synthetic scenes for the score, so it runs and tests with no shanshui-av or kc page.
//
// shanshui: a scripted scroll. Speed ramps 0 -> 78 world px/s (shanshui-av's default 120 px/s on
// a 1080 px screen), a faster stretch, a stop, then on again. Tags sit at fixed x, laid out like the
// measured upstream planner (sonar/docs/notes/shanshui-mechanics_v01.md, section 2): mount
// clusters of four 50 px apart every 1100 px, a distmount every 1000 px, a flatmount every 2048 px,
// a boat every 1500 px. A tag enters when the right edge of a 1245 px view passes its x.
// Weather follows shanshui-av's derelict keyframes (src/core/weather.js KEYS_W) on a 120 s cycle.
//
// kodama: the kc cycle, 36 s, split Wet 0.4 / Shed 0.3 / Dry 0.3 (C3-E3_kc_core_v01.js CYC).

const VIEW_W = 1245;
const KEYS_W = [
  { p: 0.0, rain: 0.0, wind: 0.2, water: 0.08, fog: 0.25, light: 1.0 },
  { p: 0.2, rain: 0.35, wind: 0.35, water: 0.25, fog: 0.5, light: 0.72 },
  { p: 0.4, rain: 1.0, wind: 0.8, water: 0.55, fog: 0.8, light: 0.42 },
  { p: 0.6, rain: 0.45, wind: 0.5, water: 1.0, fog: 0.55, light: 0.45 },
  { p: 0.8, rain: 0.0, wind: 0.15, water: 0.42, fog: 0.3, light: 0.0 },
];
const ss = (t) => t * t * (3 - 2 * t);
export function weatherAt(p) {
  p = ((p % 1) + 1) % 1;
  let i = 0;
  for (let k = 0; k < KEYS_W.length; k++) if (KEYS_W[k].p <= p) i = k;
  const A = KEYS_W[i], B = KEYS_W[(i + 1) % KEYS_W.length];
  let span = B.p - A.p; if (span <= 0) span += 1;
  let f = p - A.p; if (f < 0) f += 1;
  f = ss(Math.min(1, Math.max(0, (f / span - 0.35) / 0.65)));
  const o = {};
  for (const k of ["rain", "wind", "water", "fog", "light"]) o[k] = A[k] + (B[k] - A[k]) * f;
  return o;
}

// velocity profile, world px/s
export function velocityAt(t) {
  const tt = t % 120;
  if (tt < 4) return 78 * ss(tt / 4);
  if (tt < 40) return 78;
  if (tt < 44) return 78 + 162 * ss((tt - 40) / 4);
  if (tt < 60) return 240;
  if (tt < 63) return 240 * (1 - ss((tt - 60) / 3));
  if (tt < 70) return 0;
  if (tt < 74) return 78 * ss((tt - 70) / 4);
  return 78;
}

export function tagsUpTo(x1) {
  const out = [];
  for (let c = 400; c <= x1; c += 1100) for (let k = 0; k < 4; k++) out.push({ tag: "mount", x: c + 50 * k });
  for (let x = 1000; x <= x1; x += 1000) out.push({ tag: "distmount", x });
  for (let x = 700; x <= x1; x += 2048) out.push({ tag: "flatmount", x });
  for (let x = 1500; x <= x1; x += 1500) out.push({ tag: "boat", x });
  return out.sort((a, b) => a.x - b.x);
}

export class ShanshuiSim {
  constructor({ weatherPeriod = 120 } = {}) { this.t = 0; this.x = 0; this.period = weatherPeriod; this.cursor = 0; this.tags = []; this.tagsTo = 0; }
  // advance by dt seconds; returns a score.scene() argument
  step(dt) {
    const v = velocityAt(this.t);
    this.t += dt;
    const prevR = this.x + VIEW_W;
    this.x += v * dt;
    const right = this.x + VIEW_W;
    if (right + 4000 > this.tagsTo) { this.tagsTo = right + 20000; this.tags = tagsUpTo(this.tagsTo); }
    const entered = [];
    const tags = { mount: 0, distmount: 0, flatmount: 0, boat: 0 };
    for (const e of this.tags) {
      if (e.x > prevR && e.x <= right) entered.push(e.tag);
      if (e.x >= this.x && e.x <= right) tags[e.tag]++;
    }
    return { kind: "shanshui", t: this.t, x: this.x, velocity: v, tags, entered, weather: weatherAt(this.t / this.period) };
  }
}

export class KodamaSim {
  constructor({ len = 36, split = [0.4, 0.3, 0.3] } = {}) { this.t = 0; this.len = len; this.split = split; this.count = 0; this.last = 0; }
  step(dt) {
    this.t += dt;
    const T = (this.t % this.len) / this.len, s = this.split;
    let phase, pu;
    if (T < s[0]) { phase = 1; pu = T / s[0]; }
    else if (T < s[0] + s[1]) { phase = 2; pu = (T - s[0]) / s[1]; }
    else { phase = 3; pu = (T - s[0] - s[1]) / s[2]; }
    if (phase === 1 && this.last === 3) this.count++;
    this.last = phase;
    return { kind: "kodama", t: this.t, T, phase, pu, level: 0, morph: 0.5 - 0.5 * Math.cos(T * Math.PI * 2), cycle: this.count };
  }
}

// run a score through a sim for `seconds` at `fps`, synchronously (tests, offline renders)
export function runSim(score, kind, seconds, fps = 30, opts = {}) {
  const sim = kind === "kodama" ? new KodamaSim(opts) : new ShanshuiSim(opts);
  const dt = 1 / fps, t0 = opts.t0 || 0;
  score.play();
  for (let i = 0; i < seconds * fps; i++) {
    const sc = sim.step(dt);
    sc.t = t0 + sc.t;
    if (opts.onFrame) opts.onFrame(sc, i);
    score.scene(sc);
  }
  return score.log;
}
