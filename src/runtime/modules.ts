// Module registry, import machinery, and builtin modules written in JS.

import { T, FloatBox, PyDict, raise, builtin, tuple, getattr, isinstance, dictSet, dictGet, typeName, callKw } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { builtins, stdout, stderr } from "./builtins";

export const sysModules = new PyDict();
const factories: Record<string, (m: any) => void> = Object.create(null);

// Set by the driver: find and execute a Python source module, or return
// null; compile and run source text for exec/eval/compile.
export const loader: { load: (name: string) => any | null; exec: (src: string, g: any, mode: string, filename: string) => any } = {
  load: () => null,
  exec: () => null,
};

export function newBuiltinModule(name: string, fill: (m: any) => void) {
  factories[name] = fill;
}

function fn(m: any, name: string, f: any) {
  builtin(f, name);
  m[name] = f;
}

export function importModule(name: string): any {
  const existing = dictGet(sysModules, name);
  if (existing !== undefined) return existing;
  const dot = name.lastIndexOf(".");
  if (dot > 0) importModule(name.slice(0, dot));
  const f = factories[name];
  let m: any;
  if (f !== undefined) {
    m = Ty.newModule(name);
    dictSet(sysModules, name, m);
    f(m);
  } else {
    m = loader.load(name);
    if (m === null) {
      const e = T.ModuleNotFoundError(`No module named '${name}'`);
      e.name = name;
      throw e;
    }
  }
  if (dot > 0) {
    const parent = dictGet(sysModules, name.slice(0, dot));
    parent[name.slice(dot + 1)] = m;
  }
  return m;
}

// `import a.b.c` binds `a`.
export function importTop(name: string): any {
  importModule(name);
  return dictGet(sysModules, name.split(".")[0]);
}

export function resolveRelative(name: string, level: number, pkg: any): string {
  if (level === 0) return name;
  if (typeof pkg !== "string" || pkg === "") raise(T.ImportError, "attempted relative import with no known parent package");
  const parts = pkg.split(".");
  if (level - 1 > parts.length - 1 && level > 1) raise(T.ImportError, "attempted relative import beyond top-level package");
  const base = parts.slice(0, parts.length - (level - 1)).join(".");
  return name ? `${base}.${name}` : base;
}

// `from m import name`
export function importFrom(m: any, name: string): any {
  const v = m[name];
  if (v !== undefined && Object.prototype.hasOwnProperty.call(m, name)) return v;
  try {
    return importModule(`${m.__name__}.${name}`);
  } catch (e: any) {
    if (!(e?.$cls !== undefined && isinstance(e, T.ModuleNotFoundError))) throw e;
  }
  const err = T.ImportError(`cannot import name '${name}' from '${m.__name__}'`);
  throw err;
}

// `from m import *`
export function importStar(m: any, g: any) {
  const all = m.__all__;
  const names = all !== undefined ? O.toArray(all) : Object.keys(m).filter((k) => !k.startsWith("_") && !k.startsWith("$"));
  for (const k of names) g[k] = getattr(m, k);
}

// ------------------------------------------------------------------ sys

newBuiltinModule("sys", (m) => {
  m.argv = [];
  m.version = "3.14.0 (pyjs-spike)";
  m.version_info = Ty.structseq("sys.version_info", ["major", "minor", "micro", "releaselevel", "serial"], [3, 14, 0, "final", 0]);
  m.hexversion = 0x30e00f0;
  m.implementation = Ty.newModule("implementation");
  m.implementation.name = "pyjs";
  m.maxsize = 9223372036854775807n;
  m.maxunicode = 0x10ffff;
  m.byteorder = "little";
  m.platform = process.platform === "win32" ? "win32" : process.platform;
  m.stdout = stdout;
  m.stderr = stderr;
  m.modules = sysModules;
  m.path = [];
  m.flags = Ty.newModule("flags");
  m.flags.optimize = 0;
  let limit = 1000;
  fn(m, "getrecursionlimit", () => limit);
  fn(m, "setrecursionlimit", (n: any) => ((limit = Number(n)), null));
  fn(m, "exit", (code: any = null) => {
    throw T.SystemExit(code);
  });
  fn(m, "intern", (s: string) => s);
  fn(m, "getsizeof", (_x: any) => 64);
  fn(m, "exc_info", () => tuple([null, null, null]));
  m.float_info = tuple([1.7976931348623157e308, 1024, 308, 2.2250738585072014e-308, -1021, -307, 15, 53, 2.220446049250313e-16, 2, 1]);
});
dictSet(sysModules, "builtins", builtins);

// ------------------------------------------------------------------ time

