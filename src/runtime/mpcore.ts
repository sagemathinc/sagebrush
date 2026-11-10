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
  mp_set_max_limbs(n: number): void;
  mp_begin(pages: number): void;
  mp_last_refusal(): number;
}

// The hooks, in the order of engine/mp/src/abi.rs's op codes (a hook's op is
// its index + 1), and the kind of arguments each takes (the module's ARGS).
const HOOKS = "mpf_add mpf_sub mpf_mul mpf_div mpf_sqrt mpf_exp mpf_log mpf_cos mpf_sin mpf_pow _normalize _normalize1 from_man_exp mpc_exp mpc_sqrt exp_fixed cos_sin_fixed log_int_fixed pi_fixed ln2_fixed e_fixed bitcount trailing isqrt sqrtrem ifac".split(" ");
const KINDS = "bbbbuuuuubnnmccxxxkkkiiqqf";
const OP: Record<string, number> = {};
HOOKS.forEach((h, i) => (OP[h] = i + 1));
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
const intOf = (v: any): bigint | null => (typeof v === "bigint" ? v : typeof v === "boolean" || Number.isInteger(v) ? BigInt(v) : null);
const safe = Number.isSafeInteger;

/** the IO buffer's 32-bit words for limbs 0..n (room for them made first) */
function ioWords(c: Core, n: number): Uint32Array {
  const p = c.mp_io(n);
  if (p === 0) heap(n * 8);
  return new Uint32Array(c.memory.buffer, p, 2 * n);
}

/** the limbs of |x| into the IO buffer at limb `at`: their count */
function putLimbs(c: Core, at: number, x: bigint): number {
  const w = wordsOf(x < 0n ? -x : x), n = w.length >> 1;
  ioWords(c, at + n).set(w, 2 * at);
  return n;
}

const notInt = (what: string, v: any): never => Obj.raise(Obj.T.TypeError, `${what} must be an int, not '${Obj.typeName(v)}'`);

function badTuple(): never {
  return Obj.raise(Obj.T.TypeError, "an mpf value is a tuple of four ints (sign, man, exp, bc)");
}

/** register r := the raw mpf tuple s (sign, man, exp, bc) */
function setF(c: Core, r: number, s: any) {
  const [sg, m, e, b] = Array.isArray(s) && s.length === 4 ? s.map(intOf) : [];
  if (sg == null || m == null || e == null || b == null || m < 0n || !safe(Number(b))) badTuple();
  const sign = Number(sg);
  if (safe(s[1]) && safe(s[2])) {
    if (c.mp_set_f(r, sign, s[1], s[2], Number(b)) < 0) badTuple();
    return;
  }
  // (else the mantissa as limbs, and the exponent too when it is past 2^53)
  const small = safe(Number(e)), nman = putLimbs(c, 0, m), nexp = small ? 0 : putLimbs(c, nman, e);
  if (c.mp_set_fx(r, sign, nman, small ? Number(e) : 0, Number(b), nexp, +(e < 0n)) < 0) badTuple();
}

/** register r := the int v (or nothing, for None) */
function setI(c: Core, r: number, v: any, what: string) {
  if (v === null || v === undefined) return c.mp_set_none(r);
  const x = intOf(v);
  if (x === null) return notInt(what, v);
  const e = safe(v) ? c.mp_set_i(r, v) : c.mp_set_ix(r, +(x < 0n), putLimbs(c, 0, x));
  if (e < 0) fail(c, e, what);
}

function precOf(p: any): number {
  if (p == null) return 0;
  const x = intOf(p);
  if (x === null) return notInt("the precision", p);
  if (x < 0n) return Obj.raise(Obj.T.ValueError, "negative shift count");
  // (a precision past 2^53 bits is a number no limit admits: the limit's refusal)
  return safe(Number(x)) ? Number(x) : limit(EXACT / 64);
}

// (the rounding modes, as mpmath writes them, by their codes: 'n', 'f', 'c', 'd', 'u')
function rndOf(r: any): number {
  const k = typeof r === "string" && r.length === 1 ? "nfcdu".indexOf(r) : -1;
  return k < 0 ? Obj.raise(Obj.T.ValueError, `unknown rounding mode ${repr(r)}`) : k;
}

// ---- results out

/** the int whose magnitude is the n limbs at limb `at` of the IO buffer (negated if neg) */
function intAt(c: Core, at: number, n: number, neg: number): any {
  const x = manOf(ioWords(c, at + n).subarray(2 * at));
  return O.normBig(neg ? -x : x);
}

