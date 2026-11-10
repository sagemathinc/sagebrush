// PythonTeX, step (a) (plan r3.1, CLEAR by daybreak3, astra and board): the results pass, as a lazy chunk of the worker's
// own (dist/sagebrush-latex-pythontex.js, web/build.ts), fetched only by a document with a PythonTeX result to read
// back: a document without one never pays for it. The CLI and the tests install it at once (pipeline.mjs
// installPythontex). It imports nothing, so the chunk has no copy of the expander or the pipeline: what it needs comes
// in install()'s arguments, the expander's Machine and the pipeline's parts.
//
// The code items are fixed by the source alone: the source pass (the expansion with nothing read back) gives S, what
// Run, check and the CLI use. Its saved PythonTeX results are TeX source, read back where each item stands by a second,
// cold expansion, the results pass, which only draws the page. In it, each item gets a value only by its source id
// (demo-machine.mjs item: (H, k)); a result-born item has none (the taint below). After it, the items reached at each H
// are compared with S's there, in order (count, kind, code, where read): any difference, and no item at that H gets a
// value, and the pass runs again without reading back that H's results (one read back too early can't be taken back);
// at most 3 passes, then every H from the first refused one is refused too, and one last pass is the one shown.

/** Why an item in the results pass has no value (board's texts): result-born (made by a result's text, or by something
 * a result defined), not the document's code; a source item whose place's items a result changed (R3.1-1), or past
 * one when the passes didn't settle (R3.1-2). */
export const NOT_FROM_DOC = "Not run: this code comes from a result, not from the document (a result can't add code)";
export const NOT_HERE = "Not run: a result changed which code runs here; press Run again to update";
export const NOT_EARLIER = "Not run: results changed which code runs earlier in the document; press Run again to update";

let D;
// (a result's cap and UTF-8 size: sagetex.mjs's MAX_RESULT and utf8len, which the tests pin equal; a PythonTeX item)
export const MAX_RESULT = 16384;
const utf8len = (s) => new TextEncoder().encode(s).length, isPy = (it) => /^py/.test(it.mode);
// (a dispatch's taint (rt) is its own: put back as it was after it; a macro's call tainted by its meaning's, m.t)
const scope = (fn) => function (a, m) { const s = this.rt; this.dd = (this.dd | 0) + 1; if (m?.t) this.rt = 1; try { return fn.call(this, a, m); } finally { this.dd--; this.rt = s; } };

