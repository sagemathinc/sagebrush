// Sagebrush's multiprecision core (engine/mp; design/mpmath-core.md) as the
// builtin module `_sagebrush_mpcore`, the backend python's overlay of mpmath
// selects (SAGEBRUSH_MPMATH_BACKEND=sagebrush): the 27 libmp functions it
// hooks (backend.py's SAGEBRUSH_HOOKS), each with the reference's raw-tuple
// arguments, results and exceptions, and the Context the overlay's ctx_mp
// takes as its base.
// The WebAssembly module (wasm/sagebrush-mp.wasm) is compiled the first time
// a hook is called, from wherever the host keeps it (as the PNG module's,
// src/runtime/raster.ts):
//   globalThis.__SAGEBRUSH_MP__      its bytes, as base64 (the CLI bundle)
//   globalThis.__SAGEBRUSH_MP_URL__  a URL to fetch synchronously (the
//                                    notebook's worker), checked against
//                                    __SAGEBRUSH_MP_SHA256__
//   else, in Node, the file wasm/sagebrush-mp.wasm above this module.

import { sha256Hex } from "./sha256";
import * as Obj from "./object";
import { importModule, memoryGuard, newBuiltinModule } from "./modules";
import * as O from "./ops";
import { repr } from "./format";

interface Core {
  memory: WebAssembly.Memory;
  mp_io(n: number): number;
  mp_res(): number;
  mp_set_f(r: number, sign: number, man: number, exp: number, bc: number): number;
  mp_set_fx(r: number, sign: number, nman: number, exp: number, bc: number, nexp: number, expneg: number): number;
  mp_set_i(r: number, v: number): number;
  mp_set_ix(r: number, neg: number, n: number): number;
  mp_set_none(r: number): void;
  mp_run(op: number, prec: number, rnd: number): number;
  mp_out(k: number): number;
  mp_reset(): void;
  mp_set_max_limbs(n: number): void;
  mp_begin(pages: number): void;
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
  const g = globalThis as any;
  if (typeof g.__SAGEBRUSH_MP__ === "string") {
    const bin = atob(g.__SAGEBRUSH_MP__);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  if (g.__SAGEBRUSH_MP_URL__) {
    // (only the bytes the page was built with run: without the hash they are not fetched at all)
    const want = g.__SAGEBRUSH_MP_SHA256__;
    if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) throw new Error("the multiprecision core has no SHA-256 to check, so it is not loaded");
    let b: Uint8Array;
    if (typeof g.__SAGEBRUSH_FETCH_SYNC__ === "function") b = g.__SAGEBRUSH_FETCH_SYNC__(String(g.__SAGEBRUSH_MP_URL__));
    else {
      const x = new XMLHttpRequest();
      x.open("GET", String(g.__SAGEBRUSH_MP_URL__), false);
      x.responseType = "arraybuffer";
      x.send();
      if (x.status !== 200) throw new Error(`could not load the multiprecision core (HTTP ${x.status})`);
      b = new Uint8Array(x.response);
    }
    if (sha256Hex(b) !== want) throw new Error("the multiprecision core fetched is not the one this page was built with");
    return b;
  }
  const fs = g.process?.getBuiltinModule?.("fs"), path = g.process?.getBuiltinModule?.("path");
  if (fs && path) {
    const start = typeof __dirname === "string" ? __dirname : g.process.cwd();
    for (let dir = start, i = 0; i < 6; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, "wasm", "sagebrush-mp.wasm");
      if (fs.existsSync(f)) return new Uint8Array(fs.readFileSync(f));
    }
  }
  throw new Error("Sagebrush's multiprecision core (sagebrush-mp.wasm) is not available here");
}

// (no fallback: a core that can't load is the import's error, design §4.3)
function core(): Core {
  if (C === null) {
    const c = new WebAssembly.Instance(new WebAssembly.Module(mpBytes() as any), {}).exports as unknown as Core;
    c.mp_begin(MAX_PAGES);
    c.mp_set_max_limbs(MAX_LIMBS);
    C = c;
  }
  return C;
}

const res = (c: Core) => new Float64Array(c.memory.buffer, c.mp_res(), 8);

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

/** run op on the registers loaded by `load`: its results as Python values */
function call(name: string, op: number, prec: any, rnd: any, load: (c: Core) => void): any {
  const c = core();
  const p = precOf(prec), m = rndOf(rnd);
  load(c);
  const n = c.mp_run(op, p, m);
  if (n < 0) fail(c, n, name);
  return n === 1 ? out(c, 0, name) : Obj.tuple([out(c, 0, name), out(c, 1, name)]);
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
  // The context's base class: mpmath's own PythonMPContext for now (its types
  // run on these hooks); taken when the overlay's ctx_mp first asks, after
  // libmp is whole.
  m.__getattr__ = Obj.builtin((name: string) => {
    if (name !== "Context") return Obj.raise(Obj.T.AttributeError, `module '_sagebrush_mpcore' has no attribute '${name}'`);
    m.Context = Obj.getattr(importModule("mpmath.ctx_mp_python"), "PythonMPContext");
    return m.Context;
  }, "__getattr__");
  // (tests: the session's end, every cache and memo forgotten)
  def("_reset", () => (C !== null && C.mp_reset(), null));
});
