#!/usr/bin/env python3
"""Export flora's default garden catalog (lib/gardens/garden_catalog_default.lua)
to docs/js/catalog.json so the browser and fake-norns run the same plants."""
import json, sys
from pathlib import Path
import lupa.lua53 as lupa53
root = Path(sys.argv[1]).resolve()
L = lupa53.LuaRuntime()
L.execute('''
screen_size = {x = 128, y = 64}
vector = {}
function vector:new(x, y) return {x = x, y = y} end
tab = {load = function() return nil end, save = function() end}
''')
cat = L.execute(Path(root / "lib/gardens/garden_catalog_default.lua").read_text(encoding="utf-8"))
def conv(v):
    if lupa53.lua_type(v) == "table":
        keys = list(v.keys())
        if keys and all(isinstance(k, int) for k in keys):
            return [conv(v[k]) for k in sorted(keys)]
        return {str(k): conv(v[k]) for k in keys}
    return v
plants = conv(cat)
out = []
for i, p in enumerate(plants, 1):
    out.append({
        "id": f"p{i:02d}",
        "start_from": [p["start_from"]["x"], p["start_from"]["y"]],
        "ruleset": p["ruleset"],
        "axiom": p["axiom"],
        "max_generations": p["max_generations"],
        "length": p["length"],
        "angle": p["angle"],
        "initial_turtle_rotation": p.get("initial_turtle_rotation", 0),
        "starting_generation": p.get("starting_generation", 1),
    })
(root / "docs/js/catalog.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
print(len(out), "plants ->", root / "docs/js/catalog.json")
for p in out: print(p["id"], p["axiom"][:30], [r[0] for r in p["ruleset"]], "gen", p["starting_generation"], "/", p["max_generations"], "angle", p["angle"], "len", p["length"])
