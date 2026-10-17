// The _json module: what CPython's C accelerator gives lib/json (its
// encoder.py, decoder.py and scanner.py are CPython's, unchanged), so that
// json.dumps and json.loads run here, not in their pure-Python fallbacks:
// make_scanner (loads), make_encoder (dumps' one-shot encoding), scanstring
// and encode_basestring(_ascii). Outputs, errors, their messages and
// positions, and the notes added to errors are CPython 3.14's C module's
// (test/json_accel_cases.py compares them).
//
// Positions are Python's, code points: a string with astral characters is
// indexed through strpos.

import { T, DONE, raise, typeOf, typeName, isinstance, callObj, getattr, PyDict, dictSet, dictKeyOf, tuple, FloatBox, toPyExc, newException, builtin, unbox } from "./object";
import { newBuiltinModule, importModule } from "./modules";
import { mkfloat, iter, index, pollInterrupt } from "./ops";
import { floatRepr, decimalOf, repr as pyRepr } from "./format";
import * as SP from "./strpos";

// Stop reaches every long loop here (HARD-C0E-2): a scan of characters
// polls at every 4096th, a loop over values, frames or escapes every 4096
// steps (step), so that a huge flat loads or dumps, or a default() that keeps
// the traversal going, stops at once.
let steps = 0;
function step() {
  if (++steps >= 4096) {
    steps = 0;
    pollInterrupt();
  }
}
// an iterable's items, polling (toArray's loop doesn't: a subclass's
// __iter__ that never ends stops here, HARD-A73-1)
// (a TypeError getting the iterator is CPython's `msg`, as its
// PySequence_Fast and PyMapping_Items replace it)
function collect(x: any, msg?: () => string): any[] {
  const out: any[] = [];
  let it: any;
  try {
    it = iter(x);
  } catch (e) {
    if (msg === undefined || !isinstance(toPyExc(e), T.TypeError)) throw e;
    raise(T.TypeError, msg());
  }
  for (let v = it.$next(); v !== DONE; v = it.$next()) {
    step();
    out.push(v);
  }
  return out;
}
// a list or tuple subclass's items, from its own __iter__ (which must give
// an iterator), as CPython's PySequence_Fast lists it
function subclassItems(o: any): any[] {
  const msg = () => "_iterencode_list needs a sequence";
  let it: any;
  try {
    it = callObj(getattr(o, "__iter__"), []);
  } catch (e) {
    if (!isinstance(toPyExc(e), T.TypeError)) throw e;
    raise(T.TypeError, msg());
  }
  // (an iterable that isn't an iterator: iter()'s TypeError)
  let next = true;
  try {
    getattr(it, "__next__");
  } catch {
    next = false;
  }
  if (!next) raise(T.TypeError, msg());
  return collect(it, msg);
}
const scanPoll = (i: number) => {
  if ((i & 4095) === 0) pollInterrupt();
};

// A Py_ssize_t argument, as CPython's "n" converts it: the index protocol,
// an OverflowError past 64 bits (CORR-C0E-3)
function ssize(x: any): number {
  const v = index(x);
  if (typeof v === "bigint") {
    if (v > 9223372036854775807n || v < -9223372036854775808n) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
    return Number(v);
  }
  return v;
}

const HEX = "0123456789abcdef";
// The deepest nesting either way, arrays and objects (the empty innermost
// one too): CPython's C module is limited by its C stack, about 8 MB (40000
// levels pass, 60000 fail, on CPython 3.14 here); a fixed budget makes level
// 40001 a RecursionError every time, HARD-C0E-1.
export const MAX_DEPTH = 40000;
const hex4 = (c: number) => "\\u" + HEX[(c >> 12) & 15] + HEX[(c >> 8) & 15] + HEX[(c >> 4) & 15] + HEX[c & 15];