newBuiltinModule("time", (m) => {
  const t0 = performance.now();
  const epochOffset = Date.now() / 1000 - t0 / 1000;
  fn(m, "perf_counter", () => performance.now() / 1000);
  fn(m, "perf_counter_ns", () => O.normBig(BigInt(Math.round(performance.now() * 1e6))));
  fn(m, "monotonic", () => performance.now() / 1000);
  fn(m, "time", () => epochOffset + performance.now() / 1000);
  fn(m, "time_ns", () => O.normBig(BigInt(Date.now()) * 1000000n));
  fn(m, "process_time", () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1e6;
  });
  fn(m, "sleep", (s: any) => {
    const ms = O.fv(s)! * 1000;
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return null;
  });
});

// ------------------------------------------------------------------ math

newBuiltinModule("math", (m) => {
  const F = (x: any): number => {
    const v = O.fv(x);
    if (v === undefined) {
      const f = Ty.floatCallSafe(x);
      if (f === undefined) raise(T.TypeError, `must be real number, not ${typeName(x)}`);
      return f;
    }
    return v;
  };
  const domain = () => raise(T.ValueError, "math domain error");
  const range = () => raise(T.OverflowError, "math range error");
  const unary = (name: string, f: (x: number) => number, ok: (x: number) => boolean = () => true) =>
    fn(m, name, (x: any) => {
      const v = F(x);
      if (!ok(v)) domain();
      const r = f(v);
      if (r !== r && v === v) domain();
      if (!Number.isFinite(r) && Number.isFinite(v)) range();
      return O.mkfloat(r);
    });
  m.pi = Math.PI;
  m.e = Math.E;
  m.tau = 2 * Math.PI;
  m.inf = new FloatBox(Infinity);
  m.nan = NaN;
  unary("sqrt", Math.sqrt, (x) => x >= 0 || x !== x);
  unary("exp", Math.exp);
  unary("expm1", Math.expm1);
  unary("sin", Math.sin, (x) => Number.isFinite(x) || x !== x);
  unary("cos", Math.cos, (x) => Number.isFinite(x) || x !== x);
  unary("tan", Math.tan, (x) => Number.isFinite(x) || x !== x);
  unary("asin", Math.asin, (x) => (x >= -1 && x <= 1) || x !== x);
  unary("acos", Math.acos, (x) => (x >= -1 && x <= 1) || x !== x);
  unary("atan", Math.atan);
  unary("sinh", Math.sinh);
  unary("cosh", Math.cosh);
  unary("tanh", Math.tanh);
  unary("asinh", Math.asinh);
  unary("acosh", Math.acosh, (x) => x >= 1 || x !== x);
  unary("atanh", Math.atanh, (x) => (x > -1 && x < 1) || x !== x);
  unary("fabs", Math.abs);
  unary("log2", Math.log2, (x) => x > 0 || x !== x);
  unary("log10", Math.log10, (x) => x > 0 || x !== x);
  unary("log1p", Math.log1p, (x) => x > -1 || x !== x);
  unary("degrees", (x) => (x * 180) / Math.PI);
  unary("radians", (x) => (x * Math.PI) / 180);
  unary("cbrt", Math.cbrt);
  fn(m, "log", (x: any, base: any = undefined) => {
    const ln = (v: any) => {
      if (typeof v === "bigint") {
        if (v <= 0n) domain();
        const s = v.toString(2).length;
        return s > 1000 ? Math.log(Number(v >> BigInt(s - 64))) + (s - 64) * Math.LN2 : Math.log(Number(v));
      }
      const f = F(v);
      if (f <= 0) domain();
      return Math.log(f);
    };
    const r = base === undefined ? ln(x) : ln(x) / ln(base);
    return O.mkfloat(r);
  });
  fn(m, "pow", (x: any, y: any) => {
    const a = F(x), b = F(y);
    if (a === 0 && b < 0) domain();
    if (a < 0 && !Number.isInteger(b) && Number.isFinite(b)) domain();
    const r = Math.pow(a, b);
    if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) range();
    return O.mkfloat(r);
  });
  fn(m, "atan2", (y: any, x: any) => O.mkfloat(Math.atan2(F(y), F(x))));
  fn(m, "hypot", (...xs: any[]) => O.mkfloat(Math.hypot(...xs.map(F))));
  fn(m, "copysign", (x: any, y: any) => {
    const a = Math.abs(F(x)), b = F(y);
    return O.mkfloat(b < 0 || Object.is(b, -0) ? -a : a);
  });
  fn(m, "fmod", (x: any, y: any) => {
    const b = F(y);
    if (b === 0) domain();
    return O.mkfloat(F(x) % b);
  });
  const toInt = (v: number) => {
    if (v !== v) raise(T.ValueError, "cannot convert float NaN to integer");
    if (!Number.isFinite(v)) raise(T.OverflowError, "cannot convert float infinity to integer");
    return Number.isSafeInteger(v) ? v + 0 : O.normBig(BigInt(v));
  };
  const intOr = (name: string, f: (v: number) => number) => (x: any) => {
    if (O.isPyInt(x)) return typeof x === "boolean" ? +x : x;
    const d = Ty.lookupDunder(x, name);
    if (d !== undefined) return d(x);
    return toInt(f(F(x)));
  };
  fn(m, "floor", intOr("__floor__", Math.floor));
  fn(m, "ceil", intOr("__ceil__", Math.ceil));
  fn(m, "trunc", intOr("__trunc__", Math.trunc));
  fn(m, "isfinite", (x: any) => Number.isFinite(F(x)));
  fn(m, "isinf", (x: any) => Math.abs(F(x)) === Infinity);
  fn(m, "isnan", (x: any) => F(x) !== F(x));
  fn(m, "isclose", (a: any, b: any) => {
    const x = F(a), y = F(b);
    return x === y || Math.abs(x - y) <= Math.max(1e-9 * Math.max(Math.abs(x), Math.abs(y)), 0);
  });
  fn(m, "modf", (x: any) => {
    const v = F(x);
    const i = Math.trunc(v);
    return tuple([O.mkfloat(v - i), O.mkfloat(i)]);
  });
  fn(m, "frexp", (x: any) => {
    let v = F(x);
    if (v === 0 || !Number.isFinite(v)) return tuple([O.mkfloat(v), 0]);
    let e = 0;
    while (Math.abs(v) >= 1) { v /= 2; e++; }
    while (Math.abs(v) < 0.5) { v *= 2; e--; }
    return tuple([O.mkfloat(v), e]);
  });
  fn(m, "ldexp", (x: any, i: any) => O.mkfloat(F(x) * Math.pow(2, Number(i))));
  const bigOf = (x: any): bigint => {
    if (!O.isPyInt(x)) raise(T.TypeError, `'${typeName(x)}' object cannot be interpreted as an integer`);
    return BigInt(typeof x === "boolean" ? +x : x);
  };
  fn(m, "factorial", (x: any) => {
    const n = bigOf(x);
    if (n < 0n) raise(T.ValueError, "factorial() not defined for negative values");
    let r = 1n;
    for (let i = 2n; i <= n; i++) r *= i;
    return O.normBig(r);
  });
  const gcd2 = (a: bigint, b: bigint): bigint => {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
  };
  fn(m, "gcd", (...xs: any[]) => O.normBig(xs.map(bigOf).reduce(gcd2, 0n)));
  fn(m, "lcm", (...xs: any[]) => O.normBig(xs.map(bigOf).reduce((a, b) => (a === 0n || b === 0n ? 0n : ((a * b < 0n ? -(a * b) : a * b) / gcd2(a, b))), 1n)));
  fn(m, "isqrt", (x: any) => {
    const n = bigOf(x);
    if (n < 0n) raise(T.ValueError, "isqrt() argument must be nonnegative");
    if (n < 2n) return Number(n);
    let r = BigInt(Math.floor(Math.sqrt(Number(n))));
    while (r * r > n) r--;
    while ((r + 1n) * (r + 1n) <= n) r++;
    return O.normBig(r);
  });
  fn(m, "comb", (nn: any, kk: any) => {
    const n = bigOf(nn);
    let k = bigOf(kk);
    if (n < 0n || k < 0n) raise(T.ValueError, "n and k must be non-negative integers");
    if (k > n) return 0;
    if (k > n - k) k = n - k;
    let r = 1n;
    for (let i = 1n; i <= k; i++) r = (r * (n - k + i)) / i;
    return O.normBig(r);
  });
  fn(m, "perm", (nn: any, kk: any = null) => {
    const n = bigOf(nn);
    const k = kk === null ? n : bigOf(kk);
    if (k > n) return 0;
    let r = 1n;
    for (let i = n - k + 1n; i <= n; i++) r *= i;
    return O.normBig(r);
  });
  fn(m, "fsum", (it: any) => {
    // Shewchuk's algorithm, as CPython's math.fsum.
    const partials: number[] = [];
    O.forEach(it, (v) => {
      let x = F(v);
      let i = 0;
      for (let y of partials) {
        if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
        const hi = x + y;
        const lo = y - (hi - x);
        if (lo) partials[i++] = lo;
        x = hi;
      }
      partials.length = i;
      partials.push(x);
    });
    return O.mkfloat(partials.reduce((a, b) => a + b, 0));
  });
  fn(m, "prod", (it: any) => {
    let r: any = 1;
    O.forEach(it, (v) => (r = O.mul(r, v)));
    return r;
  });
  fn(m, "dist", (p: any, q: any) => {
    const a = O.toArray(p).map(F), b = O.toArray(q).map(F);
    return O.mkfloat(Math.hypot(...a.map((v, i) => v - b[i])));
  });
});

