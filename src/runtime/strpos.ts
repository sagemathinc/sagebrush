// Python's str positions count code points; a JS string's count UTF-16
// units, and a character beyond U+FFFF takes two (a surrogate pair). The two
// agree unless the string has a pair, so a string without one keeps the
// plain path: pairs(s) is null for it.  For a string with pairs, positions
// convert by binary search over the pairs' UTF-16 offsets.  (A lone
// surrogate is one code point in Python too, so it needs no conversion.)

const SURROGATE = /[\uD800-\uDFFF]/;
// Strings this short are scanned each time; longer ones' answers are kept,
// in at most CACHE_UNITS units of recently used strings, plus the latest
// string too long for that (so a loop indexing one huge string scans it
// once, and at most one such string is kept alive).
const SHORT = 256;
const CACHE_UNITS = 1 << 23;
const cache = new Map<string, Int32Array | null>();
let cachedUnits = 0;
let bigKey: string | null = null;
let bigVal: Int32Array | null = null;

function scan(s: string): Int32Array | null {
  let i = s.search(SURROGATE);
  if (i < 0) return null;
  const out: number[] = [];
  for (; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) out.push(i++);
    }
  }
  return out.length ? Int32Array.from(out) : null;
}

// The UTF-16 offsets of s's surrogate pairs, in order, or null if it has none.
let lastKey: string | null = null;
let lastVal: Int32Array | null = null;
export function pairs(s: string): Int32Array | null {
  if (s.length < SHORT) return SURROGATE.test(s) ? scan(s) : null;
  // (the string last asked about first: a loop over one string compares
  // its pointer, not its contents)
  if (s === lastKey) return lastVal;
  lastKey = s;
  return (lastVal = longPairs(s));
}
function longPairs(s: string): Int32Array | null {
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

// The number of pairs whose code-point index (p[j] - j) is below i.
function before(p: Int32Array, i: number): number {
  let lo = 0, hi = p.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid] - mid < i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The UTF-16 offset of code point i (0 <= i <= length).
export const unitOf = (p: Int32Array, i: number): number => i + before(p, i);

// The code-point index of UTF-16 offset u (u not inside a pair).
export function cpOf(p: Int32Array, u: number): number {
  let lo = 0, hi = p.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return u - lo;
}

// len(s) in code points.
export function cpLen(s: string): number {
  const p = pairs(s);
  return p === null ? s.length : s.length - p.length;
}

// The character at code point i of a string with pairs p.
export function charAt(s: string, p: Int32Array, i: number): string {
  const u = unitOf(p, i);
  const c = s.charCodeAt(u);
  return c >= 0xd800 && c < 0xdc00 && u + 1 < s.length && (s.charCodeAt(u + 1) & 0xfc00) === 0xdc00 ? s.slice(u, u + 2) : s[u];
}
