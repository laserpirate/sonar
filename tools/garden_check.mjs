// garden_check.mjs · Node check of docs/js/garden.js: determinism, layers on the 4-bar grid, arp, key, growth.
//   node tools/garden_check.mjs
import { readFileSync } from "node:fs";
import { Garden, LOOP_BEATS, scaleOfLength } from "../docs/js/garden.js";
import { growRoots, ARCHETYPES } from "../docs/js/roots.js";
import { maxConcurrent } from "../docs/js/player.js";
const catalog = JSON.parse(readFileSync(new URL("../docs/js/catalog.json", import.meta.url)));
const run = (seed, beats, f) => { const g = new Garden({ catalog, seed }); f?.(g); const evs = []; for (let b = 0; b <= beats; b += 0.05) evs.push(...g.step(b)); return { g, evs }; };
const sig = (evs) => evs.map((e) => `${e.plant}:${e.note}@${e.t.toFixed(3)}`).join(" ");
const out = {};
// 1 determinism
const a = run(1792909998082, 64), b = run(1792909998082, 64), c = run(42, 64);
out.determinism = sig(a.evs) === sig(b.evs) && sig(a.evs) !== sig(c.evs);
out.notes64beats = a.evs.length;
// 2 layer loops: a layer added at beat 2 starts at the next bar (4) and repeats every 16 beats
const { g, evs } = run(7, 80, (g) => { g.addLayer(99, 2); });
const Levs = evs.filter((e) => e.layer);
const L = g.layers[0];
const firstLoop = Levs.filter((e) => e.t < L.start + LOOP_BEATS).map((e) => [e.note, +(e.t - L.start).toFixed(3)]);
const secondLoop = Levs.filter((e) => e.t >= L.start + LOOP_BEATS && e.t < L.start + 2 * LOOP_BEATS).map((e) => [e.note, +(e.t - L.start - LOOP_BEATS).toFixed(3)]);
out.layer = { start: L.start, recorded: L.events.length, firstLoop: firstLoop.length, secondLoop: secondLoop.length, loopIdentical: JSON.stringify(firstLoop) === JSON.stringify(secondLoop) };
// 3 max layers and clear
for (let i = 0; i < 6; i++) g.addLayer(100 + i, 80);
out.maxLayers = g.layers.length; g.clearLayers(); out.cleared = g.layers.length === 0;
// 4 arp: with mode up at 1/16, four arp notes per beat once the buffer has notes
const r4 = run(3, 32, (g) => g.setArp({ mode: "up", rate: "1/16", octaves: 2 }));
const arp = r4.evs.filter((e) => e.arp);
out.arp = { notes: arp.length, perBeatLate: arp.filter((e) => e.t >= 24 && e.t < 32).length / 8, buf: r4.g.arpBuf.length };
// 5 key change changes the pitch set, same timing
const k1 = run(5, 32), k2 = run(5, 32, (g) => g.setKey(48, "major pentatonic"));
out.key = { sameCount: k1.evs.length === k2.evs.length, sameTimes: k1.evs.map((e) => e.t.toFixed(3)).join() === k2.evs.map((e) => e.t.toFixed(3)).join(), differentNotes: sig(k1.evs) !== sig(k2.evs), scale: scaleOfLength(48, "major pentatonic", 8) };
// 6 pitch
const p1 = run(5, 16), p2 = run(5, 16, (g) => g.setPitch(7));
out.pitch = p1.evs.length === p2.evs.length && p1.evs.every((e, i) => p2.evs[i].note === e.note + 7);
// 7 growth: 1 bar per step breathes the generation
const gr = run(9, 48, (g) => g.setGrowth(1));
out.growth = { gens: gr.g.state().gens[0] };
// 8 two arps: each feeds from the plants routed to its engine
const two = run(3, 32, (g) => { g.setRoute(2, "rain"); g.setArp({ mode: "up", rate: "1/8" }, "saw"); g.setArp({ mode: "up", rate: "1/16" }, "rain"); });
const eng = (e) => two.evs.filter((x) => x.arp && x.engine === e).length;
out.twoArps = { saw: eng("saw"), rain: eng("rain"), plant1Saw: two.evs.filter((x) => x.plant === 1).every((x) => x.engine === "saw"), plant2Rain: two.evs.filter((x) => x.plant === 2).every((x) => x.engine === "rain") };
// 9 euclid: 16 steps, 5 pulses keeps 5 of each 16 grid steps
const eu = run(3, 80, (g) => g.setArp({ mode: "up", rate: "1/16", steps: 16, pulses: 5, rotation: 0 }));
const euLate = eu.evs.filter((x) => x.arp && x.t >= 32 && x.t < 64).length;
out.euclid = { perBar16: euLate / 8, expected: 5 };
// 10 flourish: deterministic, runs of 2 to 5 on the other engine
const f1 = run(3, 64, (g) => g.setFlourish(0.8)), f2 = run(3, 64, (g) => g.setFlourish(0.8));
const fl = f1.evs.filter((x) => x.flourish);
out.flourish = { n: fl.length, same: sig(f1.evs) === sig(f2.evs), otherEngine: fl.every((x) => x.engine === "rain") };
// 11 flags off: no flourish, gate 100, full euclid leave v0.2.0's log unchanged
out.defaultsClean = run(3, 64).evs.every((x) => !x.flourish && x.engine === "saw");
// 12 setups: a configured garden and its restored copy play the same 32 bars
const conf = (g) => { g.setKey(48, "phrygian"); g.setPitch(2); g.setGrowth(2); g.nextGen(0); g.nextGen(1); g.plants[0].setAngle(33); g.plants[1].userScale = 0.8; g.addLayer(99, 0); g.addLayer(7, 1); g.setRoute(2, "rain"); g.setArp({ mode: "updown", rate: "1/16", octaves: 2, gate: 40, pulses: 11 }); g.setArp({ mode: "random", rate: "1/8" }, "rain"); g.setDelay("rain", { amount: 0.5, div: "1/4" }); g.setFlourish(0.5); };
const play = (g, beats) => { const evs = []; for (let b = 0; b <= beats; b += 0.05) evs.push(...g.step(b)); return evs; };
const full = (evs) => evs.map((e) => `${e.plant}:${e.note}:${e.engine}:${e.idx}@${e.t.toFixed(4)}`).join(" ");
const orig = new Garden({ catalog, seed: 17 }); conf(orig);
const snap = JSON.parse(JSON.stringify(orig.toSetup()));
const rest = new Garden({ catalog, seed: 999 }).fromSetup(snap, 0);
const dataEqual = JSON.stringify(rest.toSetup()) === JSON.stringify(snap);
const logA = play(orig, 128), logB = play(rest, 128);
// a garden that has played: the snapshot keeps the exact sentences, and loads the same way twice
const late = JSON.parse(JSON.stringify(orig.toSetup()));
const l1 = new Garden({ catalog, seed: 5 }).fromSetup(late, 0), l2 = new Garden({ catalog, seed: 6 }).fromSetup(late, 0);
const sentencesKept = l1.plants.every((p, k) => p.sentence === orig.plants[k].sentence);
out.setup = { dataEqual, notes: logA.length, logsEqual: full(logA) === full(logB), sentencesKept, lateEqual: full(play(l1, 128)) === full(play(l2, 128)) };
// 13 a bad setup changes nothing
const before = JSON.stringify(rest.toSetup());
let refused = 0;
for (const bad of [null, { v: 2 }, { v: 1 }, { v: 1, plants: [{ instr: 99 }, { instr: 1 }] }]) { try { rest.fromSetup(bad, 0); } catch { refused++; } }
out.setupRefused = refused === 4 && JSON.stringify(rest.toSetup()) === before;
// 14 factory setups load and sound
const factory = JSON.parse(readFileSync(new URL("../docs/js/setups.json", import.meta.url)));
out.factory = factory.map((f) => play(new Garden({ catalog, seed: 1 }).fromSetup(f, 0), 64).length);
// 15 a reseed keeps the plants array the page holds
const held = orig.plants; orig.seed(3); out.plantsHeld = held === orig.plants && held[0] === orig.plants[0] && !!held[0].lsys;
// 16 forest: deterministic from the seed, and the conductor's own count never passes the budget
const forest = (seed) => { const g = new Garden({ catalog, seed }); g.setForest({ n: 16, leads: 2, density: 0.8, budget: 6 }); g.setRoots(1, { archetype: "taproot" }); g.setArp({ mode: "up", rate: "1/16" }); return g; };
const fa = forest(9), fb = forest(9);
const fevA = play(fa, 128), fevB = play(fb, 128);
const fsig = (evs) => evs.map((e) => `${e.plant}:${e.note}:${e.silent ? 0 : 1}:${e.bass ? "b" : ""}@${e.t.toFixed(4)}`).join(" ");
const sounding = fevA.filter((e) => !e.silent);
const spans = sounding.map((e) => [e.t * 60 / fa.bpm, e.t * 60 / fa.bpm + fa._lenOf(e)]);
const perBarLead = new Map();
for (const e of sounding) if (!e.arp && !e.bass && !e.chorus && !e.flourish && !e.layer) { const k = Math.floor(e.t / 4); if (!perBarLead.has(k)) perBarLead.set(k, new Set()); perBarLead.get(k).add(e.plant); }
const chorusPerBar = new Map();
for (const e of sounding) if (e.chorus) { const k = `${Math.floor(e.t / 4)}:${e.plant}`; chorusPerBar.set(k, (chorusPerBar.get(k) || 0) + 1); }
out.forest = { same: fsig(fevA) === fsig(fevB), events: fevA.length, sounding: sounding.length, maxVoices: maxConcurrent(spans), leadsPerBarMax: Math.max(...[...perBarLead.values()].map((x) => x.size)),
  chorusOnce: [...chorusPerBar.values()].every((n) => n === 1), lit: new Set(fevA.filter((e) => !e.arp && !e.bass && !e.chorus).map((e) => e.plant)).size, bass: fevA.filter((e) => e.bass && !e.silent).length };
