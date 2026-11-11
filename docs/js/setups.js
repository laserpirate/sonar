// setups.js · labels, the local store, files and share links for a setup (Garden.toSetup / fromSetup).
// No DOM here beyond localStorage, so the tests can run it in Node.

export const pid = (n) => (n > 1000 ? "u" + (n - 1000) : "p" + String(n).padStart(2, "0"));
const MAX_LINK = 65536;     // encoded characters a share link may carry
const MAX_JSON = 524288;    // bytes a link or file may expand to

// the id and the facts, nothing else: "s04 · p06 p11 · 72 bpm · arp rain 1/8"
export function setupLabel(s, id = s.id) {
  const ps = s.plants || [];
  const parts = [ps.length > 4 ? `forest ${ps.length}` : ps.map((p) => (p.custom ? "user" : pid(p.instr))).join(" "), `${s.bpm ?? 90} bpm`];
  for (const [e, a] of Object.entries(s.arps || {})) if (a.mode && a.mode !== "off") parts.push(`arp ${e} ${a.rate || "1/8"}`);
  if (s.layers?.length) parts.push(`${s.layers.length} loops`);
  if (s.growth) parts.push(`growth ${s.growth}`);
  if (s.engineMode && s.engineMode !== "saw") parts.push(s.engineMode);
  const roots = ps.filter((p) => p.roots?.archetype).map((p) => p.roots.archetype);
  if (roots.length) parts.push("roots " + [...new Set(roots)].join(" "));
  return (id ? id + " · " : "") + parts.join(" · ");
}

const toB64u = (bytes) => { let t = ""; for (const b of bytes) t += String.fromCharCode(b); return btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fromB64u = (s) => { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/")); const a = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return a; };

async function readCapped(stream) {
  const r = stream.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (n > MAX_JSON) { await r.cancel(); throw new Error("setup too large"); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// "z" + deflate where the browser has CompressionStream, "j" + plain JSON where it does not
export async function encodeSetup(setup) {
  const bytes = new TextEncoder().encode(JSON.stringify(setup));
  if (typeof CompressionStream === "undefined") return "j" + toB64u(bytes);
  const z = await readCapped(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw")));
  return "z" + toB64u(z);
}
export async function decodeSetup(code) {
  if (typeof code !== "string" || code.length > MAX_LINK) throw new Error("setup link too long");
  let bytes = fromB64u(code.slice(1));
  if (code[0] === "z") bytes = await readCapped(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
  else if (code[0] !== "j" || bytes.length > MAX_JSON) throw new Error("setup link not readable");
  return JSON.parse(new TextDecoder().decode(bytes));
}

// numbered slots or typed names, in localStorage; an array in memory where the browser refuses it
export function createStore(key = "sonar.setups.v1") {
  let mem = [], persistent = true;
  const read = () => {
    try { const t = localStorage.getItem(key); const a = t ? JSON.parse(t) : mem; return Array.isArray(a) ? a : []; }
    catch { persistent = false; return mem; }
  };
  const write = (list) => { mem = list; try { localStorage.setItem(key, JSON.stringify(list)); } catch { persistent = false; } };
  return {
    list: read,
    get: (name) => read().find((x) => x.name === name)?.setup,
    put(name, setup) { const l = read().filter((x) => x.name !== name); l.push({ name, setup }); write(l); },
    remove(name) { write(read().filter((x) => x.name !== name)); },
    nextSlot() { const used = new Set(read().map((x) => x.name)); let n = 1; while (used.has(String(n))) n++; return String(n); },
    persistent: () => persistent,
  };
}

export const exportText = (items, plants = []) => JSON.stringify({ sonar_setups: 1, setups: items, plants }, null, 1);
// accepts an export, a list, or one bare setup; returns [{name, setup}] with the user plants in .plants
export function parseImport(text) {
  if (text.length > 8 * MAX_JSON) throw new Error("file too large");
  const data = JSON.parse(text);
  const raw = Array.isArray(data) ? data : Array.isArray(data?.setups) ? data.setups : data?.sonar_setups ? [] : [data];
  const out = [];
  for (const x of raw) {
    const setup = x?.setup ?? x;
    if (!setup || setup.v !== 1) throw new Error("not a sonar setup");
    out.push({ name: x?.name != null ? String(x.name).slice(0, 40) : null, setup });
  }
  out.plants = (Array.isArray(data?.plants) ? data.plants : []).map((x) => ({ name: x?.name != null ? String(x.name).slice(0, 40) : null, def: x?.setup ?? x?.def }));
  return out;
}
