// vana.js · VANA's root namespace onto sonar's plants (ADDENDUM-A, Tier 7). Pure, no imports.
// From the VANA roots handoff, sections 4, 6 and 9: /phylla/<slot>/root, /root/archetype, /root/depth,
// /root/spread, /root/density, /root/taproot_dom, /root/rhizome_reach, /root/maturity; slots 1 to 4.
//
// VANA archetype            sonar roots        note
// taproot_heart             taproot
// conifer_plate             plate
// deep_fibrous              fibrous
// deep_fibrous_grass        fibrous            narrow: spread held at or under 0.3
// rhizomatous_spreader      rhizome
// rhizomatous_emergent      rhizome
// ericaceous_mat            ericaceous
// tussock_sedge             fibrous
// compact_forb              fibrous            small: depth held at or under 0.35
// prop                      (none)             above-ground roots, no counterpart; the plant's roots stay
// engine rootType names (taproot, plate, fibrous, rhizomatous, ericaceous, tussock, forb) map the same way.
//
// Values arrive in VANA's ranges. depth: a ratio of plant height (x H, up to about 2), or centimetres for
// the rhizomatous types (a value over 5 is read as cm, 200 cm = full); spread: x H, up to about 2;
// density, root and maturity 0..1; rhizome_reach x H widens a rhizome's spread. `root` sets the bass level.
// taproot_dom and maturity are kept but drive nothing yet. species is kept as text.

export const VANA_ARCHETYPES = {
  taproot_heart: { archetype: "taproot" }, conifer_plate: { archetype: "plate" }, deep_fibrous: { archetype: "fibrous" },
  deep_fibrous_grass: { archetype: "fibrous", spreadMax: 0.3 }, rhizomatous_spreader: { archetype: "rhizome" },
  rhizomatous_emergent: { archetype: "rhizome" }, ericaceous_mat: { archetype: "ericaceous" }, tussock_sedge: { archetype: "fibrous" },
  compact_forb: { archetype: "fibrous", depthMax: 0.35 }, prop: { archetype: null },
  taproot: { archetype: "taproot" }, plate: { archetype: "plate" }, fibrous: { archetype: "fibrous" }, rhizomatous: { archetype: "rhizome" },
  ericaceous: { archetype: "ericaceous" }, tussock: { archetype: "fibrous" }, forb: { archetype: "fibrous", depthMax: 0.35 },
};
const c01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

// one VANA slot's raw values -> {roots: {archetype, depth, spread, density} | null, bass: level | undefined}
export function vanaSlotToRoots(v) {
  const a = v.archetype !== undefined ? VANA_ARCHETYPES[String(v.archetype)] : undefined;
  if (v.archetype !== undefined && (!a || a.archetype === null)) return { roots: null, unmapped: String(v.archetype) };
  const roots = {};
  if (a) roots.archetype = a.archetype;
  if (v.depth !== undefined) { const d = Number(v.depth); roots.depth = c01(d > 5 ? d / 200 : d / 2); }
  if (v.spread !== undefined) roots.spread = c01(Number(v.spread) / 2);
  if (v.density !== undefined) roots.density = c01(v.density);
  if (v.rhizome_reach !== undefined && (roots.archetype ?? v.current) === "rhizome") roots.spread = Math.max(roots.spread ?? 0, c01(Number(v.rhizome_reach) / 2));
  if (a?.spreadMax !== undefined && roots.spread !== undefined) roots.spread = Math.min(roots.spread, a.spreadMax);
  if (a?.depthMax !== undefined) roots.depth = Math.min(roots.depth ?? a.depthMax, a.depthMax);
  return { roots, bass: v.root !== undefined ? c01(v.root) : undefined };
}

// "/phylla/2/root/depth" -> {slot: 2, key: "depth"}; "/phylla/2/root" -> key "root"; species too
export function parseVanaPath(path) {
  const m = /^\/phylla\/([1-4])\/(species|root)(?:\/(archetype|depth|spread|density|taproot_dom|rhizome_reach|maturity))?$/.exec(path);
  if (!m) return null;
  return { slot: Number(m[1]), key: m[2] === "species" ? "species" : m[3] || "root" };
}

// a Phylla JSON export -> a sonar user plant, when its word fits flora's alphabet and the axiom limit
export function phyllaToPlant(j, { alphabet, maxAxiom = 40 }) {
  if (!j || typeof j !== "object" || !Array.isArray(j.word)) return { ok: false, why: "not a Phylla JSON export (no word)" };
  const syms = j.word.map((m) => String(m?.s ?? ""));
  const outside = [...new Set(syms.filter((s) => s.length !== 1 || !alphabet.includes(s)))];
  const why = [];
  if (outside.length) why.push(`uses ${outside.join(" ")} outside flora's alphabet`);
  if (syms.length > maxAxiom) why.push(`has ${syms.length} modules, more than ${maxAxiom}`);
  const roots = j.genome?.root_archetype !== undefined || j.genome?.root_params ? vanaSlotToRoots({ archetype: j.genome?.root_archetype, ...(j.genome?.root_params || {}), depth: j.genome?.root_params?.depth_abs_cm ?? j.genome?.root_params?.depth }) : null;
  if (why.length) return { ok: false, why: "Phylla plant " + why.join(", and ") + "; not imported", roots };
  const theta = Number(j.genome?.theta);
  return { ok: true, def: { axiom: syms.join(""), rules: [], angle: Number.isFinite(theta) ? theta : 25, length: 6, start: 0 }, name: String(j.species || "phylla").slice(0, 24), roots };
}
