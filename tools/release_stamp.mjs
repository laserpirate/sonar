// release_stamp.mjs · stamp docs/index.html with the short HEAD sha, so a release never meets a
// 10 minute GitHub Pages cache of an old module: the app.js script tag carries ?v=<sha>, and an
// import map gives every other module under docs/js the same query.
//   node tools/release_stamp.mjs        (run before the release commit; commit the result)
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const sha = execSync("git rev-parse --short HEAD").toString().trim();
const p = new URL("../docs/index.html", import.meta.url);
const t = readFileSync(p, "utf8");
const mods = readdirSync(new URL("../docs/js/", import.meta.url)).filter((f) => f.endsWith(".js") && f !== "app.js").sort();
const imports = Object.fromEntries(mods.map((f) => [`./js/${f}`, `./js/${f}?v=${sha}`]));
const map = `<script type="importmap" id="stamp">${JSON.stringify({ imports })}</script>`;
let out = t.replace(/src="js\/app\.js(\?v=[0-9a-f]+)?"/, `src="js/app.js?v=${sha}"`);
if (/<script type="importmap" id="stamp">.*?<\/script>/s.test(out)) out = out.replace(/<script type="importmap" id="stamp">.*?<\/script>/s, map);
else {
  const anchor = '<script type="module" src="js/app.js';
  if (out.split(anchor).length !== 2) throw new Error("app.js script tag not found exactly once");
  out = out.replace(anchor, map + "\n" + anchor);
}
if (out === t) { console.log("no change"); process.exit(0); }
writeFileSync(p, out);
console.log("stamped", sha, mods.length, "modules");
