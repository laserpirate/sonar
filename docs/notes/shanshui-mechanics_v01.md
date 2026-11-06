# shanshui-mechanics v01

Notes on how shanshui-av generates and plays its scroll, read from the source on 2026-11-06. Facts only. Paths are relative to `10_av/00_shan-shui/shanshui-av/` unless they start with `sonar/`. Line numbers are of the files as read (shanshui-av `main` at `1f009a1`).

Software read:
- {Shan, Shui}* by Lingdong Huang (MIT), `upstream/index.html`, extracted unchanged to `src/engine/upstream-engine.js`
- shanshui-av v0.3.0 (`src/core/constants.js:2`)

## 1 · Seeding

- `?seed=` is read raw from `location.href`, no decoding, capped at 64 characters (`src/app.js:60-65`). With no seed the app uses `String(Date.now())` (`src/app.js:67`), as upstream does (`src/engine/upstream-engine.js:84`).
- Upstream PRNG (`src/engine/upstream-engine.js:7-64`): Blum Blum Shub style, `s = s*s mod m`, `m = 999979 * 999983`. `Prng.hash(x)` is `btoa(JSON.stringify(x))`, summing `charCode * 128^i` (`:12-19`), so the string `"42"` and the number `42` seed differently. `seed()` retries `(hash + z) mod m` until it is not a multiple of `p` or `q` and not 0 or 1, then discards 10 draws (`:20-38`). `Math.random` is replaced by `Prng.next` (`:59-61`): every `Math.random()` in the engine draws from this one sequence.
- Order of draws in shanshui-av matches the original page (`src/workers/gen-worker.js:5-10`): `Math.seed(seed)`, `chunkloader(0, 3000)`, the paper texture (257 x 257 noise plus `Math.random`, `:44-61`), then one chunk at a time in travel order. One worker per seed gives fresh engine globals (`:1-3`).
- There is no chunk hashing in the shanshui world. A chunk can only be made by advancing the single PRNG to it (`src/worlds/shanshui/index.js:5-9`). Travel back past the memory cap (20000 px, `src/core/constants.js:6`) draws new landscape; Stop restarts from x = 0 to reproduce the seed (`src/app.js:156-163`).
- The derelict world does hash chunks: `mulberry32(hash(seed, chunk, layer))`, FNV-1a string seed then an avalanche (`src/worlds/derelict/rng.js:1-35`). Every chunk is a pure function of `(seed, c)` (`src/worlds/derelict/index.js:1-6`).

## 2 · How the scroll is generated as the view moves

- World units are upstream SVG px. Frame height `WORLD_H = 800 / 1.142 = 700.5` (`src/core/constants.js:3`). Chunk width `MEM.cwid = 512` (`src/engine/upstream-engine.js:3831`), also the raster tile width (`src/core/constants.js:4`).
- Each frame `Scene.frame` calls `world.update(x, viewW, dir, scale)` (`src/core/scene.js:69`). `World.update` asks the worker for one more chunk when `xmax < camR + AHEAD` (AHEAD 3500 px, `src/core/constants.js:7`), travel side first, one request in flight (`src/core/world.js:102-116`). The worker runs upstream `chunkloader(MEM.xmin + cwid, MEM.xmax - cwid + 1)` for a right step (`src/workers/gen-worker.js:76-79`).
- `chunkloader` (`src/engine/upstream-engine.js:3855-3896`) calls `mountplanner(xmax, xmax + 512)` for the new strip and turns each plan entry into SVG.
- `mountplanner` (`:3716-3824`), per 512 px strip, stepping `xstep = 5` px:
  - **mount**: at `i` where `ns(i) = max(noise(0.03 i) - 0.55, 0) * 2` is a local maximum above 0.3 (`locmax`, radius 2, `:3717-3730`), for each `j` from 0 to `yr(i) * 480` in steps of 30 (`yr = noise(0.01 i, pi)`), at `x = i + (rand - 0.5) * 1000`, `y = j + 300` (`:3766-3771`). Accepted if no entry of this strip lies within 10 px (`chadd`, `:3732-3742`). Each accepted mount raises `planmtx` over x +-200 (`mwid`, `:3774-3780`). In `chunkloader` each mount adds two entries with tag `mount`: the mountain and its water, the water at `y - 10000` (`:3899-3912`).
  - **distmount**: where `|i| mod 1000 < 4`, `y = 280 - rand * 50` (`:3784-3792`): one per 1000 px of x, with `len` 500, 1000 or 1500 (`:3929-3937`).
  - **flatmount**: where `planmtx` is 0 (no mount within 200 px), with probability 0.01 per 5 px step, 0 to 3 stacked at `y = 700 - 50 j`, x jittered +-700 (`:3795-3809`).
  - **boat**: probability 0.2 per 5 px step, at least 400 px from any entry of the strip, `y = 300 .. 690` (`:3816-3821`).
