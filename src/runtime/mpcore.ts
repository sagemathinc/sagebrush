// Sagebrush's multiprecision core (engine/mp; design/mpmath-core.md) as the
// builtin module `_sagebrush_mpcore`, the backend python's overlay of mpmath
// selects (SAGEBRUSH_MPMATH_BACKEND=sagebrush): the 27 libmp functions it
// hooks (backend.py's SAGEBRUSH_HOOKS), each with the reference's raw-tuple
// arguments, results and exceptions, and the Context the overlay's ctx_mp
// takes as its base.
// The WebAssembly module (wasm/sagebrush-mp.wasm) is compiled the first time
// a hook is called, from wherever the host keeps it (src/runtime/wasm-asset.ts,
// key MP).

import { assetBytes } from "./wasm-asset";
import * as Obj from "./object";
import { importModule, memoryGuard, newBuiltinModule } from "./modules";
import * as O from "./ops";
import { repr } from "./format";
import { INTR, INTR_CTRL_C } from "./interrupt";

interface Core {
  memory: WebAssembly.Memory;
  mp_io(n: number): number;
  mp_res(): number;
  mp_set_f(r: number, sign: number, man: number, exp: number, bc: number): number;
  mp_set_fx(r: number, sign: number, nman: number, exp: number, bc: number, nexp: number, expneg: number): number;
  mp_set_i(r: number, v: number): number;
  mp_set_ix(r: number, neg: number, n: number): number;
  mp_set_none(r: number): void;
  mp_bin(op: number, prec: number, rnd: number, as: number, am: number, ae: number, ab: number, an: number, bs: number, bm: number, be: number, bb: number, bn: number): number;
  mp_run(op: number, prec: number, rnd: number): number;
  mp_out(k: number): number;
  mp_reset(): void;
  mp_set_max_limbs(n: number): void;
  mp_begin(pages: number): void;
  mp_last_refusal(): number;
}

// The operations (engine/mp/src/abi.rs's op codes).
const OP = {
  add: 1, sub: 2, mul: 3, div: 4, sqrt: 5, exp: 6, log: 7, cos: 8, sin: 9, pow: 10, normalize: 11, normalize1: 12,
  from_man_exp: 13, mpc_exp: 14, mpc_sqrt: 15, exp_fixed: 16, cos_sin_fixed: 17, log_int_fixed: 18, pi_fixed: 19,
  ln2_fixed: 20, e_fixed: 21, bitcount: 22, trailing: 23, isqrt: 24, sqrtrem: 25, ifac: 26,
};
// The rounding modes, as mpmath writes them ('n', 'f', 'c', 'd', 'u').
const RND: Record<string, number> = { n: 0, f: 1, c: 2, d: 3, u: 4 };
// The largest number a call may make, in limbs (2^28 bits), and the most the
// core's memory may grow by, in 64 KiB pages (1 GiB): its share of the
// session's memory, bounded at its source (engine/wasmheap).
const MAX_LIMBS = 1 << 22;
const MAX_PAGES = 16384;
const EXACT = 2 ** 53;

let C: Core | null = null;

// (exported for the tests)
export function mpBytes(): Uint8Array {
  return assetBytes("MP", "sagebrush-mp.wasm", "multiprecision core");
}

// (no fallback: a core that can't load is the import's error, design §4.3)
function core(): Core {
  if (C === null) {
    // (sagebrush.interrupted: Stop, polled by the core's long loops through engine/interrupt, as the engine's)
    const imports = { sagebrush: { interrupted: () => INTR[0] & INTR_CTRL_C } };
    const c = new WebAssembly.Instance(new WebAssembly.Module(mpBytes() as any), imports).exports as unknown as Core;
    c.mp_begin(MAX_PAGES);
    c.mp_set_max_limbs(MAX_LIMBS);
    C = c;
  }
  return C;
}

// (the scalars out, a view made again only when the memory has grown)
let RES: Float64Array | null = null;
const res = (c: Core) => (RES !== null && RES.buffer === c.memory.buffer ? RES : (RES = new Float64Array(c.memory.buffer, c.mp_res(), 8)));

// ---- Python values in

