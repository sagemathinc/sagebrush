// Demo layer over the D4 core (the core files in ../core/ are byte-identical to D4 r14; see core/D4R14-SHA256SUMS).
// DemoMachine records, per unit, the OUTPUT EVENTS a renderer needs: every emitted token, plus structural markers the
// core consumes and drops (brace groups, environments, section titles, labels and refs, verbatim text, the document
// class). Markers are plain objects; tokens are the core's integers. Each unit carries its events (unit.ev), so the D4
// incremental layer reuses a converged suffix's events together with its units.
// incremental-demo.mjs is core/incremental.mjs with only its two import lines changed (to this module).
import { isCodeEnv } from "./sagetex.mjs";
import { Machine as CoreMachine, Intern, BoundError, StopError, setCurrentIntern, DEFAULT_LIMITS, CAT, mkChar, isCs, catOf, codeOf, SPACE_TOK, meaning } from "../core/machine.mjs";

export { Intern, BoundError, StopError, setCurrentIntern, DEFAULT_LIMITS, CAT, mkChar, isCs, catOf, codeOf, SPACE_TOK };

// every name counts as "known": an undefined control sequence is EMITTED (the renderer decides how to show it)
// instead of being dropped with E-UNDEF-CS
const ALL_KNOWN = { has: () => true };
const VERBATIM = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*",
  "pycode", "pyblock", "pysub", "pyverbatim", "pyconsole", "sageblock", "sagesilent", "sagecommandline", "sageexample", "sageverbatim", "sympycode", "pylabcode",
  "magmablock", "magmasilent", "matlabblock", "matlabsilent"]);
// (Magma's and MATLAB's names, Sagebrush extensions: a document that defines one itself uses its own, and ours is off
//  for it)
const EXT_CMDS = ["magma", "matlab"], EXT_ENVS = new Set(EXT_CMDS.flatMap((c) => [c + "block", c + "silent"]));
const MAX_VERB = 1 << 20;   // characters kept from one verbatim block
// s03 (William's report: a self-recursive \newcommand hung the page): every machine also stops at a WALL-CLOCK bound
// (checked at the core's own poll points, every pollEvery work units) and at an output-event bound; both stop the
// expansion with a bound error, shown as a banner, instead of running until the page's 15 s watchdog
const TIME_LIMIT_MS = 2500;
const MAX_EVENTS = 3000000;
const PMARK = 16;
const SAGE_MAX_CODE = 65536;   // UTF-8 bytes of one \sage / \sageplot argument (plan r4 section 8: 64 KiB per item)
// source positions, for keeping the source and the preview in sync: each line of the main file that yields a token
// marks its start offset ({k: "pos", at, ep}). ep is the pipeline's run (setPosEpoch): the incremental layer reuses
// events of unchanged units, and the pipeline shifts their offsets past the edit (pipeline.mjs)
// a short argument that ran away (a \par or the end of the input inside it): thrown by the demo readers, caught by
// the innermost primitive's guard (guardRunaway), which drops the command and marks {k:"err", code:"runaway"}
class RunawayArg extends Error { constructor(text) { super("runaway argument"); this.text = text; } }
// which arguments LaTeX's kernel reads \long (they may hold paragraphs; the core's readers serve them), per argument
// in the order the primitive reads them (csArg, readArgString, readArgShortRaw, readOptRaw each take the next; an
// optional argument that isn't there takes its place too); a primitive not here, and any argument past the list, is
// short. (The core's readArgRaw, which reads bodies, is the core's own: long.)
//   \footnote[n]{text}: \@xfootnote[#1] is short, \@footnotetext#1 long
//   \caption[short]{text}: \long\def\@caption#1[#2]#3
//   \thanks{text}: long (its [..], not the kernel's, read as long too)
//   \newcommand{\cs}[n][default]{body}: \new@command#1 and \@newcommand#1[#2] are short, \@xargdef's [#3] long
//   (\newenvironment{name}[n][default]{begin}{end}: name, [n] and [default] short (\@newenvb), so not listed)
const L = true, S = false;
// (secnumdepth and tocdepth by class, as TeX Live 2025's classes set them)
export const depthOf = (cls) => (/^(book|report|scrbook|scrreprt)$/.test(cls) ? 2 : cls === "memoir" ? 1 : 3);
const ARG_MODES = new Map([["footnote", [S, L]], ["caption", [L, L]], ["thanks", [L, L]],
  ...["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"].map((n) => [n, [S, S, L]])]);