// ------------------------------------------------------------------ strings out
// encode_basestring_ascii: '"' + s with \ " and controls escaped, and every
// code unit outside ' '..'~' as \uXXXX (an astral character as its pair)
function encodeAscii(s: string): string {
  let out = "", last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    scanPoll(i);
    if (c >= 0x20 && c <= 0x7e && c !== 0x22 && c !== 0x5c) continue;
    if (i > last) out += s.slice(last, i);
    out += esc(c, true);
    last = i + 1;
  }
  return '"' + (last === 0 ? s : out + s.slice(last)) + '"';
}
// encode_basestring: only \ " and the controls escaped
function encodeUnicode(s: string): string {
  let out = "", last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    scanPoll(i);
    if (c >= 0x20 && c !== 0x22 && c !== 0x5c) continue;
    if (i > last) out += s.slice(last, i);
    out += esc(c, false);
    last = i + 1;
  }
  return '"' + (last === 0 ? s : out + s.slice(last)) + '"';
}
function esc(c: number, ascii: boolean): string {
  switch (c) {
    case 0x22: return '\\"';
    case 0x5c: return "\\\\";
    case 0x0a: return "\\n";
    case 0x0d: return "\\r";
    case 0x09: return "\\t";
    case 0x08: return "\\b";
    case 0x0c: return "\\f";
  }
  return c < 0x20 || ascii ? hex4(c) : String.fromCharCode(c);
}

// a str (a subclass's contents, as the C module reads them)
function strOf(x: any): string {
  return typeof x === "string" ? x : unbox(x);
}
function encodeStr(x: any): string {
  return typeof x === "string" ? encodeAscii(x) : encodeAscii(strOf(x));
}

// ------------------------------------------------------------------ dumps
function add_note(e: any, msg: string): any {
  const pe = toPyExc(e);
  try {
    callObj(getattr(pe, "add_note"), [msg]);
  } catch {}
  return pe;
}

