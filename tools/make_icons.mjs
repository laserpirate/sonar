// make_icons.mjs · app icons from a plant drawing (p10 at generation 3, the same turtle), on the page's black.
//   node tools/make_icons.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "tests", "package.json"));
const { chromium } = require("@playwright/test");
const port = 8199;
const channel = process.env.PW_CHANNEL === undefined ? "chrome" : (process.env.PW_CHANNEL || undefined);
const server = spawn(process.execPath, [join(here, "serve.mjs"), "--port", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/robots.txt`);
  const out = await page.evaluate(async (port) => {
    const { Plant, makeRandom } = await import(`http://127.0.0.1:${port}/js/lsys.js`);
    const catalog = await (await fetch(`http://127.0.0.1:${port}/js/catalog.json`)).json();
    const p = new Plant(1, { random: makeRandom(42), defaults: catalog.defaults });
    p.setup(catalog.plants[9], 10, 3);
    const g = p.render();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of g.segments) { x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2); y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2); }
    const res = {};
    for (const n of [180, 192, 512]) {
      const c = document.createElement("canvas"); c.width = c.height = n;
      const x = c.getContext("2d");
      x.fillStyle = "#07090e"; x.fillRect(0, 0, n, n);
      const k = (n * 0.76) / Math.max(x1 - x0, y1 - y0), ox = n / 2 - (k * (x0 + x1)) / 2, oy = n / 2 - (k * (y0 + y1)) / 2;
      x.strokeStyle = "#9FC8F0"; x.lineWidth = Math.max(1.5, n / 90); x.lineCap = "round";
      x.beginPath();
      for (const s of g.segments) { x.moveTo(ox + k * s.x1, oy + k * s.y1); x.lineTo(ox + k * s.x2, oy + k * s.y2); }
      x.stroke();
      res[n] = c.toDataURL("image/png").split(",")[1];
    }
    return res;
  }, port);
  const dir = new URL("../docs/icons/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const [n, b64] of Object.entries(out)) writeFileSync(new URL(`icon-${n}.png`, dir), Buffer.from(b64, "base64"));
  console.log("icons", Object.keys(out).join(" "));
} finally { await browser.close(); server.kill(); }
