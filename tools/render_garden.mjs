// render_garden.mjs · offline renders of the sim garden to MP3 (software render, not the norns).
//   node tools/render_garden.mjs <out.mp3> '<json opts>'
//   e.g. node tools/render_garden.mjs docs/demos/x.mp3 '{"seed":42,"seconds":90,"layers":[{"seed":7,"atBeat":16}]}'
// Runs docs/js/garden-offline.js in headless Chromium (Playwright from tests/node_modules)
// against tools/serve.mjs, takes 16-bit PCM back and encodes with ffmpeg (192 kbps, title tag only).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "tests", "package.json"));
const { chromium } = require("@playwright/test");
const [outArg, optsArg = "{}"] = process.argv.slice(2);
if (!outArg) { console.error("usage: node tools/render_garden.mjs <out.mp3> '<json opts>'"); process.exit(2); }
const out = resolve(outArg), opts = JSON.parse(optsArg), port = 8198;
const channel = process.env.PW_CHANNEL === undefined ? "chrome" : (process.env.PW_CHANNEL || undefined);

const server = spawn(process.execPath, [join(here, "serve.mjs"), "--port", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?seed=3`);
  const r = await page.evaluate(async (opts) => {
    const { renderGarden, levels, pcm16base64 } = await import("./js/garden-offline.js");
    const catalog = await (await fetch("./js/catalog.json")).json();
    const a = await renderGarden(catalog, opts);
    const count = (k) => a.log.filter((e) => e.k === k).length;
    return { b64: pcm16base64(a.buf), lv: levels(a.buf), notes: count("note"), loops: count("loop"), arp: count("arp"), layers: count("layer"), state: a.state, sr: a.buf.sampleRate };
  }, opts);
  const pcm = Buffer.from(r.b64, "base64");
  const title = `sonar garden seed ${opts.seed ?? 1}, software render, not the norns`;
  await new Promise((res, rej) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(r.sr), "-ac", "2", "-i", "pipe:0",
      "-map_metadata", "-1", "-metadata", `title=${title}`, "-codec:a", "libmp3lame", "-b:a", "192k", out], { stdio: ["pipe", "inherit", "inherit"] });
    ff.on("exit", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
    ff.stdin.end(pcm);
  });
  console.log(JSON.stringify({ out, kb: Math.round(statSync(out).size / 1024), seconds: opts.seconds || 60, peakDb: +r.lv.peakDb.toFixed(1), rmsDb: +r.lv.rmsDb.toFixed(1), notes: r.notes, loops: r.loops, arp: r.arp, layers: r.layers, state: r.state }));
} finally {
  await browser.close();
  server.kill();
}
