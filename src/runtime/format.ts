// repr(), str(), format() and `str % args`.

import { T, FloatBox, PyDict, typeOf, lookupType, raise, isType, dictKeyOf, dictGet, hooks, Ellipsis, NotImplemented, PyBytes, StrLayout } from "./object";
import { PySet, setItems, isPyInt, fv, strFormatOpHook, id, index, normBig, PySlice } from "./ops";

const isInt = Number.isInteger;

// ------------------------------------------------------------------ floats

export function floatRepr(x: number): string {
  if (x !== x) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, exp] = x.toExponential().split("e");
  const e = +exp;
  const neg = x < 0;
  const digits = mant.replace("-", "").replace(".", "");
  let out: string;
  if (e < -4 || e >= 16) {
    out = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
  } else if (e >= 0) {
    out = digits.length <= e + 1 ? digits + "0".repeat(e + 1 - digits.length) + ".0" : digits.slice(0, e + 1) + "." + digits.slice(e + 1);
  } else {
    out = "0." + "0".repeat(-e - 1) + digits;
  }
  return (neg ? "-" : "") + out;
}

// Exact binary value of a finite double as mant * 2^exp.
function decompose(x: number): [bigint, number] {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const e = (hi >>> 20) & 0x7ff;
  const m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0) return [m, -1074];
  return [m | (1n << 52n), e - 1075];
}

// |x| rounded half-even to `p` digits after the point: [integer digits, fraction digits].
function fixedDigits(x: number, p: number): [string, string] {
  const [m, e] = decompose(x);
  let q: bigint;
  if (e >= 0) q = (m << BigInt(e)) * 10n ** BigInt(p);
  else {
    const N = m * 10n ** BigInt(p);
    const D = 1n << BigInt(-e);
    q = N / D;
    const r2 = (N % D) * 2n;
    if (r2 > D || (r2 === D && q % 2n === 1n)) q += 1n;
  }
  const s = q.toString().padStart(p + 1, "0");
  return [s.slice(0, s.length - p), s.slice(s.length - p)];
}

export function formatFixed(x: number, p: number, alt = false): string {
  const [i, f] = fixedDigits(x, p);
  return (x < 0 || Object.is(x, -0) ? "-" : "") + i + (p > 0 || alt ? "." + f : "");
}

// [digits (p+1 significant), decimal exponent]
function sciDigits(x: number, p: number): [string, number] {
  if (x === 0) return ["0".repeat(p + 1), 0];
  let k = Math.floor(Math.log10(Math.abs(x)));
  for (;;) {
    let digits: string;
    if (p - k >= 0) {
      const [i, f] = fixedDigits(x, p - k);
      digits = (i + f).replace(/^0+/, "");
    } else {
      // Round to a multiple of 10^(k-p).
      const [m, e] = decompose(x);
      const D = 10n ** BigInt(k - p);
      const N = e >= 0 ? m << BigInt(e) : m;
      const den = e >= 0 ? D : D << BigInt(-e);
      let q = N / den;
      const r2 = (N % den) * 2n;
      if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
      digits = q.toString();
    }
    if (digits.length === p + 1) return [digits, k];
    k += digits.length > p + 1 ? 1 : -1;
  }
}

export function formatExp(x: number, p: number, upper = false, alt = false): string {
  const [d, k] = sciDigits(x, p);
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const m = d[0] + (p > 0 || alt ? "." + d.slice(1) : "");
  const e = (k < 0 ? "-" : "+") + String(Math.abs(k)).padStart(2, "0");
  return sign + m + (upper ? "E" : "e") + e;
}

function formatGeneral(x: number, p: number, upper: boolean, alt: boolean, noneType: boolean): string {
  if (p === 0) p = 1;
  const [, k] = sciDigits(x, p - 1);
  let s: string;
  if (-4 <= k && k < p) {
    s = formatFixed(x, p - 1 - k, alt);
    if (!alt && s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, noneType ? ".0" : "");
  } else {
    s = formatExp(x, p - 1, upper, alt);
    if (!alt) s = s.replace(/\.?0+(?=[eE])/, "");
  }
  return s;
}

// ------------------------------------------------------------------ repr / str

const NONPRINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export function strRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === q || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else if (c < 0x7f || ch === " ") out += ch;
    else if (NONPRINT.test(ch)) {
      if (c <= 0xff) out += "\\x" + c.toString(16).padStart(2, "0");
      else if (c <= 0xffff) out += "\\u" + c.toString(16).padStart(4, "0");
      else out += "\\U" + c.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + q;
}

export function bytesRepr(a: ArrayLike<number>): string {
  let hasSingle = false, hasDouble = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 39) hasSingle = true;
    if (a[i] === 34) hasDouble = true;
  }
  const q = hasSingle && !hasDouble ? '"' : "'";
  let out = "b" + q;
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c === q.charCodeAt(0) || c === 92) out += "\\" + String.fromCharCode(c);
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c < 0x20 || c >= 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += String.fromCharCode(c);
  }
  return out + q;
}

export const hex = (n: number) => "0x" + n.toString(16);

const reprActive = new Set<any>();

export function repr(x: any): string {
  switch (typeof x) {
    case "string":
      return strRepr(x);
    case "number":
      return isInt(x) ? String(x) : floatRepr(x);
    case "bigint":
      return x.toString();
    case "boolean":
      return x ? "True" : "False";
    case "function":
      if (isType(x)) {
        const m = (x as any).$meta;
        if (m !== undefined) {
          const f = lookupType(m, "__repr__");
          if (f !== T.type.$dict.get("__repr__")) return f(x);
        }
        return `<class '${x.$module === "builtins" ? "" : x.$module + "."}${x.$qualname}'>`;
      }
      if (x.$self !== undefined) return `<bound method ${x.$func.__qualname__ ?? x.$func.__name__} of ${repr(x.$self)}>`;
      if (x.$pyfn === true && x.$builtinMethod !== true) return `<function ${x.__qualname__} at ${hex(id(x))}>`;
      return `<built-in function ${x.__name__ ?? x.name}>`;
  }
  if (x === null) return "None";
  if (x instanceof FloatBox) return floatRepr(x.v);
  if (x instanceof PyBytes) {
    const r = bytesRepr(x.a.subarray(0, x.n));
    return typeOf(x) === T.bytearray ? `bytearray(${r})` : r;
  }
  if (x === Ellipsis) return "Ellipsis";
  if (x === NotImplemented) return "NotImplemented";
  if (Array.isArray(x) && (x as any).$cls === undefined) return seqRepr(x);
  const t = typeOf(x);
  const f = lookupType(t, "__repr__");
  if (f !== undefined) {
    const r = f(x);
    // a str subclass is a string (CPython accepts it)
    if (r instanceof StrLayout) return r.$v;
    if (typeof r !== "string") raise(T.TypeError, `__repr__ returned non-string (type ${typeOf(r).$name})`);
    return r;
  }
  return defaultRepr(x);
}

export function seqRepr(x: any[]): string {
  {
    if (reprActive.has(x)) return (x as any).$t ? "(...)" : "[...]";
    reprActive.add(x);
    try {
      const body = x.map(repr).join(", ");
      return (x as any).$t ? (x.length === 1 ? `(${body},)` : `(${body})`) : `[${body}]`;
    } finally {
      reprActive.delete(x);
    }
  }
}

export function defaultRepr(x: any): string {
  const t = typeOf(x);
  return `<${t.$module === "builtins" ? "" : t.$module + "."}${t.$qualname} object at ${hex(id(x))}>`;
}

export function dictRepr(d: PyDict): string {
  if (reprActive.has(d)) return "{...}";
  reprActive.add(d);
  try {
    const parts: string[] = [];
    for (const [k, v] of d.$m) parts.push(repr(dictKeyOf(d, k)) + ": " + repr(v));
    return "{" + parts.join(", ") + "}";
  } finally {
    reprActive.delete(d);
  }
}

export function setRepr(s: PySet): string {
  const items = setItems(s);
  const name = s.$frozen ? "frozenset" : "set";
  if (items.length === 0) return name + "()";
  const body = "{" + items.map(repr).join(", ") + "}";
  return s.$frozen ? `frozenset(${body})` : body;
}

