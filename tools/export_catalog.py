#!/usr/bin/env python3
"""Export flora's default garden catalog (lib/gardens/garden_catalog_default.lua)
to docs/js/catalog.json so the browser and fake-norns run the same plants.

Also exports flora's sequencer defaults (scale notes from the real norns
musicutil, note scalar, durations, cf scalar) so lsys.js needs no norns.

Usage: python tools/export_catalog.py <repo_root> [<norns_lua_dir>]

screen_size is 127 x 64, as flora's lib/globals.lua sets it (not 128).
"""
import json
import sys
from pathlib import Path

import lupa.lua53 as lupa53

root = Path(sys.argv[1]).resolve()
norns_lua = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else (root.parent / "_norns" / "lua")

L = lupa53.LuaRuntime()
L.execute('''
screen_size = {x = 127, y = 64}
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

# flora defaults (lib/globals.lua, lib/parameters.lua): root 45, scale_mode 5,
# scale_length 24, root_note_offset 1, note_scalar 3, note duration index 5,
# cf scalar 1 active with option 3 -> cf_scalars_map[3] = 2
L2 = lupa53.LuaRuntime()
L2.execute(f'package.path = "{norns_lua.as_posix()}/lib/?.lua;" .. package.path')
mu = L2.execute('return require "musicutil"')
scales = L2.execute('local mu = require "musicutil"; local t = {} for i, s in ipairs(mu.SCALES) do t[i] = string.lower(s.name) end return t')
gen = L2.execute('''
local mu = require "musicutil"
local scale_length = 24
local notes = mu.generate_scale_of_length(45, 5, scale_length)
notes = mu.generate_scale_of_length(notes[1], 5, scale_length)
local num_to_add = scale_length - #notes
for i = 1, num_to_add do table.insert(notes, notes[scale_length - num_to_add]) end
return notes
''')
defaults = {
    "screen": [127, 64],
    "root_note": 45,
    "scale_mode": 5,
    "scale_name": scales[5],
    "scale_length": 24,
    "notes": conv(gen),
    "note_scalar": 3,
    "note_durations": [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16],
    "note_duration_index": 5,
    "cf_scalars_map": [0.5, 1, 2, 4],
    "cf_scalar_index": 3,
    "max_sentence_length": 300,
    "random_angle_max": 90,
    "turtle_min_length": 0.2,
    "initial_plant_instructions": [13, 13],
}
doc = {"source": "flora lib/gardens/garden_catalog_default.lua + lib/globals.lua defaults",
       "defaults": defaults, "plants": out}
(root / "docs/js/catalog.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
print(len(out), "plants -> docs/js/catalog.json; scale", scales[5], "notes", defaults["notes"][:6], "...")
for p in out:
    print(p["id"], p["axiom"][:30], [r[0] for r in p["ruleset"]], "gen", p["starting_generation"], "/",
          p["max_generations"], "angle", p["angle"], "len", p["length"], "from", p["start_from"])
