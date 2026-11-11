// roots.js · root systems below a ground line, and the bass walk over their tips. Pure, seeded.
// after phylla-arp (SymbiOS, Phylla biome), behaviour reimplemented: five archetypes, curved axes
// drawn as short segments that bend toward vertical, tips as the nodes a bass line walks.
//
// Plant coordinates: norns pixels, y down. The foot is where the plant starts; roots grow to +y.
import { makeRandom } from "./lsys.js";

export const ARCHETYPES = ["taproot", "plate", "fibrous", "rhizome", "ericaceous"];
export const ROOT_DEFAULT = () => ({ archetype: null, depth: 0.6, spread: 0.5, density: 0.5 });

// one curved axis from (x, y): heading a (radians, 0 = +x, pi/2 = down), `len` long in `n` steps,
// turning toward straight down by `bend` per step, with a small seeded wobble
function axis(out, x, y, a, len, n, bend, r, wob = 0.08) {
  const step = len / n, pts = [[x, y]];
  for (let i = 0; i < n; i++) {
    a += (Math.PI / 2 - a) * bend + (r() - 0.5) * wob;
    const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
    out.push({ x1: x, y1: y, x2: nx, y2: ny, i: 0 });
    x = nx; y = ny; pts.push([x, y]);
  }
  return { x, y, pts };
}

// p: {archetype, depth, spread, density}; foot: {x, y}; h: canopy height (sets the scale); seed
export function growRoots(p, foot, h, seed) {
  const r = makeRandom((seed >>> 0) || 1);
  const D = h * (0.3 + 0.9 * p.depth), Wd = h * (0.3 + 1.2 * p.spread), dens = p.density;
  const segs = [], tips = [];
  const tip = (e) => { segs[segs.length - 1].i = -(tips.length + 1); tips.push({ x: e.x, y: e.y }); };
  const { x: fx, y: fy } = foot;
  switch (p.archetype) {
    case "taproot": {
      // one deep axis, lobes off its sides
      const main = axis(segs, fx, fy, Math.PI / 2 + (r() - 0.5) * 0.2, D, 14, 0.15, r, 0.12);
      tip(main);
      const lobes = 2 + Math.round(dens * 5);
      for (let k = 0; k < lobes; k++) {
        const [lx, ly] = main.pts[2 + Math.floor(r() * (main.pts.length - 5))];
        const side = k % 2 ? 1 : -1;
        tip(axis(segs, lx, ly, Math.PI / 2 - side * (0.6 + r() * 0.5), D * (0.2 + r() * 0.25), 6, 0.12, r));
      }
      break;
    }
    case "plate": {
      // a short stem, wide laterals, sinkers dropping from them
      const stem = axis(segs, fx, fy, Math.PI / 2, D * 0.12, 2, 0, r, 0);
      const lats = 3 + Math.round(dens * 5);
      for (let k = 0; k < lats; k++) {
        const side = k % 2 ? 1 : -1;
        const a0 = side > 0 ? 0.08 + r() * 0.25 : Math.PI - 0.08 - r() * 0.25;
        const lat = axis(segs, stem.x, stem.y, a0, Wd * (0.45 + r() * 0.55), 8, 0.03, r, 0.05);
        const sinkers = 1 + Math.floor(r() * (1 + dens * 2));
        for (let j = 0; j < sinkers; j++) {
          const [sx, sy] = lat.pts[Math.max(2, lat.pts.length - 1 - Math.floor(r() * 4))];
          tip(axis(segs, sx, sy, Math.PI / 2, D * (0.15 + r() * 0.3), 3, 0.3, r));
        }
      }
      break;
    }
    case "fibrous": {
      // many near-vertical axes fanning out of the foot
      const n = 6 + Math.round(dens * 14);
      for (let k = 0; k < n; k++) {
        const a0 = Math.PI / 2 + (k / (n - 1) - 0.5) * (0.5 + p.spread * 0.7) + (r() - 0.5) * 0.12;
        tip(axis(segs, fx, fy, a0, D * (0.55 + r() * 0.45), 8, 0.06, r, 0.1));
      }
      break;
    }
    case "rhizome": {
      // two horizontal runners, droppers along them
      for (const side of [-1, 1]) {
        const run = axis(segs, fx, fy + D * 0.08, side > 0 ? 0.03 : Math.PI - 0.03, Wd * 1.2, 12, 0, r, 0.06);
        const drops = 2 + Math.round(dens * 5);
        for (let j = 0; j < drops; j++) {
          const [dx, dy] = run.pts[1 + Math.floor(((j + 0.5) / drops) * (run.pts.length - 1))];
          tip(axis(segs, dx, dy, Math.PI / 2, D * (0.2 + r() * 0.3), 3, 0.4, r));
        }
      }
      break;
    }
    case "ericaceous": {
      // many shallow axes, close to horizontal
      const n = 6 + Math.round(dens * 10);
      for (let k = 0; k < n; k++) {
        const side = k % 2 ? 1 : -1, dip = 0.05 + r() * 0.22;
        tip(axis(segs, fx, fy, side > 0 ? dip : Math.PI - dip, Wd * (0.5 + r() * 0.5), 7, 0.015, r, 0.05));
      }
      break;
    }
    default: return null;
  }
  // tips left to right, each with its depth below the foot as 0..1
  let maxD = 1e-6;
  for (const t of tips) maxD = Math.max(maxD, t.y - fy);
  const order = tips.map((t, k) => ({ ...t, k, depth: (t.y - fy) / maxD })).sort((a, b) => a.x - b.x);
  return { segments: segs, tips: order, ground: fy, spread: Math.max(1e-6, ...tips.map((t) => Math.abs(t.x - fx))), foot: { x: fx, y: fy } };
}

// the bass walk: root, fifth, root, third of the scale; deeper tips an octave lower
export const BASS_PATTERN = [0, 4, 0, 2];
export const BASS_DEFAULT = () => ({ octave: -1, level: 0.6, decay: 0.35, release: 0.6, detune: 6, sync: 4, drone: 0.15 });
export const BASS_SYNCS = [4, 6, 8, 0]; // 0 = free, one note every 2 beats
export function bassStep(walk, roots, key, scaleIv, octave) {
  const n = roots.tips.length;
  if (!n) return null;
  const t = roots.tips[walk % n];
  const deg = BASS_PATTERN[walk % BASS_PATTERN.length];
  const iv = scaleIv[Math.min(deg, scaleIv.length - 1)];
  const note = key.root + 12 * octave + iv - (t.depth > 0.66 ? 12 : 0);
  return { note, tip: t.k, pan: Math.max(-1, Math.min(1, (t.x - roots.foot.x) / roots.spread)) };
}
