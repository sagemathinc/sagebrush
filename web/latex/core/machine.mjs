// D4 core spike: catcode tokenizer + TeX-style expander subset + bounds + checkpoints.
// Implements the core paths named in D3 r4 §7.1/§15 for MEASUREMENT only (not product code):
//   tokenizer (catcodes, states N/M/S, ^^, \endlinechar, comments), macros with TeX
//   parameter text, \def/\edef/\gdef/\xdef/\let/\futurelet, \expandafter/\noexpand/
//   \csname/\string/\number/\romannumeral/\the, conditionals, count registers, groups with a
//   save stack and \global, \aftergroup/\afterassignment, a few e-TeX primitives, native
//   LaTeX-kernel commands (\newcommand family, environments, counters, labels, sectioning),
//   quiescent checkpoints (§7.2), per-unit read sets of counter-class state keys (§7.3),
//   the work/memory/depth bounds (§8), and Stop polling via a shared flag (§8.3).
// Typesetting is NOT modelled: unexpandable tokens go to an output digest ("stomach").
import { PMap, strHash, valueHash } from "./pmap.mjs";

// ---------------------------------------------------------------- tokens
// char token: (cat << 21) | code   (cat 0..15, code < 2^21)
// param marker inside stored bodies: (16 << 21) | n
// control sequence: -(id + 1), id into the intern table
export const CAT = { ESC: 0, BGROUP: 1, EGROUP: 2, MATH: 3, ALIGN: 4, EOL: 5, PARAM: 6, SUP: 7, SUB: 8, IGN: 9, SPACE: 10, LETTER: 11, OTHER: 12, ACTIVE: 13, COMMENT: 14, INVALID: 15 };
const PMARK = 16;
const mkChar = (cat, code) => (cat << 21) | code;
const catOf = (t) => t >>> 21;
const codeOf = (t) => t & 0x1fffff;
const isCs = (t) => t < 0;
const SPACE_TOK = mkChar(CAT.SPACE, 32);

export class Intern {
  constructor() { this.names = []; this.ids = new Map(); this.bytes = 0; }
  id(name) {
    let i = this.ids.get(name);
    if (i === undefined) { i = this.names.length; this.names.push(name); this.ids.set(name, i); this.bytes += name.length * 2 + 48; }
    return i;
  }
  tok(name) { return -(this.id(name) + 1); }
  name(t) { return this.names[-t - 1]; }
}

// ---------------------------------------------------------------- errors / bounds
export class BoundError extends Error { constructor(code, detail) { super(code + (detail ? ": " + detail : "")); this.code = code; this.detail = detail; } }
export class StopError extends Error { constructor() { super("STOPPED"); this.code = "STOPPED"; } }

export const DEFAULT_LIMITS = {
  // §8.1: document budget max(B0, k * T) and unit budget max(B1, k * T_u), where T and T_u
  // are the source tokens read so far (each token of the file text counted once per read).
  B0: Infinity, B1: Infinity, k: Infinity, ku: Infinity,   // k per admitted byte (document); ku per distinct source token (unit)
  safetyWork: 2e9,            // absolute cap for calibration runs (reported as E-BOUND-SAFETY)
  tokenList: 1 << 22,         // one body/argument/edef result
  depth: 10000,               // input stack depth
  groups: 255,
  conds: 10000,
  csCount: 1_000_000,
  csBytes: 64 * 2 ** 20,
  inputDepth: 64,
  inputFiles: 2000,
  memBytes: Infinity,         // the spike's counter is ALLOCATION VOLUME (never decremented), so it is reported, not
                              // enforced; live memory is measured from the heap. A live-byte budget is a PR 2 item.
  pollEvery: 4096,            // work units between Stop polls (W)
};