- What decides spacing: the noise field `noise(0.03 x)` for mounts (bumps about every 33 px of x, thinned by the 10 px rule and by `yr`), a fixed 1000 px grid for distmount, mount-free gaps for flatmount, and the 400 px rule for boats.
- Measured, 60 chunks right from x = 0, mountain entries only (`sonar/tools/shanshui_tags.mjs`, Node, engine unchanged):

| seed | mount / chunk | distmount / chunk | flatmount / chunk | boat / chunk | mount gap min / median / max px | boat gap min / median / max px |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4.10 | 0.43 | 1.31 | 0.19 | 1 / 60 / 2171 | 72 / 1024 / 10742 |
| 42 | 5.25 | 0.38 | 1.22 | 0.22 | 0 / 49 / 1822 | 400 / 1688 / 5090 |
| 1792909998082 | 4.68 | 0.40 | 1.13 | 0.28 | 1 / 50 / 2672 | 27 / 679 / 7280 |

  Mounts arrive in clusters: a median gap of 50 to 60 px with gaps up to about 2000 px between clusters. A score that fires on every mount entering would fire about once a second at the default speed; the score groups them (section 7).

- Derelict world (`src/worlds/derelict/`): tags are layer names, not landform kinds: `far`, `midfar`, `mid`, `ground`, `near` (`index.js:343, 357`). One element per (chunk, layer) when the kit draws something. The planner (`planner.js:186-210`) gives each chunk a density `0..1` (fbm, `:175-178`), `quiet` when density < 0.22, a passage kind in runs of 7 chunks (`terminal, tanks, kampung, hangars, port`, `:156, 179-183`), and slot landmarks (tower once per 23 chunks, airliner 13, parking 17, radar 9, `:160-165`).

## 3 · The derelict weather class

`src/core/weather.js`:
- `PHASES = ['dry', 'drizzle', 'downpour', 'flood', 'night']` (`:9`), `PARAMS = ['rain', 'wind', 'water', 'fog', 'light']` (`:10`), all 0..1.
- `KEYS_W` (`:11-17`): keyframes at p = 0, 0.2, 0.4, 0.6, 0.8:

| phase | p | rain | wind | water | fog | light |
| --- | --- | --- | --- | --- | --- | --- |
| dry | 0.0 | 0.00 | 0.20 | 0.08 | 0.25 | 1.00 |
| drizzle | 0.2 | 0.35 | 0.35 | 0.25 | 0.50 | 0.72 |
| downpour | 0.4 | 1.00 | 0.80 | 0.55 | 0.80 | 0.42 |
| flood | 0.6 | 0.45 | 0.50 | 1.00 | 0.55 | 0.45 |
| night | 0.8 | 0.00 | 0.15 | 0.42 | 0.30 | 0.00 |

- `cycleValues(p)` holds each phase for the first 35 % of its span and smoothsteps across the rest (`:20-32`).
- Period: `cfg.weather.period` 360 s by default (`src/app.js:28`), minimum 10 s (`weather.js:47`).
- Modes: `auto` advances p; `scrub` leaves p to MIDI CC 4 (`weather.js:48`; `src/app.js:525`: `weather.p = v * 0.9999`, CC 4 on channel 1 bound by default, `src/app.js:512`); a phase name eases toward that phase (`weather.js:49-54`).
- Holds: `cfg.weather.holds[param]` pins one value (MIDI or slider, `src/app.js:526`). Shown values ease toward the target at `dt * 3` per frame (`weather.js:56-59`).
- `weather.values()` returns `{rain, wind, water, fog, light, p}` (`:63`). It is stepped every frame unless panic is on (`src/app.js:283`), whichever world is shown; only the derelict world draws it (`src/worlds/registry.js:117`, `weather: true`).

## 4 · Playback

`src/core/playback.js`:
- `x` is the left edge of the view in world px (`:2`).
- `speed` is px/s on a 1080 px tall screen at zoom 1 (`:3`), default 120 (`src/app.js:20`), slider 0 to 2000 on a square law (`src/app.js:430-433`).
- `velocity = dir * speed * PX * k` world px/s, `PX = 700.5 / 1080 = 0.649` (`:6, 24`). Default speed is 77.8 world px/s; the slider top is 1297 world px/s.
- `dir` +1 or -1 (`D` key, `src/app.js:405`).
- Play and pause ease `k` toward 1 or 0 with a time constant `ease / 3 = 0.2 s` (`:45-47`).
- Stop (`Home`, `src/app.js:404`) is `goTo(0)`: a raised-cosine tween over `min(3, 0.8 + |dx| / 4000)` s (`:41, 48-53`), or a reseed of the same seed from 0 when the start was culled (`src/app.js:156-163`).
- Hand input (drag, wheel, arrows) pauses and may auto-resume after `resumeSecs` (`:31-37`).

## 5 · Controller and output split

