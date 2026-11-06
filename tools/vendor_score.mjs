// vendor_score.mjs · copy sonar's score modules into another repo's vendor folder, each with a
// "ported from" header naming the sonar commit. Imports between them stay relative (./lsys.js).
//   node tools/vendor_score.mjs <dest dir> [sha]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const FILES = ["score.js", "map.js", "lsys.js", "catalog.js", "engine-saw.js", "engine-rain.js"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [dest, shaArg] = process.argv.slice(2);
if (!dest) { console.error("usage: node tools/vendor_score.mjs <dest dir> [sha]"); process.exit(2); }
const sha = shaArg || execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  const src = readFileSync(join(root, "docs", "js", f), "utf8");
  writeFileSync(join(dest, f), `// ported from laserpirate/sonar :: docs/js/${f} @ ${sha}\n` + src);
}
writeFileSync(join(dest, "VERSION.txt"), `laserpirate/sonar @ ${sha}\n${FILES.join("\n")}\n`);
console.log("vendored", FILES.length, "files @", sha, "->", dest);
