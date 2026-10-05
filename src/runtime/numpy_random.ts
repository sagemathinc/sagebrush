// The bit generators and distributions behind numpy.random, reproducing
// NumPy's streams: MT19937 with NumPy's legacy seeding and the legacy
// algorithms of RandomState (np.random.seed / rand / randn / randint ...),
// and PCG64 seeded through NumPy's SeedSequence for np.random.default_rng.
// Algorithms follow numpy/random/src (mt19937, pcg64, distributions,
// legacy-distributions) and numpy/random/bit_generator.pyx.

import * as Obj from "./object";
import * as O from "./ops";
import { newBuiltinModule } from "./modules";
import { NDArray, empty, toDtype } from "./numpy";
import { glibcLog as crlog } from "./libm";

const { T, raise } = Obj;
const M64 = (1n << 64n) - 1n;
const M128 = (1n << 128n) - 1n;

// ------------------------------------------------------------------ MT19937

class MT19937 {
  key = new Uint32Array(624);
  pos = 624;
  hasGauss = false;
  gauss = 0;
  seed(s: number) {
    let seed = s >>> 0;
    for (let i = 0; i < 624; i++) {
      this.key[i] = seed;
      seed = (Math.imul(1812433253, seed ^ (seed >>> 30)) + i + 1) >>> 0;
    }
    this.pos = 624;
    this.hasGauss = false;
    this.gauss = 0;
  }
  // init_by_array, for array seeds
  seedArray(init: number[]) {
    this.seed(19650218);
    const k = this.key;
    let i = 1, j = 0;
    for (let n = Math.max(624, init.length); n > 0; n--) {
      k[i] = ((k[i] ^ Math.imul(k[i - 1] ^ (k[i - 1] >>> 30), 1664525)) + init[j] + j) >>> 0;
      i++;
      j++;
      if (i >= 624) {
        k[0] = k[623];
        i = 1;
      }
      if (j >= init.length) j = 0;
    }
    for (let n = 623; n > 0; n--) {
      k[i] = ((k[i] ^ Math.imul(k[i - 1] ^ (k[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) {
        k[0] = k[623];
        i = 1;
      }
    }
    k[0] = 0x80000000;
    this.pos = 624;
    this.hasGauss = false;
  }
  private gen() {
    const k = this.key;
    let y: number, i: number;
    for (i = 0; i < 624 - 397; i++) {
      y = (k[i] & 0x80000000) | (k[i + 1] & 0x7fffffff);
      k[i] = k[i + 397] ^ (y >>> 1) ^ (-(y & 1) & 0x9908b0df);
    }
    for (; i < 623; i++) {
      y = (k[i] & 0x80000000) | (k[i + 1] & 0x7fffffff);
      k[i] = k[i + (397 - 624)] ^ (y >>> 1) ^ (-(y & 1) & 0x9908b0df);
    }
    y = (k[623] & 0x80000000) | (k[0] & 0x7fffffff);
    k[623] = k[396] ^ (y >>> 1) ^ (-(y & 1) & 0x9908b0df);
    this.pos = 0;
  }
  next32(): number {
    if (this.pos === 624) this.gen();
    let y = this.key[this.pos++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  nextDouble(): number {
    const a = this.next32() >>> 5, b = this.next32() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  }
  next64(): bigint {
    return (BigInt(this.next32()) << 32n) | BigInt(this.next32());
  }
}

// ------------------------------------------------------------------ PCG64 and SeedSequence

const PCG_MULT = 0x2360ed051fc65da44385df649fcc_f645n;

class PCG64 {
  state = 0n;
  inc = 0n;
  hasU32 = false;
  u32 = 0;
  setSeed(s: bigint, initseq: bigint) {
    this.state = 0n;
    this.inc = ((initseq << 1n) | 1n) & M128;
    this.step();
    this.state = (this.state + s) & M128;
    this.step();
  }
  private step() {
    this.state = (this.state * PCG_MULT + this.inc) & M128;
  }
  next64(): bigint {
    this.step();
    const s = this.state;
    const v = ((s >> 64n) ^ s) & M64;
    const rot = Number(s >> 122n);
    return ((v >> BigInt(rot)) | (v << BigInt((64 - rot) & 63))) & M64;
  }
  next32(): number {
    if (this.hasU32) {
      this.hasU32 = false;
      return this.u32;
    }
    const n = this.next64();
    this.hasU32 = true;
    this.u32 = Number(n >> 32n);
    return Number(n & 0xffffffffn);
  }
  nextDouble(): number {
    return Number(this.next64() >> 11n) * (1.0 / 9007199254740992.0);
  }
}

// numpy.random.SeedSequence(entropy).generate_state(n_words, uint32)
function seedSequenceState(entropy: number[], nWords: number): number[] {
  const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875, INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded;
  const MIX_MULT_L = 0xca01f9dd, MIX_MULT_R = 0x4973f715, XSHIFT = 16;
  let hashConst = INIT_A;
  const hashmix = (value: number) => {
    value = (value ^ hashConst) >>> 0;
    hashConst = Math.imul(hashConst, MULT_A) >>> 0;
    value = Math.imul(value, hashConst) >>> 0;
    value = (value ^ (value >>> XSHIFT)) >>> 0;
    return value;
  };
  const mix = (x: number, y: number) => {
    let r = (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
    r = (r ^ (r >>> XSHIFT)) >>> 0;
    return r;
  };
  const pool = new Array(4).fill(0);
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? entropy[i] : 0);
  for (let s = 0; s < 4; s++) for (let d = 0; d < 4; d++) if (s !== d) pool[d] = mix(pool[d], hashmix(pool[s]));
  for (let s = 4; s < entropy.length; s++) for (let d = 0; d < 4; d++) pool[d] = mix(pool[d], hashmix(entropy[s]));
  const out: number[] = [];
  let hc = INIT_B;
  for (let i = 0; i < nWords; i++) {
    let v = pool[i % 4];
    v = (v ^ hc) >>> 0;
    hc = Math.imul(hc, MULT_B) >>> 0;
    v = Math.imul(v, hc) >>> 0;
    v = (v ^ (v >>> XSHIFT)) >>> 0;
    out.push(v);
  }
  return out;
}

// An integer seed as little-endian 32-bit words (_coerce_to_uint32_array)
function uint32Words(seed: bigint): number[] {
  if (seed < 0n) raise(T.ValueError, "expected non-negative integer");
  if (seed === 0n) return [0];
  const out: number[] = [];
  while (seed > 0n) {
    out.push(Number(seed & 0xffffffffn));
    seed >>= 32n;
  }
  return out;
}

type Gen = MT19937 | PCG64;

// ------------------------------------------------------------------ distributions

function legacyGauss(g: MT19937): number {
  if (g.hasGauss) {
    g.hasGauss = false;
    const t = g.gauss;
    g.gauss = 0;
    return t;
  }
  let x1: number, x2: number, r2: number;
  do {
    x1 = 2.0 * g.nextDouble() - 1.0;
    x2 = 2.0 * g.nextDouble() - 1.0;
    r2 = x1 * x1 + x2 * x2;
  } while (r2 >= 1.0 || r2 === 0.0);
  const f = Math.sqrt((-2.0 * crlog(r2)) / r2);
  g.gauss = f * x1;
  g.hasGauss = true;
  return f * x2;
}

// Smallest 2^k - 1 >= max
function mask32(max: number): number {
  let m = max >>> 0;
  m |= m >>> 1;
  m |= m >>> 2;
  m |= m >>> 4;
  m |= m >>> 8;
  m |= m >>> 16;
  return m >>> 0;
}
function mask64(max: bigint): bigint {
  let m = max;
  for (const s of [1n, 2n, 4n, 8n, 16n, 32n]) m |= m >> s;
  return m;
}

// random_interval: uniform in [0, max] by masked rejection (legacy shuffle)
function randomInterval(g: Gen, max: number): number {
  if (max === 0) return 0;
  if (max <= 0xffffffff) {
    const m = mask32(max);
    let v: number;
    while ((v = (g.next32() & m) >>> 0) > max);
    return v;
  }
  const mb = mask64(BigInt(max));
  let v: bigint;
  while ((v = g.next64() & mb) > BigInt(max));
  return Number(v);
}

// Legacy bounded integers: masked rejection, inclusive range [0, rng]
function maskedBounded(g: Gen, rng: number): number {
  if (rng === 0) return 0;
  if (rng <= 0xffffffff) {
    if (rng === 0xffffffff) return g.next32();
    const m = mask32(rng);
    let v: number;
    while ((v = (g.next32() & m) >>> 0) > rng);
    return v;
  }
  const mb = mask64(BigInt(rng));
  let v: bigint;
  while ((v = g.next64() & mb) > BigInt(rng));
  return Number(v);
}

// Generator's bounded integers: Lemire's method, inclusive range [0, rng]
function lemireBounded(g: Gen, rng: number): number {
  if (rng === 0) return 0;
  if (rng <= 0xffffffff) {
    if (rng === 0xffffffff) return g.next32();
    const excl = rng + 1;
    let m = BigInt(g.next32()) * BigInt(excl);
    let leftover = Number(m & 0xffffffffn);
    if (leftover < excl) {
      const threshold = (0xffffffff - rng) % excl;
      while (leftover < threshold) {
        m = BigInt(g.next32()) * BigInt(excl);
        leftover = Number(m & 0xffffffffn);
      }
    }
    return Number(m >> 32n);
  }
  const excl = BigInt(rng) + 1n;
  let m = g.next64() * excl;
  let leftover = m & M64;
  if (leftover < excl) {
    const threshold = (M64 - BigInt(rng)) % excl;
    while (leftover < threshold) {
      m = g.next64() * excl;
      leftover = m & M64;
    }
  }
  return Number(m >> 64n);
}

const LOGGAM_A = [8.333333333333333e-2, -2.777777777777778e-3, 7.936507936507937e-4, -5.952380952380952e-4, 8.417508417508418e-4, -1.917526917526918e-3, 6.41025641025641e-3, -2.955065359477124e-2, 1.796443723688307e-1, -1.3924322169059];
function loggam(x: number): number {
  if (x === 1.0 || x === 2.0) return 0.0;
  const n = x < 7.0 ? Math.trunc(7 - x) : 0;
  let x0 = x + n;
  const x2 = (1.0 / x0) * (1.0 / x0);
  let gl0 = LOGGAM_A[9];
  for (let k = 8; k >= 0; k--) {
    gl0 *= x2;
    gl0 += LOGGAM_A[k];
  }
  let gl = gl0 / x0 + 0.5 * 1.8378770664093453 + (x0 - 0.5) * crlog(x0) - x0;
  if (x < 7.0) {
    for (let k = 1; k <= n; k++) {
      gl -= crlog(x0 - 1.0);
      x0 -= 1.0;
    }
  }
  return gl;
}
function poisson(g: Gen, lam: number): number {
  if (lam >= 10) {
    const slam = Math.sqrt(lam), loglam = crlog(lam);
    const b = 0.931 + 2.53 * slam, a = -0.059 + 0.02483 * b;
    const invalpha = 1.1239 + 1.1328 / (b - 3.4), vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const U = g.nextDouble() - 0.5, V = g.nextDouble();
      const us = 0.5 - Math.abs(U);
      const k = Math.floor(((2 * a) / us + b) * U + lam + 0.43);
      if (us >= 0.07 && V <= vr) return k;
      if (k < 0 || (us < 0.013 && V > us)) continue;
      if (crlog(V) + crlog(invalpha) - crlog(a / (us * us) + b) <= -lam + k * loglam - loggam(k + 1)) return k;
    }
  }
  if (lam === 0) return 0;
  const enlam = Math.exp(-lam);
  let X = 0, prod = 1.0;
  for (;;) {
    prod *= g.nextDouble();
    if (prod > enlam) X += 1;
    else return X;
  }
}

// ------------------------------------------------------------------ the module

newBuiltinModule("_nprandom", (m) => {
  const fn = (name: string, f: any) => (m[name] = Obj.builtin(f, name));
  const shape = (size: any): number[] | null => (size === null || size === undefined ? null : Array.isArray(size) ? size.map(Number) : [Number(size)]);
  const fill = (size: any, dt: string, f: () => number): any => {
    const sh = shape(size);
    const a = empty(sh ?? [1], toDtype(dt));
    for (let i = 0; i < a.data.length; i++) a.data[i] = f();
    return sh === null ? (dt === "float64" ? O.mkfloat(a.data[0]) : a.data[0]) : a;
  };
  fn("mt19937", (seed: any) => {
    const g = new MT19937();
    if (Array.isArray(seed)) g.seedArray(seed.map((x: any) => Number(x) >>> 0));
    else g.seed(Number(seed));
    return g;
  });
  fn("pcg64", (seed: any) => {
    const ent = Array.isArray(seed) ? seed.flatMap((x: any) => uint32Words(BigInt(x))) : uint32Words(BigInt(seed));
    const w = seedSequenceState(ent, 8);
    const word = (lo: number, hi: number) => (BigInt(hi) << 32n) | BigInt(lo);
    const s0 = word(w[0], w[1]), s1 = word(w[2], w[3]), i0 = word(w[4], w[5]), i1 = word(w[6], w[7]);
    const g = new PCG64();
    g.setSeed((s0 << 64n) | s1, (i0 << 64n) | i1);
    return g;
  });
  fn("doubles", (g: Gen, size: any) => fill(size, "float64", () => g.nextDouble()));
  fn("legacy_gauss", (g: MT19937, size: any) => fill(size, "float64", () => legacyGauss(g)));
  fn("legacy_exponential", (g: MT19937, size: any) => fill(size, "float64", () => -crlog(1.0 - g.nextDouble())));
  fn("poisson", (g: Gen, lam: any, size: any) => fill(size, "int64", () => poisson(g, O.fv(lam) ?? Number(lam))));
  // integers in [low, high] (inclusive) by the legacy masked method or Lemire's
  fn("bounded", (g: Gen, low: any, high: any, size: any, lemire: any) => {
    const lo = Number(low), rng = Number(high) - lo;
    if (rng < 0) raise(T.ValueError, "low >= high");
    const f = lemire ? () => lo + lemireBounded(g, rng) : () => lo + maskedBounded(g, rng);
    return fill(size, "int64", f);
  });
  // in-place Fisher-Yates shuffle of an array's first axis, as NumPy (legacy: masked; Generator: Lemire)
  fn("shuffle_order", (g: Gen, n: any, lemire: any) => {
    const N = Number(n);
    const js: number[] = [];
    for (let i = N - 1; i >= 1; i--) js.push(lemire ? lemireBounded(g, i) : randomInterval(g, i));
    return js;
  });
  // Generator.choice(replace=False): Floyd's algorithm (or a tail shuffle for
  // large populations), then a shuffle, as numpy/random/_generator.pyx
  fn("choice_noreplace", (g: Gen, popSize: any, size: any, shuffle: any) => {
    const N = Number(popSize), k = Number(size);
    const lem = (i: number) => lemireBounded(g, i);
    let idx: number[];
    if (N > 10000 && k > Math.floor(N / 50)) {
      const arr = Array.from({ length: N }, (_, i) => i);
      for (let i = N - 1; i >= Math.max(N - k, 1); i--) {
        const j = lem(i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      idx = arr.slice(N - k);
    } else {
      let setSize = Math.floor(1.2 * k);
      const mask = mask32(setSize);
      setSize = 1 + mask;
      const hash = new Array(setSize).fill(-1);
      idx = new Array(k);
      for (let j = N - k; j < N; j++) {
        const val = lem(j);
        let loc = val & mask;
        while (hash[loc] !== -1 && hash[loc] !== val) loc = (loc + 1) & mask;
        if (hash[loc] === -1) {
          hash[loc] = val;
          idx[j - N + k] = val;
        } else {
          loc = j & mask;
          while (hash[loc] !== -1) loc = (loc + 1) & mask;
          hash[loc] = j;
          idx[j - N + k] = j;
        }
      }
      if (shuffle) {
        for (let i = k - 1; i >= 1; i--) {
          const j = lem(i);
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
      }
    }
    return idx;
  });
  fn("gauss_polar", (g: Gen, size: any) => {
    // Generator's normals are not NumPy's (NumPy uses a ziggurat); same distribution
    let spare: number | null = null;
    return fill(size, "float64", () => {
      if (spare !== null) {
        const t = spare;
        spare = null;
        return t;
      }
      let x1: number, x2: number, r2: number;
      do {
        x1 = 2.0 * g.nextDouble() - 1.0;
        x2 = 2.0 * g.nextDouble() - 1.0;
        r2 = x1 * x1 + x2 * x2;
      } while (r2 >= 1.0 || r2 === 0.0);
      const f = Math.sqrt((-2.0 * crlog(r2)) / r2);
      spare = f * x1;
      return f * x2;
    });
  });
  fn("get_state", (g: MT19937) => [Array.from(g.key), g.pos, g.hasGauss ? 1 : 0, g.gauss]);
  fn("set_state", (g: MT19937, key: any, pos: any, hasGauss: any, gauss: any) => {
    g.key.set(key.map(Number));
    g.pos = Number(pos);
    g.hasGauss = !!Number(hasGauss);
    g.gauss = Number(gauss);
    return null;
  });
  fn("next32", (g: Gen) => g.next32());
});

export { NDArray };