/** a Python int (a JS number or bigint; a bool) as a bigint, or null */
function intOf(v: any): bigint | null {
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  return null;
}

/** the limbs of |x| into the IO buffer at limb `at`: their count */
function putLimbs(c: Core, at: number, x: bigint): number {
  if (x < 0n) x = -x;
  const n = x === 0n ? 0 : Math.ceil(x.toString(16).length / 16);
  const p = c.mp_io(at + n);
  if (p === 0) memoryGuard("A number for the multiprecision core", BigInt(at + n) * 8n, 0, "one number");
  const io = new BigUint64Array(c.memory.buffer, p, at + n);
  for (let i = 0; i < n; i++, x >>= 64n) io[at + i] = x & 0xffffffffffffffffn;
  return n;
}

function badTuple(): never {
  return Obj.raise(Obj.T.TypeError, "an mpf value is a tuple of four ints (sign, man, exp, bc)");
}

/** register r := the raw mpf tuple s (sign, man, exp, bc) */
function setF(c: Core, r: number, s: any) {
  if (!Array.isArray(s) || s.length !== 4) badTuple();
  const [sign, man, exp, bc] = s;
  const sg = intOf(sign), m = intOf(man), e = intOf(exp), b = intOf(bc);
  if (sg === null || m === null || e === null || b === null) badTuple();
  if (m < 0n || b < -EXACT || b > EXACT) badTuple();
  if (Number.isSafeInteger(man) && Number.isSafeInteger(exp) && Number.isSafeInteger(bc)) {
    if (c.mp_set_f(r, Number(sg), man, exp, bc) < 0) badTuple();
    return;
  }
  const nman = putLimbs(c, 0, m);
  const small = e > -BigInt(EXACT) && e < BigInt(EXACT);
  const nexp = small ? 0 : putLimbs(c, nman, e);
  if (c.mp_set_fx(r, Number(sg), nman, small ? Number(e) : 0, Number(b), nexp, e < 0n ? 1 : 0) < 0) badTuple();
}

/** register r := the int v (or nothing, for None) */
function setI(c: Core, r: number, v: any, what: string) {
  if (v === null || v === undefined) return c.mp_set_none(r);
  const x = intOf(v);
  if (x === null) return Obj.raise(Obj.T.TypeError, `${what} must be an int, not '${Obj.typeName(v)}'`);
  const e = Number.isSafeInteger(v) ? c.mp_set_i(r, v) : c.mp_set_ix(r, x < 0n ? 1 : 0, putLimbs(c, 0, x));
  if (e < 0) fail(c, e, what);
}

function precOf(p: any): number {
  if (typeof p === "number" && p >= 0 && Number.isSafeInteger(p)) return p;
  if (p === null || p === undefined) return 0;
  const x = intOf(p);
  if (x === null) return Obj.raise(Obj.T.TypeError, `the precision must be an int, not '${Obj.typeName(p)}'`);
  if (x < 0n) return Obj.raise(Obj.T.ValueError, "negative shift count");
  // (a precision past 2^53 bits is a number no limit admits: the limit's refusal)
  return x >= BigInt(EXACT) ? limit(Number.MAX_SAFE_INTEGER / 64) : Number(x);
}

function rndOf(r: any): number {
  const k = typeof r === "string" ? RND[r] : undefined;
  return k === undefined ? Obj.raise(Obj.T.ValueError, `unknown rounding mode ${repr(r)}`) : k;
}

// ---- results out

function limbsOf(c: Core, at: number, n: number): bigint {
  const io = new BigUint64Array(c.memory.buffer, c.mp_io(at + n), at + n);
  let x = 0n;
  for (let i = n - 1; i >= 0; i--) x = (x << 64n) | io[at + i];
  return x;
}

/** result k as a Python value: a raw mpf tuple or an int */
function out(c: Core, k: number, name: string): any {
  const kind = c.mp_out(k);
  if (kind < 0) fail(c, kind, name);
  const r = res(c);
  switch (kind) {
    case 0:
      return Obj.tuple([r[0], r[1], r[2], r[3]]);
    case 1: {
      const nman = r[1], nexp = r[4];
      const man = limbsOf(c, 0, nman);
      let exp: bigint | number = r[2];
      if (nexp > 0) {
        const m = limbsOf(c, nman, nexp);
        exp = r[5] ? -m : m;
      }
      return Obj.tuple([r[0], O.normBig(man), typeof exp === "bigint" ? O.normBig(exp) : exp, r[3]]);
    }
    case 2:
      return r[0];
    case 3: {
      const x = limbsOf(c, 0, r[1]);
      return O.normBig(r[0] ? -x : x);
    }
    default:
      return null;
  }
}