function makeEncoder(markers: any, dflt: any, encoder: any, indent: any, keySep: any, itemSep: any, sortKeys: any, skipKeys: any, allowNan: any): any {
  const check = markers !== null;
  const seen = new Set<any>();
  const ascii = encoder === M.encode_basestring_ascii, uni = encoder === M.encode_basestring;
  const enc = (s: any): string => {
    if (ascii) return typeof s === "string" ? encodeAscii(s) : encodeAscii(strOf(s));
    if (uni) return encodeUnicode(strOf(s));
    const r = callObj(encoder, [s]);
    if (typeof r !== "string") raise(T.TypeError, `encoder() must return a string, not ${typeName(r)}`);
    return r;
  };
  // (the separators str, as make_encoder's "U" arguments, CORR-C0E-2; a
  // subclass's str() written each time it is, as CPython's C encoder does,
  // but read by contents where an indent's newline is added to the item
  // separator; an indent that isn't a str refused where CPython's encoder
  // first adds it to one)
  const sepOf = (x: any, n: number): string => {
    if (!isinstance(x, T.str)) raise(T.TypeError, `make_encoder() argument ${n} must be str, not ${x === null ? "None" : typeName(x)}`);
    return strOf(x);
  };
  const ks = sepOf(keySep, 5), is = sepOf(itemSep, 6);
  const ksObj = typeof keySep === "string" ? null : keySep, isObj = typeof itemSep === "string" ? null : itemSep;
  const strCall = (x: any): string => strOf(callObj(T.str, [x]));
  const sepText = (f: Frame): string => (isObj !== null && f.nl === null ? strCall(isObj) : f.sep);
  const indBad = indent !== null && !isinstance(indent, T.str);
  const ind: string | null = indent === null ? null : indBad ? "" : strOf(indent);
  const indent1 = () => {
    if (indBad) raise(T.TypeError, `can only concatenate str (not "${typeName(indent)}") to str`);
  };
  const sorted = importModule("builtins").sorted;
  const allow = !!O_truth(allowNan), skip = !!O_truth(skipKeys), sortk = !!O_truth(sortKeys);

  const floatStr = (o: any): string => {
    // (a subclass's stored value, its __float__ not called, CORR-C0E-1)
    const v = typeof o === "number" ? o : unbox(o);
    const fv: number = v instanceof FloatBox ? v.v : v;
    if (fv !== fv || fv === Infinity || fv === -Infinity) {
      if (!allow) raise(T.ValueError, "Out of range float values are not JSON compliant: " + pyRepr(o));
      return fv !== fv ? "NaN" : fv > 0 ? "Infinity" : "-Infinity";
    }
    return floatRepr(fv);
  };
  // (a big int's digits within sys's int_max_str_digits, CORR-C0E-6)
  const intStr = (o: any): string => (typeof o === "number" ? String(o) : typeof o === "bigint" ? decimalOf(o) : callObj(getattr(T.int, "__repr__"), [o]));

  // a scalar's text, or null for a container or another object
  const scalar = (o: any): string | null => {
    switch (typeof o) {
      case "string": return enc(o);
      case "boolean": return o ? "true" : "false";
      case "number": return Number.isInteger(o) ? String(o) : floatStr(o);
      case "bigint": return decimalOf(o);
    }
    if (o === null) return "null";
    if (o instanceof FloatBox) return floatStr(o);
    const t = typeOf(o);
    if (t.$mro.includes(T.str)) return enc(o);
    if (t.$mro.includes(T.int)) return intStr(o);
    if (t.$mro.includes(T.float)) return floatStr(o);
    return null;
  };

  // (iterative, a frame per open container, so that nesting as deep as
  // CPython's C encoder takes is no deeper JS stack; a frame's note is
  // added to an error raised while its current item is encoded, inValue)
  type Frame = { kind: number; o: any; items: any[]; i: number; sep: string; nl: string | null; level: number; key: any; inValue: boolean; raw?: boolean; live?: Iterator<[any, any]> | null };
  const LIST = 0, DICT = 1, DEFAULT = 2;
  let out = "";
  const stack: Frame[] = [];
  const keyText = new Map<string, string>();

  const deeper = () => {
    if (stack.length >= MAX_DEPTH) raise(T.RecursionError, "maximum recursion depth exceeded while encoding a JSON object");
  };
  const enter = (o: any) => {
    if (!check) return;
    if (seen.has(o)) raise(T.ValueError, "Circular reference detected");
    seen.add(o);
  };
  const leave = (o: any) => {
    if (check) seen.delete(o);
  };

  // a value: a scalar written at once, a container a new frame
  function value(o: any, level: number) {
    const sc = scalar(o);
    if (sc !== null) {
      out += sc;
      return;
    }
    const t = typeOf(o);
    if (t === T.list || t === T.tuple) return openList(o, o, level);
    if (t.$mro.includes(T.list) || t.$mro.includes(T.tuple)) return openList(o, subclassItems(o), level);
    if (t.$mro.includes(T.dict)) return openDict(o, level);
    enter(o);
    const n = callObj(dflt, [o]);
    deeper();
    stack.push({ kind: DEFAULT, o, items: [n], i: 0, sep: "", nl: null, level, key: null, inValue: false });
  }
  function openList(o: any, items: any[], level: number) {
    deeper();
    if (items.length === 0) {
      out += "[]";
      return;
    }
    enter(o);
    out += "[";
    let nl: string | null = null, sep = is;
    if (ind !== null) {
      indent1();
      level++;
      nl = "\n" + ind.repeat(level);
      sep = is + nl;
      out += nl;
    }
    stack.push({ kind: LIST, o, items, i: 0, sep, nl, level, key: null, inValue: false });
  }
  function openDict(o: any, level: number) {
    deeper();
    let items: any[];
    let raw = false;
    let live: Iterator<[any, any]> | null = null;
    if (typeOf(o) === T.dict && !sortk) {
      // (an exact dict's entries iterated live, as CPython's C encoder does:
      // what default() adds or deletes meanwhile shows; a key is its Python
      // object only when it isn't a str, dictKeyOf)
      const d = o as PyDict;
      if (d.$m.size === 0) {
        out += "{}";
        return;
      }
      items = [];
      raw = true;
      live = d.$m.entries();
    } else if (typeOf(o) === T.dict) {
      const d = o as PyDict;
      if (d.$m.size === 0) {
        out += "{}";
        return;
      }
      items = [];
      for (const [mk, v] of d.$m) {
        step();
        items.push(tuple([dictKeyOf(d, mk), v]));
      }
    } else if (o instanceof PyDict && o.$m.size === 0) {
      // (an empty subclass instance is "{}", its items() not called, as
      // CPython's C encoder; a nonempty one's items() is, CORR-C0E-5)
      out += "{}";
      return;
    } else {
      const r = callObj(getattr(o, "items"), []);
      items = collect(r, () => `${typeName(o)}.items() returned a non-iterable (type ${typeName(r)})`);
      if (items.length === 0) {
        out += "{}";
        return;
      }
    }
    enter(o);
    if (sortk) items = collect(callObj(sorted, [items]));
    out += "{";
    let nl: string | null = null, sep = is;
    if (ind !== null) {
      indent1();
      level++;
      nl = "\n" + ind.repeat(level);
      sep = is + nl;
    }
    // (key: undefined while no item has been written)
    stack.push({ kind: DICT, o, items, i: 0, sep, nl, level, key: undefined, inValue: false, raw, live });
  }

  function run(o: any, level: number) {
    value(o, level);
    while (stack.length) {
      step();
      const f = stack[stack.length - 1];
      if (f.inValue) {
        // (its current item's value is written: the frame goes on)
        f.inValue = false;
      }
      if (f.kind === DEFAULT) {
        if (f.i === 0) {
          f.i = 1;
          f.inValue = true;
          value(f.items[0], f.level);
          continue;
        }
        stack.pop();
        leave(f.o);
        continue;
      }
      if (f.kind === LIST) {
        if (f.i < f.items.length) {
          if (f.i) out += sepText(f);
          const v = f.items[f.i++];
          f.inValue = true;
          value(v, f.level);
          continue;
        }
        if (f.nl !== null) out += "\n" + ind!.repeat(f.level - 1);
        out += "]";
        stack.pop();
        leave(f.o);
        continue;
      }
      // a dict
      let wrote = false;
      for (;;) {
        step();
        let it: any;
        if (f.live) {
          const r = f.live.next();
          if (r.done) break;
          it = r.value;
        } else {
          if (f.i >= f.items.length) break;
          it = f.items[f.i++];
        }
        if (!f.raw && (!Array.isArray(it) || it.length !== 2)) raise(T.ValueError, "items must return 2-tuples");
        const key = f.raw && typeof it[0] !== "string" ? dictKeyOf(f.o, it[0]) : it[0];
        let k: string;
        if (typeof key === "string") {
          // (a short str key's text and separator, cached: dicts repeat keys)
          if (key.length <= 64) {
            let t = keyText.get(key);
            if (t === undefined) {
              t = ksObj === null ? enc(key) + ks : enc(key);
              if (keyText.size < 4096) keyText.set(key, t);
            }
            if (f.key === undefined) {
              if (f.nl !== null) out += f.nl;
            } else out += sepText(f);
            f.key = key;
            out += t;
            if (ksObj !== null) out += strCall(ksObj);
            f.inValue = true;
            value(it[1], f.level);
            wrote = true;
            break;
          }
          k = key;
        }
        else if (key === true) k = "true";
        else if (key === false) k = "false";
        else if (key === null) k = "null";
        else if (typeof key === "number") k = Number.isInteger(key) ? String(key) : floatStr(key);
        else if (typeof key === "bigint") k = decimalOf(key);
        else if (key instanceof FloatBox) k = floatStr(key);
        else {
          const kt = typeOf(key);
          if (kt.$mro.includes(T.str)) k = strOf(key);
          else if (kt.$mro.includes(T.float)) k = floatStr(key);
          else if (kt.$mro.includes(T.int)) k = intStr(key);
          else if (skip) continue;
          else raise(T.TypeError, `keys must be str, int, float, bool or None, not ${kt.$name}`);
        }
        if (f.key === undefined) {
          if (f.nl !== null) out += f.nl;
        } else out += sepText(f);
        f.key = key;
        out += enc(k);
        out += ksObj === null ? ks : strCall(ksObj);
        f.inValue = true;
        value(it[1], f.level);
        wrote = true;
        break;
      }
      if (wrote) continue;
      if (f.key !== undefined && f.nl !== null) out += "\n" + ind!.repeat(f.level - 1);
      out += "}";
      stack.pop();
      leave(f.o);
    }
  }

  return builtin((o: any, _level: any) => {
    out = "";
    stack.length = 0;
    seen.clear();
    try {
      run(o, ssize(_level ?? 0));
    } catch (e) {
      const pe = toPyExc(e);
      // (the notes, innermost first: each frame encoding an item when it was raised)
      for (let k = stack.length - 1; k >= 0; k--) {
        const f = stack[k];
        if (!f.inValue) continue;
        add_note(pe, f.kind === LIST ? `when serializing ${typeName(f.o)} item ${f.i - 1}`
          : f.kind === DICT ? `when serializing ${typeName(f.o)} item ${pyRepr(f.key)}`
          : `when serializing ${typeName(f.o)} object`);
      }
      stack.length = 0;
      throw pe;
    }
    return tuple([out]);
  }, "_iterencode");
}

