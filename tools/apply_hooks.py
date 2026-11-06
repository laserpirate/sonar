#!/usr/bin/env python3
"""Tier 1: wire lib/sonar_osc.lua into the forked scripts.

Run after tools/fork_upstream.py. Every insertion asserts that its anchor
occurs exactly once, so an upstream change shows up here as a count error.
Each hook is one line (or one guarded block) calling into sonar_osc; the
upstream logic is not changed.

Usage: python3 tools/apply_hooks.py <repo_root>
"""
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
log = []


def insert_after(path: Path, anchor: str, addition: str, expect=1):
    text = path.read_text(encoding="utf-8")
    n = text.count(anchor)
    log.append(f"{path.relative_to(root)}: after {anchor.strip()[:60]!r}: {n}")
    if n != expect:
        raise SystemExit("ANCHOR COUNT MISMATCH\n" + "\n".join(log))
    if addition in text:
        log[-1] += " (already applied)"
        return
    path.write_text(text.replace(anchor, anchor + addition), encoding="utf-8")


def insert_before(path: Path, anchor: str, addition: str, expect=1):
    text = path.read_text(encoding="utf-8")
    n = text.count(anchor)
    log.append(f"{path.relative_to(root)}: before {anchor.strip()[:60]!r}: {n}")
    if n != expect:
        raise SystemExit("ANCHOR COUNT MISMATCH\n" + "\n".join(log))
    if addition in text:
        log[-1] += " (already applied)"
        return
    path.write_text(text.replace(anchor, addition + anchor), encoding="utf-8")


lib = root / "lib"

# 1. include the module (sonar) ------------------------------------------------
insert_after(lib / "includes.lua",
             'plant_sounds = include("sonar/lib/plant_sounds") \n',
             'sonar_osc = include("sonar/lib/sonar_osc")\n')

# 2. params group, added last so it sits at the bottom of PARAMETERS ----------
insert_before(lib / "parameters.lua",
              "  --set the reverb input engine to -10db\n",
              "  sonar_osc.add_params()\n\n")

# 3. init / cleanup (sonar.lua) ------------------------------------------------
insert_after(root / "sonar.lua",
             "  save_load.init()\n",
             '  sonar_osc.init("sonar")\n')
insert_after(root / "sonar.lua",
             "function cleanup ()\n  all_notes_off()\n",
             "  sonar_osc.cleanup()\n")

# 4. plant: generation, setup, active plant -----------------------------------
insert_after(lib / "plant.lua",
             "      p.turtle.pop()\n      p.restart_rendering = true\n",
             "      if sonar_osc then sonar_osc.gen(p) end\n")
insert_before(lib / "plant.lua",
              "    p.initializing = false\n    initializing = false\n  end    \n",
              "    if sonar_osc then sonar_osc.rules(p); sonar_osc.gen(p) end\n")
insert_after(lib / "plant.lua",
             "    envelopes[inactive_plant].set_active(false)\n    set_midi_channels()\n",
             "    if sonar_osc then sonar_osc.plant(active_plant) end\n")

# 5. plant_sounds: note and rest -----------------------------------------------
insert_after(lib / "plant_sounds.lua",
             "            freq = freq * cf_scalar\n            note_to_play = MusicUtil.freq_to_note_num(freq)\n",
             "            if sonar_osc then\n"
             "              local tx = turtle_position and turtle_position.x or -1\n"
             "              local ty = turtle_position and turtle_position.y or -1\n"
             "              sonar_osc.note(parent.id, note_index, note_to_play, freq, tx, ty, node_obj.duration)\n"
             "            end\n")
insert_after(lib / "plant_sounds.lua",
             "        elseif (node_obj.rest and parent.initializing == false) then\n",
             "          if sonar_osc then sonar_osc.rest(parent.id, note_index) end\n")

# 6. rain.lua ------------------------------------------------------------------
rain = root / "rain.lua"
insert_after(rain,
             'local MusicUtil = require "musicutil"\n',
             'local sonar_osc = include("sonar/lib/sonar_osc")\n')
insert_after(rain,
             "local function play(note, midi_channel)\n",
             "  sonar_osc.note(midi_channel, note.index or 0, note.midi_note_number, note.hz, -1, -1, note.length or 0)\n")
insert_before(rain,
              "  engine.bits(params:get(\"bits\"))\n  engine.hiss(params:get(\"hiss\"))\nend\n\nfunction init()\n",
              "  sonar_osc.add_params()\n")
insert_after(rain,
             "function init()\n  setup_params()\n",
             '  sonar_osc.init("rain")\n')
text = rain.read_text(encoding="utf-8")
if "function cleanup()" not in text:
    text += "\nfunction cleanup()\n  sonar_osc.cleanup()\nend\n"
    rain.write_text(text, encoding="utf-8")
    log.append("rain.lua: cleanup() added")

(root / "tools" / "apply_hooks.log").write_text("\n".join(log) + "\n", encoding="utf-8")
print("\n".join(log))
print("OK")
