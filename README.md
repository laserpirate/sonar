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
| `&bpm=90` `&seed=3` | sim tempo and seed. The seed picks the two presets and the random angles; the page writes the seed into the URL on every reseed, so a URL is a garden |
| `&pitch=7` `&growth=2` `&key=48,major pentatonic` `&arp=up&arprate=1/16&arpoct=2` `&delay=0.3` | the controls row, preset from the URL |
| `&engine=saw` / `rain` / `both` | browser engine after Enable |
| `&liveaudio=1` | browser audio also in live mode (off: the norns makes the sound) |
| `&shanshui=1` `&kodama=1` | landscape hooks, below |

Keys: Space play, N next gen, R reseed (live: reset), Shift+R reset, L add a loop, C clear loops, A arp mode, Up and Down bpm, 1 and 2 plant, Tab next plant, Left and Right preset, M norns / wall, B blackout, Esc held 1 s panic (last good frame, audio muted; hold again to leave), H hide controls, F full screen, E engine, [ and ] factory setups, G and Shift+G cue go and back, ? key list. A printable card: `docs/card/`.

### Garden controls (sim)

`docs/js/garden.js` is the sim garden as one steppable object: the two base plants, the loop layers, the arpeggiator, key, pitch and growth. The page and the offline renders drive the same code.

| control | what it does |
| --- | --- |
| reseed (R) | new seed: new presets for both plants (`seed % 13`), new random angles. Same seed, same garden. |
| + loop (L) | a seeded loop layer: its own plant, recorded for one 4 bar loop from the next bar line, then repeated. Up to 4; the fifth replaces the oldest. Layers draw dimmer behind the base plants. |
| clear (C) | removes every loop layer |
| bpm | 20..300, beat phase kept; also sent to the norns in live mode (`/param/clock_tempo`) |
| pitch | transpose -24..+24 semitones, everything the garden plays |
| key | root (A1..C4) and scale (major, minor, dorian, phrygian, lydian, mixolydian, harmonic minor, major and minor pentatonic, whole tone): `musicutil.generate_scale_of_length` as flora builds its 24 note scale |
| arp | mode off / up / down / updown / random, rate 1/4 1/8 1/8t 1/16, 1..3 octaves. The arpeggiator holds the last four distinct scale degrees the plants played and walks them on the beat grid with short saw notes. |
| delay | a tempo-synced feedback delay on a send (dotted eighth, feedback 0.45, 2.4 kHz low-pass in the loop), 0..1 |
| growth | 0 (off) or 1..8 bars per step: the active plant steps up a generation every N bars to its maximum, then back down |

Enable (click) starts audio and Web MIDI. Nothing asks for a device before that. After Enable the strip shows the output level (`out -14 dB`) and, when the chain is running but nothing reaches the output for 2 s, a line saying to check the device mute switch, volume and output device.

MIDI: see MIDI mapping below; with nothing stored the v0.2.0 map is the default.

### Layout and gestures

Wide screens: the stage on the left, the rail (strip, tabs, panels, transport) on the right, 340 px. Phone portrait: the stage on top at 55 percent or more, the rail below; panels scroll inside the rail, so stage and rail never overlap. Short landscape keeps a narrower side rail. Add to Home Screen opens it standalone, without browser bars (`manifest.webmanifest`).

Gestures on the stage, each with a button in the plants tab: tap a plant to select it (an empty tap brings hidden controls back); drag a plant sideways for its angle, up and down for its length; two-finger tap for the next generation; long press for the plant palette.

### Setups and banks

A setup is the whole garden as JSON (`Garden.toSetup`, version 1): seed and RNG state, bpm, key, every plant (preset or user plant, exact sentence, random angles, roots, pitch mode, wildness, density, voice), loops, arps, delays, forest, bass, voices, mixer, reverb and wind, sound references, bank name, randomize seed and the MIDI map. Loading one replays it exactly (same notes at the same beats). The setups tab: twelve factory setups (`docs/js/setups.json`, `[` and `]` step them), morph 0 to 8 bars, saved slots in this browser, export (`sonar_setup_<name>_v01.json`, `sonar_setups_all_v01.json`, user plants included), import or drop, and a share link (`#s=` plus deflated JSON, at most 64 KB). A setup that fails a check is refused and nothing changes.