function O_truth(x: any): boolean {
  if (typeof x === "boolean") return x;
  if (x === null || x === 0 || x === "") return false;
  return callObj(importModule("builtins").bool, [x]) === true;
}

// ------------------------------------------------------------------ loads
let JSONDecodeError: any = null;
function fail(msg: string, s: string, unit: number, p: SP.Pos | null): never {
  JSONDecodeError ??= importModule("json.decoder").JSONDecodeError;
  throw callObj(JSONDecodeError, [msg, s, p === null ? unit : SP.cpOf(p, unit)]);
}
function stop(unit: number, p: SP.Pos | null): never {
  const e = newException(T.StopIteration, [p === null ? unit : SP.cpOf(p, unit)]);
  throw e;
}

const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

// scanstring: the string after the opening quote at `end` (units); returns
// [value, the unit after the closing quote]
function scanString(s: string, end: number, strict: boolean, p: SP.Pos | null): [string, number] {
  const begin = end - 1;
  const n = s.length;
  let chunks: string[] | null = null, from = end, surrogate = false;
  for (;;) {
    step();
    let i = from;
    let c = 0;
    for (; i < n; i++) {
      c = s.charCodeAt(i);
      if (c === 0x22 || c === 0x5c || c < 0x20) break;
      scanPoll(i);
    }
    if (i >= n) fail("Unterminated string starting at", s, begin, p);
    if (c < 0x20) {
      if (strict) fail("Invalid control character at", s, i, p);
      // (not strict: kept in the text, and the scan goes on after it)
      from = i + 1;
      continue;
    }
    if (c === 0x22) {
      const tail = s.slice(end, i);
      if (chunks === null) return [tail, i + 1];
      chunks.push(tail);
      return [surrogate ? SP.joinChecked(chunks, "") : chunks.join(""), i + 1];
    }
    // a backslash
    chunks ??= [];
    if (i > end) chunks.push(s.slice(end, i));
    if (i + 1 >= n) fail("Unterminated string starting at", s, begin, p);
    const e = s.charCodeAt(i + 1);
    let ch: string;
    let next = i + 2;
    switch (e) {
      case 0x22: ch = '"'; break;
      case 0x5c: ch = "\\"; break;
      case 0x2f: ch = "/"; break;
      case 0x62: ch = "\b"; break;
      case 0x66: ch = "\f"; break;
      case 0x6e: ch = "\n"; break;
      case 0x72: ch = "\r"; break;
      case 0x74: ch = "\t"; break;
      case 0x75: {
        let u = hex(s, i + 2);
        if (u < 0) fail("Invalid \\uXXXX escape", s, i + 1, p);
        next = i + 6;
        if (u >= 0xd800 && u <= 0xdbff && s.charCodeAt(next) === 0x5c && s.charCodeAt(next + 1) === 0x75) {
          const u2 = hex(s, next + 2);
          if (u2 < 0) fail("Invalid \\uXXXX escape", s, next + 1, p);
          if (u2 >= 0xdc00 && u2 <= 0xdfff) {
            ch = String.fromCharCode(u, u2);
            next += 6;
            break;
          }
        }
        if (u >= 0xd800 && u <= 0xdfff) surrogate = true;
        ch = String.fromCharCode(u);
        break;
      }
      default:
        fail("Invalid \\escape", s, i, p);
    }
    chunks.push(ch!);
    end = next;
    from = next;
  }
}
function hex(s: string, at: number): number {
  if (at + 4 > s.length) return -1;
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const c = s.charCodeAt(at + k);
    const d = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 87 : c >= 0x41 && c <= 0x46 ? c - 55 : -1;
    if (d < 0) return -1;
    v = v * 16 + d;
  }
  return v;
}

