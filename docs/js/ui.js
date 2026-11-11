// ui.js · the rail: tabs, panels and controls, built from small specs. Every control registers
// here, so the MIDI map, macros, randomize and morph all find the same list of parameters.
// A control row is label left, value right, slider full width beneath.

export const controls = new Map(); // id -> {id, label, kind, lo, hi, step, get, set, fire, panel}
const refreshers = [];
export const refreshAll = () => { for (const f of refreshers) f(); };
const $ = (id) => document.getElementById(id);
const tabs = new Map();

const compactQuery = () => (window.matchMedia ? window.matchMedia("(max-width: 820px), (max-height: 560px)") : { matches: false });
export const isCompact = () => compactQuery().matches;

export function addPanel(name, label, { open = false } = {}) {
  const panel = document.createElement("section");
  panel.className = "panel"; panel.id = "panel-" + name; panel.dataset.defaultOpen = open ? "1" : "";
  $("panels").appendChild(panel);
  const b = document.createElement("button");
  b.id = "tab-" + name; b.textContent = label; b.onclick = () => togglePanel(name);
  $("tabs").appendChild(b);
  tabs.set(name, { panel, b });
  return panel;
}
export function openPanel(name, on = true) {
  const t = tabs.get(name);
  if (!t) return;
  if (on && isCompact()) for (const [n, o] of tabs) if (n !== name) { o.panel.classList.remove("open"); o.b.classList.remove("open"); }
  t.panel.classList.toggle("open", on); t.b.classList.toggle("open", on);
  if (on) { t.b.scrollIntoView?.({ inline: "nearest", block: "nearest" }); t.panel.scrollIntoView?.({ block: "nearest" }); }
}
export const togglePanel = (name) => openPanel(name, !tabs.get(name).panel.classList.contains("open"));
// wide screens start with the default panels open; compact screens start with all closed, so the stage is largest
export function applyDefaultPanels() {
  const compact = isCompact();
  for (const [, t] of tabs) { const on = !compact && !!t.panel.dataset.defaultOpen; t.panel.classList.toggle("open", on); t.b.classList.toggle("open", on); }
}

export function group(panel, title, { solo, mute } = {}) {
  const h = document.createElement("div");
  h.className = "ghead"; const s = document.createElement("span"); s.textContent = title; h.appendChild(s);
  const toggle = (txt, o) => {
    if (!o) return;
    const b = document.createElement("button"); b.textContent = txt; b.id = o.id; b.title = o.title || txt;
    b.onclick = () => { o.set(!o.get()); refreshAll(); };
    h.appendChild(b); refreshers.push(() => b.classList.toggle("on", !!o.get()));
    controls.set(o.id, { id: o.id, label: o.label || `${title} ${txt}`, kind: "toggle", get: o.get, set: o.set, fire: () => { o.set(!o.get()); refreshAll(); }, panel: panel.id });
  };
  toggle("S", solo); toggle("M", mute);
  panel.appendChild(h);
  return h;
}

// o: {id, label, min, max, step, get, set, fmt}
export function slider(panel, o) {
  const row = document.createElement("div");
  row.className = "ctl";
  const l = document.createElement("label"); l.textContent = o.label; l.htmlFor = o.id;
  const v = document.createElement("b"); v.id = o.id.replace(/^r-/, "v-");
  const r = document.createElement("input");
  r.type = "range"; r.id = o.id; r.min = o.min; r.max = o.max; r.step = o.step ?? 1; r.value = o.get();
  r.oninput = () => { o.set(Number(r.value)); show(); };
  r.addEventListener("change", () => r.blur()); // a control that has been touched gives the keys back to the page
  const fmt = o.fmt || ((x) => String(x));
  let shown = null;
  const show = () => { const t = fmt(o.get()); if (t !== shown) { v.textContent = t; shown = t; } };
  row.append(l, v, r); panel.appendChild(row);
  refreshers.push(() => { if (document.activeElement !== r) { const x = String(o.get()); if (r.value !== x) r.value = x; } show(); });
  show();
  controls.set(o.id, { id: o.id, label: o.label2 || o.label, kind: "range", lo: Number(o.min), hi: Number(o.max), step: Number(o.step ?? 1), rlo: o.rlo, rhi: o.rhi, get: o.get, set: (x) => { o.set(x); }, panel: panel.id, random: o.random !== false });
  return r;
}

// o: {id, label, options: [value | [value, text]], get, set}
export function select(panel, o) {
  const row = document.createElement("div");
  row.className = "ctl";
  const l = document.createElement("label"); l.textContent = o.label; l.htmlFor = o.id;
  const s = document.createElement("select"); s.id = o.id;
  const fill = (opts) => { s.textContent = ""; for (const x of opts) { const [v, t] = Array.isArray(x) ? x : [x, x]; const e = document.createElement("option"); e.value = v; e.textContent = t; s.appendChild(e); } };
  fill(o.options);
  s.onchange = () => { o.set(typeof o.get() === "number" ? Number(s.value) : s.value); s.blur(); };
  row.append(l, s); panel.appendChild(row);
  refreshers.push(() => { const x = String(o.get()); if (s.value !== x) s.value = x; });
  s.value = String(o.get());
  s.refill = fill;
  controls.set(o.id, { id: o.id, label: o.label2 || o.label, kind: "select", options: o.options.map((x) => (Array.isArray(x) ? x[0] : x)), get: o.get, set: o.set, panel: panel.id, random: o.random !== false });
  return s;
}

export function buttons(panel, list) {
  const row = document.createElement("div");
  row.className = "btns";
  for (const o of list) row.appendChild(button(panel, o, false));
  panel.appendChild(row);
  return row;
}
// o: {id, label, title, fire, on?}
export function button(panel, o, append = true) {
  const b = document.createElement("button");
  b.id = o.id; b.textContent = o.label; if (o.title) b.title = o.title;
  b.onclick = () => { o.fire(); refreshAll(); };
  if (o.on) refreshers.push(() => b.classList.toggle("on", !!o.on()));
  if (append) panel.appendChild(b);
  if (!o.noMap) controls.set(o.id, { id: o.id, label: o.label2 || o.label, kind: "act", fire: o.fire, panel: panel.id });
  return b;
}
export function note(panel, text, id) {
  const p = document.createElement("div"); p.className = "note"; p.textContent = text; if (id) p.id = id; panel.appendChild(p); return p;
}
export const onRefresh = (f) => refreshers.push(f);

// every control marked random gets a value from `rand` (0..1), inside its rlo..rhi, else the middle
// 60 percent of its range; selects pick an option. Same seed, same values: the order is the registry's.
export function randomize(rand) {
  for (const c of controls.values()) {
    if (c.random === false) continue;
    if (c.kind === "range") {
      const lo = c.rlo ?? c.lo + 0.2 * (c.hi - c.lo), hi = c.rhi ?? c.hi - 0.2 * (c.hi - c.lo);
      const st = c.step || 1, x = lo + rand() * (hi - lo);
      c.set(Math.max(c.lo, Math.min(c.hi, Math.round(x / st) * st)));
    } else if (c.kind === "select" && c.options?.length) {
      c.set(c.options[Math.floor(rand() * c.options.length)]);
    }
  }
  refreshAll();
}