// ------------------------------------------------------------------ __future__

newBuiltinModule("types", (m) => {
  m.FunctionType = m.LambdaType = T.function;
  m.MethodType = T.method;
  m.BuiltinFunctionType = m.BuiltinMethodType = T.builtin_function_or_method;
  m.GeneratorType = T.generator;
  m.CoroutineType = T.coroutine;
  m.ModuleType = T.module;
  m.NoneType = T.NoneType;
  m.NotImplementedType = T.NotImplementedType;
  m.EllipsisType = T.ellipsis;
  // A generator function whose generators may be awaited.
  fn(m, "coroutine", (f: any) => {
    if (typeof f !== "function") raise(T.TypeError, "types.coroutine() expects a callable");
    const w: any = (...a: any[]) => mark(f(...a));
    const mark = (g: any) => {
      if (g !== null && typeof g === "object" && g[Symbol.toStringTag] === "Generator") g.$awaitable = true;
      return g;
    };
    w.$kw = (pos: any[], names: string[], values: any[]) => mark(callKw(f, pos, names, values));
    w.$pyfn = true;
    for (const k of ["__name__", "__qualname__", "__module__", "__doc__"]) w[k] = f[k] ?? null;
    return w;
  });
});

newBuiltinModule("__future__", (m) => {
  for (const f of ["annotations", "division", "absolute_import", "print_function", "unicode_literals", "generator_stop", "nested_scopes", "generators", "with_statement", "barry_as_FLUFL"]) m[f] = true;
});

