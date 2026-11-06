// bundle_score.mjs · the six score modules as one ES module (imports between them removed), for pages
// that open from file:// and import the score from a Blob URL (the kc scenes).
//   node tools/bundle_score.mjs <out.js> [sha]
// Fails on a duplicate top-level name. The bundle is checked by importing it and running 10 s of the sim.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ORDER = ["catalog.js", "map.js", "lsys.js", "engine-saw.js", "engine-rain.js", "score.js"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [outArg, shaArg] = process.argv.slice(2);
if (!outArg) { console.error("usage: node tools/bundle_score.mjs <out.js> [sha]"); process.exit(2); }
const sha = shaArg || execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const names = new Map();
let body = "";
for (const f of ORDER) {
  let src = readFileSync(join(root, "docs", "js", f), "utf8");
  const before = src.length;
  src = src.replace(/^import [^;]+ from "\.\/[\w-]+\.js";\r?\n/gm, "").replace(/^export default [^;]+;\r?\n/gm, "");
  for (const m of src.matchAll(/^(?:export )?(?:async )?(?:const|let|var|function\*?|class) (\w+)/gm)) {
    if (names.has(m[1])) { console.error(`duplicate top-level ${m[1]} in ${f} and ${names.get(m[1])}`); process.exit(1); }
    names.set(m[1], f);
  }
  body += `\n// ---- ${f} (${before} bytes before import lines were removed) ----\n` + src;
}
const out = `// sonar score bundle · ported from laserpirate/sonar :: docs/js/{${ORDER.join(",")}} @ ${sha}\n// one module, imports between the six files removed by tools/bundle_score.mjs\n` + body;
const outPath = resolve(outArg);
writeFileSync(outPath, out);
const mod = await import(pathToFileURL(outPath).href + "?check=" + Date.now());
const s = new mod.Score(); s.seed("kc-01");
for (let i = 0; i < 300; i++) s.scene({ kind: "kodama", t: i / 30, phase: 1, pu: i / 300, cycle: 0 }), i === 0 && s.play();
console.log("bundle", outPath, Math.round(out.length / 1024), "KB,", names.size, "names, check:", s.state().plant, "events", s.log.length);
