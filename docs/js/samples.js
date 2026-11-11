// samples.js · loaded sounds kept in IndexedDB, banks, and .sonarbank files.
// A .sonarbank is a zip: bank.json plus the audio files, written and read here (no library).
// Nothing leaves the browser.

const DB = "sonar-samples", STORE = "files";
const mem = new Map();   // used when IndexedDB is refused (private windows, some previews)
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((ok, no) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    } catch (e) { no(e); }
  });
  return dbp;
}
async function tx(mode, f) {
  let d;
  try { d = await db(); } catch { return f(null); }
  return new Promise((ok, no) => { const t = d.transaction(STORE, mode); const req = f(t.objectStore(STORE)); t.oncomplete = () => ok(req?.result); t.onerror = () => no(t.error); });
}
// rec: {id: "smp1", name, type, bytes: ArrayBuffer}
export const putSample = (rec) => tx("readwrite", (s) => (s ? s.put(rec) : (mem.set(rec.id, rec), null)));
export const getSample = (id) => tx("readonly", (s) => (s ? s.get(id) : { result: mem.get(id) })).then((x) => x ?? mem.get(id));
export const listSamples = () => tx("readonly", (s) => (s ? s.getAll() : { result: [...mem.values()] })).then((x) => x ?? [...mem.values()]);
export const deleteSample = (id) => tx("readwrite", (s) => (s ? s.delete(id) : (mem.delete(id), null)));
export const persistentSamples = async () => { try { await db(); return true; } catch { return false; } };
export const nextSampleId = (have) => { const used = new Set(have.map((x) => x.id)); let n = 1; while (used.has("smp" + n)) n++; return "smp" + n; };
export const AUDIO_EXT = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|flac|aif|aiff|caf|webm)$/i;

// ---- zip ------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
// files: [{name, bytes: Uint8Array}], stored without compression (audio does not shrink much)
export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes), n = f.bytes.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.bytes);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + n;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
}
// returns Map(name -> Uint8Array); stored and deflated entries; refuses more than 256 entries or 400 MB
export async function unzip(buf) {
  const u = new Uint8Array(buf), v = new DataView(u.buffer, u.byteOffset, u.byteLength), dec = new TextDecoder();
  let e = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip");
  const count = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true);
  if (count > 256) throw new Error("too many files");
  const out = new Map();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip directory broken");
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), loc = v.getUint32(p + 42, true);
    const name = dec.decode(u.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    total += usize;
    if (total > 400 * 1024 * 1024) throw new Error("zip too large");
    const start = loc + 30 + v.getUint16(loc + 26, true) + v.getUint16(loc + 28, true);
    const data = u.subarray(start, start + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()));
    else throw new Error("zip method " + method);
  }
  return out;
}

// ---- banks --------------------------------------------------------------------------
// bank: {sonar_bank: 1, name, voices: {id: params}, samples: [{id, name, file}]}
export async function bankFile(bank) {
  const files = [], refs = [];
  for (const s of bank.samples || []) {
    const rec = await getSample(s.id);
    if (!rec) continue;
    const file = `samples/${s.id}_${String(s.name).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60)}`;
    files.push({ name: file, bytes: new Uint8Array(rec.bytes) });
    refs.push({ id: s.id, name: s.name, file });
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...bank, sonar_bank: 1, samples: refs }, null, 1));
  return zip([{ name: "bank.json", bytes: json }, ...files]);
}
// reads a .sonarbank; returns {bank, audio: Map(file -> Uint8Array)}
export async function readBankFile(buf) {
  const files = await unzip(buf);
  const j = files.get("bank.json");
  if (!j) throw new Error("no bank.json");
  const bank = JSON.parse(new TextDecoder().decode(j));
  if (bank?.sonar_bank !== 1) throw new Error("not a sonar bank");
  return { bank, audio: files };
}
