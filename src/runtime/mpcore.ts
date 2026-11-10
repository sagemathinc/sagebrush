// Sagebrush's multiprecision core (engine/mp; design/mpmath-core.md) as the
// builtin module `_sagebrush_mpcore`, the backend python's overlay of mpmath
// selects (SAGEBRUSH_MPMATH_BACKEND=sagebrush): the 30 libmp functions it
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
import { INTR, INTR_CTRL_C } from "./interrupt";
import { admitHeap } from "./heap";

interface Core {
  memory: WebAssembly.Memory;
  mp_io(n: number): number;
  mp_res(): number;
  mp_set_f(r: number, sign: number, man: number, exp: number, bc: number): number;
  mp_set_fx(r: number, sign: number, nman: number, exp: number, bc: number, nexp: number, expneg: number): number;
  mp_set_i(r: number, v: number): number;
  mp_set_ix(r: number, neg: number, n: number): number;
  mp_set_none(r: number): void;
  mp_set_m(r: number, count: number, nwords: number): number;
  mp_bin(op: number, prec: number, rnd: number, as: number, am: number, ae: number, ab: number, an: number, bs: number, bm: number, be: number, bb: number, bn: number): number;
  mp_run(op: number, prec: number, rnd: number): number;
  mp_out(k: number): number;
  mp_set_max_limbs(n: number): void;
  mp_begin(pages: number): void;
  mp_last_refusal(): number;
}

// The hooks, in the order of engine/mp/src/abi.rs's op codes (a hook's op is
// its index + 1), and the kind of arguments each takes (the module's ARGS).
const HOOKS = "mpf_add mpf_sub mpf_mul mpf_div mpf_sqrt mpf_exp mpf_log mpf_cos mpf_sin mpf_pow _normalize _normalize1 from_man_exp mpc_exp mpc_sqrt exp_fixed cos_sin_fixed log_int_fixed pi_fixed ln2_fixed e_fixed bitcount trailing isqrt sqrtrem ifac mpc_mul mpc_div mpc_abs mpf_gamma".split(" ");
const KINDS = "bbbbuuuuubnnmccxxxkkkiiqqfwwcg";
const OP: Record<string, number> = {};
HOOKS.forEach((h, i) => (OP[h] = i + 1));
// Each hook's parameters as the reference's def has them (a keyword binds by
// their names), in HOOKS' order, three characters a hook: which of NAMES (a
// hex digit), how many trailing ones have defaults, and "*" if it takes
// **kwargs too.  Its call errors name the python backend's function, which
// for five of them is another name (python_mpf_mul, isqrt_python).
const NAMES = "s t prec rnd _sub|s t prec rnd|s prec rnd|x prec rnd|sign man exp bc prec rnd|man exp prec rnd|z prec rnd|x prec ln2|x prec pi2|n prec ln2|prec|n|x|n memo|z w prec rnd|x prec rnd type".split("|");
const SIG = "03.12.12.11.21.31.31.31.31.11.40.40.52.61.61.71.81.91.a0*a0*a0*b0.b0.c0.c0.d1.e1.e1.61.f2.";
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
    // (a native core given by the host, engine/node's `mp` namespace: the same entry points, its memory an
    // ArrayBuffer of the environment's, replaced (the old one detached) when it grows; else the WebAssembly module)
    const N = (globalThis as any).__SAGEBRUSH_MP_NATIVE__;
    // (sagebrush.interrupted: Stop, polled by the core's long loops through engine/interrupt, as the engine's)
    const imports = { sagebrush: { interrupted: () => INTR[0] & INTR_CTRL_C } };
    const c = N ? ({ ...N, memory: { get buffer() { return N.mp_buffer(); } } } as Core) : (new WebAssembly.Instance(new WebAssembly.Module(mpBytes() as any), imports).exports as unknown as Core);
    c.mp_begin(MAX_PAGES);
    c.mp_set_max_limbs(MAX_LIMBS);
    C = c;
  }
  return C;
}

// (the scalars out, a view made again only when the memory has grown)
let RES: Float64Array | null = null;
const res = (c: Core) => (RES !== null && RES.length ? RES : (RES = new Float64Array(c.memory.buffer, c.mp_res(), 8)));

// ---- Python values in

