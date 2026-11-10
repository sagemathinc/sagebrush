// The demo pipeline: text -> D4 expansion (cold, or incremental from the previous version) -> events -> HTML chunks.
// Used by the Web Worker (worker.mjs) and by the node CLI (tools/render-file.mjs).
import { coldRun, incremental } from "./incremental-demo.mjs";
import { render, installStale } from "./render.mjs";
import { setPosEpoch, setInputResolver, setPyResults, Machine, BoundError } from "./demo-machine.mjs";
import { itemOf, itemKey, isPy, isCodeEnv, STALE_TITLE } from "./sagetex.mjs";

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

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// (a cheap fingerprint of an included file's text, for noticing that it changed)
function hash32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }

// A result that needs beamer's code (needBeamer: engine/beamer.mjs, the worker's chunk of its own): load() it, then
// again(), the same text rendered with it. If it can't be loaded, the result without it, saying why at its top and that
// a reload tries again (a browser keeps a module that failed to load as failed: astra, #637)
// (a source that declares the class beamer as its first content, read from its first KiB only (@sagebrush's ruling on
//  daybreak3's BEAMER641-DECL-1 and astra's BEAMER641-SCAN-1): blank and % lines skipped, and \RequirePackage[..]{..}
//  and \PassOptionsToClass{..}{..} lines; then \documentclass at a line's start, its class exactly beamer. Not a
//  declaration quoted or stored before (a \verb, a verbatim, a macro's body) or after a \\: false, as is anything
//  else, and needBeamer finds those (an overlay command, an \input). Each pattern's repeats don't overlap, on 1 KiB)
const SKIP = /[ \t\r\ufeff]*(?:%[^\n]*)?\n|[ \t]*\\(?:RequirePackage|PassOptionsToClass)[ \t]*(?:\[[^\]\n]*\][ \t]*)?\{[^}\n]*\}(?:\{[^}\n]*\})?[ \t]*(?:%[^\n]*)?\n/y;
const DECL = /[ \t\ufeff]*\\documentclass[ \t]*(?:\[[^\]]*\][ \t]*)?\{beamer\}/y;
export function declaresBeamer(text) {
  const head = text.slice(0, 1024);
  let p = 0;
  for (SKIP.lastIndex = 0; SKIP.test(head); ) p = SKIP.lastIndex;
  DECL.lastIndex = p;
  return DECL.test(head);
}
// (load(), once: the same promise for every caller, a failed one too)
export function once(load) { let p = null; return () => (p ??= load()); }
export const withBeamer = async (r, load, again) => (r.needBeamer ? withChunk(r, "Beamer's slides", "beamer", load, again) : r);
/** The same for PythonTeX's results pass (engine/pythontex.mjs): a result that needs it (needPy). */
export const withPythontex = async (r, load, again) => (r.needPy ? withChunk(r, "PythonTeX's results", "pythontex", load, again) : r);
async function withChunk(r, what, kind, load, again) {
  try { await load(); } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    r.chunks.unshift('<div class="bounderr">' + what + " could not be loaded (" + escHtml(why) + "); reload the page to try again. The preview shows the document without them.</div>");
    r.chunkPos.unshift(-1); r.problems.push({ kind, name: why, at: -1 });
    return r;
  }
  return again();
}

// PythonTeX (a): the results pass, a lazy chunk (engine/pythontex.mjs), installed by the host; until it is, a
// document with a PythonTeX result to read back is marked needPy, and the host renders it again once it is
let resultsPass = null;
export function installPythontex(m) {
  resultsPass = m.install(Machine, { BoundError, isCodeEnv, setPyResults, itemOf, itemKey, installStale, STALE_TITLE,
    coldRun: (files) => coldRun(files, "main.tex", { limits: LIMITS, Tmin: 1500 }) });
}

