// The atlas's data model, shared by the build (scripts/build-atlas.mjs), the
// site's Worker (server-rendered pages) and the browser (spaces computed or
// recomputed on the page).  A newspace is what the engine's "dims" and
// "newforms" calls return, so stored and recomputed spaces compare exactly.

export const BOUND = 1000; // traces a_1 .. a_BOUND are stored
/** The level ranges of the home page's table. */
export const RANGES: [number, number][] = [[1, 50], [51, 100], [101, 200], [201, 300], [301, 400], [401, 500], [501, 600], [601, 700], [701, 800], [801, 900], [901, 1000]];

export interface Curve {
  cremona: string; // Cremona's label of the optimal curve, e.g. 389a1
  lmfdb: string; // LMFDB's isogeny class, e.g. 389.a
  ainvs: number[];
  rank: number;
  torsion: number;
}

export interface Orbit {
  label: string; // LMFDB's label N.k.a.x
  letter: string;
  dim: number;
  charpoly: string[]; // of T on the orbit, coefficients from x^0 up (decimal strings)
  traces: string[]; // tr a_1 .. tr a_BOUND (decimal strings)
  lmfdb?: "agrees" | "differs"; // weight 2: label, dimension and tr a_p (p < 1000) against LMFDB
  curve?: Curve; // weight 2, dimension 1: the optimal curve of the isogeny class
}

export interface Space {
  label: string; // N.k.a
  level: number;
  weight: number;
  dims: { new: number; cusp: number; eisenstein: number; modsym: number };
  old: [number, number, number][]; // [M, dim S_k^new(M), multiplicity] for M | N, M < N
  T: [number, number][]; // T = sum c T_q, whose characteristic polynomial separates the orbits
  status: string; // the engine's: "proven"
  checks: string[];
  seconds?: number; // engine time (native, one thread, for stored spaces)
  computed?: "atlas" | "browser";
  newforms: Orbit[];
}

// ------------------------------------------------------------------ labels

export interface Label { level: number; weight: number; letter?: string }

/** "389.2.a" or "389.2.a.e" (trivial character), else null. */
export function parseLabel(s: string): Label | null {
  const m = /^(\d{1,7})\.(\d{1,3})\.a(?:\.([a-z]{1,4}))?$/.exec(s.trim());
  if (!m) return null;
  const level = +m[1], weight = +m[2];
  if (level < 1 || weight < 1) return null;
  return { level, weight, letter: m[3] };
}

export const spaceLabel = (n: number, k: number) => `${n}.${k}.a`;

// ------------------------------------------------------------------ arithmetic

export function primesUpTo(n: number): number[] {
  const s = new Uint8Array(n + 1), out: number[] = [];
  for (let p = 2; p <= n; p++) {
    if (s[p]) continue;
    out.push(p);
    for (let q = p * p; q <= n; q += p) s[q] = 1;
  }
  return out;
}

export function factorInt(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let p = 2; p * p <= n; p++) {
    let e = 0;
    while (n % p === 0) { n /= p; e++; }
    if (e) out.push([p, e]);
  }
  if (n > 1) out.push([n, 1]);
  return out;
}

export function divisors(n: number): number[] {
  const out: number[] = [];
  for (let d = 1; d * d <= n; d++) if (n % d === 0) { out.push(d); if (d * d !== n) out.push(n / d); }
  return out.sort((a, b) => a - b);
}

const squarefree = (n: number) => factorInt(n).every(([, e]) => e === 1);

/** Is D (< 0) a fundamental discriminant? */
function fundamental(D: number): boolean {
  const m = -D;
  if (m % 4 === 3) return squarefree(m);
  if (m % 4 === 0) { const r = m / 4; return (r % 4 === 1 || r % 4 === 2) && squarefree(r); }
  return false;
}

/** The Kronecker symbol (D / p), p prime. */
export function kronecker(D: number, p: number): number {
  if (p === 2) { const r = ((D % 8) + 8) % 8; return r % 2 === 0 ? 0 : r === 1 || r === 7 ? 1 : -1; }
  const a = ((D % p) + p) % p;
  if (a === 0) return 0;
  let r = 1, b = a, e = (p - 1) / 2; // Euler's criterion (p < 2^26)
  while (e > 0) { if (e & 1) r = (r * b) % p; b = (b * b) % p; e >>= 1; }
  return r === 1 ? 1 : -1;
}

/** [SL_2(Z) : Gamma_0(N)] = N prod (1 + 1/p). */
export const index = (n: number) => factorInt(n).reduce((m, [p]) => (m / p) * (p + 1), n);
export const sturmBound = (n: number, k: number) => Math.floor((k * index(n)) / 12);

/** For an irreducible quadratic c0 + c1 x + c2 x^2: the squarefree D with
 *  coefficient field Q(sqrt D), when the discriminant's squarefree part is
 *  certain (trial division to 10^5 leaves a square or a cofactor < 10^10). */