// ------------------------------------------------------------------ _random: MT19937 exactly as CPython

export class MT {
  mt = new Uint32Array(624);
  mti = 625;
  initGenrand(s: number) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = 624;
  }
  initByArray(key: number[]) {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1, j = 0;
    const n = 624, len = Math.max(1, key.length);
    for (let k = Math.max(n, len); k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + (key[j] ?? 0) + j) >>> 0;
      i++;
      j++;
      if (i >= n) {
        mt[0] = mt[n - 1];
        i = 1;
      }
      if (j >= len) j = 0;
    }
    for (let k = n - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= n) {
        mt[0] = mt[n - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.mti = 624;
  }
  genrand(): number {
    const mt = this.mt;
    if (this.mti >= 624) {
      let kk = 0;
      const mag = (y: number) => (y & 1 ? 0x9908b0df : 0);
      for (; kk < 624 - 397; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ mag(y);
      }
      for (; kk < 623; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (397 - 624)] ^ (y >>> 1) ^ mag(y);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ mag(y);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  random(): number {
    const a = this.genrand() >>> 5, b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
  seed(x: any) {
    let v: bigint;
    if (x === null || x === undefined) v = BigInt(Date.now()) * 1000003n + BigInt(process.pid);
    else if (O.isPyInt(x)) v = BigInt(typeof x === "boolean" ? +x : x);
    else if (typeof x === "string") v = BigInt.asUintN(64, BigInt(O.hashAny(x)));
    else v = BigInt.asUintN(64, BigInt(O.hashAny(x)));
    if (v < 0n) v = -v;
    const key: number[] = [];
    do {
      key.push(Number(v & 0xffffffffn));
      v >>= 32n;
    } while (v > 0n);
    this.initByArray(key);
  }
  getrandbits(k: number): number | bigint {
    if (k < 0) raise(T.ValueError, "number of bits must be non-negative");
    if (k === 0) return 0;
    if (k <= 32) return this.genrand() >>> (32 - k);
    let r = 0n, shift = 0n;
    for (let left = k; left > 0; left -= 32) {
      let w = this.genrand();
      if (left < 32) w >>>= 32 - left;
      r |= BigInt(w) << shift;
      shift += 32n;
    }
    return O.normBig(r);
  }
}

newBuiltinModule("_random", (m) => {
  const RandomType = Ty.builtinTypeFor("Random", MT, "_random", (x: any = undefined) => {
    const r = new MT();
    r.seed(x === undefined ? null : x);
    return r;
  });
  Ty.method(RandomType, "seed", (r: MT, x: any = null) => (r.seed(x), null));
  Ty.method(RandomType, "random", (r: MT) => O.mkfloat(r.random()));
  Ty.method(RandomType, "getrandbits", (r: MT, k: any) => r.getrandbits(Number(k)));
  Ty.method(RandomType, "getstate", (r: MT) => tuple([3, tuple([...r.mt, r.mti]), null]));
  Ty.method(RandomType, "setstate", (r: MT, st: any) => {
    const inner = O.toArray(st[1]);
    r.mt = Uint32Array.from(inner.slice(0, 624).map(Number));
    r.mti = Number(inner[624]);
    return null;
  });
  m.Random = RandomType;
});