// ---- failures: the reference's exceptions, and the limits' refusals

// What each hook's exceptions say, as the reference's raise statements do.
const COMPLEX: Record<string, string> = {
  mpf_sqrt: "square root of a negative number",
  mpf_log: "logarithm of a negative number",
  mpf_pow: "negative number raised to a fractional power",
  log_int_fixed: "logarithm of a negative number",
};

function limit(limbs: number): never {
  return memoryGuard(`A number of ${limbs * 64} bits`, BigInt(Math.ceil(limbs)) * 8n, MAX_LIMBS * 8, "one multiprecision number", true);
}

function fail(c: Core, code: number, name: string): never {
  const r = res(c);
  switch (code) {
    case -1:
      return limit(r[0]);
    case -2:
      return memoryGuard("The multiprecision core's working memory", r[0], MAX_PAGES * 65536, "the multiprecision core");
    case -3:
      // (mpf_div's own raise has no message; Python's // and % by zero say this)
      return name === "mpf_div" ? Obj.raise(Obj.T.ZeroDivisionError) : Obj.raise(Obj.T.ZeroDivisionError, "integer division or modulo by zero");
    case -4: {
      const cls = Obj.getattr(importModule("mpmath.libmp.libmpf"), "ComplexResult");
      throw Obj.raiseExc(Obj.callObj(cls, [COMPLEX[name] ?? "complex result"]));
    }
    case -5:
      // ({1: finf, -1: fninf}[sign] with a sign of 0)
      throw Obj.raiseExc(Obj.T.KeyError(0));
    default:
      return Obj.raise(Obj.T.SystemError, `${name}: the multiprecision core refused its call (${code})`);
  }
}

// A trap: Stop (the core's loops poll it, and an interrupt traps), a growth
// past the heap's page bound that couldn't fail cleanly, or a bug.  The
// instance is retired either way (it holds no number between calls, only
// caches, so nothing the session can see is lost); a Stop is the call's
// KeyboardInterrupt, a refused growth its MemoryError.
function trapped(c: Core, e: any): never {
  C = null;
  RES = null;
  if (!(e instanceof WebAssembly.RuntimeError)) throw e;
  O.pollInterrupt();
  let need = 0;
  try {
    need = new DataView(c.memory.buffer, c.mp_last_refusal(), 12).getUint32(0, true);
  } catch {}
  if (need > 0) memoryGuard("The multiprecision core's working memory", need * 65536, MAX_PAGES * 65536, "the multiprecision core");
  return Obj.raise(Obj.T.SystemError, `the multiprecision core failed: ${e.message}`);
}

/** run op on the registers loaded by `load`: its results as Python values */
function call(name: string, op: number, prec: any, rnd: any, load: (c: Core) => void): any {
  const c = core();
  const p = precOf(prec), m = rndOf(rnd);
  let n: number;
  try {
    load(c);
    n = c.mp_run(op, p, m);
  } catch (e) {
    return trapped(c, e);
  }
  if (n < 0) fail(c, n, name);
  return n === 1 ? out(c, 0, name) : Obj.tuple([out(c, 0, name), out(c, 1, name)]);
}

// ---- the context: mpmath's PythonMPContext, its mpf type's arithmetic native

// The slot `name` of instances of cls (a __slots__ member): the key it is stored under.
function slotKey(cls: any, name: string): string {
  for (const c of cls.$mro) {
    const d = c.$dict.get(name);
    if (d !== undefined && typeof d.key === "string") return d.key;
  }
  return Obj.raise(Obj.T.TypeError, `no slot ${name}`);
}

