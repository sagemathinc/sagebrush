// The re module on JS RegExp: Python patterns are translated to JS syntax
// (named groups, \A \Z, Python's `$`, Unicode \w \d, verbose mode, ...).
// Indices are UTF-16 code units, like the rest of the runtime's strings.

import * as SP from "./strpos";
import { T, PyBytes, PyDict, StrLayout, raise, raiseExc, typeName, tuple, objectType, callObj, dictSet, isinstance, sig, lookupType, typeOf } from "./object";
import * as Shape from "./re-shape";
import * as O from "./ops";
import * as Ty from "./types";
import { repr, str } from "./format";
import { newBuiltinModule } from "./modules";

const I = 2, L = 4, M = 8, S = 16, U = 32, X = 64, A = 256;
let ReError: any;
// (_sre.MAXREPEAT, and a {m,n} repeat as CPython's parser reads one)
const MAXREPEAT = 4294967295;
const BRACE = /\{(\d*)(?:,(\d*))?\}/y;

// ------------------------------------------------------------------ translation

const SPECIAL_JS = new Set("^$\\.*+?()[]{}|/".split(""));

// Python's str.isspace() characters (\s of a str pattern), and \w's
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// (IGNORECASE: CPython's re also makes I, i, U+0130 and U+0131 one class,
// from re._casefix; JS's simple case folding joins only I and i)
const DOTTED_I = "Ii\\u0130\\u0131";

// A PatternError as CPython's: the message, and with the pattern and a
// position, "at position N", and its line and column when the pattern has
// more than one line (Lib/re/_constants.py)
function patternError(msg: string, pattern: any = null, pos: number | null = null): never {
  throw raiseExc(ReError(msg, pattern, pos));
}