export function str(x: any): string {
  switch (typeof x) {
    case "string":
      return x;
    case "number":
      return isInt(x) ? String(x) : floatRepr(x);
    case "bigint":
      return x.toString();
    case "boolean":
      return x ? "True" : "False";
  }
  if (x === null) return "None";
  if (x instanceof FloatBox) return floatRepr(x.v);
  const t = typeOf(x);
  const f = lookupType(t, "__str__");
  if (f !== undefined) {
    const r = f(x);
    // a str subclass is a string (CPython accepts it)
    if (r instanceof StrLayout) return r.$v;
    if (typeof r !== "string") raise(T.TypeError, `__str__ returned non-string (type ${typeOf(r).$name})`);
    return r;
  }
  return repr(x);
}

hooks.repr = repr;

// ------------------------------------------------------------------ format()

interface Spec {
  fill: string;
  align: string;
  sign: string;
  z: boolean;
  alt: boolean;
  zero: boolean;
  width: number;
  grouping: string;
  precision: number;
  type: string;
}

function parseSpec(spec: string): Spec {
  const m = /^(?:(.)?([<>=^]))?([-+ ])?(z)?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/su.exec(spec);
  if (m === null) raise(T.ValueError, "Invalid format specifier '" + spec + "'");
  return {
    fill: m[1] ?? (m[6] ? "0" : " "),
    align: m[2] ?? (m[6] ? "=" : ""),
    sign: m[3] ?? "-",
    z: !!m[4],
    alt: !!m[5],
    zero: !!m[6],
    width: m[7] ? parseInt(m[7]) : 0,
    grouping: m[8] ?? "",
    precision: m[9] !== undefined ? parseInt(m[9]) : -1,
    type: m[10] ?? "",
  };
}

// Zero padding with a grouping separator pads the digits themselves, so the
// zeros get separators too ('{:07,}'.format(0) == '000,000').
function zeroGroup(digits: string, sep: string, n: number, need: number): string {
  let g = group(digits, sep, n);
  while (g.length < need) g = group((digits = "0" + digits), sep, n);
  return g;
}

function group(digits: string, sep: string, n: number): string {
  if (!sep) return digits;
  let out = "";
  for (let i = digits.length; i > 0; i -= n) out = digits.slice(Math.max(0, i - n), i) + (out ? sep + out : "");
  return out;
}

function pad(body: string, sign: string, s: Spec, defaultAlign: string): string {
  const align = s.align || defaultAlign;
  const len = [...body].length + sign.length;
  if (len >= s.width) return sign + body;
  const fill = s.fill.repeat(s.width - len);
  switch (align) {
    case "<":
      return sign + body + fill;
    case "^": {
      const half = Math.floor((s.width - len) / 2);
      return s.fill.repeat(half) + sign + body + s.fill.repeat(s.width - len - half);
    }
    case "=":
      return sign + fill + body;
    default:
      return fill + sign + body;
  }
}

function signOf(neg: boolean, s: Spec): string {
  return neg ? "-" : s.sign === "+" ? "+" : s.sign === " " ? " " : "";
}

function formatInt(v: bigint, s: Spec): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  let digits: string, prefix = "";
  switch (s.type) {
    case "b": digits = a.toString(2); prefix = "0b"; break;
    case "o": digits = a.toString(8); prefix = "0o"; break;
    case "x": digits = a.toString(16); prefix = "0x"; break;
    case "X": digits = a.toString(16).toUpperCase(); prefix = "0X"; break;
    case "c":
      if (s.sign !== "-" || s.alt) raise(T.ValueError, `${s.alt ? "Alternate form (#)" : "Sign"} not allowed with integer format specifier 'c'`);
      return pad(String.fromCodePoint(Number(v)), "", s, ">");
    case "":
    case "d":
    case "n":
      digits = a.toString();
      break;
    default:
      return formatFloat(Number(v), s);
  }
  if (s.precision >= 0) raise(T.ValueError, "Precision not allowed in integer format specifier");
  const sign = signOf(neg, s) + (s.alt ? prefix : "");
  const gn = s.type === "" || s.type === "d" || s.type === "n" ? 3 : 4;
  digits = s.grouping && s.zero && s.fill === "0" && s.align === "=" ? zeroGroup(digits, s.grouping, gn, s.width - sign.length) : group(digits, s.grouping, gn);
  return pad(digits, sign, s, ">");
}

