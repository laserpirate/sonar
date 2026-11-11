#!/usr/bin/env node
// Static server for docs/ on 127.0.0.1, no dependencies.
//   node tools/serve.mjs [--port 8080] [--dir docs]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", flag("dir", "docs"));
const PORT = Number(flag("port", 8080));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".mp3": "audio/mpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8", ".wav": "audio/wav", ".webmanifest": "application/manifest+json" };

http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = normalize(join(ROOT, p));
    if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const st = await stat(f);
    if (st.isDirectory()) { res.writeHead(302, { Location: p + "/" }); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/`));