A bank is the voices with their settings and the sounds they use. `.sonarbank` is a zip (stored, written by `docs/js/samples.js`): `bank.json` plus the audio files. Export `sonar_bank_<name>_v01.sonarbank`; import or drop it on any browser. Sounds are kept in this browser (IndexedDB) and never uploaded. A setup naming a sound the browser lacks says `missing: <names>; built-in voices play`.

### Voices and space

Each plant routes to a voice: `saw`, `rain` (the two engines, within 0.5 dB of v0.2.0, `tests/logs/levels_v020.json`), `pluck` (Karplus-Strong), `sine` (two-operator FM bell), `water` (band-passed noise bursts at the note) or a sound added from a file (`smp n`: root note, start, length, attack, release, loop, reverse, tune; pitch by playback rate). Every voice has level, octave, detune, tremolo and its own delay; solo and mute per voice. `reverb` is a shared send through a generated impulse (amount, size); `wind` is low-passed pink noise (level, tone). Per plant: pitch mode `flora` or `walk`, wildness (seeded jitter on the drawn turns, 0 to 60 percent) and density (chance a note sounds). `randomize` sets every marked control inside its range from one seed, which rides in the setup; `kill` latches silence while the garden keeps drawing.

### Forest, roots and conductor

The forest tab grows 2 to 16 plants on one ground line; plants 1 and 2 play exactly as in v0.2.0, plants 3 to 16 draw from their own seeded streams. With three or more plants a conductor keeps the voices sounding at once under a budget (1 to 16), rotates 1 to 4 lead plants per bar and places the rest as a chorus on an eighth-note grid. Roots (taproot, plate, fibrous, rhizome, ericaceous; depth, spread, density) draw below the ground; their tips are the bass, walking root, fifth, root, third of the scale on every 4th, 6th or 8th canopy note (or free), with a quiet drone on the root. A user plant comes from the editor (flora's alphabet `FGf+-[]!|r` and `ABMOPTXYp`, axiom up to 40, five rules up to 80) and lives in the palette.

### MIDI mapping

The midi tab lists every control and every page act with its binding. Learn arms one; the next CC or note binds it (a CC on a slider binds as absolute with soft takeover; a note on a toggle as toggle; panic always as hold 1000 ms). Bindings are `{act, type, ch, num, mode, hold_ms, smooth, curve}`; modes cc `abs` `rel` `trig` `hold`, note `trig` `toggle` `momentary` `hold`. A message bound to two acts is shown as a conflict. Clear one, clear all (asks twice), export `av-bindings_sonar_v01.json`, import. Maps ship in `docs/data/midi-maps/`: `sonar_v020-notes_v01.json` (the default: notes 36 play, 37 next gen, 38 reseed, 41 blackout, 42 panic; CC 1 bpm 40 to 160, CC 4 angle 0 to 120, CC 7 volume) and `sonar_nanokontrol_v01.json` (original nanoKONTROL, scene 1 factory CCs, not checked on the device: verify with the wizard; strip 1 fader morph, knob flourish, upper button next setup, lower button blackout; strip 6 fader volume; play, stop, rewind and fast forward step setups, loop adds a loop, REC held 1 s is panic). Bindings are stored per browser (per `?i=`) and ride in setups. While blacked out only blackout and panic act; both skip every queue. MIDI out (off by default): notes to a chosen output, saw 1, rain 2, pluck 3, sine 4, water 5, bass 6, sounds 7; clock out at 24 ppqn; clock in sets bpm. Without Web MIDI (iPhone Safari) the tab says so and the rest works.

### Macros, record, cues

Four macros in the more tab, each 0 until moved: `weather` (reverb, wind, wind tone, delay feedback), `depth` (roots depth, bass level, drone), `motion` (bpm 60 to 140, flourish, arp gate), `density` (forest density, plant density). They go on the bus and map to MIDI like any slider. `rec` writes the output as `sonar_take_<date-time>_v01.webm` with the setup beside it as `.json`; `rec video` writes the stage and the output. Cues (setups tab) pin setups to bars with their morph; `run` plays the list from the next bar, `go` and `back` (G, Shift+G, or a MIDI button) step it; `sonar_cues_v01.json` exports it.

| URL | does |
| --- | --- |
| `#s=<link>` | load a shared setup |
| `&bus=1` | bus on at load |
| `&vana=1` | VANA in on at load |
| `&i=<name>` | a separate MIDI map for this instance |

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
| `score_shanshui_seed1792909998082_software-render_v01.mp3` | the score on the sim scroll, seed 1792909998082 (p09). WebAudio ports in an OfflineAudioContext (`tools/render_score.mjs`) |
| `score_kodama_kc-01_software-render_v01.mp3` | the score on the sim kodama cycle (36 s), seed `kc-01` (p06) |
| `garden_seed42_base_software-render_v01.mp3` | the garden at seed 42 (p04, p10), 90 bpm. `tools/render_garden.mjs` through `docs/js/garden-offline.js` |
| `garden_seed42_loops4_delay030_software-render_v01.mp3` | seed 42 with four seeded 4 bar loops added at bars 2, 6, 10, 14, delay 0.30 |
| `garden_seed42_arp-up-16_2oct_delay045_bpm100_software-render_v01.mp3` | arp up at 1/16 over 2 octaves, one loop at bar 4, delay 0.45, 100 bpm |
| `garden_seed42_growth2_c3-major-pentatonic_arp-updown-8_software-render_v01.mp3` | growth every 2 bars, C3 major pentatonic, arp updown 1/8, one loop at bar 8, 84 bpm |

`tools/render_garden_demos.sh` renders the four garden demos. v03 demos (`node tools/render_v03_demos.mjs`, 90 s each, `docs/demos/index.html` lists them): two engines with their own arps and delays, a 16-plant forest at budget 6, pluck, sine, water, a cue list of three factory setups, taproot roots with the bass, flourish, reverb and wind. No sampler demo: no sound ships in the repo.

## Score

`docs/js/score.js`: an ambient score for shanshui scrolls and kodama scenes, deterministic from the seed. ES module, no DOM, no globals. Every number is in `docs/js/map.js`.

```js
import { Score, createEngines } from "./score.js";
const score = new Score({ engines: createEngines(audioContext), osc });   // both optional
score.seed(1792909998082);
score.scene({ kind: "shanshui", x, velocity, tags, entered, weather });  // or kind "kodama", phase, pu, cycle
score.play(); score.stop(); score.panic();
score.state();   // {seed, plant, gen, genMax, bpm, root, voices, ...}
```

| in | out |
| --- | --- |
| seed | plant `seed mod 13` (p01..p13), root A1..A3, RNG streams for the L-system angles, the drone drift, rain notes, the sequencer |
| velocity | bpm 36..96 (400 world px/s = 96), smoothed 2 s; under 2 px/s the sequencer rests, the drone holds |
| entered `mount`, `distmount` | one generation step, at most every 8 s, up to the preset max then back down |
| entered `flatmount` | one bar of rest |
| entered `boat` | one rain note |
| weather rain, wind, water, fog, light | rain density, wow and flutter, root down to 7 semitones, drone band wider, drone low shelf |
| kodama phase 1, 2, 3 | generations up, down with notes x2, sequencer off (drone and fog); `cycle` reseeds the angles only |

Levels, offline (`tests/score.spec.mjs`, 90 s, seed 1792909998082): drone -24.0 dBFS rms, notes peak -8.6 dBFS, mix peak -6.9 dBFS. Panic: silent (under -80 dBFS) 50 ms after the call.

### score to norns

Give `Score` an `osc` client (the page's `OscWs` to the bridge, or anything with `send(path, args)`) and the norns follows: it plays plant 1 on the score's preset, scale, tempo and sentence (so the same random angles). Sent, all through the bridge to UDP 10111:

| when | path | args |
| --- | --- | --- |
| seed | `/param/plant1_instructions`, `/param/plant1_angle` | plant number, preset angle |
| seed, water | `/param/root_note` then `/param/scale_mode` | root (MIDI), 5 (dorian; its action rebuilds the scale) |
| seed | `/param/note_scalar`, `/param/num_active_cf_scalars`, `/param/cfs1` | 3, 1, 2 (x1) |
| seed, kodama phase | `/param/plant_1_note_duration` | 5 (1 beat), 7 in Shed (2 beats) |
| generation | `/sonar/generate` then `/sonar/sentence` | 1, +-1; 1, the score's sentence |
| kodama cycle | `/sonar/sentence` | 1, the reseeded sentence |
| tempo | `/param/clock_tempo` | whole bpm, at most every 0.5 s |
| play, stop, panic, scroll stops or starts | `/sonar/play` | 1 or 0 |

Check: `node tools/score_norns_check.mjs 60 shanshui` runs the score in real time against `bridge.mjs` and `fake-norns.mjs` and compares the score's walk (notes played, plus those muted by a rest bar or skipped by the voice cap) with fake-norns' plant 1 `/sonar/note` count. 6 Nov 2026: shanshui 35 vs 34, kodama 21 vs 21 (pass is +-1). The device does not know about rest bars, the voice cap, rain notes or the drone: it plays the whole walk, and plant 2 keeps playing flora's own walk. fake-norns now honours `plant{1,2}_instructions`, `root_note` + `scale_mode` (dorian), `note_scalar`, `plant_{1,2}_note_duration`, `cfs1`, and keeps the beat phase on a tempo change. Nothing here ran on a norns.

`?score=1&seed=<n>` on the page runs the score on a scripted scroll (`docs/js/score-sim.js`); add `&kind=kodama` for the 36 s Wet / Shed / Dry cycle. Enable for sound. Space play / stop, R reseed, Esc hold panic, B blackout. Notes on the shanshui engine: `docs/notes/shanshui-mechanics_v01.md`.

## Landscape hooks (off by default)

`?shanshui=1`: the page accepts `/av/weather f` (fog alpha) and `/av/flood f` (water level line) on the same WebSocket, 0..1. The bridge also sends every `/sonar/note` as `/av/midi` JSON `{type:"note", note, velocity, channel}` for shanshui-av's `av-in`.

`?kodama=1`: keys W, S, D pick the Wet, Shed, Dry phase presets (rqmin, rqmax, cf scalar, note duration), applied to the browser engine in sim and sent as `/param/*` to norns in live.

## The sonar bus

Off until the `bus` button (more tab) or `?bus=1`. sonar posts on the `BroadcastChannel` named `sonar-bus`, which reaches every tab of the same origin on the machine (all of `laserpirate.github.io`), no server. With `?ws=` the same messages go to the bridge as `{path: "/sonarbus/<t>", args}`; `node bridge/bridge.mjs --bus-udp 127.0.0.1:7000` also sends them out as OSC (TouchDesigner, a second machine). Absolute state, last write wins:

| t | fields | when |
| --- | --- | --- |
| `note` | voice, plant, note, freq, vel, lead | every note that sounds |
| `beat` | beat, bar, bpm | every beat while playing |
| `gen` | plant, gen, max | a plant grows |
| `level` | rms, peak, bands [low, mid, high], 0..1 | about 30 a second, after Enable |
| `state` | key, density, forest, setup | on change |
| `macro` | name, value | when a macro moves |

`docs/js/sonar-in.js` is the receiver. It has no imports and no flora-derived code; copy it into any page.

```html
<script type="module">
  import { createSonarIn } from "https://laserpirate.github.io/sonar/js/sonar-in.js";
  const sonar = createSonarIn({ stale: 2000 });   // or { ws: "ws://127.0.0.1:8765" } through the bridge
  const ring = document.querySelector("#ring");
  sonar.on("note", (m) => {
    if (!m.lead) return;                             // lead notes only, not arps or chorus
    ring.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(3)", opacity: 0 }], 900);
  });
  sonar.on("beat", (m) => { document.title = `bar ${m.bar} · ${m.bpm} bpm`; });
  sonar.on("rest", () => { document.title = "sonar stopped"; });
  function frame() {
    // smoothed 0..1: level, low, mid, high; pulse is 1 on each beat and decays
    ring.style.borderWidth = 1 + 12 * sonar.level + "px";
    ring.style.opacity = 0.3 + 0.7 * sonar.pulse;
    requestAnimationFrame(frame);
  }
  frame();
</script>
<div id="ring" style="width:80px;height:80px;border:1px solid #9FC8F0"></div>
```

When nothing arrives for `stale` ms, every value returns to rest and `rest` fires once.

**VANA in** (`vana in` button or `?vana=1`, off by default): `/phylla/<slot>/root/archetype`, `/root/depth`, `/root/spread`, `/root/density`, `/root/rhizome_reach` and `/phylla/<slot>/root`, slots 1 to 4, on the bridge or the bus (`{path, args}` on `sonar-bus`), set the roots of plants 1 to 4 and the bass level. The archetype table is at the top of `docs/js/vana.js`; `prop` has no counterpart and leaves the roots alone. A Phylla JSON export dropped or imported on the setups tab becomes a user plant only when its `word` uses flora's alphabet and has at most 40 modules; otherwise the page says which symbols or limit failed.

## Tests and tools

| tool | does |
| --- | --- |
| `tools/check_lua.py . ../_norns/lua --beats 64` | compiles every .lua, runs both scripts' `init()` and 64 beats under a headless norns mock (needs `pip install lupa` and a checkout of monome/norns) |
| `tools/identity_lsys.py . ../_norns/lua` | `lsys.js` against flora's own Lua: sentence, segments, end points, notes per index (p01 p02 p04 gen 2) |
| `tests/` (`npm install`, `npx playwright test`) | sim draws, fake-norns through the bridge (same segment count), keys to fake-norns, blackout black, offline engine levels, fake MIDI flood |
| `tools/render_demo.py` | the engine demos |
| `tools/render_score.mjs <kind> <seed> <s> <out>` | the score demos |
| `tools/score_check.mjs` | score determinism in Node, no audio |
| `tools/score_norns_check.mjs [s] [kind]` | score to fake-norns over the bridge, note counts |
| `tools/vendor_score.mjs <dir>`, `tools/bundle_score.mjs <out>` | copies of the score for shanshui-av and the kc pages |
| `tools/kc_check.mjs <kc dir> <http base>` | kc v03 pages: selftest, flag off equal to v02, score on from file:// and http |
| `tools/catalog_js.mjs [--check]` | `catalog.js` from `catalog.json` |
| `tools/shanshui_tags.mjs <upstream-engine.js>` | planner tags per chunk from the upstream engine |
| `tools/privacy_grep.py` | gate before every commit |
| `tools/garden_check.mjs` | the garden in Node: arps, Euclid, flourish, setups round trip, forest, roots, plant options |
| `tools/midimap_check.mjs` | MIDI binding modes, takeover, curves, smoothing, conflicts, bad input |
| `tools/compare_v020.mjs` | saw and rain against the v0.2.0 tag, offline in installed Chrome |
| `tools/render_v03_demos.mjs` | the v03 demos |
| `tools/fork_upstream.py`, `tools/apply_hooks.py` | regenerate the fork from `upstream/`, every replace counted |

Not verified on real hardware: the norns, SuperCollider class loading, `;install`, a MIDI controller, a projector.

## License

sonar is distributed under GPL-3.0 (`LICENSE`) because it derives from flora; raindrops is MIT per its readme. `docs/js/bus.js` and `docs/js/sonar-in.js` hold no flora-derived code and stand alone.

## Credits

- flora by jaseknighter (GPL-3.0, `upstream/flora/LICENSE`), with its own credits: Brian Crabtree, Dan Derks, Daniel Shiffman, Eli Fieldsteel, Mark Wheeler, Tom Armitage, Tyler Etters.
- raindrops by ambalek (MIT, declared in `upstream/raindrops/readme.md`; the repository has no separate LICENSE file).
- Software: norns, SuperCollider, Lua, Node, Canvas 2D, Web Audio, Web MIDI, Python with numpy and scipy, ffmpeg, Playwright, Claude Code.
