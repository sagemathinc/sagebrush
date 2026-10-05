// Module registry, import machinery, and builtin modules written in JS.

import { globalsDict, hooks } from "./object";
import { glibcLog, glibcExp, glibcLog1p } from "./libm";
import { T, FloatBox, PyDict, PyBytes, raise, builtin, tuple, getattr, isinstance, dictSet, dictGet, typeName, callKw, callObj } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { builtins, stdout, stderr, stdin } from "./builtins";

export const sysModules = new PyDict();
const factories: Record<string, (m: any) => void> = Object.create(null);

// Set by the driver: find and execute a Python source module, or return
// null; compile and run source text for exec/eval/compile.
export const loader: { load: (name: string) => any | null; exec: (src: string, g: any, mode: string, filename: string) => any } = {
  load: () => null,
  exec: () => null,
};

export function builtinModuleNames(): string[] {
  return Object.keys(factories).filter((n) => !n.startsWith("_"));
}

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
  if (dot > 0) {
    importModule(name.slice(0, dot));
    // The parent's __init__ may have imported this module already.
    const now = dictGet(sysModules, name);
    if (now !== undefined) return now;
  }
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

// builtins.__import__, and the import statements, which call a replaced
// builtins.__import__ the way CPython does.
export function defaultImport(name: any, globals: any = null, _locals: any = null, fromlist: any = null, level: any = 0): any {
  if (typeof name !== "string") raise(T.TypeError, `module name must be str, not ${typeName(name)}`);
  const lv = Number(level);
  let full = name;
  if (lv > 0) {
    const pkg = globals instanceof PyDict ? dictGet(globals, "__package__") ?? dictGet(globals, "__name__") : null;
    full = resolveRelative(name, lv, pkg);
  }
  const m = importModule(full);
  if (fromlist !== null && O.truth(fromlist)) return m;
  if (lv === 0) return dictGet(sysModules, name.split(".")[0]);
  const base = full.slice(0, full.length - name.length);
  return dictGet(sysModules, base + name.split(".")[0]);
}
const customImport = (): any => {
  const f = builtins.__import__;
  return f === defaultImport ? null : f;
};
const gdict = (g: any) => (g === undefined || g === null ? null : globalsDict(g));
// `import a.b.c` binds `a`.
export function importTop(name: string, g?: any): any {
  const c = customImport();
  if (c !== null) return callObj(c, [name, gdict(g), null, null, 0]);
  importModule(name);
  return dictGet(sysModules, name.split(".")[0]);
}
// `import a.b.c as x`
export function importAs(name: string, g?: any): any {
  const c = customImport();
  if (c === null) return importModule(name);
  let m = callObj(c, [name, gdict(g), null, null, 0]);
  for (const part of name.split(".").slice(1)) m = getattr(m, part);
  return m;
}
// The module of `from m import names` (relative when level > 0).
export function importFromStmt(module: string, names: string[], level: number, g: any): any {
  const c = customImport();
  if (c !== null) return callObj(c, [module, gdict(g), null, tuple(names), level]);
  return importModule(level ? resolveRelative(module, level, g.__package__) : module);
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
  if (!isinstance(m, T.module)) {
    // sys.modules entries may be any object.
    const v = getattr(m, name, null);
    if (v !== null || hasattr(m, name)) return v;
    raise(T.ImportError, `cannot import name '${name}' from '${typeName(m)}' object`);
  }
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
function hasattr(o: any, name: string): boolean {
  try {
    getattr(o, name);
    return true;
  } catch (e: any) {
    if (isinstance(e, T.AttributeError)) return false;
    throw e;
  }
}

// `from m import *`
export function importStar(m: any, g: any) {
  const all = getattr(m, "__all__", null);
  let names: any[];
  if (all !== null) names = O.toArray(all);
  else {
    const d = getattr(m, "__dict__", null);
    if (d === null) raise(T.ImportError, "from-import-* object has no __dict__ and no __all__");
    names = O.toArray(d).filter((k: any) => typeof k === "string" && !k.startsWith("_") && !k.startsWith("$"));
  }
  for (const k of names) g[k] = getattr(m, k);
}

// ------------------------------------------------------------------ sys

newBuiltinModule("sys", (m) => {
  m.argv = [];
  m.version = "3.14.0 (pyjs-spike)";
  m.hash_info = Ty.structseq("sys.hash_info", ["width", "modulus", "inf", "nan", "imag", "algorithm", "hash_bits", "seed_bits", "cutoff"], [64, 2305843009213693951n, 314159, 0, 1000003, "siphash13", 64, 128, 0]);
  m.int_info = Ty.structseq("sys.int_info", ["bits_per_digit", "sizeof_digit", "default_max_str_digits", "str_digits_check_threshold"], [30, 4, 4300, 640]);
  m.version_info = Ty.structseq("sys.version_info", ["major", "minor", "micro", "releaselevel", "serial"], [3, 14, 0, "final", 0]);
  m.hexversion = 0x30e00f0;
  m.implementation = Ty.simpleNamespace({ name: "pyjs", cache_tag: null, version: m.version_info, _multiarch: "js" });
  m.maxsize = 9223372036854775807n;
  m.maxunicode = 0x10ffff;
  m.byteorder = "little";
  m.platform = process.platform === "win32" ? "win32" : process.platform;
  m.stdout = stdout;
  m.stderr = stderr;
  m.stdin = stdin;
  m.__stdout__ = stdout;
  m.__stderr__ = stderr;
  m.__stdin__ = stdin;
  m.modules = sysModules;
  m.path = [];
  m.flags = Ty.newModule("flags");
  m.flags.optimize = 0;
  let limit = 1000;
  fn(m, "getrecursionlimit", () => limit);
  fn(m, "setrecursionlimit", (n: any) => ((limit = Number(n)), null));
  fn(m, "exit", (code: any = undefined) => {
    throw code === undefined ? T.SystemExit() : T.SystemExit(code);
  });
  fn(m, "intern", (s: string) => s);
  fn(m, "audit", (..._a: any[]) => null);
  fn(m, "addaudithook", (_f: any) => null);
  fn(m, "getsizeof", (_x: any) => 64);
  fn(m, "exc_info", () => tuple([null, null, null]));
  m.float_info = Ty.structseq("sys.float_info", ["max", "max_exp", "max_10_exp", "min", "min_exp", "min_10_exp", "dig", "mant_dig", "epsilon", "radix", "rounds"], [1.7976931348623157e308, 1024, 308, 2.2250738585072014e-308, -1021, -307, 15, 53, 2.220446049250313e-16, 2, 1]);
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
  unary("exp", glibcExp);
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
  unary("log1p", glibcLog1p, (x) => x > -1 || x !== x);
  unary("degrees", (x) => (x * 180) / Math.PI);
  unary("radians", (x) => (x * Math.PI) / 180);
  unary("cbrt", Math.cbrt);
  fn(m, "log", (x: any, base: any = undefined) => {
    const ln = (v: any) => {
      if (typeof v === "bigint") {
        if (v <= 0n) domain();
        const d = Number(v);
        if (d !== Infinity) return glibcLog(d);
        // as CPython: frexp (mantissa rounded to 53 bits) for ints beyond float range
        const s = v.toString(2).length;
        let top = v >> BigInt(s - 64);
        if (top << BigInt(s - 64) !== v) top |= 1n; // sticky bit for correct rounding
        let x = Number(top) / 18446744073709551616, e = s;
        if (x === 1) {
          x = 0.5;
          e += 1;
        }
        return glibcLog(x) + e * Math.LN2;
      }
      const f = F(v);
      if (f <= 0) domain();
      return glibcLog(f);
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
    // as CPython: anything with __index__ (int subclasses included)
    if (!O.isPyInt(x)) x = O.index(x);
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
    if (n < 2n ** 52n) {
      let r = BigInt(Math.floor(Math.sqrt(Number(n))));
      while (r * r > n) r--;
      while ((r + 1n) * (r + 1n) <= n) r++;
      return O.normBig(r);
    }
    // Newton's method from above (a float start is off by far more than 1 here)
    let g = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) {
      const y = (g + n / g) >> 1n;
      if (y >= g) break;
      g = y;
    }
    return O.normBig(g);
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
  m.SimpleNamespace = Ty.SimpleNamespace;
  m.UnionType = Ty.unionType;
  m.CodeType = T.code;
  m.MappingProxyType = T.dict;
  m.GetSetDescriptorType = T.getset_descriptor;
  for (const n of ["MemberDescriptorType", "WrapperDescriptorType", "MethodWrapperType", "MethodDescriptorType", "ClassMethodDescriptorType", "CellType", "FrameType", "TracebackType", "AsyncGeneratorType", "GenericAlias", "CapsuleType"]) {
    m[n] = Ty.builtinTypeFor(n, class {}, "types", () => raise(T.TypeError, `cannot create '${n}' instances`));
  }
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

// ------------------------------------------------------------------ _weakref, gc

// Weak references use JS WeakRef; callbacks run from a FinalizationRegistry,
// i.e. some time after the referent is collected.
export class PyWeakRef {
  w: WeakRef<any>;
  constructor(o: any, public cb: any) {
    this.w = new WeakRef(o);
  }
}
const weakable = (o: any) => (o !== null && typeof o === "object" && (hasInstanceDictLocal(o) || o instanceof O.PySet)) || (typeof o === "function");
const hasInstanceDictLocal = (o: any) => o.$cls !== undefined && o.$cls.$ctor !== null && !Array.isArray(o);
const registry = new FinalizationRegistry((r: PyWeakRef) => {
  if (r.cb !== null && r.cb !== undefined) {
    try {
      callObj(r.cb, [r]);
    } catch {
      // ignored, as CPython prints and ignores
    }
  }
});
newBuiltinModule("_weakref", (m) => {
  const ref = Ty.builtinTypeFor("weakref.ReferenceType", PyWeakRef, "weakref", (o: any, cb: any = null) => {
    if (!weakable(o)) raise(T.TypeError, `cannot create weak reference to '${typeName(o)}' object`);
    const r = new PyWeakRef(o, cb);
    registry.register(o, r);
    return r;
  });
  (ref as any).$name = "ReferenceType";
  Ty.method(ref, "__call__", (r: PyWeakRef) => r.w.deref() ?? null);
  Ty.method(ref, "__repr__", (r: PyWeakRef) => {
    const o = r.w.deref();
    return o === undefined ? `<weakref at 0x${O.id(r).toString(16)}; dead>` : `<weakref at 0x${O.id(r).toString(16)}; to '${typeName(o)}' at 0x${O.id(o).toString(16)}>`;
  });
  Ty.getset(ref, "__callback__", (r: PyWeakRef) => r.cb ?? null);
  m.ref = ref;
  m.ReferenceType = ref;
  fn(m, "getweakrefcount", (_o: any) => 0);
});
newBuiltinModule("gc", (m) => {
  let enabled = true;
  fn(m, "enable", () => ((enabled = true), null));
  fn(m, "disable", () => ((enabled = false), null));
  fn(m, "isenabled", () => enabled);
  fn(m, "collect", (_gen: any = 2) => {
    const g = (globalThis as any).gc;
    if (typeof g === "function") g();
    return 0;
  });
  fn(m, "get_count", () => tuple([0, 0, 0]));
  fn(m, "get_threshold", () => tuple([700, 10, 10]));
  fn(m, "set_threshold", (..._a: any[]) => null);
  fn(m, "is_tracked", (_o: any) => false);
  fn(m, "get_referrers", (..._a: any[]) => []);
  m.garbage = [];
  m.callbacks = [];
});

// ------------------------------------------------------------------ _fs (backs open() in lib/_pyjs_open.py)

newBuiltinModule("_fs", (m) => {
  const fs = require("fs");
  const oserr = (e: any, path: string): never => {
    if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw callObj(T.PermissionError, [13, String(e.message).split("\n")[0], path]);
    const cls = e.code === "ENOENT" ? T.FileNotFoundError : e.code === "EISDIR" ? T.IsADirectoryError : e.code === "EACCES" ? T.PermissionError : e.code === "EEXIST" ? T.FileExistsError : T.OSError;
    throw callObj(cls, [e.errno ? -e.errno : 0, e.code === "ENOENT" ? "No such file or directory" : String(e.message), path]);
  };
  fn(m, "read", (path: string) => {
    try {
      return new PyBytes(new Uint8Array(fs.readFileSync(path)));
    } catch (e: any) {
      return oserr(e, path);
    }
  });
  fn(m, "write", (path: string, data: any, append: any) => {
    try {
      const b = O.bufferOf(data)!;
      if (O.truth(append)) fs.appendFileSync(path, b);
      else fs.writeFileSync(path, b);
    } catch (e: any) {
      return oserr(e, path);
    }
    return null;
  });
  // Denied by a sandbox counts as absent, as os.path.exists does for EACCES.
  const quiet = (f: () => boolean) => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  fn(m, "exists", (path: string) => quiet(() => fs.existsSync(path)));
  fn(m, "isdir", (path: string) => quiet(() => fs.existsSync(path) && fs.statSync(path).isDirectory()));
});

// ------------------------------------------------------------------ os

newBuiltinModule("os", (m) => {
  const fs = require("fs");
  const nodeOs = require("os");
  const oserr = (e: any, path: any): never => {
    if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw callObj(T.PermissionError, [13, String(e.message).split("\n")[0], path]);
    const cls = e.code === "ENOENT" ? T.FileNotFoundError : e.code === "EEXIST" ? T.FileExistsError : e.code === "EACCES" || e.code === "EPERM" ? T.PermissionError : e.code === "EISDIR" ? T.IsADirectoryError : e.code === "ENOTDIR" ? T.NotADirectoryError ?? T.OSError : T.OSError;
    throw callObj(cls, [e.errno ? -e.errno : 0, String(e.message).replace(/^[A-Z]+: /, "").replace(/, .*$/, ""), path]);
  };
  const wrap = (name: string, f: (...a: any[]) => any) =>
    fn(m, name, (...a: any[]) => {
      try {
        return f(...a);
      } catch (e: any) {
        if (e && e.code && e.errno !== undefined) return oserr(e, a[0]);
        throw e;
      }
    });
  m.name = "posix";
  m.sep = "/";
  m.altsep = null;
  m.extsep = ".";
  m.pathsep = ":";
  m.linesep = "\n";
  m.curdir = ".";
  m.pardir = "..";
  m.devnull = "/dev/null";
  const env = new PyDict();
  try {
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) dictSet(env, k, v);
  } catch {
    // environment access denied (sandboxed runtime): os.environ is empty
  }
  m.environ = env;
  fn(m, "getenv", (k: string, d: any = null) => dictGet(env, k) ?? d);
  wrap("getcwd", () => process.cwd());
  wrap("chdir", (p: string) => (process.chdir(p), null));
  wrap("listdir", (p: string = ".") => fs.readdirSync(p));
  wrap("mkdir", (p: string, _mode: any = 0o777) => (fs.mkdirSync(p), null));
  wrap("makedirs", (p: string, _mode: any = 0o777, exist_ok: any = false) => {
    if (fs.existsSync(p) && !O.truth(exist_ok)) fs.mkdirSync(p);
    fs.mkdirSync(p, { recursive: true });
    return null;
  });
  m.makedirs.$sig = { args: ["name", "mode", "exist_ok"], posonly: 0, vararg: null, kwonly: [], kwarg: null };
  wrap("remove", (p: string) => (fs.unlinkSync(p), null));
  wrap("unlink", (p: string) => (fs.unlinkSync(p), null));
  wrap("rmdir", (p: string) => (fs.rmdirSync(p), null));
  wrap("rename", (a: string, b: string) => (fs.renameSync(a, b), null));
  wrap("replace", (a: string, b: string) => (fs.renameSync(a, b), null));
  wrap("stat", (p: string) => {
    const s = fs.statSync(p);
    return Ty.structseq("os.stat_result", ["st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size", "st_atime", "st_mtime", "st_ctime"], [s.mode, s.ino, s.dev, s.nlink, s.uid, s.gid, s.size, O.mkfloat(s.atimeMs / 1000), O.mkfloat(s.mtimeMs / 1000), O.mkfloat(s.ctimeMs / 1000)]);
  });
  fn(m, "uname", () => Ty.structseq("posix.uname_result", ["sysname", "nodename", "release", "version", "machine"], [nodeOs.type(), nodeOs.hostname(), nodeOs.release(), String(nodeOs.version?.() ?? ""), nodeOs.machine?.() ?? nodeOs.arch()]));
  fn(m, "getpid", () => process.pid);
  fn(m, "cpu_count", () => nodeOs.cpus().length);
  fn(m, "urandom", (n: any) => new PyBytes(new Uint8Array(require("crypto").randomBytes(Number(n)))));
  fn(m, "fspath", (p: any) => {
    if (typeof p === "string" || p instanceof PyBytes) return p;
    const f = Ty.lookupDunder(p, "__fspath__");
    if (f === undefined) raise(T.TypeError, `expected str, bytes or os.PathLike object, not ${typeName(p)}`);
    return f(p);
  });
  m.path = importModule("posixpath");
  dictSet(sysModules, "os.path", m.path);
});

builtin(defaultImport, "__import__", { args: ["name", "globals", "locals", "fromlist", "level"], posonly: 0, vararg: null, kwonly: [], kwarg: null });
builtins.__import__ = defaultImport;

hooks.importModule = importModule;
