// The re module on JS RegExp: Python patterns are translated to JS syntax
// (named groups, \A \Z, Python's `$`, Unicode \w \d, verbose mode, ...).
// Indices are UTF-16 code units, like the rest of the runtime's strings.

import * as SP from "./strpos";
import { T, PyBytes, PyDict, raise, typeName, tuple, objectType, callObj, dictSet, isinstance, sig } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { repr } from "./format";
import { newBuiltinModule } from "./modules";

const I = 2, L = 4, M = 8, S = 16, U = 32, X = 64, A = 256;
let ReError: any;

// ------------------------------------------------------------------ translation

const SPECIAL_JS = new Set("^$\\.*+?()[]{}|/".split(""));

// Python's str.isspace() characters (\s of a str pattern), and \w's
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// (IGNORECASE: CPython's re also makes I, i, U+0130 and U+0131 one class,
// from re._casefix; JS's simple case folding joins only I and i)
const DOTTED_I = "Ii\\u0130\\u0131";

function translate(p: string, flags: number, bytes = false): { src: string; flags: number } {
  // Leading global inline flags: (?aiLmsux)
  let m: RegExpExecArray | null;
  while ((m = /^\(\?([aiLmsux]+)\)/.exec(p)) !== null) {
    for (const c of m[1]) flags |= { a: A, i: I, L, m: M, s: S, u: U, x: X }[c]!;
    p = p.slice(m[0].length);
  }
  const ascii = (flags & A) !== 0 || bytes;
  const verbose = (flags & X) !== 0;
  let out = "";
  let i = 0;
  let inClass = false;
  let classStart = false;
  const W = ascii ? "a-zA-Z0-9_" : "\\p{L}\\p{N}_";
  const D = ascii ? "0-9" : "\\p{Nd}";
  const SP = ascii ? " \\t\\n\\r\\f\\v" : SPACE;
  // The flags in force (a scoped group's own, inside it), and the class
  // being read: where it starts in out, whether it is negated, and the sets
  // of the \S \W \D in it (JS cannot negate a set inside a class)
  let cur = flags;
  const scopes: number[] = [];
  let classAt = 0, classNeg = false;
  let negSets: string[] = [];
  // A literal character under IGNORECASE (JS's i flag folds by Unicode, so
  // ASCII and bytes patterns never have it: their letters are written as
  // both cases, CORR-BD8-1), escaped or not (CORR-BD8-2)
  const lit = (ch: string, src: string): string => {
    if (cur & I) {
      if (ascii) {
        if (/^[A-Za-z]$/.test(ch)) return `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
      } else if (ch === "I" || ch === "i" || ch === "\u0130" || ch === "\u0131") return `[${DOTTED_I}]`;
    }
    return src;
  };
  const closeClass = () => {
    const pos = out.slice(classAt + (classNeg ? 2 : 1));
    out = out.slice(0, classAt);
    const has = (ch: string) =>
      (pos !== "" && new RegExp(`[${pos}]`, "u" + (cur & I && !ascii ? "i" : "")).test(ch)) || negSets.some((n) => !new RegExp(`[${n}]`, "u").test(ch));
    let body = pos;
    if (cur & I && ascii) {
      // (each ASCII letter the class holds, in both cases)
      for (let k = 0; k < 26; k++) {
        const lo = String.fromCharCode(97 + k), up = String.fromCharCode(65 + k);
        const hl = has(lo), hu = has(up);
        if (hl !== hu) body += hl ? up : lo;
      }
    } else if (cur & I && ["I", "i", "\u0130", "\u0131"].some(has)) body += DOTTED_I;
    if (negSets.length === 0) out += `[${classNeg ? "^" : ""}${body}]`;
    else if (!classNeg) out += `(?:${[...(body ? [`[${body}]`] : []), ...negSets.map((n) => `[^${n}]`)].join("|")})`;
    // (one atom, so that a quantifier after it repeats all of it)
    else out += "(?:" + (body ? `(?![${body}])` : "") + negSets.slice(0, -1).map((n) => `(?=[${n}])`).join("") + `[${negSets[negSets.length - 1]}]` + ")";
    negSets = [];
  };
  while (i < p.length) {
    const c = p[i];
    if (verbose && !inClass) {
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === "#") {
        while (i < p.length && p[i] !== "\n") i++;
        continue;
      }
    }
    if (c === "\\") {
      classStart = false;
      const d = p[i + 1];
      if (d === undefined) raise(ReError, "bad escape (end of pattern)");
      i += 2;
      switch (d) {
        // (the JS regex never has the m flag, so ^ and $ are the input's
        // ends; V8 misplaces (?![\s\S]) beside a surrogate pair in u mode)
        case "A":
          out += inClass ? "" : "^";
          continue;
        case "Z":
        case "z":
          out += inClass ? "" : "$";
          continue;
        case "w":
          out += inClass ? W : `[${W}]`;
          continue;
        case "W":
          if (inClass) negSets.push(W);
          else out += `[^${W}]`;
          continue;
        case "d":
          out += inClass ? D : `[${D}]`;
          continue;
        case "D":
          if (inClass) negSets.push(D);
          else out += `[^${D}]`;
          continue;
        case "s":
          out += inClass ? SP : `[${SP}]`;
          continue;
        case "S":
          if (inClass) negSets.push(SP);
          else out += `[^${SP}]`;
          continue;
        // (word boundaries by \w's own characters: JS's \b knows only ASCII)
        case "b":
          if (inClass) out += "\\x08";
          else out += ascii ? "\\b" : `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
          continue;
        case "B":
          if (inClass) raise(ReError, "bad escape \\B");
          out += ascii ? "\\B" : `(?:(?<=[${W}])(?=[${W}])|(?<![${W}])(?![${W}]))`;
          continue;
        case "n":
        case "t":
        case "r":
        case "f":
        case "v":
          out += "\\" + d;
          continue;
        case "a":
          out += "\\x07";
          continue;
        case "x": {
          const h = p.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(h)) raise(ReError, `incomplete escape \\x${h}`);
          out += inClass ? "\\x" + h : lit(String.fromCharCode(parseInt(h, 16)), "\\x" + h);
          i += 2;
          continue;
        }
        case "u": {
          const h = p.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) raise(ReError, `incomplete escape \\u${h}`);
          out += inClass ? "\\u" + h : lit(String.fromCharCode(parseInt(h, 16)), "\\u" + h);
          i += 4;
          continue;
        }
        case "U": {
          const h = p.slice(i, i + 8);
          if (!/^[0-9a-fA-F]{8}$/.test(h)) raise(ReError, `incomplete escape \\U${h}`);
          const cp = parseInt(h, 16);
          if (cp > 0x10ffff) raise(ReError, `bad escape \\U${h}`);
          out += inClass ? `\\u{${cp.toString(16)}}` : lit(String.fromCodePoint(cp), `\\u{${cp.toString(16)}}`);
          i += 8;
          continue;
        }
        case "0": {
          const o = /^[0-7]{0,2}/.exec(p.slice(i))![0];
          i += o.length;
          const cp = parseInt("0" + o, 8);
          out += inClass ? `\\u{${cp.toString(16)}}` : lit(String.fromCodePoint(cp), `\\u{${cp.toString(16)}}`);
          continue;
        }
      }
      if (/[1-9]/.test(d)) {
        // backreference, or an octal escape of three digits
        const o3 = /^[0-7]{2}/.exec(p.slice(i));
        if (/[0-7]/.test(d) && o3) {
          i += 2;
          const cp = parseInt(d + o3[0], 8);
          out += inClass ? `\\u{${cp.toString(16)}}` : lit(String.fromCodePoint(cp), `\\u{${cp.toString(16)}}`);
          continue;
        }
        const num = /^\d?/.exec(p.slice(i))![0];
        i += num.length;
        if (!inClass && ascii && cur & I) raise(T.NotImplementedError, "IGNORECASE backreferences in ASCII or bytes patterns are not supported");
        out += inClass ? "" : `\\${d}${num}`;
        continue;
      }
      if (/[A-Za-z]/.test(d)) raise(ReError, `bad escape \\${d}`);
      // Escaped punctuation: only escape what JS (in u mode) allows.
      out += SPECIAL_JS.has(d) || (inClass && d === "-") ? "\\" + d : d;
      continue;
    }
    if (inClass) {
      if (c === "]" && !classStart) {
        inClass = false;
        closeClass();
        i++;
        continue;
      } else if (c === "[") {
        out += "\\[";
        i++;
        classStart = false;
        continue;
      }
      classStart = false;
      out += c;
      i++;
      continue;
    }
    switch (c) {
      case "[":
        inClass = true;
        classStart = true;
        classAt = out.length;
        classNeg = p[i + 1] === "^";
        out += c;
        i++;
        if (p[i] === "^") {
          out += "^";
          i++;
        }
        if (p[i] === "]") {
          out += "\\]";
          i++;
          classStart = false;
        }
        continue;
      case "$":
        out += cur & M ? "(?=\\n|$)" : "(?=\\n?$)";
        i++;
        continue;
      case "^":
        out += cur & M ? "(?:^|(?<=\\n))" : "^";
        i++;
        continue;
      // (Python's . is every character but \n, or every one with DOTALL;
      // JS's also leaves out \r, U+2028 and U+2029)
      case ".":
        out += cur & S ? "[\\s\\S]" : "[^\\n]";
        i++;
        continue;
      case ")":
        cur = scopes.pop() ?? cur;
        out += c;
        i++;
        continue;
      case "{": {
        const q = /^\{(\d*)(?:,(\d*))?\}/.exec(p.slice(i));
        if (q === null) {
          out += "\\{";
          i++;
          continue;
        }
        out += q[2] === undefined ? `{${q[1] || "0"}}` : `{${q[1] || "0"},${q[2]}}`;
        i += q[0].length;
        if (p[i] === "+") raise(ReError, "possessive quantifiers are not supported");
        continue;
      }
      case "}":
        out += "\\}";
        i++;
        continue;
      case "/":
        out += "\\/";
        i++;
        continue;
      case "(":
        if (p[i + 1] === "?") {
          const rest = p.slice(i);
          let g: RegExpExecArray | null;
          if ((g = /^\(\?P<([A-Za-z_]\w*)>/.exec(rest))) {
            scopes.push(cur);
            out += `(?<${g[1]}>`;
            i += g[0].length;
            continue;
          }
          if ((g = /^\(\?P=([A-Za-z_]\w*)\)/.exec(rest))) {
            if (ascii && cur & I) raise(T.NotImplementedError, "IGNORECASE backreferences in ASCII or bytes patterns are not supported");
            out += `\\k<${g[1]}>`;
            i += g[0].length;
            continue;
          }
          if ((g = /^\(\?#[^)]*\)/.exec(rest))) {
            i += g[0].length;
            continue;
          }
          if ((g = /^\(\?([aiLmsux]*)(?:-([imsx]+))?:/.exec(rest)) && (g[1] || g[2])) {
            // scoped flags: m and s are this translation's own (^, $ and .);
            // i is JS's modifier, and is in force for the class rules too
            // (a, L and x in a scope are not implemented: refused, not ignored;
            // u is a str pattern's default, and refused inside an ASCII one,
            // CORR-6A0-1)
            if (/[aLx]/.test(g[1] + (g[2] ?? "")) || (ascii && g[1].includes("u"))) raise(T.NotImplementedError, `scoped flags (?${g[1]}${g[2] ? "-" + g[2] : ""}:...) are not supported`);
            scopes.push(cur);
            for (const f of g[1]) if (f === "i" || f === "m" || f === "s") cur |= { i: I, m: M, s: S }[f]!;
            for (const f of g[2] ?? "") if (f === "i" || f === "m" || f === "s") cur &= ~{ i: I, m: M, s: S }[f]!;
            // (in ASCII and bytes patterns IGNORECASE is written out, lit)
            const on = g[1].includes("i") && !ascii ? "i" : "", off = (g[2] ?? "").includes("i") && !ascii ? "-i" : "";
            out += on || off ? `(?${on}${off}:` : "(?:";
            i += g[0].length;
            continue;
          }
          if (/^\(\?\(/.test(rest)) raise(ReError, "conditional groups are not supported");
          if (/^\(\?>/.test(rest)) raise(ReError, "atomic groups are not supported");
          if (/^\(\?[aiLmsux]+\)/.test(rest)) raise(ReError, "global flags not at the start of the expression");
        }
        scopes.push(cur);
        out += c;
        i++;
        continue;
      default:
        out += lit(c, c);
        i++;
    }
  }
  if (inClass) raise(ReError, `unterminated character set at position ${p.lastIndexOf("[")}`);
  return { src: out, flags };
}

// ------------------------------------------------------------------ Pattern

export class PyPattern {
  rx: RegExp; // global search
  sticky: RegExp; // match at a position
  full: RegExp; // fullmatch at a position
  groups: number;
  names: string[]; // group index -> name ("" if unnamed), index 0 unused
  constructor(public pattern: any, public flags: number, public isBytes: boolean) {
    const text = isBytes ? Ty.decode(pattern, "latin1") : pattern;
    const t = translate(text, flags, isBytes);
    this.flags = t.flags | (isBytes ? 0 : U);
    let jf = "dgu";
    // (JS's i folds by Unicode: ASCII and bytes patterns write out their
    // letters' cases instead, CORR-BD8-1)
    if (t.flags & I && !(t.flags & A) && !isBytes) jf += "i";
    if (t.flags & S) jf += "s";
    try {
      this.rx = new RegExp(t.src, jf);
      this.sticky = new RegExp(t.src, jf.replace("g", "y"));
      this.full = new RegExp(`(?:${t.src})$`, jf.replace("g", "y"));
    } catch (e: any) {
      raise(ReError, String(e.message).replace(/^Invalid regular expression: /, ""));
    }
    // Count groups and their names from the JS source.
    this.names = [""];
    const re = /\\.|\[(?:\\.|[^\]])*\]|\((\?<([A-Za-z_]\w*)>|\?)?/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(t.src)) !== null) {
      if (mm[0].startsWith("(") && (mm[1] === undefined || mm[2] !== undefined)) this.names.push(mm[2] ?? "");
    }
    this.groups = this.names.length - 1;
  }
  str(x: any): string {
    if (this.isBytes) {
      const b = O.bufferOf(x);
      if (b === undefined || typeof x === "string") raise(T.TypeError, "cannot use a bytes pattern on a string-like object");
      return Buffer.from(b).toString("latin1");
    }
    if (typeof x !== "string") raise(T.TypeError, `cannot use a string pattern on a bytes-like object`);
    return x;
  }
  out(s: string | undefined): any {
    if (s === undefined) return null;
    return this.isBytes ? new PyBytes(new Uint8Array(Buffer.from(s, "latin1"))) : s;
  }
  exec(kind: "search" | "match" | "full", string: any, pos: any = 0, endpos: any = null): PyMatch | null {
    const s0 = this.str(string);
    let [p, e] = bounds(s0, pos, endpos);
    const s = e < s0.length ? s0.slice(0, e) : s0;
    const rx = kind === "search" ? this.rx : kind === "match" ? this.sticky : this.full;
    rx.lastIndex = p;
    const m = kind === "search" ? execAt(rx, s) : rx.exec(s);
    return m === null ? null : new PyMatch(this, string, s0, m, p, e);
  }
}

// pos and endpos, given in code points, as UTF-16 offsets into s
function bounds(s: string, pos: any, endpos: any): [number, number] {
  const sp = SP.pairs(s);
  const n = sp === null ? s.length : s.length - sp.n;
  let p = Number(pos ?? 0), e = endpos === null || endpos === undefined ? n : Number(endpos);
  if (p < 0) p = 0;
  if (p > n) p = n;
  if (e < 0) e = 0;
  if (e > n) e = n;
  e = Math.max(p, e);
  return sp === null ? [p, e] : [SP.unitOf(sp, p), SP.unitOf(sp, e)];
}

export class PyMatch {
  constructor(public re: PyPattern, public string: any, public s: string, public m: RegExpExecArray, public pos: number, public endpos: number) {}
  index(g: any): number {
    if (typeof g === "string") {
      const k = this.re.names.indexOf(g);
      if (k <= 0) raise(T.IndexError, "no such group");
      return k;
    }
    const k = Number(O.index(g));
    if (k < 0 || k > this.re.groups) raise(T.IndexError, "no such group");
    return k;
  }
  group(k: number): any {
    return this.re.out(this.m[k]);
  }
  span(k: number): [number, number] {
    const ix = (this.m as any).indices[k];
    return ix === undefined ? [-1, -1] : ix;
  }
  // span, pos and endpos as Python's: code points, not UTF-16 units
  cpSpan(k: number): [number, number] {
    const sp = this.span(k);
    const p = SP.pairs(this.s);
    return p === null || sp[0] < 0 ? sp : [SP.cpOf(p, sp[0]), SP.cpOf(p, sp[1])];
  }
  cp(u: number): number {
    const p = SP.pairs(this.s);
    return p === null ? u : SP.cpOf(p, u);
  }
}

// Python replacement template -> function of a match.
function expandTemplate(p: PyPattern, tmpl: string, m: PyMatch): string {
  let out = "";
  for (let i = 0; i < tmpl.length; i++) {
    const c = tmpl[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const d = tmpl[++i];
    if (d === undefined) raise(ReError, "bad escape (end of pattern)");
    if (d === "g") {
      const g = /^<([^>]*)>/.exec(tmpl.slice(i + 1));
      if (g === null) raise(ReError, "missing <");
      const name = g[1];
      const k = /^\d+$/.test(name) ? Number(name) : p.names.indexOf(name);
      if (k < 0 || k > p.groups) raise(/^\d+$/.test(name) ? ReError : T.IndexError, `invalid group reference ${name}`);
      out += m.m[k] ?? "";
      i += g[0].length;
    } else if (/\d/.test(d)) {
      let num = d;
      if (/\d/.test(tmpl[i + 1] ?? "")) num += tmpl[++i];
      const k = Number(num);
      if (k > p.groups) raise(ReError, `invalid group reference ${k}`);
      out += m.m[k] ?? "";
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07", b: "\b", "\\": "\\" };
      if (map[d] !== undefined) out += map[d];
      else if (/[A-Za-z]/.test(d)) raise(ReError, `bad escape \\${d}`);
      else out += "\\" + d;
    }
  }
  return out;
}

function subImpl(p: PyPattern, repl: any, string: any, count: any): [any, number] {
  const s = p.str(string);
  const n = Number(count ?? 0);
  let tmpl: string | null = null;
  if (typeof repl === "string" || repl instanceof PyBytes) tmpl = p.isBytes ? Ty.decode(repl as any, "latin1") : p.str(repl);
  let out = "", last = 0, k = 0;
  const rx = p.rx;
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seams: number[] = []; // (a replacement's ends: no lone surrogates joined, SP.checkSeams)
  while ((n === 0 || k < n) && (m = execAt(rx, s)) !== null) {
    // (Stop, every 1024 matches: a long string has millions, HARD-978-1)
    if ((k & 1023) === 1023) O.pollInterrupt();
    const pm = new PyMatch(p, string, s, m, 0, s.length);
    out += s.slice(last, m.index);
    seams.push(out.length);
    if (tmpl !== null) out += expandTemplate(p, tmpl, pm);
    else {
      const r = callObj(repl, [pm]);
      out += p.isBytes ? Ty.decode(r, "latin1") : p.str(r);
    }
    seams.push(out.length);
    last = m.index + m[0].length;
    k++;
    if (m[0].length === 0) rx.lastIndex = advance(s, m.index);
  }
  out += s.slice(last);
  return [p.out(SP.checkSeams(out, seams)), k];
}
const advance = (s: string, i: number) => (i < s.length && s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) < 0xdc00 ? i + 2 : i + 1);
// rx.exec(s), skipping a match V8 finds inside a surrogate pair (its scan
// tries zero-width matches between a pair's halves, where lookarounds see
// neither: \B in 'a😀b', CORR-BD8-3); the search goes on after the pair
const midPair = (s: string, i: number) => i > 0 && i < s.length && (s.charCodeAt(i) & 0xfc00) === 0xdc00 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800;
function execAt(rx: RegExp, s: string): RegExpExecArray | null {
  let m = rx.exec(s);
  while (m !== null && (midPair(s, m.index) || midPair(s, m.index + m[0].length))) {
    rx.lastIndex = advance(s, m.index);
    m = rx.exec(s);
  }
  return m;
}

function allMatches(p: PyPattern, string: any, pos: any = 0, endpos: any = null): PyMatch[] {
  const s0 = p.str(string);
  const [ps, e] = bounds(s0, pos, endpos);
  const s = s0.slice(0, e);
  const out: PyMatch[] = [];
  const rx = p.rx;
  rx.lastIndex = ps;
  let m: RegExpExecArray | null;
  while ((m = execAt(rx, s)) !== null) {
    if ((out.length & 1023) === 1023) O.pollInterrupt();
    out.push(new PyMatch(p, string, s0, m, ps, e));
    if (m[0].length === 0) rx.lastIndex = advance(s, m.index);
  }
  return out;
}

const cache = new Map<string, PyPattern>();
function compile(pattern: any, flags: any = 0): PyPattern {
  if (pattern instanceof PyPattern) {
    if (Number(flags) !== 0) raise(T.ValueError, "cannot process flags argument with a compiled pattern");
    return pattern;
  }
  const f = Number(O.index(typeof flags === "object" && flags !== null && "$v" in flags ? flags.$v : flags));
  const isBytes = pattern instanceof PyBytes;
  if (!isBytes && typeof pattern !== "string") raise(T.TypeError, "first argument must be string or compiled pattern");
  if (isBytes && f & U) raise(T.ValueError, "cannot use UNICODE flag with a bytes pattern");
  const key = (isBytes ? "b" : "s") + f + ":" + (isBytes ? Ty.decode(pattern, "latin1") : pattern);
  let p = cache.get(key);
  if (p === undefined) {
    p = new PyPattern(pattern, f, isBytes);
    if (cache.size > 512) cache.clear();
    cache.set(key, p);
  }
  return p;
}

newBuiltinModule("re", (mod) => {
  ReError = objectType("error", [T.Exception], new Map(), "re");
  mod.error = ReError;
  mod.PatternError = ReError;
  for (const [k, v] of Object.entries({ I, IGNORECASE: I, L, LOCALE: L, M, MULTILINE: M, S, DOTALL: S, U, UNICODE: U, X, VERBOSE: X, A, ASCII: A, NOFLAG: 0, T: 1, TEMPLATE: 1, DEBUG: 128 })) mod[k] = v;

  const Pattern = Ty.builtinTypeFor("Pattern", PyPattern, "re", () => raise(T.TypeError, "cannot create 're.Pattern' instances"));
  const Match = Ty.builtinTypeFor("Match", PyMatch, "re", () => raise(T.TypeError, "cannot create 're.Match' instances"));
  mod.Pattern = Pattern;
  mod.Match = Match;
  const P = (name: string, f: any, sg: string[] | null = null) => Ty.method(Pattern, name, f, sg ? sig(sg) : null);
  P("match", (p: PyPattern, s: any, pos: any = 0, endpos: any = null) => p.exec("match", s, pos, endpos), ["self", "string", "pos", "endpos"]);
  P("search", (p: PyPattern, s: any, pos: any = 0, endpos: any = null) => p.exec("search", s, pos, endpos), ["self", "string", "pos", "endpos"]);
  P("fullmatch", (p: PyPattern, s: any, pos: any = 0, endpos: any = null) => p.exec("full", s, pos, endpos), ["self", "string", "pos", "endpos"]);
  const findall = (p: PyPattern, s: any, pos: any = 0, endpos: any = null) =>
    allMatches(p, s, pos, endpos).map((m) => {
      if (p.groups === 0) return m.group(0);
      if (p.groups === 1) return m.group(1) ?? p.out("");
      const g: any[] = [];
      for (let k = 1; k <= p.groups; k++) g.push(m.group(k) ?? p.out(""));
      return tuple(g);
    });
  P("findall", findall, ["self", "string", "pos", "endpos"]);
  P("finditer", (p: PyPattern, s: any, pos: any = 0, endpos: any = null) => new O.ListIter(allMatches(p, s, pos, endpos)), ["self", "string", "pos", "endpos"]);
  P("sub", (p: PyPattern, repl: any, s: any, count: any = 0) => subImpl(p, repl, s, count)[0], ["self", "repl", "string", "count"]);
  P("subn", (p: PyPattern, repl: any, s: any, count: any = 0) => tuple(subImpl(p, repl, s, count)), ["self", "repl", "string", "count"]);
  const split = (p: PyPattern, string: any, maxsplit: any = 0) => {
    const s = p.str(string);
    const n = Number(maxsplit);
    const out: any[] = [];
    let last = 0, k = 0;
    for (const m of allMatches(p, string)) {
      if (n > 0 && k >= n) break;
      out.push(p.out(s.slice(last, m.m.index)));
      for (let g = 1; g <= p.groups; g++) out.push(m.group(g));
      last = m.m.index + m.m[0].length;
      k++;
    }
    out.push(p.out(s.slice(last)));
    return out;
  };
  P("split", split, ["self", "string", "maxsplit"]);
  Ty.getset(Pattern, "pattern", (p: PyPattern) => p.pattern);
  Ty.getset(Pattern, "flags", (p: PyPattern) => p.flags);
  Ty.getset(Pattern, "groups", (p: PyPattern) => p.groups);
  Ty.getset(Pattern, "groupindex", (p: PyPattern) => {
    const d = new PyDict();
    p.names.forEach((n, k) => n && dictSet(d, n, k));
    return d;
  });
  P("__repr__", (p: PyPattern) => {
    const fl: string[] = [];
    for (const [n, v] of [["IGNORECASE", I], ["LOCALE", L], ["MULTILINE", M], ["DOTALL", S], ["VERBOSE", X], ["ASCII", A]] as const) if (p.flags & v) fl.push("re." + n);
    return `re.compile(${repr(p.pattern)}${fl.length ? ", " + fl.join("|") : ""})`;
  });
  P("__eq__", (p: PyPattern, o: any) => (o instanceof PyPattern ? p.flags === o.flags && O.eqBool(p.pattern, o.pattern) : false));
  P("__hash__", (p: PyPattern) => O.hashAny(p.pattern) ^ p.flags);

  const groupArgs = (m: PyMatch, args: any[]) => {
    if (args.length === 0) return m.group(0);
    if (args.length === 1) return m.group(m.index(args[0]));
    return tuple(args.map((a) => m.group(m.index(a))));
  };
  const Mm = (name: string, f: any) => Ty.method(Match, name, f);
  Mm("group", (m: PyMatch, ...args: any[]) => groupArgs(m, args));
  Mm("__getitem__", (m: PyMatch, g: any) => m.group(m.index(g)));
  Mm("groups", (m: PyMatch, dflt: any = null) => {
    const out: any[] = [];
    for (let k = 1; k <= m.re.groups; k++) out.push(m.m[k] === undefined ? dflt : m.group(k));
    return tuple(out);
  });
  Mm("groupdict", (m: PyMatch, dflt: any = null) => {
    const d = new PyDict();
    m.re.names.forEach((n, k) => n && dictSet(d, n, m.m[k] === undefined ? dflt : m.group(k)));
    return d;
  });
  Mm("start", (m: PyMatch, g: any = 0) => m.cpSpan(m.index(g))[0]);
  Mm("end", (m: PyMatch, g: any = 0) => m.cpSpan(m.index(g))[1]);
  Mm("span", (m: PyMatch, g: any = 0) => tuple(m.cpSpan(m.index(g))));
  Mm("expand", (m: PyMatch, t: any) => m.re.out(expandTemplate(m.re, m.re.isBytes ? Ty.decode(t, "latin1") : t, m)));
  Mm("__repr__", (m: PyMatch) => `<re.Match object; span=(${m.cpSpan(0).join(", ")}), match=${repr(m.group(0))}>`);
  Mm("__bool__", (_m: PyMatch) => true);
  Ty.getset(Match, "string", (m: PyMatch) => m.string);
  Ty.getset(Match, "re", (m: PyMatch) => m.re);
  Ty.getset(Match, "pos", (m: PyMatch) => m.cp(m.pos));
  Ty.getset(Match, "endpos", (m: PyMatch) => m.cp(m.endpos));
  Ty.getset(Match, "lastindex", (m: PyMatch) => {
    let best: number | null = null, end = -1;
    for (let k = 1; k <= m.re.groups; k++) {
      const sp = m.span(k);
      if (sp[0] >= 0 && sp[1] >= end) {
        if (best === null || sp[1] > end || k < best) best = k;
        end = sp[1];
      }
    }
    return best;
  });
  Ty.getset(Match, "lastgroup", (m: PyMatch) => {
    const li = Ty.lookupDunder(m, "lastindex");
    void li;
    let best: number | null = null, end = -1;
    for (let k = 1; k <= m.re.groups; k++) {
      const sp = m.span(k);
      if (sp[0] >= 0 && sp[1] >= end) {
        best = k;
        end = sp[1];
      }
    }
    return best === null ? null : m.re.names[best] || null;
  });

  const fn = (name: string, f: any, sg: string[]) => {
    f.__name__ = name;
    f.$sig = sig(sg);
    mod[name] = f;
  };
  fn("compile", (p: any, flags: any = 0) => compile(p, flags), ["pattern", "flags"]);
  fn("match", (p: any, s: any, flags: any = 0) => compile(p, flags).exec("match", s), ["pattern", "string", "flags"]);
  fn("search", (p: any, s: any, flags: any = 0) => compile(p, flags).exec("search", s), ["pattern", "string", "flags"]);
  fn("fullmatch", (p: any, s: any, flags: any = 0) => compile(p, flags).exec("full", s), ["pattern", "string", "flags"]);
  fn("findall", (p: any, s: any, flags: any = 0) => findall(compile(p, flags), s), ["pattern", "string", "flags"]);
  fn("finditer", (p: any, s: any, flags: any = 0) => new O.ListIter(allMatches(compile(p, flags), s)), ["pattern", "string", "flags"]);
  fn("sub", (p: any, r: any, s: any, count: any = 0, flags: any = 0) => subImpl(compile(p, flags), r, s, count)[0], ["pattern", "repl", "string", "count", "flags"]);
  fn("subn", (p: any, r: any, s: any, count: any = 0, flags: any = 0) => tuple(subImpl(compile(p, flags), r, s, count)), ["pattern", "repl", "string", "count", "flags"]);
  fn("split", (p: any, s: any, maxsplit: any = 0, flags: any = 0) => split(compile(p, flags), s, maxsplit), ["pattern", "string", "maxsplit", "flags"]);
  fn("purge", () => (cache.clear(), null), []);
  const SPECIAL = new Set("()[]{}?*+-|^$\\.&~# \t\n\r\v\f".split(""));
  fn("escape", (s: any) => {
    if (s instanceof PyBytes) {
      const t = Ty.decode(s, "latin1");
      return new PyBytes(new Uint8Array(Buffer.from([...t].map((c) => (SPECIAL.has(c) ? "\\" + c : c)).join(""), "latin1")));
    }
    if (typeof s !== "string") raise(T.TypeError, `expected str or bytes, not ${typeName(s)}`);
    return [...s].map((c) => (SPECIAL.has(c) ? "\\" + c : c)).join("");
  }, ["pattern"]);
  void isinstance;
});
