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
const cache = new Map<string, Pos | null>();
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

// The surrogate-pair index of s, or null if it has none.
let lastKey: string | null = null;
let lastVal: Pos | null = null;
export function pairs(s: string): Pos | null {
  if (s.length < SHORT) return SURROGATE.test(s) ? scan(s) : null;
  // (the string last asked about first: a loop over one string compares
  // its pointer, not its contents)
  if (s === lastKey) return lastVal;
  const p = longPairs(s);
  lastKey = s;
  return (lastVal = p);
}
function longPairs(s: string): Pos | null {
  if (s === bigKey) return bigVal;
  const hit = cache.get(s);
  if (hit !== undefined) {
    cache.delete(s);
    cache.set(s, hit);
    return hit;
  }
  const p = scan(s);
  if (s.length > CACHE_UNITS >> 3) {
    bigKey = s;
    bigVal = p;
    return p;
  }
  while (cachedUnits + s.length > CACHE_UNITS) {
    const old = cache.keys().next().value as string;
    cache.delete(old);
    cachedUnits -= old.length;
  }
  cache.set(s, p);
  cachedUnits += s.length;
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
