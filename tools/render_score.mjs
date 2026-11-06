// render_score.mjs · offline renders of the score to MP3 (software render, not the norns).
//   node tools/render_score.mjs <kind> <seed> <seconds> <out.mp3>
// Runs docs/js/score-offline.js in headless Chrome (Playwright from tests/node_modules) against
// tools/serve.mjs, takes 16-bit PCM back and encodes with ffmpeg (192 kbps, title tag only).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "tests", "package.json"));
const { chromium } = require("@playwright/test");
const [kind = "shanshui", seed = "1792909998082", secArg = "90", outArg] = process.argv.slice(2);
if (!outArg) { console.error("usage: node tools/render_score.mjs <kind> <seed> <seconds> <out.mp3>"); process.exit(2); }
const out = resolve(outArg), seconds = Number(secArg), port = 8197;

const server = spawn(process.execPath, [join(here, "serve.mjs"), "--port", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?seed=3`);
  const r = await page.evaluate(async ({ kind, seed, seconds }) => {
    const { renderScore, levels, pcm16base64 } = await import("./js/score-offline.js");
    const a = await renderScore({ kind, seed, seconds });
    const notes = a.log.filter((e) => e.k === "note").length, rain = a.log.filter((e) => e.k === "rain").length;
    return { b64: pcm16base64(a.buf), lv: levels(a.buf), notes, rain, state: a.state, sr: a.buf.sampleRate };
  }, { kind, seed, seconds });
  const pcm = Buffer.from(r.b64, "base64");
  const title = `sonar score ${kind} seed ${seed}, software render, not the norns`;
  await new Promise((res, rej) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(r.sr), "-ac", "2", "-i", "pipe:0",
      "-map_metadata", "-1", "-metadata", `title=${title}`, "-codec:a", "libmp3lame", "-b:a", "192k", out], { stdio: ["pipe", "inherit", "inherit"] });
    ff.on("exit", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
    ff.stdin.end(pcm);
  });
  console.log(JSON.stringify({ out, kb: Math.round(statSync(out).size / 1024), seconds, peakDb: +r.lv.peakDb.toFixed(1), rmsDb: +r.lv.rmsDb.toFixed(1), notes: r.notes, rain: r.rain, state: r.state }));
} finally {
  await browser.close();
  server.kill();
}