/** a Python int (a JS number or bigint; a bool) as a bigint, or null */
const intOf = (v: any): bigint | null => (typeof v === "bigint" ? v : typeof v === "boolean" || Number.isInteger(v) ? BigInt(v) : null);
const safe = Number.isSafeInteger;

// (the core's whole memory as 32-bit words, made again only when the memory
// has grown, which detaches the old view: its length is then 0)
let U32: Uint32Array | null = null;
/** the IO buffer's first word in U32, room for limbs 0..n made first */
function ioAt(c: Core, n: number): number {
  const p = c.mp_io(n);
  if (p === 0) heap(n * 8);
  if (U32 === null || U32.length === 0) U32 = new Uint32Array(c.memory.buffer);
  return p >> 2;
}

/** the limbs (as words) into the IO buffer at limb `at`: their count */
function putWords(c: Core, at: number, w: ArrayLike<number>): number {
  const n = w.length >> 1;
  // (the offset first: ioAt may grow the memory, and with it make U32 again)
  const q = ioAt(c, at + n) + 2 * at;
  U32!.set(w, q);
  return n;
}

/** the limbs of |x| into the IO buffer at limb `at`: their count */
const putLimbs = (c: Core, at: number, x: bigint): number => putWords(c, at, wordsOf(x < 0n ? -x : x));

const notInt = (what: string, v: any): never => Obj.raise(Obj.T.TypeError, `${what} must be an int, not '${Obj.typeName(v)}'`);

function badTuple(): never {
  return Obj.raise(Obj.T.TypeError, "an mpf value is a tuple of four ints (sign, man, exp, bc)");
}

/** register r := the raw mpf tuple s (sign, man, exp, bc) */
function setF(c: Core, r: number, s: any) {
  // (four exact JS numbers, the common case, straight to the core, which checks them)
  if (Array.isArray(s) && s.length === 4 && safe(s[0]) && safe(s[1]) && s[1] >= 0 && safe(s[2]) && safe(s[3])) {
    if (c.mp_set_f(r, s[0], s[1], s[2], s[3]) < 0) badTuple();
    return;
  }
  const [sg, m, e, b] = Array.isArray(s) && s.length === 4 ? s.map(intOf) : [];
  if (sg == null || m == null || e == null || b == null || m < 0n || !safe(Number(b))) badTuple();
  const sign = Number(sg);
  if (safe(s[1]) && safe(s[2])) {
    if (c.mp_set_f(r, sign, s[1], s[2], Number(b)) < 0) badTuple();
    return;
  }
  // (else the mantissa as limbs, and the exponent too when it is past 2^53)
  const small = safe(Number(e)), nman = putWords(c, 0, wordsOf(m)), nexp = small ? 0 : putLimbs(c, nman, e);
  if (c.mp_set_fx(r, sign, nman, small ? Number(e) : 0, Number(b), nexp, +(e < 0n)) < 0) badTuple();
}

// A list of mpfs (a matrix's entries, row-major, or a vector's) packed for the core's set_m: each entry
// [sign | nlimbs << 1, exp, bc, limbs...] as u64 words (two 32-bit words each, little-endian); an exponent
// must be exact (|e| < 2^53), else the core is not asked (the caller's own path answers: null).
// (an exact integer |x| < 2^53 as an i64's two words: hi = floor(x / 2^32), lo = x - hi * 2^32)
const u64w = (x: number): [number, number] => {
  const hi = Math.floor(x / 4294967296);
  return [x - hi * 4294967296, hi >>> 0];
};
function setM(c: Core, r: number, xs: any): boolean {
  // (a list or a tuple of raw mpf tuples)
  if (!Array.isArray(xs)) return Obj.raise(Obj.T.TypeError, "a matrix's entries are a list of raw mpf tuples");
  const list: any[] = xs;
  const parts: number[][] = [];
  let words = 0;
  for (const s of list) {
    const [sg, m, e, b] = Array.isArray(s) && s.length === 4 ? s.map(intOf) : [];
    if (sg == null || m == null || e == null || b == null || m < 0n) badTuple();
    if (!safe(Number(e)) || !safe(Number(b))) return false;
    const w = m === 0n ? [] : wordsOf(m);
    const ex = Number(e), bc = Number(b);
    parts.push([...u64w(Number(sg) + 2 * (w.length >> 1)), ...u64w(ex), ...u64w(bc), ...w]);
    words += 3 + (w.length >> 1);
  }
  let q = ioAt(c, words);
  for (const p of parts) {
    U32!.set(p, q);
    q += p.length;
  }
  if (c.mp_set_m(r, list.length, words) < 0) badTuple();
  return true;
}

