// str.encode and bytes.decode for the Unicode codecs (utf-8, utf-8-sig,
// utf-16 and utf-32 in either byte order, ascii, latin-1, cp1252), as
// CPython 3.14's (Objects/unicodeobject.c, Python/codecs.c): each run of
// characters (or bytes) a codec cannot take goes to the error handler,
// strict, ignore, replace, backslashreplace, xmlcharrefreplace,
// namereplace, surrogateescape or surrogatepass, with CPython's reasons and
// positions; a lone surrogate is never silently replaced (TextEncoder made
// '\ud800'.encode() b'\xef\xbf\xbd'). Another encoding is a LookupError,
// a handler registered by codecs.register_error not supported yet. The
// results are built in typed buffers with a bound: past it MemoryError,
// before the memory is taken.

import { T, raise, PyBytes, typeName, unbox } from "./object";
import * as SP from "./strpos";

type Codec = { name: string; kind: "utf8" | "utf16" | "utf32" | "ascii" | "latin1" | "charmap"; le: boolean; bom: boolean; table?: number[] };
// (cp1252: latin-1 but 0x80-0x9F, five of them undefined, -1)
const CP1252 = Array.from({ length: 256 }, (_, i) => i);
[0x20ac, -1, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, -1, 0x17d, -1,
 -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, -1, 0x17e, 0x178].forEach((v, i) => (CP1252[0x80 + i] = v));
// (a null-prototype table: no inherited property is a codec)
const CODECS: Record<string, Codec> = Object.create(null);
const def = (names: string, c: Codec) => {
  for (const n of names.split(" ")) CODECS[n] = c;
};
const UTF8: Codec = { name: "utf-8", kind: "utf8", le: true, bom: false };
def("utf8 u8 utf cp65001", UTF8);
def("utf8sig", { name: "utf-8-sig", kind: "utf8", le: true, bom: true });
def("utf16 u16", { name: "utf-16", kind: "utf16", le: true, bom: true });
def("utf16le unicodelittleunmarked", { name: "utf-16-le", kind: "utf16", le: true, bom: false });
def("utf16be unicodebigunmarked", { name: "utf-16-be", kind: "utf16", le: false, bom: false });
def("utf32 u32", { name: "utf-32", kind: "utf32", le: true, bom: true });
def("utf32le", { name: "utf-32-le", kind: "utf32", le: true, bom: false });
def("utf32be", { name: "utf-32-be", kind: "utf32", le: false, bom: false });
def("ascii usascii 646 ansix3.41968 ansix3.41986 cp367 csascii ibm367 iso646us iso646.irv1991 isoir6 us", { name: "ascii", kind: "ascii", le: true, bom: false });
def("cp1252 windows1252", { name: "cp1252", kind: "charmap", le: true, bom: false, table: CP1252 });
def("latin1 latin iso88591 iso885911987 8859 cp819 l1 ibm819 isoir100 csisolatin1", { name: "latin-1", kind: "latin1", le: true, bom: false });

// (the codec an encoding names, as codecs.lookup's normalization; the
// argument's type checked by the caller's clinic: what)
export function codecOf(encoding: any, what: string): Codec {
  const e = unbox(encoding);
  if (typeof e !== "string") raise(T.TypeError, `${what}() argument 'encoding' must be str, not ${typeName(encoding)}`);
  const c = CODECS[e.toLowerCase().replace(/[-_ ]/g, "")];
  return c ?? raise(T.LookupError, `unknown encoding: ${e}`);
}
function errorsOf(errors: any, what: string): string {
  const e = unbox(errors);
  return typeof e === "string" ? e : raise(T.TypeError, `${what}() argument 'errors' must be str, not ${typeName(errors)}`);
}
const KNOWN = new Set(["strict", "ignore", "replace", "backslashreplace", "xmlcharrefreplace", "namereplace", "surrogateescape", "surrogatepass"]);
function handlerCheck(errors: string): void {
  if (!KNOWN.has(errors)) raise(T.LookupError, `unknown error handler name '${errors}'`);
}

const isSur = (c: number) => c >= 0xd800 && c <= 0xdfff;
const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
const charEsc = (c: number) => (c < 0x100 ? `\\x${hex(c, 2)}` : c < 0x10000 ? `\\u${hex(c, 4)}` : `\\U${hex(c, 8)}`);

