// palette.js · the 13 catalog plants and the user plants drawn by the same turtle at generation 2,
// the five root archetypes, and the editor for a user plant. Drawn when the list changes, never per frame.
import { Plant, makeRandom } from "./lsys.js";
import { validatePlant, plantEntry, PLANT_ALPHABET } from "./garden.js";
import { growRoots, ARCHETYPES } from "./roots.js";

const INK = "rgb(92, 104, 158)", ROOT = "rgb(62, 70, 107)";
const pid = (n) => "p" + String(n).padStart(2, "0");

// one plant at a generation: its segments, its sentence and its foot
export function plantSegments(entry, D, gen = 2) {
  const p = new Plant(1, { random: makeRandom(7), defaults: D });
  p.setup(entry, 1, gen);
  return { segs: p.render().segments, sentence: p.sentence, foot: { x: p.startFrom.x, y: p.startFrom.y } };
}

// layers: [{segs, color, width}], fitted to the canvas with a margin
export function drawThumb(cv, layers) {
  const c = cv.getContext("2d"), W = cv.width, H = cv.height;
  c.fillStyle = "#07090e"; c.fillRect(0, 0, W, H);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of layers) for (const s of L.segs) { x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2); y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2); }
  if (x0 === Infinity) return;
  const k = Math.min((W * 0.84) / Math.max(x1 - x0, 1e-6), (H * 0.84) / Math.max(y1 - y0, 1e-6));
  const ox = W / 2 - (k * (x0 + x1)) / 2, oy = H / 2 - (k * (y0 + y1)) / 2;
  c.lineCap = "round";
  for (const L of layers) {
    c.strokeStyle = L.color; c.lineWidth = L.width * (W / 64);
    c.beginPath();
    for (const s of L.segs) { c.moveTo(ox + k * s.x1, oy + k * s.y1); c.lineTo(ox + k * s.x2, oy + k * s.y2); }
    c.stroke();
  }
}

