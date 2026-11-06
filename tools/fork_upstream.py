#!/usr/bin/env python3
"""Tier 0: build the sonar norns script from the vendored upstreams.

Copies upstream/flora -> repo root (sonar.lua + lib/) and upstream/raindrops
-> rain.lua + lib/Engine_SonarRain.sc, then applies the rename pass.
Every replacement asserts the count it expects, so a drift in upstream
shows up here and not on the norns.

Usage: python3 tools/fork_upstream.py <repo_root>
Re-runnable: it deletes and recreates sonar.lua, rain.lua and lib/ (except
lib/sonar_osc.lua, which is this repo's own module and is preserved).
"""
import re
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
up_flora = root / "upstream" / "flora"
up_rain = root / "upstream" / "raindrops"
lib = root / "lib"

PRESERVE = {"sonar_osc.lua"}

# ---- copy -----------------------------------------------------------------
preserved = {}
if lib.exists():
    for name in PRESERVE:
        p = lib / name
        if p.exists():
            preserved[name] = p.read_text(encoding="utf-8")
    shutil.rmtree(lib)
for f in ("sonar.lua", "rain.lua"):
    if (root / f).exists():
        (root / f).unlink()

shutil.copytree(up_flora / "lib", lib)
shutil.copy2(up_flora / "flora.lua", root / "sonar.lua")
shutil.copy2(up_rain / "raindrops.lua", root / "rain.lua")
shutil.copy2(up_rain / "Engine_Snowflake.sc", lib / "Engine_SonarRain.sc")
(lib / "Engine_BandSaw.sc").rename(lib / "Engine_SonarSaw.sc")
for name, text in preserved.items():
    (lib / name).write_text(text, encoding="utf-8")

# ---- replace --------------------------------------------------------------
log = []


def sub(path: Path, pattern: str, repl: str, expect, regex=False):
    text = path.read_text(encoding="utf-8")
    if regex:
        new, n = re.subn(pattern, repl, text)
    else:
        n = text.count(pattern)
        new = text.replace(pattern, repl)
    ok = (n in expect) if isinstance(expect, (set, range, tuple, list)) else (n == expect)
    log.append(f"{path.relative_to(root)}: {pattern!r} -> {repl!r}: {n} (expect {expect})")
    if not ok:
        raise SystemExit("COUNT MISMATCH\n" + "\n".join(log))
    path.write_text(new, encoding="utf-8")
    return n


# include paths: flora/lib -> sonar/lib, across every lua file
total_inc = 0
for p in [root / "sonar.lua", *lib.rglob("*.lua")]:
    t = p.read_text(encoding="utf-8")
    n = t.count('"flora/lib/') + t.count("'flora/lib/")
    if n:
        total_inc += sub(p, "flora/lib/", "sonar/lib/", n)
assert total_inc >= 30, total_inc
log.append(f"TOTAL include rewrites: {total_inc}")

# engine names
sub(lib / "globals.lua", "engine.name = 'BandSaw'", "engine.name = 'SonarSaw'", 1)
sub(lib / "Engine_SonarSaw.sc", "Engine_BandSaw", "Engine_SonarSaw", 2)
sub(lib / "Engine_SonarSaw.sc", r"\\BandSaw\b", r"\\SonarSaw", 1, regex=True)
sub(lib / "Engine_SonarSaw.sc", 'Synth("BandSaw"', 'Synth("SonarSaw"', 1)
sub(root / "rain.lua", "engine.name = 'Snowflake'", "engine.name = 'SonarRain'", 1)
sub(lib / "Engine_SonarRain.sc", "Engine_Snowflake", "Engine_SonarRain", 1)
sub(lib / "Engine_SonarRain.sc", 'SynthDef("Snowflake"', 'SynthDef("SonarRain"', 1)
sub(lib / "Engine_SonarRain.sc", 'Synth("Snowflake"', 'Synth("SonarRain"', 1)

# data paths that were literal "flora"
sub(lib / "cloud.lua", 'local script_name="flora"', 'local script_name="sonar"', 1)
sub(lib / "cloud.lua", '_path.data.."flora/', '_path.data.."sonar/', 2)

# headers
sub(root / "sonar.lua", "---flora\n-- v2.1.1\n-- lines: llllllll.co/t/40261\n",
    "---sonar\n-- v0.1.0\n-- flora fork (jaseknighter) with osc out/in\n-- github.com/laserpirate/sonar\n", 1)
sub(root / "rain.lua", "-- raindrops: random melodies\n-- 2.0.0 @ambalek\n",
    "-- rain: random melodies\n-- sonar 0.1.0, raindrops fork (@ambalek) with osc out\n", 1)

(root / "tools" / "fork_upstream.log").write_text("\n".join(log) + "\n", encoding="utf-8")
print("\n".join(log))
print("OK")
