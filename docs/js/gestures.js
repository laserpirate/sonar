// gestures.js · pointer gestures on the stage. Each has a button equivalent in the plants panel.
//   tap            select the plant under it (an empty tap restores hidden controls)
//   drag on plant  horizontal turns its angle, vertical changes its length (flora's E2 and E3)
//   two-finger tap next generation
//   long press     plant palette for that slot

const MOVE = 12, LONG_MS = 550, TWO_MS = 300;

export function initGestures({ canvas, pick, act, S, angleOf, lengthOf, onLongPress, onEmptyTap }) {
  const pts = new Map();
  let g = null, timer = null, twoAt = 0, twoCandidate = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX, y: e.clientY, dx: (e.clientX - r.left) * (canvas.width / r.width), dy: (e.clientY - r.top) * (canvas.height / r.height) };
  };
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  canvas.addEventListener("pointerdown", (e) => {
    if (S.mode === "norns") return;
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, pos(e));
    if (pts.size === 1) {
      const p = pos(e), id = pick(p.dx, p.dy);
      g = { id, x: p.x, y: p.y, moved: false, angle: null, length: null, done: false };
      twoCandidate = false;
      clear();
      if (id) timer = setTimeout(() => { if (g && !g.moved) { g.done = true; act.plant(id); onLongPress(id); } }, LONG_MS);
    } else if (pts.size === 2) {
      clear();
      twoAt = performance.now();
      twoCandidate = !g || !g.moved;
      if (g) g.done = true;
    } else { twoCandidate = false; clear(); }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pos(e), first = pts.get(e.pointerId);
    if (Math.hypot(p.x - first.x, p.y - first.y) > MOVE) twoCandidate = false;
    if (!g || g.done || pts.size !== 1) return;
    const dx = p.x - g.x, dy = p.y - g.y;
    if (!g.moved && Math.hypot(dx, dy) > MOVE) {
      g.moved = true; clear();
      if (g.id) { act.plant(g.id); g.angle = angleOf(); g.length = lengthOf(); g.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y"; }
    }
    if (g.moved && g.id) {
      if (g.axis === "x") act.angle(Math.max(-360, Math.min(360, Math.round(g.angle + dx * 0.25))));
      else act.length(Math.max(0.35, Math.min(1.6, g.length * Math.exp(-dy * 0.005))));
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const was = pts.size;
    pts.delete(e.pointerId);
    clear();
    if (was === 2 && twoCandidate && performance.now() - twoAt < TWO_MS + 400) { twoCandidate = false; act.nextGen(); return; }
    if (pts.size === 0 && g && !g.moved && !g.done) {
      if (g.id) act.plant(g.id); else onEmptyTap();
    }
    if (pts.size === 0) g = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); clear(); if (!pts.size) g = null; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}
