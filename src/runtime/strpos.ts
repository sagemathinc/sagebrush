// Python's str positions count code points; a JS string's count UTF-16
// units, and a character beyond U+FFFF takes two (a surrogate pair). The two
// agree unless the string has a pair, so a string without one keeps the
// plain path: pairs(s) is null for it.  For a string with pairs, positions
// convert through a sparse index (HARD-AF6-1): for every block of B units,
// the number of pairs that start before it, so the index is a single
// Int32Array of length/B entries, made in one pass with nothing per pair; a
// conversion is a binary search over the blocks and a walk of at most B
// units.  (A lone surrogate is one code point in Python too, so it needs no
// conversion.)

import { T, raise } from "./object";
import { INTR } from "./interrupt";

const SURROGATE = /[\uD800-\uDFFF]/;
const B = 32;

export class Pos {
  // c[b]: the pairs starting before unit b * B; n: all of them
  constructor(
    public s: string,
    public c: Int32Array,
    public n: number,
  ) {}
}

// Strings this short are scanned each time; longer ones' answers are kept,
// in at most CACHE_UNITS units of recently used strings, plus the latest
// string too long for that (so a loop indexing one huge string scans it
// once, and at most one such string is kept alive).
const SHORT = 256;
const CACHE_UNITS = 1 << 23;
type Entry = { key: string; p: Pos | null };
const cache = new Map<string, Entry>();
let cachedUnits = 0;
let bigKey: string | null = null;
let bigVal: Pos | null = null;

const isHigh = (c: number) => c >= 0xd800 && c < 0xdc00;
const isLow = (c: number) => c >= 0xdc00 && c < 0xe000;

function scan(s: string): Pos | null {
  const first = s.search(SURROGATE);
  if (first < 0) return null;
  const len = s.length;
  let c: Int32Array;
  try {
    c = new Int32Array(Math.floor(len / B) + 1);
  } catch {
    raise(T.MemoryError, "string too long to index by code point");
  }
  let n = 0;
  for (let i = Math.floor(first / B) * B; i < len; i++) {
    if (i % B === 0) {
      c[i / B] = n;
      // (Stop reaches a long scan)
      if ((i & 0xfffff) === 0 && INTR[0]) {
        INTR[0] = 0;
        raise(T.KeyboardInterrupt);
      }
    }
    if (isHigh(s.charCodeAt(i)) && i + 1 < len && isLow(s.charCodeAt(i + 1))) {
      n++;
      i++;
      // (a pair across a block boundary counts for the block after it)
      if ((i % B) === 0) c[i / B] = n;
    }
  }
  if (len % B === 0) c[len / B] = n;
  return n ? new Pos(s, c, n) : null;
}

// The comparisons of contents that can be full: of two strings of the same
// length, and the cache's lookup when it finds one (the tests count them).
export const compares = { n: 0 };

// An equal string that is another object becomes the one every reference
// here holds (lastKey, bigKey, its index's s, its cache key): one body is
// kept alive, not two equal ones (HARD-3F4-1), and the next comparisons are
// of pointers.  Where it was found says which of them hold it, so they are
// assigned, not compared again (HARD-3F4-2).  A new object is compared in
// full at most twice: with lastKey, which can fail late when it is as long
// and differs near the end, then with what finds it (bigKey or the cache)
// (HARD-3F4-3); bigKey is not compared again when it is lastKey.  (The
// cache's lookup is V8's Map's: a key of the same hash is compared too.)
let lastKey: string | null = null;
let lastVal: Pos | null = null;
let lastBig = false; // lastKey is bigKey
let lastEntry: Entry | null = null; // lastKey's cache entry
let lastTouched = false; // lastKey was asked about again since it was found