function formatFloat(x: number, s: Spec): string {
  const neg = x < 0 || Object.is(x, -0);
  let a = Math.abs(x);
  let body: string;
  const p = s.precision;
  if (!Number.isFinite(a)) body = a !== a ? "nan" : "inf";
  else {
    switch (s.type) {
      case "f":
      case "F":
        body = formatFixed(a, p < 0 ? 6 : p, s.alt);
        break;
      case "e":
      case "E":
        body = formatExp(a, p < 0 ? 6 : p, s.type === "E", s.alt);
        break;
      case "g":
      case "G":
      case "n":
        body = formatGeneral(a, p < 0 ? 6 : p, s.type === "G", s.alt, false);
        break;
      case "%":
        body = formatFixed(a * 100, p < 0 ? 6 : p, s.alt) + "%";
        break;
      case "":
        body = p < 0 ? floatRepr(a) : formatGeneral(a, p, false, s.alt, true);
        break;
      default:
        raise(T.ValueError, `Unknown format code '${s.type}' for object of type 'float'`);
    }
    if (s.type === "F" || s.type === "E" || s.type === "G") body = body.toUpperCase();
  }
  if (s.grouping) {
    const [ip] = body.split(/(?=[.eE%])/, 2);
    const negZero0 = s.z && neg && Number(body.replace(/[^0-9.e]/g, "")) === 0;
    const signLen = signOf(neg && !negZero0, s).length;
    const rest = body.slice(ip.length);
    body = (s.zero && s.fill === "0" && s.align === "=" && /^\d+$/.test(ip) ? zeroGroup(ip, s.grouping, 3, s.width - signLen - rest.length) : group(ip, s.grouping, 3)) + rest;
  }
  const negZero = s.z && neg && Number(body.replace(/[^0-9.e]/g, "")) === 0;
  return pad(body, signOf(neg && !negZero, s), s, ">");
}

export function format(v: any, spec: string): string {
  if (typeof v === "string") {
    if (spec === "") return v;
    const s = parseSpec(spec);
    if (s.type !== "" && s.type !== "s") raise(T.ValueError, `Unknown format code '${s.type}' for object of type 'str'`);
    if (s.sign !== "-" && spec.match(/[-+ ]/)) raise(T.ValueError, "Sign not allowed in string format specifier");
    if (s.alt) raise(T.ValueError, "Alternate form (#) not allowed in string format specifier");
    if (s.grouping) raise(T.ValueError, "Cannot specify ',' with 's'.");
    if (s.align === "=") {
      if (!s.zero || /^(.)?=/su.test(spec)) raise(T.ValueError, "'=' alignment not allowed in string format specifier");
      s.align = "<";
    }
    return pad(s.precision >= 0 ? [...v].slice(0, s.precision).join("") : v, "", s, "<");
  }
  if (typeof v === "boolean" && spec === "") return v ? "True" : "False";
  if (isPyInt(v)) {
    if (spec === "") return typeof v === "bigint" ? v.toString() : String(+v);
    return formatInt(typeof v === "bigint" ? v : BigInt(+v), parseSpec(spec));
  }
  if (typeof v === "number" || v instanceof FloatBox) {
    const x = fv(v)!;
    if (spec === "") return floatRepr(x);
    return formatFloat(x, parseSpec(spec));
  }
  const f = lookupType(typeOf(v), "__format__");
  if (f !== undefined) {
    const r = f(v, spec);
    if (typeof r !== "string") raise(T.TypeError, "__format__ must return a str");
    return r;
  }
  if (spec !== "") raise(T.TypeError, `unsupported format string passed to ${typeOf(v).$name}.__format__`);
  return str(v);
}

// f"{x!r:>10}"
export function fmt(v: any, conv: string | null, spec: string): string {
  if (conv === "r") v = repr(v);
  else if (conv === "s") v = str(v);
  else if (conv === "a") v = repr(v).replace(/[^\x00-\x7f]/gu, (c) => {
    const n = c.codePointAt(0)!;
    return n <= 0xff ? "\\x" + n.toString(16).padStart(2, "0") : n <= 0xffff ? "\\u" + n.toString(16).padStart(4, "0") : "\\U" + n.toString(16).padStart(8, "0");
  });
  else if (spec === "" && typeof v === "string") return v;
  return format(v, spec);
}

