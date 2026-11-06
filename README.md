# sonar

norns scripts forked from flora and raindrops, with OSC out and in, plus a browser renderer and a browser-only mode.

| script | fork of | engine |
| --- | --- | --- |
| `sonar.lua` | flora (jaseknighter) | `SonarSaw` (flora's BandSaw, renamed) |
| `rain.lua` | raindrops (ambalek) | `SonarRain` (raindrops' Snowflake, renamed) |

Keys, encoders, params and sound are the originals'. The engines are renamed so sonar can sit beside flora and raindrops in `dust/code/` (SuperCollider aborts on two classes with one name). Data lives in `dust/data/sonar/`, so flora presets do not carry over.

## Install (norns)

```
;install https://github.com/laserpirate/sonar
```

Then SYSTEM > RESTART so SuperCollider loads `Engine_SonarSaw` and `Engine_SonarRain`. Open `sonar` or `sonar/rain` from SELECT.

PARAMETERS > sonar osc: `osc out` on/off, `osc ip` (the laptop running the bridge), `osc port` (57120), `resend state`.

## OSC

norns listens on UDP 10111. The bridge listens on UDP 57120 and serves WebSocket 8765.

Out, from norns:

| path | args | when |
| --- | --- | --- |
| `/sonar/hb` | i:seq f:bpm s:script | every 1 s |
| `/sonar/gen` | i:plant i:gen i:maxgen f:angle_deg f:length f:x0 f:y0 f:rot0 s:sentence i:truncated | setup and every generation |
| `/sonar/rules` | i:plant s:axiom i:n (s:pred s:succ) x n | setup and modify |
| `/sonar/note` | i:plant i:idx i:note f:freq f:x f:y f:dur | every F that plays |
| `/sonar/rest` | i:plant i:idx | every G |
| `/sonar/plant` | i:active | active plant switch |
| `/sonar/page` | i:page | flora page change |
| `/sonar/env` | i:plant f:level | envelope level at note on |

`sentence` longer than 8000 bytes is sent as `""` with `truncated` 1; the renderer regenerates from `/sonar/rules` (random `!` angles then differ from the device). x and y are norns screen pixels (flora's screen is 127 x 64). `rain.lua` sends `/sonar/note` (plant = sequence 1 or 2, x y = -1) and `/sonar/hb`.

In, to norns:

| path | args | does |
| --- | --- | --- |
| `/param/<id>` | f:value | norns core; every flora param id works (`plant1_instructions`, `plant1_angle`, `clock_tempo`...) |
| `/sonar/generate` | i:plant i:dir | +1 or -1 generation |
| `/sonar/reset` | | k1+k3: both plants back to their instructions |
| `/sonar/plant` | i:n | set active plant |
| `/sonar/sentence` | i:plant s:sentence | replace the sentence |
| `/sonar/play` | i:0 or 1 | stop or start both plants |
| `/sonar/resend` | | rules, gen, plant and page again |
| `/sonar/ping` | | replies `/sonar/pong` |

## Bridge and fake norns

```
cd bridge
npm install
node bridge.mjs --norns 192.168.1.50 --udp-any     # real norns on the LAN
node bridge.mjs --norns 127.0.0.1                  # with fake-norns
node fake-norns.mjs --plant 2 --bpm 90 --gens 2    # no hardware
```

The WebSocket binds 127.0.0.1 only. UDP binds 127.0.0.1 unless `--udp-any` (needed when a real norns sends to the laptop). Browser messages are JSON `{"path", "args"}`; `/param/*` and `/sonar/*` go on to norns.

fake-norns runs the same L-system core as the page (`docs/js/lsys.js`) with flora's catalog and answers `/sonar/*` and `/param/plant{1,2}_angle` like the device.

## Page

`docs/index.html`, served by GitHub Pages from `/docs`, or locally:

```
node tools/serve.mjs --port 8080
```

| URL | mode |
| --- | --- |
| `index.html` | sim: the page runs flora's sequencer itself |
| `index.html?ws=ws://127.0.0.1:8765` | live: draws what norns (or fake-norns) sends |
| `&mode=norns` | 128 x 64 white on black at an integer scale (default `wall`) |
| `&p1=2&p2=11` | presets for plant 1 and 2 (`p01..p13`, flora's catalog order) |
| `&bpm=90` `&seed=3` | sim tempo and random seed |
| `&engine=saw` / `rain` / `both` | browser engine after Enable |
| `&liveaudio=1` | browser audio also in live mode (off: the norns makes the sound) |
| `&shanshui=1` `&kodama=1` | landscape hooks, below |

Keys: Space play, N next gen, R reset, 1 and 2 plant, Left and Right preset, M norns / wall, B blackout, Esc held 1 s panic (last good frame, audio muted; hold again to leave), H hide controls, F full screen, E engine, ? key list.

Enable (click) starts audio and Web MIDI. Nothing asks for a device before that.

MIDI default map (AV-STANDARD v02): note 36 play/pause, 37 next gen, 38 reset, 41 blackout, 42 panic; CC 1 BPM 40..160, CC 4 angle 0..120, CC 7 master. CCs use soft takeover. While blacked out only notes 41 and 42 act.

## Browser engines

`docs/js/engine-saw.js` and `docs/js/engine-rain.js` are Web Audio ports of the two SuperCollider engines. The saw voice is flora's: two saws at a slow tempo-derived rate (bpm / 90 Hz) into a narrow band-pass at the note's frequency (rq 0.001..0.005), Env.xyc from flora's envelope arrays. The browser adds makeup gain into a limiter; on the norns that is the output level.

## Demos

`docs/demos/*.mp3`: software render, not the norns. Rendered by `tools/render_demo.py` (numpy ports of both engines; sonar note events from the same `lsys.js` core). 48 kHz, 192 kbps.

| file | what |
| --- | --- |
| `sonar_p01_90s_software-render_v01.mp3` | both plants on p01, 90 bpm, one generation every 32 beats |
| `sonar_p02_90s_software-render_v01.mp3` | p02 |
| `sonar_p04_90s_software-render_v01.mp3` | p04 |
| `rain_software-render_v01.mp3` | raindrops sequencer, one stereo delay standing in for softcut |

## Landscape hooks (off by default)

`?shanshui=1`: the page accepts `/av/weather f` (fog alpha) and `/av/flood f` (water level line) on the same WebSocket, 0..1. The bridge also sends every `/sonar/note` as `/av/midi` JSON `{type:"note", note, velocity, channel}` for shanshui-av's `av-in`.

`?kodama=1`: keys W, S, D pick the Wet, Shed, Dry phase presets (rqmin, rqmax, cf scalar, note duration), applied to the browser engine in sim and sent as `/param/*` to norns in live.

## Tests and tools

| tool | does |
| --- | --- |
| `tools/check_lua.py . ../_norns/lua --beats 64` | compiles every .lua, runs both scripts' `init()` and 64 beats under a headless norns mock (needs `pip install lupa` and a checkout of monome/norns) |
| `tools/identity_lsys.py . ../_norns/lua` | `lsys.js` against flora's own Lua: sentence, segments, end points, notes per index (p01 p02 p04 gen 2) |
| `tests/` (`npm install`, `npx playwright test`) | sim draws, fake-norns through the bridge (same segment count), keys to fake-norns, blackout black, offline engine levels, fake MIDI flood |
| `tools/render_demo.py` | the demos |
| `tools/privacy_grep.py` | gate before every commit |
| `tools/fork_upstream.py`, `tools/apply_hooks.py` | regenerate the fork from `upstream/`, every replace counted |

Not verified on real hardware: the norns, SuperCollider class loading, `;install`, a MIDI controller, a projector.

## Credits

- flora by jaseknighter (MIT, `upstream/flora/LICENSE`), with its own credits: Brian Crabtree, Dan Derks, Daniel Shiffman, Eli Fieldsteel, Mark Wheeler, Tom Armitage, Tyler Etters.
- raindrops by ambalek (`upstream/raindrops/`; no license file in the upstream repository).
- Software: norns, SuperCollider, Lua, Node, Canvas 2D, Web Audio, Web MIDI, Python with numpy and scipy, ffmpeg, Playwright, Claude Code.
