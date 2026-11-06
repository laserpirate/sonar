#!/usr/bin/env python3
"""Software renders of sonar's two engines to MP3 (not the norns).

  python tools/render_demo.py [--out docs/demos] [--only p01,p02,p04,rain] [--seconds 90]

sonar (flora fork, engine SonarSaw): note events come from the shared core
(docs/js/lsys.js via tools/demo_events.mjs), so the render plays the same
L-system walk as the browser and fake-norns. Voice, per SynthDef SonarSaw:
two saws (L, R) at the tempo-derived rate bpm/90 Hz, each detuned by a
linear random walk of +-0.2 semitone at 0.5 Hz; RBJ band-pass centred on the
note's Hz, wandering between cf and cf x 1.008..1.025 at 0.1..0.3 Hz; rq
between rqmin x 1.01..1.15 and rqmax (flora sends 0.001 and 0.005); wow as
wobble_amp x sin^39 on the centre; Env.xyc from flora's default arrays
(levels 0 2 0, times 0 0 1.5, curves 0 -10 -10) x amp 2. Low shelf at 0 dB
and the pitch shifter at 0 are no-ops at flora's defaults and are skipped.

rain (raindrops fork, engine SonarRain): raindrops' own sequencer (two
7-note sequences, lengths 2..8 ticks, chance, pan, gain, release = length)
over Pulse(pw 0.5) -> 24 dB low-pass at 500 Hz with resonance from gain ->
Env.perc(0.01, release, amp 0.3). softcut's delays are approximated by one
stereo feedback delay (1 s, feedback 0.5).

Output: 48 kHz, peak-normalised to -1 dBFS, MP3 192 kbps via ffmpeg, with
metadata title "... software render, not the norns" and no other tags.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

SR = 48000
ROOT = Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=str(ROOT / "docs" / "demos"))
ap.add_argument("--only", default="p01,p02,p04,rain")
ap.add_argument("--seconds", type=float, default=90)
ap.add_argument("--bpm", type=float, default=90)
ap.add_argument("--seed", type=int, default=11)
args = ap.parse_args()
out_dir = Path(args.out)
out_dir.mkdir(parents=True, exist_ok=True)


def curve_value(a, b, c, x):
    if abs(c) < 1e-4:
        return a + (b - a) * x
    return a + (b - a) * (1 - np.exp(c * x)) / (1 - math.exp(c))


def env_xyc(times, levels, curves):
    pts = sorted(zip(times, levels, curves))
    dur = max(0.01, pts[-1][0])
    t = np.arange(int(dur * SR)) / SR
    e = np.full(t.shape, pts[-1][1], dtype=np.float64)
    for (t0, l0, c0), (t1, l1, _) in zip(pts, pts[1:]):
        if t1 - t0 < 1e-6:
            continue
        m = (t >= t0) & (t <= t1)
        e[m] = curve_value(l0, l1, c0, (t[m] - t0) / (t1 - t0))
    return e


def lfnoise1(n, rate, lo, hi, rng):
    """SuperCollider LFNoise1: straight lines between random values at `rate` Hz."""
    step = max(1, int(SR / max(rate, 1e-3)))
    k = n // step + 2
    pts = rng.uniform(lo, hi, k)
    return np.interp(np.arange(n), np.arange(k) * step, pts)


def bpf_varying(x, cf, q, block=128):
    """RBJ constant-0-dB-peak band-pass with per-block coefficients."""
    y = np.empty_like(x)
    zi = np.zeros(2)
    for s in range(0, len(x), block):
        e = min(len(x), s + block)
        f = float(cf[s]); qq = float(q[s])
        w0 = 2 * math.pi * min(f, SR * 0.45) / SR
        alpha = math.sin(w0) / (2 * qq)
        b = np.array([alpha, 0.0, -alpha]) / (1 + alpha)
        a = np.array([1.0, -2 * math.cos(w0) / (1 + alpha), (1 - alpha) / (1 + alpha)])
        y[s:e], zi = lfilter(b, a, x[s:e], zi=zi)
    return y


SAW = dict(amp=2.0, rqmin=0.001, rqmax=0.005, cfhzmin=0.1, cfhzmax=0.3, wobble_rpm=33, wobble_amp=0.01,
           wobble_exp=39, env_levels=[0, 2, 0], env_times=[0, 0, 1.5], env_curves=[0, -10, -10])


def saw_voice(cf, rate, rng, p=SAW):
    env = env_xyc(p["env_times"], p["env_levels"], p["env_curves"]) * p["amp"]
    n = len(env)
    t = np.arange(n) / SR
    cfmax = cf * rng.uniform(1.008, 1.025)
    rqlo = p["rqmin"] * math.exp(rng.uniform(math.log(1.01), math.log(1.15)))
    rqhi = max(p["rqmax"], rqlo * 1.0001)
    out = np.zeros((n, 2))
    wob_phase = rng.uniform(0, 2 * math.pi)
    s = np.sin(2 * math.pi * (p["wobble_rpm"] / 60) * t + wob_phase) ** p["wobble_exp"]
    wow = 1 + p["wobble_amp"] * np.where(s > 0, s, 0)
    for ch in range(2):
        ratio = 2 ** (lfnoise1(n, 0.5, -0.2, 0.2, rng) / 12)
        phase = np.cumsum(rate * ratio / SR) + rng.uniform()
        saw = 2 * (phase % 1.0) - 1
        # LFNoise1.kr(LFNoise1.kr(4).exprange(cfhzmin, cfhzmax)).exprange(cfmin, cfmax): one drawn rate per channel
        rate_cf = math.exp(rng.uniform(math.log(p["cfhzmin"]), math.log(p["cfhzmax"])))
        u = lfnoise1(n, rate_cf, 0, 1, rng)
        cfs = np.exp(np.log(cf) + u * (np.log(cfmax) - np.log(cf))) * wow
        rq = np.exp(lfnoise1(n, 0.1, math.log(rqlo), math.log(rqhi), rng))
        out[:, ch] = bpf_varying(saw, cfs, 1 / rq)
    return out * env[:, None]


def render_sonar(plant):
    ev = json.loads(subprocess.run(["node", str(ROOT / "tools" / "demo_events.mjs"), str(plant), str(args.seconds),
                                    str(args.bpm), str(args.seed), "32"], capture_output=True, text=True,
                                   encoding="utf-8", check=True).stdout)
    rng = np.random.default_rng(args.seed + plant)
    total = int((args.seconds + 2) * SR)
    mix = np.zeros((total, 2))
    live = []  # [start, array]; 10-voice cap, oldest stolen with a 10 ms fade (as the engine does)
    fade = int(0.01 * SR)
    stolen = 0

    def commit(start, arr):
        end = min(total, start + len(arr))
        if end > start:
            mix[start:end] += arr[: end - start]

    for e in ev["events"]:
        start = int(e["t"] * SR)
        if start >= total:
            break
        for x in [x for x in live if x[0] + len(x[1]) <= start]:
            commit(*x); live.remove(x)
        if len(live) >= 10:
            old = min(live, key=lambda x: x[0])
            cut = start - old[0]
            arr = old[1][: cut + fade].copy()
            arr[cut: cut + fade] *= np.linspace(1, 0, len(arr[cut: cut + fade]))[:, None]
            commit(old[0], arr); live.remove(old); stolen += 1
        live.append([start, saw_voice(e["freq"], ev["sawRate"], rng)])
    for x in live:
        commit(*x)
    ev["stolen"] = stolen
    return mix, ev


SCALES = {
    "Minor Pentatonic": [0, 3, 5, 7, 10],
    "Major Pentatonic": [0, 2, 4, 7, 9],
    "Mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "Phrygian": [0, 1, 3, 5, 7, 8, 10],
}


def gen_scale(root, name, octaves):
    iv = SCALES[name]
    notes = [root + 12 * o + i for o in range(octaves) for i in iv]
    return notes + [root + 12 * octaves]


def rain_voice(freq, release, gain, pan, rng, pw=0.5, cutoff=500.0, amp=0.3):
    n = int((0.01 + release * 1.1) * SR)
    t = np.arange(n) / SR
    phase = (freq * t + rng.uniform()) % 1.0
    pulse = np.where(phase < pw, 1.0, -1.0)
    q = 0.6 + min(4, max(0, gain)) * 2.2
    w0 = 2 * math.pi * cutoff / SR
    alpha = math.sin(w0) / (2 * q * 0.5)
    b = np.array([(1 - math.cos(w0)) / 2, 1 - math.cos(w0), (1 - math.cos(w0)) / 2]) / (1 + alpha)
    a = np.array([1, -2 * math.cos(w0) / (1 + alpha), (1 - alpha) / (1 + alpha)])
    y = lfilter(b, a, lfilter(b, a, pulse))
    att = int(0.01 * SR)
    env = np.empty(n)
    env[:att] = np.linspace(0, amp, att)
    x = (t[att:] - 0.01) / release
    env[att:] = np.where(x < 1, amp * (1 - (1 - np.exp(-4 * x)) / (1 - math.exp(-4))), 0)
    y = y * env
    return np.stack([y * math.cos(pan * math.pi / 2), y * math.sin(pan * math.pi / 2)], axis=1)


def render_rain():
    rng = np.random.default_rng(args.seed + 100)
    bpm = args.bpm
    beat = 60 / bpm
    names = list(SCALES)
    name = names[rng.integers(0, len(names))]
    start_note = int(rng.integers(44, 69))
    scales = [gen_scale(start_note, name, 3), gen_scale(start_note - 12, name, 2)]

    def rnote(scale, use_chance):
        m = scale[rng.integers(0, len(scale) - 4)]
        return dict(midi=m, hz=13.75 * 2 ** ((m - 9) / 12), length=int(rng.integers(2, 9)), pan=rng.uniform(),
                    gain=min(1, 0.3 + rng.uniform()), chance=rng.uniform() if use_chance else 1)

    seqs = [[rnote(scales[0], c) for c in (0, 1, 0, 0, 0, 1, 0)], [rnote(scales[1], c) for c in (0, 0, 1, 0, 0, 1, 0)]]
    total = int((args.seconds + 2) * SR)
    mix = np.zeros((total, 2))
    events = []
    # tick(1, 1, 1) and tick(2, 4, random 2..5)
    for d, (i0, s) in enumerate([(0, 1), (3, int(rng.integers(2, 6)))]):
        notes = seqs[d]
        for nt in notes:
            nt["ticks"] = nt["length"]
        i = i0
        t = 0.0
        while t < args.seconds:
            t += s * beat
            nt = notes[i]
            nt["ticks"] -= 1
            if nt["ticks"] == 0:
                if rng.uniform() < nt["chance"]:
                    v = rain_voice(nt["hz"], nt["length"], nt["gain"], nt["pan"], rng)
                    a = int(t * SR)
                    e = min(total, a + len(v))
                    if a < total:
                        mix[a:e] += v[: e - a]
                        events.append(dict(t=round(t, 3), seq=d + 1, midi=nt["midi"]))
                nt["ticks"] = nt["length"]
                i = (i + 1) % len(notes)
    # softcut stand-in: one stereo feedback delay, 1 s, feedback 0.5, mixed at 0.5
    dly = int(1.0 * SR)
    wet = mix.copy()
    for rep in range(1, 8):
        sh = dly * rep
        if sh >= total:
            break
        wet[sh:] += mix[:-sh] * (0.5 ** rep)
    mix = mix + 0.5 * (wet - mix)
    return mix, dict(scale=name, root=start_note, events=events)


def finish(mix, name, title):
    peak = np.max(np.abs(mix)) or 1.0
    mix = mix / peak * (10 ** (-1 / 20))
    fade = int(1.5 * SR)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    pcm = (np.clip(mix, -1, 1) * 32767).astype("<i2")
    mp3 = out_dir / name
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0",
           "-map_metadata", "-1", "-metadata", f"title={title}", "-codec:a", "libmp3lame", "-b:a", "192k", str(mp3)]
    subprocess.run(cmd, input=pcm.tobytes(), check=True)
    rms = 20 * math.log10(float(np.sqrt(np.mean(mix ** 2))) + 1e-12)
    print(f"{mp3.name}: {mp3.stat().st_size // 1024} KB, {len(mix) / SR:.1f} s, raw peak {20 * math.log10(peak):.1f} dBFS, rms {rms:.1f} dBFS")
    return mp3


report = {}
for item in args.only.split(","):
    if item.startswith("p"):
        n = int(item[1:])
        mix, ev = render_sonar(n)
        name = f"sonar_p{n:02d}_{int(args.seconds)}s_software-render_v01.mp3"
        finish(mix, name, f"sonar p{n:02d} {int(args.seconds)} s, software render, not the norns")
        report[name] = {"notes": len(ev["events"]), "stolen": ev["stolen"], "gens": ev["gens"], "bpm": ev["bpm"], "seed": args.seed}
    elif item == "rain":
        mix, info = render_rain()
        name = "rain_software-render_v01.mp3"
        finish(mix, name, f"rain {int(args.seconds)} s, software render, not the norns")
        report[name] = {"notes": len(info["events"]), "scale": info["scale"], "root": info["root"], "seed": args.seed}
(ROOT / "tests" / "logs").mkdir(parents=True, exist_ok=True)
(ROOT / "tests" / "logs" / "render_demo_v01.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "gens"} for k, v in report.items()}))
