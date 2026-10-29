// Demo layer over the D4 core (the core files in ../core/ are byte-identical to D4 r14; see core/D4R14-SHA256SUMS).
// DemoMachine records, per unit, the OUTPUT EVENTS a renderer needs: every emitted token, plus structural markers the
// core consumes and drops (brace groups, environments, section titles, labels and refs, verbatim text, the document
// class). Markers are plain objects; tokens are the core's integers. Each unit carries its events (unit.ev), so the D4
// incremental layer reuses a converged suffix's events together with its units.
// incremental-demo.mjs is core/incremental.mjs with only its two import lines changed (to this module).
import { Machine as CoreMachine, Intern, BoundError, StopError, setCurrentIntern, DEFAULT_LIMITS, CAT, mkChar, isCs, catOf, codeOf, SPACE_TOK } from "../core/machine.mjs";

export { Intern, BoundError, StopError, setCurrentIntern, DEFAULT_LIMITS, CAT, mkChar, isCs, catOf, codeOf, SPACE_TOK };

// every name counts as "known": an undefined control sequence is EMITTED (the renderer decides how to show it)
// instead of being dropped with E-UNDEF-CS
const ALL_KNOWN = { has: () => true };
const VERBATIM = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*",
  "pycode", "pyblock", "pysub", "pyverbatim", "pyconsole", "sageblock", "sagesilent", "sagecommandline", "sageexample", "sageverbatim", "sympycode", "pylabcode"]);
const MAX_VERB = 1 << 20;   // characters kept from one verbatim block
// s03 (William's report: a self-recursive \newcommand hung the page): every machine also stops at a WALL-CLOCK bound
// (checked at the core's own poll points, every pollEvery work units) and at an output-event bound; both stop the
// expansion with a bound error, shown as a banner, instead of running until the page's 15 s watchdog
const TIME_LIMIT_MS = 2500;
const MAX_EVENTS = 3000000;
const PMARK = 16;
const SAGE_MAX_CODE = 65536;   // UTF-8 bytes of one \sage / \sageplot argument (plan r4 section 8: 64 KiB per item)

export class Machine extends CoreMachine {
  constructor(opts) {
    super(Object.assign({}, opts, { known: ALL_KNOWN }));
    this.ev = []; this.nev = 0; this.deadline = Date.now() + TIME_LIMIT_MS;
    this.installDemoPrimitives();
  }
  emit(t) { if (++this.nev > MAX_EVENTS) throw new BoundError("E-BOUND-OUTPUT", "events"); this.ev.push(t); super.emit(t); }
  mark(o) { if (++this.nev > MAX_EVENTS) throw new BoundError("E-BOUND-OUTPUT", "events"); this.ev.push(o); this.reserve(32); }
  charge(n) { super.charge(n); if (this.sincePoll === 0 && Date.now() > this.deadline) throw new BoundError("E-BOUND-TIME"); }
  beginGroup(kind) { super.beginGroup(kind); if (kind === "brace") this.mark({ k: "o" }); }
  endGroup(kind) { if (kind === "brace") this.mark({ k: "c" }); super.endGroup(kind); }
  finishUnit(nextIndex) {
    super.finishUnit(nextIndex);
    this.units[this.units.length - 1].ev = this.ev;
    this.ev = [];
  }
  restore(ck, files, delta = 0) { super.restore(ck, files, delta); this.ev = []; this.nev = 0; this.deadline = Date.now() + TIME_LIMIT_MS; }
  // push "{s}" back as an argument, for a core primitive that reads it again
  pushArg(s) {
    const toks = [mkChar(CAT.BGROUP, 123)].concat(this.str2toks(s), [mkChar(CAT.EGROUP, 125)]);
    this.pushList(toks);
  }