function makeScanner(ctx: any): any {
  const strict = O_truth(getattr(ctx, "strict"));
  const objectHook = getattr(ctx, "object_hook");
  const pairsHook = getattr(ctx, "object_pairs_hook");
  const parseFloat = getattr(ctx, "parse_float");
  const parseInt = getattr(ctx, "parse_int");
  const parseConstant = getattr(ctx, "parse_constant");
  const plainFloat = parseFloat === T.float, plainInt = parseInt === T.int;

  return builtin((string: any, idx: any) => {
    // (a str subclass read by its contents, CORR-C0E-4; idx by the index
    // protocol, and one at or past the end is the StopIteration's own value,
    // not clamped, CORR-C0E-3)
    if (!isinstance(string, T.str)) raise(T.TypeError, `first argument must be a string, not ${typeName(string)}`);
    const s: string = strOf(string);
    const i0 = ssize(idx);
    if (i0 < 0) raise(T.ValueError, "idx cannot be negative");
    const p = SP.pairs(s);
    const n = s.length;
    if (i0 >= (p === null ? n : SP.cpOf(p, n))) throw newException(T.StopIteration, [i0]);
    const start = p === null ? i0 : SP.unitOf(p, i0);

    const number = (i: number): [any, number] | null => {
      let j = i;
      if (s.charCodeAt(j) === 0x2d) j++;
      const d0 = s.charCodeAt(j);
      if (d0 === 0x30) j++;
      else if (d0 >= 0x31 && d0 <= 0x39) {
        j++;
        while (j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x39) scanPoll(++j);
      } else return null;
      let isFloat = false;
      if (s.charCodeAt(j) === 0x2e && s.charCodeAt(j + 1) >= 0x30 && s.charCodeAt(j + 1) <= 0x39) {
        j += 2;
        while (j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x39) scanPoll(++j);
        isFloat = true;
      }
      const e = s.charCodeAt(j);
      if (e === 0x65 || e === 0x45) {
        let k = j + 1;
        const sg = s.charCodeAt(k);
        if (sg === 0x2b || sg === 0x2d) k++;
        if (s.charCodeAt(k) >= 0x30 && s.charCodeAt(k) <= 0x39) {
          k++;
          while (k < n && s.charCodeAt(k) >= 0x30 && s.charCodeAt(k) <= 0x39) scanPoll(++k);
          j = k;
          isFloat = true;
        }
      }
      const text = s.slice(i, j);
      if (isFloat) return [plainFloat ? mkfloat(Number(text)) : callObj(parseFloat, [text]), j];
      if (!plainInt) return [callObj(parseInt, [text]), j];
      return [text.length <= 15 ? Number(text) || 0 : callObj(T.int, [text]), j];
    };

    const ws = (i: number) => {
      while (i < n && isWs(s.charCodeAt(i))) scanPoll(++i);
      return i;
    };

    const finishObject = (pairs: any[]): any => {
      if (pairsHook !== null) return callObj(pairsHook, [pairs]);
      const d = new PyDict();
      for (const kv of pairs) {
        step();
        dictSet(d, kv[0], kv[1]);
      }
      return objectHook !== null ? callObj(objectHook, [d]) : d;
    };
    // an object's key and its ':' from the quote at i: the unit after ':' and spaces
    const keyAt = (i: number): [string, number] => {
      const [key, kend] = scanString(s, i + 1, strict, p);
      i = ws(kend);
      if (s.charCodeAt(i) !== 0x3a) fail("Expecting ':' delimiter", s, i, p);
      return [key, ws(i + 1)];
    };

    // (iterative: a frame per open array or object, so that nesting as deep
    // as CPython's C scanner takes needs no deeper JS stack)
    type Frame = { arr: any[] | null; pairs: any[]; key: string };
    const stack: Frame[] = [];
    let i = start;
    let v: any;
    for (;;) {
      step();
      // a value at i
      if (i >= n) stop(i, p);
      const c = s.charCodeAt(i);
      if (c === 0x5b) {
        if (stack.length >= MAX_DEPTH) raise(T.RecursionError, "maximum recursion depth exceeded while decoding a JSON array from a unicode string");
        i = ws(i + 1);
        if (s.charCodeAt(i) === 0x5d) {
          v = [];
          i++;
        } else {
          stack.push({ arr: [], pairs: [], key: "" });
          continue;
        }
      } else if (c === 0x7b) {
        if (stack.length >= MAX_DEPTH) raise(T.RecursionError, "maximum recursion depth exceeded while decoding a JSON object from a unicode string");
        i = ws(i + 1);
        const c2 = s.charCodeAt(i);
        if (c2 === 0x22) {
          const [key, at] = keyAt(i);
          stack.push({ arr: null, pairs: [], key });
          i = at;
          continue;
        }
        if (c2 !== 0x7d) fail("Expecting property name enclosed in double quotes", s, i, p);
        v = finishObject([]);
        i++;
      } else if (c === 0x22) {
        [v, i] = scanString(s, i + 1, strict, p);
      } else {
        let r: [any, number] | null = null;
        switch (c) {
          case 0x6e: if (s.startsWith("null", i)) r = [null, i + 4]; break;
          case 0x74: if (s.startsWith("true", i)) r = [true, i + 4]; break;
          case 0x66: if (s.startsWith("false", i)) r = [false, i + 5]; break;
          case 0x4e: if (s.startsWith("NaN", i)) r = [callObj(parseConstant, ["NaN"]), i + 3]; break;
          case 0x49: if (s.startsWith("Infinity", i)) r = [callObj(parseConstant, ["Infinity"]), i + 8]; break;
          case 0x2d: if (s.startsWith("-Infinity", i)) r = [callObj(parseConstant, ["-Infinity"]), i + 9]; break;
        }
        if (r === null) r = number(i);
        if (r === null) stop(i, p);
        [v, i] = r;
      }
      // the value ends at i: into the open containers, closing those it ends
      let more = false;
      while (stack.length) {
        step();
        const f = stack[stack.length - 1];
        i = ws(i);
        const d = s.charCodeAt(i);
        if (f.arr !== null) {
          f.arr.push(v);
          if (d === 0x5d) {
            v = f.arr;
            stack.pop();
            i++;
            continue;
          }
          if (d !== 0x2c) fail("Expecting ',' delimiter", s, i, p);
          const comma = i;
          i = ws(i + 1);
          if (s.charCodeAt(i) === 0x5d) fail("Illegal trailing comma before end of array", s, comma, p);
          more = true;
          break;
        }
        f.pairs.push(tuple([f.key, v]));
        if (d === 0x7d) {
          v = finishObject(f.pairs);
          stack.pop();
          i++;
          continue;
        }
        if (d !== 0x2c) fail("Expecting ',' delimiter", s, i, p);
        const comma = i;
        i = ws(i + 1);
        const e = s.charCodeAt(i);
        if (e !== 0x22) {
          if (e === 0x7d) fail("Illegal trailing comma before end of object", s, comma, p);
          fail("Expecting property name enclosed in double quotes", s, i, p);
        }
        [f.key, i] = keyAt(i);
        more = true;
        break;
      }
      if (!more) break;
    }
    const r: [any, number] = [v, i];
    return tuple([r[0], p === null ? r[1] : SP.cpOf(p, r[1])]);
  }, "scan_once");
}