export function quadraticField(c: string[]): bigint | null {
  if (c.length !== 3) return null;
  const [a0, a1, a2] = c.map(BigInt);
  let disc = a1 * a1 - 4n * a0 * a2;
  const neg = disc < 0n;
  if (neg) disc = -disc;
  let D = 1n;
  for (const p of primesUpTo(100000).map(BigInt)) {
    if (p * p > disc) break;
    let e = 0;
    while (disc % p === 0n) { disc /= p; e++; }
    if (e % 2) D *= p;
  }
  if (disc > 1n) {
    let r = BigInt(Math.round(Math.sqrt(Number(disc))));
    while (r * r > disc) r--;
    while ((r + 1n) * (r + 1n) <= disc) r++;
    if (r * r !== disc) {
      if (disc >= 10n ** 10n) return null;
      D *= disc;
    }
  }
  return neg ? -D : D;
}

// ------------------------------------------------------------------ invariants

export interface Derived {
  al: [number, number | null][]; // Atkin-Lehner sign w_p for p | N (null when p^2 | N)
  fricke: number | null;
  sign: number | null; // sign of the functional equation, (-1)^(k/2) w_N
  cm: number | null; // a negative fundamental discriminant D: tr a_p = 0 for every inert p < BOUND
  cmInert: number; // how many inert primes that rests on
}

/** Invariants that follow from the stored traces.  For p || N every form in
 *  the orbit has a_p = -p^(k/2-1) w_p, so tr a_p = -dim p^(k/2-1) w_p. */
export function derive(sp: Space, f: Orbit): Derived {
  const N = sp.level, k = sp.weight, tr = (n: number) => BigInt(f.traces[n - 1]);
  const al: [number, number | null][] = [];
  for (const [p, e] of factorInt(N)) {
    if (e > 1 || p > f.traces.length) { al.push([p, null]); continue; }
    const unit = BigInt(f.dim) * BigInt(p) ** BigInt(k / 2 - 1);
    const t = tr(p);
    al.push([p, t === -unit ? 1 : t === unit ? -1 : null]);
  }
  const fricke = al.every(([, w]) => w !== null) ? al.reduce((s, [, w]) => s * (w as number), 1) : null;
  const sign = fricke === null ? null : (k % 4 === 0 ? 1 : -1) * fricke;
  let cm: number | null = null, cmInert = 0;
  const ps = primesUpTo(Math.min(BOUND, f.traces.length));
  for (const d of divisors(N)) {
    if (d < 3 || !fundamental(-d)) continue;
    const inert = ps.filter((p) => N % p !== 0 && kronecker(-d, p) === -1);
    if (inert.length >= 20 && inert.every((p) => tr(p) === 0n)) { cm = -d; cmInert = inert.length; break; }
  }
  return { al, fricke, sign, cm, cmInert };
}

// ------------------------------------------------------------------ from the engine

/** A Space from the engine's replies dims(N, k) and newforms(N, k, BOUND),
 *  with newDim(M) = dims(M, k).new for the proper divisors M of N. */
export function spaceFromEngine(n: number, k: number, dims: any, nf: any, newDim: (m: number) => number, seconds?: number): Space {
  const old: [number, number, number][] = [];
  for (const m of divisors(n)) {
    if (m === n) continue;
    const d = newDim(m);
    if (d > 0) old.push([m, d, divisors(n / m).length]);
  }
  const sp: Space = {
    label: spaceLabel(n, k),
    level: n,
    weight: k,
    dims: { new: dims.new, cusp: dims.cusp, eisenstein: dims.eisenstein, modsym: dims.modsym },
    old,
    T: nf.T,
    status: nf.status,
    checks: nf.checks,
    newforms: nf.newforms.map((o: any) => ({ label: `${spaceLabel(n, k)}.${o.letter}`, letter: o.letter, dim: o.dim, charpoly: o.charpoly, traces: o.traces })),
  };
  if (seconds !== undefined) sp.seconds = Math.round(seconds * 1000) / 1000;
  return sp;
}

/** Compare a recomputed space with a stored one: the mathematics
 *  (dimensions, T, orbits, characteristic polynomials, traces). */
export function sameMath(a: Space, b: Space): string | null {
  if (JSON.stringify(a.dims) !== JSON.stringify(b.dims)) return "the dimensions differ";
  if (JSON.stringify(a.old) !== JSON.stringify(b.old)) return "the old-space decomposition differs";
  if (JSON.stringify(a.T) !== JSON.stringify(b.T)) return "the Hecke operator T differs";
  if (a.newforms.length !== b.newforms.length) return `${a.newforms.length} orbits, stored ${b.newforms.length}`;
  for (let i = 0; i < a.newforms.length; i++) {
    const x = a.newforms[i], y = b.newforms[i];
    if (x.label !== y.label || x.dim !== y.dim) return `orbit ${i + 1}: ${x.label} (dimension ${x.dim}), stored ${y.label} (dimension ${y.dim})`;
    if (x.charpoly.join() !== y.charpoly.join()) return `${x.label}: the characteristic polynomial differs`;
    const n = Math.min(x.traces.length, y.traces.length);
    for (let j = 0; j < n; j++) if (x.traces[j] !== y.traces[j]) return `${x.label}: tr a_${j + 1} = ${x.traces[j]}, stored ${y.traces[j]}`;
  }
  return null;
}