- The controller (`index.html`, `src/app.js`) owns clock, seed, palette, weather and show logic (`src/app.js:1-2`). Each frame it builds `frameState(now)` (`src/app.js:258-273`): `{worlds: [{key, seed, world, x, alpha}], dir, pal, u, time, weather, v, t}` and posts `{type: 'frame', fs, flags, custom}` on `BroadcastChannel('shanshui-av:' + INSTANCE)` (`src/app.js:229-230, 302`).
- The output window (`output.html`, `src/output.js`) has no UI and writes no storage; it renders the frames it receives (`src/output.js:1, 20, 40`) and sends back `hello`, `beat`, `log`, `bye` and the keys pressed in it (`B`, panic, Space, R, Home and a few more, `src/app.js:232-243`; `src/output.js:54-58`).
- `steer()`: no function of that name exists in `src/`, `index.html` or `output.html` (grep, 2026-11-06). The controller steers the output only through the frame state above.

## 6 · What is observable per frame from `app.js` without touching the renderer

All in `tick(now)` (`src/app.js:278-310`), after `pb.step` and `weather.step`:
- `pb.x`, `pb.velocity`, `pb.dir`, `pb.playing`, `pb.k`
- `weather.values()` and `weather.phase`
- `cur.seed`, `cur.world`, `cur.key`; `outgoing` and `fade` during a reseed crossfade
- `flags.blackout`, `flags.panic`, `flags.hold`
- `scene.peek(cur.key)` returns the `World` (`src/core/scene.js:46`). `World.chunks` is a `Map id -> {id, tag, x, y, canv, minx, maxx}` (`src/core/world.js:18`); `minx, maxx` start at `x +- 1500` and are replaced by the raster worker's measured extents (`:59, 75-79`). `World.elementsIn(x0, x1)` returns the elements overlapping a world range in paint order (`:178-183`). With `lastView.viewW` (`src/app.js:301`) this is "chunks in view" with no new renderer path.
- Element ids are stable while the element lives, so a diff of ids in view between frames gives "entered".
- Reseed: `setSeed()` (`src/app.js:124-139`), `reseed()` (`:140`). Panic: `setPanic(on)` (`:318-323`), entered by holding Esc 1 s (`:393-397`) or the output's panic key. Blackout: `setBlack()` (`:313-317`).

## 7 · Busy share and composition numbers (`DECISIONS.md`)

- Busy share (derelict, `DECISIONS.md:121`): a chunk is busy when its ink coverage in a greyscale strip is 0.045 or more. Over 80 chunks x 5 seeds the first build was 25 to 42 % busy (mean 37 %); after the composition pass 15 to 36 % (mean 28 %).
- Planner (`DECISIONS.md:120`): quiet stretches where density < 0.22; passages in runs of 7 chunks; landmark slots tower 23, airliner 13, parking 17, radar 9.
- Frame path (`DECISIONS.md:51`): no GPU readback per frame; at 1500 px/s, 1920 x 1080, 4 reseeds, frame gaps over 25 ms went from 34 to 0.

## 8 · Signals for the score

| signal | where it lives | rate | range |
| --- | --- | --- | --- |
| seed | `cur.seed`, `src/app.js:100, 124` | on reseed | string, up to 64 chars (digits from `Date.now()` by default) |
| world | `cur.world`, `src/app.js:100` | on world switch | `shanshui`, `derelict` |
| x | `pb.x`, `src/core/playback.js:20` | per frame | world px, from 0, unbounded |
| velocity | `pb.velocity`, `src/core/playback.js:35` | per frame | -1297 .. 1297 world px/s (default 77.8) |
| playing | `pb.playing`, `pb.k` | per frame | bool; k 0..1 |
| view width | `lastView.viewW`, `src/app.js:301`; `viewOf`, `src/core/scene.js:8-13` | per frame, on resize | world px, `W / (H / 700.5 * zoom)` (1245 at 16:9, zoom 1) |
| tags in view | `scene.peek(cur.key).elementsIn(x, x + viewW)`, `src/core/world.js:179` | per frame | counts per tag: shanshui `mount` about 4 to 5 per 512 px, `distmount` 0.4, `flatmount` 1.3, `boat` 0.2; derelict `far, midfar, mid, ground, near` |
| entered | diff of element ids in view | per frame | list of tags |
| weather | `weather.values()`, `src/core/weather.js:63` | per frame, cycle 360 s default | rain, wind, water, fog, light 0..1; p 0..1 |
| weather phase | `weather.phase`, `src/core/weather.js:62` | per frame | `dry, drizzle, downpour, flood, night` |
| blackout | `flags.blackout`, `src/app.js:111, 313` | on key / MIDI | bool |
| panic | `flags.panic`, `src/app.js:111, 318` | on Esc hold / MIDI | bool |
| stop | `stop()`, `src/app.js:156` | on Home | event |