const M: any = {};
newBuiltinModule("_json", (m) => {
  const fn = (name: string, f: any) => {
    builtin(f, name);
    f.__module__ = "_json";
    m[name] = M[name] = f;
  };
  fn("encode_basestring_ascii", (s: any) => {
    if (!isinstance(s, T.str)) raise(T.TypeError, `first argument must be a string, not ${typeName(s)}`);
    return encodeStr(s);
  });
  fn("encode_basestring", (s: any) => {
    if (!isinstance(s, T.str)) raise(T.TypeError, `first argument must be a string, not ${typeName(s)}`);
    return encodeUnicode(strOf(s));
  });
  fn("scanstring", (s: any, end: any, strict: any = true) => {
    if (!isinstance(s, T.str)) raise(T.TypeError, `first argument must be a string, not ${typeName(s)}`);
    const str = strOf(s);
    const p = SP.pairs(str);
    const e = ssize(end);
    if (e < 0 || e > (p === null ? str.length : SP.cpOf(p, str.length))) raise(T.ValueError, "end is out of bounds");
    const [v, u] = scanString(str, p === null ? e : SP.unitOf(p, e), O_truth(strict), p);
    return tuple([v, p === null ? u : SP.cpOf(p, u)]);
  });
  fn("make_scanner", (ctx: any) => makeScanner(ctx));
  fn("make_encoder", (markers: any, dflt: any, encoder: any, indent: any, keySep: any, itemSep: any, sortKeys: any, skipKeys: any, allowNan: any) =>
    makeEncoder(markers, dflt, encoder, indent, keySep, itemSep, sortKeys, skipKeys, allowNan));
});
