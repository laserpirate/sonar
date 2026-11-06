// Minimal OSC 1.0 codec: messages only (no bundles), types i f s b d T F.
// Shared by bridge.mjs and fake-norns.mjs. No dependencies.

const enc = new TextEncoder();
const dec = new TextDecoder();

function pad4(n) {
  return (n + 3) & ~3;
}

function writeString(s) {
  const bytes = enc.encode(s);
  const out = new Uint8Array(pad4(bytes.length + 1));
  out.set(bytes);
  return out;
}

// args: array of numbers (float), integers tagged {i: 3}, strings, Uint8Array blobs, booleans
export function encode(address, args = []) {
  const parts = [writeString(address)];
  let tags = ",";
  const bodies = [];
  for (const a of args) {
    if (typeof a === "string") {
      tags += "s";
      bodies.push(writeString(a));
    } else if (typeof a === "boolean") {
      tags += a ? "T" : "F";
    } else if (a instanceof Uint8Array) {
      tags += "b";
      const b = new Uint8Array(4 + pad4(a.length));
      new DataView(b.buffer).setInt32(0, a.length);
      b.set(a, 4);
      bodies.push(b);
    } else if (a !== null && typeof a === "object" && "i" in a) {
      tags += "i";
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, Math.trunc(a.i));
      bodies.push(b);
    } else if (typeof a === "number") {
      if (Number.isInteger(a) && Math.abs(a) < 2 ** 31) {
        tags += "i";
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, a);
        bodies.push(b);
      } else {
        tags += "f";
        const b = new Uint8Array(4);
        new DataView(b.buffer).setFloat32(0, a);
        bodies.push(b);
      }
    } else {
      throw new Error("osc encode: unsupported arg " + String(a));
    }
  }
  parts.push(writeString(tags), ...bodies);
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = dec.decode(buf.subarray(off, end));
  return [s, pad4(end + 1)];
}

// returns {address, args} or null when the packet is not a message
export function decode(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
  if (buf.length < 4 || buf[0] !== 47 /* '/' */) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let [address, off] = readString(buf, 0);
  let tags = "";
  if (off < buf.length && buf[off] === 44 /* ',' */) {
    [tags, off] = readString(buf, off);
    tags = tags.slice(1);
  }
  const args = [];
  for (const t of tags) {
    switch (t) {
      case "i": args.push(view.getInt32(off)); off += 4; break;
      case "f": args.push(view.getFloat32(off)); off += 4; break;
      case "d": args.push(view.getFloat64(off)); off += 8; break;
      case "s": { const [s, o] = readString(buf, off); args.push(s); off = o; break; }
      case "b": { const n = view.getInt32(off); args.push(buf.slice(off + 4, off + 4 + n)); off += 4 + pad4(n); break; }
      case "T": args.push(true); break;
      case "F": args.push(false); break;
      case "N": args.push(null); break;
      default: return { address, args, error: "unsupported tag " + t };
    }
  }
  return { address, args };
}