function translate(p: string, flags: number, bytes = false, pattern: any = null): { src: string; flags: number; groups: number } {
  // (positions in errors are the pattern's own: base is the length of the
  // leading flags taken off p)
  // (pos counts code points, as CPython's: at is a UTF-16 offset into p,
  // after the flags taken off, CORR-079-2)
  let base = 0;
  const whole = p;
  const perr = (msg: string, at: number): never => {
    const u = base + at;
    let cp = 0;
    for (let k = 0; k < u && k < whole.length; k++) if ((whole.charCodeAt(k) & 0xfc00) !== 0xdc00 || k === 0 || (whole.charCodeAt(k - 1) & 0xfc00) !== 0xd800) cp++;
    return patternError(msg, pattern, cp + Math.max(0, u - whole.length));
  };
  // Leading global inline flags: (?aiLmsux), as CPython's _parse_flags
  // reads them: L only in a bytes pattern, u only in a str one, and one of
  // a, u and L in each group (a and u in two groups: fix_flags, later)
  let m: RegExpExecArray | null;
  while ((m = /^\(\?([aiLmsux]+)\)/.exec(p)) !== null) {
    let own = 0;
    for (let k = 0; k < m[1].length; k++) {
      const c = m[1][k];
      const f = { a: A, i: I, L, m: M, s: S, u: U, x: X }[c]!;
      if (c === "L" && !bytes) perr("bad inline flags: cannot use 'L' flag with a str pattern", k + 3);
      if (c === "u" && bytes) perr("bad inline flags: cannot use 'u' flag with a bytes pattern", k + 3);
      own |= f;
      if (f & (A | L | U) && (own & (A | L | U)) !== f) perr("bad inline flags: flags 'a', 'u' and 'L' are incompatible", k + 3);
      flags |= f;
    }
    p = p.slice(m[0].length);
    base += m[0].length;
  }
  // (ASCII matching, \w \d \s \b and IGNORECASE: the pattern's, or a
  // scoped group's own, (?a:...), as the flags in force say)
  const asc = () => (cur & A) !== 0 || bytes;
  const verbose = (flags & X) !== 0;
  let out = "";
  let i = 0;
  let inClass = false;
  let classStart = false;
  const Wf = () => (asc() ? "a-zA-Z0-9_" : "\\p{L}\\p{N}_");
  const Df = () => (asc() ? "0-9" : "\\p{Nd}");
  const SPf = () => (asc() ? " \\t\\n\\r\\f\\v" : SPACE);
  // The flags in force (a scoped group's own, inside it), and the class
  // being read: where it starts in out, whether it is negated, and the sets
  // of the \S \W \D in it (JS cannot negate a set inside a class)
  let cur = flags;
  const scopes: number[] = [];
  // (whether JS's i is in force here: the regex's flag, then each scoped
  // group's (?i:...) or (?-i:...); an ASCII scope writes cases out instead,
  // so in one under IGNORECASE it is off)
  let jsI = (flags & I) !== 0 && !((flags & A) !== 0 || bytes);
  const jsScopes: boolean[] = [];
  let classAt = 0, classNeg = false, classPos = 0;
  let negSets: string[] = [];
  // The groups as CPython's parser counts them: how many are opened so far,
  // the open ones, the named ones, and for each open "(" its group (0 if
  // it captures none), where it is, and whether it starts the outermost
  // look-behind; behind is the number of groups before that look-behind
  // (state.lookbehindgroups), or -1 outside one
  let ngroups = 0, behind = -1;
  const open = new Set<number>();
  const byName = new Map<string, number>();
  const groups: { g: number; behind: boolean; at: number }[] = [];
  // What a repeat would repeat, as CPython's parser sees it: nothing (the
  // start of the pattern, a group or a branch), an AT code (^ $ \A \Z \b
  // \B), a repeat (and whether its ? was read), or any other item
  let last: "none" | "at" | "rep" | "item" = "none";
  let lazyRead = false;
  const repeat = (at: number) => {
    if (last === "none" || last === "at") perr("nothing to repeat", at);
    if (last === "rep") perr("multiple repeat", at);
    last = "rep";
    lazyRead = false;
  };
  // A literal character under IGNORECASE (JS's i flag folds by Unicode, so
  // ASCII and bytes patterns never have it: their letters are written as
  // both cases, CORR-BD8-1), escaped or not (CORR-BD8-2)
  const lit = (ch: string, src: string): string => {
    if (cur & I) {
      if (asc()) {
        if (/^[A-Za-z]$/.test(ch)) return `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
      } else if (ch === "I" || ch === "i" || ch === "\u0130" || ch === "\u0131") return `[${DOTTED_I}]`;
    }
    return src;
  };
  const closeClass = () => {
    const pos = out.slice(classAt + (classNeg ? 2 : 1));
    out = out.slice(0, classAt);
    const has = (ch: string) =>
      (pos !== "" && new RegExp(`[${pos}]`, "u" + (cur & I && !asc() ? "i" : "")).test(ch)) || negSets.some((n) => !new RegExp(`[${n}]`, "u").test(ch));
    let body = pos;
    if (cur & I && asc()) {
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
      if (d === undefined) perr("bad escape (end of pattern)", i);
      const esc = i;
      i += 2;
      if (!inClass) last = "item";
      switch (d) {
        // (the JS regex never has the m flag, so ^ and $ are the input's
        // ends; V8 misplaces (?![\s\S]) beside a surrogate pair in u mode;
        // in a class they are bad escapes, as CPython's _class_escape says)
        case "A":
          if (inClass) perr("bad escape \\A", esc);
          out += "^";
          last = "at";
          continue;
        case "Z":
        case "z":
          if (inClass) perr(`bad escape \\${d}`, esc);
          out += "$";
          last = "at";
          continue;
        case "w":
          out += inClass ? Wf() : `[${Wf()}]`;
          continue;
        case "W":
          if (inClass) negSets.push(Wf());
          else out += `[^${Wf()}]`;
          continue;
        case "d":
          out += inClass ? Df() : `[${Df()}]`;
          continue;
        case "D":
          if (inClass) negSets.push(Df());
          else out += `[^${Df()}]`;
          continue;
        case "s":
          out += inClass ? SPf() : `[${SPf()}]`;
          continue;
        case "S":
          if (inClass) negSets.push(SPf());
          else out += `[^${SPf()}]`;
          continue;
        // (word boundaries by \w's own characters: JS's \b knows only ASCII)
        case "b":
          if (inClass) out += "\\x08";
          else {
            out += asc() ? "\\b" : `(?:(?<=[${Wf()}])(?![${Wf()}])|(?<![${Wf()}])(?=[${Wf()}]))`;
            last = "at";
          }
          continue;
        case "B":
          if (inClass) perr("bad escape \\B", esc);
          out += asc() ? "\\B" : `(?:(?<=[${Wf()}])(?=[${Wf()}])|(?<![${Wf()}])(?![${Wf()}]))`;
          last = "at";
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
          const h = /^[0-9a-fA-F]{0,2}/.exec(p.slice(i, i + 2))![0];
          if (h.length < 2) perr(`incomplete escape \\x${h}`, esc);
          out += inClass ? "\\x" + h : lit(String.fromCharCode(parseInt(h, 16)), "\\x" + h);
          i += 2;
          continue;
        }
        // (\u and \U only in a str pattern)
        case "u": {
          if (bytes) perr("bad escape \\u", esc);
          const h = /^[0-9a-fA-F]{0,4}/.exec(p.slice(i, i + 4))![0];
          if (h.length < 4) perr(`incomplete escape \\u${h}`, esc);
          out += inClass ? "\\u" + h : lit(String.fromCharCode(parseInt(h, 16)), "\\u" + h);
          i += 4;
          continue;
        }
        case "U": {
          if (bytes) perr("bad escape \\U", esc);
          const h = /^[0-9a-fA-F]{0,8}/.exec(p.slice(i, i + 8))![0];
          if (h.length < 8) perr(`incomplete escape \\U${h}`, esc);
          const cp = parseInt(h, 16);
          if (cp > 0x10ffff) perr(`bad escape \\U${h}`, esc);
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
        // (in a class, an octal escape of up to three digits, and \8 and \9
        // bad escapes, as CPython's _class_escape reads them)
        if (inClass) {
          if (!/[0-7]/.test(d)) perr(`bad escape \\${d}`, esc);
          const o = /^[0-7]{0,2}/.exec(p.slice(i, i + 2))![0];
          i += o.length;
          const cp = parseInt(d + o, 8);
          if (cp > 0o377) perr(`octal escape value \\${d}${o} outside of range 0-0o377`, esc);
          out += `\\u{${cp.toString(16)}}`;
          continue;
        }
        // backreference, or an octal escape of three digits
        if (/[0-7]/.test(d) && /^[0-7]{2}$/.test(p.slice(i, i + 2))) {
          const o = p.slice(i, i + 2);
          i += 2;
          const cp = parseInt(d + o, 8);
          if (cp > 0o377) perr(`octal escape value \\${d}${o} outside of range 0-0o377`, esc);
          out += lit(String.fromCodePoint(cp), `\\u{${cp.toString(16)}}`);
          continue;
        }
        const num = /^\d?/.exec(p.slice(i, i + 1))![0];
        i += num.length;
        const g = Number(d + num);
        if (g > ngroups) perr(`invalid group reference ${g}`, esc + 1);
        if (open.has(g)) perr("cannot refer to an open group", esc);
        if (behind >= 0 && g > behind) perr("cannot refer to group defined in the same lookbehind subpattern", i);
        if (asc() && cur & I) raise(T.NotImplementedError, "IGNORECASE backreferences in ASCII or bytes patterns are not supported");
        out += `\\${g}`;
        continue;
      }
      if (/[A-Za-z]/.test(d)) perr(`bad escape \\${d}`, esc);
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
        classPos = i;
        last = "item";
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
        last = "at";
        continue;
      case "^":
        out += cur & M ? "(?:^|(?<=\\n))" : "^";
        i++;
        last = "at";
        continue;
      // (Python's . is every character but \n, or every one with DOTALL;
      // JS's also leaves out \r, U+2028 and U+2029)
      case ".":
        out += cur & S ? "[\\s\\S]" : "[^\\n]";
        i++;
        last = "item";
        continue;
      case ")": {
        const gr = groups.pop();
        if (gr === undefined) perr("unbalanced parenthesis", i);
        if (gr!.g) open.delete(gr!.g);
        if (gr!.behind) behind = -1;
        cur = scopes.pop() ?? cur;
        jsI = jsScopes.pop() ?? jsI;
        out += c;
        i++;
        last = "item";
        continue;
      }
      // Repeats, as CPython's parser reads them: of the item before, not
      // of nothing, an AT code or another repeat; {} and an unclosed { are
      // literal; then ? for a lazy one (+, possessive, is not implemented)
      case "{": {
        BRACE.lastIndex = i;
        const q = BRACE.exec(p);
        if (q === null || q[0] === "{}") {
          out += "\\{";
          i++;
          last = "item";
          continue;
        }
        repeat(i);
        const lo = q[1] === "" ? 0 : Number(q[1]), hi = q[2] === undefined ? lo : q[2] === "" ? Infinity : Number(q[2]);
        if (lo >= MAXREPEAT || (hi !== Infinity && hi >= MAXREPEAT)) raise(T.OverflowError, "the repetition number is too large");
        if (hi < lo) perr("min repeat greater than max repeat", i + 1);
        out += q[2] === undefined ? `{${lo}}` : `{${lo},${hi === Infinity ? "" : hi}}`;
        i += q[0].length;
        continue;
      }
      case "*":
      case "+":
      case "?":
        if (last === "rep" && !lazyRead && c !== "*") {
          if (c === "+") raise(T.NotImplementedError, "possessive repeats (*+, ++, ?+ and {m,n}+) are not supported");
          lazyRead = true;
        } else repeat(i);
        out += c;
        i++;
        continue;
      case "}":
      case "]":
        out += "\\" + c;
        i++;
        last = "item";
        continue;
      case "|":
        out += c;
        i++;
        last = "none";
        continue;
      case "/":
        out += "\\/";
        i++;
        last = "item";
        continue;
      case "(": {
        // (a comment leaves what a repeat after it would repeat)
        const before = last;
        last = "none";
        if (p[i + 1] === "?") {
          let g: RegExpExecArray | null;
          const at = (rx: RegExp) => ((rx.lastIndex = i), rx.exec(p));
          if ((g = at(/\(\?P<([A-Za-z_]\w*)>/y))) {
            ngroups++;
            byName.set(g[1], ngroups);
            open.add(ngroups);
            groups.push({ g: ngroups, behind: false, at: i });
            scopes.push(cur);
            jsScopes.push(jsI);
            out += `(?<${g[1]}>`;
            i += g[0].length;
            continue;
          }
          if ((g = at(/\(\?P=([A-Za-z_]\w*)\)/y))) {
            // (CPython's checks: a name not yet defined, an open group, one
            // in the same look-behind)
            const k = byName.get(g[1]);
            if (k === undefined) perr(`unknown group name '${g[1]}'`, i + 4);
            if (open.has(k!)) perr("cannot refer to an open group", i + 4);
            if (behind >= 0 && k! > behind) perr("cannot refer to group defined in the same lookbehind subpattern", i + g[0].length);
            if (asc() && cur & I) raise(T.NotImplementedError, "IGNORECASE backreferences in ASCII or bytes patterns are not supported");
            out += `\\k<${g[1]}>`;
            i += g[0].length;
            last = "item";
            continue;
          }
          if ((g = at(/\(\?#[^)]*\)/y))) {
            i += g[0].length;
            last = before;
            continue;
          }
          if ((g = at(/\(\?(=|!|<=|<!)/y))) {
            // (a look-behind: the groups before it, for CPython's
            // checklookbehindgroup)
            const lb = g[1][0] === "<" && behind < 0;
            if (lb) behind = ngroups;
            groups.push({ g: 0, behind: lb, at: i });
            scopes.push(cur);
            jsScopes.push(jsI);
            out += g[0];
            i += g[0].length;
            continue;
          }
          if (p[i + 2] === "<") {
            if (i + 3 >= p.length) perr("unexpected end of pattern", p.length);
            perr(`unknown extension ?<${String.fromCodePoint(p.codePointAt(i + 3)!)}`, i + 1);
          }
          if (/[aiLmsux-]/.test(p[i + 2] ?? "")) {
            // (flags, read as CPython's _parse_flags reads them, for its
            // errors: positions are where its source is when it raises)
            const F: Record<string, number> = { a: A, i: I, L, m: M, s: S, u: U, x: X };
            const alpha = (ch: string) => /\p{L}/u.test(ch);
            let k = i + 2, ch: string | undefined = p[k++], add = 0, del = 0;
            if (ch !== "-") {
              for (;;) {
                const f = F[ch!];
                if (ch === "L" && !bytes) perr("bad inline flags: cannot use 'L' flag with a str pattern", k);
                if (ch === "u" && bytes) perr("bad inline flags: cannot use 'u' flag with a bytes pattern", k);
                add |= f;
                if (f & (A | L | U) && (add & (A | L | U)) !== f) perr("bad inline flags: flags 'a', 'u' and 'L' are incompatible", k);
                ch = p[k++];
                if (ch === undefined) perr("missing -, : or )", p.length);
                if (ch === ")" || ch === "-" || ch === ":") break;
                if (F[ch!] === undefined) perr(alpha(ch!) ? "unknown flag" : "missing -, : or )", k - 1);
              }
            }
            if (ch === ")") perr("global flags not at the start of the expression", i);
            if (ch === "-") {
              ch = p[k++];
              if (ch === undefined) perr("missing flag", p.length);
              if (F[ch!] === undefined) perr(alpha(ch!) ? "unknown flag" : "missing flag", k - 1);
              for (;;) {
                const f = F[ch!];
                if (f & (A | L | U)) perr("bad inline flags: cannot turn off flags 'a', 'u' and 'L'", k);
                del |= f;
                ch = p[k++];
                if (ch === undefined) perr("missing :", p.length);
                if (ch === ":") break;
                if (F[ch!] === undefined) perr(alpha(ch!) ? "unknown flag" : "missing :", k - 1);
              }
            }
            if (add & del) perr("bad inline flags: flag turned on and off", k - 1);
          }
          if ((g = at(/\(\?([aiLmsux]*)(?:-([imsx]+))?:/y)) && (g[1] || g[2])) {
            // scoped flags: m and s are this translation's own (^, $ and .);
            // i is JS's modifier, and is in force for the class rules too;
            // a makes the group's \w \d \s \b and IGNORECASE ASCII's
            // (string.Template's (?a:[_a-z][_a-z0-9]*))
            // (L and x in a scope are not implemented: refused, not ignored;
            // u is a str pattern's default, and refused inside an ASCII one,
            // CORR-6A0-1, or beside a, which CPython refuses too)
            if (/[Lx]/.test(g[1] + (g[2] ?? "")) || (asc() && g[1].includes("u"))) raise(T.NotImplementedError, `scoped flags (?${g[1]}${g[2] ? "-" + g[2] : ""}:...) are not supported`);
            groups.push({ g: 0, behind: false, at: i });
            scopes.push(cur);
            jsScopes.push(jsI);
            for (const f of g[1]) if (f === "i" || f === "m" || f === "s" || f === "a") cur |= { i: I, m: M, s: S, a: A }[f]!;
            for (const f of g[2] ?? "") if (f === "i" || f === "m" || f === "s") cur &= ~{ i: I, m: M, s: S }[f]!;
            // (JS's i as this group needs it: on for a Unicode IGNORECASE,
            // off in an ASCII one, which lit and closeClass write out)
            const want = (cur & I) !== 0 && !asc();
            out += want === jsI ? "(?:" : want ? "(?i:" : "(?-i:";
            jsI = want;
            i += g[0].length;
            continue;
          }
          if (p[i + 2] === ":") {
            groups.push({ g: 0, behind: false, at: i });
            scopes.push(cur);
            jsScopes.push(jsI);
            out += "(?:";
            i += 3;
            continue;
          }
          if (p[i + 2] === "(") raise(T.NotImplementedError, "conditional groups, (?(1)...|...), are not supported");
          if (p[i + 2] === ">") raise(T.NotImplementedError, "atomic groups, (?>...), are not supported");
          if (i + 2 >= p.length) perr("unexpected end of pattern", p.length);
          if (p[i + 2] === "P") perr(i + 3 >= p.length ? "unexpected end of pattern" : `unknown extension ?P${String.fromCodePoint(p.codePointAt(i + 3)!)}`, i + 3 >= p.length ? p.length : i + 1);
          perr(`unknown extension ?${String.fromCodePoint(p.codePointAt(i + 2)!)}`, i + 1);
        } else {
          ngroups++;
          open.add(ngroups);
          groups.push({ g: ngroups, behind: false, at: i });
        }
        scopes.push(cur);
        jsScopes.push(jsI);
        out += c;
        i++;
        continue;
      }
      default:
        out += lit(c, c);
        i++;
        last = "item";
    }
  }
  if (inClass) perr("unterminated character set", classPos);
  if (groups.length) perr("missing ), unterminated subpattern", groups[groups.length - 1].at);
  return { src: out, flags, groups: ngroups };
}

// ------------------------------------------------------------------ Pattern

export class PyPattern {
  rx!: RegExp; // global search
  sticky!: RegExp; // match at a position
  full!: RegExp; // fullmatch at a position
  groups: number;
  names: string[]; // group index -> name ("" if unnamed), index 0 unused
  shape: Shape.Shape; // the groups as JS has them, and what must_advance needs
  private jf: string;
  private nonEmpty = new Map<string, RegExp>();
  constructor(public pattern: any, public flags: number, public isBytes: boolean) {
    const text = isBytes ? Ty.decode(pattern, "latin1") : pattern;
    const t = translate(text, flags, isBytes, pattern);
    this.flags = fixFlags(t.flags, isBytes);
    let jf = "dgu";
    // (JS's i folds by Unicode: ASCII and bytes patterns write out their
    // letters' cases instead, CORR-BD8-1)
    if (t.flags & I && !(t.flags & A) && !isBytes) jf += "i";
    if (t.flags & S) jf += "s";
    this.jf = jf;
    const jsError = (e: any): never => raise(ReError, String(e.message).replace(/^Invalid regular expression: /, ""));
    // (the source as re-shape.ts writes it again: where JS and sre would
    // disagree, rewritten or refused)
    const sh = Shape.shape(t.src, (msg) => raise(T.NotImplementedError, msg), (msg) => patternError(msg));
    if (sh === null) {
      try {
        new RegExp(t.src, jf);
      } catch (e: any) {
        jsError(e);
      }
      raise(T.NotImplementedError, "this pattern could not be read back after its translation to a JavaScript regular expression (a limit of Sagebrush's re)");
    }
    this.shape = sh;
    try {
      this.rx = new RegExp(sh.src, jf);
      this.sticky = new RegExp(sh.src, jf.replace("g", "y"));
      this.full = new RegExp(`(?:${sh.src})$`, jf.replace("g", "y"));
    } catch (e: any) {
      jsError(e);
    }
    this.names = sh.names;
    this.groups = sh.groups;
  }
  // A match at i that is not empty: what CPython's scan looks for at i
  // after an empty match there (state->must_advance: SRE_OP_SUCCESS fails
  // the match where it ends, at toplevel, so the pattern backtracks for a
  // longer one, in its own order). The same pattern, ended by a look-behind
  // that fails at i, run sticky on a slice of s that starts as far before
  // i as the pattern can look back (so the look-behind costs that much, not
  // i), with ^ never matching when the slice starts after 0.
  nonEmptyAt(s: string, i: number): RegExpExecArray | null {
    const sh = this.shape;
    if (!sh.canConsume || i >= s.length) return null;
    let j = i, k = 0;
    while (k < sh.back && j > 0) {
      j -= j >= 2 && (s.charCodeAt(j - 1) & 0xfc00) === 0xdc00 && (s.charCodeAt(j - 2) & 0xfc00) === 0xd800 ? 2 : 1;
      k++;
    }
    const key = `${k}${j > 0 && sh.caret ? "^" : ""}`;
    let rx = this.nonEmpty.get(key);
    if (rx === undefined) {
      const src = j > 0 && sh.caret ? sh.variant : sh.src;
      rx = new RegExp(`(?:${src})(?<!^[\\s\\S]{${k}})`, this.jf.replace("g", "y"));
      // (one per distance from the start within the look-behind's reach,
      // and one past it: a long look-behind's are not all kept)
      if (this.nonEmpty.size >= 64) this.nonEmpty.clear();
      this.nonEmpty.set(key, rx);
    }
    const t = j === 0 ? s : s.slice(j);
    rx.lastIndex = i - j;
    const m = rx.exec(t);
    if (m === null) return null;
    if (j === 0) return midPair(s, m.index + m[0].length) ? null : m;
    // (the match on s: its indices shifted back by where the slice starts)
    const out: any = [...m];
    out.index = m.index + j;
    out.input = s;
    out.indices = (m as any).indices.map((x: [number, number] | undefined) => (x === undefined ? undefined : [x[0] + j, x[1] + j]));
    return midPair(s, out.index + m[0].length) ? null : out;
  }
  // (the subject, as CPython's getstring reads it: a str, a str subclass by
  // its payload, or a bytes-like object, else "expected string or
  // bytes-like object"; then it must be the pattern's kind)
  str(x: any): string {
    const text = typeof x === "string" ? x : x instanceof StrLayout ? (x.$v as string) : undefined;
    const b = text === undefined ? O.bufferOf(x) : undefined;
    if (text === undefined && b === undefined) raise(T.TypeError, `expected string or bytes-like object, got '${typeName(x)}'`);
    if (this.isBytes) {
      if (text !== undefined) raise(T.TypeError, "cannot use a bytes pattern on a string-like object");
      return Buffer.from(b!).toString("latin1");
    }
    if (text === undefined) raise(T.TypeError, "cannot use a string pattern on a bytes-like object");
    return text!;
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
  m: RegExpExecArray; // the match by Python's groups
  // (raw: the match as JS made it, by its own groups)
  constructor(public re: PyPattern, public string: any, public s: string, public raw: RegExpExecArray, public pos: number, public endpos: number) {
    this.m = Shape.normalize(re.shape, raw);
  }
  lastIndex(): number | null {
    return Shape.lastIndex(this.re.shape, this.raw);
  }
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
// A template's pieces, as CPython's _parser.parse_template makes them:
// literal chunks (escapes done, consecutive ones merged) and group numbers
type Piece = { lit: string } | { group: number };
function templatePieces(p: PyPattern, tmpl: string): Piece[] {
  const out: Piece[] = [];
  let lit = "";
  const group = (k: number) => {
    if (lit) out.push({ lit });
    lit = "";
    out.push({ group: k });
  };
  for (let i = 0; i < tmpl.length; i++) {
    const c = tmpl[i];
    if (c !== "\\") {
      lit += c;
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
      group(k);
      i += g[0].length;
    } else if (/\d/.test(d)) {
      let num = d;
      if (/\d/.test(tmpl[i + 1] ?? "")) num += tmpl[++i];
      const k = Number(num);
      if (k > p.groups) raise(ReError, `invalid group reference ${k}`);
      group(k);
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07", b: "\b", "\\": "\\" };
      if (map[d] !== undefined) lit += map[d];
      else if (/[A-Za-z]/.test(d)) raise(ReError, `bad escape \\${d}`);
      else lit += "\\" + d;
    }
  }
  if (lit) out.push({ lit });
  return out;
}
function expandTemplate(p: PyPattern, tmpl: string, m: PyMatch): string {
  return templatePieces(p, tmpl).map((x) => ("lit" in x ? x.lit : (m.m[x.group] ?? ""))).join("");
}
// (a template of the other kind than the pattern: its pieces joined in its
// own kind, as CPython's expand_template does, so the first matched group,
// of the pattern's kind, is refused by its place in that join: the first
// literal always there, empty or not, a later literal only if not empty, a
// group only if it matched; with no group matched, the joined literals, a
// piece of the wrong kind for the outer join)
function expandOtherKind(p: PyPattern, pieces: Piece[], m: PyMatch): void {
  let at = 1;
  for (const x of pieces.length && "lit" in pieces[0] ? pieces.slice(1) : pieces) {
    if ("lit" in x) at++;
    else if (m.m[x.group] !== undefined)
      raise(T.TypeError, `sequence item ${at}: expected ${p.isBytes ? "str instance, bytes" : "a bytes-like object, str"} found`);
  }
}

// The replacement, as CPython's pattern_subx takes it: a callable first
// (a callable str subclass is called); else a template of the pattern's
// kind (str or a str subclass for a str pattern, a bytes-like object for a
// bytes one); else, of the other kind, a literal piece, refused only when
// the pieces are joined, so not when nothing matched; anything else at once
// ("decoding to str: need a bytes-like object, int found").
// (an other-kind template is parsed once, here: its pieces, and its
// literals joined in its own kind, kept for every match, daybreak2's
// RE-LIMIT-C0D-1)
type Repl = { call: any } | { tmpl: string } | { literal: any } | { other: Piece[]; lits: any };
function replOf(p: PyPattern, repl: any): Repl {
  // (callable() as the builtin decides it)
  if (typeof repl === "function" || lookupType(typeOf(repl), "__call__") !== undefined) return { call: repl };
  const text = typeof repl === "string" ? repl : repl instanceof StrLayout ? (repl.$v as string) : undefined;
  const b = text === undefined ? O.bufferOf(repl) : undefined;
  if (text === undefined && b === undefined) raise(T.TypeError, `decoding to str: need a bytes-like object, ${typeName(repl)} found`);
  const own = b !== undefined ? Buffer.from(b.buffer, b.byteOffset, b.length).toString("latin1") : text!;
  if (p.isBytes ? b !== undefined : text !== undefined) return { tmpl: own };
  // (the other kind: parsed as a template all the same; without groups it
  // is one literal piece, of its own kind)
  const pieces = templatePieces(p, own);
  if (!pieces.some((x) => "group" in x)) return { literal: repl };
  const lits = pieces.map((x) => ("lit" in x ? x.lit : "")).join("");
  return { other: pieces, lits: p.isBytes ? lits : new PyBytes(new Uint8Array(Buffer.from(lits, "latin1"))) };
}

function subImpl(p: PyPattern, repl: any, string: any, count: any): [any, number] {
  const s = p.str(string);
  const n = Number(count ?? 0);
  const r = replOf(p, repl);
  let out = "", last = 0, k = 0;
  // (the pieces CPython joins: each non-empty stretch of the subject, and
  // each replacement but a callable's None; the first of the wrong kind is
  // refused after every match is made, as the join does, by its place)
  let piece = 0, bad: { at: number; v: any } | null = null;
  const add = (v: any) => {
    if (bad === null) {
      const text = p.isBytes ? undefined : typeof v === "string" ? v : v instanceof StrLayout ? (v.$v as string) : undefined;
      const b = p.isBytes && typeof v !== "string" && !(v instanceof StrLayout) ? O.bufferOf(v) : undefined;
      if (text !== undefined) out += text;
      else if (b !== undefined) out += Buffer.from(b.buffer, b.byteOffset, b.length).toString("latin1");
      else bad = { at: piece, v };
    }
    piece++;
  };
  const seams: number[] = []; // (a replacement's ends: no lone surrogates joined, SP.checkSeams)
  scan(p, s, 0, (m) => {
    if (n !== 0 && k >= n) return false;
    // (Stop, every 1024 matches: a long string has millions, HARD-978-1)
    if ((k & 1023) === 1023) O.pollInterrupt();
    const pm = new PyMatch(p, string, s, m, 0, s.length);
    if (m.index > last) {
      out += s.slice(last, m.index);
      piece++;
    }
    seams.push(out.length);
    if ("tmpl" in r) {
      out += expandTemplate(p, r.tmpl, pm);
      piece++;
    } else if ("literal" in r) add(r.literal);
    else if ("other" in r) {
      expandOtherKind(p, r.other, pm);
      // (no group matched: the template's literals, joined in its kind, one
      // piece of the wrong kind, refused when the pieces are joined)
      add(r.lits);
    }
    else {
      const v = callObj(r.call, [pm]);
      if (v !== null) add(v);
    }
    seams.push(out.length);
    last = m.index + m[0].length;
    k++;
    return true;
  });
  if (bad !== null) {
    const { at, v } = bad;
    raise(T.TypeError, `sequence item ${at}: expected ${p.isBytes ? "a bytes-like object" : "str instance"}, ${typeName(v)} found`);
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

// The matches of a scan from `from`, in order, to each until it returns
// false, as CPython's scans find them (pattern_findall, pattern_subx and
// the scanner): after a match the next starts where it ended; after an
// empty one at i, the next is one at i that is not empty if there is one
// (must_advance), else the next from i + 1 (A22)
function scan(p: PyPattern, s: string, from: number, each: (m: RegExpExecArray) => boolean): void {
  const rx = p.rx;
  let at = from;
  for (;;) {
    rx.lastIndex = at;
    const m = execAt(rx, s);
    if (m === null || !each(m)) return;
    if (m[0].length !== 0) {
      at = m.index + m[0].length;
      continue;
    }
    const n = p.nonEmptyAt(s, m.index);
    if (n !== null) {
      if (!each(n)) return;
      at = n.index + n[0].length;
      continue;
    }
    if (m.index >= s.length) return;
    at = advance(s, m.index);
  }
}

function allMatches(p: PyPattern, string: any, pos: any = 0, endpos: any = null): PyMatch[] {
  const s0 = p.str(string);
  const [ps, e] = bounds(s0, pos, endpos);
  const s = s0.slice(0, e);
  const out: PyMatch[] = [];
  scan(p, s, ps, (m) => {
    if ((out.length & 1023) === 1023) O.pollInterrupt();
    out.push(new PyMatch(p, string, s0, m, ps, e));
    return true;
  });
  return out;
}

// The flags as CPython's _parser.fix_flags checks them, the pattern read:
// a str pattern is UNICODE unless ASCII, and never LOCALE; a bytes one is
// never UNICODE, nor both ASCII and LOCALE
function fixFlags(flags: number, bytes: boolean): number {
  if (!bytes) {
    if (flags & L) raise(T.ValueError, "cannot use LOCALE flag with a str pattern");
    if (!(flags & A)) return flags | U;
    if (flags & U) raise(T.ValueError, "ASCII and UNICODE flags are incompatible");
    return flags;
  }
  if (flags & U) raise(T.ValueError, "cannot use UNICODE flag with a bytes pattern");
  if (flags & L && flags & A) raise(T.ValueError, "ASCII and LOCALE flags are incompatible");
  return flags;
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
  // (PatternError, error its old name, as Lib/re/_constants.py has it)
  ReError = objectType("PatternError", [T.Exception], new Map(), "re");
  Ty.method(
    ReError,
    "__init__",
    (self: any, msg: any, pattern: any = null, pos: any = null) => {
      self.msg = msg;
      self.pattern = pattern;
      self.pos = pos;
      let text = msg;
      if (pattern !== null && pos !== null) {
        text = `${str(msg)} at position ${str(pos)}`;
        // (lineno and colno counted in code points, as CPython's are)
        const s = pattern instanceof PyBytes ? Ty.decode(pattern, "latin1") : typeof pattern === "string" ? pattern : str(pattern);
        const k = Number(pos);
        const before = Array.from(s).slice(0, k);
        self.lineno = before.filter((ch) => ch === "\n").length + 1;
        self.colno = k - before.lastIndexOf("\n");
        if (s.includes("\n")) text = `${text} (line ${self.lineno}, column ${self.colno})`;
      } else self.lineno = self.colno = null;
      self.args = tuple([text]);
      return null;
    },
    sig(["self", "msg", "pattern", "pos"]),
  );
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
  // (sre's lastindex, the group that closed last, and its name, A25)
  Ty.getset(Match, "lastindex", (m: PyMatch) => m.lastIndex());
  Ty.getset(Match, "lastgroup", (m: PyMatch) => {
    const k = m.lastIndex();
    return k === null ? null : m.re.names[k] || null;
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