// The surrogate-pair index of s, or null if it has none.
export function pairs(s: string): Pos | null {
  if (s.length < SHORT) return SURROGATE.test(s) ? scan(s) : null;
  // (the string last asked about first: a loop over one string compares
  // its pointer, not its contents; an equal string that is another object is
  // compared in full (at most twice, above), then kept as the key, so the next asks about it
  // compare pointers again: json.loads of a new json.dumps result took a
  // full comparison per character)
  if (lastKey !== null && s.length === lastKey.length) compares.n++;
  if (s === lastKey) {
    lastKey = s;
    if (lastBig) bigKey = s;
    if (lastVal !== null) lastVal.s = s;
    lastTouched = true;
    return lastVal;
  }
  // (the cache entry of the string asked about before is re-keyed by the
  // object last asked about, deleting its own key, a pointer comparison, and
  // made the most recently used: until then the old key is a second body of
  // at most CACHE_UNITS >> 3 units)
  if (lastEntry !== null && lastTouched) {
    cache.delete(lastEntry.key);
    lastEntry.key = lastKey!;
    cache.set(lastKey!, lastEntry);
  }
  lastTouched = false;
  const p = longPairs(s, lastBig);
  lastKey = s;
  return (lastVal = p);
}
// (wasBig: lastKey, just found unequal to s, is bigKey)
function longPairs(s: string, wasBig: boolean): Pos | null {
  lastBig = false;
  lastEntry = null;
  if (!wasBig && bigKey !== null && s.length === bigKey.length) compares.n++;
  if (!wasBig && s === bigKey) {
    bigKey = s;
    if (bigVal !== null) bigVal.s = s;
    lastBig = true;
    return bigVal;
  }
  const hit = cache.get(s);
  if (hit !== undefined) {
    compares.n++;
    // (re-inserted under the new object, which the index then holds too)
    cache.delete(hit.key);
    hit.key = s;
    cache.set(s, hit);
    if (hit.p !== null) hit.p.s = s;
    lastEntry = hit;
    return hit.p;
  }
  const p = scan(s);
  if (s.length > CACHE_UNITS >> 3) {
    bigKey = s;
    bigVal = p;
    lastBig = true;
    return p;
  }
  while (cachedUnits + s.length > CACHE_UNITS) {
    const old = cache.keys().next().value as string;
    cache.delete(old);
    cachedUnits -= old.length;
  }
  const e = { key: s, p };
  cache.set(s, e);
  cachedUnits += s.length;
  lastEntry = e;
  return p;
}

// Walking from block b's start: the first unit to look at and the pairs
// before it (a block may start inside a pair, its low half).
function blockStart(p: Pos, b: number): [number, number] {
  const u = b * B;
  return u > 0 && u < p.s.length && isLow(p.s.charCodeAt(u)) && isHigh(p.s.charCodeAt(u - 1)) ? [u + 1, p.c[b]] : [u, p.c[b]];
}
// The code-point index of the character at unit u, from the pairs before it
// (u - pb), stepping one character from u.
function step(s: string, u: number): number {
  return isHigh(s.charCodeAt(u)) && u + 1 < s.length && isLow(s.charCodeAt(u + 1)) ? 2 : 1;
}

// The UTF-16 offset of code point i (0 <= i <= length).
export function unitOf(p: Pos, i: number): number {
  // (the last block whose first character's index is below i)
  let lo = 0, hi = p.c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (mid * B - p.c[mid] < i) lo = mid;
    else hi = mid - 1;
  }
  let [u, pb] = blockStart(p, lo);
  const s = p.s;
  while (u - pb < i && u < s.length) {
    const k = step(s, u);
    if (k === 2) pb++;
    u += k;
  }
  return u;
}

// The code-point index of UTF-16 offset u (u not inside a pair).
export function cpOf(p: Pos, u: number): number {
  const b = Math.min(Math.floor(u / B), p.c.length - 1);
  let [v, pb] = blockStart(p, b);
  const s = p.s;
  while (v < u) {
    const k = step(s, v);
    if (k === 2) pb++;
    v += k;
  }
  return u - pb;
}

// len(s) in code points.
export function cpLen(s: string): number {
  const p = pairs(s);
  return p === null ? s.length : s.length - p.n;
}

