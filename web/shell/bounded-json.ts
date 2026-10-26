// A notebook's or board's JSON text for the shell (plan-bash-shell r3 §3.1: documents read as their JSON
// text), within a byte cap: exactly JSON.stringify(value, null, 1) + "\n" as UTF-8, but refused the moment
// the text would pass `max` bytes (LIMIT-BASH-S2-2).
//
// Nothing is built whole to learn its size (LIMIT-BASH-S2-R2-1, CORR-BASH-S2-R2-2): strings and keys are
// escaped and UTF-8-encoded a code unit at a time, straight into fixed-size chunks, and the cap is checked
// before each byte is added; numbers (at most 24 characters) and the indentation are written the same way.
// So the memory it takes is the output's, never a value's:
//   - while it runs: the chunks written so far, ceil(n / CHUNK_BYTES) of CHUNK_BYTES each for n bytes of
//     output so far (n <= max), however many values, keys or tokens the document has; and the walk's stack
//     (one frame per level of nesting);
//   - on success, at most: those chunks and the result being copied out of them, 2 n + CHUNK_BYTES bytes;
//   - refused: the chunks up to the cap, max + CHUNK_BYTES bytes at most, released with the TooLarge.

/** The text would be more than the cap. */
export class TooLarge extends Error {}

/** The builder's chunk size. */
export const CHUNK_BYTES = 64 * 1024;

/** What a call built (a test's seam), kept current as it runs, refused or not: the chunks it holds, and the output's bytes so far. */
export type BoundedJsonStats = { chunks: number; bytes: number };

const HEX = "0123456789abcdef";

/** `value` (plain JSON data, as documents are kept) as JSON.stringify(value, null, 1) + "\n", in UTF-8, or TooLarge past `max` bytes. */
export function boundedJson(value: unknown, max: number, stats?: BoundedJsonStats): Uint8Array {
  const chunks: Uint8Array[] = [];
  let chunk = new Uint8Array(0), at = 0, n = 0;
  if (stats) Object.assign(stats, { chunks: 0, bytes: 0 });
  const byte = (b: number) => {
    if (n >= max) throw new TooLarge(`larger than ${max} bytes`);
    if (at === chunk.length) {
      chunk = new Uint8Array(CHUNK_BYTES);
      chunks.push(chunk);
      at = 0;
      if (stats) stats.chunks = chunks.length;
    }
    chunk[at++] = b;
    n++;
    if (stats) stats.bytes = n;
  };
  // (ASCII only: punctuation, literals, numbers and escapes)
  const ascii = (s: string) => {
    for (let i = 0; i < s.length; i++) byte(s.charCodeAt(i));
  };
  const indent = (k: number) => {
    byte(10);
    for (let i = 0; i < k; i++) byte(32);
  };
  const escape = (c: number) => {
    ascii("\\u");
    byte(HEX.charCodeAt((c >> 12) & 15));
    byte(HEX.charCodeAt((c >> 8) & 15));
    byte(HEX.charCodeAt((c >> 4) & 15));
    byte(HEX.charCodeAt(c & 15));
  };
  // JSON.stringify's quoting (ES2019's well-formed form), encoded as it goes
  const string = (s: string) => {
    byte(34);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34) ascii('\\"');
      else if (c === 92) ascii("\\\\");
      else if (c < 32) {
        if (c === 8) ascii("\\b");
        else if (c === 9) ascii("\\t");
        else if (c === 10) ascii("\\n");
        else if (c === 12) ascii("\\f");
        else if (c === 13) ascii("\\r");
        else escape(c);
      } else if (c < 0x80) byte(c);
      else if (c < 0x800) {
        byte(0xc0 | (c >> 6));
        byte(0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdfff) {
        const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
          const p = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          byte(0xf0 | (p >> 18));
          byte(0x80 | ((p >> 12) & 63));
          byte(0x80 | ((p >> 6) & 63));
          byte(0x80 | (p & 63));
          i++;
        } else escape(c); // (a lone surrogate)
      } else {
        byte(0xe0 | (c >> 12));
        byte(0x80 | ((c >> 6) & 63));
        byte(0x80 | (c & 63));
      }
    }
    byte(34);
  };
  const seen = new Set<object>();
  // (as JSON.stringify: toJSON first; undefined, functions and symbols are left out of objects and are null in arrays)
  const prep = (v: unknown, key: string): unknown => {
    if (v !== null && typeof v === "object" && typeof (v as any).toJSON === "function") return (v as any).toJSON(key);
    return v;
  };
  const skip = (v: unknown) => v === undefined || typeof v === "function" || typeof v === "symbol";
  const has = Object.prototype.hasOwnProperty;
  const emit = (v: unknown, depth: number): void => {
    if (v === null) return ascii("null");
    switch (typeof v) {
      case "boolean":
        return ascii(v ? "true" : "false");
      case "number":
        return ascii(Number.isFinite(v) ? String(v) : "null");
      case "string":
        return string(v);
      case "bigint":
        throw new TypeError("a document holds no BigInt");
    }
    const o = v as object;
    if (seen.has(o)) throw new TypeError("a document holds no cycle");
    seen.add(o);
    if (Array.isArray(o)) {
      if (!o.length) ascii("[]");
      else {
        byte(91);
        for (let i = 0; i < o.length; i++) {
          if (i) byte(44);
          indent(depth + 1);
          const x = prep(o[i], String(i));
          if (skip(x)) ascii("null");
          else emit(x, depth + 1);
        }
        indent(depth);
        byte(93);
      }
    } else {
      // (for-in over own keys: Object.keys's order, without an array of every key)
      let first = true;
      for (const k in o) {
        if (!has.call(o, k)) continue;
        const x = prep((o as any)[k], k);
        if (skip(x)) continue;
        byte(first ? 123 : 44);
        first = false;
        indent(depth + 1);
        string(k);
        ascii(": ");
        emit(x, depth + 1);
      }
      if (first) ascii("{}");
      else {
        indent(depth);
        byte(125);
      }
    }
    seen.delete(o);
  };
  const top = prep(value, "");
  if (skip(top)) throw new TypeError("a document is a value");
  emit(top, 0);
  byte(10);
  const out = new Uint8Array(n);
  let left = n;
  for (let i = 0; i < chunks.length; i++) {
    const take = Math.min(CHUNK_BYTES, left);
    out.set(take === CHUNK_BYTES ? chunks[i] : chunks[i].subarray(0, take), i * CHUNK_BYTES);
    chunks[i] = undefined as unknown as Uint8Array; // (each chunk released once copied)
    left -= take;
  }
  return out;
}