// UnicodeEncodeError(encoding, object, start, end, reason), as CPython's
// (its __str__ is the exception's own, src/runtime/types.ts)
function encodeError(name: string, s: string, start: number, end: number, reason: string): never {
  throw T.UnicodeEncodeError(name, s, start, end, reason);
}
function decodeError(name: string, b: Uint8Array, start: number, end: number, reason: string): never {
  throw T.UnicodeDecodeError(name, new PyBytes(b.slice()), start, end, reason);
}

// -------------------------------------------------------------- encoding

// (a lone surrogate anywhere: what TextEncoder would replace)
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// The bytes an encoding builds, grown by doubling, at most MAX_BYTES (1 GiB):
// past it MemoryError, before the memory is taken, never a host failure
const MAX_BYTES = 2 ** 30;
class ByteBuf {
  a = new Uint8Array(256);
  n = 0;
  need(k: number) {
    if (this.n + k <= this.a.length) return;
    if (this.n + k > MAX_BYTES) raise(T.MemoryError);
    let size = this.a.length;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(Math.min(size, MAX_BYTES));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push(x: number) {
    this.need(1);
    this.a[this.n++] = x;
  }
  bytes(): Uint8Array {
    return this.a.slice(0, this.n);
  }
}
// (valid UTF-16 or UTF-32, no lone surrogate: fixed-width units, the size
// known first)
function fixedWidth(s: string, c: Codec): Uint8Array {
  const n = s.length, bom = c.bom ? 1 : 0;
  if (c.kind === "utf16") {
    if ((n + bom) * 2 > MAX_BYTES) raise(T.MemoryError);
    const out = new Uint8Array((n + bom) * 2);
    const dv = new DataView(out.buffer);
    if (bom) dv.setUint16(0, 0xfeff, c.le);
    for (let k = 0; k < n; k++) dv.setUint16((k + bom) * 2, s.charCodeAt(k), c.le);
    return out;
  }
  const m = SP.cpLen(s);
  if ((m + bom) * 4 > MAX_BYTES) raise(T.MemoryError);
  const out = new Uint8Array((m + bom) * 4);
  const dv = new DataView(out.buffer);
  let p = 0;
  if (bom) dv.setUint32(p++ * 4, 0xfeff, c.le);
  for (const ch of s) dv.setUint32(p++ * 4, ch.codePointAt(0)!, c.le);
  return out;
}

export function encodeStr(s: string, encoding: any = "utf-8", errors: any = "strict"): PyBytes {
  const c = codecOf(encoding, "encode");
  const err = errorsOf(errors, "encode");
  // (utf-8-sig: a BOM, then utf-8's own encoding, its errors utf-8's)
  if (c.kind === "utf8" && c.bom) {
    const body = encodeStr(s, "utf-8", err);
    const out = new Uint8Array(body.n + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body.a.subarray(0, body.n), 3);
    return new PyBytes(out);
  }
  // (fast paths: nothing for a handler)
  if (c.kind === "utf8" && !LONE.test(s)) return new PyBytes(new TextEncoder().encode(s));
  if (c.kind === "latin1" && !/[^\x00-\xff]/.test(s)) return new PyBytes(new Uint8Array(Buffer.from(s, "latin1")));
  if (c.kind === "ascii" && !/[^\x00-\x7f]/.test(s)) return new PyBytes(new Uint8Array(Buffer.from(s, "latin1")));
  if ((c.kind === "utf16" || c.kind === "utf32") && !LONE.test(s)) return new PyBytes(fixedWidth(s, c));
  const out = new ByteBuf();
  // (a charmap codec: its table inverted; the error's codec is 'charmap')
  let inv: Map<number, number> | null = null;
  if (c.table) {
    inv = new Map();
    c.table.forEach((v, i) => v >= 0 && inv!.set(v, i));
  }
  const lim = c.kind === "ascii" ? 0x80 : c.kind === "latin1" ? 0x100 : 0x110000;
  const ok = inv ? (cp: number) => inv!.has(cp) : (cp: number) => cp < lim && (lim < 0x110000 || !isSur(cp));
  const reason = c.kind === "ascii" ? "ordinal not in range(128)" : c.kind === "latin1" ? "ordinal not in range(256)" : inv ? "character maps to <undefined>" : "surrogates not allowed";
  const ename = inv ? "charmap" : c.name;
  const put = (cp: number) => {
    switch (c.kind) {
      case "utf8":
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6)), out.push(0x80 | (cp & 63));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12)), out.push(0x80 | ((cp >> 6) & 63)), out.push(0x80 | (cp & 63));
        else out.push(0xf0 | (cp >> 18)), out.push(0x80 | ((cp >> 12) & 63)), out.push(0x80 | ((cp >> 6) & 63)), out.push(0x80 | (cp & 63));
        return;
      case "utf16": {
        const unit = (u: number) => (c.le ? (out.push(u & 255), out.push(u >> 8)) : (out.push(u >> 8), out.push(u & 255)));
        if (cp < 0x10000) unit(cp);
        else {
          unit(0xd800 + ((cp - 0x10000) >> 10));
          unit(0xdc00 + ((cp - 0x10000) & 1023));
        }
        return;
      }
      case "utf32":
        if (c.le) out.push(cp & 255), out.push((cp >> 8) & 255), out.push((cp >> 16) & 255), out.push(cp >>> 24);
        else out.push(cp >>> 24), out.push((cp >> 16) & 255), out.push((cp >> 8) & 255), out.push(cp & 255);
        return;
      default:
        out.push(inv ? inv.get(cp)! : cp);
    }
  };
  // (a handler's replacement text, encoded; one it cannot encode is the
  // original error, as CPython's)
  const putText = (t: string, start: number, end: number) => {
    for (const ch of t) {
      const cp = ch.codePointAt(0)!;
      if (!ok(cp)) encodeError(ename, s, start, end, reason);
      put(cp);
    }
  };
  if (c.bom) put(0xfeff);
  // (walked in place: u the UTF-16 index, i the code point's position)
  const cpAt = (u: number) => s.codePointAt(u)!;
  const width = (cp: number) => (cp > 0xffff ? 2 : 1);
  for (let u = 0, i = 0; u < s.length; ) {
    const cp = cpAt(u);
    if (ok(cp)) {
      put(cp);
      u += width(cp);
      i++;
      continue;
    }
    // (the run of characters the codec cannot take; CPython's UTF-16 and
    // UTF-32 encoders take them one at a time)
    let v = u + width(cp), j = i + 1;
    if (c.kind !== "utf16" && c.kind !== "utf32") {
      while (v < s.length && !ok(cpAt(v))) {
        v += width(cpAt(v));
        j++;
      }
    }
    handlerCheck(err);
    const each = (f: (x: number) => void) => {
      for (let w = u; w < v; ) {
        const x = cpAt(w);
        f(x);
        w += width(x);
      }
    };
    switch (err) {
      case "strict":
        return encodeError(ename, s, i, j, reason);
      case "ignore":
        break;
      case "replace":
        each(() => putText("?", i, j));
        break;
      case "backslashreplace":
        each((x) => putText(charEsc(x), i, j));
        break;
      case "xmlcharrefreplace":
        each((x) => putText(`&#${x};`, i, j));
        break;
      case "namereplace":
        // (a surrogate has no name: its escape; a named character needs
        // the Unicode names, which Sagebrush has no table of yet)
        each((x) => {
          if (!isSur(x)) raise(T.NotImplementedError, "the namereplace error handler for named characters is not supported yet");
        });
        each((x) => putText(charEsc(x), i, j));
        break;
      case "surrogateescape": {
        // (raw bytes; a UTF-16 or UTF-32 encoder takes them only in whole
        // code units, else the original error, as CPython's)
        const unitSize = c.kind === "utf16" ? 2 : c.kind === "utf32" ? 4 : 1;
        if ((j - i) % unitSize !== 0) encodeError(ename, s, i, j, reason);
        each((x) => {
          if (x < 0xdc80 || x > 0xdcff) encodeError(ename, s, i, j, reason);
        });
        each((x) => out.push(x - 0xdc00));
        break;
      }
      case "surrogatepass":
        if (c.kind === "ascii" || c.kind === "latin1" || inv) encodeError(ename, s, i, j, reason);
        each((x) => {
          if (!isSur(x)) encodeError(ename, s, i, j, reason);
        });
        each((x) => put(x));
        break;
    }
    u = v;
    i = j;
  }
  return new PyBytes(out.bytes());
}

