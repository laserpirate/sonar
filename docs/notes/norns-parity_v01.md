# norns parity · v01 · 2026-11-11

Which v03 page controls have a counterpart on the norns over OSC (`?ws=` through `bridge/bridge.mjs`), and which are page only. No Lua changed in this run. "sent" means the page sends it in live mode today; "param exists" means flora has the param, reachable as `/param/<id>`, but the page does not send it.

| page control | norns counterpart | status |
| --- | --- | --- |
| play, stop | `/sonar/play i` | sent |
| next gen | `/sonar/generate i:plant i:dir` | sent |
| reset (Shift+R) | `/sonar/reset` | sent |
| active plant (1, 2, Tab) | `/sonar/plant i` | sent |
| preset (Left, Right) | `/param/plant<n>_instructions` | sent |
| angle | `/param/plant<n>_angle` | sent |
| bpm | `/param/clock_tempo` | sent, whole bpm |
| key root | `/param/root_note` | sent |
| pitch | `/param/root_note_offset` | sent, whole semitones |
| scale | flora `scale_mode` param | param exists, not sent |
| plant length | none | page only |
| reseed | none (the device has no seed; R resets in live) | page only |
| loop layers, clear loops | none | page only |
| arp (both engines), Euclid, flourish | none | page only |
| delay per engine | none | page only |
| growth | none | page only |
| routes, voices (pluck, sine, water, sounds), mixer | none | page only |
| reverb, wind | none | page only |
| roots, bass, drone | none | page only |
| forest (3 to 16 plants), conductor | none (flora has two plants) | page only |
| setups, morph, cues, banks | none | page only |
| macros | none | page only |
| kill | none on the device; the page goes silent | page only |
| blackout, panic | none on the device; panic stops the page's sound | page only |
| MIDI map, MIDI out, clock | the norns has its own MIDI; not linked | page only |
| bus, VANA in | none | page only |
| kodama W S D (`?kodama=1`) | `/param/rqmin`, `/param/rqmax`, `/param/cfs1`, `/param/plant_1_note_duration`, `/param/plant_2_note_duration` | sent |

Live mode turns the page into a view of the device: the garden, arps, forest and voices above are sim features and do not run while `?ws=` is connected.
