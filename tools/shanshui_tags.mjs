// shanshui_tags.mjs · runs shanshui-av's copy of the upstream engine in Node (same order of draws
// as src/workers/gen-worker.js) and prints the planner tags per chunk for a few seeds.
// usage: node tools/shanshui_tags.mjs <path to upstream-engine.js> [chunks] [seed ...]
// Output: JSON {seed: {chunks, perChunk: {tag: mean}, gaps: {tag: [min, median, max] px}, firstX: {...}}}
import fs from 'node:fs';
import vm from 'node:vm';

const [, , enginePath, nArg, ...seedArgs] = process.argv;
if (!enginePath) { console.error('usage: node tools/shanshui_tags.mjs <upstream-engine.js> [chunks] [seed ...]'); process.exit(2); }
const N = +(nArg || 60);
const seeds = seedArgs.length ? seedArgs : ['1792909998082', '42', '1'];
const src = fs.readFileSync(enginePath, 'utf8');

function run(seed) {
  const ctx = { console: { log() {} }, location: { href: 'x' } };
  ctx.window = ctx; ctx.self = ctx;
  ctx.btoa = s => Buffer.from(s, 'binary').toString('base64');
  ctx.document = { addEventListener() {}, getElementById() { return null; } };
  ctx.Math = Object.create(Math);
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext(`Math.seed(${JSON.stringify(seed)}); chunkloader(0, 3000);`, ctx);
  // the paper texture draws 257 * 257 randoms after the first load (gen-worker.js paperTexture)
  vm.runInContext('for (var i = 0; i < 257 * 257; i++) { Noise.noise(0, 0); Math.random(); }', ctx);
  for (let k = 0; k < N; k++) vm.runInContext('chunkloader(MEM.xmin + MEM.cwid, MEM.xmax - MEM.cwid + 1);', ctx);
  const chunks = vm.runInContext('MEM.chunks.map(c => ({tag: c.tag, x: c.x, y: c.y}))', ctx);
  const xmax = vm.runInContext('MEM.xmax', ctx), xmin = vm.runInContext('MEM.xmin', ctx);
  // a mount adds two entries (the mountain, and its water at y - 10000); count the mountain only
  const real = chunks.filter(c => c.y > -5000);
  const tags = {};
  for (const c of real) (tags[c.tag] ||= []).push(c.x);
  const span = (xmax - xmin) / 512;
  const perChunk = {}, gaps = {};
  for (const [t, xs] of Object.entries(tags)) {
    xs.sort((a, b) => a - b);
    perChunk[t] = +(xs.length / span).toFixed(2);
    const g = xs.slice(1).map((x, i) => x - xs[i]).sort((a, b) => a - b);
    gaps[t] = g.length ? [Math.round(g[0]), Math.round(g[g.length >> 1]), Math.round(g[g.length - 1])] : null;
  }
  return { xmin, xmax, chunks: span, counts: Object.fromEntries(Object.entries(tags).map(([t, x]) => [t, x.length])), perChunk, gaps };
}

const out = {};
for (const s of seeds) out[s] = run(s);
console.log(JSON.stringify(out, null, 1));