// -------------------------------------------------------------- decoding

// The next code point of b at i for UTF-8: [code point, length], or [-1,
// length, reason] for an invalid run (its length, CPython's)
function nextUtf8(b: Uint8Array, i: number): [number, number, string?] {
  const n = b.length, x = b[i];
  if (x < 0x80) return [x, 1];
  let need: number, lo = 0x80, hi = 0xbf, cp: number;
  if (x >= 0xc2 && x <= 0xdf) (need = 1), (cp = x & 31);
  else if (x >= 0xe0 && x <= 0xef) {
    need = 2;
    cp = x & 15;
    if (x === 0xe0) lo = 0xa0;
    if (x === 0xed) hi = 0x9f;
  } else if (x >= 0xf0 && x <= 0xf4) {
    need = 3;
    cp = x & 7;
    if (x === 0xf0) lo = 0x90;
    if (x === 0xf4) hi = 0x8f;
  } else return [-1, 1, "invalid start byte"];
  for (let k = 1; k <= need; k++) {
    if (i + k >= n) return [-1, k, "unexpected end of data"];
    const y = b[i + k];
    if (y < (k === 1 ? lo : 0x80) || y > (k === 1 ? hi : 0xbf)) return [-1, k, "invalid continuation byte"];
    cp = (cp << 6) | (y & 63);
  }
  return [cp, need + 1];
}