// The character at code point i of a string with pairs p.
export function charAt(s: string, p: Pos, i: number): string {
  const u = unitOf(p, i);
  return step(s, u) === 2 ? s.slice(u, u + 2) : s[u];
}

// ---------------------------------------------------------------- seams
// A JS string cannot tell the astral character U+1F600 from the two lone
// surrogates '\ud83d' + '\ude00', which CPython keeps as two code points
// (CORR-C4D-1).  So an operation that would put a lone high surrogate right
// before a lone low one refuses instead of answering with one character.
const endsHigh = (s: string) => s.length > 0 && isHigh(s.charCodeAt(s.length - 1));
const startsLow = (s: string) => s.length > 0 && isLow(s.charCodeAt(0));

export function refuseMerge(): never {
  raise(T.NotImplementedError, "a lone high surrogate followed by a lone low surrogate would become one character in Sagebrush's strings; not supported");
}
// a + b
export function glue(a: string, b: string): string {
  if (endsHigh(a) && startsLow(b)) refuseMerge();
  return a + b;
}
// parts joined by sep (empty parts let their neighbours meet)
export function joinChecked(parts: string[], sep: string): string {
  let high = false;
  const sepHigh = endsHigh(sep), sepLow = startsLow(sep);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && sep.length) {
      if (high && sepLow) refuseMerge();
      high = sepHigh;
    }
    const p = parts[i];
    if (p.length) {
      if (high && isLow(p.charCodeAt(0))) refuseMerge();
      high = isHigh(p.charCodeAt(p.length - 1));
    }
  }
  return parts.join(sep);
}
// s * n
export function repeatChecked(s: string, n: number): string {
  if (n > 1 && endsHigh(s) && startsLow(s)) refuseMerge();
  return s.repeat(n);
}
// r was built with pieces meeting at these offsets: none may join a pair
export function checkSeams(r: string, seams: number[]): string {
  for (const p of seams) if (p > 0 && p < r.length && isHigh(r.charCodeAt(p - 1)) && isLow(r.charCodeAt(p))) refuseMerge();
  return r;
}

// ---------------------------------------------------------------- searches
// A match of sub at unit j counts only on code-point boundaries: a sub that
// starts with a low surrogate or ends with a high one could otherwise match
// half an astral character (CORR-C4D-2).
export const risky = (sub: string) => sub.length > 0 && (isLow(sub.charCodeAt(0)) || isHigh(sub.charCodeAt(sub.length - 1)));
export function onBoundaries(s: string, j: number, m: number): boolean {
  if (j > 0 && isLow(s.charCodeAt(j)) && isHigh(s.charCodeAt(j - 1))) return false;
  const e = j + m;
  return !(e > 0 && e < s.length && isLow(s.charCodeAt(e)) && isHigh(s.charCodeAt(e - 1)));
}
// s.indexOf(sub, from) / s.lastIndexOf(sub, from), counting only such matches
export function indexOf(s: string, sub: string, from: number): number {
  let j = s.indexOf(sub, from);
  if (!risky(sub)) return j;
  while (j >= 0 && !onBoundaries(s, j, sub.length)) j = s.indexOf(sub, j + 1);
  return j;
}
export function lastIndexOf(s: string, sub: string, from: number): number {
  let j = s.lastIndexOf(sub, from);
  if (!risky(sub)) return j;
  while (j >= 0 && !onBoundaries(s, j, sub.length)) j = j > 0 ? s.lastIndexOf(sub, j - 1) : -1;
  return j;
}
// the pieces of s between non-overlapping matches of sub, left to right
export function split(s: string, sub: string): string[] {
  if (!risky(sub)) return s.split(sub);
  const out: string[] = [];
  let i = 0;
  for (let j = indexOf(s, sub, 0); j >= 0; j = indexOf(s, sub, j + sub.length)) {
    out.push(s.slice(i, j));
    i = j + sub.length;
  }
  out.push(s.slice(i));
  return out;
}