/** result k as a Python value: a raw mpf tuple or an int */
function out(c: Core, k: number, name: string): any {
  const kind = c.mp_out(k);
  if (kind < 0) fail(c, kind, name);
  const r = res(c);
  switch (kind) {
    case 0:
      return Obj.tuple([r[0], r[1], r[2], r[3]]);
    case 1:
      // (the exponent too as limbs, after the mantissa's, when it is past 2^53)
      return Obj.tuple([r[0], intAt(c, 0, r[1], 0), r[4] > 0 ? intAt(c, r[1], r[4], r[5]) : r[2], r[3]]);
    case 2:
      return r[0];
    case 3:
      return intAt(c, 0, r[1], r[0]);
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

/** the core's memory refused `bytes` more (the operands' copy-in, or its working memory) */
const heap = (bytes: number): never => memoryGuard("The multiprecision core's working memory", bytes, MAX_PAGES * 65536, "the multiprecision core");

function limit(limbs: number): never {
  return memoryGuard(`A number of ${limbs * 64} bits`, BigInt(Math.ceil(limbs)) * 8n, MAX_LIMBS * 8, "one multiprecision number", true);
}

function fail(c: Core, code: number, name: string): never {
  const r = res(c);
  switch (code) {
    case -1:
      return limit(r[0]);
    case -2:
      return heap(r[0]);
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
    need = new Uint32Array(c.memory.buffer, c.mp_last_refusal(), 1)[0];
  } catch {}
  if (need > 0) heap(need * 65536);
  return Obj.raise(Obj.T.SystemError, `the multiprecision core failed: ${e.message}`);
}

/** run hook `name` on the registers loaded by `load`: its results as Python values */
function call(name: string, prec: any, rnd: any, load: (c: Core) => void): any {
  const c = core();
  const p = precOf(prec), m = rndOf(rnd);
  let n: number;
  try {
    load(c);
    n = c.mp_run(OP[name], p, m);
  } catch (e) {
    return trapped(c, e);
  }
  if (n < 0) fail(c, n, name);
  return n === 1 ? out(c, 0, name) : Obj.tuple([out(c, 0, name), out(c, 1, name)]);
}

// ---- the context: mpmath's PythonMPContext, its mpf type's arithmetic native

// The hybrid number (design §4.6): an mpf whose mantissa is 2^53 or more keeps
// it JS-side, as packed limbs ($m: a Uint32Array of 2n words, n u64 limbs,
// little-endian, the top limb nonzero) with $s, $e and $b (sign, exponent and
// bc, exact numbers); its `_mpf_` tuple of Python ints is made from them the
// first time Python reads it, and kept (so x._mpf_ is x._mpf_).  The core
// holds no number between calls: each call copies its operands' limbs in and
// its result's limbs out (a fresh array, never a view of the core's memory).

/** |x|'s limbs as 32-bit words (an even count), refused past the limb limit before anything is allocated */
function wordsOf(x: bigint): Uint32Array {
  const n = x === 0n ? 0 : Math.ceil(x.toString(16).length / 16);
  if (n > MAX_LIMBS) limit(n);
  const w = new Uint32Array(2 * n);
  for (let i = 0; i < 2 * n; i++, x >>= 32n) w[i] = Number(x & 0xffffffffn);
  return w;
}

/** the int whose limbs are the words w */
function manOf(w: Uint32Array): bigint {
  let x = 0n;
  for (let i = w.length - 1; i >= 0; i--) x = (x << 32n) | BigInt(w[i]);
  return x;
}

// ctx.mpf's binary arithmetic: when the other operand is an mpf of the same
// context (its exact type), the same libmp call the reference's
// binary_op makes (mpf_add/mpf_sub/mpf_mul/mpf_div(sval, tval, prec,
// rounding), prec and rounding read from ctx._prec_rounding at each call),
// on the core in one call; anything else (an int, a float, an mpc, a
// constant, another context's mpf) goes to mpmath's own method unchanged.
function installFast(ctx: any) {
  const cls = Obj.getattr(ctx, "mpf");
  // (the key mpf's _mpf_ slot is stored under, its __slots__ member's)
  const key: string = Obj.lookupType(cls, "_mpf_").key;
  const pr = Obj.getattr(cls, "_ctxdata")[2];
  const Ctor = cls.$ctor;
  // (x as mp_bin's operand: its tuple when its four fields are exact JS numbers (inline), else null with its big
  // form made from the tuple and kept; undefined where it has neither, an exponent past 2^53)
  const operand = (x: any): any[] | null | undefined => {
    const t = x[key];
    if (x.$m !== undefined) return null;
    if (!Array.isArray(t) || t.length !== 4 || !safe(t[2]) || !safe(t[3])) return undefined;
    if (safe(t[1]) && (t[0] === 0 || t[0] === 1)) return t;
    if (typeof t[1] !== "bigint") return undefined;
    x.$s = t[0];
    x.$e = t[2];
    x.$b = t[3];
    x.$m = wordsOf(t[1]);
    return null;
  };
  Obj.setattr(cls, "_mpf_", Obj.callObj((Obj.T as any).property, [
    Obj.builtin((self: any) => {
      const t = self[key];
      if (t !== undefined) return t;
      if (self.$m === undefined) return Obj.raise(Obj.T.AttributeError, "_mpf_");
      return (self[key] = Obj.tuple([self.$s, O.normBig(manOf(self.$m)), self.$e, self.$b]));
    }, "_mpf_"),
    Obj.builtin((self: any, v: any) => ((self[key] = v), (self.$m = undefined), null), "_mpf_"),
  ]));
  "__add__ __radd__ __sub__ __mul__ __rmul__ __truediv__".split(" ").forEach((name, i) => {
    const op = [1, 1, 2, 3, 3, 4][i], hook = HOOKS[op - 1];
    const slow = Obj.getattr(cls, name);
    const f = (self: any, other: any) => {
      if (other === null || typeof other !== "object" || other.$cls !== cls || self.$cls !== cls) return Obj.callObj(slow, [self, other]);
      const c = core();
      const prec = precOf(pr[0]), rnd = rndOf(pr[1]);
      const a = operand(self), b = operand(other);
      let k = -100;
      if (a !== undefined && b !== undefined) {
        // (the packed operands' limbs into the IO buffer: a's, then b's)
        const an = a ? 0 : self.$m.length >> 1, bn = b ? 0 : other.$m.length >> 1;
        if (an + bn > 0) {
          const io = ioWords(c, an + bn);
          if (!a) io.set(self.$m, 0);
          if (!b) io.set(other.$m, 2 * an);
        }
        const x = a ?? [self.$s, 0, self.$e, self.$b], y = b ?? [other.$s, 0, other.$e, other.$b];
        try {
          k = c.mp_bin(op, prec, rnd, x[0], x[1], x[2], x[3], an, y[0], y[1], y[2], y[3], bn);
        } catch (e) {
          return trapped(c, e);
        }
        if (k < 0) fail(c, k, hook);
      }
      const o = new Ctor();
      const r = res(c);
      if (k === 0) o[key] = Obj.tuple([r[0], r[1], r[2], r[3]]);
      else if (k === 1 && r[4] === 0) {
        // (the result's limbs copied out: a fresh array)
        const n = r[1];
        o.$m = ioWords(c, n).slice();
        o.$s = r[0];
        o.$e = r[2];
        o.$b = r[3];
      } else o[key] = call(hook, pr[0], pr[1], (cc) => (setF(cc, 0, Obj.getattr(self, "_mpf_")), setF(cc, 1, Obj.getattr(other, "_mpf_"))));
      return o;
    };
    Obj.setattr(cls, name, Obj.pyfn(f, name));
  });
}

// ---- the module

newBuiltinModule("_sagebrush_mpcore", (m) => {
  const pair = (s: any, t: any) => (c: Core) => (setF(c, 0, s), setF(c, 1, t));
  // Each kind of hook's arguments, as the reference's signatures take them.
  const ARGS: Record<string, (name: string) => (...a: any[]) => any> = {
    // mpf_add, mpf_sub, mpf_mul, mpf_div, mpf_pow
    b: (name) => (s, t, prec, rnd = "d") => call(name, prec, rnd, pair(s, t)),
    // mpf_sqrt, mpf_exp, mpf_log, mpf_cos, mpf_sin
    u: (name) => (x, prec, rnd = "d") => call(name, prec, rnd, (c) => setF(c, 0, x)),
    // _normalize, _normalize1
    n: (name) => (sign, man, exp, bc, prec, rnd) => call(name, prec, rnd, (c) => setF(c, 0, [sign, man, exp, bc])),
    // from_man_exp
    m: (name) => (man, exp, prec = null, rnd = "d") => call(name, prec, rnd, (c) => (setI(c, 0, man, "man"), setI(c, 1, exp, "exp"))),
    // mpc_exp, mpc_sqrt
    c: (name) => (z, prec, rnd = "d") =>
      Array.isArray(z) && z.length === 2 ? call(name, prec, rnd, pair(z[0], z[1])) : Obj.raise(Obj.T.TypeError, "an mpc value is a pair of mpf tuples"),
    // exp_fixed, cos_sin_fixed, log_int_fixed
    x: (name) => (x, prec, extra = null) => call(name, prec, "n", (c) => (setI(c, 0, x, "x"), setI(c, 1, extra, name === "cos_sin_fixed" ? "pi2" : "ln2"))),
    // pi_fixed, ln2_fixed, e_fixed (constant_memo's g(prec, **kwargs): pi_fixed's verbose arguments change nothing returned)
    k: (name) => (prec) => call(name, prec, "n", () => {}),
    // bitcount, trailing
    i: (name) => (n) => call(name, 0, "n", (c) => setI(c, 0, n, "n")),
    // isqrt, sqrtrem: a negative x is, in the python backend's int(x**0.5 ...), a complex, which int() refuses
    q: (name) => (x) => {
      const v = intOf(x);
      if (v !== null && v < 0n) Obj.raise(Obj.T.TypeError, "int() argument must be a string, a bytes-like object or a real number, not 'complex'");
      return call(name, 0, "n", (c) => setI(c, 0, x, "x"));
    },
    // ifac: a float n is its floor, and whether it was integral (ifac's memo decides the rest, abi.rs)
    f: (name) => (n) =>
      typeof n === "number" && !Number.isInteger(n)
        ? call(name, 0, "f", (c) => setI(c, 0, Math.floor(n), "n"))
        : call(name, 0, "n", (c) => setI(c, 0, n instanceof Obj.FloatBox ? n.v : n, "n")),
  };
  HOOKS.forEach((name, i) => (m[name] = Obj.builtin(ARGS[KINDS[i]](name), name)));
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
});