/** the n mpfs packed in the IO buffer's first `words` words, as a list of raw tuples */
function mpfsAt(c: Core, n: number, words: number): any {
  const q0 = ioAt(c, words), out: any[] = [];
  const i64 = (lo: number, hi: number) => (hi >= 0x80000000 ? (hi - 4294967296) * 4294967296 + lo : hi * 4294967296 + lo);
  for (let k = 0, q = q0; k < n; k++) {
    const h = U32![q], nl = (h >>> 1) + U32![q + 1] * 2147483648;
    const exp = i64(U32![q + 2], U32![q + 3]), bc = i64(U32![q + 4], U32![q + 5]);
    const man = nl === 0 ? 0 : O.normBig(manOf(U32!.subarray(q + 6, q + 6 + 2 * nl)));
    out.push(Obj.tuple([h & 1, man, exp, bc]));
    q += 6 + 2 * nl;
  }
  return out;
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
  if (p >= 0 && safe(p)) return p;
  if (p == null) return 0;
  const x = intOf(p);
  if (x === null) return notInt("the precision", p);
  if (x < 0n) return Obj.raise(Obj.T.ValueError, "negative shift count");
  // (a precision past 2^53 bits is a number no limit admits: the limit's refusal)
  return safe(Number(x)) ? Number(x) : limit(EXACT / 64);
}

// (the rounding modes, as mpmath writes them, by their codes: 'n', 'f', 'c', 'd', 'u'; another is the KeyError
// the reference's tables raise when it rounds, shifts_down[rnd], raised here at once, rounding or not)
function rndOf(r: any): number {
  const k = typeof r === "string" && r.length === 1 ? "nfcdu".indexOf(r) : -1;
  if (k < 0) throw Obj.raiseExc(Obj.T.KeyError(r));
  return k;
}

// ---- results out

/** the int whose magnitude is the n limbs at limb `at` of the IO buffer (negated if neg) */
function intAt(c: Core, at: number, n: number, neg: number): any {
  const o = ioAt(c, at + n) + 2 * at, x = manOf(U32!.subarray(o, o + 2 * n));
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
    case 5:
      return mpfsAt(c, r[0], r[1]);
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

/** the core's own failure (a bug): a SystemError */
const bug = (what: string): never => ((C = RES = U32 = null), Obj.raise(Obj.T.SystemError, `the multiprecision core failed: ${what}`));

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
      // (mpf_div's own raise has no message, nor mpf_pow's or mpc_div's, which are mpf_div's; Python's // and % by zero say this)
      return name === "mpf_div" || name === "mpf_pow" || name === "mpc_div" ? Obj.raise(Obj.T.ZeroDivisionError) : Obj.raise(Obj.T.ZeroDivisionError, "integer division or modulo by zero");
    case -4: {
      const cls = Obj.getattr(importModule("mpmath.libmp.libmpf"), "ComplexResult");
      throw Obj.raiseExc(Obj.callObj(cls, [COMPLEX[name] ?? "complex result"]));
    }
    case -5:
      // ({1: finf, -1: fninf}[sign] with a sign of 0)
      throw Obj.raiseExc(Obj.T.KeyError(0));
    case -6:
      // (the reference's LU_decomp)
      return Obj.raise(Obj.T.ZeroDivisionError, "matrix is numerically singular");
    case -8:
      // (the reference's cholesky)
      return Obj.raise(Obj.T.ValueError, "matrix is not positive-definite");
    default:
      return bug(`${name} refused (${code})`);
  }
}