// 17 two plants: forest code leaves v0.2.0's garden alone (no conductor, nothing silent)
out.twoPlantsClean = play(new Garden({ catalog, seed: 42 }), 64).every((e) => !e.silent && !e.chorus && e.voiceKey === undefined);
// 18 roots: every archetype has tips; same seed, same roots
out.roots = Object.fromEntries(ARCHETYPES.map((a) => { const p = { archetype: a, depth: 0.6, spread: 0.5, density: 0.5 }; const r1 = growRoots(p, { x: 0, y: 0 }, 30, 5), r2 = growRoots(p, { x: 0, y: 0 }, 30, 5); return [a, { tips: r1.tips.length, same: JSON.stringify(r1) === JSON.stringify(r2), below: r1.segments.every((q) => q.y2 >= -0.01) }]; }));
// 19 setup round trip with a forest, roots, a user plant
const fo = new Garden({ catalog, seed: 21 }); fo.setForest({ n: 7, leads: 3, density: 0.4, budget: 5 }); fo.setRoots(2, { archetype: "rhizome", depth: 0.3 }); fo.setBass({ sync: 6, octave: -2 });
fo.setup(3, fo.addCustom({ axiom: "X", rules: [["X", "F[+X][-X]FX"], ["F", "FF"]], angle: 22, length: 6, start: 3 }));
const fs = JSON.parse(JSON.stringify(fo.toSetup()));
const fr = new Garden({ catalog, seed: 1 }).fromSetup(fs, 0);
out.forestSetup = { dataEqual: JSON.stringify(fr.toSetup()) === JSON.stringify(fs), logsEqual: fsig(play(fo, 128)) === fsig(play(fr, 128)), n: fr.plants.length };
// 20 Tier 5 plant options: walk is deterministic and differs from flora; density near its value; wildness moves the drawing only
const nsig = (evs) => evs.filter((e) => e.plant === 1 && !e.arp).map((e) => `${e.note}:${e.silent ? 0 : 1}@${e.t.toFixed(4)}`).join(" ");
const opt = (o) => { const g = new Garden({ catalog, seed: 42 }); if (o) g.setPlantOpt(1, o); return g; };
const flora = play(opt(), 128), walk1 = play(opt({ mode: "walk" }), 128), walk2 = play(opt({ mode: "walk" }), 128);
const dens = play(opt({ density: 0.5 }), 256).filter((e) => e.plant === 1 && !e.arp);
const geo = (g) => JSON.stringify(g.geometry()[0].geom);
const gw0 = opt(), gw1 = opt({ wildness: 0.4 });
out.plantOpts = { walkSame: nsig(walk1) === nsig(walk2), walkDiffers: nsig(walk1) !== nsig(flora), walkTimes: walk1.filter((e) => e.plant === 1 && !e.arp).map((e) => e.t.toFixed(4)).join() === flora.filter((e) => e.plant === 1 && !e.arp).map((e) => e.t.toFixed(4)).join(),
  densityShare: +(dens.filter((e) => !e.silent).length / dens.length).toFixed(2), wildGeomDiffers: geo(gw0) !== geo(gw1), wildNotesSame: nsig(play(opt({ wildness: 0.4 }), 128)) === nsig(flora) };
