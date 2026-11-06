// kodama.js · ?kodama=1 · phase presets Wet, Shed, Dry (keys W, S, D)
//
// A phase is a set of flora parameters. In sim it sets the browser saw
// engine (rqmin, rqmax) and the sim sequencer (cf scalar, note duration).
// In live it sends the same values as /param/* to norns, in flora's units:
// rqmin and rqmax are x1000 (flora sends param/1000 to the engine), cfs1 and
// plant_N_note_duration are option indices.
// Values are first guesses (SN-21) to be tuned against the kodama scenes.

export const PHASES = {
  wet:  { label: "wet",  rqmin: 2.0, rqmax: 8.0, cfs1: 3, cf: 2, duration_ix: 5, duration: 1 },
  shed: { label: "shed", rqmin: 1.0, rqmax: 5.0, cfs1: 2, cf: 1, duration_ix: 4, duration: 0.75 },
  dry:  { label: "dry",  rqmin: 0.3, rqmax: 1.5, cfs1: 4, cf: 4, duration_ix: 3, duration: 0.5 },
};

export function init({ S, act }) {
  function apply(name) {
    const ph = PHASES[name];
    S.phase = name;
    if (act.isLive()) {
      act.send("/param/rqmin", [ph.rqmin]);
      act.send("/param/rqmax", [ph.rqmax]);
      act.send("/param/cfs1", [ph.cfs1]);
      act.send("/param/plant_1_note_duration", [ph.duration_ix]);
      act.send("/param/plant_2_note_duration", [ph.duration_ix]);
    } else {
      act.simParams({ duration: ph.duration, cfScalar: ph.cf });
    }
    if (S.audio && S.audio.saw) { S.audio.saw.set("rqmin", ph.rqmin / 1000); S.audio.saw.set("rqmax", ph.rqmax / 1000); }
    const f = document.getElementById("f-phase");
    if (f) f.innerHTML = `phase <b>${ph.label}</b>`;
  }
  const hud = document.getElementById("hud");
  const span = document.createElement("span");
  span.className = "fact"; span.id = "f-phase"; span.innerHTML = "phase <b>-</b>";
  hud.insertBefore(span, document.getElementById("f-bpm").nextSibling);
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    const name = k === "w" ? "wet" : k === "s" ? "shed" : k === "d" ? "dry" : null;
    if (name) { e.preventDefault(); try { apply(name); } catch (err) { console.warn("kodama", err); } }
  });
  S.kodama = { apply, PHASES };
}