// A trap: Stop (the core's loops poll it, and an interrupt traps), a growth
// past the heap's page bound that couldn't fail cleanly, or a bug.  The
// caller has retired the instance already, on any JS error (a stack
// overflow too, which may leave the core mid-call, borrowed for good: every
// later call 0), before any call; it holds no number between calls, only
// caches, so nothing the session can see is lost.  A Stop is the call's
// KeyboardInterrupt, a refused growth its MemoryError; a Python exception
// passes as it is.
function trapped(c: Core, e: any): never {
  // (the native core's Stop, engine/node's mp_interrupt: this call's KeyboardInterrupt)
  if (e instanceof Error && e.message === "the multiprecision core was interrupted (Stop)") {
    O.pollInterrupt();
    return Obj.raise(Obj.T.KeyboardInterrupt);
  }
  if (!(e instanceof WebAssembly.RuntimeError)) throw e;
  O.pollInterrupt();
  let need = 0;
  try {
    need = new Uint32Array(c.memory.buffer, c.mp_last_refusal(), 1)[0];
  } catch {}
  if (need > 0) heap(need * 65536);
  return bug(e.message);
}

/** run hook `name` on the registers loaded by `load`: its results as Python values */
function call(name: string, prec: any, rnd: any, load: (c: Core) => void): any {
  const c = core();
  const p = precOf(prec), m = rndOf(rnd);
  try {
    load(c);
    const n = c.mp_run(OP[name], p, m);
    // (mpf_gamma's no result: mpmath's own path answers, None)
    if (n === 0 && name === "mpf_gamma") return null;
    // (no result: a core left mid-call, its failure a bug())
    if (n < 1) fail(c, n, name);
    return n === 1 ? out(c, 0, name) : Obj.tuple([out(c, 0, name), out(c, 1, name)]);
  } catch (e) {
    // (retired here, before any call: at the stack's end trapped() itself may not run)
    if (e instanceof Error) C = RES = U32 = null;
    return trapped(c, e);
  }
}

// ---- the context: mpmath's PythonMPContext, its mpf type's arithmetic native

// The hybrid number (design §4.6): an mpf whose mantissa is 2^53 or more keeps
// it JS-side, as packed limbs ($m: a plain array of 2n 32-bit words, n u64
// limbs, little-endian, the top limb nonzero; ordinary heap, no ArrayBuffer)
// with $s, $e and $b (sign, exponent and bc, exact numbers); its `_mpf_` tuple
// of Python ints is made from them the first time Python reads it, and kept
// (so x._mpf_ is x._mpf_).  The core holds no number between calls: each call
// copies its operands' limbs in and its result's limbs out (a fresh array,
// never a view of the core's memory).

// A copy of n limbs made in the JS heap, admitted before anything is made
// (design §4.5): the limb limit, then its peak, `per` bytes a limb, against
// this session's heap by the shared admission (heap.ts admitHeap, as an int's
// conversion to text is: the free heap for a large one).  The peaks: a copy-out's words
// (2n numbers, 16n, in an array grown by push, whose store may reach half as
// much again: 24n); an int's limbs (wordsOf: its hex text, 16n, and the
// words, whose elements may be held as small ints, 8n, before numbers, 16n:
// 40n); an int made from limbs (manOf: the digits as bytes, 16n, their text,
// 16n, and the int, 8n: 40n).  The loops test for Stop.
function admit(n: number, per: number) {
  if (n > MAX_LIMBS) limit(n);
  admitHeap(per * n, `Converting a number of ${n * 64} bits`);
}

// (an int below 2^4096, 64 limbs, goes to words by shifts, without the text,
// and words up to 32 (1024 bits) to an int: faster there than the text, and
// slower past it; those copies are at most a few KB, which no admission
// refuses, so they have none)
const SMALL = 1n << 4096n, SMALL_WORDS = 32, MID = 1n << 65536n;