// ---------------------------------------------------------------- meanings
let vhSeq = 1;
// The intern of the machine currently creating meanings: token hashes use control-sequence NAMES, so
// meaning hashes (and the A/C state hashes) do not depend on intern-id assignment (astra4 D4 r1 R3).
let CUR_INTERN = null;
export function setCurrentIntern(i) { CUR_INTERN = i; }
const canonTok = (t) => (t >= 0 ? t : (strHash(CUR_INTERN.name(t)) ^ 0x6b43a9b5) | 0x40000000);
function tokHash(arr, seed = 0x811c9dc5) { let h = seed ^ arr.length; for (let i = 0; i < arr.length; i++) { h ^= canonTok(arr[i]); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function delimsHash(ds) {    // boundaries matter: [[a],[b]] and [[a,b],[]] must differ
  let h = 0x9e3779b9 ^ ds.length;
  for (const d of ds) { h = Math.imul(h ^ (d.length + 0x2545f491), 0x85ebca6b) >>> 0; h = tokHash(d, h); }
  return h >>> 0;
}
function meaning(type, extra) { const m = Object.assign({ type }, extra); m.vh = computeVh(m); return Object.freeze(m); }
function computeVh(m) {
  switch (m.type) {
    case "macro": { let h = tokHash(m.pre, 0x1b873593); h = Math.imul(h ^ delimsHash(m.delims), 0xcc9e2d51) >>> 0; h = tokHash(m.body, h); return (h ^ (m.long ? 0x1000 : 0) ^ (m.prot ? 0x2000 : 0)) >>> 0; }
    case "lmacro": { let h = tokHash(m.body, 0x27d4eb2f ^ m.n); h = Math.imul(h ^ (m.dflt ? tokHash(m.dflt, 0x165667b1) : 0x5bd1e995), 0x85ebca6b) >>> 0; return (h ^ (m.prot ? 0x2000 : 0)) >>> 0; }
    case "char": return Math.imul(canonTok(m.tok) ^ 0x3c6ef372, 2654435761) >>> 0;
    case "count": case "chardef": case "toksdef": return strHash(m.type + ":" + m.n);
    case "prim": case "xprim": return strHash(m.type + ":" + m.name);
    case "data": return strHash(m.type + ":" + JSON.stringify(m.data, (k, v) => (typeof v === "number" && v < 0 && CUR_INTERN ? "\\" + CUR_INTERN.name(v) : v)));
    default: return vhSeq++;
  }
}

const COUNTER_CLASS = /^(c@|the|p@|cl@)/;
const MKEY_CLASS = new Map();
const FORMAT_PRIMS = new Set(["arabic", "roman", "Roman", "alph", "Alph", "fnsymbol", "value"]);

// default catcodes (plain TeX / LaTeX initial)
function defaultCat(code) {
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return CAT.LETTER;
  switch (code) {
    case 92: return CAT.ESC; case 123: return CAT.BGROUP; case 125: return CAT.EGROUP; case 36: return CAT.MATH;
    case 38: return CAT.ALIGN; case 13: return CAT.EOL; case 35: return CAT.PARAM; case 94: return CAT.SUP;
    case 95: return CAT.SUB; case 0: return CAT.IGN; case 32: return CAT.SPACE; case 9: return CAT.SPACE;
    case 126: return CAT.ACTIVE; case 37: return CAT.COMMENT; case 127: return CAT.INVALID;
    default: return code >= 128 ? CAT.LETTER : CAT.OTHER;   // UTF-8 text treated as letters (LaTeX's inputenc effect, approximated)
  }
}

// ---------------------------------------------------------------- the machine
export class Machine {
  constructor(opts) {
    this.files = opts.files;                 // Map path -> string (admitted snapshot)
    this.mainPath = opts.main;
    this.mainDir = opts.main.includes("/") ? opts.main.slice(0, opts.main.lastIndexOf("/") + 1) : "";
    this.known = opts.known || new Set();    // catalog names treated as unexpandable "stomach" commands
    this.limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
    // the document budget's denominator is FIXED before the run: the admitted source size in bytes
    // (all files of the snapshot). Re-reading files can never replenish it (daybreak2 D4 r1).
    // unit: UTF-8 bytes of the admitted decoded texts (astra4 D4 r2 R5: not UTF-16 code units)
    let adm = 0; for (const v of opts.files.values()) adm += Buffer.byteLength(v, "utf8"); this.admittedBytes = adm;
    this.stopFlag = opts.stopFlag || null;   // Int32Array over a SharedArrayBuffer: [0]=stop, [1]=heartbeat
    this.intern = opts.intern || new Intern();
    setCurrentIntern(this.intern);
    this.A = PMap.empty(); this.C = PMap.empty();
    this.stack = []; this.conds = []; this.groups = [];
    this.work = 0; this.unitWork = 0; this.sincePoll = 0;
    this.srcTokens = 0; this.unitSrc = 0; this.filesRead = 0; this.srcSeen = new Map();
    this.diag = new Map(); this.undef = new Map();
    this.out = { n: 0, h1: 0x811c9dc5, h2: 0x01000193 };
    this.unitOut = { n: 0, h1: 0x811c9dc5, h2: 0x01000193 };
    this.readSet = new Set(); this.writeSet = new Set();
    this.prefix = 0;            // 1 global, 2 long, 4 protected, 8 outer
    this.afterAssign = null;
    this.noexpandNext = false;
    this.edefDepth = 0;
    this.inBody = false; this.docLevel = -1;
    this.checkpoints = []; this.units = [];
    this.tokensSinceCkpt = 0;
    this.Tmin = opts.Tmin || 2000;
    this.ckptRegex = /^[ \t]*\\(part|chapter|section)\b/;
    this.memBytes = 0;
    this.pendingCkpt = opts.onCheckpoint || null;
    this.stopAt = opts.stopAt || null;      // {offset} in main file: stop (for incremental resume compare)
    this.installPrimitives();
  }

  // ---------------- diagnostics and charging
  d(code, n = 1) { this.diag.set(code, (this.diag.get(code) || 0) + n); }
  charge(n) {
    this.work += n; this.unitWork += n; this.sincePoll += n;
    const L = this.limits;
    if (this.work > L.safetyWork) throw new BoundError("E-BOUND-SAFETY");
    // document: max(B0, k * admitted bytes) (fixed); unit: max(B1, k * distinct source tokens first read in the unit)
    const kd = L.k === Infinity ? Infinity : L.k * this.admittedBytes, ku = L.ku === Infinity ? Infinity : L.ku * this.unitSrc;   // avoid Infinity*0 = NaN
    if (this.work > Math.max(L.B0, kd)) throw new BoundError("E-BOUND-WORK", "document");
    if (this.unitWork > Math.max(L.B1, ku)) throw new BoundError("E-BOUND-WORK", "unit");
    if (this.sincePoll >= this.limits.pollEvery) {
      this.sincePoll = 0;
      if (this.stopFlag) { Atomics.add(this.stopFlag, 1, 1); if (Atomics.load(this.stopFlag, 0) !== 0) throw new StopError(); }
    }
  }
  reserve(bytes) { this.memBytes += bytes; if (this.memBytes > this.limits.memBytes) throw new BoundError("E-BOUND-MEMORY"); }
  emit(t0) {
    const t = t0 >= 0 ? t0 : canonTok(t0);       // intern-independent
    const o = this.out, u = this.unitOut;
    o.n++; o.h1 = Math.imul(o.h1 ^ t, 0x01000193) >>> 0; o.h2 = Math.imul(o.h2 + t, 0x5bd1e995) >>> 0;
    u.n++; u.h1 = Math.imul(u.h1 ^ t, 0x01000193) >>> 0; u.h2 = Math.imul(u.h2 + t, 0x5bd1e995) >>> 0;
  }
  outDigest() { return this.out.h1.toString(16) + this.out.h2.toString(16) + ":" + this.out.n; }

  // ---------------- state access (A = ordinary state, C = counter-class keys, §7.3)
  isCounterKey(k) {
    if (k.charCodeAt(0) === 109 /* m */ && k.charCodeAt(1) === 58) {   // "m:" keys: classification is static, cache it
      let c = MKEY_CLASS.get(k);
      if (c === undefined) { const n = k.slice(2); c = COUNTER_CLASS.test(n) || FORMAT_PRIMS.has(n); MKEY_CLASS.set(k, c); }
      return c;
    }
    if (k.startsWith("r:")) return this.A.get("ccreg:" + k.slice(2)) !== undefined;
    return k.startsWith("cl:");
  }
  getS(k) {
    if (this.isCounterKey(k)) { this.readSet.add(k); return this.C.get(k); }
    return this.A.get(k);
  }
  setS(k, v, global) {
    const inC = this.isCounterKey(k);
    const map = inC ? this.C : this.A;
    const old = map.get(k);
    if (this.groups.length) {
      if (global || this.prefix & 1) { for (const g of this.groups) g.saved.delete(k); }
      else { const g = this.groups[this.groups.length - 1]; if (!g.saved.has(k)) g.saved.set(k, { inC, old }); }
    }
    const nm = v === undefined ? map.delete(k) : map.set(k, v);
    if (inC) { this.C = nm; this.writeSet.add(k); } else this.A = nm;
    if (this.A.size + this.C.size > this.limits.csCount) throw new BoundError("E-BOUND-CS", "state entries");
    this.reserve(64);
  }
  mean(t) {
    if (isCs(t)) return this.getS("m:" + this.intern.name(t));
    return undefined;
  }
  cat(code) {                  // cached per state version of A (A changes on every assignment)
    if (this._catOwner !== this.A) { this._catOwner = this.A; this._catCache = new Map(); }
    let v = this._catCache.get(code);
    if (v === undefined) { v = this.A.get("cat:" + code); if (v === undefined) v = defaultCat(code); this._catCache.set(code, v); }
    return v;
  }
  intPar(name, dflt) { const v = this.A.get("ip:" + name); return v === undefined ? dflt : v; }

  // ---------------- tokenizer (TeX's get_next for file readers)
  openFile(path) {
    const text = this.files.get(path);
    if (text === undefined) return false;
    if (this.stack.filter((f) => f.kind === "file").length >= this.limits.inputDepth) throw new BoundError("E-BOUND-INPUT", "depth");
    if (++this.filesRead > this.limits.inputFiles) throw new BoundError("E-BOUND-INPUT", "files");
    this.stack.push({ kind: "file", path, text, pos: 0, line: null, li: 0, st: 0, endinput: false });
    return true;
  }
  loadLine(f) {
    if (f.pos >= f.text.length || f.endinput) return false;
    let e = f.text.indexOf("\n", f.pos); if (e < 0) e = f.text.length;
    let line = f.text.slice(f.pos, e);
    f.lineStart = f.pos;
    f.pos = e + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.replace(/ +$/, "");
    const elc = this.intPar("endlinechar", 13);
    if (elc >= 0 && elc < 256) line += String.fromCharCode(elc);
    f.line = line; f.li = 0; f.st = 0;   // state N
    return true;
  }
  atLineStart(f) { return f.line === null || f.li >= f.line.length; }
  readTok(f) {
    for (;;) {
      if (f.line === null || f.li >= f.line.length) { if (!this.loadLine(f)) return null; }
      const L = f.line;
      const tstart = f.li;
      let c = L.codePointAt(f.li), clen = c > 0xffff ? 2 : 1;
      let cat = this.cat(c);
      if (cat === CAT.SUP && L.codePointAt(f.li + 1) === c && f.li + 2 < L.length) {   // ^^ notation
        const h = L.slice(f.li + 2, f.li + 4);
        if (/^[0-9a-f]{2}$/.test(h)) { c = parseInt(h, 16); clen = 4; }
        else { const x = L.charCodeAt(f.li + 2); c = x < 64 ? x + 64 : x - 64; clen = 3; }
        cat = this.cat(c);
      }
      switch (cat) {
        case CAT.ESC: {
          let j = f.li + clen;
          if (j >= L.length) { f.li = j; this.charge(1); this.countSrc(f, tstart); return this.intern.tok(""); }
          const c2 = L.codePointAt(j);
          if (this.cat(c2) === CAT.LETTER) {
            let k = j; while (k < L.length && this.cat(L.codePointAt(k)) === CAT.LETTER) k += L.codePointAt(k) > 0xffff ? 2 : 1;
            const name = L.slice(j, k); f.li = k; f.st = 2;    // state S
            this.charge(1); this.countSrc(f, tstart); return this.csTok(name);
          }
          const w = c2 > 0xffff ? 2 : 1;
          f.li = j + w; f.st = this.cat(c2) === CAT.SPACE ? 2 : 1;
          this.charge(1); this.countSrc(f, tstart); return this.csTok(String.fromCodePoint(c2));
        }
        case CAT.EOL: {
          const st = f.st; f.li = L.length;
          if (st === 0) { this.charge(1); this.countSrc(f, tstart); return this.csTok("par"); }
          if (st === 1) { this.charge(1); this.countSrc(f, tstart); return SPACE_TOK; }
          continue;
        }
        case CAT.IGN: f.li += clen; continue;
        case CAT.SPACE: f.li += clen; if (f.st === 1) { f.st = 2; this.charge(1); this.countSrc(f, tstart); return SPACE_TOK; } continue;
        case CAT.COMMENT: f.li = L.length; f.st = 2; f.line = null; continue;  // the endline char is discarded too
        case CAT.INVALID: f.li += clen; this.d("E-INVALID-CHAR"); continue;
        case CAT.ACTIVE: f.li += clen; f.st = 1; this.charge(1); this.countSrc(f, tstart); return this.csTok("\u0001" + String.fromCodePoint(c));
        default: f.li += clen; f.st = 1; this.charge(1); this.countSrc(f, tstart); return mkChar(cat, c);
      }
    }
  }
  // count a source token only the FIRST time its file offset is read (re-reading an \input file or a
  // replayed prefix adds nothing): T = distinct source tokens, independent of repeated execution
  countSrc(f, i) {
    if (f.path === "<native>") return;
    const off = (f.lineStart ?? 0) + i;
    const m = this.srcSeen.get(f.path);
    if (m === undefined || off > m) { this.srcSeen.set(f.path, off); this.srcTokens++; this.unitSrc++; }
  }
  csTok(name) {
    if (name.length > 1 << 20) throw new BoundError("E-BOUND-CS", "name length");
    return this.intern.tok(name);
  }

  // ---------------- input stack
  pushList(toks, kind = "list", extra) {
    // TeX pops exhausted token lists before pushing (keeps tail recursion flat)
    while (this.stack.length) { const top = this.stack[this.stack.length - 1]; if (top.kind !== "file" && top.i >= top.toks.length) this.stack.pop(); else break; }
    if (this.stack.length >= this.limits.depth) throw new BoundError("E-BOUND-DEPTH");
    this.stack.push(Object.assign({ kind, toks, i: 0 }, extra));
  }
  back(t) { this.pushList([t], "back"); }
  nextRaw() {
    while (this.stack.length) {
      const f = this.stack[this.stack.length - 1];
      if (f.kind === "file") { const t = this.readTok(f); if (t !== null) return t; this.stack.pop(); if (f.onEnd) f.onEnd(); continue; }
      if (f.i < f.toks.length) { this.charge(1); const t = f.toks[f.i++]; if (f.noexpand) this.noexpandNext = true; return t; }
      this.stack.pop();
    }
    return null;
  }
  nextX() {                                   // next token after expansion
    for (;;) {
      this.noexpandNext = false;
      const t = this.nextRaw();
      if (t === null) return null;
      if (this.noexpandNext) { this.lastNoexpand = true; return t; }
      this.lastNoexpand = false;
      if (!isCs(t)) return t;
      const m = this.mean(t);
      if (m === undefined) return t;
      if (m.type === "macro") { if (this.edefDepth && m.prot) return t; this.callMacro(t, m); continue; }
      if (m.type === "lmacro") { if (this.edefDepth && m.prot) return t; this.callLMacro(t, m); continue; }
      if (m.type === "xprim") { m.fn.call(this, t); continue; }
      return t;
    }
  }
  skipSpacesRaw() { for (;;) { const t = this.nextRaw(); if (t === null) return null; if (t !== SPACE_TOK) return t; } }
  skipSpacesX() { for (;;) { const t = this.nextX(); if (t === null) return null; if (t !== SPACE_TOK) return t; } }

  // ---------------- groups (balanced) reading
  readGroupRaw(open) {         // reads tokens after an opening brace until the matching close; returns array (no outer braces)
    const out = []; let depth = 1;
    for (;;) {
      const t = this.nextRaw();
      if (t === null) { this.d("E-RUNAWAY"); return out; }
      if (!isCs(t)) { const c = catOf(t); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP && --depth === 0) return out; }
      out.push(t); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }
  readArgRaw() {               // undelimited argument
    const t = this.skipSpacesRaw();
    if (t === null) return [];
    if (!isCs(t) && catOf(t) === CAT.BGROUP) return this.readGroupRaw();
    return [t];
  }
  readArgString() { return this.toks2str(this.readArgRaw()).trim(); }
  readOptRaw() {               // [ ... ] if present, else null
    const t = this.skipSpacesRaw();
    if (t === null) return null;
    if (t !== mkChar(CAT.OTHER, 91)) { this.back(t); return null; }
    const out = []; let depth = 0;
    for (;;) {
      const u = this.nextRaw();
      if (u === null) return out;
      if (!isCs(u)) { const c = catOf(u); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP) depth--; }
      if (depth === 0 && u === mkChar(CAT.OTHER, 93)) return out;
      out.push(u); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }
  toks2str(toks) {
    let s = "";
    for (const t of toks) {
      if (isCs(t)) { const n = this.intern.name(t); s += n.startsWith("\u0001") ? n.slice(1) : "\\" + n + (/^[A-Za-z@]+$/.test(n) ? " " : ""); }
      else if (catOf(t) !== PMARK) s += String.fromCodePoint(codeOf(t));
    }
    return s;
  }
  str2toks(s) {                // standard catcodes for strings produced by \string etc.: chars are cat 12, spaces cat 10
    const out = []; for (const ch of s) { const c = ch.codePointAt(0); out.push(c === 32 ? SPACE_TOK : mkChar(CAT.OTHER, c)); }
    this.reserve(out.length * 4); return out;
  }
  tokenizeString(s) {          // tokenize with CURRENT catcodes (for native definitions)
    const save = this.stack; this.stack = [];
    this.stack.push({ kind: "file", path: "<native>", text: s, pos: 0, line: null, li: 0, st: 0, endinput: false });
    const out = []; let t;
    while ((t = this.readTokRaw()) !== null) out.push(t);   // "<native>" is never counted as source (countSrc)
    this.stack = save;
    if (out.length && out[out.length - 1] === SPACE_TOK) out.pop();
    return out;
  }
  readTokRaw() { const f = this.stack[this.stack.length - 1]; return f ? this.readTok(f) : null; }

  // ---------------- macros
  callMacro(cs, m) {
    this.charge(1);
    for (const p of m.pre) {
      const t = this.nextRaw();
      if (t !== p) { this.d("E-USE-DOESNT-MATCH"); if (t !== null) this.back(t); return; }
    }
    const args = [];
    for (let i = 0; i < m.delims.length; i++) {
      const del = m.delims[i];
      if (del.length === 0) { args.push(this.readArgRaw()); continue; }
      // delimited argument: collect until delimiter at brace depth 0
      const a = []; let depth = 0;
      for (;;) {
        const t = this.nextRaw();
        if (t === null) { this.d("E-RUNAWAY"); break; }
        if (!m.long && isCs(t) && this.intern.name(t) === "par" && depth === 0) { this.d("E-RUNAWAY-PAR"); this.back(t); break; }
        a.push(t); this.charge(1);
        if (a.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
        if (!isCs(t)) { const c = catOf(t); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP) depth--; }
        if (depth === 0 && a.length >= del.length) {
          let ok = true; for (let k = 0; k < del.length; k++) if (a[a.length - del.length + k] !== del[k]) { ok = false; break; }
          if (ok) { a.length -= del.length; break; }
        }
      }
      // strip one brace pair if the whole argument is a single group
      if (a.length >= 2 && !isCs(a[0]) && catOf(a[0]) === CAT.BGROUP && !isCs(a[a.length - 1]) && catOf(a[a.length - 1]) === CAT.EGROUP) {
        let d = 0, whole = true;
        for (let k = 0; k < a.length; k++) { const t = a[k]; if (!isCs(t)) { const c = catOf(t); if (c === CAT.BGROUP) d++; else if (c === CAT.EGROUP) d--; } if (d === 0 && k < a.length - 1) { whole = false; break; } }
        if (whole) { a.shift(); a.pop(); }
      }
      args.push(a);
    }
    this.pushList(this.substitute(m.body, args), "macro");
  }
  substitute(body, args) {
    if (!args.length) { this.charge(body.length); return body; }
    let size = 0;
    for (const t of body) size += (!isCs(t) && catOf(t) === PMARK) ? (args[codeOf(t) - 1] || []).length : 1;
    if (size > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    this.charge(size);
    const out = [];
    for (const t of body) {
      if (!isCs(t) && catOf(t) === PMARK) { const a = args[codeOf(t) - 1] || []; for (const x of a) out.push(x); }
      else out.push(t);
    }
    this.reserve(out.length * 4);
    return out;
  }
  callLMacro(cs, m) {           // \newcommand-defined: optional first argument with default
    this.charge(1);
    const args = [];
    let n = m.n;
    if (m.dflt) { const o = this.readOptRaw(); args.push(o === null ? m.dflt : o); n--; }
    for (let i = 0; i < n; i++) args.push(this.readArgRaw());
    this.pushList(this.substitute(m.body, args), "macro");
  }

  // parse TeX parameter text and body (for \def family)
  readDefinition(expand) {
    const pre = [], delims = []; let cur = pre; let nparams = 0;
    for (;;) {
      const t = this.nextRaw();
      if (t === null) throw new BoundError("E-RUNAWAY-DEF");
      if (!isCs(t) && catOf(t) === CAT.BGROUP) break;
      if (!isCs(t) && catOf(t) === CAT.PARAM) {
        const u = this.nextRaw();
        if (u !== null && !isCs(u) && catOf(u) === CAT.BGROUP) { cur.push(u); break; }   // #{ form (approximation: the brace opens the body)
        nparams++; delims.push([]); cur = delims[delims.length - 1]; continue;
      }
      cur.push(t);
    }
    let raw;
    if (expand) {
      this.edefDepth++;
      try { raw = this.readExpandedAfterBrace(); } finally { this.edefDepth--; }
    } else raw = this.readGroupRaw();
    const body = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (!isCs(t) && catOf(t) === CAT.PARAM && i + 1 < raw.length) {
        const u = raw[i + 1];
        if (!isCs(u) && catOf(u) === CAT.PARAM) { body.push(t); i++; continue; }
        const n = isCs(u) ? 0 : codeOf(u) - 48;
        if (n >= 1 && n <= 9) { body.push(mkChar(PMARK, n)); i++; continue; }
      }
      body.push(t);
    }
    this.reserve(body.length * 4 + 64);
    return { pre, delims, body, nparams };
  }
  readGroupExpanded() {        // for \message: expects the opening brace
    const t0 = this.skipSpacesRaw();
    if (t0 === null || isCs(t0) || catOf(t0) !== CAT.BGROUP) { if (t0 !== null) this.back(t0); return []; }
    return this.readExpandedAfterBrace();
  }
  readExpandedAfterBrace() {   // for \edef/\xdef: the opening brace is already consumed
    const out = []; let depth = 1;
    for (;;) {
      const t = this.nextX();
      if (t === null) { this.d("E-RUNAWAY"); return out; }
      if (!this.lastNoexpand && !isCs(t)) { const c = catOf(t); if (c === CAT.BGROUP) depth++; else if (c === CAT.EGROUP && --depth === 0) return out; }
      out.push(t); this.charge(1);
      if (out.length > this.limits.tokenList) throw new BoundError("E-BOUND-TOKENS");
    }
  }

  // ---------------- numbers
  scanInt() {
    let sign = 1, t;
    for (;;) { t = this.nextX(); if (t === null) return 0; if (t === SPACE_TOK) continue; if (t === mkChar(CAT.OTHER, 45)) { sign = -sign; continue; } if (t === mkChar(CAT.OTHER, 43)) continue; break; }
    if (isCs(t)) {
      const m = this.mean(t);
      if (m && m.type === "count") return sign * this.regGet(m.n);
      if (m && m.type === "chardef") return sign * m.n;
      if (m && m.type === "prim" && m.name === "count") { const n = this.scanInt(); return sign * this.regGet(n); }
      if (m && m.type === "prim" && m.name === "catcode") { const n = this.scanInt(); return sign * this.cat(n); }
      if (m && m.type === "prim" && (m.name === "endlinechar" || m.name === "escapechar" || m.name === "newlinechar")) return sign * this.intPar(m.name, m.name === "endlinechar" ? 13 : m.name === "escapechar" ? 92 : -1);
      this.d("E-MISSING-NUMBER"); this.back(t); return 0;
    }
    const c = codeOf(t);
    if (t === mkChar(CAT.OTHER, 96)) { const u = this.nextRaw(); this.skipOneSpace(); return sign * (u === null ? 0 : isCs(u) ? (this.intern.name(u).codePointAt(0) || 0) : codeOf(u)); }
    let base = 10, v = 0, any = false;
    if (t === mkChar(CAT.OTHER, 34)) base = 16; else if (t === mkChar(CAT.OTHER, 39)) base = 8;
    else if (c >= 48 && c <= 57 && catOf(t) === CAT.OTHER) { v = c - 48; any = true; }
    else { this.d("E-MISSING-NUMBER"); this.back(t); return 0; }
    for (;;) {
      const u = this.nextX();
      if (u === null) break;
      if (isCs(u)) { this.back(u); break; }
      const k = codeOf(u), ct = catOf(u);
      let dgt = -1;
      if (k >= 48 && k <= 57 && ct === CAT.OTHER) dgt = k - 48;
      else if (base === 16 && k >= 65 && k <= 70 && (ct === CAT.OTHER || ct === CAT.LETTER)) dgt = k - 55;
      if (dgt < 0 || dgt >= base) { if (u !== SPACE_TOK) this.back(u); break; }
      v = v * base + dgt; any = true;
      if (v > 2147483647) { this.d("E-NUMBER-TOO-BIG"); v = 2147483647; }
    }
    return sign * v;
  }
  scanKeyword(word) {          // TeX's scan_keyword: optional spaces, then the letters (case-insensitive); else put back
    const got = [];
    let t = this.skipSpacesX();
    for (let i = 0; i < word.length; i++) {
      if (t === null || isCs(t) || String.fromCodePoint(codeOf(t)).toLowerCase() !== word[i]) {
        if (t !== null) this.back(t);
        for (let j = got.length - 1; j >= 0; j--) this.back(got[j]);
        return false;
      }
      got.push(t);
      if (i < word.length - 1) t = this.nextX();
    }
    return true;
  }
  skipOneSpace() { const t = this.nextX(); if (t !== null && t !== SPACE_TOK) this.back(t); }
  skipEquals() { const t = this.skipSpacesX(); if (t !== null && t !== mkChar(CAT.OTHER, 61)) this.back(t); }
  regGet(n) { const v = this.getS("r:" + n); return v === undefined ? 0 : v; }
  regSet(n, v, global) { this.setS("r:" + n, v | 0, global); }

  // ---------------- conditionals
  pushCond(kind) { if (this.conds.length >= this.limits.conds) throw new BoundError("E-BOUND-IF"); this.conds.push(kind); }
  // skip tokens of the false branch; stops after \else (want 'else'), at \or (for \ifcase), or after \fi
  skipBranch(stopAtElse, orCount) {
    let depth = 0;
    for (;;) {
      const t = this.nextRaw();
      if (t === null) { this.d("E-INCOMPLETE-IF"); return "eof"; }
      if (!isCs(t)) continue;
      const m = this.mean(t);
      if (!m || m.type !== "xprim") continue;
      if (m.cond) { depth++; continue; }
      if (m.name === "fi") { if (depth === 0) { this.conds.pop(); return "fi"; } depth--; continue; }
      if (depth === 0 && m.name === "else" && stopAtElse) return "else";
      if (depth === 0 && m.name === "or" && orCount !== undefined) { if (--orCount.n === 0) return "or"; }
    }
  }
  condResult(b) {
    if (this.unlessNext) { b = !b; this.unlessNext = false; }
    this.pushCond("if");
    if (!b) { const r = this.skipBranch(true); if (r === "else") this.conds[this.conds.length - 1] = "else"; }
  }

  // ---------------- groups
  beginGroup(kind) {
    if (this.groups.length >= this.limits.groups) throw new BoundError("E-BOUND-GROUPS");
    this.groups.push({ kind, saved: new Map(), after: [] });
  }
  endGroup(kind) {
    const g = this.groups[this.groups.length - 1];
    if (!g) { this.d("E-EXTRA-ENDGROUP"); return; }
    if (g.kind !== kind && !(kind === "env" || g.kind === "env")) this.d("E-GROUP-MISMATCH");
    this.groups.pop();
    for (const [k, { inC, old }] of g.saved) {
      if (inC) { this.C = old === undefined ? this.C.delete(k) : this.C.set(k, old); this.writeSet.add(k); }
      else this.A = old === undefined ? this.A.delete(k) : this.A.set(k, old);
    }
    if (g.after.length) this.pushList(g.after.slice(), "after");
  }

  // ---------------- definitions helpers
  defineMacro(name, m, global) { this.setS("m:" + name, m, global); }
  csArg() {                    // read a control sequence argument: \x or {\x}
    let t = this.skipSpacesRaw();
    if (t !== null && !isCs(t) && catOf(t) === CAT.BGROUP) { const g = this.readGroupRaw(); t = g.find(isCs) ?? null; }
    if (t === null || !isCs(t)) { this.d("E-MISSING-CS"); return null; }
    return t;
  }
  finishAssignment() {
    this.prefix = 0;
    if (this.afterAssign !== null) { const t = this.afterAssign; this.afterAssign = null; this.back(t); }
  }

  // ---------------- counters (native LaTeX kernel subset)
  counterReg(name) { const m = this.getS("m:c@" + name); return m && m.type === "count" ? m.n : -1; }
  newCounter(name, within) {
    if (this.counterReg(name) >= 0) { this.d("E-COUNTER-EXISTS"); return; }
    const n = (this.A.get("alloc:count") || 20) + 1;
    this.setS("alloc:count", n, true);
    this.setS("ccreg:" + n, 1, true);
    this.setS("m:c@" + name, meaning("count", { n }), true);
    this.setS("r:" + n, 0, true);
    const body = this.tokenizeString("\\arabic{" + name + "}");
    this.setS("m:the" + name, meaning("macro", { pre: [], delims: [], body, long: false, prot: false }), true);
    this.setS("m:p@" + name, meaning("macro", { pre: [], delims: [], body: [], long: false, prot: false }), true);
    this.setS("cl:" + name, meaning("data", { data: [] }), true);
    if (within) { const k = "cl:" + within; const old = this.getS(k); const list = old ? old.data.slice() : []; list.push(name); this.setS(k, meaning("data", { data: list }), true); }
  }
  stepCounter(name) {
    const n = this.counterReg(name);
    if (n < 0) { this.d("E-NO-COUNTER"); return; }
    this.regSet(n, this.regGet(n) + 1, true);
    const cl = this.getS("cl:" + name);
    if (cl) for (const sub of cl.data) { const r = this.counterReg(sub); if (r >= 0) this.regSet(r, 0, true); }
  }

  // ---------------- the stomach (main loop)
  run() {
    setCurrentIntern(this.intern);
    for (;;) {
      if (this.inBody && this.groups.length === this.docLevel) this.maybeCheckpoint();
      const t = this.nextX();
      if (t === null) break;
      this.step(t);
    }
    this.finishUnit(null);
  }
  step(t) {
    if (!isCs(t)) {
      const c = catOf(t);
      if (this.lastNoexpand) { this.emit(t); return; }
      if (c === CAT.BGROUP) { this.beginGroup("brace"); return; }
      if (c === CAT.EGROUP) { this.endGroup("brace"); return; }
      this.emit(t); this.tokensSinceCkpt++; return;
    }
    if (this.lastNoexpand) { this.emit(t); return; }
    const m = this.mean(t);
    if (m === undefined) {
      const name = this.intern.name(t);
      if (this.known.has(name) || BASE_KNOWN.has(name)) { this.emit(t); this.tokensSinceCkpt++; return; }
      this.d("E-UNDEF-CS"); this.undef.set(name, (this.undef.get(name) || 0) + 1); return;   // TeX-like recovery: drop it
    }
    switch (m.type) {
      case "prim": m.fn.call(this, t); return;
      case "char": this.step(m.tok); return;
      case "count": this.skipEquals(); { const v = this.scanInt(); this.regSet(m.n, v, this.prefix & 1); } this.finishAssignment(); return;
      case "chardef": this.emit(mkChar(CAT.OTHER, m.n & 0x1fffff)); return;
      default: this.emit(t); this.tokensSinceCkpt++; return;
    }
  }

  // ---------------- checkpoints (§7.2): only at quiescent boundaries
  quiescent() {
    if (this.conds.length || this.prefix || this.afterAssign !== null || this.edefDepth) return false;
    for (const f of this.stack) {
      if (f.kind !== "file") { if (f.i < f.toks.length) return false; continue; }
    }
    const top = this.topFile();
    return top !== null && this.atLineStart(top) && !this.groups.some((g) => g.after.length);
  }
  topFile() { for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].kind === "file") return this.stack[i]; return null; }
  maybeCheckpoint() {
    const f = this.topFile();
    if (f === null || !this.atLineStart(f)) return;
    if (f.ckptChecked === f.pos) return;
    f.ckptChecked = f.pos;
    if (!this.quiescent()) return;
    let e = f.text.indexOf("\n", f.pos); if (e < 0) e = f.text.length;
    const next = f.text.slice(f.pos, e);
    const isSection = this.ckptRegex.test(next);
    const isBlank = /^[ \t]*\r?$/.test(next) && this.tokensSinceCkpt >= this.Tmin;
    if (!isSection && !isBlank) return;
    if ((this.ckptBase || 0) + this.checkpoints.length >= 4096) return;   // unit cap (§8.1), whole document: later candidates coalesce
    this.makeCheckpoint();
  }
  mainPos() { const f = this.stack.find((x) => x.kind === "file" && x.path === this.mainPath); return f ? f.pos : -1; }
  makeCheckpoint() {
    this.finishUnit(this.checkpoints.length);
    const ck = {
      A: this.A, C: this.C,
      groups: this.groups.map((g) => ({ kind: g.kind, env: g.env, saved: new Map(g.saved), after: g.after.slice() })),
      // complete reader state (§7.2): an outer file may be mid-line (e.g. after "\input{x}"); keep its line state
      readers: this.stack.filter((f) => f.kind === "file").map((f) => ({ path: f.path, pos: f.pos, lineStart: f.lineStart ?? f.pos, li: f.li, st: f.st, partial: !this.atLineStart(f), endinput: !!f.endinput })),
      mainPos: this.mainPos(), docLevel: this.docLevel, inBody: this.inBody,
      work: this.work, srcTokens: this.srcTokens, srcSeen: new Map(this.srcSeen), filesRead: this.filesRead,
      memBytes: this.memBytes, logN: this.logN || 0, nCheckpoints: (this.ckptBase || 0) + this.checkpoints.length + 1,
    };
    const mr = ck.readers.find((r) => r.path === this.mainPath);
    ck.mainKey = mr ? (mr.partial ? mr.lineStart : mr.pos) : -1;   // the main-file offset this checkpoint depends on
    this.checkpoints.push(ck);
    if (this.pendingCkpt) this.pendingCkpt(ck, this);
    this.tokensSinceCkpt = 0; this.unitWork = 0; this.unitSrc = 0;
  }
  finishUnit(nextIndex) {
    this.units.push({ out: { ...this.unitOut }, R: this.readSet, W: this.writeSet, work: this.unitWork, src: this.unitSrc });
    this.unitOut = { n: 0, h1: 0x811c9dc5, h2: 0x01000193 };
    this.readSet = new Set(); this.writeSet = new Set();
  }
  // resume from a checkpoint against (possibly edited) files; main-file offsets shift by delta
  restore(ck, files, delta = 0) {
    this.files = files;
    this.A = ck.A; this.C = ck.C;
    this.groups = ck.groups.map((g) => ({ kind: g.kind, env: g.env, saved: new Map(g.saved), after: g.after.slice() }));
    this.stack = [];
    for (const r of ck.readers) {
      const text = files.get(r.path);
      const d = r.path === this.mainPath ? delta : 0;
      const f = { kind: "file", path: r.path, text, pos: r.pos + d, line: null, li: 0, st: 0, endinput: !!r.endinput };
      if (r.partial) { f.pos = r.lineStart + d; const ei = f.endinput; f.endinput = false; this.loadLine(f); f.endinput = ei; f.li = r.li; f.st = r.st; }   // rebuild the half-read line exactly
      this.stack.push(f);
    }
    // this position was already examined (the checkpoint itself): do not create it again (daybreak2 D4 r1)
    const top = this.topFile(); if (top) top.ckptChecked = top.pos;
    this.conds = []; this.prefix = 0; this.afterAssign = null; this.edefDepth = 0;
    this.docLevel = ck.docLevel; this.inBody = ck.inBody;
    this.work = ck.work; this.unitWork = 0; this.unitSrc = 0; this.filesRead = ck.filesRead; this.srcTokens = ck.srcTokens;
    this.srcSeen = new Map(ck.srcSeen); if (delta && this.srcSeen.has(this.mainPath)) this.srcSeen.set(this.mainPath, this.srcSeen.get(this.mainPath) + delta);
    setCurrentIntern(this.intern);
    this.out = { n: 0, h1: 0x811c9dc5, h2: 0x01000193 }; this.unitOut = { n: 0, h1: 0x811c9dc5, h2: 0x01000193 };   // only unit digests carry meaning
    this.readSet = new Set(); this.writeSet = new Set(); this.tokensSinceCkpt = 0;
    this.checkpoints = []; this.units = [];
    this.endDocument = false; this.lastNoexpand = false; this.noexpandNext = false; this.unlessNext = false;
    this.logN = ck.logN || 0; this.memBytes = ck.memBytes || 0; this.ckptBase = ck.nCheckpoints || 0;
  }
  stateKey() { return this.A.hashString() + "/" + this.C.hashString(); }

  // ---------------- primitives
  prim(name, fn) { this.A = this.A.set("m:" + name, meaning("prim", { name, fn })); }   // fn is called with this = the running machine
  xprim(name, fn, cond = false) { this.A = this.A.set("m:" + name, meaning("xprim", { name, fn, cond })); }
  installPrimitives() {
    const P = this;
    // --- expandable
    P.xprim("expandafter", function () { const a = this.nextRaw(); const b = this.nextRaw(); if (b !== null) { this.back(b); this.nextXOnce(); } if (a !== null) this.back(a); });
    P.xprim("noexpand", function () { const t = this.nextRaw(); if (t !== null) this.pushList([t], "back", { noexpand: true }); });
    P.xprim("csname", function () {
      let s = "";
      for (;;) {
        const t = this.nextX();
        if (t === null) break;
        if (isCs(t)) { if (this.intern.name(t) === "endcsname") break; this.d("E-CSNAME-CS"); continue; }
        s += String.fromCodePoint(codeOf(t)); this.charge(1);
      }
      const tok = this.csTok(s);
      if (this.mean(tok) === undefined) this.setS("m:" + s, this.getS("m:relax"), false);
      this.back(tok);
    });
    P.xprim("string", function () { const t = this.nextRaw(); if (t === null) return; const s = isCs(t) ? (this.intern.name(t).startsWith("\u0001") ? this.intern.name(t).slice(1) : "\\" + this.intern.name(t)) : String.fromCodePoint(codeOf(t)); this.pushList(this.str2toks(s)); });
    P.xprim("number", function () { this.pushList(this.str2toks(String(this.scanInt()))); });
    P.xprim("romannumeral", function () { const n = this.scanInt(); this.pushList(this.str2toks(roman(n))); });
    P.xprim("the", function () {
      const t = this.nextX(); if (t === null) return;
      const m = isCs(t) ? this.mean(t) : undefined;
      let toks;
      if (m && m.type === "count") toks = this.str2toks(String(this.regGet(m.n)));
      else if (m && m.type === "chardef") toks = this.str2toks(String(m.n));
      else if (m && m.type === "toksdef") toks = (this.getS("t:" + m.n) || { data: [] }).data;
      else if (m && m.type === "prim" && m.name === "count") toks = this.str2toks(String(this.regGet(this.scanInt())));
      else if (m && m.type === "prim" && m.name === "catcode") toks = this.str2toks(String(this.cat(this.scanInt())));
      else if (m && m.type === "prim" && m.name === "toks") toks = (this.getS("t:" + this.scanInt()) || { data: [] }).data;
      else { this.d("E-THE-UNSUPPORTED"); toks = []; }
      this.pushList(toks, "back", this.edefDepth ? { noexpand: true } : undefined);
    });
    P.xprim("detokenize", function () { const g = this.readArgRaw(); this.pushList(this.str2toks(this.toks2str(g))); });
    P.xprim("unexpanded", function () { const g = this.readArgRaw(); this.pushList(g, "back", { noexpand: true }); });
    P.xprim("jobname", function () { this.pushList(this.str2toks("main")); });
    P.xprim("input", function () {
      const t = this.skipSpacesX(); let name = "";
      if (t !== null && !isCs(t) && catOf(t) === CAT.BGROUP) { this.back(t); name = this.readArgString(); }
      else { if (t !== null) this.back(t); for (;;) { const u = this.nextX(); if (u === null || isCs(u) || u === SPACE_TOK) { if (u !== null && isCs(u)) this.back(u); break; } name += String.fromCodePoint(codeOf(u)); } }
      this.doInput(name);
    });
    for (const nm of ["include", "subfile"]) P.prim(nm, function () { this.doInput(this.readArgString()); });
    for (const nm of ["import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"]) P.prim(nm, function () { let t = this.skipSpacesRaw(); if (t !== mkChar(CAT.OTHER, 42) && t !== null) this.back(t); const dir = this.readArgString(); const f = this.readArgString(); this.doInput((dir.endsWith("/") || dir === "" ? dir : dir + "/") + f); });
    P.xprim("endinput", function () { const f = this.topFile(); if (f) f.endinput = true; });
    // conditionals
    const C = (name, fn) => P.xprim(name, function () { this.condResult(fn.call(this)); }, true);
    C("iftrue", () => true); C("iffalse", () => false);
    C("ifnum", function () { const a = this.scanInt(); const r = this.skipSpacesX(); const b = this.scanInt(); const op = r === null ? 61 : codeOf(r); return op === 60 ? a < b : op === 62 ? a > b : a === b; });
    C("ifodd", function () { return (this.scanInt() & 1) === 1; });
    C("ifx", function () { const a = this.nextRaw(), b = this.nextRaw(); return this.sameMeaning(a, b); });
    C("if", function () { const a = this.nextXNonCs(), b = this.nextXNonCs(); return a.code === b.code; });
    C("ifcat", function () { const a = this.nextXNonCs(), b = this.nextXNonCs(); return a.cat === b.cat; });
    C("ifdefined", function () { const t = this.nextRaw(); const m = t === null ? undefined : this.mean(t); return m !== undefined && !(m.type === "prim" && m.name === "relax" && false); });
    C("ifcsname", function () { let s = ""; for (;;) { const t = this.nextX(); if (t === null) break; if (isCs(t)) { if (this.intern.name(t) === "endcsname") break; continue; } s += String.fromCodePoint(codeOf(t)); } return this.getS("m:" + s) !== undefined; });
    P.xprim("ifcase", function () {
      const n = this.scanInt(); this.pushCond("case");
      if (n === 0) return;
      const r = this.skipBranch(true, { n });
      if (r === "else") this.conds[this.conds.length - 1] = "else";
    }, true);
    P.xprim("unless", function () {
      const t = this.nextRaw(); const m = t === null ? undefined : this.mean(t);
      if (!m || !m.cond || m.name === "ifcase") { this.d("E-UNLESS"); return; }
      this.unlessNext = true; this.back(t);
    });
    P.xprim("else", function () { const top = this.conds[this.conds.length - 1]; if (!top) { this.d("E-EXTRA-ELSE"); return; } this.skipBranch(false); });
    P.xprim("or", function () { const top = this.conds[this.conds.length - 1]; if (!top) { this.d("E-EXTRA-OR"); return; } this.skipBranch(false); });
    P.xprim("fi", function () { if (!this.conds.length) { this.d("E-EXTRA-FI"); return; } this.conds.pop(); });
    // --- unexpandable
    P.prim("relax", function () {});
    P.prim("par", function (t) { this.emit(t); });
    P.prim("global", function () { this.prefix |= 1; });
    P.prim("long", function () { this.prefix |= 2; });
    P.prim("protected", function () { this.prefix |= 4; });
    P.prim("outer", function () { this.prefix |= 8; });
    const defp = (name, expand, glob) => P.prim(name, function () {
      const cs = this.nextRaw(); if (cs === null) return;
      const d = this.readDefinition(expand);
      const m = meaning("macro", { pre: d.pre, delims: d.delims, body: d.body, long: !!(this.prefix & 2), prot: !!(this.prefix & 4) });
      this.setS("m:" + this.intern.name(cs), m, glob || (this.prefix & 1));
      this.finishAssignment();
    });
    defp("def", false, false); defp("gdef", false, true); defp("edef", true, false); defp("xdef", true, true);
    P.prim("let", function () {
      const cs = this.nextRaw(); if (cs === null) return;
      let t = this.nextRaw(); while (t === SPACE_TOK) t = this.nextRaw();
      if (t === mkChar(CAT.OTHER, 61)) { t = this.nextRaw(); if (t === SPACE_TOK) t = this.nextRaw(); }
      this.letTo(cs, t, this.prefix & 1); this.finishAssignment();
    });
    P.prim("futurelet", function () {
      const cs = this.nextRaw(); const a = this.nextRaw(); const b = this.nextRaw();
      this.letTo(cs, b, this.prefix & 1); this.finishAssignment();
      if (b !== null) this.back(b); if (a !== null) this.back(a);
    });
    P.prim("countdef", function () { const cs = this.nextRaw(); this.skipEquals(); const n = this.scanInt(); this.setS("m:" + this.intern.name(cs), meaning("count", { n }), this.prefix & 1); this.finishAssignment(); });
    P.prim("chardef", function () { const cs = this.nextRaw(); this.skipEquals(); const n = this.scanInt(); this.setS("m:" + this.intern.name(cs), meaning("chardef", { n }), this.prefix & 1); this.finishAssignment(); });
    P.prim("toksdef", function () { const cs = this.nextRaw(); this.skipEquals(); const n = this.scanInt(); this.setS("m:" + this.intern.name(cs), meaning("toksdef", { n }), this.prefix & 1); this.finishAssignment(); });
    P.prim("count", function () { const n = this.scanInt(); this.skipEquals(); const v = this.scanInt(); this.regSet(n, v, this.prefix & 1); this.finishAssignment(); });
    P.prim("toks", function () { const n = this.scanInt(); this.skipEquals(); const g = this.readArgRaw(); this.setS("t:" + n, meaning("data", { data: g }), this.prefix & 1); this.finishAssignment(); });
    const arith = (name, op) => P.prim(name, function () {   // op(a, b, machine)
      const t = this.skipSpacesX(); let reg = -1;
      const m = t !== null && isCs(t) ? this.mean(t) : undefined;
      if (m && m.type === "count") reg = m.n; else if (m && m.type === "prim" && m.name === "count") reg = this.scanInt(); else { this.d("E-ARITH"); return; }
      this.scanKeyword("by");   // TeX keyword: letters (any case), optional
      const v = this.scanInt(); const old = this.regGet(reg);
      this.regSet(reg, op(old, v, this), this.prefix & 1); this.finishAssignment();
    });
    arith("advance", (a, b) => a + b); arith("multiply", (a, b) => Math.imul(a, b)); arith("divide", (a, b, mc) => (b === 0 ? (mc.d("E-DIVIDE-BY-ZERO"), a) : Math.trunc(a / b)));
    P.prim("catcode", function () { const n = this.scanInt(); this.skipEquals(); const v = this.scanInt(); if (v < 0 || v > 15) { this.d("E-BAD-CATCODE"); return; } this.setS("cat:" + n, v, this.prefix & 1); this.finishAssignment(); });
    for (const ip of ["endlinechar", "escapechar", "newlinechar"]) P.prim(ip, function () { this.skipEquals(); const v = this.scanInt(); this.setS("ip:" + ip, v, this.prefix & 1); this.finishAssignment(); });
    P.prim("begingroup", function () { this.beginGroup("semi"); });
    P.prim("endgroup", function () { this.endGroup("semi"); });
    P.prim("aftergroup", function () { const t = this.nextRaw(); const g = this.groups[this.groups.length - 1]; if (g && t !== null) g.after.push(t); });
    P.prim("afterassignment", function () { this.afterAssign = this.nextRaw(); });
    P.prim("message", function () { const g = this.readGroupExpanded(); this.logBytes(g.length); });
    P.prim("errmessage", function () { const g = this.readGroupExpanded(); this.logBytes(g.length); this.d("E-ERRMESSAGE"); });
    P.prim("immediate", function () {});
    P.prim("write", function () { this.scanInt(); const g = this.readArgRaw(); this.logBytes(g.length); this.d("I-WRITE-NOT-MODELLED-IN-D4"); });
    P.prim("openout", function () { this.scanInt(); this.skipEquals(); this.readFileName(); });
    P.prim("closeout", function () { this.scanInt(); });
    P.prim("openin", function () { this.scanInt(); this.skipEquals(); this.readFileName(); this.d("I-OPENIN-NOT-MODELLED-IN-D4"); });
    // --- native LaTeX kernel subset (D3 §2.2)
    P.prim("makeatletter", function () { this.setS("cat:64", CAT.LETTER, false); });
    P.prim("makeatother", function () { this.setS("cat:64", CAT.OTHER, false); });
    const newcmd = (name, mode) => P.prim(name, function () {
      let t = this.skipSpacesRaw(); const star = t === mkChar(CAT.OTHER, 42); if (!star && t !== null) this.back(t);
      const cs = this.csArg(); if (cs === null) return;
      const nOpt = this.readOptRaw(); const n = nOpt ? parseInt(this.toks2str(nOpt), 10) || 0 : 0;
      const dflt = this.readOptRaw();
      const raw = this.readArgRaw();
      const nm = this.intern.name(cs);
      const exists = this.getS("m:" + nm) !== undefined;
      if (mode === "new" && exists) this.d("E-ALREADY-DEFINED");
      if (mode === "renew" && !exists) this.d("E-NOT-DEFINED");
      if (mode === "provide" && exists) return;
      const body = raw.map((x) => x); const b2 = [];
      for (let i = 0; i < body.length; i++) { const x = body[i]; if (!isCs(x) && catOf(x) === CAT.PARAM && i + 1 < body.length) { const y = body[i + 1]; const k = isCs(y) ? 0 : codeOf(y) - 48; if (k >= 1 && k <= 9) { b2.push(mkChar(PMARK, k)); i++; continue; } if (!isCs(y) && catOf(y) === CAT.PARAM) { b2.push(x); i++; continue; } } b2.push(x); }
      this.setS("m:" + nm, meaning("lmacro", { n, dflt: dflt, body: b2, prot: false }), false);
      this.finishAssignment();
    });
    newcmd("newcommand", "new"); newcmd("renewcommand", "renew"); newcmd("providecommand", "provide"); newcmd("DeclareRobustCommand", "renew");
    const newenv = (name, mode) => P.prim(name, function () {
      let t = this.skipSpacesRaw(); const star = t === mkChar(CAT.OTHER, 42); if (!star && t !== null) this.back(t);
      const env = this.readArgString();
      const nOpt = this.readOptRaw(); const n = nOpt ? parseInt(this.toks2str(nOpt), 10) || 0 : 0;
      const dflt = this.readOptRaw();
      const begin = this.readArgRaw(); const end = this.readArgRaw();
      const conv = (body) => { const b2 = []; for (let i = 0; i < body.length; i++) { const x = body[i]; if (!isCs(x) && catOf(x) === CAT.PARAM && i + 1 < body.length) { const y = body[i + 1]; const k = isCs(y) ? 0 : codeOf(y) - 48; if (k >= 1 && k <= 9) { b2.push(mkChar(PMARK, k)); i++; continue; } } b2.push(x); } return b2; };
      this.setS("m:" + env, meaning("lmacro", { n, dflt, body: conv(begin), prot: false }), false);
      this.setS("m:end" + env, meaning("lmacro", { n: 0, dflt: null, body: end, prot: false }), false);
      this.finishAssignment();
    });
    newenv("newenvironment", "new"); newenv("renewenvironment", "renew");
    P.prim("begin", function () {
      const env = this.readArgString(); this.charge(env.length);
      if (env === "document") { this.beginGroup("env"); this.groups[this.groups.length - 1].env = env; this.inBody = true; this.docLevel = this.groups.length; return; }
      if (VERBATIM.has(env)) { this.skipVerbatim(env); return; }
      this.beginGroup("env"); this.groups[this.groups.length - 1].env = env;
      if (EQ_ENVS.has(env)) this.stepCounterRef("equation");
      const m = this.getS("m:" + env);
      if (m !== undefined) this.back(this.csTok(env));
      else if (!this.known.has(env) && !KNOWN_ENVS.has(env)) { this.d("E-UNDEF-ENV"); this.undef.set("env:" + env, (this.undef.get("env:" + env) || 0) + 1); }
    });
    P.prim("end", function () {
      const env = this.readArgString();
      if (env === "document") { this.endDocument = true; this.stack.length = 0; return; }
      const g = this.groups[this.groups.length - 1];
      if (!g || g.env !== env) this.d("E-ENV-MISMATCH");
      const m = this.getS("m:end" + env);
      if (m !== undefined) { this.pushList([this.csTok("sb@endgroup")]); this.back(this.csTok("end" + env)); }
      else this.endGroup("env");
    });
    P.prim("sb@endgroup", function () { this.endGroup("env"); });
    for (const nm of ["documentclass", "usepackage", "RequirePackage", "LoadClass"]) P.prim(nm, function () {
      this.readOptRaw(); const a = this.readArgString(); this.readOptRaw();
      const ext = nm === "documentclass" || nm === "LoadClass" ? ".cls" : ".sty";
      // project-local packages (D3 §2.3 precedence: next to the main file) run as TeX, with @ a letter while loading
      const names = a.split(",").map((x) => x.trim()).filter(Boolean).reverse();   // reversed: the stack runs them in order
      for (const n of names) {
        const pth = normPath(this.mainDir + n + ext);
        if (!this.files.has(pth)) { this.pkgs = (this.pkgs || 0) + 1; continue; }
        const oldAt = this.A.get("cat:64");
        if (!this.openFile(pth)) continue;
        this.setS("cat:64", CAT.LETTER, false);
        const f = this.stack[this.stack.length - 1];
        f.onEnd = () => { this.setS("cat:64", oldAt === undefined ? CAT.OTHER : oldAt, false); };
        this.localPkgs = (this.localPkgs || 0) + 1;
      }
    });
    P.prim("newcounter", function () { const name = this.readArgString(); const w = this.readOptRaw(); this.newCounter(name, w ? this.toks2str(w).trim() : null); });
    P.prim("stepcounter", function () { this.stepCounter(this.readArgString()); });
    P.prim("refstepcounter", function () { this.stepCounterRef(this.readArgString()); });
    P.prim("setcounter", function () { const name = this.readArgString(); const g = this.readArgRaw(); this.pushList(g); const v = this.scanInt(); const n = this.counterReg(name); if (n >= 0) this.regSet(n, v, true); else this.d("E-NO-COUNTER"); });
    P.prim("addtocounter", function () { const name = this.readArgString(); const g = this.readArgRaw(); this.pushList(g); const v = this.scanInt(); const n = this.counterReg(name); if (n >= 0) this.regSet(n, this.regGet(n) + v, true); else this.d("E-NO-COUNTER"); });
    P.xprim("value", function () { const name = this.readArgString(); const n = this.counterReg(name); this.back(n >= 0 ? this.csTok("c@" + name) : this.csTok("relax")); });
    for (const [nm, f] of [["arabic", String], ["roman", (n) => roman(n)], ["Roman", (n) => roman(n).toUpperCase()], ["alph", (n) => n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : ""], ["Alph", (n) => n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : ""]]) {
      P.xprim(nm, function () { const name = this.readArgString(); const r = this.counterReg(name); this.pushList(this.str2toks(f(r >= 0 ? this.regGet(r) : 0))); });
    }
    P.prim("label", function () { const l = this.readArgString(); this.setS("lbl:" + l, meaning("data", { data: this.A.get("curlabel")?.data ?? "" }), true); });
    for (const nm of ["ref", "eqref", "pageref", "cite", "cref", "Cref", "autoref", "citep", "citet"]) P.prim(nm, function (t) { this.readOptRaw(); this.readArgRaw(); this.emit(t); });
    for (const [nm, ctr] of [["part", "part"], ["chapter", "chapter"], ["section", "section"], ["subsection", "subsection"], ["subsubsection", "subsubsection"], ["paragraph", "paragraph"], ["caption", null], ["footnote", "footnote"]]) {
      P.prim(nm, function (t) {
        let s = this.skipSpacesRaw(); const star = s === mkChar(CAT.OTHER, 42); if (!star && s !== null) this.back(s);
        this.readOptRaw(); const arg = this.readArgRaw();
        if (ctr && !star && this.counterReg(ctr) >= 0) this.stepCounterRef(ctr);
        this.emit(t); this.pushList(arg);     // the title is expanded and output like body text
      });
    }
    P.prim("newif", function () {
      const cs = this.nextRaw(); if (cs === null) return; const nm = this.intern.name(cs);
      if (!nm.startsWith("if")) { this.d("E-NEWIF"); return; }
      const base = nm.slice(2);
      this.setS("m:" + nm, this.getS("m:iffalse"), this.prefix & 1);
      const mk = (val) => meaning("macro", { pre: [], delims: [], body: [this.csTok("let"), cs, this.csTok(val)], long: false, prot: false });
      this.setS("m:" + base + "true", mk("iftrue"), this.prefix & 1);
      this.setS("m:" + base + "false", mk("iffalse"), this.prefix & 1);
      this.finishAssignment();
    });
    P.prim("@ifnextchar", function () { this.ifNextChar(false); });
    P.prim("@ifstar", function () { this.ifNextChar(true); });
    P.xprim("@ifundefined", function () { const nm = this.readArgString(); const a = this.readArgRaw(); const b = this.readArgRaw(); const m = this.getS("m:" + nm); this.pushList(m === undefined || (m.type === "prim" && m.name === "relax") ? a : b); });
    P.xprim("@gobble", function () { this.readArgRaw(); });
    P.xprim("@firstofone", function () { this.pushList(this.readArgRaw()); });
    P.xprim("@firstoftwo", function () { const a = this.readArgRaw(); this.readArgRaw(); this.pushList(a); });
    P.xprim("@secondoftwo", function () { this.readArgRaw(); this.pushList(this.readArgRaw()); });
    P.xprim("@namedef", function () { const nm = this.readArgString(); this.back(this.csTok(nm)); this.back(this.csTok("def")); });
    P.xprim("@nameuse", function () { const nm = this.readArgString(); this.back(this.csTok(nm)); });
    P.prim("protect", function () {});
    for (const nm of ["verb", "lstinline", "mintinline", "Verb"]) P.prim(nm, function (t) {
      const f = this.stack[this.stack.length - 1];
      if (!f || f.kind !== "file" || f.line === null) { this.d("E-VERB-IN-ARG"); return; }
      const L = f.line;
      if (L[f.li] === "*") f.li++;
      if (nm !== "verb" && L[f.li] === "[") { const e = L.indexOf("]", f.li); f.li = e < 0 ? L.length : e + 1; }
      if (nm === "mintinline" && L[f.li] === "{") { const e = L.indexOf("}", f.li); f.li = e < 0 ? L.length : e + 1; }
      const d = L[f.li]; const close = d === "{" ? "}" : d;
      const e = L.indexOf(close, f.li + 1);
      if (e < 0) { this.d("E-VERB-UNTERMINATED"); f.li = L.length; return; }
      this.charge(Math.ceil((e - f.li) / 8)); f.li = e + 1; f.st = 1; this.emit(t);
    });
    P.prim("sbxbusy", function () { const ms = this.scanInt(); if (this.stopFlag) Atomics.store(this.stopFlag, 2, 1); const t0 = Date.now(); while (Date.now() - t0 < ms) {} if (this.stopFlag) Atomics.store(this.stopFlag, 2, 0); });   // test hook: a native call that cannot poll (§8.3 watchdog)
    // standard counters (LaTeX's article)
    for (const c of ["part", "section", "subsection", "subsubsection", "paragraph", "equation", "figure", "table", "footnote", "page", "enumi", "enumii"]) this.newCounter(c, null);
    this.newCounter("chapter", null);
    { const k = "cl:section"; this.setS(k, meaning("data", { data: ["subsection"] }), true); this.setS("cl:subsection", meaning("data", { data: ["subsubsection"] }), true); }
    this.setS("m:@empty", meaning("macro", { pre: [], delims: [], body: [], long: false, prot: false }), true);
    this.setS("cat:64", CAT.OTHER, true);
    this.A = this.A; // primitives installed
  }
  stepCounterRef(name) {
    this.stepCounter(name);
    // owned symbolic numbering (§2.4): record a reference, not formatted text
    const n = this.counterReg(name);
    this.setS("curlabel", meaning("data", { data: name + ":" + (n >= 0 ? this.regGet(n) : 0) }), false);
  }
  ifNextChar(star) {
    let ch;
    if (star) ch = mkChar(CAT.OTHER, 42); else ch = this.nextRaw();
    const a = this.readArgRaw(); const b = this.readArgRaw();
    const t = this.skipSpacesRaw();
    if (t !== null && t === ch) { if (!star) this.back(t); this.pushList(a); }
    else { if (t !== null) this.back(t); this.pushList(b); }
  }
  letTo(cs, t, global) {
    let m;
    if (t === null) m = undefined;
    else if (isCs(t)) m = this.mean(t);
    else m = meaning("char", { tok: t });
    this.setS("m:" + this.intern.name(cs), m, global);
  }
  sameMeaning(a, b) {
    if (a === null || b === null) return a === b;
    if (!isCs(a) && !isCs(b)) return a === b;
    const ma = isCs(a) ? this.mean(a) : meaning("char", { tok: a });
    const mb = isCs(b) ? this.mean(b) : meaning("char", { tok: b });
    if (ma === undefined || mb === undefined) return ma === mb;
    if (ma === mb) return true;
    if (ma.type !== mb.type) return false;
    if (ma.type === "macro") return ma.vh === mb.vh && ma.long === mb.long && arrEq(ma.body, mb.body) && arrEq(ma.pre, mb.pre) && ma.delims.length === mb.delims.length && ma.delims.every((d, i) => arrEq(d, mb.delims[i]));
    return ma.vh === mb.vh;
  }
  nextXNonCs() {              // for \if/\ifcat: expand; an unexpandable cs counts as (cat 16, code 256)
    const t = this.nextX();
    if (t === null) return { code: -1, cat: -1 };
    if (isCs(t)) { const m = this.mean(t); if (m && m.type === "char") return { code: codeOf(m.tok), cat: catOf(m.tok) }; return { code: 256, cat: 16 }; }
    return { code: codeOf(t), cat: catOf(t) };
  }
  nextXOnce() {               // expand the token on top exactly once (for \expandafter)
    const t = this.nextRaw();
    if (t === null) return;
    if (isCs(t)) {
      const m = this.mean(t);
      if (m && m.type === "macro") { this.callMacro(t, m); return; }
      if (m && m.type === "lmacro") { this.callLMacro(t, m); return; }
      if (m && m.type === "xprim") { m.fn.call(this, t); return; }
    }
    this.back(t);
  }
  logBytes(n) { this.logN = (this.logN || 0) + n; if (this.logN > 4 * 2 ** 20) throw new BoundError("E-BOUND-OUTPUT", "log"); }
  readFileName() { const t = this.skipSpacesX(); if (t !== null && !isCs(t) && catOf(t) === CAT.BGROUP) { this.back(t); return this.readArgString(); } let s = ""; let u = t; while (u !== null && !isCs(u) && u !== SPACE_TOK) { s += String.fromCodePoint(codeOf(u)); u = this.nextX(); } if (u !== null && isCs(u)) this.back(u); return s; }
  doInput(name) {
    const cands = [this.mainDir + name, this.mainDir + name + ".tex"];
    for (const c of cands) { const p = normPath(c); if (this.files.has(p)) { this.openFile(p); return; } }
    this.d("E-INPUT-NOT-FOUND");
  }
  skipVerbatim(env) {
    const f = this.stack[this.stack.length - 1];
    if (!f || f.kind !== "file") { this.d("E-VERBATIM-IN-ARG"); return; }
    const endtok = "\\end{" + env + "}";
    const restLine = f.line === null ? "" : f.line.slice(f.li);
    const ix = restLine.indexOf(endtok);
    if (ix >= 0) { f.li += ix + endtok.length; return; }
    const e = f.text.indexOf(endtok, f.pos);
    if (e < 0) { this.d("E-UNTERMINATED-VERBATIM"); f.pos = f.text.length; f.line = null; return; }
    this.charge(Math.ceil((e - f.pos) / 64));
    // continue after the end token on its line
    let ls = f.text.lastIndexOf("\n", e) + 1;
    f.pos = ls; this.loadLine(f); f.li = e - ls + endtok.length; f.st = 1;
  }
}