  // ---- half-typed arguments (William, Oct 29: "\begin{" typed in the middle of a document blanked everything after
  // it). LaTeX's commands that take a name (\begin, \end, \label, \ref, counters, packages, ...), an optional [...] or a
  // section title are not \long: a \par (a blank line) inside the argument ends it ("Runaway argument? ... Paragraph
  // ended before \begin was complete"), the \par is read again, and LaTeX goes on. These readers do the same (the core's
  // own readers, which run to the end of the input, are unchanged): the \par goes back, and this.runaway records where
  // the argument stopped, so the command can say so and drop itself, as TeX drops the call, instead of swallowing the
  // rest of the document. A demo primitive clears this.runaway before it reads.
  readShortGroup(open) {    // after "{": to the matching "}", or up to a \par or the end of the input (this.runaway set)
    const out = []; let depth = 1;
    for (;;) {
      const t = this.nextRaw();
      if (t === null) { this.d("E-RUNAWAY"); this.runaway = { open, text: this.toks2str(out) }; return out; }
      if (isCs(t) && this.intern.name(t) === "par") { this.d("E-RUNAWAY-PAR"); this.back(t); this.runaway = { open, text: this.toks2str(out) }; return out; }
      if (!isCs(t)) { const c = catOf(t); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP && --depth === 0) return out; }
      out.push(t); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }
  readArgShortRaw() {       // an undelimited argument, short: a group as readShortGroup reads it, else one token
    const t = this.skipSpacesRaw();
    if (t === null) return [];
    if (!isCs(t) && catOf(t) === CAT.BGROUP) return this.readShortGroup("{");
    return [t];
  }
  readArgString() { return this.toks2str(this.readArgShortRaw()).trim(); }
  readOptRaw() {            // [ ... ] if present (else null), short: it ends at a \par or the end of the input too
    const t = this.skipSpacesRaw();
    if (t === null) return null;
    if (t !== mkChar(CAT.OTHER, 91)) { this.back(t); return null; }
    const out = []; let depth = 0;
    for (;;) {
      const u = this.nextRaw();
      if (u === null) { this.runaway = { open: "[", text: this.toks2str(out) }; return out; }
      if (isCs(u) && this.intern.name(u) === "par") { this.d("E-RUNAWAY-PAR"); this.back(u); this.runaway = { open: "[", text: this.toks2str(out) }; return out; }
      if (!isCs(u)) { const c = catOf(u); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP) depth--; }
      if (depth === 0 && u === mkChar(CAT.OTHER, 93)) return out;
      out.push(u); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }
  // the note for a command whose argument ran away (it is then dropped, as TeX drops the call); true if one was made
  ranAway(name) {
    const r = this.runaway; this.runaway = null;
    if (!r) return false;
    this.mark({ k: "err", code: "runaway", name, text: r.open + r.text });
    return true;
  }

  // verbatim text: the core skips it; here it is captured (bounded) first, then the core's own skip runs
  // (the demo's own skip: like the core's, but "\end{env}" may have spaces or a line break before its brace, as
  //  LaTeX.js's showcase writes it; the text in between is captured, bounded)
  skipVerbatim(env) {
    const f = this.stack[this.stack.length - 1];
    if (!f || f.kind !== "file") { this.d("E-VERBATIM-IN-ARG"); this.mark({ k: "verbenv", env, text: "", inarg: true }); return; }
    const esc = env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\\\end\\s*\\{" + esc + "\\}", "g");
    const restStart = f.line === null ? f.pos : f.lineStart + f.li;   // absolute offset of the rest of the current line
    re.lastIndex = restStart;
    const m = re.exec(f.text);
    let text;
    let unterminated = false, truncated = false;
    if (!m) { this.d("E-UNTERMINATED-VERBATIM"); text = f.text.slice(restStart); f.pos = f.text.length; f.line = null; unterminated = true; }
    else {
      text = f.text.slice(restStart, m.index);
      const endAt = m.index + m[0].length;
      this.charge(Math.ceil((endAt - restStart) / 64));
      const ls = f.text.lastIndexOf("\n", endAt - 1) + 1;
      f.pos = ls; this.loadLine(f); f.li = endAt - ls; f.st = 1;
    }
    text = text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (text.length > MAX_VERB) { text = text.slice(0, MAX_VERB); truncated = true; }
    // (SageTeX S1, plan r4 section 4: a code block's capture fails closed, so the marker says whether it is whole)
    const o = { k: "verbenv", env, text };
    if (unterminated) o.unterminated = true;
    if (truncated) o.truncated = true;
    this.mark(o);
  }

