// Screenshots of the page for MORNING.md / review: wall and norns modes, sim.
//   node tests/shots.mjs <outdir>   (needs tools/serve.mjs on 8080)
import { chromium } from "@playwright/test";
const out = process.argv[2] || ".";
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
for (const [name, url] of [["wall", "index.html?seed=3&p1=2&p2=11"], ["norns", "index.html?seed=3&mode=norns"], ["wall_p13", "index.html?seed=5"]]) {
  await p.goto("http://127.0.0.1:8080/" + url);
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${out}/sonar_${name}.png` });
}
await b.close();