/** Install the results pass: the expander's provenance (taint) and read-back on `Machine`; -> resultsPass. */
export function install(Machine, deps) {
  D = deps;
  // (the renderer's fade: what is drawn while a stale result's frame is read (between its stale events, R3-4) has the
  //  class sagestale, a text run's added to its size's classes, a block's on a box around it)
  let zd = 0;
  deps.installStale({
    on: (on) => { zd = on === undefined ? 0 : Math.max(0, zd + (on ? 1 : -1)); },
    s: (st) => (zd > 0 && st && !/sagestale/.test(st.size ?? "") ? Object.assign({}, st, { size: (st.size ? st.size + " " : "") + "sagestale" }) : st),
    b: (h) => (zd > 0 ? '<div class="sagestale" title="' + deps.STALE_TITLE + '">' + h + "</div>" : h),
  });
  const P = Machine.prototype, { prim, xprim, callMacro, callLMacro, setS, pushList, openFile } = P, { BoundError } = deps;
  Object.assign(P, {
    // ---- provenance (R3-2). rt is 1 while the dispatch running is tainted: its token, its meaning, or something it read
    // came from a result. A frame pushed or a file opened while it runs, and a meaning set, carry the taint on (f.t,
    // m.t); an item marked while it is set is result-born (demo-machine.mjs item: no source id)
    prim(name, fn) { prim.call(this, name, scope(fn)); },
    xprim(name, fn, cond = false) { xprim.call(this, name, scope(fn), cond); },
    callMacro: scope(callMacro),
    callLMacro: scope(callLMacro),
    pushList(toks, kind, extra) { pushList.call(this, toks, kind, this.rt ? Object.assign({ t: 1 }, extra) : extra); },
    openFile(path) { const ok = openFile.call(this, path); if (ok && this.rt) this.stack[this.stack.length - 1].t = 1; return ok; },
    // (a meaning set while tainted: a copy that taints whoever uses it; the copy keeps vh, so \ifx and sameMeaning still
    //  see it as the same meaning (daybreak3, plan r3))
    setS(k, v, global) {
      if (this.rt && v && typeof v === "object" && !v.t && k.startsWith("m:")) {
        const fn = v.fn;
        v = Object.assign({}, v, { t: 1 }, fn ? { fn(t) { this.rt = 1; return fn.call(this, t); } } : {});
      }
      setS.call(this, k, v, global);
    },
    // (the core's nextX and nextRaw, with the taint kept: rt cleared before each outermost token, set by a token read
    //  from a tainted frame; a stale result's frame read to its end ends its stale span, R3-4)
    nextX() {
      for (;;) {
        if (!this.dd) this.rt = 0;
        this.noexpandNext = false;
        const t = this.nextRaw();
        if (t === null) return null;
        if (this.noexpandNext) { this.lastNoexpand = true; return t; }
        this.lastNoexpand = false;
        if (t >= 0) return t;   // (a character: the core's isCs is t < 0)
        const m = this.mean(t);
        if (m === undefined) return t;
        if (m.type === "macro") { if (this.edefDepth && m.prot) return t; this.callMacro(t, m); continue; }
        if (m.type === "lmacro") { if (this.edefDepth && m.prot) return t; this.callLMacro(t, m); continue; }
        if (m.type === "xprim") { m.fn.call(this, t); continue; }
        return t;
      }
    },
    nextRaw() {
      const s = this.stack;
      while (s.length) {
        const f = s[s.length - 1];
        if (f.kind === "file") {
          const t = this.readTok(f);
          if (t !== null) { if (f.t) this.rt = 1; return t; }
          s.pop(); if (f.z) this.mark({ k: "z", on: 0 }); if (f.onEnd) f.onEnd(); continue;
        }
        if (f.i < f.toks.length) { this.charge(1); const t = f.toks[f.i++]; if (f.noexpand) this.noexpandNext = true; if (f.t) this.rt = 1; return t; }
        s.pop();
      }
      return null;
    },
    // a result read back as TeX: as an \input of generated text (real TeX semantics: read lazily, with the catcodes of
    // the moment, unbraced, ungrouped), tainted; a stale one between stale events, the end one when its frame ends.
    // (\py's ends without an end-of-line space, as PythonTeX's own: "1024." stays "1024."; what pycode and pyblock
    //  printed keeps its last line's, as PythonTeX's \input of it does: "D: 8 E:")
    pushResult(r, inline = false) {
      if (this.stack.filter((f) => f.kind === "file").length >= this.limits.inputDepth) throw new BoundError("E-BOUND-INPUT", "depth");
      this.reserve(r.text.length * 2);
      if (r.z) this.mark({ k: "z", on: 1 });
      this.stack.push({ kind: "file", path: "<native>", text: inline ? r.text + "%" : r.text, pos: 0, line: null, li: 0, st: 0, endinput: false, t: 1, z: r.z ? 1 : 0 });
    },
  });
  return resultsPass;
}

// (what makes a read-back result an item's, and what the check after the pass compares: its kind, its code as read,
//  and where its command was read (R3.1-1 "at"))
const sigOf = (o, ap) => (o.mode || o.env) + "\u0000" + (o.code ?? o.text ?? "") + "\u0000" + ap;
const itemEvents = (events) => events.filter((e) => typeof e !== "number" && (e.k === "sage" || (e.k === "verbenv" && D.isCodeEnv(e.env))));
function byH(list) {
  const m = new Map();
  for (const e of list) if (e.h !== undefined) { if (!m.has(e.h)) m.set(e.h, []); m.get(e.h).push(sigOf(e, e.ap)); }
  return m;
}
function eventsOf(res) { const ev = []; for (const u of res.units) if (u.ev) for (const e of u.ev) ev.push(e); return ev; }