// 21 setup round trip with voices, space and plant options
const vo = new Garden({ catalog, seed: 33 }); vo.setVoiceParam("pluck", "decay", 3.1); vo.setVoiceParam("saw", "octave", 1); vo.setFx({ reverb: { amount: 0.5, size: 3 }, wind: { level: 0.2, tone: 700 } });
vo.setMixVoice("rain", { mute: true }); vo.setPlantOpt(2, { mode: "walk", wildness: 0.3, density: 0.7 }); vo.setRoute(1, "pluck");
const vs = JSON.parse(JSON.stringify(vo.toSetup()));
const vr = new Garden({ catalog, seed: 2 }).fromSetup(vs, 0);
out.voiceSetup = { dataEqual: JSON.stringify(vr.toSetup()) === JSON.stringify(vs), logsEqual: fsig(play(vo, 128)) === fsig(play(vr, 128)), decay: vr.voiceParams.pluck?.decay, walk: vr.plantOpts[2]?.mode };
console.log(JSON.stringify(out, null, 1));
const ok = out.plantOpts.walkSame && out.plantOpts.walkDiffers && out.plantOpts.walkTimes && Math.abs(out.plantOpts.densityShare - 0.5) < 0.12 && out.plantOpts.wildGeomDiffers && out.plantOpts.wildNotesSame &&
  out.voiceSetup.dataEqual && out.voiceSetup.logsEqual && out.voiceSetup.decay === 3.1 && out.voiceSetup.walk === "walk" &&out.forest.same && out.forest.maxVoices <= 6 && out.forest.leadsPerBarMax <= 2 && out.forest.chorusOnce && out.forest.lit === 16 && out.forest.bass > 5 && out.twoPlantsClean &&
  Object.values(out.roots).every((r) => r.tips > 2 && r.same && r.below) && out.forestSetup.dataEqual && out.forestSetup.logsEqual && out.forestSetup.n === 7 && out.setup.dataEqual && out.setup.logsEqual && out.setup.notes > 50 && out.setup.sentencesKept && out.setup.lateEqual && out.setupRefused && out.factory.length === 12 && out.factory.every((n) => n > 5) && out.plantsHeld && out.twoArps.saw > 10 && out.twoArps.rain > 10 && out.twoArps.plant1Saw && out.twoArps.plant2Rain && Math.abs(out.euclid.perBar16 - 5) < 0.51 && out.flourish.n > 0 && out.flourish.same && out.flourish.otherEngine && out.defaultsClean && out.determinism && out.layer.loopIdentical && out.layer.start === 4 && out.maxLayers === 4 && out.cleared && out.arp.notes > 20 && out.key.sameTimes && out.key.differentNotes && out.pitch;
console.log(ok ? "OK" : "FAIL"); process.exit(ok ? 0 : 1);
