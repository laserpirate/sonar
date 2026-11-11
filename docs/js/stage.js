// stage.js · the wall view: fits the geometry on stage to the canvas and draws it.
// after phylla-arp (SymbiOS, Phylla biome), behaviour reimplemented: geometry rebuilt only on
// a structural change, fit to the bounding box, sway as a shear in the projection, note marks.
//
// arrange() is pure: items in, one transform per item out, in device pixels.
// Stage holds the eased transforms, a raster of the still plants (rebuilt only
// when a plant, the fit or the selection changes) and the per-frame pass, which
// is one drawImage plus the lit overlay. Nothing here touches the turtle.

export const MARGIN = 0.06;
export const EASE_MS = 400;
const smooth = (x) => x * x * (3 - 2 * x);

export function bboxOf(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of geom.segments) {
    if (s.x1 < x0) x0 = s.x1; if (s.x2 < x0) x0 = s.x2;
    if (s.x1 > x1) x1 = s.x1; if (s.x2 > x1) x1 = s.x2;
    if (s.y1 < y0) y0 = s.y1; if (s.y2 < y0) y0 = s.y2;
    if (s.y1 > y1) y1 = s.y1; if (s.y2 > y1) y1 = s.y2;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
// the plant with its roots: what the camera must hold
export function boxFor(it) {
  const b = bboxOf(it.geom);
  if (!it.roots || !b) return b;
  const r = bboxOf(it.roots);
  return r ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : b;
}
// where the ground is for a plant: its roots' ground line, else the foot of its drawing
const footOf = (it, b) => (it.roots ? it.roots.ground : b ? b.y1 : 0);

// seeded hash to 0..1, for forest spacing and depth
export const hash01 = (seed, i) => {
  let t = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// items: [{id, geom, group, scale?}]. Plants of one group share a cell (a base
// plant and its loop layers). Each plant is normalised to its cell, because
// flora's preset lengths run from 4 to 32 and would otherwise hide one another.
// Landscape: groups side by side. Portrait: stacked. Then one camera over the
// bounding box of everything placed, with a 6 percent margin.
export function arrange(items, W, H) {
  const portrait = H > W;
  const aspect = W / H;
  const groups = new Map();
  for (const it of items) {
    const b = boxFor(it);
    if (!b) continue;
    if (!groups.has(it.group)) groups.set(it.group, []);
    groups.get(it.group).push({ it, b, bw: b.x1 - b.x0, bh: b.y1 - b.y0 });
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const n = Math.max(1, keys.length);
  const cw = portrait ? aspect : aspect / n, ch = portrait ? 1 / n : 1;
  const gap = 0.04;
  let cursor = 0;
  const placed = [];
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const key of keys) {
    const list = groups.get(key);
    let gw = 1e-6, gh = 1e-6;
    for (const m of list) {
      m.ki = (m.it.scale ?? 1) / Math.max(m.bw, m.bh, 1e-6);
      gw = Math.max(gw, m.bw * m.ki); gh = Math.max(gh, m.bh * m.ki);
    }
    const gk = Math.min(cw / gw, ch / gh) * (list[0].it.size ?? 1);
    const w = gw * gk, h = gh * gk;
    const cx = portrait ? 0 : cursor + w / 2, cy = portrait ? cursor + h / 2 : 0;
    cursor += (portrait ? h : w) + gap;
    for (const m of list) placed.push({ ...m, gk, cx, cy });
    ux0 = Math.min(ux0, cx - w / 2); ux1 = Math.max(ux1, cx + w / 2);
    uy0 = Math.min(uy0, cy - h / 2); uy1 = Math.max(uy1, cy + h / 2);
  }
  const out = new Map();
  if (!placed.length) return { fit: 1, map: out };
  const uw = Math.max(ux1 - ux0, 1e-6), uh = Math.max(uy1 - uy0, 1e-6);
  const s = Math.min((W * (1 - 2 * MARGIN)) / uw, (H * (1 - 2 * MARGIN)) / uh);
  const ox = W / 2 - s * (ux0 + ux1) / 2, oy = H / 2 - s * (uy0 + uy1) / 2;
  for (const m of placed) {
    const k = s * m.gk * m.ki;
    const sx = ox + s * m.cx, sy = oy + s * m.cy;
    out.set(m.it.id, { k, tx: sx - (k * (m.b.x0 + m.b.x1)) / 2, ty: sy - (k * (m.b.y0 + m.b.y1)) / 2 });
  }
  return { fit: s, map: out };
}

// the forest: one row, every foot on one ground line, back plants (depth near 1) smaller.
// Spacing and depth come from the seed. compact: the row runs past the screen and pans so the
// active plant sits in the middle.
export function arrangeForest(items, W, H, o = {}) {
  const groups = new Map();
  for (const it of items) {
    const b = boxFor(it);
    if (!b) continue;
    if (!groups.has(it.group)) groups.set(it.group, []);
    groups.get(it.group).push({ it, b, foot: footOf(it, bboxOf(it.geom)) });
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const placed = [], centre = new Map();
  let cursor = 0, ux0 = Infinity, ux1 = -Infinity, uy0 = Infinity, uy1 = -Infinity;
  for (const key of keys) {
    const list = groups.get(key), lead = list[0];
    const depth = lead.it.depth ?? 0;
    const h = (1 - 0.38 * depth) * (lead.it.size ?? 1);
    const k0 = h / Math.max(lead.b.y1 - lead.b.y0, lead.b.x1 - lead.b.x0, 1e-6);
    let gx0 = Infinity, gx1 = -Infinity;
    for (const m of list) { m.kn = k0 * (m.it.scale ?? 1); gx0 = Math.min(gx0, (m.b.x0 - lead.b.x0) * m.kn); gx1 = Math.max(gx1, (m.b.x1 - lead.b.x0) * m.kn); }
    const w = gx1 - gx0, cx = cursor + w / 2;
    centre.set(key, cx);
    cursor += w + 0.04 + 0.16 * hash01(o.seed ?? 1, key);
    for (const m of list) {
      const bcx = (m.b.x0 + m.b.x1) / 2;
      placed.push({ ...m, cx, bcx });
      ux0 = Math.min(ux0, cx + (m.b.x0 - bcx) * m.kn); ux1 = Math.max(ux1, cx + (m.b.x1 - bcx) * m.kn);
      uy0 = Math.min(uy0, (m.b.y0 - m.foot) * m.kn); uy1 = Math.max(uy1, (m.b.y1 - m.foot) * m.kn);
    }
  }
  const out = new Map();
  if (!placed.length) return { fit: 1, map: out };
  const uw = Math.max(ux1 - ux0, 1e-6), uh = Math.max(uy1 - uy0, 1e-6);
  const sH = (H * (1 - 2 * MARGIN)) / uh, sAll = Math.min((W * (1 - 2 * MARGIN)) / uw, sH);
  // a phone in portrait would make 16 plants tiny: keep a readable height and pan instead
  const s = o.compact ? Math.min(sH, Math.max(sAll, (W * (1 - 2 * MARGIN)) / Math.min(uw, 1.6))) : sAll;
  let ox = W / 2 - s * (ux0 + ux1) / 2;
  if (uw * s > W * (1 - 2 * MARGIN)) {
    const ac = centre.get(o.active) ?? (ux0 + ux1) / 2;
    ox = W / 2 - s * ac;
    ox = Math.min(W * MARGIN - s * ux0, Math.max(W * (1 - MARGIN) - s * ux1, ox));
  }
  const oy = H / 2 - s * (uy0 + uy1) / 2;
  for (const m of placed) {
    const k = s * m.kn;
    out.set(m.it.id, { k, tx: ox + s * m.cx - k * m.bcx, ty: oy - k * m.foot });
  }
  return { fit: s, map: out };
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.base = document.createElement("canvas");
    this.bctx = this.base.getContext("2d");
    this.cur = new Map();   // id -> {from, to, t0}
    this.now = new Map();   // id -> {k, tx, ty}, the transform of this frame
    this.segs = new Map();  // id -> {rev, byIdx}
    this.fit = 1; this.fitFrom = 1; this.fitTo = 1; this.fitT0 = 0;
    this.sig = ""; this.baseSig = ""; this.items = [];
    this.dpr = 1;
    this.swayAmp = 0.012;   // shear at the top of a plant, as a fraction of its height (0 = still)
    this.swayT = 0;         // advances only while playing, so a paused stage is pixel-identical
    this.marks = [];        // {id, i, t}: expanding rings, drawn in the per-frame pass
    this.t = 0;
  }
  // true when the canvas really changed size (setting width clears it, so the caller redraws at once)
  setSize(w, h, dpr) {
    this.dpr = dpr;
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w; this.canvas.height = h;
    this.base.width = w; this.base.height = h;
    this.baseSig = ""; this.sig = ""; this.jump = true;
    return true;
  }
  addMark(id, i) { this.marks.push({ id, i, t: this.t }); if (this.marks.length > 96) this.marks.shift(); }
  // the shear of one plant this frame: a slow sway, its phase differing per plant
  _sway(id) { return this.swayAmp ? Math.sin(this.swayT / 2600 + id * 1.7) * this.swayAmp : 0; }
  update(items, t, arrangeFn = arrange) {
    const W = this.canvas.width, H = this.canvas.height;
    this.t = t;
    this.items = items;
    const sig = W + "x" + H + "|" + items.map((i) => `${i.id}:${i.rev}:${i.group}:${i.scale ?? 1}:${i.size ?? 1}`).join(",") + "|" + (this.arrangeKey || "");
    if (sig !== this.sig) {
      this.sig = sig;
      const { fit, map } = arrangeFn(items, W, H);
      for (const [id, to] of map) {
        const c = this.cur.get(id), at = this.now.get(id);
        if (c && at && !this.jump) this.cur.set(id, { from: at, to, t0: t });
        else this.cur.set(id, { from: to, to, t0: t - EASE_MS });
      }
      for (const id of [...this.cur.keys()]) if (!map.has(id)) { this.cur.delete(id); this.now.delete(id); }
      this.fitFrom = this.jump ? fit : this.fit; this.fitTo = fit; this.fitT0 = this.jump ? t - EASE_MS : t;
      this.jump = false;
    }
    let animating = false;
    for (const [id, c] of this.cur) {
      const p = Math.max(0, Math.min(1, (t - c.t0) / EASE_MS));
      if (p < 1) animating = true;
      const e = smooth(p);
      this.now.set(id, p >= 1 ? c.to : { k: c.from.k + (c.to.k - c.from.k) * e, tx: c.from.tx + (c.to.tx - c.from.tx) * e, ty: c.from.ty + (c.to.ty - c.from.ty) * e });
    }
    const pf = Math.max(0, Math.min(1, (t - this.fitT0) / EASE_MS));
    this.fit = this.fitFrom + (this.fitTo - this.fitFrom) * smooth(pf);
    this.animating = animating;
  }
  lineWidth() { return Math.max(this.dpr * 0.75, this.fit * 0.0032); }
  // the screen box of one plant, in device pixels
  boxOf(item) {
    const m = this.now.get(item.id), b = bboxOf(item.geom);
    if (!m || !b) return null;
    return { x0: m.tx + m.k * b.x0, y0: m.ty + m.k * b.y0, x1: m.tx + m.k * b.x1, y1: m.ty + m.k * b.y1 };
  }
  // hit test in device pixels: the smallest box under the point, base plants before layers
  pick(x, y, pad = 8) {
    let best = null, area = Infinity;
    for (const it of this.items) {
      if (it.layer) continue;
      const b = this.boxOf(it);
      if (!b || x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad) continue;
      const a = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
      if (a < area) { area = a; best = it.id; }
    }
    return best;
  }
  // local plant coordinates to device pixels, with the shear measured up from the plant's foot
  _proj(it, m) {
    const sh = this._sway(it.id), foot = footOf(it, bboxOf(it.geom));
    return { x: (x, y) => m.tx + m.k * (x + sh * Math.max(0, foot - y)), y: (y) => m.ty + m.k * y };
  }
  _drawBase(active) {
    const key = this.canvas.width + "x" + this.canvas.height + "|" + active + "|" + this.items.map((it) => {
      const m = this.now.get(it.id);
      return `${it.id}:${it.rev}:${it.dim ?? 0}:${this._sway(it.id).toFixed(5)}:${m ? m.k.toFixed(4) + "," + m.tx.toFixed(2) + "," + m.ty.toFixed(2) : ""}`;
    }).join(",");
    if (key === this.baseSig) return;
    this.baseSig = key;
    const c = this.bctx, W = this.base.width, H = this.base.height, lw = this.lineWidth();
    c.fillStyle = "#07090e"; c.fillRect(0, 0, W, H);
    c.lineCap = "round";
    // back to front: dim plants first, the active plant last
    const order = this.items.slice().sort((a, b) => (b.dim ?? 0) - (a.dim ?? 0) || (a.id === active) - (b.id === active));
    for (const it of order) {
      const m = this.now.get(it.id);
      if (!m) continue;
      const on = it.id === active;
      const dim = it.dim ?? 0;
      c.strokeStyle = on ? "#9FC8F0" : `rgba(92, 104, 158, ${(1 - dim * 0.7).toFixed(3)})`;
      c.lineWidth = lw * (on ? 1.9 : it.layer ? 0.7 : 1 - dim * 0.4);
      c.beginPath();
      const P = this._proj(it, m);
      for (const s of it.geom.segments) { c.moveTo(P.x(s.x1, s.y1), P.y(s.y1)); c.lineTo(P.x(s.x2, s.y2), P.y(s.y2)); }
      c.stroke();
      if (it.roots) { // below the ground: dimmer and thinner than the canopy, and a thin ground rule
        c.strokeStyle = on ? "rgba(46, 74, 140, 1)" : `rgba(62, 70, 107, ${(1 - dim * 0.6).toFixed(3)})`;
        c.lineWidth = lw * (on ? 0.9 : 0.8 - dim * 0.3);
        c.beginPath();
        for (const s of it.roots.segments) { c.moveTo(P.x(s.x1, s.y1), P.y(s.y1)); c.lineTo(P.x(s.x2, s.y2), P.y(s.y2)); }
        c.stroke();
        const b = this.boxOf(it), gy = P.y(it.roots.ground), pad = lw * 8;
        c.strokeStyle = "rgba(62, 70, 107, 0.9)"; c.lineWidth = Math.max(this.dpr * 0.75, lw * 0.4);
        c.beginPath();
        if (this.groundAll) { c.moveTo(0, gy); c.lineTo(W, gy); } else if (b) { c.moveTo(b.x0 - pad, gy); c.lineTo(b.x1 + pad, gy); }
        c.stroke();
      }
      if (on) { // the selection reads by weight and a thin frame, not by hue
        const b = this.boxOf(it), p = lw * 5;
        if (b) { c.strokeStyle = "#9FC8F0"; c.lineWidth = Math.max(this.dpr * 0.75, lw * 0.5); c.strokeRect(b.x0 - p, b.y0 - p, b.x1 - b.x0 + 2 * p, b.y1 - b.y0 + 2 * p); }
      }
    }
  }
  // lit: id -> Map(sentence index -> brightness)
  draw(active, lit) {
    const c = this.ctx, lw = this.lineWidth();
    this._drawBase(active);
    c.drawImage(this.base, 0, 0);
    c.lineCap = "round";
    for (const it of this.items) {
      const L = lit.get(it.id);
      if (!L || !L.size) { if (it.roots) this._cache(it); continue; }
      const m = this.now.get(it.id);
      if (!m) continue;
      let cache = this.segs.get(it.id);
      if (!cache || cache.rev !== it.rev) {
        const byIdx = new Map();
        for (const s of it.geom.segments) byIdx.set(s.i, s);
        if (it.roots) for (const s of it.roots.segments) if (s.i) byIdx.set(s.i, s); // root tips: negative ids
        cache = { rev: it.rev, byIdx }; this.segs.set(it.id, cache);
      }
      c.lineWidth = lw * 2.2;
      const P = this._proj(it, m);
      for (const [i, b] of L) {
        const s = cache.byIdx.get(i);
        if (!s) continue;
        const X2 = P.x(s.x2, s.y2), Y2 = P.y(s.y2);
        c.strokeStyle = `rgba(159, 200, 240, ${b.toFixed(3)})`;
        c.beginPath(); c.moveTo(P.x(s.x1, s.y1), P.y(s.y1)); c.lineTo(X2, Y2); c.stroke();
        c.fillStyle = c.strokeStyle;
        c.beginPath(); c.arc(X2, Y2, lw * 2.4 * b + lw, 0, Math.PI * 2); c.fill();
      }
    }
    this._drawMarks();
  }
  _cache(it) {
    let cache = this.segs.get(it.id);
    if (!cache || cache.rev !== it.rev) {
      const byIdx = new Map();
      for (const s of it.geom.segments) byIdx.set(s.i, s);
      if (it.roots) for (const s of it.roots.segments) if (s.i) byIdx.set(s.i, s);
      cache = { rev: it.rev, byIdx }; this.segs.set(it.id, cache);
    }
    return cache;
  }
  // a ring grows from the end of each sounded segment and fades over 1.4 s
  _drawMarks() {
    const c = this.ctx, d = this.dpr;
    let keep = 0;
    for (const mk of this.marks) {
      const age = (this.t - mk.t) / 1400;
      if (age >= 1) continue;
      this.marks[keep++] = mk;
      const it = this.items.find((x) => x.id === mk.id), m = it && this.now.get(mk.id), s = it && this._cache(it).byIdx.get(mk.i);
      if (!s || !m) continue;
      const P = this._proj(it, m);
      c.strokeStyle = `rgba(159, 200, 240, ${(0.45 * (1 - age)).toFixed(3)})`;
      c.lineWidth = d;
      c.beginPath(); c.arc(P.x(s.x2, s.y2), P.y(s.y2), (4 + age * 40) * d, 0, Math.PI * 2); c.stroke();
    }
    this.marks.length = keep;
  }
}