function guardRunaway(name, fn) {
  const modes = ARG_MODES.get(name) ?? null;
  return function (t) {
    (this.argFrames ??= []).push({ modes, i: 0, long: false });
    try { return fn.call(this, t); }
    catch (e) { if (!(e instanceof RunawayArg)) throw e; this.mark({ k: "err", code: "runaway", name, text: e.text }); }
    finally { this.argFrames.pop(); }
  };
}
let POS_EPOCH = 0;
export function setPosEpoch(n) { POS_EPOCH = n; }
// PythonTeX (a), plan r3.1: the results pass's (engine/pythontex.mjs) read-back, called on the machine with each item's
// marker and where it was read (and with none for \printpythontex); null in the source pass, which reads nothing back
let PY = null;
export function setPyResults(p) { PY = p; }
// \input, \include (William's L4, Nov 2: they were silently ignored): each name given to the host's resolver
// (setInputResolver: as TeX finds a file, from the .tex's folder, images.ts texCandidates) for a key of the files
// snapshot, or why there is none; read from the snapshot, never fetched here. Each \input marks {k:"inref", name} (the
// host gathers the files to read from them) and, when nothing is read, a visible note {k:"err", code:"input"}: a
// file not found or refused, or nested deeper than INPUT_NEST (a cycle)
let INPUT_RESOLVE = null;
export function setInputResolver(f) { INPUT_RESOLVE = f; }
const INPUT_NEST = 16;

export class Machine extends CoreMachine {
  constructor(opts) {
    super(Object.assign({}, opts, { known: ALL_KNOWN }));
    this.ev = []; this.nev = 0; this.deadline = Date.now() + TIME_LIMIT_MS; this.posFrontier = -1;
    this.installDemoPrimitives();
  }
  emit(t) { if (++this.nev > MAX_EVENTS) throw new BoundError("E-BOUND-OUTPUT", "events"); this.ev.push(t); super.emit(t); }
  mark(o) { if (++this.nev > MAX_EVENTS) throw new BoundError("E-BOUND-OUTPUT", "events"); this.ev.push(o); this.reserve(32); }
  // where an item's command was read (R3.1-1 "at"): each frame's read point, bottom up, the main file's relative to H
  // (so an edit above doesn't move it)
  placeOf() {
    const H = this.srcSeen.get(this.mainPath) ?? -1;
    return this.stack.map((f) => f.kind === "file" ? (f.line === null ? f.pos : f.lineStart + f.li) - (f.path === this.mainPath ? H : 0) : f.i).join();
  }
  // an item's marker: a source-born one gets its id (H, k): H the main file's source high-water mark, k the source items
  // marked since H last rose (kept as state, "sb:ak", so checkpoints carry it); a result-born one (rt: the taint, set
  // only by the results pass, engine/pythontex.mjs) none, tn.
  // (then, in the results pass, its saved result read back, if it has one for this very item)
  item(o, ap) {
    if (this.rt) o.tn = 1;
    else {
      const H = this.srcSeen.get(this.mainPath) ?? -1, k = H === this.akH ? this.getS("sb:ak") ?? 0 : 0;
      this.akH = H; this.setS("sb:ak", k + 1, true);
      o.h = H; o.kk = k; o.ap = ap; o.ep = POS_EPOCH;
    }
    this.mark(o);
    PY?.call(this, o, ap);
  }
  charge(n) { super.charge(n); if (this.sincePoll === 0 && Date.now() > this.deadline) throw new BoundError("E-BOUND-TIME"); }
  beginGroup(kind) { super.beginGroup(kind); if (kind === "brace") this.mark({ k: "o" }); }
  endGroup(kind) { if (kind === "brace") this.mark({ k: "c" }); super.endGroup(kind); }
  finishUnit(nextIndex) {
    super.finishUnit(nextIndex);
    this.units[this.units.length - 1].ev = this.ev;
    this.ev = [];
  }
  // (the marked-line frontier, restored: it is always the start of the line holding the main file's source high-water
  //  mark (the core's srcSeen, restored and shifted with the checkpoint): every counted main token marks its line
  //  unless a line at or after it is marked, so the highest line marked is that of the highest offset counted. Not the
  //  outer reader's place: after the main file read itself, that is behind lines already marked (astra4 POS-A4-1))
  restore(ck, files, delta = 0) {
    super.restore(ck, files, delta); this.ev = []; this.nev = 0; this.deadline = Date.now() + TIME_LIMIT_MS;
    this.akH = this.srcSeen.get(this.mainPath); this.rt = 0; this.dd = 0;
    const seen = this.srcSeen.get(this.mainPath), text = files.get(this.mainPath);
    this.posFrontier = seen === undefined || typeof text !== "string" ? -1 : seen <= 0 ? 0 : text.lastIndexOf("\n", seen - 1) + 1;
  }
  // (the core's count of a source token, then: the first token of a main-file line past the marked frontier marks
  //  that line's offset, once: the frontier only moves forward, so a line read again (a reread of the file, the rest
  //  of a half-read line) is never marked twice)
  countSrc(f, i) {
    super.countSrc(f, i);
    if (f.path !== this.mainPath) return;
    const ls = f.lineStart ?? 0;
    if (ls > this.posFrontier) { this.posFrontier = ls; this.mark({ k: "pos", at: ls, ep: POS_EPOCH }); }
  }
  doInput(name) {
    name = String(name).trim();
    this.mark({ k: "inref", name });
    let r;
    if (INPUT_RESOLVE) r = INPUT_RESOLVE(name);
    else { const k = [this.mainDir + name + ".tex", this.mainDir + name].find((c) => this.files.has(c)); r = k ? { key: k } : { why: "not found" }; }
    const miss = (why) => this.mark({ k: "err", code: "input", name, text: why });
    if (!r || !r.key) return miss(r?.why || "not found");
    if (!this.files.has(r.key)) return miss(r.why || "not read yet");
    const open = this.stack.filter((f) => f.kind === "file");
    // (a file may \input itself, guarded by a conditional, as TeX allows; one that never stops is a cycle, stopped here)
    if (open.length > INPUT_NEST) return miss(open.some((f) => f.path === r.key) ? "an \\input cycle: stopped " + INPUT_NEST + " deep" : "nested more than " + INPUT_NEST + " deep");
    this.openFile(r.key);
  }
  // push "{s}" back as an argument, for a core primitive that reads it again
  pushArg(s) {
    const toks = [mkChar(CAT.BGROUP, 123)].concat(this.str2toks(s), [mkChar(CAT.EGROUP, 125)]);
    this.pushList(toks);
  }