/** |x|'s limbs as 32-bit words (an even count) (exported for the tests) */
export function wordsOf(x: bigint): number[] {
  if (x < SMALL) {
    const w: number[] = [];
    for (; x > 0n; x >>= 64n) {
      const l = BigInt.asUintN(64, x);
      w.push(Number(l & 0xffffffffn), Number(l >> 32n));
    }
    return w;
  }
  // (below 2^65536, 1024 limbs, its text is at most 16 KB, made first as an
  // int's repr would be, its length the count; past it, the count first, by
  // the bits, and the copy admitted before the text is made)
  const mid = x < MID, h0 = mid ? x.toString(16) : "";
  const n = mid ? Math.ceil(h0.length / 16) : Math.ceil(O.bitLengthSmallCopies(x) / 64);
  admit(n, 40);
  const w: number[] = new Array(2 * n).fill(0), h = mid ? h0 : x.toString(16);
  for (let i = 0, j = h.length; j > 0; i++, j -= 8) {
    if ((i & 65535) === 65535) O.pollInterrupt();
    // (the word's hex digits, at most 8, from h's end: 0-9 are 48-57, a-f 97-102)
    let v = 0;
    for (let k = Math.max(0, j - 8); k < j; k++) {
      const c = h.charCodeAt(k);
      v = v * 16 + (c < 58 ? c - 48 : c - 87);
    }
    w[i] = v;
  }
  return w;
}

/** the int whose limbs are the words w (exported for the tests) */
export function manOf(w: ArrayLike<number>): bigint {
  const n = w.length;
  if (n <= SMALL_WORDS) {
    let x = 0n;
    for (let i = n - 1; i > 0; i -= 2) x = (x << 64n) | (BigInt(w[i]) << 32n) | BigInt(w[i - 1]);
    return x;
  }
  admit(n >> 1, 40);
  const b = new Uint8Array(8 * n + 3);
  b.set([48, 120, 48]);
  for (let i = n - 1, k = 3; i >= 0; i--, k += 8) {
    if ((i & 65535) === 0) O.pollInterrupt();
    for (let d = 7, v = w[i]; d >= 0; d--, v >>>= 4) b[k + d] = HEX.charCodeAt(v & 15);
  }
  return BigInt(new TextDecoder().decode(b));
}
const HEX = "0123456789abcdef";

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
      try {
        if (a !== undefined && b !== undefined) {
          // (the packed operands' limbs into the IO buffer: a's, then b's)
          const an = a ? 0 : self.$m.length >> 1, bn = b ? 0 : other.$m.length >> 1;
          if (an + bn > 0) {
            const q = ioAt(c, an + bn);
            if (!a) U32!.set(self.$m, q);
            if (!b) U32!.set(other.$m, q + 2 * an);
          }
          const x = a ?? [self.$s, 0, self.$e, self.$b], y = b ?? [other.$s, 0, other.$e, other.$b];
          k = c.mp_bin(op, prec, rnd, x[0], x[1], x[2], x[3], an, y[0], y[1], y[2], y[3], bn);
          if (k < 0) fail(c, k, hook);
        }
        const o = new Ctor(), r = res(c);
        if (k === 0) o[key] = Obj.tuple([r[0], r[1], r[2], r[3]]);
        else if (k === 1 && r[4] === 0) {
          // (the result's limbs copied out: a fresh array)
          const n = r[1], q = ioAt(c, n), w: number[] = [];
          admit(n, 24);
          for (let i = 0; i < 2 * n; i++) {
            if ((i & 65535) === 65535) O.pollInterrupt();
            w.push(U32![q + i]);
          }
          o.$m = w;
          o.$s = r[0];
          o.$e = r[2];
          o.$b = r[3];
        }
        // (else an exponent past 2^53, an operand's or the result's: mpmath's own method, which makes the
        // same libmp call through the hook)
        else return Obj.callObj(slow, [self, other]);
        return o;
      } catch (e) {
        if (e instanceof Error) C = RES = U32 = null;
        return trapped(c, e);
      }
    };
    Obj.setattr(cls, name, Obj.pyfn(f, name));
  });
}

// ---- the module

const SIGS: Record<string, { args: string[]; required: number; nd: number; kw: boolean; qual: string; sig: Obj.Signature }> = {};
HOOKS.forEach((name, i) => {
  const c = SIG.slice(3 * i, 3 * i + 3), args = NAMES[parseInt(c[0], 16)].split(" "), nd = +c[1], kw = c[2] === "*";
  const qual = /^(mpf_mul|bitcount|trailing)$/.test(name) ? "python_" + name : /^(isqrt|sqrtrem)$/.test(name) ? name + "_python" : name;
  SIGS[name] = { args, required: args.length - nd, nd, kw, qual, sig: Obj.sig(args, { kwarg: kw ? "kwargs" : null }) };
});

