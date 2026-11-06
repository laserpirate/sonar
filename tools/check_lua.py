#!/usr/bin/env python3
"""Tier 0/1 check: compile every .lua, then load each entry script under the
headless norns mock (tools/norns_mock.lua), run init(), step the clock,
call redraw(), and report engine / osc / screen activity.

Usage:
  python3 tools/check_lua.py <repo_root> <norns_lua_dir> [--beats N] [--script sonar|rain] [--verbose]

Exit code 0 only if every file compiles and every entry script reaches the
end of init() and survives N beats of clock without a coroutine error.
Prints a JSON summary on the last line (consumed by tests and MORNING.md).
"""
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import lupa.lua53 as lupa53

ap = argparse.ArgumentParser()
ap.add_argument("root")
ap.add_argument("norns_lua")
ap.add_argument("--beats", type=float, default=32)
ap.add_argument("--script", default="sonar,rain")
ap.add_argument("--verbose", action="store_true")
args = ap.parse_args()

# flora's load path can block on stdin (seen under lupa); never give it one
_devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(_devnull, 0)

root = Path(args.root).resolve()
norns_lua = Path(args.norns_lua).resolve()
summary = {"compile": {}, "scripts": {}}
fail = False

# ---- 1. compile every lua file -------------------------------------------
L = lupa53.LuaRuntime(unpack_returned_tuples=True)
loadfile = L.eval("loadfile")
for p in sorted(root.rglob("*.lua")):
    if "upstream" in p.parts or "node_modules" in p.parts:
        continue
    res = loadfile(str(p))
    fn, err = (res if isinstance(res, tuple) else (res, None))
    rel = str(p.relative_to(root))
    if fn is None:
        summary["compile"][rel] = str(err)
        fail = True
    else:
        summary["compile"][rel] = "ok"
n_ok = sum(1 for v in summary["compile"].values() if v == "ok")
print(f"compile: {n_ok}/{len(summary['compile'])} ok")
for k, v in summary["compile"].items():
    if v != "ok":
        print("  FAIL", k, v)

# ---- 2. run each entry script under the mock -----------------------------
def run_script(name: str):
    L = lupa53.LuaRuntime(unpack_returned_tuples=True)
    g = L.globals()
    data_root = tempfile.mkdtemp(prefix="norns-data-")
    # dust/code/ is the parent of the repo so that include("sonar/lib/x") resolves
    code_root = str(root.parent)
    if root.name != "sonar":
        # make a symlink farm so the folder is called sonar
        code_root = tempfile.mkdtemp(prefix="norns-code-")
        os.symlink(str(root), os.path.join(code_root, "sonar"))
    g.NORNS_LUA = str(norns_lua)
    g.CODE_ROOT = code_root
    g.DATA_ROOT = data_root
    g.SCRIPT_NAME = name
    mock = L.execute(Path(root / "tools" / "norns_mock.lua").read_text(encoding="utf-8"))
    mock.verbose = args.verbose
    result = {"loaded": False, "init": False, "beats": 0, "error": None}
    try:
        L.execute(f'dofile("{root}/{name}.lua")')
        result["loaded"] = True
        result["engine_name"] = g.engine.name
        g.init()
        result["init"] = True
        step = mock.step
        step(args.beats)
        result["beats"] = args.beats
        if mock.clock_error:
            result["error"] = "clock: " + str(mock.clock_error)
        g.redraw()
        if g.cleanup:
            g.cleanup()
    except Exception as e:  # lupa.LuaError
        result["error"] = str(e).splitlines()[0][:400]
    # collect logs
    eng = list(mock.log.engine.values()) if mock.log.engine else []
    osc = list(mock.log.osc.values()) if mock.log.osc else []
    result["engine_calls"] = len(eng)
    cmds = {}
    for call in eng:
        k = call[1]
        cmds[k] = cmds.get(k, 0) + 1
    result["engine_cmds"] = cmds
    result["osc_msgs"] = len(osc)
    paths = {}
    for m in osc:
        paths[m["path"]] = paths.get(m["path"], 0) + 1
    result["osc_paths"] = paths
    result["osc_sample"] = [[m["path"], list(m["args"].values()) if m["args"] else []] for m in osc[:6]]
    result["screen_calls"] = {k: int(v) for k, v in dict(mock.log.screen).items()} if mock.log.screen else {}
    result["lines_drawn"] = int(mock.log.lines or 0)
    result["params"] = int(g.params.count) if g.params else 0
    errs = [s for s in (list(mock.log.prints.values()) if mock.log.prints else []) if "error" in s.lower()]
    result["error_prints"] = errs[:10]
    return result

for name in args.script.split(","):
    r = run_script(name)
    summary["scripts"][name] = r
    status = "OK" if (r["init"] and not r["error"]) else "FAIL"
    if status == "FAIL":
        fail = True
    print(f"{name}.lua: {status} loaded={r['loaded']} init={r['init']} beats={r['beats']} "
          f"engine={r.get('engine_name')} params={r['params']} engine_calls={r['engine_calls']} "
          f"osc={r['osc_msgs']} lines={r['lines_drawn']}")
    if r["error"]:
        print("  error:", r["error"])
    for e in r["error_prints"]:
        print("  print:", e)

print(json.dumps(summary, default=str))
sys.exit(1 if fail else 0)