/** a raw mpf tuple whose four fields are exact JS numbers, else null */
const inline = (t: any): any[] | null =>
  Array.isArray(t) && t.length === 4 && Number.isSafeInteger(t[1]) && Number.isSafeInteger(t[2]) && Number.isSafeInteger(t[3]) && (t[0] === 0 || t[0] === 1) ? t : null;

// The hybrid number (design §4.6): an mpf whose mantissa is 2^53 or more keeps
// it JS-side, as packed limbs ($m: a Uint32Array of 2n words, n u64 limbs,
// little-endian, the top limb nonzero) with $s, $e and $b (sign, exponent and
// bc, exact numbers); its `_mpf_` tuple of Python ints is made from them the
// first time Python reads it, and kept (so x._mpf_ is x._mpf_).  The core
// holds no number between calls: each call copies its operands' limbs in and
// its result's limbs out (a fresh array, never a view of the core's memory).

/** |x|'s limbs as 32-bit words (an even count), refused past the limb limit before anything is allocated */
function wordsOf(x: bigint): Uint32Array {
  const bits = x.toString(16).length * 4;
  const n = Math.ceil(bits / 64);
  if (n > MAX_LIMBS) limit(n);
  const w = new Uint32Array(2 * n);
  for (let i = 0; i < 2 * n; i++, x >>= 32n) w[i] = Number(x & 0xffffffffn);
  return w;
}

/** the big form's mantissa as a Python int */
function manOf(w: Uint32Array): any {
  let x = 0n;
  for (let i = w.length - 1; i >= 0; i--) x = (x << 32n) | BigInt(w[i]);
  return O.normBig(x);
}

// ctx.mpf's binary arithmetic: when the other operand is an mpf of the same
// context (its exact type), the same libmp call the reference's
// binary_op makes (mpf_add/mpf_sub/mpf_mul/mpf_div(sval, tval, prec,
// rounding), prec and rounding read from ctx._prec_rounding at each call),
// on the core in one call; anything else (an int, a float, an mpc, a
// constant, another context's mpf) goes to mpmath's own method unchanged.
function installFast(ctx: any) {
  const cls = Obj.getattr(ctx, "mpf");
  const key = slotKey(cls, "_mpf_");
  const pr = Obj.getattr(cls, "_ctxdata")[2];
  const Ctor = cls.$ctor;
  // (x's big form, made from its tuple and kept, or null where it has none: a tuple inline, or its exponent past 2^53)
  const big = (x: any): Uint32Array | null => {
    if (x.$m !== undefined) return x.$m;
    const t = x[key];
    if (!Array.isArray(t) || t.length !== 4 || !Number.isSafeInteger(t[2]) || !Number.isSafeInteger(t[3]) || typeof t[1] !== "bigint") return null;
    x.$s = t[0];
    x.$e = t[2];
    x.$b = t[3];
    return (x.$m = wordsOf(t[1]));
  };
  Obj.setattr(cls, "_mpf_", Obj.callObj((Obj.T as any).property, [
    Obj.builtin((self: any) => {
      const t = self[key];
      if (t !== undefined) return t;
      if (self.$m === undefined) return Obj.raise(Obj.T.AttributeError, "_mpf_");
      return (self[key] = Obj.tuple([self.$s, manOf(self.$m), self.$e, self.$b]));
    }, "_mpf_"),
    Obj.builtin((self: any, v: any) => {
      self[key] = v;
      self.$m = undefined;
      return null;
    }, "_mpf_"),
    Obj.builtin((self: any) => {
      self[key] = undefined;
      self.$m = undefined;
      return null;
    }, "_mpf_"),
  ]));
  for (const [name, op, hook] of [["__add__", OP.add, "mpf_add"], ["__radd__", OP.add, "mpf_add"], ["__sub__", OP.sub, "mpf_sub"], ["__mul__", OP.mul, "mpf_mul"], ["__rmul__", OP.mul, "mpf_mul"], ["__truediv__", OP.div, "mpf_div"]] as [string, number, string][]) {
    const slow = Obj.getattr(cls, name);
    const f = (self: any, other: any) => {
      if (other === null || typeof other !== "object" || other.$cls !== cls || self.$cls !== cls) return Obj.callObj(slow, [self, other]);
      const c = core();
      const prec = precOf(pr[0]), rnd = RND[pr[1]] ?? rndOf(pr[1]);
      const a = self.$m === undefined ? inline(self[key]) : null, b = other.$m === undefined ? inline(other[key]) : null;
      const am = a === null ? big(self) : null, bm = b === null ? big(other) : null;
      let k: number;
      if ((a !== null || am !== null) && (b !== null || bm !== null)) {
        // (the packed operands' limbs into the IO buffer: a's, then b's)
        const an = am === null ? 0 : am.length >> 1, bn = bm === null ? 0 : bm.length >> 1;
        if (an + bn > 0) {
          const p = c.mp_io(an + bn);
          if (p === 0) memoryGuard("The operands of a multiprecision operation", (an + bn) * 8, MAX_PAGES * 65536, "the multiprecision core");
          const io = new Uint32Array(c.memory.buffer, p, 2 * (an + bn));
          if (am !== null) io.set(am, 0);
          if (bm !== null) io.set(bm, 2 * an);
        }
        try {
          k = a !== null
          ? (b !== null ? c.mp_bin(op, prec, rnd, a[0], a[1], a[2], a[3], 0, b[0], b[1], b[2], b[3], 0) : c.mp_bin(op, prec, rnd, a[0], a[1], a[2], a[3], 0, other.$s, 0, other.$e, other.$b, bn))
          : (b !== null ? c.mp_bin(op, prec, rnd, self.$s, 0, self.$e, self.$b, an, b[0], b[1], b[2], b[3], 0) : c.mp_bin(op, prec, rnd, self.$s, 0, self.$e, self.$b, an, other.$s, 0, other.$e, other.$b, bn));
        } catch (e) {
          return trapped(c, e);
        }
        if (k < 0) fail(c, k, hook);
      } else k = -100;
      const o = new Ctor();
      const r = res(c);
      if (k === 0) o[key] = Obj.tuple([r[0], r[1], r[2], r[3]]);
      else if (k === 1 && r[4] === 0) {
        // (the result's limbs copied out: a fresh array)
        const n = r[1];
        o.$m = new Uint32Array(new Uint32Array(c.memory.buffer, c.mp_io(n), 2 * n));
        o.$s = r[0];
        o.$e = r[2];
        o.$b = r[3];
      } else o[key] = call(hook, op, pr[0], pr[1], (cc) => (setF(cc, 0, Obj.getattr(self, "_mpf_")), setF(cc, 1, Obj.getattr(other, "_mpf_"))));
      return o;
    };
    Obj.setattr(cls, name, Obj.pyfn(f, name));
  }
}

