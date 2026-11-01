// The export's direct writer (E1 r2a heap plan r2c §2; daybreak2's P1): JSON text and UTF-8 written byte by byte
// straight into a slice at an index, exactly as JSON.stringify and TextEncoder write them, with no string, view or
// scratch buffer per call.  Each function writes at `at` and returns the index after what it wrote; the caller has
// made room for the most it can write (jsonMax, utf8Max, NUM_MAX).
//   - JSON strings: `"` and `\` escaped; U+0008, U+000C, U+000A, U+000D, U+0009 as \b \f \n \r \t; any other control
//     below U+0020 as \u00xx (lowercase); a lone surrogate as \udxxx (well-formed JSON.stringify); U+2028 and U+2029
//     as they are; everything else as UTF-8, a surrogate pair as its 4-byte form;
//   - UTF-8: the same, unescaped, a lone surrogate as U+FFFD (TextEncoder's);
//   - numbers: JSON.stringify's text (NaN and ±Infinity as null, -0 as 0), a safe integer by a digit loop, any other
//     finite number through String(n), which for a finite number is that text.

const HEX = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102];
// (the one-letter escapes, by code: \b \t \n \f \r)
const ESC: number[] = [];
ESC[8] = 0x62; ESC[9] = 0x74; ESC[10] = 0x6e; ESC[12] = 0x66; ESC[13] = 0x72;

/** The most putJson writes for `s`. */
export const jsonMax = (s: string) => 6 * s.length + 2;
/** The most putUtf8 writes for `s` from `from`. */
export const utf8Max = (s: string, from = 0) => 3 * (s.length - from);
/** The most putNum writes (String(n) of a finite double is at most 24 characters, "-1.2345678901234567e-308"). */
export const NUM_MAX = 24;

/** \uXXXX for the UTF-16 unit `c`. */
function putU(b: Uint8Array, at: number, c: number): number {
  b[at] = 0x5c; b[at + 1] = 0x75;
  b[at + 2] = HEX[(c >> 12) & 15]; b[at + 3] = HEX[(c >> 8) & 15]; b[at + 4] = HEX[(c >> 4) & 15]; b[at + 5] = HEX[c & 15];
  return at + 6;
}

/** JSON.stringify(s) as UTF-8. */
export function putJson(b: Uint8Array, at: number, s: string): number {
  b[at++] = 0x22;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c >= 0x20 && c !== 0x22 && c !== 0x5c) b[at++] = c;
      else if (c === 0x22 || c === 0x5c) { b[at++] = 0x5c; b[at++] = c; }
      else if (ESC[c] !== undefined) { b[at++] = 0x5c; b[at++] = ESC[c]; }
      else at = putU(b, at, c);
    } else if (c < 0x800) {
      b[at++] = 0xc0 | (c >> 6); b[at++] = 0x80 | (c & 63);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if ((d & 0xfc00) === 0xdc00) {
        const p = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        b[at++] = 0xf0 | (p >> 18); b[at++] = 0x80 | ((p >> 12) & 63); b[at++] = 0x80 | ((p >> 6) & 63); b[at++] = 0x80 | (p & 63);
        i++;
      } else at = putU(b, at, c);
    } else {
      b[at++] = 0xe0 | (c >> 12); b[at++] = 0x80 | ((c >> 6) & 63); b[at++] = 0x80 | (c & 63);
    }
  }
  b[at++] = 0x22;
  return at;
}

/** `s` from its unit `from` as UTF-8, as TextEncoder writes it. */
export function putUtf8(b: Uint8Array, at: number, s: string, from = 0): number {
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) b[at++] = c;
    else if (c < 0x800) { b[at++] = 0xc0 | (c >> 6); b[at++] = 0x80 | (c & 63); }
    else if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if ((d & 0xfc00) === 0xdc00) {
        const p = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        b[at++] = 0xf0 | (p >> 18); b[at++] = 0x80 | ((p >> 12) & 63); b[at++] = 0x80 | ((p >> 6) & 63); b[at++] = 0x80 | (p & 63);
        i++;
      } else { b[at++] = 0xef; b[at++] = 0xbf; b[at++] = 0xbd; }
    } else { b[at++] = 0xe0 | (c >> 12); b[at++] = 0x80 | ((c >> 6) & 63); b[at++] = 0x80 | (c & 63); }
  }
  return at;
}