// ------------------------------------------------------------------ str % args

// Follows CPython's unicode_format_arg_parse: a non-tuple mapping (anything
// with __getitem__) is both the single positional argument and the source
// of %(key) lookups; after a key lookup the looked-up value is the argument.
export function percentFormat(fmtStr: string, args: any, bytesMode = false): string {
  const isTuple = Array.isArray(args) && (args as any).$t === true;
  const dict = !isTuple && typeof args !== "string" && (args instanceof PyDict || Array.isArray(args) || (args !== null && typeof args === "object" && lookupType(typeOf(args), "__getitem__") !== undefined)) ? args : null;
  let cur: any = args;
  let arglen = isTuple ? args.length : -1;
  let argidx = isTuple ? 0 : -2;
  const nextArg = () => {
    if (argidx < arglen) {
      if (arglen < 0) {
        argidx = -1;
        return cur;
      }
      return cur[argidx++];
    }
    raise(T.TypeError, "not enough arguments for format string");
  };
  const intOf = (v: any, type: string, needIndex: boolean): bigint => {
    if (typeof v === "boolean") return BigInt(+v);
    if (isPyInt(v)) return BigInt(v);
    if (!needIndex && fv(v) !== undefined) return BigInt(Math.trunc(fv(v)!));
    for (const name of needIndex ? ["__index__"] : ["__index__", "__int__"]) {
      const f = lookupType(typeOf(v), name);
      if (f !== undefined) {
        const r = f(v);
        return BigInt(typeof r === "boolean" ? +r : r);
      }
    }
    raise(T.TypeError, `%${type} format: ${needIndex ? "an integer" : "a real number"} is required, not ${typeOf(v).$name}`);
  };
  let out = "";
  const n = fmtStr.length;
  let i = 0;
  while (i < n) {
    const k = fmtStr.indexOf("%", i);
    if (k < 0) {
      out += fmtStr.slice(i);
      break;
    }
    out += fmtStr.slice(i, k);
    i = k + 1;
    if (i < n && fmtStr[i] === "%") {
      out += "%";
      i++;
      continue;
    }
    if (i < n && fmtStr[i] === "(") {
      if (dict === null) raise(T.TypeError, "format requires a mapping");
      let depth = 1;
      const ks = ++i;
      while (i < n && depth > 0) {
        if (fmtStr[i] === "(") depth++;
        else if (fmtStr[i] === ")") depth--;
        i++;
      }
      if (depth > 0) raise(T.ValueError, "incomplete format key");
      cur = getitemMapping(dict, fmtStr.slice(ks, i - 1));
      arglen = -1;
      argidx = -2;
    }
    let flags = "";
    while (i < n && "-+ #0".includes(fmtStr[i])) flags += fmtStr[i++];
    let width = 0, precision = -1;
    const num = (): number => {
      if (fmtStr[i] === "*") {
        i++;
        const v = nextArg();
        if (!isPyInt(v)) raise(T.TypeError, "* wants int");
        return Number(v);
      }
      const m = /^\d+/.exec(fmtStr.slice(i, i + 20));
      if (m === null) return -1;
      i += m[0].length;
      return parseInt(m[0]);
    };
    width = num();
    let left = flags.includes("-");
    if (width < -1 || (width < 0 && fmtStr[i - 1] === "*")) {
      left = true;
      width = -width;
    }
    if (width < 0) width = 0;
    if (fmtStr[i] === ".") {
      i++;
      precision = Math.max(0, num());
    }
    while (i < n && "hlL".includes(fmtStr[i])) i++;
    if (i >= n) raise(T.ValueError, "incomplete format");
    const type = fmtStr[i++];
    const zero = flags.includes("0") && !left;
    const sign = flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
    const padW = (body: string, numeric: boolean, signPart = ""): string => {
      const len = [...body].length + signPart.length;
      if (len >= width) return signPart + body;
      if (left) return signPart + body + " ".repeat(width - len);
      if (zero && numeric) return signPart + "0".repeat(width - len) + body;
      return " ".repeat(width - len) + signPart + body;
    };
    let body: string;
    switch (type) {
      case "b":
      case "s":
      case "r":
      case "a": {
        const v = nextArg();
        if (bytesMode && (type === "s" || type === "b")) {
          if (v instanceof PyBytes) body = Buffer.from(v.a.subarray(0, v.n)).toString("latin1");
          else {
            const f = lookupType(typeOf(v), "__bytes__");
            if (f === undefined) raise(T.TypeError, `%b requires a bytes-like object, or an object that implements __bytes__, not '${typeOf(v).$name}'`);
            const r = f(v);
            body = Buffer.from(r.a.subarray(0, r.n)).toString("latin1");
          }
        } else if (type === "b") raise(T.ValueError, `unsupported format character 'b' (0x62) at index ${i - 1}`);
        else body = type === "s" ? str(v) : type === "r" && !bytesMode ? repr(v) : fmt(v, "a", "");
        if (precision >= 0) body = [...body].slice(0, precision).join("");
        body = padW(body, false);
        break;
      }
      case "c": {
        const v = nextArg();
        let c: string;
        if (bytesMode) {
          if (v instanceof PyBytes && v.n === 1) c = String.fromCharCode(v.a[0]);
          else if (isPyInt(v) && Number(v) >= 0 && Number(v) < 256) c = String.fromCharCode(Number(v));
          else raise(isPyInt(v) ? T.OverflowError : T.TypeError, isPyInt(v) ? "%c arg not in range(256)" : "%c requires an integer in range(256) or a single byte");
        } else if (typeof v === "string") {
          if ([...v].length !== 1) raise(T.TypeError, `%c requires an int or a unicode character, not a string of length ${[...v].length}`);
          c = v;
        } else {
          const x = intOf(v, "c", true);
          if (x < 0n || x >= 0x110000n) raise(T.OverflowError, "%c arg not in range(0x110000)");
          c = String.fromCodePoint(Number(x));
        }
        body = padW(c, false);
        break;
      }
      case "d": case "i": case "u": case "o": case "x": case "X": {
        const v = intOf(nextArg(), type, "oxX".includes(type));
        const neg = v < 0n;
        const a = neg ? -v : v;
        let digits = type === "o" ? a.toString(8) : type === "x" ? a.toString(16) : type === "X" ? a.toString(16).toUpperCase() : a.toString();
        if (precision > digits.length) digits = "0".repeat(precision - digits.length) + digits;
        const prefix = flags.includes("#") && "oxX".includes(type) ? "0" + type : "";
        body = padW(digits, true, (neg ? "-" : sign) + prefix);
        break;
      }
      case "e": case "E": case "f": case "F": case "g": case "G": {
        const v = nextArg();
        let x = fv(v);
        if (x === undefined) {
          if (isPyInt(v) || typeof v === "boolean") x = Number(v);
          else {
            const f = lookupType(typeOf(v), "__float__") ?? lookupType(typeOf(v), "__index__");
            if (f === undefined) raise(T.TypeError, `must be real number, not ${typeOf(v).$name}`);
            x = Number(fv(f(v)) ?? f(v));
          }
        }
        const sp: Spec = { fill: zero ? "0" : " ", align: left ? "<" : zero ? "=" : ">", sign: sign || "-", z: false, alt: flags.includes("#"), zero: false, width, grouping: "", precision: precision < 0 ? 6 : precision, type };
        body = formatFloat(x, sp);
        break;
      }
      default:
        raise(T.ValueError, `unsupported format character '${type}' (0x${type.charCodeAt(0).toString(16)}) at index ${i - 1}`);
    }
    out += body;
  }
  if (argidx < arglen && dict === null) raise(T.TypeError, "not all arguments converted during string formatting");
  return out;
}

function getitemMapping(m: any, k: string): any {
  if (m instanceof PyDict) {
    const v = dictGet(m, k);
    if (v === undefined) throw T.KeyError(k);
    return v;
  }
  return lookupType(typeOf(m), "__getitem__")(m, k);
}

strFormatOpHook.f = percentFormat;

export { index, normBig, PySlice };
