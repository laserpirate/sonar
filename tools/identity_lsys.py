#!/usr/bin/env python3
"""Identity check: docs/js/lsys.js against flora's own Lua.

1. Geometry. flora's rule.lua, l_system.lua, vector.lua, matrix_stack.lua and
   turtle.lua (the repo copies, unedited apart from the include path) run under
   lupa with a screen that records lines. Each plant is set up as plant.lua's
   setup() does (plant 1, start_from - 127/4, generate target times) and drawn
   as redraw_fn() does. Sentence, segment count and every segment end point
   must match lsys.js (1e-3 px).
2. Notes. The full norns mock runs sonar.lua, sets plant 1 to the catalog
   entry and steps the clock; every /sonar/note gives (sentence index, note).
   lsys.js's Sequencer must give the same note for the same index.

Usage: python tools/identity_lsys.py <repo> <norns_lua> [--plants 1,2,4] [--gen 2] [--beats 24]
Exit 0 only if every plant matches. Writes tests/logs/identity_lsys_v01.json.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import lupa.lua53 as lupa53

ap = argparse.ArgumentParser()
ap.add_argument("root")
ap.add_argument("norns_lua")
ap.add_argument("--plants", default="1,2,4")
ap.add_argument("--gen", type=int, default=2)
ap.add_argument("--beats", type=float, default=24)
args = ap.parse_args()
_devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(_devnull, 0)
root = Path(args.root).resolve()
nums = [int(x) for x in args.plants.split(",")]
catalog = json.loads((root / "docs/js/catalog.json").read_text(encoding="utf-8"))

# ---- JS side ---------------------------------------------------------------
js = json.loads(subprocess.run(["node", str(root / "tools/lsys_dump.mjs"), args.plants, str(args.gen), str(args.beats)],
                               capture_output=True, text=True, encoding="utf-8", check=True).stdout)

# ---- Lua geometry ----------------------------------------------------------
def lua_geometry(n):
    L = lupa53.LuaRuntime(unpack_returned_tuples=True)
    g = L.globals()
    libdir = (root / "lib").as_posix()
    L.execute(f'''
    LIB = "{libdir}"
    math.atan2 = math.atan2 or function(y, x) return math.atan(y, x) end -- norns: 5.3 with 5.2 compat
    function include(f)
      local name = f:gsub("^sonar/lib/", "")
      return dofile(LIB .. "/" .. name .. ".lua")
    end
    screen_size = {{x = 127, y = 64}}
    MAX_SENTENCE_LENGTH = 300
    RANDOM_ANGLE_MAX = 90
    LINES = {{}}
    local cur = {{0, 0}}
    screen = {{
      move = function(x, y) cur = {{x, y}} end,
      line = function(x, y) LINES[#LINES + 1] = {{cur[1], cur[2], x, y}}; cur = {{x, y}} end,
      circle = function() end, stroke = function() end, line_width = function() end,
    }}
    vector = include("sonar/lib/vector")
    rule = include("sonar/lib/rule")
    l_system = include("sonar/lib/l_system")
    turtle_class = include("sonar/lib/turtle")
    ''')
    p = catalog["plants"][n - 1]
    rs = "{" + ",".join("{%s,%s}" % (json.dumps(a), json.dumps(b)) for a, b in p["ruleset"]) + "}"
    res = L.execute(f'''
    local start = vector:new({p["start_from"][0]} - screen_size.x/4, {p["start_from"][1]})
    local ls = l_system:new({json.dumps(p["axiom"])}, {rs})
    ls.reset_random_angles()
    local t = turtle_class:new(ls.get_sentence(), {p["length"]} or 35, math.rad({p["angle"]}))
    local gen = 0
    local target = {args.gen}
    for i = 1, target do
      if gen >= 0 and gen < {p["max_generations"]} then
        t.push(); ls.generate(1); gen = gen + 1; t.set_todo(ls.get_sentence()); t.pop()
      end
    end
    t.rotate(0, true)
    t.translate(start.x, start.y)
    t.rotate(math.rad({p["initial_turtle_rotation"]}))
    t.render(true)
    return ls.get_sentence(), gen
    ''')
    sentence, gen = res
    lines = [list(g.LINES[k].values()) for k in range(1, len(g.LINES) + 1)]
    return sentence, gen, lines

# ---- Lua notes (full flora under the norns mock) ---------------------------
def lua_notes(n):
    L = lupa53.LuaRuntime(unpack_returned_tuples=True)
    g = L.globals()
    code_root = tempfile.mkdtemp(prefix="nornscode")
    link = os.path.join(code_root, "sonar")
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(root), link)
    else:
        os.symlink(str(root), link)
    try:
        g.NORNS_LUA = Path(args.norns_lua).resolve().as_posix()
        g.CODE_ROOT = Path(code_root).as_posix()
        g.DATA_ROOT = Path(tempfile.mkdtemp(prefix="nornsdata")).as_posix()
        g.SCRIPT_NAME = "sonar"
        mock = L.execute((root / "tools/norns_mock.lua").read_text(encoding="utf-8"))
        L.execute(f'dofile("{Path(code_root).as_posix()}/sonar/sonar.lua")')
        g.init()
        mock.step(2)
        before = len(mock.log.osc)
        # setup() keeps the running note walk (ps.note carries over from the old
        # sentence). Retire that chain by bumping the sentence id, then start a
        # fresh walk from index 1 as start_playing() does, so both sides start equal.
        L.execute(f'plants[1].setup({n}, {args.gen}); plants[1].current_sentence_id = plants[1].current_sentence_id + 1; plants[1].sounds.set_note()')
        mock.step(args.beats)
        pairs = {}
        osc = mock.log.osc
        for k in range(before + 1, len(osc) + 1):
            m = osc[k]
            if m["path"] == "/sonar/note" and m["args"][1] == 1:
                pairs[int(m["args"][2])] = int(m["args"][3])
        return pairs, str(mock.clock_error or "")
    finally:
        os.rmdir(link)

report = {}
ok_all = True
for n in nums:
    key = f"p{n:02d}"
    sentence, gen, lines = lua_geometry(n)
    j = js[key]
    seg_ok = len(lines) == j["segments"]
    worst = 0.0
    if seg_ok:
        for a, b in zip(lines, j["seg"]):
            worst = max(worst, *(abs(a[q] - b[2 + q]) for q in range(4)))
    sent_ok = sentence == j["sentence"]
    lua_pairs, clock_err = lua_notes(n)
    js_pairs = {}
    for t, idx, note in j["notes"]:
        js_pairs.setdefault(idx, note)
    common = sorted(set(lua_pairs) & set(js_pairs))
    note_mismatch = [(i, lua_pairs[i], js_pairs[i]) for i in common if lua_pairs[i] != js_pairs[i]]
    ok = sent_ok and seg_ok and worst < 1e-3 and len(common) > 0 and not note_mismatch
    ok_all &= ok
    report[key] = {"ok": ok, "gen": gen, "sentence_match": sent_ok, "segments_lua": len(lines),
                   "segments_js": j["segments"], "max_point_error_px": worst,
                   "notes_compared": len(common), "note_mismatches": note_mismatch[:10],
                   "lua_clock_error": clock_err}
    print(f"{key} gen {gen}: sentence {'=' if sent_ok else '!='}, segments lua {len(lines)} js {j['segments']}, "
          f"max err {worst:.2e} px, notes {len(common)} compared, {len(note_mismatch)} mismatched -> {'OK' if ok else 'FAIL'}")
out = root / "tests/logs/identity_lsys_v01.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, indent=1), encoding="utf-8")
print(f"identity {sum(r['ok'] for r in report.values())}/{len(report)}")
sys.exit(0 if ok_all else 1)
