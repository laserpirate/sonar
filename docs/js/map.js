// map.js · every number the score reads, in one table. Tune here, not in score.js.
// Units: seconds, beats, semitones, dB, 0..1. Rows marked SN-xx are logged in DECISIONS.md.

export const MAP = {
  seed: {
    plants: 13,            // plant = seed mod 13, shown as p01..p13
    rootLo: 33,            // A1 (MIDI)
    rootSpan: 25,          // root = A1 + (floor(seed / 13) mod 25): A1..A3
    scale: [0, 2, 3, 5, 7, 9, 10],   // Dorian (flora default)
    scaleLength: 24,       // notes in the sequencer's scale, as flora's build_scale
  },
  tempo: {
    bpmMin: 36, bpmMax: 96,
    vFull: 400,            // world px/s at which bpm reaches bpmMax (default scroll 77.8 -> 47.7 bpm)
    vStop: 2,              // below this the sequencer rests and the drone holds
    smoothS: 2,            // one-pole time constant
    kodamaBpm: 48,         // kodama scenes have no velocity
  },
  gen: {
    minGapS: 8,            // shanshui mounts arrive every ~50 px; one breath at most every 8 s (SN-29)
    stepTags: ["mount", "distmount"],
    restTags: ["flatmount"],
    rainTags: ["boat"],
    restBeats: 4,          // flatmount: one bar of rest
    // derelict world tags are layer names; map them onto the shanshui roles (SN-30)
    alias: { midfar: "mount", far: "distmount", ground: "flatmount" },
  },
  note: {
    durationBeats: 1,      // flora default (note_duration_index 5)
    shedDurationX: 2,      // kodama Shed: longer notes
    attackS: 0.9,          // ambient: attack >= 0.8 s
    releaseS: 2.6,         // release >= 2 s
    maxVoices: 6,          // drone (2) + notes, never more
    sawRate: 0.55,         // saw pulse rate Hz for notes (BandSaw: bpm / 90 at flora's 50 bpm)
    peakDb: -8,            // target, measured offline (tests/score.spec.mjs)
    gain: 0.17,            // note level into the saw engine (makeup 200 inside; calibrated offline, SN-32)
    restartEveryBeats: 0,  // 0: the sequencer walks the whole sentence
  },
  rain: {
    perBeat: 0.35,         // chance of a rain note per beat at weather.rain = 1
    releaseS: 2.5,
    amp: 0.11,
    cutoff: 700,
    octave: 12,            // rain notes one octave over the scale note
  },
  drone: {
    rmsDb: -24,            // target, measured offline
    gain: 0.43,            // level before the master at rq = rqDry, light 1 (calibrated offline, SN-32)
    detuneCents: 7,        // the two voices +- this
    rqDry: 0.08,           // band-pass rq with no fog
    rqFog: 0.8,            // fog = 1 pushes rq toward this (v02 brief)
    driftS: 90,            // a new centre target every 90 s
    driftSpan: 0.03,       // centre wanders root x (1 +- 0.03)
    attackS: 4, releaseS: 4,
    waterSemis: 7,         // water = 1 drops the root this many semitones
    glideS: 6,             // root glide time when water moves
  },
  weather: {
    shelfHz: 200,
    shelfDbDark: 9,        // light = 0 -> +9 dB low shelf on the drone; light = 1 -> 0 dB
    shelfComp: 0.8,        // drone gain down by this x the shelf dB (SN-33)
    rqComp: 0.5,           // drone gain x (rqDry / rq) ^ this as fog opens the band (SN-33)
    wowMax: 0.03,          // wind = 1 -> wobble_amp
    flutterMax: 0.25,      // wind = 1 -> flutter_amp
    fogRqNotes: 0.6,       // fog widens the note band-pass too: rqmax up to this x 0.01 (SN-31)
  },
  kodama: {
    cycleS: 36,            // sim cycle length (kc default ?cycle=36)
    split: [0.4, 0.3, 0.3],
  },
  master: {
    gainDb: -6,            // headroom
    limiterDb: -7,         // a dB under the headroom: the 2 ms attack lets transients past
  },
  norns: {                 // score to norns over the bridge (flora param ids and option indices)
    scaleMode: 5,          // dorian in flora's scale list
    cfs1: 2,               // cf scalar option 2 = x1 (the score plays at scale pitch)
    dur: 5,                // plant_1_note_duration option 5 = 1 beat
    durShed: 7,            // option 7 = 2 beats (kodama Shed)
    tempoEveryS: 0.5,      // clock_tempo at most every 0.5 s, on a whole-bpm change
  },
  panicRampS: 0.012,       // all voices to silence inside 50 ms
  lookaheadS: 0.25,        // events are scheduled this far ahead of the clock
  logMax: 20000,
};

export const dbToGain = (db) => Math.pow(10, db / 20);