const MAX_UNITS = 2 ** 29 - 24; // (V8's longest string)
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeBytes(bytes: Uint8Array, encoding: any = "utf-8", errors: any = "strict"): string {
  const c = codecOf(encoding, "decode");
  const err = errorsOf(errors, "decode");
  // (utf-8-sig: one leading BOM dropped, the rest utf-8's own decoding, its
  // errors utf-8's, on the bytes after the BOM, as CPython's)
  if (c.kind === "utf8" && c.bom) {
    const b = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    return decodeBytes(b, "utf-8", err);
  }
  // (fast paths: valid input; TextDecoder's fatal UTF-8 accepts exactly
  // what CPython's does, a BOM kept)
  if (c.kind === "latin1") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("latin1");
  if (c.kind === "ascii" && bytes.every((x) => x < 0x80)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("latin1");
  if (c.kind === "utf8") {
    try {
      return UTF8_FATAL.decode(bytes);
    } catch {
      // (an error: the loop below finds it, with CPython's position)
    }
  }
  const n = bytes.length;
  let i = 0, le = c.le;
  if (c.bom) {
    if (c.kind === "utf16" && n >= 2) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) (le = true), (i = 2);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) (le = false), (i = 2);
    } else if (c.kind === "utf32" && n >= 4) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) (le = true), (i = 4);
      else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) (le = false), (i = 4);
    }
  }
  // (errors name 'charmap' for a charmap codec, and a BOM-detecting UTF-16
  // or UTF-32 its byte order, as CPython's)
  const dname = c.table ? "charmap" : c.bom ? `${c.name}-${le ? "le" : "be"}` : c.name;
  const u16 = (k: number) => (le ? bytes[k] | (bytes[k + 1] << 8) : (bytes[k] << 8) | bytes[k + 1]);
  const u32 = (k: number) => (le ? (bytes[k] | (bytes[k + 1] << 8) | (bytes[k + 2] << 16) | (bytes[k + 3] << 24)) >>> 0 : ((bytes[k] << 24) | (bytes[k + 1] << 16) | (bytes[k + 2] << 8) | bytes[k + 3]) >>> 0);
  // (the result's UTF-16 units, grown by doubling, at most a V8 string's
  // length: past it MemoryError; a lone high surrogate a handler wrote,
  // followed by a low one, would join into one character: refused, SP)
  let units = new Uint16Array(256), nu = 0, loneHigh = false;
  const unit = (x: number, lone: boolean) => {
    if (nu === units.length) {
      if (nu >= MAX_UNITS) raise(T.MemoryError);
      const b = new Uint16Array(Math.min(nu * 2, MAX_UNITS));
      b.set(units);
      units = b;
    }
    if (loneHigh && x >= 0xdc00 && x <= 0xdfff) SP.refuseMerge();
    units[nu++] = x;
    loneHigh = lone && x >= 0xd800 && x <= 0xdbff;
  };
  const emit = (cp: number) => {
    if (cp > 0xffff) {
      unit(0xd800 + ((cp - 0x10000) >> 10), false);
      unit(0xdc00 + ((cp - 0x10000) & 1023), false);
    } else unit(cp, isSur(cp));
  };
  const text = (t: string) => {
    for (let k = 0; k < t.length; k++) unit(t.charCodeAt(k), false);
  };
  while (i < n) {
    // [code point or -1, length, reason]
    let r: [number, number, string?];
    switch (c.kind) {
      case "ascii":
        r = bytes[i] < 0x80 ? [bytes[i], 1] : [-1, 1, "ordinal not in range(128)"];
        break;
      case "charmap": {
        const v = c.table![bytes[i]];
        r = v >= 0 ? [v, 1] : [-1, 1, "character maps to <undefined>"];
        break;
      }
      case "utf16": {
        if (i + 1 >= n) {
          r = [-1, n - i, "truncated data"];
          break;
        }
        const u = u16(i);
        if (u < 0xd800 || u > 0xdfff) r = [u, 2];
        else if (u >= 0xdc00) r = [-1, 2, "illegal encoding"];
        else if (i + 3 >= n) r = [-1, n - i, "unexpected end of data"];
        else {
          const v = u16(i + 2);
          r = v >= 0xdc00 && v <= 0xdfff ? [0x10000 + ((u - 0xd800) << 10) + (v - 0xdc00), 4] : [-1, 2, "illegal UTF-16 surrogate"];
        }
        break;
      }
      case "utf32": {
        if (i + 3 >= n) {
          r = [-1, n - i, "truncated data"];
          break;
        }
        const u = u32(i);
        r = u > 0x10ffff ? [-1, 4, "code point not in range(0x110000)"] : isSur(u) ? [-1, 4, "code point in surrogate code point range(0xd800, 0xe000)"] : [u, 4];
        break;
      }
      default:
        r = nextUtf8(bytes, i);
    }
    if (r[0] >= 0) {
      emit(r[0]);
      i += r[1];
      continue;
    }
    const end = i + r[1], reason = r[2]!;
    handlerCheck(err);
    switch (err) {
      case "strict":
        return decodeError(dname, bytes, i, end, reason);
      case "ignore":
        break;
      case "replace":
        unit(0xfffd, false);
        break;
      case "backslashreplace":
        for (let k = i; k < end; k++) text(`\\x${hex(bytes[k], 2)}`);
        break;
      case "surrogateescape": {
        // (the span's leading bytes of 128 or more, at most four, each
        // escaped, then decoding resumes after them, as CPython's handler:
        // none, the original error)
        let k = i;
        while (k < end && k < i + 4 && bytes[k] >= 0x80) unit(0xdc00 + bytes[k++], true);
        if (k === i) decodeError(dname, bytes, i, end, reason);
        i = k;
        continue;
      }
      case "surrogatepass": {
        // (an encoded surrogate: utf-8's ED A0..BF 80..BF, utf-16's lone
        // unit, utf-32's value)
        let sur = -1, len = 0;
        if (c.kind === "utf8" && bytes[i] === 0xed && i + 2 < n && bytes[i + 1] >= 0xa0 && bytes[i + 1] <= 0xbf && bytes[i + 2] >= 0x80 && bytes[i + 2] <= 0xbf) (sur = 0xd000 | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)), (len = 3);
        else if (c.kind === "utf16" && i + 1 < n && isSur(u16(i))) (sur = u16(i)), (len = 2);
        else if (c.kind === "utf32" && i + 3 < n && isSur(u32(i))) (sur = u32(i)), (len = 4);
        if (sur < 0) decodeError(dname, bytes, i, end, reason);
        unit(sur, true);
        i += len;
        continue;
      }
      default:
        // (the encoding-only handlers: CPython's TypeError for decoding)
        raise(T.TypeError, `don't know how to handle UnicodeDecodeError in error callback`);
    }
    i = end;
  }
  // (into a string, in chunks)
  let out = "";
  for (let k = 0; k < nu; k += 8192) out += String.fromCharCode.apply(null, units.subarray(k, Math.min(nu, k + 8192)) as any);
  return out;
}
void UTF8;
