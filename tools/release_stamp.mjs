// release_stamp.mjs · stamp docs/index.html's app.js script tag with the short HEAD sha, so a
// release never meets a 10 minute GitHub Pages cache of the old module.
//   node tools/release_stamp.mjs        (run before the release commit; commit the result)
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const sha = execSync("git rev-parse --short HEAD").toString().trim();
const p = new URL("../docs/index.html", import.meta.url);
const t = readFileSync(p, "utf8");
const out = t.replace(/src="js\/app\.js(\?v=[0-9a-f]+)?"/, `src="js/app.js?v=${sha}"`);
if (out === t) { console.log("no change"); process.exit(0); }
writeFileSync(p, out);
console.log("stamped", sha);