  // ---- half-typed arguments (William, Oct 29: "\begin{" typed in the middle of a document blanked everything after
  // it). Inside a primitive that LaTeX's kernel defines without \long (\begin, \end, \label, \ref, \cite, the counter
  // and package commands, section titles, ...), a \par (a blank line) or the end of the input inside a name, an
  // argument or an optional [...] is TeX's "Runaway argument? ... Paragraph ended before \x was complete": the
  // reader puts the \par back and throws RunawayArg; every primitive is wrapped (prim/xprim below), and the innermost
  // one drops the whole command before any effect (as TeX drops the call), with a "not finished" note, and the rest of
  // the document goes on from the \par. For a \long argument (ARG_MODES, per argument: a caption's or footnote's
  // text, \thanks, a \newcommand default or body), in a \newcommand macro's call, and outside any primitive, the
  // core's own readers run, which read on to the closing brace or bracket.
  prim(name, fn) { super.prim(name, guardRunaway(name, fn)); }
  xprim(name, fn, cond = false) { super.xprim(name, guardRunaway(name, fn), cond); }
  // (a \newcommand macro's optional argument is \long in the kernel, even read inside a short primitive's expansion)
  callLMacro(cs, m) { (this.argFrames ??= []).push({ modes: null, i: 0, long: true }); try { return super.callLMacro(cs, m); } finally { this.argFrames.pop(); } }
  // (the mode of the argument about to be read, taken once per read: long outside any primitive or in a macro call)
  nextLong() {
    const s = this.argFrames; if (!s || s.length === 0) return true;
    const f = s[s.length - 1]; if (f.long) return true;
    return f.modes ? (f.modes[f.i++] ?? false) : false;
  }
  readShortGroup(open) {    // after "{": to the matching "}"; a \par or the end of the input throws RunawayArg
    const out = []; let depth = 1;
    for (;;) {
      const t = this.nextRaw();
      if (t === null) { this.d("E-RUNAWAY"); throw new RunawayArg(open + this.toks2str(out)); }
      if (isCs(t) && this.intern.name(t) === "par") { this.d("E-RUNAWAY-PAR"); this.back(t); throw new RunawayArg(open + this.toks2str(out)); }
      if (!isCs(t)) { const c = catOf(t); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP && --depth === 0) return out; }
      out.push(t); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }
  readArgShortRaw() { return this.nextLong() ? this.readArgRaw() : this.shortArg(); }
  readArgString() { return this.nextLong() ? super.readArgString() : this.toks2str(this.shortArg()).trim(); }
  csArg() {                 // \x or {\x}: the braces read short for a short argument (\newcommand{\x then a blank line)
    if (this.nextLong()) return super.csArg();
    let t = this.skipSpacesRaw();
    if (t !== null && !isCs(t) && catOf(t) === CAT.BGROUP) { const g = this.readShortGroup("{"); t = g.find(isCs) ?? null; }
    if (t === null || !isCs(t)) { this.d("E-MISSING-CS"); return null; }
    return t;
  }
  shortArg() {              // an undelimited argument, short: a brace group by readShortGroup
    const t = this.skipSpacesRaw();
    if (t === null) return [];
    if (!isCs(t) && catOf(t) === CAT.BGROUP) return this.readShortGroup("{");
    return [t];
  }
  readOptRaw() {            // [ ... ] if present (else null): short for a short argument, else the core's
    if (this.nextLong()) return super.readOptRaw();
    const t = this.skipSpacesRaw();
    if (t === null) return null;
    if (t !== mkChar(CAT.OTHER, 91)) { this.back(t); return null; }
    const out = []; let depth = 0;
    for (;;) {
      const u = this.nextRaw();
      if (u === null) { this.d("E-RUNAWAY"); throw new RunawayArg("[" + this.toks2str(out)); }
      if (isCs(u) && this.intern.name(u) === "par") { this.d("E-RUNAWAY-PAR"); this.back(u); throw new RunawayArg("[" + this.toks2str(out)); }
      if (!isCs(u)) { const c = catOf(u); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP) depth--; }
      if (depth === 0 && u === mkChar(CAT.OTHER, 93)) return out;
      out.push(u); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }

  // verbatim text: the core skips it; here it is captured (bounded) first, then the core's own skip runs
  // (the demo's own skip: like the core's, but "\end{env}" may have spaces or a line break before its brace, as
  //  LaTeX.js's showcase writes it; the text in between is captured, bounded)
  skipVerbatim(env, ap = "") {
    const f = this.stack[this.stack.length - 1];
    // (a code environment's text is an item, in expansion order: render.mjs numbers them the same)
    const put = (o) => (isCodeEnv(env) ? this.item(o, ap) : this.mark(o));
    if (!f || f.kind !== "file") { this.d("E-VERBATIM-IN-ARG"); put({ k: "verbenv", env, text: "", inarg: true }); return; }
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
    put(o);
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
      const ap = this.placeOf(), env = this.readArgString();
      // verbatim: exactly the core's branch (its reader must be the file on top of the stack, not a pushed list)
      if (isVerb(env) && !(EXT_ENVS.has(env) && this.getS("m:" + env) !== undefined)) { this.charge(env.length); this.skipVerbatim(env, ap); return; }
      if (env === "document") {
        this.mark({ k: "doc" }); this.shortVerbAtBegin(this.getS("sb:cls"));
        // (Magma's and MATLAB's names the document took over: said once each, by check and the editor)
        for (const c of EXT_CMDS) if (this.getS("m:" + c) !== ours[c]) this.mark({ k: "own", name: c });
        for (const e of EXT_ENVS) if (this.getS("m:" + e) !== undefined) this.mark({ k: "own", name: e });
      }
      else this.mark({ k: "be", env, user: this.getS("m:" + env) !== undefined });
      this.pushArg(env);
      coreBegin.call(this, t);
      if (env === "document") { this.setS("sb:indoc", 1, true); const h = this.getS("m:sb@bdhook"); if (h) this.pushList(h.body); }
    });
    // \AtBeginDocument: its tokens kept, globally, in \sb@bdhook (LaTeX's \@begindocumenthook) and read at \begin{document}
    // (as doc's \AtBeginDocument{\MakeShortVerb{\|}}: run at once, "|" was \verb in the preamble that follows, #622);
    // in the document, read at once. The hook is one token list: bounded as one (limits.tokenList), its copy charged and
    // reserved before it replaces the one before, which a refusal leaves as it was (astra, #631 LATEX631-HOOK-1): so its
    // memory is checked first, setS's own 64 bytes included
    P.prim("AtBeginDocument", function () {
      const a = this.readArgRaw();
      if (this.getS("sb:indoc")) { this.pushList(a); return; }
      const h = this.getS("m:sb@bdhook"), old = h ? h.body : [], n = old.length + a.length;
      if (n > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
      if (this.memBytes + n * 4 + 128 > this.limits.memBytes) throw new BoundError("E-BOUND-MEMORY");
      this.charge(n); this.reserve(n * 4 + 64);
      this.defineMacro("sb@bdhook", meaning("macro", { pre: [], delims: [], body: old.concat(a), long: true, prot: false }), true);
    });
    P.prim("end", function (t) {
      const env = this.readArgString();
      if (env !== "document" && this.getS("m:end" + env) === undefined) this.mark({ k: "ee", env });
      this.pushArg(env);
      coreEnd.call(this, t);
    });
    // a user environment's end: the end macro's output comes first, then the marker
    P.prim("sb@endgroup", function () { const g = this.groups[this.groups.length - 1]; this.mark({ k: "ee", env: g ? g.env : "?" }); this.endGroup("env"); });
    // the document class (the core reads and drops it)
    P.prim("documentclass", function (t) {
      const opt = this.readOptRaw(); const cls = this.readArgString();
      this.mark({ k: "cls", cls, opt: opt ? this.toks2str(opt) : "" }); this.setS("sb:cls", cls, true);
      // (the class's secnumdepth and tocdepth, as TeX Live's classes set them: book, report and KOMA's two 2, memoir 1, the
      //  rest (article) 3; so an \addtocounter on them starts from the class's value)
      { const d = depthOf(cls); for (const c of ["secnumdepth", "tocdepth"]) { const r = this.counterReg(c); if (r >= 0) this.regSet(r, d, true); } }
      this.pushArg(cls);
      coreClass.call(this, t);
    });
    // labels and references: the key is kept as a marker
    P.prim("label", function (t) {
      const key = this.readArgString();
      this.mark({ k: "label", key });
      this.pushArg(key);
      coreLabel.call(this, t);
    });
    for (const nm of ["ref", "eqref", "pageref", "cite", "cref", "Cref", "autoref", "citep", "citet", "nameref"]) P.prim(nm, function () {
      const opt = this.readOptRaw(); const key = this.readArgString();
      this.mark({ k: "ref", cmd: nm, key, opt: opt ? this.toks2str(opt) : null });
    });
    // \newcommand (and \newcommand*) on a name that already has a meaning: LaTeX's "already defined" error, and the old
    // meaning stays (the core's own prim reported E-ALREADY-DEFINED but redefined anyway); the arguments are consumed
    const coreNew = core("newcommand");
    P.prim("newcommand", function (t) {
      const s0 = this.skipSpacesRaw(); const star = s0 === mkChar(CAT.OTHER, 42); if (!star && s0 !== null) this.back(s0);
      const cs = this.csArg(); if (cs === null) return;
      // (\magma and \matlab, ours, give way to the document's: Sagebrush extensions, not a package's commands)
      const nm = this.intern.name(cs);
      if (this.getS("m:" + nm) !== undefined && !(nm in ours && this.getS("m:" + nm) === ours[nm])) {
        this.d("E-ALREADY-DEFINED"); this.readOptRaw(); this.readOptRaw(); this.readArgRaw(); this.finishAssignment();
        this.mark({ k: "err", code: "already-defined", name: nm });
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
    P.prim("sage", function () { const ap = this.placeOf(); this.item(Object.assign({ k: "sage", mode: "sage" }, this.readSageArg()), ap); });
    // PythonTeX (a): \py{expr}, an item; its saved result (str of the value) read back here as TeX, and
    // \printpythontex, what the last pyblock passed printed, by the results pass (plan r3.1)
    P.prim("py", function () { const ap = this.placeOf(); this.item(Object.assign({ k: "sage", mode: "py" }, this.readSageArg()), ap); });
    P.prim("printpythontex", function () { PY?.call(this); });
    // Magma and MATLAB (Sagebrush extensions, William Nov 10): \magma{expr} and \matlab{expr}, items (their language
    // prints them); their block and silent environments are code environments (VERBATIM)
    const ours = {};
    for (const c of EXT_CMDS) { P.prim(c, function () { const ap = this.placeOf(); this.item(Object.assign({ k: "sage", mode: c }, this.readSageArg()), ap); }); ours[c] = this.getS("m:" + c); }
    P.prim("sageplot", function () {
      const ap = this.placeOf(), o1 = this.readOptRaw(); const o2 = o1 === null ? null : this.readOptRaw();
      const opts = [o1, o2].filter((o) => o !== null).map((o) => this.toks2str(o).trim());
      // (options are kept whole: over 1 KiB is an error, never a silent truncation; astra4 S1E01-A2)
      const tooLong = opts.some((o) => o.length > 1024);
      const a = this.readSageArg();
      this.item(Object.assign({ k: "sage", mode: "plot", opts: tooLong ? [] : opts }, a, tooLong && !a.err ? { err: "optstoolong", code: undefined } : {}), ap);
    });
    // SageTeX commands this preview doesn't support: their arguments are consumed RAW here, never expanded, so a
    // \sage inside them can't become a hidden item (astra4 S1E01-A3); a chip shows each one
    for (const [nm, nargs] of [["sagestr", 1], ["sagetexpause", 0], ["sagetexunpause", 0], ["sagetexindent", 1],
      // (PythonTeX's inline commands: the same "not run" chip; its code environments are shown as code)
      ["pyc", 1], ["pys", 1], ["pyb", 1]]) P.prim(nm, function () {
      for (let k = 0; k < nargs; k++) this.readArgRaw();
      this.mark({ k: "sageunsup", name: nm });
    });
    void PMARK;
    // sectioning, captions and footnotes: the title/text is expanded as body text between two markers
    for (const [nm, ctr] of [["part", "part"], ["chapter", "chapter"], ["section", "section"], ["subsection", "subsection"], ["subsubsection", "subsubsection"],
      ["paragraph", "paragraph"], ["subparagraph", null], ["caption", null], ["footnote", "footnote"], ["thanks", null]]) {
      P.prim(nm, function () {
        const s = this.skipSpacesRaw(); const star = s === mkChar(CAT.OTHER, 42); if (!star && s !== null) this.back(s);
        const o = this.readOptRaw(), arg = this.readArgShortRaw();
        if (ctr && !star && this.counterReg(ctr) >= 0) this.stepCounterRef(ctr);
        // (the short form, \section[short]{..}, as written: beamer's headlines show it)
        this.mark({ k: "sec", cmd: nm, star, short: o ? this.toks2str(o) : null });
        this.pushList(arg.concat([this.csTok("sb@eot")]));
      });
    }
    P.prim("sb@eot", function () { this.mark({ k: "eot" }); });
    // \setcounter and \addtocounter: the core's, and the counter's new value marked for the renderer, whose own numbering
    // (sections, figures, tables, equations, footnotes, enumerate's items) follows it (astra4's fidelity digest, gap 1)
    for (const nm of ["setcounter", "addtocounter"]) {
      const f = core(nm);
      P.prim(nm, function (t) {
        const name = this.readArgString(); this.pushArg(name); f.call(this, t);
        const r = this.counterReg(name); if (r >= 0) this.mark({ k: "ctr", name, v: this.regGet(r) });
      });
    }
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
    // short verbatim (#622: amsldoc's |\begin{aligned}| opened an environment that took the rest of the document): a
    // character made active as \verb with itself as the delimiter, by \MakeShortVerb (doc, shortvrb; its * read and shown as \verb, as the preview shows \verb*),
    // \DefineShortVerb (fancyvrb), or the class at \begin{document} (SHORTVERB_CLASSES), undone by \DeleteShortVerb and
    // \UndefineShortVerb. Global, as doc's are; "sv:<code>" is 1 while it is, kept with the catcode before ("svcat:<code>", stale once deleted: the next \MakeShortVerb sets it)
    // and the active character's meaning before (\sb@sv@<char>), both from the first \MakeShortVerb (a second mustn't
    // keep the short verb as the one to restore), and in "svchars" (for \index below; kept after \DeleteShortVerb, harmless there)
    const shortVerb = (m, cp) => {
      const ch = String.fromCodePoint(cp);
      if (m.getS("sv:" + cp) === undefined) {
        m.setS("svcat:" + cp, m.cat(cp), true); m.letTo(m.csTok("sb@sv@" + ch), m.csTok("\u0001" + ch), true);
        m.setS("svchars", (m.getS("svchars") ?? "") + ch, true);
      }
      m.setS("sv:" + cp, 1, true); m.setS("cat:" + cp, CAT.ACTIVE, true);
      m.letTo(m.csTok("\u0001" + ch), m.csTok("sb@shortverb"), true);
    };
    const shortVerbArg = (m) => {       // {\|} or \|: the character's code, or null
      const cs = m.csArg(); if (cs === null) return null;
      const ch = m.intern.name(cs);
      if ([...ch].length !== 1) { m.d("E-SHORTVERB-ARG"); return null; }
      return ch.codePointAt(0);
    };
    for (const nm of ["MakeShortVerb", "DefineShortVerb"]) P.prim(nm, function () {
      if (nm === "MakeShortVerb") { const s = this.skipSpacesRaw(); if (s !== null && s !== mkChar(CAT.OTHER, 42)) this.back(s); }
      else this.readOptRaw();
      const cp = shortVerbArg(this); if (cp !== null) shortVerb(this, cp);
    });
    for (const nm of ["DeleteShortVerb", "UndefineShortVerb"]) P.prim(nm, function () {
      const cp = shortVerbArg(this); if (cp === null || this.getS("sv:" + cp) === undefined) return;
      this.setS("cat:" + cp, this.getS("svcat:" + cp), true); this.setS("sv:" + cp, undefined, true);
      const ch = String.fromCodePoint(cp); this.letTo(this.csTok("\u0001" + ch), this.csTok("sb@sv@" + ch), true);
    });
    const verb = core("verb");
    P.prim("sb@shortverb", function (t) {
      const f = this.stack[this.stack.length - 1];
      // (in the source: \verb, with the reader put back on this character, its delimiter; in an argument, already
      //  tokens: to the same active character, stopping at a blank line, as \verb's text can't span one, or at the
      //  list's end: no bound of its own, as a list is at most limits.tokenList long)
      if (f && f.kind === "file" && f.line !== null) { f.li -= this.intern.name(t).length - 1; return verb.call(this); }
      const out = [];
      for (;;) {
        const u = this.nextRaw();
        if (u === null || u === t) break;
        if (isCs(u) && this.intern.name(u) === "par") { this.back(u); break; }
        out.push(u); this.charge(1);
      }
      this.mark({ k: "verb", text: this.toks2str(out) });
    });
    // \index and \glossary read their argument with the short verbatim characters as other characters, as LaTeX's
    // \@sanitize does (makeindex's "|" in \index{x|(}, amsldoc's first index entry, was a \verb to the end of the line
    // that took the closing brace); then the command and its argument go on as before (render.mjs GOBBLE drops them)
    for (const nm of ["index", "glossary"]) P.prim(nm, function (t) {
      const cps = [...(this.getS("svchars") ?? "")].map((c) => c.codePointAt(0));
      const saved = cps.map((cp) => this.cat(cp)); for (const cp of cps) this.setS("cat:" + cp, CAT.OTHER, true);
      let arg; try { arg = this.readArgRaw(); } finally { cps.forEach((cp, k) => this.setS("cat:" + cp, saved[k], true)); }
      this.emit(t); this.pushList([mkChar(CAT.BGROUP, 123), ...arg, mkChar(CAT.EGROUP, 125)]);
    });
    // (the classes that make "|" (and l3doc also '"') short verbatim at \begin{document})
    P.shortVerbAtBegin = (cls) => { for (const ch of SHORTVERB_CLASSES.get(cls) ?? "") shortVerb(this, ch.codePointAt(0)); };
  }
}
const SHORTVERB_CLASSES = new Map([["amsldoc", "|"], ["ltxdoc", "|"], ["l3doc", '"|']]);
