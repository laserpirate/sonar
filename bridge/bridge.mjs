#!/usr/bin/env node
// sonar bridge: UDP OSC (from norns) -> WebSocket JSON (to the browser),
// and WebSocket JSON (from the browser) -> UDP OSC (to norns).
//
//   node bridge.mjs [--udp 57120] [--ws 8765] [--norns 192.168.1.50] [--norns-port 10111] [--verbose]
//
// Binds 127.0.0.1 only. The browser connects to ws://127.0.0.1:8765.
// Messages on the wire are {"path": "/sonar/note", "args": [1, 12, 60, 261.6, 40, 20, 0.25]}.
// Any message whose path starts with /param/ or /sonar/ or /remote/ is forwarded to norns;
// everything else from the browser is echoed to the other browser clients only
// (so two pages can talk through the bridge without a norns in the room).

import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import { encode, decode } from "./osc-codec.mjs";

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const UDP_PORT = Number(flag("udp", 57120));
const WS_PORT = Number(flag("ws", 8765));
const NORNS_IP = flag("norns", process.env.SONAR_NORNS_IP || "");
const NORNS_PORT = Number(flag("norns-port", 10111));
const VERBOSE = argv.includes("--verbose");
const SHANSHUI = argv.includes("--shanshui");

const stats = { udpIn: 0, wsOut: 0, wsIn: 0, udpOut: 0, clients: 0, lastNornsFrom: null };

// --- UDP in (from norns) ----------------------------------------------------
// 127.0.0.1 is the safe default. --udp-any binds 0.0.0.0 so a norns on the LAN
// can reach a bridge running on the show laptop.
const UDP_HOST = argv.includes("--udp-any") ? "0.0.0.0" : "127.0.0.1";
const udp = dgram.createSocket("udp4");
udp.on("message", (buf, rinfo) => {
  const msg = decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (!msg) return;
  stats.udpIn++;
  stats.lastNornsFrom = rinfo.address;
  const json = JSON.stringify({ path: msg.address, args: msg.args, from: rinfo.address, t: Date.now() });
  for (const c of wss.clients) {
    if (c.readyState === 1) {
      c.send(json);
      stats.wsOut++;
    }
  }
  // --shanshui: every note also goes out MIDI-shaped for shanshui-av's av-in (later)
  if (SHANSHUI && msg.address === "/sonar/note") {
    const [plant, , note] = msg.args;
    const midiJson = JSON.stringify({ path: "/av/midi", args: [0x90 | ((plant - 1) & 15), note & 127, 100],
      midi: { type: "note", note: note & 127, velocity: 100, channel: plant }, t: Date.now() });
    for (const c of wss.clients) if (c.readyState === 1) c.send(midiJson);
  }
  if (VERBOSE) console.log("<-udp", msg.address, msg.args.map(a => (typeof a === "number" ? +a.toFixed(3) : a)).join(" "));
});
udp.on("error", (e) => console.error("udp error", e.message));
udp.bind(UDP_PORT, UDP_HOST, () => console.log(`udp  ${UDP_HOST}:${UDP_PORT}  (norns -> here)`));
const udpSend = (buf, port, ip) => udp.send(buf, port, ip);

// --- WebSocket (browser) ----------------------------------------------------
const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
wss.on("listening", () => console.log(`ws   ws://127.0.0.1:${WS_PORT}  (browser)`));
wss.on("connection", (ws) => {
  stats.clients = wss.clients.size;
  ws.send(JSON.stringify({ path: "/bridge/hello", args: [NORNS_IP || "", NORNS_PORT, UDP_PORT], t: Date.now() }));
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m.path !== "string") return;
    stats.wsIn++;
    const args = Array.isArray(m.args) ? m.args : [];
    const toNorns = /^\/(param|sonar|remote)\//.test(m.path) || m.path === "/sonar/reset";
    if (toNorns) {
      const ip = m.norns || NORNS_IP || stats.lastNornsFrom;
      if (ip) {
        udpSend(Buffer.from(encode(m.path, args)), NORNS_PORT, ip);
        stats.udpOut++;
        if (VERBOSE) console.log("->udp", ip, m.path, args.join(" "));
      } else if (VERBOSE) {
        console.log("drop (no norns ip yet)", m.path);
      }
    }
    // echo to other browser clients (renderer <-> controller without hardware)
    const json = JSON.stringify({ path: m.path, args, from: "ws", t: Date.now() });
    for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(json);
  });
  ws.on("close", () => { stats.clients = wss.clients.size; });
});

setInterval(() => {
  if (VERBOSE) console.log("stats", JSON.stringify(stats));
}, 10000);

process.on("SIGINT", () => { udp.close(); wss.close(); process.exit(0); });