const BASE_KNOWN = new Set(["\\", " ", "[", "]", "(", ")", ",", ";", ":", "!", "{", "}", "%", "&", "#", "_", "$", "-", "/", "'", "`", "^", "~", "=", ".", "\"", "@", "|", "\u0001~", ""]);
const VERBATIM = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*",
  "pycode", "pyblock", "pysub", "pyverbatim", "pyconsole", "sageblock", "sagesilent", "sagecommandline", "sageexample", "sageverbatim", "sympycode", "pylabcode"]);
const EQ_ENVS = new Set(["equation", "align", "gather", "multline", "eqnarray"]);
const KNOWN_ENVS = new Set(["itemize", "enumerate", "description", "center", "flushleft", "flushright", "figure", "figure*", "table", "table*", "tabular", "tabular*", "tabularx", "array",
  "minipage", "quote", "quotation", "abstract", "titlepage", "thebibliography", "equation*", "align*", "gather*", "multline*", "split", "aligned", "cases", "matrix", "pmatrix", "bmatrix", "vmatrix", "Bmatrix", "Vmatrix",
  "theorem", "lemma", "proof", "definition", "corollary", "proposition", "remark", "example", "frame", "block", "columns", "column", "tikzpicture", "longtable", "subfigure", "algorithm", "algorithmic", "displaymath", "math", "eqnarray*", "list", "picture", "small", "footnotesize", "scope", "axis"]);
function roman(n) { if (n <= 0 || n > 100000) return ""; const v = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let s = ""; for (const [k, r] of v) while (n >= k) { s += r; n -= k; } return s; }
function arrEq(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
export function normPath(p) { const out = []; for (const s of p.split("/")) { if (s === "" || s === ".") continue; if (s === "..") { if (!out.length) return "\u0000escape"; out.pop(); } else out.push(s); } return out.join("/"); }
export { mkChar, isCs, catOf, codeOf, SPACE_TOK };