// the page as the results pass draws it: {res, ev, states (the display's, one per item it reached), key, passes}
function resultsPass(events, out, files, prev = null) {
  const S = itemEvents(events), st = out.sageStates || [], push = new Map();
  S.forEach((e, n) => {
    const x = st[n], it = out.sageItems[n];
    // (only a PythonTeX item's ok or stale result, its text within MAX_RESULT: checked before it is ever tokenized)
    if (e.h === undefined || !it || !isPy(it) || it.err || !x || (x.s !== "ok" && x.s !== "stale") || typeof x.latex !== "string" || utf8len(x.latex) > MAX_RESULT) return;
    push.set(e.h + ":" + e.kk, { sig: sigOf(e, e.ap), text: x.latex, z: x.s === "stale" ? 1 : 0, h: e.h });
  });
  if (!push.size) return null;
  // (the same text and the same results read back: the last results pass's expansion, not expanded again (ENGINE r1);
  //  its display states are made again below, from the source's states now: a Sage item's new value, or any state not
  //  read back, isn't in the key (astra's PTX-CACHE-1))
  const key = JSON.stringify([...push]);
  if (prev && prev.key === key) return Object.assign({}, prev, { states: display(S, st, prev.ev, prev.refused) });
  const SH = byH(S), refused = new Map();
  const run = () => {
    // (an item's result: the one for its id, if it is this very item: its kind, its code as read, where it was read;
    //  read back as TeX where \py and pycode stand, a pyblock's kept for \printpythontex. \printpythontex (no item)
    //  from a result, or from a macro one defined: not run (R3-3))
    const m = new Map([...push].filter(([, r]) => !refused.has(r.h)));
    D.setPyResults(function (o, ap) {
      if (!o) return this.rt ? this.mark({ k: "sageunsup", name: "printpythontex", msg: NOT_FROM_DOC }) : this.lastBlock && this.pushResult(this.lastBlock);
      let r = !o.tn && !o.err && m.get(o.h + ":" + o.kk);
      if (r && r.sig !== sigOf(o, ap)) r = null;
      if (o.env === "pyblock") this.lastBlock = r; else if (r) this.pushResult(r, o.mode === "py");
    });
    try { const r = D.coldRun(files); r.m = null; return r; } finally { D.setPyResults(null); }
  };
  let res, ev, pass = 1;
  for (; ; pass++) {
    res = run(); ev = eventsOf(res);
    const RH = byH(itemEvents(ev)); let grew = false;
    for (const h of new Set([...SH.keys(), ...RH.keys()])) {
      const a = SH.get(h) ?? [], b = RH.get(h) ?? [];
      if (!refused.has(h) && (a.length !== b.length || a.some((x, i) => x !== b[i]))) { refused.set(h, NOT_HERE); grew = true; }
    }
    if (!grew) break;
    if (pass === 3) {
      const h0 = Math.min(...refused.keys());
      for (const h of SH.keys()) if (h >= h0 && !refused.has(h)) refused.set(h, NOT_EARLIER);
      res = run(); ev = eventsOf(res); pass++;
      break;
    }
  }
  return { res, ev, refused, states: display(S, st, ev, refused), key, passes: pass };
}
// each results-pass item's display state: result-born, refused, or its source item's state now (by its id)
function display(S, st, ev, refused) {
  const idx = new Map(S.map((e, n) => [e.h + ":" + e.kk, n]));
  return itemEvents(ev).map((e) => {
    const key = D.itemKey(D.itemOf(e)), n = e.tn ? undefined : idx.get(e.h + ":" + e.kk), why = e.tn ? NOT_FROM_DOC : refused.get(e.h) ?? (n === undefined ? NOT_HERE : null);
    return why ? { key, s: "notrun", msg: why } : Object.assign({}, st[n], { key });
  });
}