  // SageTeX S1 (plan r4 section 3): the argument of \sage / \sageplot as raw tokens, under the S1 inline subset.
  // -> { code } or { err, name? }. Character tokens of any category and balanced braces are allowed; a control
  // sequence or an active character, a blank line (a \par token: the argument ran on, as "a % b}" does), the end of
  // the input, an empty argument, or more than SAGE_MAX_CODE characters is rejected. The whole argument is consumed
  // either way, so the rest of the document reads as TeX would read it.
  readSageArg() {
    const t0 = this.skipSpacesRaw();
    if (t0 === null) return { err: "unbalanced" };
    if (isCs(t0) || catOf(t0) !== CAT.BGROUP) { this.back(t0); return { err: "nobrace" }; }
    let depth = 1, s = "", bytes = 0, err = null, name = null, n = 0;
    for (;;) {
      const t = this.nextRaw();
      if (t === null) return { err: "unbalanced" };
      this.charge(1);
      if (++n > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
      if (isCs(t)) {
        const nm = this.intern.name(t);
        if (nm === "par") { this.back(t); return { err: "par" }; }
        if (err === null) { err = nm.startsWith("\u0001") ? "active" : "cs"; name = nm.startsWith("\u0001") ? nm.slice(1) : nm; }
        continue;
      }
      const c = catOf(t);
      if (c === CAT.BGROUP) depth++;
      else if (c === CAT.EGROUP && --depth === 0) break;
      if (c === PMARK) continue;
      // (the cap is UTF-8 bytes, as everywhere; past it, nothing more is kept, and the item is refused below)
      const cp = c === CAT.SPACE ? 32 : codeOf(t);
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (bytes <= SAGE_MAX_CODE) s += String.fromCodePoint(cp);
    }
    if (err !== null) return { err, name };
    if (bytes > SAGE_MAX_CODE) return { err: "toolong" };
    if (s.trim() === "") return { err: "empty" };
    return { code: s };
  }

  installDemoPrimitives() {
    const P = this;
    const core = (nm) => this.A.get("m:" + nm).fn;
    const coreBegin = core("begin"), coreEnd = core("end"), coreClass = core("documentclass"), coreLabel = core("label");
    const isVerb = (env) => VERBATIM.has(env);
    // \begin / \end: the core's behaviour, plus markers (the name is read here, then pushed back for the core)
    P.prim("begin", function (t) {
      this.runaway = null;
      const env = this.readArgString();
      if (this.ranAway("begin")) return;
      // verbatim: exactly the core's branch (its reader must be the file on top of the stack, not a pushed list)
      if (isVerb(env)) { this.charge(env.length); this.skipVerbatim(env); return; }
      if (env === "document") this.mark({ k: "doc" });
      else this.mark({ k: "be", env, user: this.getS("m:" + env) !== undefined });
      this.pushArg(env);
      coreBegin.call(this, t);
    });
    P.prim("end", function (t) {
      this.runaway = null;
      const env = this.readArgString();
      if (this.ranAway("end")) return;
      if (env !== "document" && this.getS("m:end" + env) === undefined) this.mark({ k: "ee", env });
      this.pushArg(env);
      coreEnd.call(this, t);
    });
    // a user environment's end: the end macro's output comes first, then the marker
    P.prim("sb@endgroup", function () { const g = this.groups[this.groups.length - 1]; this.mark({ k: "ee", env: g ? g.env : "?" }); this.endGroup("env"); });
    // the document class (the core reads and drops it)
    P.prim("documentclass", function (t) {
      this.runaway = null;
      const opt = this.readOptRaw(); if (this.ranAway("documentclass")) return;
      const cls = this.readArgString(); if (this.ranAway("documentclass")) return;
      this.mark({ k: "cls", cls, opt: opt ? this.toks2str(opt) : "" });
      this.pushArg(cls);
      coreClass.call(this, t);
    });
    // labels and references: the key is kept as a marker
    P.prim("label", function (t) {
      this.runaway = null;
      const key = this.readArgString();
      if (this.ranAway("label")) return;
      this.mark({ k: "label", key });
      this.pushArg(key);
      coreLabel.call(this, t);
    });
    for (const nm of ["ref", "eqref", "pageref", "cite", "cref", "Cref", "autoref", "citep", "citet", "nameref"]) P.prim(nm, function () {
      this.runaway = null;
      const opt = this.readOptRaw(); if (this.ranAway(nm)) return;
      const key = this.readArgString(); if (this.ranAway(nm)) return;
      this.mark({ k: "ref", cmd: nm, key, opt: opt ? this.toks2str(opt) : null });
    });
    // \newcommand (and \newcommand*) on a name that already has a meaning: LaTeX's "already defined" error, and the old
    // meaning stays (the core's own prim reported E-ALREADY-DEFINED but redefined anyway); the arguments are consumed
    const coreNew = core("newcommand");
    P.prim("newcommand", function (t) {
      const s0 = this.skipSpacesRaw(); const star = s0 === mkChar(CAT.OTHER, 42); if (!star && s0 !== null) this.back(s0);
      const cs = this.csArg(); if (cs === null) return;
      if (this.getS("m:" + this.intern.name(cs)) !== undefined) {
        this.d("E-ALREADY-DEFINED"); this.readOptRaw(); this.readOptRaw(); this.readArgRaw(); this.finishAssignment();
        this.mark({ k: "err", code: "already-defined", name: this.intern.name(cs) });
        return;
      }
      this.pushList([mkChar(CAT.BGROUP, 123), cs, mkChar(CAT.EGROUP, 125)]);
      if (star) this.back(mkChar(CAT.OTHER, 42));
      coreNew.call(this, t);
    });
    // SageTeX S1 (plan r4 sections 1-3): \sage{...} and \sageplot[opts][fmt]{...} are primitives here, so a macro that
    // expands to them reaches them in expansion order; each becomes one code-item marker (never executed here: the
    // page's executor runs the ordered items, with consent, in the runner). Code in verbatim, comments or false
    // conditional branches never reaches these.
    P.prim("sage", function () { this.mark(Object.assign({ k: "sage", mode: "sage" }, this.readSageArg())); });
    P.prim("sageplot", function () {
      const o1 = this.readOptRaw(); const o2 = o1 === null ? null : this.readOptRaw();
      const opts = [o1, o2].filter((o) => o !== null).map((o) => this.toks2str(o).trim());
      // (options are kept whole: over 1 KiB is an error, never a silent truncation; astra4 S1E01-A2)
      const tooLong = opts.some((o) => o.length > 1024);
      const a = this.readSageArg();
      this.mark(Object.assign({ k: "sage", mode: "plot", opts: tooLong ? [] : opts }, a, tooLong && !a.err ? { err: "optstoolong", code: undefined } : {}));
    });
    // SageTeX commands this preview doesn't support: their arguments are consumed RAW here, never expanded, so a
    // \sage inside them can't become a hidden item (astra4 S1E01-A3); a chip shows each one
    for (const [nm, nargs] of [["sagestr", 1], ["sagetexpause", 0], ["sagetexunpause", 0], ["sagetexindent", 1]]) P.prim(nm, function () {
      for (let k = 0; k < nargs; k++) this.readArgRaw();
      this.mark({ k: "sageunsup", name: nm });
    });
    void PMARK;
    // sectioning, captions and footnotes: the title/text is expanded as body text between two markers
    for (const [nm, ctr] of [["part", "part"], ["chapter", "chapter"], ["section", "section"], ["subsection", "subsection"], ["subsubsection", "subsubsection"],
      ["paragraph", "paragraph"], ["subparagraph", null], ["caption", null], ["footnote", "footnote"], ["thanks", null]]) {
      P.prim(nm, function () {
        const s = this.skipSpacesRaw(); const star = s === mkChar(CAT.OTHER, 42); if (!star && s !== null) this.back(s);
        this.runaway = null;
        this.readOptRaw(); if (this.ranAway(nm)) return;
        const arg = this.readArgShortRaw(); if (this.ranAway(nm)) return;
        if (ctr && !star && this.counterReg(ctr) >= 0) this.stepCounterRef(ctr);
        this.mark({ k: "sec", cmd: nm, star });
        this.pushList(arg.concat([this.csTok("sb@eot")]));
      });
    }
    P.prim("sb@eot", function () { this.mark({ k: "eot" }); });
    // inline verbatim: the text is kept
    for (const nm of ["verb", "lstinline", "Verb"]) P.prim(nm, function () {
      const f = this.stack[this.stack.length - 1];
      if (!f || f.kind !== "file" || f.line === null) { this.d("E-VERB-IN-ARG"); return; }
      const L = f.line; let star = false;
      if (L[f.li] === "*") { f.li++; star = true; }
      if (nm !== "verb" && L[f.li] === "[") { const e = L.indexOf("]", f.li); f.li = e < 0 ? L.length : e + 1; }
      const d = L[f.li]; const close = d === "{" ? "}" : d;
      const e = L.indexOf(close, f.li + 1);
      if (e < 0) { this.d("E-VERB-UNTERMINATED"); f.li = L.length; return; }
      const text = L.slice(f.li + 1, e);
      this.charge(Math.ceil((e - f.li) / 8)); f.li = e + 1; f.st = 1;
      this.mark({ k: "verb", text, star });
    });
  }
}
