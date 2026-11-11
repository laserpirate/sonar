// render_v03_demos.mjs · the v03 demos, 90 s each, software renders of the sim garden (not the norns).
//   node tools/render_v03_demos.mjs [name ...]     writes docs/demos/*.mp3 and prints one JSON line per demo
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = 90;
export const DEMOS = [
  { name: "engines", file: "garden_seed42_saw-arp-up16-2oct-delay035_rain-arp-down8-delay040-pingpong_software-render_v01.mp3",
    opts: { seed: 42, seconds: S, bpm: 96, routes: { 1: "saw", 2: "rain" }, arps: { saw: { mode: "up", rate: "1/16", octaves: 2 }, rain: { mode: "down", rate: "1/8", octaves: 1 } },
      delays: { saw: { amount: 0.35, div: "d1/8" }, rain: { amount: 0.4, div: "1/4", pingpong: true } } } },
  { name: "forest", file: "garden_seed42_forest16_budget6_leads2_software-render_v01.mp3",
    opts: { seed: 42, seconds: S, bpm: 90, forest: { n: 16, leads: 2, density: 0.6, budget: 6 } } },
  { name: "pluck", file: "garden_seed42_voice-pluck_software-render_v01.mp3", opts: { seed: 42, seconds: S, bpm: 90, routes: { 1: "pluck", 2: "pluck" } } },
  { name: "sine", file: "garden_seed42_voice-sine_software-render_v01.mp3", opts: { seed: 42, seconds: S, bpm: 90, routes: { 1: "sine", 2: "sine" } } },
  { name: "water", file: "garden_seed42_voice-water_software-render_v01.mp3", opts: { seed: 42, seconds: S, bpm: 90, routes: { 1: "water", 2: "water" } } },
  { name: "cues", file: "garden_cues_s03-bar0_s06-bar8_s10-bar16_bpm96_software-render_v01.mp3",
    opts: { seconds: S, cuesFactory: [[0, "s03"], [8, "s06"], [16, "s10"]] } },
  { name: "roots", file: "garden_seed42_roots-taproot_bass-sync4_software-render_v01.mp3",
    opts: { seed: 42, seconds: S, bpm: 84, roots: { 1: { archetype: "taproot", depth: 0.7, spread: 0.5, density: 0.5 } }, bass: { sync: 4 } } },
  { name: "flourish", file: "garden_seed42_flourish060_software-render_v01.mp3", opts: { seed: 42, seconds: S, bpm: 90, flourish: 0.6 } },
  { name: "space", file: "garden_seed42_reverb050-size4_wind025-tone800_software-render_v01.mp3",
    opts: { seed: 42, seconds: S, bpm: 90, fx: { reverb: { amount: 0.5, size: 4 }, wind: { level: 0.25, tone: 800 } } } },
];
const pick = process.argv.slice(2);
let bad = 0;
for (const d of DEMOS) {
  if (pick.length && !pick.includes(d.name)) continue;
  const r = spawnSync(process.execPath, [join(root, "tools", "render_garden.mjs"), join(root, "docs", "demos", d.file), JSON.stringify(d.opts)], { encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n").pop();
  try { const j = JSON.parse(line); delete j.state; j.out = d.file; console.log(d.name, JSON.stringify(j)); if (j.peakDb > -1) bad++; }
  catch { console.log(d.name, "FAILED", (r.stderr || "").slice(0, 400)); bad++; }
}
process.exit(bad ? 1 : 0);