/** ASCII text (a number's String, a fixed fragment's), byte for byte. */
function putAscii(b: Uint8Array, at: number, s: string): number {
  for (let i = 0; i < s.length; i++) b[at++] = s.charCodeAt(i);
  return at;
}

/** JSON.stringify(n). */
export function putNum(b: Uint8Array, at: number, n: number): number {
  // (NaN, Infinity and -Infinity: null; -0 and 0: 0)
  if (n !== n || n === Infinity || n === -Infinity) return putAscii(b, at, "null");
  if (n === 0) { b[at] = 0x30; return at + 1; }
  if (!Number.isSafeInteger(n)) return putAscii(b, at, String(n));
  if (n < 0) { b[at++] = 0x2d; n = -n; }
  let k = 1;
  for (let x = n; x >= 10; x = Math.floor(x / 10)) k++;
  for (let i = at + k - 1; i >= at; i--) { b[i] = 0x30 + (n % 10); n = Math.floor(n / 10); }
  return at + k;
}

/** The most putValue writes for `v`. */
export function valueMax(v: unknown): number {
  if (typeof v === "string") return jsonMax(v);
  if (typeof v === "number") return NUM_MAX;
  if (v === null || typeof v === "boolean") return 5;
  return 3 * (JSON.stringify(v)?.length ?? 0);
}
/** JSON.stringify(v) for a value read from IndexedDB (a string or a number in practice; anything else through
 * JSON.stringify itself).  Never undefined: the callers leave such a key out, as JSON.stringify does. */
export function putValue(b: Uint8Array, at: number, v: unknown): number {
  if (typeof v === "string") return putJson(b, at, v);
  if (typeof v === "number") return putNum(b, at, v);
  if (v === null) return putAscii(b, at, "null");
  if (typeof v === "boolean") return putAscii(b, at, v ? "true" : "false");
  return putUtf8(b, at, JSON.stringify(v) ?? "null");
}

/** A fixed fragment's bytes (ASCII), made once. */
export const frag = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/** `src[from, to)` copied into `b` at `at` by an index loop (no view). */
export function putBytes(b: Uint8Array, at: number, src: Uint8Array, from: number, to: number): number {
  for (let i = from; i < to; i++) b[at++] = src[i];
  return at;
}

// ------------------------------------------------------------------ exact lengths, counted without writing
/** UTF-8 bytes of `s` as TextEncoder writes it (a lone surrogate as U+FFFD), counted without encoding it. */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** UTF-8 bytes of JSON.stringify(s), quotes included, counted without building it. */
export function jsonLen(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) n += 2;
    else if (c < 0x20) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { if (i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 6; }
    else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
    else n += 3;
  }
  return n;
}
/** The length of JSON.stringify(n), counted (a string only for a non-integer, as putNum makes one). */
export function numLen(n: number): number {
  if (n !== n || n === Infinity || n === -Infinity) return 4;
  if (n === 0) return 1;
  if (!Number.isSafeInteger(n)) return String(n).length;
  let k = n < 0 ? 2 : 1;
  for (let x = Math.abs(n); x >= 10; x = Math.floor(x / 10)) k++;
  return k;
}
/** The length of what putValue writes for `v`. */
export function valueLen(v: unknown): number {
  if (typeof v === "string") return jsonLen(v);
  if (typeof v === "number") return numLen(v);
  if (v === null) return 4;
  if (typeof v === "boolean") return v ? 4 : 5;
  return utf8Len(JSON.stringify(v) ?? "null");
}