/** a hook call's arguments checked as the reference's def checks them: too many positional ones, then the
 * missing (a keyword call comes bound by the signature, its **kwargs, if any, last) */
function arity(name: string, a: IArguments) {
  const s = SIGS[name], n = s.args.length;
  if (a.length > n && !(s.kw && a.length === n + 1 && a[n] instanceof Obj.PyDict)) Obj.tooManyPositional(s.qual, n, s.nd, a.length);
  for (let j = 0; j < s.required; j++) {
    if (a[j] === undefined) Obj.missingArgs(s.qual, "positional", s.args.filter((_, i) => i < s.required && a[i] === undefined));
  }
}

const mpcOk = (z: any) => (Array.isArray(z) && z.length === 2) || Obj.raise(Obj.T.TypeError, "an mpc value is a pair of mpf tuples");

newBuiltinModule("_sagebrush_mpcore", (m) => {
  const pair = (s: any, t: any) => (c: Core) => (setF(c, 0, s), setF(c, 1, t));
  // Each kind of hook's arguments, as the reference's signatures take them.  Each checks its call's arguments
  // first (arity), a call that returns before the core runs: a hook stays one frame deep, so where a deep
  // recursion runs out of stack doesn't move.
  const ARGS: Record<string, (name: string) => (...a: any[]) => any> = {
    // mpf_add (its _sub, mpf_sub's way in, makes it mpf_sub), mpf_sub, mpf_mul, mpf_div, mpf_pow
    b: (name) => function (s, t, prec, rnd = "d", sub) {
      arity(name, arguments);
      return call(sub !== undefined && O.truth(sub) ? "mpf_sub" : name, prec, rnd, pair(s, t));
    },
    // mpf_sqrt, mpf_exp, mpf_log, mpf_cos, mpf_sin
    u: (name) => function (x, prec, rnd = "d") {
      arity(name, arguments);
      return call(name, prec, rnd, (c) => setF(c, 0, x));
    },
    // _normalize, _normalize1
    n: (name) => function (sign, man, exp, bc, prec, rnd) {
      arity(name, arguments);
      return call(name, prec, rnd, (c) => setF(c, 0, [sign, man, exp, bc]));
    },
    // from_man_exp
    m: (name) => function (man, exp, prec = null, rnd = "d") {
      arity(name, arguments);
      return call(name, prec, rnd, (c) => (setI(c, 0, man, "man"), setI(c, 1, exp, "exp")));
    },
    // mpc_exp, mpc_sqrt, mpc_abs
    c: (name) => function (z, prec, rnd = "d") {
      arity(name, arguments);
      return mpcOk(z), call(name, prec, rnd, pair(z[0], z[1]));
    },
    // mpc_mul, mpc_div
    w: (name) => function (z, w, prec, rnd = "d") {
      arity(name, arguments);
      return mpcOk(z), mpcOk(w), call(name, prec, rnd, (c) => (setF(c, 0, z[0]), setF(c, 1, z[1]), setF(c, 2, w[0]), setF(c, 3, w[1])));
    },
    // exp_fixed, cos_sin_fixed, log_int_fixed
    x: (name) => function (x, prec, extra = null) {
      arity(name, arguments);
      return call(name, prec, "n", (c) => (setI(c, 0, x, "x"), setI(c, 1, extra, name === "cos_sin_fixed" ? "pi2" : "ln2")));
    },
    // pi_fixed, ln2_fixed, e_fixed (constant_memo's g(prec, **kwargs): pi_fixed's verbose arguments change nothing returned)
    k: (name) => function (prec) {
      arity(name, arguments);
      return call(name, prec, "n", () => {});
    },
    // bitcount, trailing
    i: (name) => function (n) {
      arity(name, arguments);
      return call(name, 0, "n", (c) => setI(c, 0, n, "n"));
    },
    // isqrt, sqrtrem: a negative x is, in the python backend's int(x**0.5 ...), a complex, which int() refuses (its TypeError)
    q: (name) => function (x) {
      arity(name, arguments);
      const v = intOf(x);
      if (v !== null && v < 0n) Obj.callObj(Obj.T.int, [Obj.callObj(Obj.T.complex, [0])]);
      return call(name, 0, "n", (c) => setI(c, 0, x, "x"));
    },
    // ifac: a float n is its floor, and whether it was integral (ifac's memo decides the rest, abi.rs); a memo
    // of the caller's is read and grown as the reference does, by its own steps (its errors too)
    f: (name) => function (n, memo) {
      arity(name, arguments);
      if (memo !== undefined) {
        const f = Obj.callObj(Obj.getattr(memo, "get"), [n]);
        if (O.truth(f)) return f;
        let k = O.len(memo), p = O.getitem(memo, k - 1);
        for (; O.truth(O.le(k, n)); k++) {
          if ((k & 4095) === 0) O.pollInterrupt();
          p = O.mul(p, k);
          if (k <= 1000) O.setitem(memo, k, p);
        }
        return p;
      }
      return typeof n === "number" && !Number.isInteger(n)
        ? call(name, 0, "f", (c) => setI(c, 0, Math.floor(n), "n"))
        : call(name, 0, "n", (c) => setI(c, 0, n instanceof Obj.FloatBox ? n.v : n, "n"));
    },
    // mpf_gamma: the whole computation in the core where the reference takes the Taylor path; None elsewhere
    g: (name) => function (x, prec, rnd = "d", type = 0) {
      arity(name, arguments);
      return call(name, prec, rnd, (c) => (setF(c, 0, x), setI(c, 1, type, "type")));
    },
  };
  HOOKS.forEach((name, i) => (m[name] = Obj.builtin(ARGS[KINDS[i]](name), name, SIGS[name].sig)));
  // Dense linear algebra on real matrices, a whole operation a call (engine/mp's linalg.rs): the entries as a
  // list of raw mpfs, row-major, and n, its column count (lu_solve's A may have more rows: an overdetermined
  // system); None where the core is not asked (an exponent past 2^53)
  const MAT: Record<string, number> = { mat_lu: 31, mat_inverse: 32, mat_det: 33, mat_lu_solve: 34, mat_cholesky: 35, mat_cholesky_solve: 36 };
  for (const name of Object.keys(MAT)) {
    m[name] = Obj.builtin(function (a: any, ...rest: any[]) {
      const solve = name === "mat_lu_solve" || name === "mat_cholesky_solve", b = solve ? rest[0] : null, [n, prec, rnd = "n"] = solve ? rest.slice(1) : rest;
      const c = core(), p = precOf(prec), r = rndOf(rnd);
      try {
        if (!setM(c, 0, a) || (solve && !setM(c, 1, b))) return null;
        setI(c, solve ? 2 : 1, n, "n");
        const k = c.mp_run(MAT[name], p, r);
        if (k < 1) fail(c, k, name);
        if (name === "mat_det") return out(c, 0, name) ?? 0;
        return k === 1 ? out(c, 0, name) : Obj.tuple([out(c, 0, name), out(c, 1, name)]);
      } catch (e) {
        if (e instanceof Error) C = RES = U32 = null;
        return trapped(c, e);
      }
    }, name);
  }
  // The context's base class: mpmath's own PythonMPContext with its mpf
  // type's arithmetic native (installFast); made when the overlay's ctx_mp
  // asks, after libmp is whole, for the PythonMPContext of the mpmath being
  // imported: this module outlives a re-import of mpmath (its entries removed
  // from sys.modules), and a class made from an earlier import would run that
  // import's code, catching its exceptions, not the current one's.
  let made: [any, any] | null = null;
  m.__getattr__ = Obj.builtin((name: string) => {
    if (name !== "Context") return Obj.raise(Obj.T.AttributeError, `module '_sagebrush_mpcore' has no attribute '${name}'`);
    const Base = Obj.getattr(importModule("mpmath.ctx_mp_python"), "PythonMPContext");
    if (made !== null && made[0] === Base) return made[1];
    const init = Obj.getattr(Base, "__init__");
    const ns = new Obj.PyDict();
    Obj.dictSet(ns, "__module__", "_sagebrush_mpcore");
    Obj.dictSet(ns, "__init__", Obj.pyfn((ctx: any) => {
      Obj.callObj(init, [ctx]);
      installFast(ctx);
      return null;
    }, "__init__"));
    made = [Base, Obj.callObj(Obj.T.type, ["Context", Obj.tuple([Base]), ns])];
    return made[1];
  }, "__getattr__");
});