// host: the element to fill; act: {assign(instr | def), roots({archetype})}; state(): {instr, archetype}
export function initPalette({ host, D, catalog, act, state, store, say }) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const tile = (id, label, layers, fire) => {
    const b = document.createElement("button");
    b.id = id; b.className = "tile"; b.title = label;
    const cv = document.createElement("canvas"); cv.width = cv.height = Math.round(56 * dpr);
    const t = document.createElement("span"); t.textContent = label;
    b.append(cv, t); b.onclick = fire;
    drawThumb(cv, layers);
    return b;
  };
  const plants = document.createElement("div"); plants.className = "thumbs"; plants.id = "pal-plants";
  catalog.plants.forEach((entry, i) => {
    const { segs } = plantSegments(entry, D, 2);
    plants.appendChild(tile("pal-" + pid(i + 1), pid(i + 1), [{ segs, color: INK, width: 1.2 }], () => act.assign(i + 1)));
  });
  const users = document.createElement("div"); users.className = "thumbs"; users.id = "pal-users";
  const roots = document.createElement("div"); roots.className = "thumbs"; roots.id = "pal-roots";
  roots.appendChild(tile("pal-none", "none", [{ segs: [{ x1: 0, y1: 0, x2: 0, y2: -20 }], color: INK, width: 1.4 }], () => act.roots({ archetype: null })));
  for (const a of ARCHETYPES) {
    const R = growRoots({ archetype: a, depth: 0.6, spread: 0.5, density: 0.5 }, { x: 0, y: 0 }, 20, 3);
    roots.appendChild(tile("pal-" + a, a, [{ segs: [{ x1: 0, y1: 0, x2: 0, y2: -20 }], color: INK, width: 1.4 }, { segs: R.segments, color: ROOT, width: 1 }], () => act.roots({ archetype: a })));
  }

  const fillUsers = () => {
    users.textContent = "";
    for (const x of store.list()) {
      const v = validatePlant(x.setup);
      if (!v.ok) continue;
      const { segs } = plantSegments(plantEntry(v.def), D, Math.min(2, v.def.start || 2));
      users.appendChild(tile("pal-u-" + x.name.replace(/[^A-Za-z0-9_-]/g, "-"), x.name, [{ segs, color: INK, width: 1.2 }], () => act.assign(v.def)));
    }
  };

  // the editor
  const ed = document.createElement("div"); ed.id = "editor"; ed.className = "editor";
  const field = (id, label, el) => { const row = document.createElement("div"); row.className = "ctl"; const l = document.createElement("label"); l.textContent = label; l.htmlFor = id; el.id = id; row.append(l, el); ed.appendChild(row); return el; };
  const text = (id, label, max) => field(id, label, Object.assign(document.createElement("input"), { type: "text", maxLength: max, autocomplete: "off", spellcheck: false }));
  const range = (id, label, min, max, step, val) => {
    const r = Object.assign(document.createElement("input"), { type: "range", min, max, step, value: val });
    const row = document.createElement("div"); row.className = "ctl";
    const l = document.createElement("label"); l.textContent = label; l.htmlFor = id;
    const v = document.createElement("b"); v.id = id + "-v"; v.textContent = val;
    r.id = id; r.addEventListener("input", () => { v.textContent = r.value; });
    row.append(l, v, r); ed.appendChild(row); return r;
  };
  const axiom = text("ed-axiom", "axiom", 40);
  const rules = [];
  for (let i = 1; i <= 5; i++) rules.push([text("ed-a" + i, `rule ${i} letter`, 1), text("ed-b" + i, `rule ${i}`, 80)]);
  const angle = range("ed-angle", "angle", -180, 180, 0.5, 25);
  const length = range("ed-length", "length", 2, 40, 0.5, 10);
  const start = range("ed-start", "start generation", 0, 6, 1, 2);
  const preview = document.createElement("canvas"); preview.id = "ed-preview"; preview.width = preview.height = Math.round(120 * dpr);
  ed.appendChild(preview);
  const msg = document.createElement("div"); msg.className = "note"; msg.id = "ed-note"; ed.appendChild(msg);
  const name = text("ed-name", "name", 40);
  const read = () => validatePlant({ axiom: axiom.value, rules: rules.map(([a, b]) => [a.value, b.value]), angle: angle.value, length: length.value, start: start.value });
  const update = () => {
    const v = read();
    if (!v.ok) { msg.textContent = v.errors.join(" · "); drawThumb(preview, []); return v; }
    const r = plantSegments(plantEntry(v.def), D, v.def.start);
    drawThumb(preview, [{ segs: r.segs, color: INK, width: 1 }]);
    const cap = D.max_sentence_length ?? 300;
    msg.textContent = `sentence ${r.sentence.length}` + (r.sentence.length >= cap ? ` · capped at ${cap}, as flora` : "") + ` · alphabet ${PLANT_ALPHABET}`;
    return v;
  };
  ed.addEventListener("input", update);
  const btns = document.createElement("div"); btns.className = "btns";
  const button = (id, label, fire) => { const b = document.createElement("button"); b.id = id; b.textContent = label; b.onclick = fire; btns.appendChild(b); return b; };
  button("ed-use", "use", () => { const v = update(); if (v.ok) act.assign(v.def); });
  button("ed-save", "save", () => {
    const v = update(); if (!v.ok) return;
    const n = name.value.trim() || "u" + (store.list().length + 1);
    store.put(n, v.def); name.value = ""; fillUsers(); say?.(`saved ${n}`);
  });
  ed.appendChild(btns);
  // open the editor on the active plant's drawing rules when it is a user plant, else a small default
  const load = (def) => {
    axiom.value = def.axiom; rules.forEach(([a, b], i) => { a.value = def.rules[i]?.[0] ?? ""; b.value = def.rules[i]?.[1] ?? ""; });
    angle.value = def.angle; length.value = def.length; start.value = def.start;
    for (const r of [angle, length, start]) r.dispatchEvent(new Event("input"));
    update();
  };
  load({ axiom: "F", rules: [["F", "F[+F]F[-F]F"]], angle: 25, length: 10, start: 2 });
  ed.hidden = true;

  host.append(plants, users, roots, ed);
  fillUsers();
  const refresh = () => {
    const st = state();
    for (const b of plants.children) b.classList.toggle("on", b.id === "pal-" + pid(st.instr));
    for (const b of roots.children) b.classList.toggle("on", b.id === "pal-" + (st.archetype || "none"));
  };
  return { refresh, fillUsers, toggleEditor: () => { ed.hidden = !ed.hidden; if (!ed.hidden) update(); }, editor: ed, load };
}