// ---- the module

newBuiltinModule("_sagebrush_mpcore", (m) => {
  const def = (name: string, f: (...a: any[]) => any) => (m[name] = Obj.builtin(f, name));
  const binary = (name: string, op: number, precDefault: any) =>
    def(name, (s: any, t: any, prec: any = precDefault, rnd: any = "d") => call(name, op, prec, rnd, (c) => (setF(c, 0, s), setF(c, 1, t))));
  const unary = (name: string, op: number) => def(name, (x: any, prec: any, rnd: any = "d") => call(name, op, prec, rnd, (c) => setF(c, 0, x)));

  // libmpf
  for (const [name, op] of [["_normalize", OP.normalize], ["_normalize1", OP.normalize1]] as [string, number][])
    def(name, (sign: any, man: any, exp: any, bc: any, prec: any, rnd: any) => call(name, op, prec, rnd, (c) => setF(c, 0, Obj.tuple([sign, man, exp, bc]))));
  def("from_man_exp", (man: any, exp: any, prec: any = null, rnd: any = "d") =>
    call("from_man_exp", OP.from_man_exp, prec, rnd, (c) => (setI(c, 0, man, "man"), setI(c, 1, exp, "exp"))));
  binary("mpf_add", OP.add, 0);
  binary("mpf_sub", OP.sub, 0);
  binary("mpf_mul", OP.mul, 0);
  def("mpf_div", (s: any, t: any, prec: any, rnd: any = "d") => call("mpf_div", OP.div, prec, rnd, (c) => (setF(c, 0, s), setF(c, 1, t))));
  unary("mpf_sqrt", OP.sqrt);
  // libelefun
  unary("mpf_exp", OP.exp);
  unary("mpf_log", OP.log);
  unary("mpf_cos", OP.cos);
  unary("mpf_sin", OP.sin);
  def("mpf_pow", (s: any, t: any, prec: any, rnd: any = "d") => call("mpf_pow", OP.pow, prec, rnd, (c) => (setF(c, 0, s), setF(c, 1, t))));
  for (const [name, op, opt] of [["exp_fixed", OP.exp_fixed, "ln2"], ["cos_sin_fixed", OP.cos_sin_fixed, "pi2"], ["log_int_fixed", OP.log_int_fixed, "ln2"]] as [string, number, string][])
    def(name, (x: any, prec: any, extra: any = null) => call(name, op, prec, "n", (c) => (setI(c, 0, x, "x"), setI(c, 1, extra, opt))));
  // (constant_memo's g(prec, **kwargs): pi_fixed's verbose arguments change nothing returned)
  for (const [name, op] of [["pi_fixed", OP.pi_fixed], ["ln2_fixed", OP.ln2_fixed], ["e_fixed", OP.e_fixed]] as [string, number][])
    def(name, (prec: any) => call(name, op, prec, "n", () => {}));
  // libmpc
  for (const [name, op] of [["mpc_exp", OP.mpc_exp], ["mpc_sqrt", OP.mpc_sqrt]] as [string, number][])
    def(name, (z: any, prec: any, rnd: any = "d") => {
      if (!Array.isArray(z) || z.length !== 2) Obj.raise(Obj.T.TypeError, "an mpc value is a pair of mpf tuples");
      return call(name, op, prec, rnd, (c) => (setF(c, 0, z[0]), setF(c, 1, z[1])));
    });
  // libintmath
  def("bitcount", (n: any) => call("bitcount", OP.bitcount, 0, "n", (c) => setI(c, 0, n, "n")));
  def("trailing", (n: any) => call("trailing", OP.trailing, 0, "n", (c) => setI(c, 0, n, "n")));
  for (const [name, op] of [["isqrt", OP.isqrt], ["sqrtrem", OP.sqrtrem]] as [string, number][])
    def(name, (x: any) => {
      // (the python backend's int(x**0.5 ...) of a negative x: a complex, which int() refuses)
      const v = intOf(x);
      if (v !== null && v < 0n) Obj.raise(Obj.T.TypeError, "int() argument must be a string, a bytes-like object or a real number, not 'complex'");
      return call(name, op, 0, "n", (c) => setI(c, 0, x, "x"));
    });
  def("ifac", (n: any) => {
    // (a float n: its floor, and whether it was integral; ifac's memo decides the rest, abi.rs)
    if (typeof n === "number" && !Number.isInteger(n)) return call("ifac", OP.ifac, 0, "f", (c) => setI(c, 0, Math.floor(n), "n"));
    return call("ifac", OP.ifac, 0, "n", (c) => setI(c, 0, n instanceof Obj.FloatBox ? n.v : n, "n"));
  });
  // The context's base class: mpmath's own PythonMPContext with its mpf
  // type's arithmetic native (installFast); made when the overlay's ctx_mp
  // first asks, after libmp is whole.
  m.__getattr__ = Obj.builtin((name: string) => {
    if (name !== "Context") return Obj.raise(Obj.T.AttributeError, `module '_sagebrush_mpcore' has no attribute '${name}'`);
    const Base = Obj.getattr(importModule("mpmath.ctx_mp_python"), "PythonMPContext");
    const init = Obj.getattr(Base, "__init__");
    const ns = new Obj.PyDict();
    Obj.dictSet(ns, "__module__", "_sagebrush_mpcore");
    Obj.dictSet(ns, "__init__", Obj.pyfn((ctx: any) => {
      Obj.callObj(init, [ctx]);
      installFast(ctx);
      return null;
    }, "__init__"));
    m.Context = Obj.callObj(Obj.T.type, ["Context", Obj.tuple([Base]), ns]);
    return m.Context;
  }, "__getattr__");
  // (tests: the session's end, every cache and memo forgotten)
  def("_reset", () => (C !== null && C.mp_reset(), null));
});
