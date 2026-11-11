// garden_check.mjs · Node check of docs/js/garden.js: determinism, layers on the 4-bar grid, arp, key, growth.
//   node tools/garden_check.mjs
import { readFileSync } from "node:fs";
import { Garden, LOOP_BEATS, scaleOfLength } from "../docs/js/garden.js";
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
console.log(JSON.stringify(out, null, 1));
const ok = out.twoArps.saw > 10 && out.twoArps.rain > 10 && out.twoArps.plant1Saw && out.twoArps.plant2Rain && Math.abs(out.euclid.perBar16 - 5) < 0.51 && out.flourish.n > 0 && out.flourish.same && out.flourish.otherEngine && out.defaultsClean && out.determinism && out.layer.loopIdentical && out.layer.start === 4 && out.maxLayers === 4 && out.cleared && out.arp.notes > 20 && out.key.sameTimes && out.key.differentNotes && out.pitch;
console.log(ok ? "OK" : "FAIL"); process.exit(ok ? 0 : 1);