export class Engine {
  constructor(opts = {}) { this.opts = opts; this.prev = null; this.text = null; this.epoch = 0; this.inputs = null; this.inputsKey = ""; }
  // sage: SageTeX S1's item states from the page's executor ({states}); kept until the next one is given
  // inputs: the files \input and \include read ({files: Map key -> text, resolve(name) -> {key} | {why}}, the host's:
  // the page's from the workspace, the CLI's from its folder); kept until the next is given; when they change, the
  // document is expanded again from the start (an included file's macros apply everywhere after it)
  update(text, { cold = false, sage, inputs } = {}) {
    if (sage !== undefined) this.opts = Object.assign({}, this.opts, { sage });
    if (inputs !== undefined) {
      // (the host's version of what it read changes whenever any of it does; without one, the files' fingerprints)
      const key = !inputs ? "" : inputs.version !== undefined ? "v" + inputs.version : JSON.stringify([...inputs.files].map(([k, v]) => [k, v.length, hash32(v)]));
      if (key !== this.inputsKey) { this.inputsKey = key; cold = true; }
      this.inputs = inputs;
    }
    const t0 = now();
    setPosEpoch(++this.epoch);
    setInputResolver(this.inputs ? this.inputs.resolve : null);
    const files = new Map([["main.tex", text], ...(this.inputs ? [...this.inputs.files].filter(([k]) => k !== "main.tex") : [])]);
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
    const events = [], inputRefs = new Set();
    // (source positions in events reused from the last run, from units the edit didn't re-expand: those past the edit
    //  move by its length change; markers made in this run are already right)
    const shift = edit && mode !== "cold" ? { end: edit.end, d: edit.text.length - (edit.end - edit.start) } : null;
    for (const u of res.units) if (u.ev) for (let k = 0; k < u.ev.length; k++) {
      const e = u.ev[k];
      // (and a code item's id, H: demo-machine.mjs item)
      if (typeof e !== "number" && e.ep !== undefined && e.ep !== this.epoch) { const f = e.k === "pos" ? "at" : "h"; if (shift && e[f] >= shift.end) e[f] += shift.d; e.ep = this.epoch; }
      if (typeof e !== "number" && e.k === "inref" && inputRefs.size < 256) inputRefs.add(e.name);
      events.push(e);
    }
    let out = render(events, res.intern, this.opts), outcome = res.outcome;
    // (the page as the results pass draws it, when there are PythonTeX results to read back; the same text and results:
    //  the last one's, not expanded again)
    const tk = this.inputsKey + "\u0000" + text;
    // (a saved result, ok or stale, of a PythonTeX item: the results pass, or, until its chunk is here, needPy)
    const needPy = out.sageItems.some((it, n) => isPy(it) && !it.err && /^(ok|stale)$/.test(out.sageStates?.[n]?.s));
    const rp = needPy && resultsPass ? resultsPass(events, out, files, this.rp && this.rp.tk === tk ? this.rp : null) : null;
    this.rp = rp && Object.assign(rp, { tk });
    if (rp) {
      const S = out;
      out = render(rp.ev, rp.res.intern, Object.assign({}, this.opts, { sage: { states: rp.states } }));
      out.sageItems = S.sageItems; out.sageStates = S.sageStates;
      if (rp.res.outcome !== "ok") outcome = rp.res.outcome;
      for (const e of rp.ev) if (typeof e !== "number" && e.k === "inref" && inputRefs.size < 256) inputRefs.add(e.name);
    }
    setInputResolver(null);
    const t2 = now();
    // (an \input in the preamble that wasn't read: a note at the top, as nothing of the preamble is shown)
    if (out.inputMisses?.length) {
      out.chunkPos.unshift(-1);
      out.chunks.unshift('<div class="bounderr inputmiss">Not read: ' + out.inputMisses.map((m) => "\\input{" + escHtml(m.name) + "}: " + escHtml(m.why)).join("; ") + ".</div>");
    }
    if (outcome !== "ok") {
      const why = { "E-BOUND-TIME": "it ran over the 2.5 s time limit (a macro that never stops expanding?)", "E-BOUND-OUTPUT": "it produced too much output (a macro that never stops expanding?)", "E-BOUND-WORK": "it exceeded the work budget (a macro that never stops expanding?)" }[outcome] || "a bound was exceeded";
      out.chunkPos.unshift(-1);
      out.chunks.unshift('<div class="bounderr">Expansion stopped (' + String(outcome).replace(/[^A-Z0-9-]/g, "") + "): " + why + ". The preview shows the output up to that point.</div>");
    }
    this.prev = res; this.text = text;
    return {
      chunks: out.chunks, chunkPos: out.chunkPos, sageItems: out.sageItems, sageStates: out.sageStates || [], imageRefs: out.imageRefs || [], inputRefs: [...inputRefs],
      frames: out.frames || [], problems: out.problems || [], beamer: !!out.beamer, needBeamer: !!out.needBeamer, needPy: needPy && !resultsPass,
      stats: Object.assign({}, out.stats, {
        mode, outcome, expandMs: +(t1 - t0).toFixed(1), renderMs: +(t2 - t1).toFixed(1), units: res.units.length, events: events.length,
        reused: inc ? inc.stats.reusedUnits : 0, reexpanded: inc ? inc.stats.reexpandedUnits : res.units.length, chars: text.length,
      }),
    };
  }
}
