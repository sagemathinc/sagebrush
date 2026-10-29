// The demo pipeline: text -> D4 expansion (cold, or incremental from the previous version) -> events -> HTML chunks.
// Used by the Web Worker (worker.mjs) and by the node CLI (tools/render-file.mjs).
import { coldRun, incremental } from "./incremental-demo.mjs";
import { render } from "./render.mjs";
import { setPosEpoch } from "./demo-machine.mjs";

const LIMITS = { B0: 1e8, B1: 5e7, k: 1e6, ku: 1e6, safetyWork: 3e8 };   // bounded: a runaway document stops with a bound error
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function diffEdit(a, b) {   // the single edit turning a into b (common prefix and suffix), or null if equal
  if (a === b) return null;
  let p = 0; const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

export class Engine {
  constructor(opts = {}) { this.opts = opts; this.prev = null; this.text = null; this.epoch = 0; }
  // sage: SageTeX S1's item states from the page's executor ({states}); kept until the next one is given
  update(text, { cold = false, sage } = {}) {
    if (sage !== undefined) this.opts = Object.assign({}, this.opts, { sage });
    const t0 = now();
    setPosEpoch(++this.epoch);
    const files = new Map([["main.tex", text]]);
    let res, mode, inc = null;
    const edit = this.prev && this.text !== null ? diffEdit(this.text, text) : null;
    if (!cold && this.prev && this.prev.outcome === "ok" && edit) {
      inc = incremental(this.prev, edit); res = inc.res; mode = inc.stats.mode;
    } else if (!cold && this.prev && this.text === text) { res = this.prev; mode = "unchanged"; }
    else { res = coldRun(files, "main.tex", { limits: LIMITS, Tmin: 1500 }); mode = "cold"; }
    // the D4 machine of a result is never needed again; dropping it keeps an editing session from retaining
    // every earlier version through the resumed machine's checkpoint callback
    res.m = null;
    const t1 = now();
    const events = [];
    // (source positions in events reused from the last run, from units the edit didn't re-expand: those past the edit
    //  move by its length change; markers made in this run are already right)
    const shift = edit && mode !== "cold" ? { end: edit.end, d: edit.text.length - (edit.end - edit.start) } : null;
    for (const u of res.units) if (u.ev) for (let k = 0; k < u.ev.length; k++) {
      const e = u.ev[k];
      if (typeof e !== "number" && e.k === "pos" && e.ep !== this.epoch) { if (shift && e.at >= shift.end) e.at += shift.d; e.ep = this.epoch; }
      events.push(e);
    }
    const out = render(events, res.intern, this.opts);
    const t2 = now();
    if (res.outcome !== "ok") {
      const why = { "E-BOUND-TIME": "it ran over the 2.5 s time limit (a macro that never stops expanding?)", "E-BOUND-OUTPUT": "it produced too much output (a macro that never stops expanding?)", "E-BOUND-WORK": "it exceeded the work budget (a macro that never stops expanding?)" }[res.outcome] || "a bound was exceeded";
      out.chunkPos.unshift(-1);
      out.chunks.unshift('<div class="bounderr">Expansion stopped (' + String(res.outcome).replace(/[^A-Z0-9-]/g, "") + "): " + why + ". The preview shows the output up to that point.</div>");
    }
    this.prev = res; this.text = text;
    return {
      chunks: out.chunks, chunkPos: out.chunkPos, sageItems: out.sageItems, imageRefs: out.imageRefs || [],
      stats: Object.assign({}, out.stats, {
        mode, outcome: res.outcome, expandMs: +(t1 - t0).toFixed(1), renderMs: +(t2 - t1).toFixed(1), units: res.units.length, events: events.length,
        reused: inc ? inc.stats.reusedUnits : 0, reexpanded: inc ? inc.stats.reexpandedUnits : res.units.length, chars: text.length,
      }),
    };
  }
}
