// The core of sagebrush's numpy: n-dimensional arrays over JS typed arrays.
//
// An ndarray is a typed array plus shape, strides and offset (in elements),
// so slices, transposes and reshapes are views.  Element loops walk strides
// directly (with broadcasting), sums use NumPy's pairwise algorithm, type
// promotion follows NumPy 2 (Python scalars are "weak"), and printing
// follows NumPy's arrayprint rules, so results and output can be compared
// with NumPy itself.  The Python surface (keyword arguments, scalar types,
// most functions) is in lib/numpy, on top of the module _numpy defined here.
//
// Storage: bool -> Uint8Array; int8..int32, uint8..uint32, float32,
// float64 -> their typed arrays; int64 and uint64 -> Float64Array (exact up
// to 2^53: the one deliberate difference from NumPy); complex -> interleaved
// (re, im) Float64Array or Float32Array.

import * as Obj from "./object";
import * as O from "./ops";
import * as F from "./format";
import * as Ty from "./types";
import { PyComplex } from "./complex";
import { newBuiltinModule } from "./modules";
import { glibcLog, glibcExp, glibcExp2, glibcLog1p, EXP_TABLES, LOG_TABLES, glibcPow, glibcPowf } from "./libm";
import { gemmBuffers, wasmUnary, wasmSinCos, wasmSort, wasmArgsort } from "./kernels";
import * as FD from "./fdlibm";
import * as CR from "./crmath";

const { T, raise, tuple, typeName, NotImplemented } = Obj;

// ------------------------------------------------------------------ dtypes

type Kind = "b" | "i" | "u" | "f" | "c";
export class DType {
  constructor(
    public name: string,
    public kind: Kind,
    public itemsize: number,
    public char: string,
    public ctor: any,
    public rank: number, // order within its kind, for promotion
  ) {}
  get cplx() {
    return this.kind === "c";
  }
  get isInt() {
    return this.kind === "i" || this.kind === "u";
  }
}

const D: Record<string, DType> = Obj.table({});
const def = (name: string, kind: Kind, size: number, char: string, ctor: any, rank: number) => (D[name] = new DType(name, kind, size, char, ctor, rank));
def("bool", "b", 1, "?", Uint8Array, 0);
def("int8", "i", 1, "b", Int8Array, 1);
def("int16", "i", 2, "h", Int16Array, 2);
def("int32", "i", 4, "i", Int32Array, 3);
def("int64", "i", 8, "l", Float64Array, 4);
def("uint8", "u", 1, "B", Uint8Array, 1);
def("uint16", "u", 2, "H", Uint16Array, 2);
def("uint32", "u", 4, "I", Uint32Array, 3);
def("uint64", "u", 8, "L", Float64Array, 4);
def("float32", "f", 4, "f", Float32Array, 3);
def("float64", "f", 8, "d", Float64Array, 4);
def("complex64", "c", 8, "F", Float32Array, 3);
def("complex128", "c", 16, "D", Float64Array, 4);
// float16 is not implemented: NumPy stores and computes it in binary16,
// and float32 in its place gave other values (np.array([1.234],
// dtype=np.float16) was 1.2339999675750732, not 1.234375), so it is refused,
// as is any float ufunc NumPy computes in float16 (of bool, int8 and uint8).
function refuseF16(what: string): never {
  return raise(T.NotImplementedError, `${what}: float16 (half precision) is not supported yet`) as never;
}
// The float type NumPy gives a float ufunc of ints or bools: float16 for
// bool and 8-bit ints (refused), float32 for 16-bit, float64 above (true
// division: always float64)
function floatFor(op: string, dt: DType): DType {
  if (op === "true_divide") return D.float64;
  if (dt.kind === "b" || dt.itemsize === 1) refuseF16(`np.${op} of ${dt.name} (NumPy computes it in float16)`);
  return dt.itemsize === 2 ? D.float32 : D.float64;
}
// A binary float ufunc's loop, as NumPy's type resolver picks it: the
// smallest float type each input (but a Python scalar, which is weak) casts
// to safely, the wider of the two; not the float type of the inputs'
// promoted int type (int8 with uint8 promotes to int16, but its loop is
// float16; int16 with uint16 to int32, but its loop is float32). A Python
// int with a bool array is int64 (its kind is higher), so float64
function floatLoop(op: string, a: { arr: NDArray; weak: Weak | null }, b: { arr: NDArray; weak: Weak | null }, ct: DType): DType {
  if (op === "true_divide") return D.float64;
  let bits = 0;
  for (const x of [a, b]) {
    if (x.weak) {
      const other = x === a ? b : a;
      if (x.weak.kind !== "b" && !other.weak && other.arr.dt.kind === "b") bits = 64;
      continue;
    }
    const dt = x.arr.dt;
    if (dt.kind === "f" || dt.kind === "c") return ct;
    bits = Math.max(bits, dt.kind === "b" || dt.itemsize === 1 ? 16 : dt.itemsize === 2 ? 32 : 64);
  }
  if (bits === 0) return floatFor(op, ct);
  if (bits === 16) refuseF16(`np.${op} of ${a.weak ? "a Python scalar" : a.arr.dt.name} and ${b.weak ? "a Python scalar" : b.arr.dt.name} (NumPy computes it in float16)`);
  return bits === 32 ? D.float32 : D.float64;
}
const ALIASES: Record<string, string> = Obj.table({
  bool: "bool", bool_: "bool", "?": "bool", b1: "bool",
  int8: "int8", i1: "int8", byte: "int8", int16: "int16", i2: "int16", short: "int16", int32: "int32", i4: "int32", intc: "int32",
  int64: "int64", i8: "int64", int: "int64", int_: "int64", intp: "int64", long: "int64", longlong: "int64", l: "int64", q: "int64",
  uint8: "uint8", u1: "uint8", ubyte: "uint8", B: "uint8", uint16: "uint16", u2: "uint16", uint32: "uint32", u4: "uint32", uint: "uint64",
  uint64: "uint64", u8: "uint64", uintp: "uint64", float16: "float16", half: "float16", f2: "float16", e: "float16",
  float32: "float32", f4: "float32", single: "float32", f: "float32", float64: "float64", f8: "float64", float: "float64", double: "float64", d: "float64",
  float_: "float64", longdouble: "longdouble", float128: "longdouble", g: "longdouble", f16: "longdouble", clongdouble: "clongdouble",
  complex256: "clongdouble", G: "clongdouble", c32: "clongdouble", complex64: "complex64", c8: "complex64", F: "complex64", csingle: "complex64",
  complex128: "complex128", c16: "complex128", complex: "complex128", D: "complex128", cdouble: "complex128", complex_: "complex128",
});
const RANGE: Record<string, [number, number]> = Obj.table({
  int8: [-128, 127], int16: [-32768, 32767], int32: [-2147483648, 2147483647], uint8: [0, 255], uint16: [0, 65535], uint32: [0, 4294967295],
});

// Python type objects that name dtypes (float -> float64, np.float64 -> float64, ...).
const typeDtypes = new Map<any, DType>();

export function toDtype(x: any, dflt: DType | null = null): DType {
  if (x === null || x === undefined) {
    if (dflt) return dflt;
    return D.float64;
  }
  if (x instanceof DType) return x;
  if (x instanceof NDArray) return x.dt;
  if (typeof x === "string") {
    const s = x.replace(/^[<>=|]/, "");
    const n = ALIASES[s];
    if (n === "float16") refuseF16(`dtype '${x}'`);
    // (NumPy's longdouble is x87 extended precision, 80 bits: not float64)
    if (n === "longdouble" || n === "clongdouble") return raise(T.NotImplementedError, `dtype '${x}': ${n} (extended precision) is not supported yet`) as never;
    if (n) return D[n];
    raise(T.TypeError, `data type '${x}' not understood`);
  }
  const t = typeDtypes.get(x);
  if (t) return t;
  if (Obj.getattr(x, "__name__", null) === "float16" && Obj.getattr(x, "__module__", null) === "numpy") refuseF16("dtype np.float16");
  if (x === T.float) return D.float64;
  if (x === T.int) return D.int64;
  if (x === T.bool) return D.bool;
  if (x === T.complex) return D.complex128;
  const dt = Obj.getattr(x, "dtype", null);
  if (dt instanceof DType) return dt;
  return raise(T.TypeError, `Cannot interpret '${F.repr(x)}' as a data type`);
}

// The common type of two dtypes (np.result_type for arrays).
function promote(a: DType, b: DType): DType {
  if (a === b) return a;
  const order = { b: 0, i: 1, u: 1, f: 2, c: 3 } as Record<Kind, number>;
  if (order[a.kind] < order[b.kind]) [a, b] = [b, a];
  // now a is at least as "high" a kind as b
  if (a.kind === "c") {
    if (b.kind === "c") return a.rank >= b.rank ? a : b;
    if (b.kind === "f") return b.rank > a.rank ? D.complex128 : a;
    if (b.isInt) return b.itemsize >= 4 || a.rank >= 4 ? D.complex128 : a; // int8/16 + complex64 -> complex64
    return a;
  }
  if (a.kind === "f") {
    if (b.kind === "f") return a.rank >= b.rank ? a : b;
    if (b.isInt) return b.itemsize <= 2 && a === D.float32 ? D.float32 : D.float64;
    return a;
  }
  if (a.isInt && b.isInt) {
    if (a.kind === b.kind) return a.rank >= b.rank ? a : b;
    const [s, u] = a.kind === "i" ? [a, b] : [b, a];
    if (u.itemsize < s.itemsize) return s;
    if (u.itemsize === 8) return D.float64;
    return [D.int16, D.int32, D.int64][[1, 2, 4].indexOf(u.itemsize)] ?? D.int64;
  }
  return a; // int with bool
}

// A Python scalar's dtype and value, if x is one ("weak": it adapts to arrays).
// (big: a Python int's exact value, when it is a bigint)
type Weak = { kind: "b" | "i" | "f" | "c"; v: number; im?: number; dt: DType | null; inexact?: boolean; big?: bigint };
function pyScalar(x: any): Weak | null {
  if (typeof x === "boolean") return { kind: "b", v: +x, dt: null };
  if (typeof x === "number") return Number.isInteger(x) ? { kind: "i", v: x, dt: null } : { kind: "f", v: x, dt: null };
  if (typeof x === "bigint") {
    // (one past a double's range is Infinity: inexact, without converting
    // back; the range checks name it later)
    const n = Number(x);
    return { kind: "i", v: n, dt: null, inexact: !Number.isFinite(n) || BigInt(n) !== x, big: x };
  }
  if (x instanceof Obj.FloatBox) return { kind: "f", v: x.v, dt: null };
  if (x instanceof PyComplex) return { kind: "c", v: x.re, im: x.im, dt: typeDtypes.get(Obj.typeOf(x)) ?? null };
  if (x instanceof Obj.PrimBox) {
    const dt = typeDtypes.get(Obj.typeOf(x)) ?? null; // a NumPy scalar keeps its dtype
    const s = pyScalar(x.$v);
    // (an int64 or uint64 scalar holds its Python int exactly; one a double
    // does not hold enters no array, refused, never rounded)
    if (s && dt && isWide(dt) && s.inexact) wideRefuse(dt);
    if (s && dt) s.dt = dt;
    return s;
  }
  if (x !== null && typeof x === "object" && x.$npscalar !== undefined) {
    // np.bool_ / np.complex128 (not float/int subclasses)
    const s = pyScalar(x.$npscalar);
    if (s) s.dt = typeDtypes.get(Obj.typeOf(x)) ?? null;
    return s;
  }
  return null;
}

// NEP 50: a Python scalar takes the array's dtype when it fits its kind.
function weakType(arr: DType, w: Weak): DType {
  if (w.dt) return promote(arr, w.dt);
  switch (w.kind) {
    case "b":
      return arr;
    case "i":
      return arr.kind === "b" ? D.int64 : arr;
    case "f":
      return arr.kind === "f" || arr.kind === "c" ? arr : D.float64;
    case "c":
      return arr.kind === "c" ? arr : arr === D.float32 ? D.complex64 : D.complex128;
  }
}
const scalarDtype = (w: Weak): DType => w.dt ?? { b: D.bool, i: D.int64, f: D.float64, c: D.complex128 }[w.kind];

// ------------------------------------------------------------------ ndarray

export class NDArray {
  constructor(
    public dt: DType,
    public data: any,
    public shape: number[],
    public strides: number[],
    public offset = 0,
    public base: NDArray | null = null,
  ) {}
  // read-only (broadcast_to's views, and views of them; flags.writeable =
  // False): writes raise
  ro = false;
  // (a read-only array that can never be made writeable: frombuffer of
  // bytes, whose memory NumPy may not write; NumPy's base, the bytes)
  fixedRO = false;
  bufBase: any = null;
  // (flags.aligned set False: no effect here but the flag, as NumPy keeps it)
  unaligned = false;
  get size(): number {
    let n = 1;
    for (const s of this.shape) n *= s;
    return n;
  }
  get ndim(): number {
    return this.shape.length;
  }
  isC(): boolean {
    let want = 1;
    for (let d = this.shape.length - 1; d >= 0; d--) {
      if (this.shape[d] !== 1 && this.strides[d] !== want) return false;
      want *= this.shape[d];
    }
    return true;
  }
}

const cStrides = (shape: number[]): number[] => {
  const st = new Array(shape.length);
  let s = 1;
  for (let d = shape.length - 1; d >= 0; d--) {
    st[d] = s;
    s *= shape[d];
  }
  return st;
};
const prod = (a: number[]) => a.reduce((x, y) => x * y, 1);

// Every array's storage is admitted before it is allocated (empty, which
// every constructor uses; daybreak2's LIMIT-PR55-1): at most ARRAY_LIMITS.elements
// elements and ARRAY_LIMITS.bytes bytes, both inclusive, the bytes counting any
// scratch the caller reserves too. Counted exactly (BigInt), so no product
// overflows. Past intp it is NumPy's own ValueError, as NumPy refuses on any
// machine; past the caps, NumPy's MemoryError wording (_ArrayMemoryError).
// (one object, so a test can lower the caps to check the boundary cheaply)
export const ARRAY_LIMITS = { elements: 2 ** 32, bytes: 2 ** 32 };
export function admitArray(shape: readonly (number | bigint)[], dt: DType, scratch = 0): void {
  let n = 1n;
  for (const d of shape) n *= typeof d === "bigint" ? d : BigInt(d);
  const bytes = n * BigInt(dt.itemsize);
  if (bytes > 2n ** 63n - 1n) raise(T.ValueError, "array is too big; `arr.size * arr.dtype.itemsize` is larger than the maximum possible size.");
  if (n > BigInt(ARRAY_LIMITS.elements) || bytes + BigInt(scratch) > BigInt(ARRAY_LIMITS.bytes)) {
    const dims = shape.map((d) => String(typeof d === "bigint" ? d : BigInt(d)));
    raise(T.MemoryError, `Unable to allocate ${sizeString(bytes)} for an array with shape (${dims.join(", ")}${dims.length === 1 ? "," : ""}) and data type ${dt.name}`);
  }
}

// An operation's working memory: the outputs it makes and its scratch
// together (typed arrays, JS arrays of indices, WebAssembly buffers),
// admitted at its start, before any of them is allocated (daybreak2's
// LIMIT-PR55-3): at most ARRAY_LIMITS.bytes. `bytes` is computed from the
// operands' sizes, never less than what the operation allocates; an
// infinite or NaN estimate is refused too.
export function admitWork(bytes: number, what: string): void {
  if (bytes <= ARRAY_LIMITS.bytes) return;
  const need = Number.isFinite(bytes) ? sizeString(BigInt(Math.ceil(bytes))) : "an unbounded amount";
  raise(T.MemoryError, `${what} needs ${need} of working memory, more than Sagebrush's limit of ${sizeString(BigInt(ARRAY_LIMITS.bytes))}`);
}

// NumPy's _ArrayMemoryError._size_to_string: binary units, 3 significant
// digits (Python's "#.3g", which keeps a trailing point), whole bytes below 1 KiB
function sizeString(bytes: bigint): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let unit = Math.floor(Math.max(bytes.toString(2).length - 1, 1) / 10);
  let v = Number(bytes) / 2 ** (unit * 10);
  if (Math.round(v) === 1024) {
    unit += 1;
    v /= 1024;
  }
  if (unit >= units.length) {
    v *= 2 ** ((unit - (units.length - 1)) * 10);
    unit = units.length - 1;
  }
  if (unit === 0) return `${v.toFixed(0)} ${units[unit]}`;
  let t = Math.round(v) < 1000 ? v.toPrecision(3) : v.toFixed(0);
  if (!t.includes(".")) t += ".";
  return `${t} ${units[unit]}`;
}

export function empty(shape: number[], dt: DType): NDArray {
  admitArray(shape, dt);
  const n = prod(shape);
  return new NDArray(dt, new dt.ctor(dt.cplx ? 2 * n : n), shape.slice(), cStrides(shape));
}

// Store a JS number into an array of dtype dt (truncating and wrapping as C does).
// ------------------------------------------------------------------ int64 exactness
// Sagebrush's int64 and uint64 arrays hold doubles. A value they hold is an
// integer a double represents exactly (2**62 and -2**63 are; 2**53 + 1 is
// not). A result is kept only when it is exact: inside the safe range
// (|v| < 2**53) a correctly rounded add, subtract or multiply is; outside it,
// or from inputs outside it, the result is computed exactly (BigInt) and
// wrapped as NumPy wraps, then kept if a double holds the wrapped value
// exactly, else refused, never rounded (BigInt64 storage is the later
// numpy stream)
const isWide = (d: DType): boolean => d.isInt && d.ctor === Float64Array;
function wideRefuse(d: DType): never {
  return raise(T.NotImplementedError, `${d.name} values beyond 2**53 are not supported yet`);
}
const MASK64 = (1n << 64n) - 1n;
const bdiv = (a: bigint, b: bigint): bigint => {
  if (b === 0n) return 0n;
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
};
const BIG_OPS: Record<string, (a: bigint, b: bigint) => bigint> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  square: (a) => a * a,
  floor_divide: bdiv,
  remainder: (a, b) => (b === 0n ? 0n : a - bdiv(a, b) * b),
  bitwise_and: (a, b) => a & b,
  bitwise_or: (a, b) => a | b,
  bitwise_xor: (a, b) => a ^ b,
  left_shift: (a, b) => (b < 0n || b >= 64n ? 0n : a << b),
  right_shift: (a, b) => (b < 0n || b >= 64n ? (a < 0n ? -1n : 0n) : a >> b),
  maximum: (a, b) => (a > b ? a : b),
  minimum: (a, b) => (a < b ? a : b),
  // (modulo 2**64 as it goes: a huge exponent stays cheap)
  power: (a, b) => {
    let r = 1n, x = a & MASK64, e = b;
    while (e > 0n) {
      if (e & 1n) r = (r * x) & MASK64;
      x = (x * x) & MASK64;
      e >>= 1n;
    }
    return r;
  },
};
// (a 64-bit integer exactly as a double, or undefined)
function exact64(d: DType, b: bigint): number | undefined {
  const w = d.kind === "u" ? BigInt.asUintN(64, b) : BigInt.asIntN(64, b);
  const n = Number(w);
  return BigInt(n) === w ? n : undefined;
}
// r: op's result for x and y as computed in doubles
// (the one fast case: a signed add, subtract or multiply whose inputs and
// result are all safe integers, exact as correctly rounded; everything
// else, uint64 always, exactly in BigInt and certified)
const FAST_WIDE = new Set(["add", "subtract", "multiply"]);
function wideExact(d: DType, op: string, r: number, x: number, y: number): number {
  if (d.kind === "i" && FAST_WIDE.has(op) && Number.isSafeInteger(r) && Number.isSafeInteger(x) && Number.isSafeInteger(y)) return r;
  const g = BIG_OPS[op];
  if (g === undefined || !Number.isInteger(x) || !Number.isInteger(y)) return wideRefuse(d);
  return exact64(d, g(BigInt(x), BigInt(y))) ?? wideRefuse(d);
}
function allNonNeg(a: NDArray): boolean {
  let ok = true;
  loop1(a.shape, a.strides, a.offset, (p) => {
    if (a.data[p] < 0) ok = false;
  });
  return ok;
}
function allSafe(a: NDArray): boolean {
  const d = a.data;
  let ok = true;
  loop1(a.shape, a.strides, a.offset, (p) => {
    if (ok && !Number.isSafeInteger(d[p])) ok = false;
  });
  return ok;
}

function castNum(dt: DType, v: number): number {
  switch (dt.kind) {
    case "b":
      return v !== 0 ? 1 : 0;
    case "i":
    case "u":
      if (dt.ctor === Float64Array) {
        // (an int64 or uint64 store: an integer in its range (a float's
        // truncation is exact there); NaN, infinity or past the range
        // refused, where NumPy's cast is undefined; a negative uint64 the
        // wrapped value if a double holds it exactly)
        if (!Number.isFinite(v)) wideRefuse(dt);
        v = Math.trunc(v);
        if (dt.kind === "u") {
          if (v >= 18446744073709551616) wideRefuse(dt);
          return v >= 0 ? v + 0 : (exact64(dt, BigInt(v)) ?? wideRefuse(dt));
        }
        return v >= -9223372036854775808 && v < 9223372036854775808 ? v + 0 : wideRefuse(dt);
      }
      return Number.isFinite(v) ? Math.trunc(v) : dt.kind === "i" ? RANGE[dt.name][0] : 0;
    case "f":
      return dt.ctor === Float32Array ? Math.fround(v) : v;
    default:
      return v;
  }
}

// ------------------------------------------------------------------ strided loops

// Call f(physicalOffset, k) for every element in C order.
function loop1(shape: number[], st: number[], off: number, f: (p: number, k: number) => void) {
  const nd = shape.length;
  if (nd === 0) return f(off, 0);
  if (prod(shape) === 0) return;
  const last = nd - 1, L = shape[last], s = st[last];
  const idx = new Array(nd).fill(0);
  let base = off, k = 0;
  for (;;) {
    let p = base;
    for (let j = 0; j < L; j++, p += s) {
      f(p, k++);
      // (Stop, every 1024 elements)
      if ((k & 1023) === 0) O.pollInterrupt();
    }
    let d = nd - 2;
    for (; d >= 0; d--) {
      base += st[d];
      if (++idx[d] < shape[d]) break;
      base -= st[d] * shape[d];
      idx[d] = 0;
    }
    if (d < 0) return;
  }
}

function loop2(shape: number[], s1: number[], o1: number, s2: number[], o2: number, f: (p1: number, p2: number, k: number) => void) {
  const nd = shape.length;
  if (nd === 0) return f(o1, o2, 0);
  if (prod(shape) === 0) return;
  const last = nd - 1, L = shape[last], i1 = s1[last], i2 = s2[last];
  const idx = new Array(nd).fill(0);
  let b1 = o1, b2 = o2, k = 0;
  for (;;) {
    let p1 = b1, p2 = b2;
    for (let j = 0; j < L; j++, p1 += i1, p2 += i2) f(p1, p2, k++);
    let d = nd - 2;
    for (; d >= 0; d--) {
      b1 += s1[d];
      b2 += s2[d];
      if (++idx[d] < shape[d]) break;
      b1 -= s1[d] * shape[d];
      b2 -= s2[d] * shape[d];
      idx[d] = 0;
    }
    if (d < 0) return;
  }
}

function loop3(shape: number[], s1: number[], o1: number, s2: number[], o2: number, s3: number[], o3: number, f: (p1: number, p2: number, p3: number, k: number) => void) {
  const nd = shape.length;
  if (nd === 0) return f(o1, o2, o3, 0);
  if (prod(shape) === 0) return;
  const idx = new Array(nd).fill(0);
  let b1 = o1, b2 = o2, b3 = o3, k = 0;
  const last = nd - 1, L = shape[last];
  for (;;) {
    let p1 = b1, p2 = b2, p3 = b3;
    for (let j = 0; j < L; j++, p1 += s1[last], p2 += s2[last], p3 += s3[last]) f(p1, p2, p3, k++);
    let d = nd - 2;
    for (; d >= 0; d--) {
      b1 += s1[d];
      b2 += s2[d];
      b3 += s3[d];
      if (++idx[d] < shape[d]) break;
      b1 -= s1[d] * shape[d];
      b2 -= s2[d] * shape[d];
      b3 -= s3[d] * shape[d];
      idx[d] = 0;
    }
    if (d < 0) return;
  }
}

// Strides of `a` broadcast to `shape` (0 along stretched or new axes).
function bstrides(a: NDArray, shape: number[]): number[] {
  const nd = shape.length, k = nd - a.ndim;
  const out = new Array(nd).fill(0);
  for (let d = 0; d < a.ndim; d++) {
    const n = a.shape[d];
    if (n === shape[k + d]) out[k + d] = n === 1 ? 0 : a.strides[d];
    else if (n === 1) out[k + d] = 0;
    else raise(T.ValueError, `operands could not be broadcast together with shapes ${shapeStr(a.shape)} ${shapeStr(shape)} `);
  }
  return out;
}
function broadcastShapes(...shapes: number[][]): number[] {
  const nd = Math.max(0, ...shapes.map((s) => s.length));
  const out = new Array(nd).fill(1);
  for (const s of shapes) {
    for (let d = 0; d < s.length; d++) {
      const j = nd - s.length + d, n = s[d];
      if (n === 1) continue;
      if (out[j] === 1) out[j] = n;
      else if (out[j] !== n) raise(T.ValueError, `operands could not be broadcast together with shapes ${shapes.map(shapeStr).join(" ")} `);
    }
  }
  return out;
}
const shapeStr = (s: number[]) => (s.length === 1 ? `(${s[0]},)` : `(${s.join(",")})`);

// A contiguous copy in C order (or `a` itself when it already is one).
export function ascontig(a: NDArray): NDArray {
  if (a.isC() && a.offset === 0 && a.data.length === (a.dt.cplx ? 2 : 1) * a.size) return a;
  return copy(a);
}
export function copy(a: NDArray, dt: DType = a.dt): NDArray {
  const out = empty(a.shape, dt);
  assign(out, a);
  return out;
}

// A view of a keeps a's read-only flag.
const viewOf = (v: NDArray, a: NDArray): NDArray => ((v.ro = a.ro), v);
// (frombuffer's array as NumPy's: of bytes, read-only for good, its base
// the bytes; of a writeable buffer (lib/numpy passes a bytearray as a
// memoryview, NumPy's base), writeable.  It is a copy here, aligned, where
// NumPy's shares the buffer's memory.  At module level, so the limit-sites
// census keeps attributing the lines after frombuffer to their own function)
function fromBytes(a: NDArray, buffer: any): NDArray {
  a.bufBase = buffer;
  // (writeable only over writeable memory: a bytearray, or a memoryview
  // that isn't read-only)
  const ro = buffer instanceof Obj.PyByteArray ? false : buffer instanceof Obj.PyBytes ? true : O.truth(Obj.getattr(buffer, "readonly"));
  if (ro) {
    a.ro = true;
    a.fixedRO = true;
  }
  return a;
}
function writable(a: NDArray) {
  if (a.ro) raise(T.ValueError, "assignment destination is read-only");
}
// (a ufunc's out=, and an in-place operator's target, in NumPy's words)
function outWritable(a: NDArray) {
  if (a.ro) raise(T.ValueError, "output array is read-only");
}

// ------------------------------------------------------------------ flags
// ndarray.flags, NumPy's flagsobj: the contiguity, ownership and
// writeability of an array, read live (a flags object follows its array),
// and writeable, aligned and writebackifcopy set as NumPy's rules allow
const cContig = (a: NDArray) => a.size === 0 || a.isC();
function fContig(a: NDArray): boolean {
  if (a.size === 0) return true;
  let want = 1;
  for (let d = 0; d < a.shape.length; d++) {
    if (a.shape[d] !== 1 && a.strides[d] !== want) return false;
    want *= a.shape[d];
  }
  return true;
}
const ownsData = (a: NDArray) => a.base === null && a.bufBase === null;
// (NumPy's NPY_ARRAY_* bits)
const F_C = 0x1, F_F = 0x2, F_OWN = 0x4, F_ALIGNED = 0x100, F_WRITE = 0x400;
function flagsNum(a: NDArray): number {
  return (cContig(a) ? F_C : 0) | (fContig(a) ? F_F : 0) | (ownsData(a) ? F_OWN : 0) | (a.unaligned ? 0 : F_ALIGNED) | (a.ro ? 0 : F_WRITE);
}
// writeable = True only where the memory may be written: not frombuffer's
// bytes, and not a view of a read-only array (NumPy's check of the base);
// broadcast_to's views may be made writeable, as in NumPy
function setWriteable(a: NDArray, v: boolean) {
  if (!v) {
    a.ro = true;
    return;
  }
  if (a.fixedRO || (a.base !== null && a.base.ro)) raise(T.ValueError, "cannot set WRITEABLE flag to True of this array");
  a.ro = false;
}
// (NumPy's flagsobj is a snapshot: its flags are the array's when it was
// made; setting a flag through it changes the array, not the snapshot)
export class FlagsObj {
  num: number;
  constructor(public a: NDArray) {
    this.num = flagsNum(a);
  }
}

// out[...] = src (an array, broadcast to out's shape), casting as needed.
function assign(out: NDArray, src: NDArray) {
  writable(out);
  // overlapping storage (a[1:] = a[:-1], a[:] = a[::-1]): read from a copy
  if (src.data.buffer === out.data.buffer) src = copy(src);
  const sb = bstrides(src, out.shape);
  const od = out.data, sd = src.data;
  if (out.dt.cplx) {
    if (src.dt.cplx) loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => ((od[2 * p] = sd[2 * q]), (od[2 * p + 1] = sd[2 * q + 1])));
    else loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => ((od[2 * p] = sd[q]), (od[2 * p + 1] = 0)));
    return;
  }
  const dt = out.dt;
  if (src.dt.cplx) {
    loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => (od[p] = castNum(dt, sd[2 * q])));
  } else if (isWide(dt) && isWide(src.dt) && src.dt !== dt) {
    // (int64 <-> uint64: NumPy's wrap, certified)
    loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => (od[p] = exact64(dt, BigInt(sd[q])) ?? wideRefuse(dt)));
  } else if (dt.kind === "f" || dt.ctor !== Float64Array && dt.kind !== "b" && src.dt.isInt) {
    loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => (od[p] = sd[q]));
  } else {
    loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => (od[p] = castNum(dt, sd[q])));
  }
}

// ------------------------------------------------------------------ from Python values

let scalarCtors: Record<string, any> = Obj.table({}); // dtype name -> NumPy scalar type (registered by lib/numpy)

function isSeq(x: any): boolean {
  return Array.isArray(x) || (x !== null && typeof x === "object" && typeName(x) === "range");
}
function seqItems(x: any): any[] {
  return Array.isArray(x) ? x : O.toArray(x);
}

// Shape and dtype of nested Python data. (shapeOnly: a dtype was given, so
// an element is converted once, by fill, through that dtype's protocol
// alone, as NumPy's: no other numeric protocol called here first, astra
// CORR-76A-1)
function discover(x: any, depth: number, shape: number[] & { leaf?: number }, kinds: { dt: DType | null }, shapeOnly = false) {
  if (x instanceof NDArray) {
    const s = x.shape;
    for (let i = 0; i < s.length; i++) setDim(shape, depth + i, s[i]);
    kinds.dt = kinds.dt ? promote(kinds.dt, x.dt) : x.dt;
    return;
  }
  if (isSeq(x)) {
    const items = seqItems(x);
    setDim(shape, depth, items.length);
    for (const it of items) discover(it, depth + 1, shape, kinds, shapeOnly);
    if (items.length === 0 && shape.length === depth + 1) return;
    return;
  }
  if (shape.length > depth) inhomogeneous(depth);
  shape.leaf ??= depth;
  if (shape.leaf !== depth) inhomogeneous(Math.min(depth, shape.leaf));
  if (shapeOnly && typeof x !== "string") return;
  const w = pyScalar(x);
  if (w === null) {
    if (typeof x === "string") raise(T.NotImplementedError, "string arrays are not supported by sagebrush's numpy yet");
    const f = Ty.floatCallSafe(x);
    if (f === undefined) raise(T.TypeError, `float() argument must be a string or a real number, not '${typeName(x)}'`);
    kinds.dt = kinds.dt ? promote(kinds.dt, D.float64) : D.float64;
    return;
  }
  const dt = scalarDtype(w);
  kinds.dt = kinds.dt ? promoteScalar(kinds.dt, dt, w) : dt;
}
// Python scalars inside a list promote as values (an int and a float give float64).
function promoteScalar(a: DType, b: DType, w: Weak): DType {
  if (w.dt === null && a.kind !== "b" && b === D.int64 && a.isInt) return a.itemsize >= 8 ? a : D.int64;
  return promote(a, b);
}
function setDim(shape: number[] & { leaf?: number }, d: number, n: number) {
  if (shape.length === d) shape.push(n);
  else if (shape.length < d) inhomogeneous(d);
  else if (shape[d] !== n) inhomogeneous(d);
  if (shape.leaf !== undefined && d >= shape.leaf) inhomogeneous(shape.leaf);
}
function inhomogeneous(d: number): never {
  return raise(T.ValueError, `setting an array element with a sequence. The requested array has an inhomogeneous shape after ${d} dimensions. The detected shape was ${"(...)"} + inhomogeneous part.`);
}

// Write nested Python data into a fresh array.
function fill(out: NDArray, x: any) {
  const d = out.data, cplx = out.dt.cplx, dt = out.dt;
  let k = 0;
  const put = (v: any) => {
    if (v instanceof NDArray) {
      const c = copy(v, dt);
      const w = cplx ? 2 : 1;
      d.set(c.data.subarray(0, c.size * w), k * w);
      k += c.size;
      return;
    }
    if (isSeq(v)) {
      for (const it of seqItems(v)) put(it);
      return;
    }
    if (cplx) {
      const c = toC(v);
      d[2 * k] = c[0];
      d[2 * k + 1] = c[1];
    } else d[k] = castNum(dt, toNum(v, dt));
    k++;
  };
  put(x);
}

// NumPy 2: a Python int that does not fit the array's integer type is an error.
// (first, as NumPy 2's: one no C long holds, OverflowError "Python int too
// large to convert to C long" (uint64 takes its own range); then the
// dtype's range; with int64 or uint64, one a double holds exactly:
// Sagebrush's are doubles. A comparison takes any int, exactly: bigCompare)
const I64MIN = -(2n ** 63n), I64MAX = 2n ** 63n - 1n, U64MAX = 2n ** 64n - 1n;
function checkWeak(dt: DType, w: Weak) {
  checkWeakRange(dt, w);
  if (isWide(dt) && w.inexact) wideRefuse(dt);
}
function checkWeakRange(dt: DType, w: Weak) {
  if (w.big !== undefined && (dt.kind === "u" && dt.itemsize === 8 ? w.big < I64MIN || w.big > U64MAX : w.big < I64MIN || w.big > I64MAX)) raise(T.OverflowError, "Python int too large to convert to C long");
  checkPyInt(dt, w.v);
}
const MINMAX_OPS: Record<string, boolean> = { maximum: true, minimum: true, fmax: true, fmin: true };
function bigMinMax(op: string, ct: DType, arr: NDArray, big: bigint): NDArray {
  const max = op === "maximum" || op === "fmax";
  const res = empty(arr.shape, ct), od = res.data, d = arr.data;
  loop1(arr.shape, arr.strides, arr.offset, (p, k) => {
    const x = d[p];
    if (max ? BigInt(x) >= big : BigInt(x) <= big) od[k] = x;
    else wideRefuse(ct);
  });
  return res;
}
const CMP_OPS: Record<string, (a: bigint, b: bigint) => boolean> = {
  equal: (a, b) => a === b, not_equal: (a, b) => a !== b, less: (a, b) => a < b,
  less_equal: (a, b) => a <= b, greater: (a, b) => a > b, greater_equal: (a, b) => a >= b,
};
// (an integer array compared with a Python int a double does not hold
// exactly, or past int64: element by element, exactly, as NumPy 2)
function bigCompare(op: string, A: { arr: NDArray; weak: Weak | null }, B: { arr: NDArray; weak: Weak | null }): NDArray {
  const left = A.weak === null, arr = left ? A.arr : B.arr, big = (left ? B.weak : A.weak)!.big!;
  const f = CMP_OPS[op];
  const res = empty(arr.shape, D.bool), od = res.data, d = arr.data;
  loop1(arr.shape, arr.strides, arr.offset, (p, k) => {
    const x = BigInt(d[p]);
    od[k] = +(left ? f(x, big) : f(big, x));
  });
  return res;
}
function checkPyInt(dt: DType, v: number) {
  const rg = RANGE[dt.name];
  if (rg && (v < rg[0] || v > rg[1])) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
  if (dt.kind === "u" && v < 0) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
}

// The one admission of a Python value into int64 or uint64 storage
// (creation, assignment, full, NumPy scalars): the ORIGINAL value checked:
// an integer (an __index__ or __int__ object's integer, before any float)
// within the dtype (NumPy's OverflowError) and one a double holds exactly
// (else refused); a float through castNum (finite, truncated, in range)
function admitWide(v: any, dt: DType): number {
  if (typeof v === "boolean") return +v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) return castNum(dt, v);
    if (dt.kind === "u" && v < 0) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
    return v + 0;
  }
  if (typeof v === "bigint") {
    const lo = dt.kind === "u" ? 0n : -(2n ** 63n), hi = dt.kind === "u" ? 2n ** 64n - 1n : 2n ** 63n - 1n;
    if (v < lo || v > hi) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
    const n = Number(v);
    return BigInt(n) === v ? n : wideRefuse(dt);
  }
  if (v instanceof Obj.FloatBox) return castNum(dt, v.v);
  // (an int subclass by its own __int__ if it overrides int's, as NumPy
  // converts it; a NumPy scalar or another subclass by its value)
  const t = Obj.typeOf(v);
  const ownInt = Obj.lookupType(t, "__int__");
  if (Obj.isinstance(v, T.int) && ownInt !== undefined && ownInt !== T.int.$dict.get("__int__")) return admitWide(Ty.intCall(v), dt);
  const u = Obj.unbox(v);
  if (u !== v) return admitWide(u, dt);
  if (v !== null && typeof v === "object" && v.$npscalar !== undefined) return admitWide(v.$npscalar, dt);
  if (v instanceof PyComplex) raise(T.TypeError, "can't convert complex to float");
  // (another object as NumPy converts it: __int__, then __index__; one
  // with neither refused, its __float__ never called)
  if (ownInt !== undefined || Obj.lookupType(t, "__index__") !== undefined) return admitWide(Ty.intCall(v), dt);
  return raise(T.TypeError, `int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`);
}
function toNum(v: any, dt?: DType): number {
  if (dt && isWide(dt)) return admitWide(v, dt);
  if (typeof v === "number") {
    if (dt && dt.isInt && Number.isInteger(v)) checkPyInt(dt, v);
    return v;
  }
  if (typeof v === "boolean") return +v;
  if (typeof v === "bigint") {
    if (dt && dt.isInt && dt.itemsize === 8 && (v > 18446744073709551615n || v < -9223372036854775808n)) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
    // (into int64 or uint64 only if a double holds it exactly)
    if (dt && isWide(dt) && BigInt(Number(v)) !== v) wideRefuse(dt);
    return Number(v);
  }
  const u = Obj.unbox(v);
  if (u !== v) return toNum(u, dt);
  if (v instanceof Obj.FloatBox) return v.v;
  if (v !== null && typeof v === "object" && v.$npscalar !== undefined) return toNum(v.$npscalar, dt);
  if (v instanceof PyComplex) raise(T.TypeError, "can't convert complex to float");
  const f = Ty.floatCallSafe(v);
  if (f === undefined) return raise(T.TypeError, `float() argument must be a string or a real number, not '${typeName(v)}'`);
  return f;
}
function toC(v: any): [number, number] {
  if (v instanceof PyComplex) return [v.re, v.im];
  if (v !== null && typeof v === "object" && v.$npscalar instanceof PyComplex) return [v.$npscalar.re, v.$npscalar.im];
  return [toNum(v), 0];
}

export function asarray(x: any, dtype: any = null): NDArray {
  if (x instanceof NDArray) return dtype === null || toDtype(dtype) === x.dt ? x : copy(x, toDtype(dtype));
  return fromPy(x, dtype);
}
export function fromPy(x: any, dtype: any = null): NDArray {
  const shape: number[] & { leaf?: number } = [];
  const kinds = { dt: null as DType | null };
  const given = dtype !== null && dtype !== undefined;
  discover(x, 0, shape, kinds, given);
  const dt = given ? toDtype(dtype) : (kinds.dt ?? D.float64);
  const out = empty(shape, dt);
  fill(out, x);
  return out;
}

// ------------------------------------------------------------------ elements -> Python

function pyScalarOf(dt: DType, data: any, p: number): any {
  const ctor = scalarCtors[dt.name];
  // NumPy's float and int scalar types box the value like any float/int
  // subclass instance: construct them directly (much cheaper than a call)
  if (ctor !== undefined && !dt.cplx && ctor.$ctor !== undefined) {
    const o = new ctor.$ctor();
    const x = data[p];
    o.$v = dt.kind === "f" ? O.mkfloat(x) : dt.kind === "b" ? (x !== 0 ? 1 : 0) : intOf(x);
    return o;
  }
  let v: any;
  if (dt.cplx) v = new PyComplex(data[2 * p], data[2 * p + 1]);
  else if (dt.kind === "b") v = data[p] !== 0;
  else if (dt.kind === "f") v = O.mkfloat(data[p]);
  else v = intOf(data[p]);
  return ctor ? Obj.callObj(ctor, [v]) : v;
}
const intOf = (x: number) => (Number.isSafeInteger(x) ? x : O.normBig(BigInt(x)));
function pyPlain(dt: DType, data: any, p: number): any {
  if (dt.cplx) return new PyComplex(data[2 * p], data[2 * p + 1]);
  if (dt.kind === "b") return data[p] !== 0;
  if (dt.kind === "f") return O.mkfloat(data[p]);
  return intOf(data[p]);
}

export function tolist(a: NDArray): any {
  if (a.ndim === 0) return pyPlain(a.dt, a.data, a.offset);
  const rec = (d: number, off: number): any[] => {
    const out = new Array(a.shape[d]);
    for (let i = 0; i < a.shape[d]; i++) out[i] = d === a.ndim - 1 ? pyPlain(a.dt, a.data, off + i * a.strides[d]) : rec(d + 1, off + i * a.strides[d]);
    return out;
  };
  return rec(0, a.offset);
}

// ------------------------------------------------------------------ indexing

function normAxis(ax: number, nd: number): number {
  const a = ax < 0 ? ax + nd : ax;
  if (a < 0 || a >= nd || !Number.isInteger(a)) raise(T.AxisError ?? T.IndexError, `axis ${ax} is out of bounds for array of dimension ${nd}`);
  return a;
}

type IndexResult = { view: NDArray } | { shape: number[]; offsets: number[] };

function isIntLike(k: any): boolean {
  if (typeof k === "number") return Number.isInteger(k);
  if (typeof k === "bigint") return true;
  if (k instanceof Obj.PrimBox) return isIntLike(k.$v);
  return false;
}

// An integer argument (a shape, an axis, an index) as a JS number.  A float
// is refused, as NumPy refuses it: an integral one is a FloatBox, which
// Number() would make NaN.
function intNum(x: any): number {
  const v = Obj.unbox(x);
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return +v;
  if (v !== null && typeof v === "object" && v.$npscalar !== undefined && v.$npscalar !== v) return intNum(v.$npscalar);
  return raise(T.TypeError, `'${typeName(x)}' object cannot be interpreted as an integer`);
}

function resolveIndex(a: NDArray, key: any): IndexResult {
  let items: any[] = Array.isArray(key) && (key as any).$t ? key.slice() : [key];
  // Ellipsis expands to the axes the other entries do not consume
  const consumes = (k: any) => (k === null || k === Obj.Ellipsis ? 0 : k instanceof NDArray && k.dt.kind === "b" ? Math.max(k.ndim, 1) : 1);
  const used = items.reduce((s, k) => s + consumes(k), 0);
  const ei = items.indexOf(Obj.Ellipsis);
  if (ei >= 0) {
    if (items.indexOf(Obj.Ellipsis, ei + 1) >= 0) raise(T.IndexError, "an index can only have a single ellipsis ('...')");
    items.splice(ei, 1, ...new Array(Math.max(0, a.ndim - used)).fill(new O.PySlice(null, null, null)));
  }
  if (items.reduce((s, k) => s + consumes(k), 0) > a.ndim) {
    raise(T.IndexError, `too many indices for array: array is ${a.ndim}-dimensional, but ${items.reduce((s, k) => s + consumes(k), 0)} were indexed`);
  }
  // advanced indices: arrays and lists of ints or bools
  items = items.map((k) => (Array.isArray(k) && !(k as any).$t ? fromPy(k) : k));
  items = items.map((k) => (Array.isArray(k) && (k as any).$t ? fromPy(k) : k));
  const hasAdv = items.some((k) => k instanceof NDArray);
  if (!hasAdv) {
    const shape: number[] = [], strides: number[] = [];
    let off = a.offset, d = 0;
    for (const k of items) {
      if (k === null) {
        shape.push(1);
        strides.push(0);
      } else if (k instanceof O.PySlice) {
        const [start, step, n] = O.sliceIndices(k, a.shape[d]);
        off += start * a.strides[d];
        shape.push(n);
        strides.push(a.strides[d] * step);
        d++;
      } else {
        const i = intIndex(k, a.shape[d], d);
        off += i * a.strides[d];
        d++;
      }
    }
    for (; d < a.ndim; d++) {
      shape.push(a.shape[d]);
      strides.push(a.strides[d]);
    }
    return { view: viewOf(new NDArray(a.dt, a.data, shape, strides, off, a.base ?? a), a) };
  }
  // Advanced indexing: integer scalars count as advanced too.  The
  // broadcast index shape goes where the advanced indices are, if they are
  // next to each other, else first.
  type Ent = { axis: number; kind: "slice" | "adv" | "new"; n?: number; stride?: number; start?: number; step?: number; idx?: NDArray };
  const ents: Ent[] = [];
  let d = 0;
  for (const k of items) {
    if (k === null) ents.push({ axis: -1, kind: "new" });
    else if (k instanceof O.PySlice) {
      const [start, step, n] = O.sliceIndices(k, a.shape[d]);
      ents.push({ axis: d, kind: "slice", n, start, step });
      d++;
    } else if (k instanceof NDArray && k.dt.kind === "b") {
      // a boolean mask over k.ndim axes: its nonzero() positions
      for (let j = 0; j < k.ndim; j++) if (k.shape[j] !== a.shape[d + j]) raise(T.IndexError, `boolean index did not match indexed array along axis ${d + j}; size of axis is ${a.shape[d + j]} but size of corresponding boolean axis is ${k.shape[j]}`);
      const nz = nonzero(k);
      for (let j = 0; j < Math.max(1, k.ndim); j++) ents.push({ axis: d + j, kind: "adv", idx: nz[j] ?? nz[0] });
      d += Math.max(1, k.ndim);
    } else if (k instanceof NDArray) {
      if (!k.dt.isInt) raise(T.IndexError, "arrays used as indices must be of integer (or boolean) type");
      ents.push({ axis: d, kind: "adv", idx: k });
      d++;
    } else {
      ents.push({ axis: d, kind: "adv", idx: fromPy(intIndex(k, a.shape[d], d)) });
      d++;
    }
  }
  for (; d < a.ndim; d++) ents.push({ axis: d, kind: "slice", n: a.shape[d], start: 0, step: 1 });
  const adv = ents.filter((e) => e.kind === "adv");
  const bshape = broadcastShapes(...adv.map((e) => e.idx!.shape));
  const bsize = prod(bshape);
  // (the index arrays, the output's offsets (a JS array) and the output
  // itself, admitted together first; LIMIT-PR55-3)
  const basicN = prod(ents.filter((e) => e.kind !== "adv").map((e) => (e.kind === "slice" ? e.n! : 1)));
  admitWork(8 * adv.length * bsize + bsize * basicN * (8 + a.dt.itemsize), "indexing");
  const idxs = adv.map((e) => {
    const s = bstrides(e.idx!, bshape);
    const out = new Array(bsize);
    const n = a.shape[e.axis];
    loop1(bshape, s, e.idx!.offset, (p, k) => {
      let v = e.idx!.data[p];
      if (v < 0) v += n;
      if (v < 0 || v >= n) raise(T.IndexError, `index ${e.idx!.data[p]} is out of bounds for axis ${e.axis} with size ${n}`);
      out[k] = v * a.strides[e.axis];
    });
    return out;
  });
  const advPos = ents.map((e, i) => (e.kind === "adv" ? i : -1)).filter((i) => i >= 0);
  const adjacent = advPos.every((p, i) => i === 0 || p === advPos[i - 1] + 1);
  // output axes: basic entries in order, with the broadcast block inserted
  type Ax = { kind: "basic"; ent: Ent } | { kind: "block" };
  const axes: Ax[] = [];
  let placed = false;
  ents.forEach((e, i) => {
    if (e.kind === "adv") {
      if (adjacent && !placed) {
        axes.push({ kind: "block" });
        placed = true;
      }
      return;
    }
    axes.push({ kind: "basic", ent: e });
  });
  if (!placed) axes.unshift({ kind: "block" });
  const shape: number[] = [];
  for (const ax of axes) {
    if (ax.kind === "block") shape.push(...bshape);
    else shape.push(ax.ent.kind === "new" ? 1 : ax.ent.n!);
  }
  const offsets = new Array(prod(shape));
  let k = 0;
  const walk = (i: number, off: number, bpos: number) => {
    if (i === axes.length) {
      let o = off;
      for (const ix of idxs) o += ix[bpos];
      offsets[k++] = o;
      return;
    }
    const ax = axes[i];
    if (ax.kind === "block") {
      for (let b = 0; b < bsize; b++) walk(i + 1, off, b);
      return;
    }
    const e = ax.ent;
    if (e.kind === "new") return walk(i + 1, off, bpos);
    const st = a.strides[e.axis];
    for (let j = 0; j < e.n!; j++) walk(i + 1, off + (e.start! + j * e.step!) * st, bpos);
  };
  walk(0, a.offset, 0);
  return { shape, offsets };
}

function intIndex(k: any, n: number, axis: number): number {
  if (typeof k === "boolean") raise(T.IndexError, "boolean scalar indices are not supported");
  if (!isIntLike(k)) {
    const f = Ty.lookupDunder(k, "__index__");
    if (f === undefined) raise(T.IndexError, "only integers, slices (`:`), ellipsis (`...`), numpy.newaxis (`None`) and integer or boolean arrays are valid indices");
    k = f(k);
  }
  let i = intNum(k);
  if (i < 0) i += n;
  if (i < 0 || i >= n) raise(T.IndexError, `index ${intNum(k)} is out of bounds for axis ${axis} with size ${n}`);
  return i;
}

function getitem(a: NDArray, key: any): any {
  // a[i] on a 1-D array
  if (typeof key === "number" && a.ndim === 1 && Number.isInteger(key)) {
    const n = a.shape[0];
    const i = key < 0 ? key + n : key;
    if (i >= 0 && i < n) return pyScalarOf(a.dt, a.data, a.offset + i * a.strides[0]);
  }
  // a[mask] with a boolean mask of a's shape
  if (key instanceof NDArray && key.dt.kind === "b" && key.ndim === a.ndim && key.shape.every((v, i) => v === a.shape[i]) && !a.dt.cplx) {
    const ad = a.data, kd = key.data;
    if (a.isC() && key.isC()) {
      const n = a.size, ao = a.offset, ko = key.offset;
      let cnt = 0;
      for (let i = 0; i < n; i++) if (kd[ko + i]) cnt++;
      const res = empty([cnt], a.dt), rd = res.data;
      for (let i = 0, j = 0; i < n; i++) if (kd[ko + i]) rd[j++] = ad[ao + i];
      return res;
    }
    const vals: number[] = [];
    loop2(a.shape, a.strides, a.offset, key.strides, key.offset, (p, q) => {
      if (kd[q]) vals.push(ad[p]);
    });
    const res = empty([vals.length], a.dt);
    res.data.set(vals);
    return res;
  }
  const r = resolveIndex(a, key);
  if ("view" in r) {
    const v = r.view;
    return v.ndim === 0 ? pyScalarOf(v.dt, v.data, v.offset) : v;
  }
  const out = empty(r.shape, a.dt);
  const od = out.data, ad = a.data;
  if (a.dt.cplx) r.offsets.forEach((p, k) => ((od[2 * k] = ad[2 * p]), (od[2 * k + 1] = ad[2 * p + 1])));
  else r.offsets.forEach((p, k) => (od[k] = ad[p]));
  return out;
}

function setitem(a: NDArray, key: any, value: any) {
  writable(a);
  const r = resolveIndex(a, key);
  // (a Python value into int64/uint64 through the admission, its original)
  const src = value instanceof NDArray ? value : isWide(a.dt) ? fromPy(value, a.dt) : operand(value).arr;
  if ("view" in r) return assign(r.view, src);
  const tmp = empty(r.shape, a.dt);
  assign(tmp, src);
  const ad = a.data, td = tmp.data;
  if (a.dt.cplx) r.offsets.forEach((p, k) => ((ad[2 * p] = td[2 * k]), (ad[2 * p + 1] = td[2 * k + 1])));
  else r.offsets.forEach((p, k) => (ad[p] = td[k]));
}

// ------------------------------------------------------------------ shape operations

function reshape(a: NDArray, shape: number[]): NDArray {
  const n = a.size;
  const neg = shape.indexOf(-1);
  if (neg >= 0) {
    const rest = prod(shape.filter((_, i) => i !== neg));
    if (rest === 0 || n % rest !== 0) raise(T.ValueError, `cannot reshape array of size ${n} into shape ${shapeStr(shape)}`);
    shape = shape.slice();
    shape[neg] = n / rest;
  }
  if (prod(shape) !== n) raise(T.ValueError, `cannot reshape array of size ${n} into shape ${shapeStr(shape)}`);
  const c = a.isC() ? a : copy(a);
  return viewOf(new NDArray(c.dt, c.data, shape, cStrides(shape), c.offset, c === a ? (a.base ?? a) : null), c);
}
function transpose(a: NDArray, axes: number[] | null): NDArray {
  const ax = axes ?? a.shape.map((_, i) => a.ndim - 1 - i);
  if (ax.length !== a.ndim) raise(T.ValueError, "axes don't match array");
  const norm = ax.map((x) => normAxis(x, a.ndim));
  if (new Set(norm).size !== norm.length) raise(T.ValueError, "repeated axis in transpose");
  return viewOf(new NDArray(a.dt, a.data, norm.map((i) => a.shape[i]), norm.map((i) => a.strides[i]), a.offset, a.base ?? a), a);
}

// ------------------------------------------------------------------ elementwise operations

type Bin = (x: number, y: number) => number;
type CBin = (ar: number, ai: number, br: number, bi: number) => [number, number];

// Python-semantics floor division and modulo for floats (as NumPy's
// npy_divmod).  (C's `if (mod)` is true for a nan, which JS's is not: the
// tests are `!== 0`, so an infinite or nan operand gives nan, not 0.)
function fdivmod(a: number, b: number): [number, number] {
  if (b === 0) return [a / b, NaN];
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0) {
    if (b < 0 !== mod < 0) {
      mod += b;
      div -= 1;
    }
  } else mod = b < 0 ? -0 : 0;
  let floordiv: number;
  if (div !== 0) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else {
    const q = a / b; // (its sign: copysign(0, a / b), -0.0 included)
    floordiv = q < 0 || Object.is(q, -0) ? -0 : 0;
  }
  return [floordiv, mod];
}

const BIN: Record<string, { f: Bin; c?: CBin; out?: "bool" | "float"; int?: Bin; noBool?: boolean }> = Obj.table({
  add: { f: (x, y) => x + y, c: (a, b, c, d) => [a + c, b + d] },
  subtract: { f: (x, y) => x - y, c: (a, b, c, d) => [a - c, b - d], noBool: true },
  multiply: { f: (x, y) => x * y, c: (a, b, c, d) => [a * c - b * d, a * d + b * c] },
  true_divide: { f: (x, y) => x / y, out: "float", c: cdiv },
  floor_divide: { f: (x, y) => fdivmod(x, y)[0], int: (x, y) => (y === 0 ? 0 : Math.floor(x / y)) },
  remainder: { f: (x, y) => fdivmod(x, y)[1], int: (x, y) => (y === 0 ? 0 : x - Math.floor(x / y) * y) },
  power: { f: glibcPow, c: cpow, int: ipow },
  maximum: { f: (x, y) => (x !== x || y !== y ? NaN : Math.max(x, y)) },
  minimum: { f: (x, y) => (x !== x || y !== y ? NaN : Math.min(x, y)) },
  fmax: { f: (x, y) => (x !== x ? y : y !== y ? x : Math.max(x, y)) },
  fmin: { f: (x, y) => (x !== x ? y : y !== y ? x : Math.min(x, y)) },
  arctan2: { f: CR.atan2, out: "float" },
  hypot: { f: CR.hypot, out: "float" },
  copysign: { f: (x, y) => withSign(x, signBit(y)), out: "float" },
  logaddexp: { f: (x, y) => { const m = Math.max(x, y); return m === -Infinity ? m : m + glibcLog1p(glibcExp(-Math.abs(x - y))); }, out: "float" },
  equal: { f: (x, y) => +(x === y), out: "bool", c: (a, b, c, d) => [+(a === c && b === d), 0] },
  not_equal: { f: (x, y) => +(x !== y), out: "bool", c: (a, b, c, d) => [+(a !== c || b !== d), 0] },
  less: { f: (x, y) => +(x < y), out: "bool" },
  less_equal: { f: (x, y) => +(x <= y), out: "bool" },
  greater: { f: (x, y) => +(x > y), out: "bool" },
  greater_equal: { f: (x, y) => +(x >= y), out: "bool" },
  logical_and: { f: (x, y) => +(x !== 0 && y !== 0), out: "bool" },
  logical_or: { f: (x, y) => +(x !== 0 || y !== 0), out: "bool" },
  logical_xor: { f: (x, y) => +((x !== 0) !== (y !== 0)), out: "bool" },
  bitwise_and: { f: (x, y) => Number(BigInt.asIntN(64, BigInt(x) & BigInt(y))) },
  bitwise_or: { f: (x, y) => Number(BigInt.asIntN(64, BigInt(x) | BigInt(y))) },
  bitwise_xor: { f: (x, y) => Number(BigInt.asIntN(64, BigInt(x) ^ BigInt(y))) },
  left_shift: { f: (x, y) => x * 2 ** y },
  right_shift: { f: (x, y) => Math.floor(x / 2 ** y) },
});
// (a + b i) / (c + d i) as NumPy's complex divide loop (umath/loops.c.src)
// and npy_cpow's cdiv: Smith's algorithm, multiplying by the reciprocal of
// the denominator (scl), not dividing by it, which rounds differently (an
// ulp in about 43% of results); a zero divisor gives a / |c|, b / |d|
function cdiv(a: number, b: number, c: number, d: number): [number, number] {
  const ac = Math.abs(c), ad = Math.abs(d);
  if (ac >= ad) {
    if (ac === 0 && ad === 0) return [a / ac, b / ad];
    const rat = d / c, scl = 1 / (c + d * rat);
    return [(a + b * rat) * scl, (b - a * rat) * scl];
  }
  const rat = c / d, scl = 1 / (d + c * rat);
  return [(a * rat + b) * scl, (b * rat - a) * scl];
}
// NumPy's cmul: the product as written, no fused multiply-add
const cmul = (ar: number, ai: number, br: number, bi: number): [number, number] => [ar * br - ai * bi, ar * bi + ai * br];
// a ** b as NumPy's npy_cpow (npymath/npy_math_complex.c.src): 0 ** b is 0
// for b with a positive real part, else NaN; an integer exponent below 100
// in magnitude by its unrolled 1, 2 and 3 (which keep infinities and signed
// zeros: no product with 1 + 0j), else binary powering from 1 with cmul,
// and Smith's cdiv for a negative one
function cpow(a: number, b: number, c: number, d: number): [number, number] {
  if (c === 0 && d === 0) return [1, 0];
  if (a === 0 && b === 0) return c > 0 ? [0, 0] : [NaN, NaN];
  if (d === 0 && Number.isInteger(c) && c > -100 && c < 100) {
    if (c === 1) return [a, b];
    if (c === 2) return cmul(a, b, a, b);
    if (c === 3) {
      const [sr, si] = cmul(a, b, a, b);
      return cmul(a, b, sr, si);
    }
    let n = Math.abs(c), mask = 1, rr = 1, ri = 0, pr = a, pi = b;
    for (;;) {
      if (n & mask) [rr, ri] = cmul(rr, ri, pr, pi);
      mask <<= 1;
      if (n < mask) break;
      [pr, pi] = cmul(pr, pi, pr, pi);
    }
    return c < 0 ? cdiv(1, 0, rr, ri) : [rr, ri];
  }
  // (other exponents: NumPy calls the C library's cpow, glibc's on Linux,
  // which is not ported here; this agrees with it but for the last bit or
  // so of some results)
  const logr = glibcLog(FD.v8hypot(a, b)), th = FD.atan2(b, a);
  const mr = glibcExp(c * logr - d * th), ang = d * logr + c * th;
  return [mr * FD.cos(ang), mr * FD.sin(ang)];
}
// 1 / z as NumPy's complex reciprocal loop (umath/loops.c.src), which is
// not cdiv(1, z): the larger part's ratio, and 1 / d and -r / d
// a ** o and a **= o as NumPy's array_power (multiarray/number.c,
// fast_scalar_power): an exact Python int 2 is the square ufunc (an array of
// any dtype), an exact int -1 reciprocal and an exact float 0.5 sqrt (float
// and complex arrays), not power; their complex results differ from
// power's in the last bits, and their warnings name them
function fastScalarPower(a: NDArray, o: any): string | null {
  const t = Obj.typeOf(o);
  if (t === T.int) {
    const v = Obj.unbox(o);
    if (v == 2) return "square";
    if (v == -1 && (a.dt.kind === "f" || a.dt.cplx)) return "reciprocal";
  } else if (t === T.float && Obj.unbox(o) === 0.5 && (a.dt.kind === "f" || a.dt.cplx)) return "sqrt";
  return null;
}
function crecip(a: number, b: number): [number, number] {
  if (Math.abs(b) <= Math.abs(a)) {
    const r = b / a, d = a + b * r;
    return [1 / d, -r / d];
  }
  const r = a / b, d = a * r + b;
  return [r / d, -1 / d];
}
function ipow(x: number, y: number): number {
  if (y < 0) raise(T.ValueError, "Integers to negative integer powers are not allowed.");
  let r = 1;
  while (y > 0) {
    if (y & 1) r *= x;
    x *= x;
    y = Math.floor(y / 2);
  }
  return r;
}

function operand(x: any): { arr: NDArray; weak: Weak | null } {
  if (x instanceof NDArray) return { arr: x, weak: null };
  const w = pyScalar(x);
  if (w !== null) {
    const a = empty([], w.dt ?? scalarDtype(w));
    if (a.dt.cplx) {
      a.data[0] = w.v;
      a.data[1] = w.im ?? 0;
    } else if (w.dt === null && w.kind === "i" && isWide(a.dt) && (w.inexact || w.v >= 9223372036854775808 || w.v < -9223372036854775808)) {
      // (a Python int no int64 holds exactly: its double here, an operand;
      // checkWeak refuses it, or its range check names it, in an operation)
      a.data[0] = w.v;
    } else a.data[0] = castNum(a.dt, w.v);
    return { arr: a, weak: w.dt ? null : w };
  }
  return { arr: fromPy(x), weak: null };
}

function resultType(a: { arr: NDArray; weak: Weak | null }, b: { arr: NDArray; weak: Weak | null }): DType {
  if (a.weak && b.weak) return promote(scalarDtype(a.weak), scalarDtype(b.weak));
  if (a.weak) return weakType(b.arr.dt, a.weak);
  if (b.weak) return weakType(a.arr.dt, b.weak);
  return promote(a.arr.dt, b.arr.dt);
}

// Tight loops for the common operations on contiguous data (V8 compiles
// these monomorphic loops far better than a per-element callback):
// kind "aa" (two arrays of one shape), "as" (array, scalar), "sa".
const FAST_EXPR: Record<string, (x: string, y: string) => string> = {
  add: (x, y) => `${x} + ${y}`, subtract: (x, y) => `${x} - ${y}`, multiply: (x, y) => `${x} * ${y}`, true_divide: (x, y) => `${x} / ${y}`,
  equal: (x, y) => `+(${x} === ${y})`, not_equal: (x, y) => `+(${x} !== ${y})`, less: (x, y) => `+(${x} < ${y})`,
  less_equal: (x, y) => `+(${x} <= ${y})`, greater: (x, y) => `+(${x} > ${y})`, greater_equal: (x, y) => `+(${x} >= ${y})`,
  maximum: (x, y) => `(${x} !== ${x} || ${y} !== ${y} ? NaN : ${x} > ${y} ? ${x} : ${y})`,
  minimum: (x, y) => `(${x} !== ${x} || ${y} !== ${y} ? NaN : ${x} < ${y} ? ${x} : ${y})`,
  power: (x, y) => `POW(${x}, ${y})`,
  // (the power of one exponent for the whole loop, as NumPy's: powerExponent)
  "power -1": (x) => `1 / ${x}`,
  "power 0": () => "1",
  "power 0.5": (x) => `Math.sqrt(${x})`,
  "power 1": (x) => x,
  "power 2": (x) => `${x} * ${x}`,
  // (float32: glibc's powf, as NumPy's float32 loop calls it)
  "power float32": (x, y) => `POW(${x}, ${y})`,
};
const POW_ONE: Record<string, (x: number, y: number) => number> = {
  "power -1": (x) => 1 / x,
  "power 0": () => 1,
  "power 0.5": Math.sqrt,
  "power 1": (x) => x,
  "power 2": (x) => x * x,
  "power float32": (x, y) => powf32(x, y),
};
// NumPy's float power loop, given one exponent for the whole loop (a scalar,
// or an array of one element), computes 1 / x, 1, sqrt(x), x and x * x for
// the exponents -1, 0, 0.5, 1 and 2, not pow(x, y), whose last bit differs
// from those for -1, 0.5 and 2 (about one element in 1,000): the kernel's
// name for them, else "power" (float32: "power float32", glibc's powf, which
// NumPy's float32 loop calls, not pow rounded to float)
function powerExponent(ct: DType, b: NDArray): string {
  const general = ct === D.float32 ? "power float32" : "power";
  if ((ct !== D.float64 && ct !== D.float32) || b.size !== 1) return general;
  // (the exponent as the loop's type holds it: a float32 loop's is the
  // float32 nearest, so 0.500000001 is 0.5 there, as NumPy casts it first)
  const e = ct === D.float32 ? Math.fround(Number(b.data[b.offset])) : Number(b.data[b.offset]);
  return e === -1 || e === 0 || e === 0.5 || e === 1 || e === 2 ? `power ${e}` : general;
}
// x^y of float32 operands (a Python float exponent is cast to float32 first,
// as NumPy casts it to the loop's type), as glibc's powf
const powf32 = (x: number, y: number): number => glibcPowf(Math.fround(x), Math.fround(y));
const kernels = new Map<string, any>();
function fastKernel(op: string, kind: string): any {
  const key = op + kind;
  let k = kernels.get(key);
  if (k === undefined) {
    if (!Object.hasOwn(FAST_EXPR, op)) throw new Error(`no fast kernel for ${op}`); // generated code: only the table's own entries
    const e = FAST_EXPR[op];
    const x = kind === "sa" ? "av" : "ad[ao + i]", y = kind === "as" ? "bv" : "bd[bo + i]";
    k = new Function("POW", "ad", "ao", "av", "bd", "bo", "bv", "od", "n", `for (let i = 0; i < n; i++) od[i] = ${e(x, y)};`).bind(null, op === "power float32" ? powf32 : glibcPow);
    kernels.set(key, k);
  }
  return k;
}
const isFlat = (a: NDArray) => a.isC();

// The same operations over arbitrary strides (broadcasting, transposes):
// an odometer over the outer axes around a tight inner loop.
const strided = new Map<string, any>();
function stridedKernel(op: string): any {
  let k = strided.get(op);
  if (k === undefined) {
    if (!Object.hasOwn(FAST_EXPR, op)) throw new Error(`no fast kernel for ${op}`);
    k = new Function("POW", "ad", "ao", "as", "bd", "bo", "bs", "od", "shape", `
      const nd = shape.length, last = nd - 1, L = shape[last], ia = as[last], ib = bs[last];
      const idx = new Array(nd).fill(0);
      let pa = ao, pb = bo, o = 0;
      for (;;) {
        let x = pa, y = pb;
        for (let i = 0; i < L; i++, x += ia, y += ib) od[o++] = ${FAST_EXPR[op]("ad[x]", "bd[y]")};
        let d = nd - 2;
        for (; d >= 0; d--) {
          pa += as[d]; pb += bs[d];
          if (++idx[d] < shape[d]) break;
          pa -= as[d] * shape[d]; pb -= bs[d] * shape[d]; idx[d] = 0;
        }
        if (d < 0) return;
      }`).bind(null, op === "power float32" ? powf32 : glibcPow);
    strided.set(op, k);
  }
  return k;
}

// With tryOut, the result goes into out only if it has exactly out's dtype
// and shape (out C-contiguous from its start and sharing no memory with the
// operands unless it is one of them, laid out alike): else undefined, before
// anything is computed.
export function binary(op: string, x: any, y: any, out: NDArray | null = null, tryOut = false): any {
  const spec = BIN[op];
  if (out) outWritable(out);
  const A = operand(x), B = operand(y);
  let ct = resultType(A, B); // type the computation runs in
  if (spec.noBool && ct.kind === "b") raise(T.TypeError, `numpy boolean ${op}, the \`-\` operator, is not supported, use the bitwise_xor, the \`^\` operator, or the logical_xor function instead.`);
  if (op.startsWith("bitwise") || op.endsWith("_shift")) {
    if (ct.kind === "f" || ct.kind === "c") raise(T.TypeError, `ufunc '${op}' not supported for the input types, and the inputs could not be safely coerced to any supported types according to the casting rule ''safe''`);
  }
  // (a Python int past what a double or int64 holds, against an integer
  // array: compared exactly; in arithmetic with a float, NumPy's error)
  if (CMP_OPS[op] && !out) {
    const w = A.weak ?? B.weak, o = A.weak ? B : A;
    if (w && w.kind === "i" && w.big !== undefined && o.weak === null && (o.arr.dt.isInt || o.arr.dt.kind === "b") && (w.inexact || w.big < I64MIN || w.big > I64MAX)) return bigCompare(op, A, B);
  }
  // (minimum and maximum of an integer array and a Python int a double does
  // not hold: compared exactly, the int refused only where it is chosen, so
  // np.clip(a, 0, 2**63 - 1) of a uint64 array keeps its elements)
  if (MINMAX_OPS[op] && !out && ct.isInt) {
    const w = A.weak ?? B.weak, o = A.weak ? B : A;
    if (w && w.kind === "i" && w.inexact && w.big !== undefined && o.weak === null && (o.arr.dt.isInt || o.arr.dt.kind === "b")) {
      checkWeakRange(ct, w);
      return bigMinMax(op, ct, o.arr, w.big);
    }
  }
  for (const w of [A.weak, B.weak]) if (w && w.kind === "i" && w.big !== undefined && !Number.isFinite(w.v) && ct.kind === "f") raise(T.OverflowError, "int too large to convert to float");
  for (const w of [A.weak, B.weak]) if (w && w.kind === "i" && ct.isInt) checkWeak(ct, w);
  if (spec.out === "float" && (ct.kind === "b" || ct.isInt)) ct = floatLoop(op, A, B, ct);
  if (op === "power" && ct.kind === "b") ct = D.int8;
  const rt = spec.out === "bool" ? D.bool : ct;
  const a = A.arr, b = B.arr;
  const kop = op === "power" ? powerExponent(ct, b) : op; // the kernel
  const shape = broadcastShapes(a.shape, b.shape);
  if (tryOut && (rt !== out!.dt || out!.offset !== 0 || !out!.isC() || shape.length !== out!.ndim || shape.some((v, i) => v !== out!.shape[i]))) return undefined;
  // fast paths: real dtypes whose arithmetic needs no wrapping or truncation
  const plain = (d: DType) => d.kind === "f" || d.kind === "b" || (d.isInt && d.ctor !== Float64Array) || d === D.int64;
  // (an int64 result in place only through the checked loop below: a fast
  // kernel's result is checked after, and redone there if it left the safe
  // range, which needs the operands intact)
  const wide = isWide(rt) && spec.out === undefined;
  if ((!out || tryOut) && !(wide && (out || rt.kind !== "i" || (op !== "add" && op !== "subtract"))) && !ct.cplx && FAST_EXPR[kop] && plain(ct) && plain(rt) && !(op === "power" && ct.isInt) && !(ct === D.int64 && op === "multiply")
      && (rt.kind !== "b" || spec.out === "bool") && !(rt.kind === "b" && spec.out !== "bool")) {
    const n = prod(shape);
    const aScalar = a.ndim === 0, bScalar = b.ndim === 0;
    const sameShape = a.ndim === b.ndim && a.shape.every((v, i) => v === b.shape[i]);
    if ((sameShape && isFlat(a) && isFlat(b)) || (aScalar && isFlat(b) && b.ndim > 0) || (bScalar && isFlat(a) && a.ndim > 0)) {
      const res = out ?? empty(shape, rt);
      const kind = aScalar && !bScalar ? "sa" : bScalar && !aScalar ? "as" : "aa";
      const av = aScalar ? a.data[a.offset] : 0, bv = bScalar ? b.data[b.offset] : 0;
      // operands of different storage types (int8 + float64 ...) read fine as numbers
      fastKernel(kop, kind)(a.data, a.offset, av, b.data, b.offset, bv, res.data, n);
      if (!wide || (allSafe(res) && allSafe(a) && allSafe(b))) return res;
    } else if (shape.length >= 1 && n > 0) {
      const res = out ?? empty(shape, rt);
      stridedKernel(kop)(a.data, a.offset, bstrides(a, shape), b.data, b.offset, bstrides(b, shape), res.data, shape);
      if (!wide || (allSafe(res) && allSafe(a) && allSafe(b))) return res;
    }
  }
  const res = out ?? empty(shape, rt);
  const sa = bstrides(a, shape), sb = bstrides(b, shape);
  const ad = a.data, bd = b.data, od = res.data, ost = res.strides, oo = res.offset;
  const contigOut = res.isC() && oo === 0;
  if (ct.cplx) {
    const fc = spec.c;
    if (!fc) return raise(T.TypeError, `ufunc '${op}' not supported for complex input`);
    const ac = a.dt.cplx, bc = b.dt.cplx;
    loop2(shape, sa, a.offset, sb, b.offset, (p, q, k) => {
      const r = fc(ac ? ad[2 * p] : ad[p], ac ? ad[2 * p + 1] : 0, bc ? bd[2 * q] : bd[q], bc ? bd[2 * q + 1] : 0);
      if (rt.cplx) {
        od[2 * k] = r[0];
        od[2 * k + 1] = r[1];
      } else od[k] = r[0];
    });
    return res;
  }
  const f0 = kop !== op ? POW_ONE[kop] : ct.isInt || ct.kind === "b" ? (spec.int ?? spec.f) : spec.f;
  const f = wide ? (x: number, y: number) => wideExact(rt, op, f0(x, y), x, y) : f0;
  const store = rt.kind === "f" || (rt.isInt && rt.ctor !== Float64Array) ? null : rt;
  if (contigOut) {
    if (store === null) loop2(shape, sa, a.offset, sb, b.offset, (p, q, k) => (od[k] = f(ad[p], bd[q])));
    else loop2(shape, sa, a.offset, sb, b.offset, (p, q, k) => (od[k] = castNum(store, f(ad[p], bd[q]))));
  } else {
    const tmp = empty(shape, rt);
    const td = tmp.data;
    loop2(shape, sa, a.offset, sb, b.offset, (p, q, k) => (td[k] = store ? castNum(store, f(ad[p], bd[q])) : f(ad[p], bd[q])));
    assign(res, tmp);
  }
  return res;
}

// The sign bit itself, a NaN's too, as C's signbit and copysign read and
// set it, and so NumPy's (x < 0 and Object.is(x, -0) say nothing of a NaN)
const SIGN_F = new Float64Array(1), SIGN_W = new Uint32Array(SIGN_F.buffer);
// Whether this engine keeps a NaN's sign in a JavaScript value: V8 (Node,
// Deno, browsers but Safari) does; JavaScriptCore (Bun, Safari) makes every
// NaN the positive canonical one, so no NaN read from an array, or computed,
// has a sign there, and signbit and copysign of a NaN are refused, not
// answered from a sign that was lost.
const NAN_SIGN_KEPT = (() => {
  const f = new Float64Array(2), w = new Uint32Array(f.buffer);
  w[1] = 0xfff80000;
  f[1] = f[0];
  return w[3] === 0xfff80000;
})();
function nanSignLost(): never {
  return raise(T.NotImplementedError, "signbit and copysign of a NaN: this JavaScript engine (JavaScriptCore, as in Bun) does not keep NaN signs") as never;
}
function signBit(x: number): number {
  if (x !== x && !NAN_SIGN_KEPT) nanSignLost();
  SIGN_F[0] = x;
  return SIGN_W[1] >>> 31;
}
function withSign(x: number, negative: number): number {
  if (x !== x && !NAN_SIGN_KEPT) nanSignLost();
  SIGN_F[0] = x;
  SIGN_W[1] = (SIGN_W[1] & 0x7fffffff) | (negative << 31);
  return SIGN_F[0];
}

type Un = (x: number) => number;
type CUn = (re: number, im: number) => [number, number];
const UN: Record<string, { f: Un; c?: CUn; float?: boolean; keepInt?: boolean; out?: "bool" }> = Obj.table({
  negative: { f: (x) => -x, c: (a, b) => [-a, -b], keepInt: true },
  positive: { f: (x) => x, c: (a, b) => [a, b], keepInt: true },
  absolute: { f: Math.abs, keepInt: true },
  sign: { f: (x) => (x !== x ? NaN : x > 0 ? 1 : x < 0 ? -1 : 0), keepInt: true },
  // (complex: NumPy's loop as written, a a - b b and a b + b a; on hardware
  // with fused multiply-add NumPy's SIMD loop fuses them, in the last bit)
  square: { f: (x) => x * x, c: (a, b) => [a * a - b * b, a * b + b * a], keepInt: true },
  sqrt: { f: Math.sqrt, c: csqrt, float: true },
  cbrt: { f: FD.cbrt, float: true },
  // (a real argument keeps its zero imaginary part: exp(inf+0j) = inf+0j)
  exp: { f: glibcExp, c: cexp, float: true },
  // (as math.exp2: glibc's, not JavaScript's 2 ** x)
  exp2: { f: glibcExp2, float: true },
  expm1: { f: FD.expm1, float: true },
  log: { f: glibcLog, c: clog, float: true },
  log2: { f: CR.log2, float: true },
  log10: { f: FD.log10, float: true },
  log1p: { f: glibcLog1p, float: true },
  sin: { f: CR.sin, c: (a, b) => (b === 0 ? [CR.sin(a), Number.isFinite(a) ? CR.cos(a) * b : b] : [hmul(CR.sin(a), b, "cosh"), hmul(CR.cos(a), b, "sinh")]), float: true },
  cos: { f: CR.cos, c: (a, b) => (b === 0 ? [CR.cos(a), Number.isFinite(a) ? -CR.sin(a) * b : -b] : [hmul(CR.cos(a), b, "cosh"), -hmul(CR.sin(a), b, "sinh")]), float: true },
  tan: { f: CR.tan, float: true },
  arcsin: { f: CR.asin, float: true },
  arccos: { f: CR.acos, float: true },
  arctan: { f: CR.atan, float: true },
  sinh: { f: FD.sinh, float: true },
  cosh: { f: FD.cosh, float: true },
  tanh: { f: FD.tanh, float: true },
  arcsinh: { f: CR.asinh, float: true },
  arccosh: { f: CR.acosh, float: true },
  arctanh: { f: CR.atanh, float: true },
  deg2rad: { f: (x) => (x * Math.PI) / 180, float: true },
  rad2deg: { f: (x) => (x * 180) / Math.PI, float: true },
  floor: { f: Math.floor, keepInt: true },
  ceil: { f: Math.ceil, keepInt: true },
  trunc: { f: Math.trunc, keepInt: true },
  rint: { f: roundHalfEven, float: true }, // (of ints: float16, float32 or float64, as NumPy's)
  fabs: { f: Math.abs, float: true },
  reciprocal: { f: (x) => 1 / x, c: crecip, keepInt: true },
  isnan: { f: (x) => +(x !== x), out: "bool", c: (a, b) => [+(a !== a || b !== b), 0] },
  isinf: { f: (x) => +(x === Infinity || x === -Infinity), out: "bool" },
  isfinite: { f: (x) => +Number.isFinite(x), out: "bool", c: (a, b) => [+(Number.isFinite(a) && Number.isFinite(b)), 0] },
  signbit: { f: signBit, out: "bool" },
  logical_not: { f: (x) => +(x === 0), out: "bool", c: (a, b) => [+(a === 0 && b === 0), 0] },
  invert: { f: (x) => -x - 1, keepInt: true },
});
// Complex exp, log, sin and cos without spurious overflow, cancellation or
// NaN (the systematic review's R2-NUM-F3: log(1.3e308+1.3e308j) and
// exp(710+pi/4 j) were inf, log(1+1e-8j).real 0, sin(711j) NaN+inf j).
// c * cosh(y) or c * sinh(y): through e^(|y|/2) when cosh(y) would overflow,
// and an exact zero c stays zero (signed) instead of 0 * inf = NaN.
function hmul(c: number, y: number, f: "cosh" | "sinh"): number {
  if (c === 0 && Number.isFinite(y)) return f === "sinh" && y < 0 ? -c : c;
  const ay = Math.abs(y);
  if (ay < 709 || !Number.isFinite(ay)) return c * (f === "cosh" ? FD.cosh(y) : FD.sinh(y));
  const e = glibcExp(ay / 2);
  const v = c * (e / 2) * e;
  return f === "sinh" && y < 0 ? -v : v;
}
// a * b = p + e exactly (Veltkamp split; no fma in JavaScript)
function twoProd(a: number, b: number): [number, number] {
  const p = a * b;
  const sp = (v: number) => { const c = 134217729 * v, hi = c - (c - v); return [hi, v - hi]; };
  const [ah, al] = sp(a), [bh, bl] = sp(b);
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}
function cexp(a: number, b: number): [number, number] {
  // (a real argument keeps its zero imaginary part: exp(inf+0j) = inf+0j)
  if (b === 0) return [glibcExp(a), b];
  if (a > 709 && a < 1420) {
    const e = glibcExp(a / 2);
    return [FD.cos(b) * e * e, FD.sin(b) * e * e];
  }
  const e = glibcExp(a);
  return [e * FD.cos(b), e * FD.sin(b)];
}
function clog(a: number, b: number): [number, number] {
  const im = FD.atan2(b, a);
  let x = Math.abs(a), y = Math.abs(b);
  if (x < y) [x, y] = [y, x];
  if (!Number.isFinite(x) || x !== x || y !== y) return [glibcLog(FD.v8hypot(a, b)), im];
  if (x === 0) return [-Infinity, im];
  if (x > 2 ** 1000) return [glibcLog(FD.v8hypot(x / 4, y / 4)) + 2 * Math.LN2, im];
  if (x < 2 ** -1000) return [glibcLog(FD.v8hypot(x * 2 ** 600, y * 2 ** 600)) - 600 * Math.LN2, im];
  // near the unit circle log|z| = log1p(|z|^2 - 1) / 2, with x^2 + y^2 - 1
  // from error-free products (Dekker): it cancels (0.6+0.8j)
  if (x > 0.5 && x < 2 && y < 1) {
    const h = FD.v8hypot(x, y);
    if (h > 0.7 && h < 1.4) {
      const [xh, xl] = twoProd(x, x), [yh, yl] = twoProd(y, y);
      const t = xh - 1; // exact (Sterbenz)
      const s = t + yh, bb = s - t, err = (t - (s - bb)) + (yh - bb);
      return [glibcLog1p(s + (err + xl + yl)) / 2, im];
    }
  }
  return [glibcLog(FD.v8hypot(x, y)), im];
}

// The principal square root as C99 csqrt: the sign of the imaginary part
// follows b's sign bit (sqrt(-1-0j) = -1j), special values as C99, and
// scaling so that huge or tiny arguments neither overflow nor underflow.
function csqrt(a: number, b: number): [number, number] {
  if (b === Infinity || b === -Infinity) return [Infinity, b];
  if (a !== a) return [NaN, NaN];
  if (a === Infinity) return [Infinity, b !== b ? NaN : Object.is(b, -0) || b < 0 ? -0 : 0];
  if (a === -Infinity) return [b !== b ? NaN : 0, Object.is(b, -0) || b < 0 ? -Infinity : Infinity];
  if (b !== b) return [NaN, NaN];
  if (a === 0 && b === 0) return [0, b];
  const m = Math.max(Math.abs(a), Math.abs(b));
  // sqrt(z) = sqrt(z / 4^k) 2^k
  let s = 1;
  if (m > 1e300) (a *= 0.25), (b *= 0.25), (s = 2);
  else if (m < 1e-300) (a *= 2 ** 600), (b *= 2 ** 600), (s = 2 ** -300);
  const t = Math.sqrt((Math.abs(a) + FD.v8hypot(a, b)) / 2);
  const neg = b < 0 || Object.is(b, -0);
  return a >= 0 ? [s * t, s * (b / (2 * t))] : [(s * Math.abs(b)) / (2 * t), neg ? -s * t : s * t];
}
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Tight loops for unary operations on real data: contiguous or strided.
const UN_EXPR: Record<string, string> = Obj.table({
  negative: "-v", positive: "v", absolute: "Math.abs(v)", square: "v * v", sqrt: "Math.sqrt(v)", cbrt: "FD.cbrt(v)",
  exp: "EXP(v)", exp2: "EXP2(v)", expm1: "FD.expm1(v)", log: "LOG(v)", log2: "CR.log2(v)", log10: "FD.log10(v)",
  log1p: "LOG1P(v)", sin: "CR.sin(v)", cos: "CR.cos(v)", tan: "CR.tan(v)", arcsin: "CR.asin(v)",
  arccos: "CR.acos(v)", arctan: "CR.atan(v)", sinh: "FD.sinh(v)", cosh: "FD.cosh(v)", tanh: "FD.tanh(v)",
  arcsinh: "CR.asinh(v)", arccosh: "CR.acosh(v)", arctanh: "CR.atanh(v)", floor: "Math.floor(v)", ceil: "Math.ceil(v)",
  trunc: "Math.trunc(v)", isnan: "+(v !== v)", isfinite: "+(v - v === 0)", isinf: "+(v === Infinity || v === -Infinity)",
  deg2rad: "v * (Math.PI / 180)", rad2deg: "v * (180 / Math.PI)", logical_not: "+(v === 0)",
});
const unKernels = new Map<string, any>();
function unaryKernel(op: string, contiguous: boolean): any {
  const key = op + contiguous;
  let k = unKernels.get(key);
  if (k === undefined) {
    if (!Object.hasOwn(UN_EXPR, op)) throw new Error(`no fast kernel for ${op}`);
    const body = contiguous
      ? `for (let i = 0; i < n; i++) { const v = ad[ao + i]; od[i] = ${UN_EXPR[op]}; if ((i & 1023) === 1023) POLL(); }`
      : `const nd = shape.length, last = nd - 1, L = shape[last], s = st[last];
         const idx = new Array(nd).fill(0);
         let p = ao, o = 0;
         for (;;) {
           let x = p;
           for (let i = 0; i < L; i++, x += s) { const v = ad[x]; od[o++] = ${UN_EXPR[op]}; if ((o & 1023) === 0) POLL(); }
           let d = nd - 2;
           for (; d >= 0; d--) { p += st[d]; if (++idx[d] < shape[d]) break; p -= st[d] * shape[d]; idx[d] = 0; }
           if (d < 0) return;
         }`;
    // (Stop polled every 1024 elements: a large array of slow functions stays interruptible)
    k = new Function("EXP", "LOG", "LOG1P", "FD", "POW", "CR", "EXP2", "POLL", "ad", "ao", "st", "shape", "od", "n", body).bind(null, glibcExp, glibcLog, glibcLog1p, FD, glibcPow, CR, glibcExp2, O.pollInterrupt);
    unKernels.set(key, k);
  }
  return k;
}

// (an int64 or uint64 result: computed exactly, wrapped as NumPy wraps,
// when an input or a result left the safe range (-(-2**63) is -2**63);
// an operation without an exact form refused there)
const UN_BIG: Record<string, (a: bigint) => bigint> = { negative: (a) => -a, positive: (a) => a, absolute: (a) => (a < 0n ? -a : a), square: (a) => a * a, invert: (a) => ~a };
export function unary(op: string, x: any): any {
  const r = unaryRaw(op, x);
  if (r instanceof NDArray && isWide(r.dt)) {
    // (signed, safe inputs and results: exact; else UN_BIG's exact form,
    // wrapped and certified (-uint64(1) is 2**64 - 1, refused); another
    // operation only with safe inputs and results, unsigned ones >= 0)
    const a = operand(x).arr;
    const safe = allSafe(r) && allSafe(a);
    const g = UN_BIG[op];
    if (g !== undefined && !(safe && r.dt.kind === "i" && op !== "square")) {
      const od = r.data;
      loop1(a.shape, a.strides, a.offset, (p, k) => (od[k] = exact64(r.dt, g(BigInt(a.data[p]))) ?? wideRefuse(r.dt)));
    } else if (g === undefined && (!safe || (r.dt.kind === "u" && !allNonNeg(r)))) wideRefuse(r.dt);
  }
  return r;
}
function unaryRaw(op: string, x: any): any {
  const spec = UN[op];
  const a = operand(x).arr;
  if (op === "invert" && a.dt.kind === "b") {
    const out = empty(a.shape, D.bool);
    loop1(a.shape, a.strides, a.offset, (p, k) => (out.data[k] = a.data[p] ? 0 : 1));
    return out;
  }
  if (op === "absolute" && a.dt.cplx) {
    const out = empty(a.shape, a.dt === D.complex64 ? D.float32 : D.float64);
    loop1(a.shape, a.strides, a.offset, (p, k) => (out.data[k] = CR.hypot(a.data[2 * p], a.data[2 * p + 1])));
    return out;
  }
  if (op === "negative" && a.dt.kind === "b") raise(T.TypeError, "The numpy boolean negative, the `-` operator, is not supported, use the `~` operator or the logical_not function instead.");
  let rt: DType;
  if (spec.out === "bool") rt = D.bool;
  else if (a.dt.cplx) rt = a.dt;
  else if (spec.float && (a.dt.isInt || a.dt.kind === "b")) rt = floatFor(op, a.dt);
  else if (op === "reciprocal" && a.dt.kind === "b") rt = D.int8;
  else rt = a.dt;
  if (spec.float && (a.dt === D.int64 || a.dt === D.uint64 || a.dt === D.int32 || a.dt === D.uint32)) rt = D.float64;
  const out = empty(a.shape, rt);
  const od = out.data, ad = a.data;
  if (a.dt.cplx) {
    const fc = spec.c;
    if (!fc) return raise(T.TypeError, `ufunc '${op}' not supported for complex input`);
    loop1(a.shape, a.strides, a.offset, (p, k) => {
      const r = fc(ad[2 * p], ad[2 * p + 1]);
      if (rt.cplx) {
        od[2 * k] = r[0];
        od[2 * k + 1] = r[1];
      } else od[k] = r[0];
    });
    return out;
  }
  if ((op === "exp" || op === "log") && a.dt === D.float64 && rt === D.float64 && a.isC()
      && wasmUnary(op === "exp" ? "vexp" : "vlog", op === "exp" ? EXP_TABLES : LOG_TABLES, ad as Float64Array, a.offset, a.size, od as Float64Array)) return out;
  if ((op === "sin" || op === "cos") && a.dt === D.float64 && rt === D.float64 && a.isC()
      && wasmSinCos(op === "cos", CR.SINCOS_TABLE, ad as Float64Array, a.offset, a.size, od as Float64Array, op === "cos" ? CR.cos : CR.sin)) return out;
  if (UN_EXPR[op] && a.ndim > 0 && a.size > 0) {
    unaryKernel(op, a.isC())(ad, a.offset, a.strides, a.shape, od, a.size);
    return out;
  }
  const f = op === "reciprocal" && rt.isInt ? (x: number) => (x === 0 ? 0 : Math.trunc(1 / x)) : spec.f;
  if (rt.isInt && rt.ctor === Float64Array) loop1(a.shape, a.strides, a.offset, (p, k) => (od[k] = castNum(rt, f(ad[p]))));
  else loop1(a.shape, a.strides, a.offset, (p, k) => (od[k] = f(ad[p])));
  return out;
}

// ------------------------------------------------------------------ reductions

// NumPy's pairwise summation (numpy/_core/src/umath/loops_utils.h.src), so
// float sums agree with NumPy's to the last bit.
function pairwise(d: any, off: number, n: number, st: number): number {
  if (n < 8) {
    let res = -0;
    for (let i = 0; i < n; i++) res += d[off + i * st];
    return res;
  }
  if (n <= 128) {
    const r = [d[off], d[off + st], d[off + 2 * st], d[off + 3 * st], d[off + 4 * st], d[off + 5 * st], d[off + 6 * st], d[off + 7 * st]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      const p = off + i * st;
      r[0] += d[p];
      r[1] += d[p + st];
      r[2] += d[p + 2 * st];
      r[3] += d[p + 3 * st];
      r[4] += d[p + 4 * st];
      r[5] += d[p + 5 * st];
      r[6] += d[p + 6 * st];
      r[7] += d[p + 7 * st];
    }
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i++) res += d[off + i * st];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(d, off, n2, st) + pairwise(d, off + n2 * st, n - n2, st);
}

// pairwise() in float32 arithmetic (NumPy sums float32 in float32): each
// sum of two float32 values rounded to float32, which f64 + fround does
// correctly.
const f32 = Math.fround;
function pairwise32(d: any, off: number, n: number, st: number): number {
  if (n < 8) {
    let res = -0;
    for (let i = 0; i < n; i++) res = f32(res + d[off + i * st]);
    return res;
  }
  if (n <= 128) {
    const r = [d[off], d[off + st], d[off + 2 * st], d[off + 3 * st], d[off + 4 * st], d[off + 5 * st], d[off + 6 * st], d[off + 7 * st]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      const p = off + i * st;
      for (let j = 0; j < 8; j++) r[j] = f32(r[j] + d[p + j * st]);
    }
    let res = f32(f32(f32(r[0] + r[1]) + f32(r[2] + r[3])) + f32(f32(r[4] + r[5]) + f32(r[6] + r[7])));
    for (; i < n; i++) res = f32(res + d[off + i * st]);
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return f32(pairwise32(d, off, n2, st) + pairwise32(d, off + n2 * st, n - n2, st));
}

// pairwise() of (d[i] - m)^2: var's sum of squared deviations with NumPy's
// bits (it computes a - mean, squares in place and sums pairwise) and no
// temporary array.
function pairwiseSqDev(d: any, off: number, n: number, m: number): number {
  if (n < 8) {
    let res = -0;
    for (let i = 0; i < n; i++) {
      const t = d[off + i] - m;
      res += t * t;
    }
    return res;
  }
  if (n <= 128) {
    const r = new Array(8);
    for (let j = 0; j < 8; j++) {
      const t = d[off + j] - m;
      r[j] = t * t;
    }
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) {
        const t = d[off + i + j] - m;
        r[j] += t * t;
      }
    }
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i++) {
      const t = d[off + i] - m;
      res += t * t;
    }
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSqDev(d, off, n2, m) + pairwiseSqDev(d, off + n2, n - n2, m);
}

// Reduce `a` over `axes` with fold(acc, x) from init; `inner` reduces a run of
// the innermost axis at once (pairwise sums).
function reduceAxes(a: NDArray, axes: number[] | null, keepdims: boolean, rt: DType, init: number, fold: (acc: number, x: number) => number, inner?: (d: any, off: number, n: number, st: number) => number): NDArray {
  const nd = a.ndim;
  const ax = axes === null ? a.shape.map((_, i) => i) : [...new Set(axes.map((x) => normAxis(x, nd)))];
  const keep = a.shape.map((_, i) => i).filter((i) => !ax.includes(i));
  const outShape = keep.map((i) => a.shape[i]);
  // (the output and the row accumulator, a float64 (or float32) per output element)
  admitWork(prod(outShape) * (rt.itemsize + 8), "the reduction");
  const out = empty(outShape, rt);
  const red = ax.slice().sort((x, y) => x - y);
  const rshape = red.map((i) => a.shape[i]), rstr = red.map((i) => a.strides[i]);
  const kstr = keep.map((i) => a.strides[i]);
  const rn = prod(rshape);
  const d = a.data;
  // pairwise only when the reduction is over the last axis (as NumPy's inner loop)
  // reducing the leading axes of a C-contiguous array: accumulate whole rows
  // (NumPy adds slice by slice in this case, so the order is NumPy's too)
  if (inner && a.isC() && red.length < nd && red.every((x, i) => x === i) && !keepdims && prod(outShape) > 1) {
    const rows = rn, w = prod(outShape);
    const od = out.data;
    const acc = rt === D.float32 ? new Float32Array(w) : new Float64Array(w);
    for (let j = 0; j < w; j++) acc[j] = d[a.offset + j];
    for (let i = 1; i < rows; i++) {
      const base = a.offset + i * w;
      for (let j = 0; j < w; j++) acc[j] += d[base + j];
    }
    for (let j = 0; j < w; j++) od[j] = castNum(rt, init + acc[j]);
    return out;
  }
  // everything that is not reduced has length 1: NumPy's iterator drops those
  // axes, leaving one contiguous run, summed pairwise
  if (inner && a.isC() && prod(outShape) === 1 && rn > 0) {
    out.data[0] = castNum(rt, fold(init, inner(d, a.offset, rn, 1)));
    return keepdims ? reshape(out, a.shape.map((n, i) => (ax.includes(i) ? 1 : n))) : out;
  }
  const usePairwise = inner && red.length >= 1 && red[red.length - 1] === nd - 1 && (red.length === 1 || a.isC());
  loop1(outShape, kstr, a.offset, (base, k) => {
    let acc = init;
    if (usePairwise && red.length === 1) acc = fold(acc, inner!(d, base, rn, rstr[0]));
    else if (usePairwise && a.isC() && red.length === nd) acc = fold(acc, inner!(d, base, rn, 1));
    else if (inner && red.length === 1) {
      // over an outer axis NumPy adds slice by slice: sequentially
      for (let i = 0, p = base; i < rn; i++, p += rstr[0]) acc = fold(acc, d[p]);
    } else loop1(rshape, rstr, base, (p) => (acc = fold(acc, d[p])));
    out.data[k] = castNum(rt, acc);
  });
  if (keepdims) {
    const ks = a.shape.map((n, i) => (ax.includes(i) ? 1 : n));
    return reshape(out, ks);
  }
  return out;
}

function axesArg(axis: any, nd: number): number[] | null {
  if (axis === null || axis === undefined) return null;
  if (Array.isArray(axis)) return axis.map((x) => normAxis(intNum(x), nd));
  return [normAxis(intNum(axis), nd)];
}

function sumType(dt: DType): DType {
  if (dt.kind === "b" || (dt.kind === "i" && dt.itemsize < 8)) return D.int64;
  if (dt.kind === "u" && dt.itemsize < 8) return D.uint64;
  return dt;
}

function sum(a: NDArray, axis: any, keepdims: boolean, dtype: any = null): any {
  const rt = dtype !== null ? toDtype(dtype) : sumType(a.dt);
  const axs = axesArg(axis, a.ndim);
  const outN = axs === null ? 1 : prod(a.shape.filter((_, i) => !axs.includes(i)));
  if (a.dt.cplx) {
    // (the whole complex sum admitted first: the real and imaginary sums,
    // each with its accumulator, and the combined result; daybreak2's
    // LIMIT-PR56-1; the parts are views, not copies)
    admitWork(outN * (2 * (8 + 8) + 16), "sum");
    const re = realPart(a), im = imagPart(a);
    const r = sum(re, axis, keepdims), i = sum(im, axis, keepdims);
    return combineComplex(r, i, rt.cplx ? rt : a.dt);
  }
  // (a float sum of another dtype sums a converted copy: that copy, the
  // output and its accumulator admitted first; LIMIT-PR55-3)
  const widen = rt !== a.dt && rt.kind === "f";
  admitWork((widen ? a.size * rt.itemsize : 0) + outN * (rt.itemsize + 8), "sum");
  const src = widen ? copy(a, rt) : a;
  if (rt === D.float32) return finish(reduceAxes(src, axesArg(axis, a.ndim), keepdims, rt, 0, (x, y) => f32(x + y), pairwise32), axis, keepdims);
  // (int64: each partial sum checked, as wideExact)
  const add = isWide(rt) ? (x: number, y: number) => wideExact(rt, "add", x + y, x, y) : (x: number, y: number) => x + y;
  return finish(reduceAxes(src, axesArg(axis, a.ndim), keepdims, rt, 0, add, rt.kind === "f" ? pairwise : undefined), axis, keepdims);
}
// The product of a complex array (or of one into a complex dtype) over the
// axes: each output element the product of its reduced elements, one at a
// time from the first, in C order of the reduced axes, with NumPy's complex
// product (ac - bd, ad + bc), rounded to complex64 at each step for that
// dtype. NumPy walks a non-contiguous array in its memory order instead, so
// when products under- or overflow on the way the two can differ: for
// np.array([[1e-200, 1e200], [1e-200, 1e200]], dtype=complex).T NumPy gives
// 1+0j and this 0j (as the real fold does for a real array), a known
// traversal-order limitation.
function complexProd(a: NDArray, axes: number[] | null, keepdims: boolean, rt: DType, init: [number, number] | null = null): NDArray {
  // (NumPy discards the imaginary parts with a ComplexWarning, which Sagebrush does not have)
  if (a.dt.cplx && !rt.cplx) raise(T.TypeError, `prod: a complex array multiplied in the real dtype ${rt.name} would lose its imaginary parts; take .real first`);
  const nd = a.ndim;
  const ax = axes === null ? a.shape.map((_, i) => i) : [...new Set(axes.map((x) => normAxis(x, nd)))].sort((x, y) => x - y);
  const keep = a.shape.map((_, i) => i).filter((i) => !ax.includes(i));
  // (the reduced elements in prodOrder's order, each its value in rt)
  const { off, rshape, rst } = prodOrder(a, ax, rt);
  const outShape = keep.map((i) => a.shape[i]);
  const out = empty(outShape, rt);
  const f32 = rt === D.complex64;
  const cin = a.dt.cplx, d = a.data, o = out.data;
  const val = (p: number): [number, number] => {
    const xr = cin ? d[2 * p] : d[p], xi = cin ? d[2 * p + 1] : 0;
    return f32 ? [Math.fround(xr), Math.fround(xi)] : [xr, xi];
  };
  const kshape = keep.map((i) => a.shape[i]), kst = keep.map((i) => a.strides[i]);
  loop1(kshape, kst, off, (p0, r) => {
    // (from the first element, as NumPy's reduction: 1 only for none;
    // initial= starts the product, as NumPy's)
    let re = 1, im = 0, first = init === null;
    if (init) [re, im] = f32 ? [Math.fround(init[0]), Math.fround(init[1])] : init;
    loop1(rshape, rst, p0, (p) => {
      const [xr, xi] = val(p);
      if (first) {
        [re, im] = [xr, xi];
        first = false;
        return;
      }
      [re, im] = [re * xr - im * xi, re * xi + im * xr];
      if (f32) [re, im] = [Math.fround(re), Math.fround(im)];
    });
    o[2 * r] = re;
    o[2 * r + 1] = im;
  });
  return keepdims ? reshape(out, a.shape.map((n, i) => (ax.includes(i) ? 1 : n))) : out;
}
function finish(r: NDArray, axis: any, keepdims: boolean): any {
  return r.ndim === 0 && !keepdims ? pyScalarOf(r.dt, r.data, r.offset) : r;
}
// (a complex array's components are views of it, read-only where it is,
// as NumPy's; a real array's imag is a new read-only array of zeros)
function realPart(a: NDArray): NDArray {
  if (!a.dt.cplx) return a;
  const dt = a.dt === D.complex64 ? D.float32 : D.float64;
  const v = new NDArray(dt, a.data, a.shape, a.strides.map((s) => 2 * s), 2 * a.offset, a);
  v.ro = a.ro;
  return v;
}
function imagPart(a: NDArray): NDArray {
  if (!a.dt.cplx) {
    const z = empty(a.shape, a.dt);
    z.ro = true;
    return z;
  }
  const dt = a.dt === D.complex64 ? D.float32 : D.float64;
  const v = new NDArray(dt, a.data, a.shape, a.strides.map((s) => 2 * s), 2 * a.offset + 1, a);
  v.ro = a.ro;
  return v;
}
// A real scalar as a JS number: through a NumPy scalar's box and an
// integral float's FloatBox.
function realNum(x: any): number {
  let v = Obj.unbox(x);
  if (v instanceof Obj.FloatBox) v = v.v;
  return typeof v === "bigint" ? Number(v) : (v as number);
}

function combineComplex(r: any, i: any, dt: DType): any {
  if (!(r instanceof NDArray)) {
    const v = new PyComplex(realNum(r), realNum(i));
    const ctor = scalarCtors[dt.name];
    return ctor ? Obj.callObj(ctor, [v]) : v;
  }
  const out = empty(r.shape, dt);
  for (let k = 0; k < r.size; k++) {
    out.data[2 * k] = r.data[k];
    out.data[2 * k + 1] = i.data[k];
  }
  return out;
}

function minmax(a: NDArray, axis: any, keepdims: boolean, isMax: boolean): any {
  if (a.size === 0 && (axis === null || axis === undefined)) raise(T.ValueError, `zero-size array to reduction operation ${isMax ? "maximum" : "minimum"} which has no identity`);
  const fold = isMax ? (x: number, y: number) => (x !== x || y !== y ? NaN : x > y ? x : y) : (x: number, y: number) => (x !== x || y !== y ? NaN : x < y ? x : y);
  return finish(reduceAxes(a, axesArg(axis, a.ndim), keepdims, a.dt, isMax ? -Infinity : Infinity, fold), axis, keepdims);
}

function argminmax(a: NDArray, axis: any, isMax: boolean): any {
  if (axis === null || axis === undefined) a = ravel(a);
  const ax = axis === null || axis === undefined ? 0 : normAxis(intNum(axis), a.ndim);
  if (a.shape[ax] === 0) raise(T.ValueError, `attempt to get ${isMax ? "argmax" : "argmin"} of an empty sequence`);
  const t = moveAxisToEnd(a, ax);
  const outShape = t.shape.slice(0, -1);
  const out = empty(outShape, D.int64);
  const n = t.shape[t.ndim - 1], st = t.strides[t.ndim - 1];
  loop1(outShape, t.strides.slice(0, -1), t.offset, (base, k) => {
    let best = t.data[base], bi = 0;
    if (best === best) {
      for (let i = 1, p = base + st; i < n; i++, p += st) {
        const v = t.data[p];
        if (v !== v) {
          bi = i;
          break;
        }
        if (isMax ? v > best : v < best) {
          best = v;
          bi = i;
        }
      }
    }
    out.data[k] = bi;
  });
  return out.ndim === 0 ? pyScalarOf(D.int64, out.data, 0) : out;
}
function moveAxisToEnd(a: NDArray, ax: number): NDArray {
  const order = a.shape.map((_, i) => i).filter((i) => i !== ax).concat([ax]);
  return transpose(a, order);
}

// One product in dtype rt, as NumPy's multiply loop: a float32 rounded at
// each step (1e-30 * 1e-30 underflows there); an integer wrapped exactly
// to its width (2**40 * 2**40 is 0 in int64), from the exact product when a
// double cannot hold it; an int64 or uint64 result a double cannot hold
// exactly (Sagebrush's int64 arrays are doubles) refused
function mulIn(rt: DType, what: string): (p: number, x: number) => number {
  if (rt === D.float32) return (p, x) => Math.fround(p * x);
  if (rt.kind !== "i" && rt.kind !== "u") return (p, x) => p * x;
  if (isWide(rt)) return (p, x) => wideExact(rt, "multiply", p * x, p, x);
  const bits = rt.itemsize * 8, signed = rt.kind === "i";
  return (p, x) => {
    const r = p * x;
    if (!Number.isSafeInteger(r)) {
      const b = BigInt(Math.trunc(p)) * BigInt(Math.trunc(x));
      const wb = signed ? BigInt.asIntN(bits, b) : BigInt.asUintN(bits, b);
      const w = Number(wb);
      if (BigInt(w) !== wb) raise(T.NotImplementedError, `${what}: the ${rt.name} product ${wb} is not exactly representable in Sagebrush's ${rt.name} arrays (doubles) yet`);
      return w;
    }
    if (bits === 64) return r;
    if (bits === 32) return signed ? r | 0 : r >>> 0;
    return signed ? (r << (32 - bits)) >> (32 - bits) : r & ((1 << bits) - 1);
  };
}

// numpy.prod of a real array: each output the product of its reduced
// elements in NumPy's iterator order, their memory order (the reduced axes
// by decreasing stride, a negative stride walked forward), from 1 (or
// initial: it starts the product, as NumPy's), each element cast to rt and
// each product rounded or wrapped as mulIn
// The order a product's reduced elements are multiplied in (it decides
// overflow and underflow): float32, float16 and complex64, rounded at
// each step, in their logical order (NumPy's inner loop over one axis,
// and its order for a C-contiguous array reduced whole); over several
// axes of another layout NumPy's iterator reorders axes and buffers:
// refused, never a product in another order. Every other dtype in the
// order NumPy's reduction iterator visits them (iterAxisOrder, a
// broadcast axis's zero stride included), each walked in its own
// direction, a negative stride not reversed (the reduction's
// NPY_ITER_DONT_NEGATE_STRIDES: astra CORR-76A-2, CORR-3D5-1, CORR-948-1)
function prodOrder(a: NDArray, ax: number[], rt: DType): { off: number; rshape: number[]; rst: number[] } {
  if (rt === D.float32 || rt.name === "float16" || rt === D.complex64) {
    const rshape = ax.map((i) => a.shape[i]), rst = ax.map((i) => a.strides[i]);
    if (rshape.filter((n) => n > 1).length > 1 && !(ax.length === a.ndim && a.isC())) {
      raise(T.NotImplementedError, `${rt.name} prod over several axes or a non-contiguous view is not supported yet`);
    }
    return { off: a.offset, rshape, rst };
  }
  // (the reduced axes in the order of all the axes NumPy's iterator
  // chooses for the input and the result, whose reduced axes have stride 0)
  const nd = a.ndim, outSt = new Array(nd).fill(0);
  for (let i = nd - 1, st = 1; i >= 0; i--) if (!ax.includes(i)) {
    outSt[i] = st;
    st *= a.shape[i];
  }
  const order = iterAxisOrder(nd, [a.strides, outSt]).filter((i) => ax.includes(i)).reverse();
  return { off: a.offset, rshape: order.map((i) => a.shape[i]), rst: order.map((i) => a.strides[i]) };
}
// NumPy's nditer axis ordering (npyiter_find_best_axis_ordering): the
// axes innermost first, an insertion sort from C order that moves an axis
// inward past another while some operand's stride there is larger, a
// zero stride saying nothing (the scan goes on past it), and C order
// winning when operands disagree
function iterAxisOrder(nd: number, strides: number[][]): number[] {
  const perm: number[] = [];
  for (let i = nd - 1; i >= 0; i--) perm.push(i);
  for (let i0 = 1; i0 < nd; i0++) {
    let ipos = i0;
    const a0 = perm[i0];
    for (let i1 = i0 - 1; i1 >= 0; i1--) {
      let ambig = true, swap = false;
      const a1 = perm[i1];
      for (const st of strides) {
        const s0 = st[a0], s1 = st[a1];
        if (s0 !== 0 && s1 !== 0) {
          if (Math.abs(s1) <= Math.abs(s0)) swap = false;
          else if (ambig) swap = true;
          ambig = false;
        }
      }
      if (!ambig) {
        if (swap) ipos = i1;
        else break;
      }
    }
    if (ipos !== i0) {
      perm.splice(i0, 1);
      perm.splice(ipos, 0, a0);
    }
  }
  return perm;
}
function prodReduce(a: NDArray, axes: number[] | null, keepdims: boolean, rt: DType, init: number, hasInitial: boolean): NDArray {
  const nd = a.ndim;
  const ax = axes === null ? a.shape.map((_, i) => i) : [...new Set(axes.map((x) => normAxis(x, nd)))].sort((x, y) => x - y);
  const keep = a.shape.map((_, i) => i).filter((i) => !ax.includes(i));
  const outShape = keep.map((i) => a.shape[i]);
  const out = empty(outShape, rt);
  const { off, rshape, rst } = prodOrder(a, ax, rt);
  const mul = mulIn(rt, "prod");
  const cast = (v: number) => (rt.kind === "f" ? castNum(rt, v) : v);
  const d = a.data, od = out.data;
  const kshape = keep.map((i) => a.shape[i]), kst = keep.map((i) => a.strides[i]);
  loop1(kshape, kst, off, (p0, k) => {
    let acc = init, first = !hasInitial;
    loop1(rshape, rst, p0, (p) => {
      const v = cast(d[p]);
      // (as NumPy's reduction: the first element copied, then multiplied)
      if (first) {
        acc = v;
        first = false;
      } else acc = mul(acc, v);
    });
    od[k] = castNum(rt, acc);
  });
  return keepdims ? reshape(out, a.shape.map((n, i) => (ax.includes(i) ? 1 : n))) : out;
}

function cumulative(a: NDArray, axis: any, isProd: boolean, dtype: any): NDArray {
  if (axis === null || axis === undefined) a = ravel(a);
  if (a.ndim === 1 && a.isC() && (dtype === null || dtype === undefined) && a.dt.kind === "f") {
    // (the first element is copied, as NumPy does: 0 + -0.0 would be +0.0)
    const out = empty(a.shape, a.dt), d = a.data, od = out.data, n = a.size;
    let acc = d[a.offset];
    if (n) od[0] = acc;
    if (a.dt === D.float32) for (let i = 1; i < n; i++) od[i] = acc = Math.fround(isProd ? acc * d[a.offset + i] : acc + d[a.offset + i]);
    else for (let i = 1; i < n; i++) od[i] = acc = isProd ? acc * d[a.offset + i] : acc + d[a.offset + i];
    return out;
  }
  const ax = axis === null || axis === undefined ? 0 : normAxis(intNum(axis), a.ndim);
  const rt = dtype !== null && dtype !== undefined ? toDtype(dtype) : sumType(a.dt);
  const out = empty(a.shape, rt);
  const t = moveAxisToEnd(a, ax), o = moveAxisToEnd(out, ax);
  const n = t.shape[t.ndim - 1], st = t.strides[t.ndim - 1], ost = o.strides[o.ndim - 1];
  if (rt.cplx) {
    // complex: (re, im) pairs, at data[2p] and data[2p + 1]; the first is
    // copied, as NumPy does ((1 + 0j) * (inf + 1j) would be inf + nanj)
    const cin = a.dt.cplx, f32 = rt === D.complex64;
    loop2(t.shape.slice(0, -1), t.strides.slice(0, -1), t.offset, o.strides.slice(0, -1), o.offset, (p, q) => {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const s = p + i * st, xr = cin ? t.data[2 * s] : t.data[s], xi = cin ? t.data[2 * s + 1] : 0;
        if (i === 0) [re, im] = [xr, xi];
        else if (isProd) [re, im] = [re * xr - im * xi, re * xi + im * xr];
        else [re, im] = [re + xr, im + xi];
        if (f32) [re, im] = [Math.fround(re), Math.fround(im)];
        const d = q + i * ost;
        o.data[2 * d] = re;
        o.data[2 * d + 1] = im;
      }
    });
    return out;
  }
  // (NumPy discards the imaginary parts with a ComplexWarning, which Sagebrush does not have)
  if (a.dt.cplx) raise(T.TypeError, `${isProd ? "cumprod" : "cumsum"}: a complex array accumulated in the real dtype ${rt.name} would lose its imaginary parts; take .real first`);
  const mul = mulIn(rt, "cumprod");
  const add = isWide(rt) ? (x: number, y: number) => wideExact(rt, "add", x + y, x, y) : (x: number, y: number) => x + y;
  loop2(t.shape.slice(0, -1), t.strides.slice(0, -1), t.offset, o.strides.slice(0, -1), o.offset, (p, q) => {
    let acc = isProd ? 1 : 0;
    for (let i = 0; i < n; i++) {
      acc = i === 0 ? t.data[p] : isProd ? mul(acc, t.data[p + i * st]) : add(acc, t.data[p + i * st]);
      acc = castNum(rt, acc);
      o.data[q + i * ost] = acc;
    }
  });
  return out;
}

function ravel(a: NDArray): NDArray {
  return reshape(a, [a.size]);
}

export function nonzero(a: NDArray): NDArray[] {
  const nd = Math.max(1, a.ndim);
  const shape = a.ndim ? a.shape : [1];
  const strides = a.ndim ? a.strides : [0];
  const idx = new Array(nd).fill(0);
  const cplx = a.dt.cplx;
  const isNz = (p: number) => (cplx ? a.data[2 * p] !== 0 || a.data[2 * p + 1] !== 0 : a.data[p] !== 0);
  // (counted first, then the nd int64 outputs admitted together and filled
  // in place: no JS arrays growing with the count; LIMIT-PR55-3)
  let count = 0;
  loop1(shape, strides, a.offset, (p) => {
    if (isNz(p)) count++;
  });
  admitWork(nd * count * 8, "nonzero");
  const outs = Array.from({ length: nd }, () => empty([count], D.int64));
  let j = 0;
  loop1(shape, strides, a.offset, (p, k) => {
    if (isNz(p)) {
      let r = k;
      for (let d = nd - 1; d >= 0; d--) {
        idx[d] = r % shape[d];
        r = Math.floor(r / shape[d]);
      }
      for (let d = 0; d < nd; d++) outs[d].data[j] = idx[d];
      j++;
    }
  });
  return outs;
}

// ------------------------------------------------------------------ linear algebra basics

function matmul(x: any, y: any): any {
  const a = operand(x).arr, b = operand(y).arr;
  if (a.ndim === 0 || b.ndim === 0) raise(T.ValueError, "matmul: Input operand does not have enough dimensions");
  const A = a.ndim === 1 ? reshape(a, [1, a.shape[0]]) : a;
  const B = b.ndim === 1 ? reshape(b, [b.shape[0], 1]) : b;
  const n = A.shape[A.ndim - 2], m = A.shape[A.ndim - 1], m2 = B.shape[B.ndim - 2], p = B.shape[B.ndim - 1];
  if (m !== m2) raise(T.ValueError, `matmul: Input operand 1 has a mismatch in its core dimension 0, with gufunc signature (n?,k),(k,m?)->(n?,m?) (size ${m2} is different from ${m})`);
  const batch = broadcastShapes(A.shape.slice(0, -2), B.shape.slice(0, -2));
  const rt = promote(a.dt, b.dt);
  const ct = rt.kind === "b" ? D.bool : rt;
  // (the output, the row buffers or WebAssembly's GEMM buffers, and for
  // complex two copies of each operand in its complex dtype, four real
  // products, their two sums and the combined result; LIMIT-PR55-3)
  const outN = prod(batch) * n * p;
  admitWork(ct.cplx
    ? 2 * (A.size + B.size) * ct.itemsize + 6 * outN * 8 + outN * ct.itemsize + 8 * (n * m + m * p + n * p + 5 * p)
    : outN * ct.itemsize + 8 * (n * m + m * p + n * p + 5 * p), "matmul");
  if (ct.cplx) {
    // via real arithmetic on the parts
    const ar = realPart(copy(A, ct)), ai = imagPart(copy(A, ct)), br = realPart(copy(B, ct)), bi = imagPart(copy(B, ct));
    const rr = binary("subtract", matmul(ar, br), matmul(ai, bi)), ii = binary("add", matmul(ar, bi), matmul(ai, br));
    return squeezeMatmul(combineComplex(rr, ii, ct), a, b, ct);
  }
  const out = empty([...batch, n, p], ct);
  const Ab = bstrides(new NDArray(A.dt, A.data, A.shape.slice(0, -2), A.strides.slice(0, -2), A.offset), batch);
  const Bb = bstrides(new NDArray(B.dt, B.data, B.shape.slice(0, -2), B.strides.slice(0, -2), B.offset), batch);
  const as0 = A.strides[A.ndim - 2], as1 = A.strides[A.ndim - 1], bs0 = B.strides[B.ndim - 2], bs1 = B.strides[B.ndim - 1];
  const ad = A.data, bd = B.data, od = out.data;
  // (int64: each product and partial sum checked and wrapped, in order)
  if (isWide(ct)) {
    loop2(batch, Ab, A.offset, Bb, B.offset, (pa, pb, bk) => {
      for (let i = 0; i < n; i++)
        for (let j = 0; j < p; j++) {
          let sum = 0;
          for (let k = 0; k < m; k++) {
            const x = ad[pa + i * as0 + k * as1], y = bd[pb + k * bs0 + j * bs1];
            const q = wideExact(ct, "multiply", x * y, x, y);
            sum = wideExact(ct, "add", sum + q, sum, q);
          }
          od[bk * n * p + i * p + j] = sum;
        }
    });
    return squeezeMatmul(out, a, b, ct);
  }
  // matrix times vector: dot products
  if (p === 1) {
    loop2(batch, Ab, A.offset, Bb, B.offset, (pa, pb, bk) => {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0, x = pa + i * as0, y = pb; k < m; k++, x += as1, y += bs0) sum += ad[x] * bd[y];
        od[bk * n + i] = castNum(ct, sum);
      }
    });
    return squeezeMatmul(out, a, b, ct);
  }
  // WebAssembly SIMD (kernels/src/lib.rs), same sums in the same order
  const W = gemmBuffers(n, p, m);
  if (W) {
    const f64out = ct === D.float64;
    loop2(batch, Ab, A.offset, Bb, B.offset, (pa, pb, bk) => {
      const { a: wa, b: wb, c: wc } = W;
      if (as1 === 1 && as0 === m) wa.set(ad.subarray(pa, pa + n * m) as any);
      else for (let i = 0, t = 0; i < n; i++) for (let k = 0, x = pa + i * as0; k < m; k++, x += as1) wa[t++] = ad[x];
      if (bs1 === 1 && bs0 === p) wb.set(bd.subarray(pb, pb + m * p) as any);
      else for (let k = 0, t = 0; k < m; k++) for (let j = 0, y = pb + k * bs0; j < p; j++, y += bs1) wb[t++] = bd[y];
      W.run();
      const ob = bk * n * p;
      if (f64out) (od as Float64Array).set(wc, ob);
      else for (let t = 0; t < n * p; t++) od[ob + t] = castNum(ct, wc[t]);
    });
    return squeezeMatmul(out, a, b, ct);
  }
  // Four rows of the result at a time: each element of B is loaded once per
  // four multiply-adds.  Each output element still sums over k in order.
  const r0 = new Float64Array(p), r1 = new Float64Array(p), r2 = new Float64Array(p), r3 = new Float64Array(p);
  const brow = new Float64Array(p);
  const store = (ob: number, i: number, r: Float64Array) => {
    for (let j = 0; j < p; j++) od[ob + i * p + j] = castNum(ct, r[j]);
  };
  loop2(batch, Ab, A.offset, Bb, B.offset, (pa, pb, bk) => {
    const ob = bk * n * p;
    let i = 0;
    for (; i + 3 < n; i += 4) {
      r0.fill(0);
      r1.fill(0);
      r2.fill(0);
      r3.fill(0);
      for (let k = 0; k < m; k++) {
        const a0 = ad[pa + i * as0 + k * as1], a1 = ad[pa + (i + 1) * as0 + k * as1];
        const a2 = ad[pa + (i + 2) * as0 + k * as1], a3 = ad[pa + (i + 3) * as0 + k * as1];
        const bk0 = pb + k * bs0;
        if (bs1 === 1) brow.set(bd.subarray(bk0, bk0 + p));
        else for (let j = 0; j < p; j++) brow[j] = bd[bk0 + j * bs1];
        for (let j = 0; j < p; j++) {
          const b = brow[j];
          r0[j] += a0 * b;
          r1[j] += a1 * b;
          r2[j] += a2 * b;
          r3[j] += a3 * b;
        }
      }
      store(ob, i, r0);
      store(ob, i + 1, r1);
      store(ob, i + 2, r2);
      store(ob, i + 3, r3);
    }
    for (; i < n; i++) {
      r0.fill(0);
      for (let k = 0; k < m; k++) {
        const aik = ad[pa + i * as0 + k * as1];
        const bk0 = pb + k * bs0;
        for (let j = 0; j < p; j++) r0[j] += aik * bd[bk0 + j * bs1];
      }
      store(ob, i, r0);
    }
  });
  return squeezeMatmul(out, a, b, ct);
}
// matmul with a 1-D operand drops the axis it added
function squeezeMatmul(out: NDArray, a: NDArray, b: NDArray, ct: DType): any {
  const rs = out.shape.slice();
  if (a.ndim === 1) rs.splice(rs.length - 2, 1);
  if (b.ndim === 1) rs.splice(rs.length - 1, 1);
  const res = reshape(out, rs);
  return res.ndim === 0 ? pyScalarOf(ct, res.data, res.offset) : res;
}

// ------------------------------------------------------------------ printing (NumPy's arrayprint)

export const printopts = Obj.table({
  precision: 8, threshold: 1000, edgeitems: 3, linewidth: 75, suppress: false, sign: "-",
  floatmode: "maxprec", nanstr: "nan", infstr: "inf",
  // formatter's functions by kind (bool, int, float, complex), resolved from
  // the formatter dict (lib/numpy set_printoptions); override_repr
  fmt: { b: null, i: null, f: null, c: null } as Record<string, any>,
  overrideRepr: null as any,
});

// Shortest round-trip digits of x: [digits, exponent] with x = 0.d1d2... * 10^exp
// (round-tripping through float32 while a float32 array is being printed).
let printingF32 = false;
function shortestDigits(x: number, f32 = printingF32): [string, number] {
  if (x === 0) return ["", 0];
  const s = f32 ? shortestF32(Math.abs(x)) : Math.abs(x).toExponential();
  const [m, e] = s.split("e");
  return [m.replace(".", "").replace(/0+$/, ""), Number(e) + 1];
}
// The digits NumPy prints for a float32 x >= 0, as toExponential writes
// them: Dragon4's unique mode (Ryan Juckett's, as NumPy's dragon4.c has
// it), digit by digit until the rest is within the rounding margins (the
// lower one half the upper at a power of two, the bounds inclusive for an
// even mantissa), the last digit rounded by the remainder, a tie to even
const dv32 = new DataView(new ArrayBuffer(4));
function shortestF32(x: number): string {
  if (x === 0) return "0e+0";
  dv32.setFloat32(0, x);
  const bits = dv32.getUint32(0), fe = (bits >>> 23) & 0xff, fm = bits & 0x7fffff;
  // (value = mantissa * 2^exponent; mbit the mantissa's highest bit)
  const normal = fe !== 0;
  const mant = normal ? (1 << 23) | fm : fm, exponent = normal ? fe - 150 : -149, mbit = normal ? 23 : 31 - Math.clz32(fm);
  const unequal = normal && fe !== 1 && fm === 0, isEven = mant % 2 === 0;
  const M = BigInt(mant);
  let value: bigint, scale: bigint, mlow: bigint;
  if (unequal) {
    if (exponent > 0) [value, scale, mlow] = [M << BigInt(exponent + 2), 4n, 1n << BigInt(exponent)];
    else [value, scale, mlow] = [M << 2n, 1n << BigInt(-exponent + 2), 1n];
  } else {
    if (exponent > 0) [value, scale, mlow] = [M << BigInt(exponent + 1), 2n, 1n << BigInt(exponent)];
    else [value, scale, mlow] = [M << 1n, 1n << BigInt(-exponent + 1), 1n];
  }
  const high = () => (unequal ? 2n * mlow : mlow);
  // (the first digit's exponent estimated, then corrected once)
  let dexp = Math.ceil((mbit + exponent) * 0.30102999566398119521373889472449 - 0.69);
  if (dexp > 0) scale *= 10n ** BigInt(dexp);
  else if (dexp < 0) {
    const p = 10n ** BigInt(-dexp);
    value *= p;
    mlow *= p;
  }
  if (value >= scale) dexp++;
  else {
    value *= 10n;
    mlow *= 10n;
  }
  let outExp = dexp - 1;
  const digits: number[] = [];
  let d = 0, lo = false, hi = false;
  for (;;) {
    d = Number(value / scale);
    value %= scale;
    const vh = value + high();
    lo = isEven ? value <= mlow : value < mlow;
    hi = isEven ? vh >= scale : vh > scale;
    if (lo || hi) break;
    digits.push(d);
    value *= 10n;
    mlow *= 10n;
  }
  let roundDown = lo;
  if (lo === hi) {
    const c = 2n * value - scale;
    roundDown = c < 0n || (c === 0n && (d & 1) === 0);
  }
  if (roundDown) digits.push(d);
  else if (d < 9) digits.push(d + 1);
  else {
    // (a carry through the 9s, or a new leading 1)
    let i = digits.length - 1;
    while (i >= 0 && digits[i] === 9) i--;
    if (i < 0) {
      digits.length = 0;
      digits.push(1);
      outExp++;
    } else {
      digits[i]++;
      digits.length = i + 1;
    }
  }
  const s = digits.join("");
  return `${s[0]}${s.length > 1 ? "." + s.slice(1) : ""}e${outExp < 0 ? "-" : "+"}${Math.abs(outExp)}`;
}
// The exact decimal digits of |x| (a double is a dyadic rational): [digits,
// exponent] as above, without trailing zeros.
const dv64 = new DataView(new ArrayBuffer(8));
function exactDigits(x: number): [string, number] {
  x = Math.abs(x);
  if (x === 0) return ["", 0];
  dv64.setFloat64(0, x);
  const hi = dv64.getUint32(0), lo = dv64.getUint32(4), be = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (be === 0) e2 = -1074;
  else { m |= 1n << 52n; e2 = be - 1075; }
  let s: string, exp: number;
  if (e2 >= 0) { s = (m << BigInt(e2)).toString(); exp = s.length; }
  else { s = (m * 5n ** BigInt(-e2)).toString(); exp = s.length + e2; }
  return [s.replace(/0+$/, ""), exp];
}
// digits (of an exact value) cut to their first n, rounding half to even,
// as NumPy's Dragon4 does: rounding down keeps the digits generated (zeros
// too: 1.04 to one place is 1.0), rounding up drops the 9s it carries
// through (1.96 is 2.), and may add a digit in front (exp + 1); 0 is ["", 0]
function roundDigits(digits: string, exp: number, n: number): [string, number] {
  if (n >= digits.length) return [digits, exp];
  if (n <= 0 && !(n === 0 && (digits[0] > "5" || (digits[0] === "5" && digits.length > 1)))) return ["", 0];
  const keep = digits.slice(0, n), rest = digits.slice(n);
  const up = rest[0] > "5" || (rest[0] === "5" && (rest.length > 1 || (keep.length > 0 && Number(keep[keep.length - 1]) % 2 === 1)));
  if (!up) return [keep, exp];
  let i = keep.length - 1;
  while (i >= 0 && keep[i] === "9") i--;
  if (i < 0) return ["1", exp + 1];
  return [keep.slice(0, i) + String(Number(keep[i]) + 1), exp];
}

export type Trim = "k" | "." | "0" | "-";
interface Dragon4 { precision: number | null; unique: boolean; trim: Trim; sign: boolean; padLeft?: number | null; padRight?: number | null; minDigits?: number | null; f32?: boolean }
// the digits of |x| per NumPy's unique/precision rules; n(exp) is the number of
// digits a precision allows, given the exponent
// (and whether a value that is not 0 rounded to 0: NumPy then prints the
// precision's zeros, 0.00, even in unique mode)
// In unique mode, min_digits makes Dragon4 go on past the shortest digits to
// its place, with the exact value's digits (0.3 to 20 places is
// 0.29999999999999998890, and a large number's integer digits are exact),
// and zeros once those run out.  nMin(exp): the digits min_digits asks for.
// Dragon4 never writes more than `room` digits (its output buffer).
function digitsOf(x: number, o: Dragon4, n: (exp: number) => number, nMin: (exp: number) => number, room: number): [string, number, boolean] {
  const e = exactDigits(x);
  const cut = (k: number, pad = false): [string, number, boolean] => {
    const r = roundDigits(e[0], e[1], k);
    return [pad && r[0].length < k ? r[0].padEnd(k, "0") : r[0], r[1], r[0] === "" && e[0] !== ""];
  };
  const most = (exp: number) => Math.min(o.precision === null ? Infinity : n(exp), room);
  if (o.unique) {
    const s = shortestDigits(x, !!o.f32);
    if (s[0].length > most(s[1])) return cut(most(e[1]));
    if (o.minDigits != null && s[0].length < Math.min(nMin(s[1]), room)) return cut(Math.min(nMin(e[1]), room), true);
    return [s[0], s[1], false];
  }
  return o.precision === null ? [e[0], e[1], false] : cut(most(e[1]));
}
function nonFinite(x: number, sign: boolean): string {
  return x !== x ? "nan" : x < 0 ? "-inf" : sign ? "+inf" : "inf";
}
const signOf = (x: number, sign: boolean) => (x < 0 || Object.is(x, -0) ? "-" : sign ? "+" : "");
// The digits Dragon4 outputs, as [digits, exp] with value 0.d1d2... * 10^exp:
// 0 is one digit 0 (at 10^0), and a value that rounds to 0 at a fraction
// precision p a 0 at 10^-p (NumPy then prints 0.00).
function dragonDigits(x: number, o: Dragon4, n: (exp: number) => number, nMin: (exp: number) => number, p: number, room: number): [string, number] {
  if (x === 0) return ["0", 1];
  const [d, e, toZero] = digitsOf(x, o, n, nMin, room);
  return toZero ? ["0", 1 - p] : [d, e];
}
// NumPy formats into a buffer of DRAGON4_BUFFER chars (with the NUL): the two
// formatters below follow dragon4.c's arithmetic on it, so a result that would
// not fit is refused or cut exactly where NumPy refuses or cuts it.
const DRAGON4_BUFFER = 16384;
const tooLarge = () => raise(T.RuntimeError, "Float formatting result too large");
// np.format_float_positional: NumPy's FormatPositional (dragon4.c)
export function dragon4Positional(x: number, o: Dragon4 & { fractional?: boolean }): string {
  if (!Number.isFinite(x)) return nonFinite(x, o.sign);
  const fractional = o.fractional !== false;
  const p = o.precision ?? 0;
  const minDigits = o.minDigits ?? -1, left = o.padLeft ?? -1, right = o.padRight ?? -1;
  const max = DRAGON4_BUFFER - 1;
  const buf: string[] = [];
  let pos = 0;
  const sign = signOf(x, o.sign);
  const hasSign = sign ? 1 : 0;
  if (sign) buf[pos++] = sign;
  const [digits, exp] = dragonDigits(x, o, (e) => (fractional ? e + p : p), (e) => (fractional ? e : 0) + (o.minDigits ?? 0), p, max - hasSign);
  let numDigits = digits.length, numWhole: number, numFrac = 0;
  if (exp > 0) {
    numWhole = exp;
    if (numDigits <= numWhole) {
      for (let i = 0; i < numDigits; i++) buf[pos++] = digits[i];
      const count = numWhole - numDigits;
      if (count > max - pos) tooLarge();
      for (let i = 0; i < count; i++) buf[pos++] = "0";
    } else {
      numFrac = Math.min(numDigits - numWhole, max - numWhole - 1 - pos);
      for (let i = 0; i < numWhole; i++) buf[pos++] = digits[i];
      buf[pos++] = ".";
      for (let i = 0; i < numFrac; i++) buf[pos++] = digits[numWhole + i];
    }
  } else {
    if (pos + 2 < max) {
      const zeros = Math.min(-exp, max - 2 - pos);
      const start = 2 + zeros;
      const nd = Math.min(numDigits, max - start - pos);
      for (let i = 0; i < zeros; i++) buf[pos + 2 + i] = "0";
      for (let i = 0; i < nd; i++) buf[pos + start + i] = digits[i];
      numFrac = nd + zeros;
    }
    if (pos + 1 < max) buf[pos + 1] = ".";
    if (pos < max) buf[pos] = "0";
    numWhole = 1;
    pos += 2 + numFrac;
  }
  if (o.trim !== "-" && numFrac === 0 && pos < max) buf[pos++] = ".";
  const add = o.unique ? minDigits : (o.precision ?? -1);
  const desired = fractional ? Math.max(add, 0) : add - numWhole;
  if (o.trim === "0") {
    if (numFrac === 0 && pos < max) { buf[pos++] = "0"; numFrac++; }
  } else if (o.trim === "k" && desired > numFrac && pos < max) {
    const count = desired - numFrac;
    if (count > max - pos) tooLarge();
    for (let i = 0; i < count; i++) buf[pos++] = "0";
    numFrac += count;
  }
  if (o.trim !== "k" && numFrac > 0) {
    while (buf[pos - 1] === "0") { pos--; numFrac--; }
    if (buf[pos - 1] === ".") {
      if (o.trim === "0") { buf[pos++] = "0"; numFrac++; }
      else if (o.trim === "-") pos--;
    }
  }
  if (right >= numFrac) {
    const count = right - numFrac;
    if (o.trim === "-" && numFrac === 0 && pos < max) buf[pos++] = " ";
    if (count > max - pos) tooLarge();
    for (let i = 0; i < count; i++) buf[pos++] = " ";
  }
  let out = buf.slice(0, pos).join("");
  if (left > numWhole + hasSign) {
    const shift = left - (numWhole + hasSign);
    if (pos > max - shift) tooLarge();
    out = " ".repeat(shift) + out;
  }
  return out;
}
// np.format_float_scientific: NumPy's FormatScientific (dragon4.c), with its
// buffer bookkeeping as it is (the zeros added for a precision are not counted
// against the room left, so a long result can end past the buffer's size)
export function dragon4Scientific(x: number, o: Dragon4 & { expDigits?: number | null }): string {
  if (!Number.isFinite(x)) return nonFinite(x, o.sign);
  const p = o.precision ?? 0;
  const left = o.padLeft ?? -1;
  const buf: string[] = [];
  let at = 0, room = DRAGON4_BUFFER;
  const sign = signOf(x, o.sign);
  const leftChars = 1 + (sign ? 1 : 0);
  for (let i = 0; i < left - leftChars && room > 1; i++) { buf[at++] = " "; room--; }
  if (sign && room > 1) { buf[at++] = sign; room--; }
  // Dragon4 gets min_digits + 1 as a C int: from 2**31 - 1 that wraps to a
  // negative, no minimum at all (the zeros are still added below)
  const dragon = o.minDigits != null && o.minDigits >= 2147483647 ? { ...o, minDigits: null } : o;
  const [digits, exp] = dragonDigits(x, dragon, () => p + 1, () => (o.minDigits ?? 0) + 1, p, room);
  const e = x === 0 ? 0 : exp - 1;
  for (let i = 0; i < digits.length; i++) buf[at + i] = digits[i];
  if (room > 1) { at++; room--; }
  let numFrac = digits.length - 1;
  if (numFrac > 0 && room > 1) {
    numFrac = Math.min(numFrac, room - 2);
    for (let i = numFrac; i > 0; i--) buf[at + i] = buf[at + i - 1];
    buf[at] = ".";
    at += 1 + numFrac;
    room -= 1 + numFrac;
  }
  if (o.trim !== "-" && numFrac === 0 && room > 1) { buf[at++] = "."; room--; }
  const add = Math.max(o.unique ? (o.minDigits ?? -1) : p, 0);
  if (o.trim === "0") {
    if (numFrac === 0 && room > 1) { buf[at++] = "0"; room--; numFrac++; }
  } else if (o.trim === "k" && add > numFrac) {
    const zeros = Math.min(add - numFrac, room - 1);
    for (let i = 0; i < zeros; i++) buf[at++] = "0";
    numFrac += zeros;
  }
  if (o.trim !== "k" && numFrac > 0) {
    at--;
    while (buf[at] === "0") { at--; room++; numFrac--; }
    if (o.trim === "0" && buf[at] === ".") { buf[++at] = "0"; room--; numFrac++; }
    at++;
  }
  if (room > 1) {
    let ed = o.expDigits ?? -1;
    if (ed > 5) ed = 5;
    if (ed < 0) ed = 2;
    // at least ed digits, without leading zeros past them (exponent 0 with
    // exp_digits=0 has no digits at all)
    const digs = e === 0 ? "0".repeat(ed) : String(Math.abs(e)).padStart(ed, "0");
    const text = ("e" + (e < 0 ? "-" : "+") + digs).slice(0, room - 1);
    for (const c of text) buf[at++] = c;
  }
  return buf.slice(0, at).join("");
}
// (the array printer's former helpers, on Dragon4)
function positional(x: number, precision: number, trimZeros: boolean, minDigits = 0): string {
  return dragon4Positional(x, { precision, unique: true, trim: trimZeros ? "." : "k", sign: false, minDigits });
}

type Fmt = (x: number) => string;
// NumPy's FloatingFormat (numpy/_core/arrayprint.py, legacy=False): one
// format for the values shown, by floatmode, suppress and sign.  signMode
// is the sign option ("-", "+" or " "); the imaginary parts use "+".
function floatFormatter(vals: number[], signMode = printopts.sign as string): Fmt {
  const finite = vals.filter((v) => Number.isFinite(v));
  const abs = finite.map(Math.abs).filter((v) => v !== 0);
  const floatmode = printopts.floatmode as string;
  let precision: number | null = floatmode === "unique" ? null : printopts.precision;
  // NumPy hands the precision to Dragon4 as a C int (lib/numpy passes 2**31
  // or 2**63 for any precision that large)
  if (precision !== null && finite.length && precision > 2147483647) {
    raise(T.OverflowError, `Python int too large to convert to C ${precision >= 2 ** 63 ? "long" : "int"}`);
  }
  let expFormat = false;
  if (abs.length) {
    const mx = Math.max(...abs), mn = Math.min(...abs);
    // (scientific from 10**min(8, finfo(dtype).precision) up: 1e6 for
    // float32 and complex64, 1e8 for float64, as NumPy 2's fillFormat)
    const cutoff = printingF32 ? 1e6 : 1e8;
    if (mx >= cutoff || (!printopts.suppress && (mn < 0.0001 || mx / mn > 1000))) expFormat = true;
  }
  const plus = signMode === "+";
  const f32 = printingF32;
  let padLeft = 0, padRight = 0, expSize = -1, trim: Trim = ".", unique = true, minDigits: number | null = 0;
  if (finite.length === 0) {
    trim = "."; unique = true; minDigits = null;
  } else if (expFormat) {
    const fixed = floatmode === "fixed";
    const strs = finite.map((v) => dragon4Scientific(v, { precision, unique: !fixed, trim: fixed ? "k" : ".", sign: plus, f32 }));
    const parts = strs.map((s) => s.split("e"));
    const ints = parts.map((p) => p[0].split(".")[0]);
    const fracs = parts.map((p) => p[0].split(".")[1] ?? "");
    expSize = Math.max(...parts.map((p) => p[1].length)) - 1;
    trim = "k";
    precision = Math.max(...fracs.map((f) => f.length));
    minDigits = precision;
    unique = !fixed;
    padLeft = Math.max(...ints.map((s) => s.length));
    padRight = expSize + 2 + precision;
  } else {
    const fixed = floatmode === "fixed";
    const strs = finite.map((v) => dragon4Positional(v, { precision, unique: !fixed, trim: fixed ? "k" : ".", sign: plus, f32 }));
    padLeft = Math.max(...strs.map((s) => s.split(".")[0].length));
    padRight = Math.max(...strs.map((s) => s.split(".")[1]?.length ?? 0));
    unique = !fixed;
    if (fixed || floatmode === "maxprec_equal") {
      precision = minDigits = padRight;
      trim = "k";
    } else {
      trim = ".";
      minDigits = 0;
    }
  }
  // sign " ": room for a sign that is not there
  if (signMode === " " && !finite.some((v) => v < 0 || Object.is(v, -0))) padLeft += 1;
  const nanstr = String(printopts.nanstr), infstr = String(printopts.infstr);
  if (finite.length !== vals.length) {
    const neginf = signMode !== "-" || vals.some((v) => v === -Infinity) ? 1 : 0;
    const offset = padRight + 1;
    padLeft = Math.max(padLeft, nanstr.length - offset, infstr.length + neginf - offset);
  }
  const width = padLeft + padRight + 1;
  const o = { precision, unique, trim, sign: plus, padLeft, minDigits, f32 };
  return (x) => {
    // fitted to no finite values, NumPy's FloatingFormat has min_digits None,
    // which Dragon4 refuses for a finite one (edgeitems <= 0 can show one)
    if (finite.length === 0 && Number.isFinite(x)) raise(T.TypeError, "'NoneType' object cannot be interpreted as an integer");
    if (!Number.isFinite(x)) {
      const s = x !== x ? (plus ? "+" : "") + nanstr : (x < 0 ? "-" : plus ? "+" : "") + infstr;
      return s.padStart(width);
    }
    if (expFormat) return dragon4Scientific(x, { ...o, expDigits: expSize });
    return dragon4Positional(x, { ...o, padRight });
  };
}

// NumPy's IntegerFormat, with the sign option
function intFormatter(strs: string[], signMode: string): (s: string) => string {
  if (!strs.length) return (s) => (signMode !== "-" && !s.startsWith("-") ? (signMode === "+" ? "+" : " ") + s : s);
  const neg = strs.some((s) => s.startsWith("-"));
  const mode = signMode === " " && neg ? "-" : signMode;
  const nums = strs.map((s) => BigInt(s));
  let max = nums[0], min = nums[0];
  for (const v of nums) { if (v > max) max = v; if (v < min) min = v; }
  let w = String(max).length;
  if (max >= 0n && (mode === "+" || mode === " ")) w += 1;
  w = Math.max(w, String(min).length);
  return (s) => (mode !== "-" && !s.startsWith("-") ? (mode === "+" ? "+" : " ") + s : s).padStart(w);
}

// The formatter for an array's elements, by their positions in a.data: its
// widths come from the elements at `positions`.
function elementFormatter(a: NDArray, positions: number[]): (p: number) => string {
  const dt = a.dt;
  // a formatter function for the kind: called with each element (as a NumPy scalar)
  const user = printopts.fmt[dt.cplx ? "c" : dt.kind === "b" ? "b" : dt.isInt ? "i" : "f"];
  if (user) return (p) => F.str(Obj.callObj(user, [pyScalarOf(dt, a.data, p)]));
  if (dt.kind === "b") {
    const w = a.ndim === 0 ? 0 : 5; // NumPy's BoolFormat: " True" in arrays
    return (p) => (a.data[p] ? "True" : "False").padStart(w);
  }
  if (dt.isInt) {
    const str = (p: number) => {
      const v = a.data[p] as number;
      return String(Number.isSafeInteger(v) ? v : BigInt(v));
    };
    const f = intFormatter(positions.map(str), printopts.sign as string);
    return (p) => f(str(p));
  }
  if (dt.cplx) {
    const rf = floatFormatter(positions.map((p) => a.data[2 * p] as number));
    const imf = floatFormatter(positions.map((p) => a.data[2 * p + 1] as number), "+");
    return (p) => {
      const r = rf(a.data[2 * p] as number);
      const im = imf(a.data[2 * p + 1] as number);
      const sp = im.trimEnd().length;
      return r + im.slice(0, sp) + "j" + " ".repeat(im.length - sp);
    };
  }
  const f = floatFormatter(positions.map((p) => a.data[p] as number));
  return (p) => f(a.data[p] as number);
}

// The indices of range(n)[start:stop], with Python's slice rules
function sliceRange(n: number, start: number, stop: number): number[] {
  const at = (i: number) => (i < 0 ? Math.max(n + i, 0) : Math.min(i, n));
  const out: number[] = [];
  for (let i = at(start); i < at(stop); i++) out.push(i);
  return out;
}

// The text of an array's elements: a port of NumPy's _formatArray and
// _extendLine (numpy/_core/arrayprint.py, legacy=False).  `prefix` is what
// precedes the "[" ("array(" for repr), `suffix` what follows it.
export function arrayText(a: NDArray, sep: string, prefix: string, suffix = ""): string {
  printingF32 = a.dt === D.float32 || a.dt === D.complex64;
  try {
    return arrayText1(a, sep, prefix, suffix);
  } finally {
    printingF32 = false;
  }
}
function arrayText1(a: NDArray, sep: string, prefix: string, suffix: string): string {
  const summarize = a.size > printopts.threshold;
  const edge = printopts.edgeitems;
  // the elements the formatter is fitted to: NumPy's _leading_trailing,
  // a[:edge] and a[-edge:] along each axis (with edgeitems <= 0 these are
  // slices of most or all of it)
  const fitted: number[] = [];
  const fit = (d: number, off: number) => {
    const n = a.shape[d];
    const idx = summarize && n > 2 * edge ? [...sliceRange(n, 0, edge), ...sliceRange(n, -edge, n)] : sliceRange(n, 0, n);
    for (const i of idx) {
      if (d === a.ndim - 1) fitted.push(off + i * a.strides[d]);
      else fit(d + 1, off + i * a.strides[d]);
    }
  };
  // the elements shown, in the order rec shows them (NumPy's _formatArray):
  // the leading ones, the trailing ones and always the last
  const shown: number[] = [];
  const showIdx = (n: number) => {
    const sum = summarize && 2 * edge < n;
    const idx: number[] = [];
    for (let i = 0; i < (sum ? edge : 0); i++) idx.push(i);
    for (let i = sum ? edge : n; i > 1; i--) idx.push(n - i);
    idx.push(n - 1);
    return idx;
  };
  const show = (d: number, off: number) => {
    for (const i of showIdx(a.shape[d])) {
      if (d === a.ndim - 1) shown.push(off + i * a.strides[d]);
      else show(d + 1, off + i * a.strides[d]);
    }
  };
  if (a.ndim === 0) fitted.push(a.offset);
  else fit(0, a.offset);
  const fmtAt = elementFormatter(a, fitted);
  if (a.ndim === 0) return fmtAt(a.offset);
  show(0, a.offset);
  const fmt = (i: number) => fmtAt(shown[i]);
  let pos = 0;
  const lineWidth = printopts.linewidth - suffix.length;
  const nextLinePrefix = " " + " ".repeat(prefix.length);
  const extend = (st: { s: string; line: string }, word: string, width: number, hanging: string) => {
    let wrap = st.line.length + word.length > width;
    if (st.line.length <= hanging.length) wrap = false; // wrapping would not help
    if (wrap) {
      st.s += st.line.trimEnd() + "\n";
      st.line = hanging;
    }
    st.line += word;
  };
  const rec = (d: number, hanging: string, currWidth: number): string => {
    const axesLeft = a.ndim - d;
    const nextHanging = hanging + " ";
    const nextWidth = currWidth - 1;
    const n = a.shape[d];
    const showSummary = summarize && 2 * edge < n;
    const leading = showSummary ? edge : 0;
    const trailing = showSummary ? edge : n;
    let s = "";
    if (axesLeft === 1) {
      const elemWidth = currWidth - Math.max(sep.trimEnd().length, 1);
      const st = { s: "", line: hanging };
      for (let i = 0; i < leading; i++) {
        extend(st, fmt(pos++), elemWidth, hanging);
        st.line += sep;
      }
      if (showSummary) {
        extend(st, "...", elemWidth, hanging);
        st.line += sep;
      }
      for (let i = trailing; i > 1; i--) {
        extend(st, fmt(pos++), elemWidth, hanging);
        st.line += sep;
      }
      extend(st, fmt(pos++), elemWidth, hanging);
      s = st.s + st.line;
    } else {
      const lineSep = sep.trimEnd() + "\n".repeat(axesLeft - 1);
      for (let i = 0; i < leading; i++) s += hanging + rec(d + 1, nextHanging, nextWidth) + lineSep;
      if (showSummary) s += hanging + "..." + lineSep;
      for (let i = trailing; i > 1; i--) s += hanging + rec(d + 1, nextHanging, nextWidth) + lineSep;
      s += hanging + rec(d + 1, nextHanging, nextWidth);
    }
    return "[" + s.slice(hanging.length) + "]";
  };
  return rec(0, nextLinePrefix, lineWidth);
}

export function arrayRepr(a: NDArray, override = true): string {
  // np.set_printoptions(override_repr=f): repr(array) is f(array)
  if (override && printopts.overrideRepr) {
    const r = Obj.callObj(printopts.overrideRepr, [a]);
    if (typeof r !== "string") raise(T.TypeError, `__repr__ returned non-string (type ${Obj.typeName(r)})`);
    return r;
  }
  const skipDtype = a.dt === D.float64 || a.dt === D.int64 || a.dt === D.bool || a.dt === D.complex128;
  if (a.size === 0) {
    const sh = a.ndim === 1 ? "" : `shape=${shapeStr(a.shape).replace(/,/g, ", ").replace(", )", ",)")}, `;
    return `array([], ${sh}dtype=${a.dt.name})`;
  }
  const arrStr = "array(" + arrayText(a, ", ", "array(", ")") + ")";
  // NumPy 2.2: a summarized array also shows its shape
  const extras: string[] = [];
  if (a.size > printopts.threshold) extras.push(`shape=${shapeStr(a.shape).replace(/,(?=\d)/g, ", ")}`);
  if (!skipDtype) extras.push(`dtype=${a.dt.name}`);
  if (!extras.length) return arrStr;
  const extraStr = extras.join(", ") + ")";
  const lastLine = arrStr.length - (arrStr.lastIndexOf("\n") + 1);
  const spacer = lastLine + extraStr.length + 1 > printopts.linewidth ? "\n" + " ".repeat(6) : " ";
  return arrStr.slice(0, -1) + "," + spacer + extraStr;
}
export function arrayStr(a: NDArray): string {
  if (a.size === 0) return "[]";
  // a 0-d array prints as its element does
  if (a.ndim === 0) return F.str(pyScalarOf(a.dt, a.data, a.offset));
  return arrayText(a, " ", "");
}

// ------------------------------------------------------------------ sorting

// argsort of a 1-D integer array of moderate size and range: pack value and
// index into one double (v * 2^21 + i) and use the native numeric sort; stable.
function argsortInts(a: NDArray): NDArray | null {
  const n = a.size;
  if (a.ndim !== 1 || !a.dt.isInt && a.dt.kind !== "b" || n >= 1 << 21) return null;
  admitWork(16 * n, "argsort");
  const keys = new Float64Array(n), d = a.data, st = a.strides[0];
  for (let i = 0, p = a.offset; i < n; i++, p += st) {
    const v = d[p];
    if (v < -(2 ** 31) || v >= 2 ** 31) return null;
    keys[i] = v * 2097152 + i;
  }
  keys.sort();
  const out = empty([n], D.int64);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    out.data[i] = k - Math.floor(k / 2097152) * 2097152;
  }
  return out;
}

function sortAxis(a: NDArray, axis: number, arg: boolean): NDArray {
  // (every path's outputs and scratch, at most: two copies of a (contiguous,
  // and the result moved back), the output (int64 for argsort), and per
  // element float64 values, an index and WebAssembly's sort buffers: 40
  // bytes; a uint8 array's argsort needs 2 * 1 + 8 + 40 = 50 bytes an
  // element; LIMIT-PR55-3)
  admitWork(a.size * (2 * a.dt.itemsize + (arg ? 8 : a.dt.itemsize) + 40), arg ? "argsort" : "sort");
  if (arg && a.ndim === 1 && !a.dt.cplx && a.size >= 64) {
    // the WebAssembly radix sort (stable, as the comparison sort below)
    const c = ascontig(a);
    const vals = Float64Array.from(c.data.subarray(c.offset, c.offset + a.size) as any);
    const out = empty([a.size], D.int64);
    if (wasmArgsort(vals, out.data as Float64Array, 0)) return out;
  }
  if (arg && a.ndim === 1) {
    const r = argsortInts(a);
    if (r) return r;
  }
  if (!arg && !a.dt.cplx) {
    // the typed array's own numeric sort (NaN last, as NumPy) on each row
    const t = ascontig(moveAxisToEnd(a, axis));
    const out = copy(t);
    const n = t.shape[t.ndim - 1];
    const f64 = out.data instanceof Float64Array;
    if (n > 1) for (let base = 0; base < out.size; base += n) {
      const row = out.data.subarray(base, base + n);
      if (!(f64 && wasmSort(row as Float64Array))) row.sort();
    }
    const order = a.shape.map((_, i) => i).filter((i) => i !== axis);
    const inv = new Array(a.ndim);
    [...order, axis].forEach((src, dst) => (inv[src] = dst));
    return ascontig(transpose(out, inv));
  }
  const t = moveAxisToEnd(a, axis);
  const n = t.shape[t.ndim - 1], st = t.strides[t.ndim - 1];
  const out = empty(arg ? t.shape : t.shape, arg ? D.int64 : a.dt);
  if (a.dt.cplx) {
    // NumPy's complex order: by real part, then imaginary part, with nan
    // placed last: R + Rj < R + nanj < nan + Rj < nan + nanj (stable)
    const re = new Float64Array(n), im = new Float64Array(n);
    const ix = new Array(n);
    const ccmp = (i: number, j: number) => {
      const ri = re[i] !== re[i], rj = re[j] !== re[j], ii = im[i] !== im[i], ij = im[j] !== im[j];
      if (ri !== rj) return ri ? 1 : -1;
      if (ii !== ij) return ii ? 1 : -1;
      if (!ri && re[i] !== re[j]) return re[i] < re[j] ? -1 : 1;
      if (!ii && im[i] !== im[j]) return im[i] < im[j] ? -1 : 1;
      return i - j;
    };
    loop1(t.shape.slice(0, -1), t.strides.slice(0, -1), t.offset, (base, k) => {
      for (let i = 0; i < n; i++) {
        re[i] = t.data[2 * (base + i * st)];
        im[i] = t.data[2 * (base + i * st) + 1];
        ix[i] = i;
      }
      ix.sort(ccmp);
      for (let i = 0; i < n; i++) {
        if (arg) out.data[k * n + i] = ix[i];
        else {
          out.data[2 * (k * n + i)] = re[ix[i]];
          out.data[2 * (k * n + i) + 1] = im[ix[i]];
        }
      }
    });
    const order = a.shape.map((_, i) => i).filter((i) => i !== axis);
    const inv = new Array(a.ndim);
    [...order, axis].forEach((src, dst) => (inv[src] = dst));
    return ascontig(transpose(out, inv));
  }
  const vals = new Float64Array(n);
  const idx = new Array(n);
  const cmp = (i: number, j: number) => {
    const x = vals[i], y = vals[j];
    if (x !== x) return y !== y ? i - j : 1;
    if (y !== y) return -1;
    return x < y ? -1 : x > y ? 1 : i - j;
  };
  loop1(t.shape.slice(0, -1), t.strides.slice(0, -1), t.offset, (base, k) => {
    for (let i = 0; i < n; i++) {
      vals[i] = t.data[base + i * st];
      idx[i] = i;
    }
    idx.sort(cmp);
    for (let i = 0; i < n; i++) out.data[k * n + i] = arg ? idx[i] : vals[idx[i]];
  });
  // move the axis back
  const back = a.shape.map((_, i) => i);
  const order = back.filter((i) => i !== axis);
  const inv = new Array(a.ndim);
  [...order, axis].forEach((src, dst) => (inv[src] = dst));
  return ascontig(transpose(out, inv));
}

// ------------------------------------------------------------------ the Python module

newBuiltinModule("_numpy", (m) => {
  const fn = (name: string, f: any, s: Obj.Signature | null = null) => (m[name] = Obj.builtin(f, name, s));
  const opt = (x: any) => (x === undefined ? null : x);

  // dtype
  const DT = Ty.builtinTypeFor("dtype", DType, "numpy", (x: any) => toDtype(x));
  const DM = (name: string, f: any) => Ty.method(DT, name, f);
  Ty.getset(DT, "name", (d: DType) => d.name);
  Ty.getset(DT, "kind", (d: DType) => d.kind);
  Ty.getset(DT, "char", (d: DType) => d.char);
  Ty.getset(DT, "itemsize", (d: DType) => d.itemsize);
  Ty.getset(DT, "type", (d: DType) => scalarCtors[d.name] ?? null);
  DM("__repr__", (d: DType) => `dtype('${d.name}')`);
  DM("__str__", (d: DType) => d.name);
  DM("__eq__", (d: DType, o: any) => {
    try {
      return toDtype(o) === d;
    } catch {
      return false;
    }
  });
  DM("__ne__", (d: DType, o: any) => {
    try {
      return toDtype(o) !== d;
    } catch {
      return true;
    }
  });
  DM("__hash__", (d: DType) => O.hashAny(d.name));
  m.dtype = DT;
  for (const k of Object.keys(D)) m["dtype_" + k] = D[k];

  // ndarray
  const A = Ty.builtinTypeFor("ndarray", NDArray, "numpy", (shape: any, dtype: any = null) => empty(shapeArg(shape), toDtype(dtype ?? null)));
  const M = (name: string, f: any, s: Obj.Signature | null = null) => Ty.method(A, name, f, s);
  Ty.getset(A, "shape", (a: NDArray) => tuple(a.shape.slice()), (a: NDArray, v: any) => {
    const r = reshape(a, shapeArg(v));
    if (r.data !== a.data) raise(T.AttributeError, "Incompatible shape for in-place modification. Use `.reshape()` to make a copy with the desired shape.");
    a.shape = r.shape;
    a.strides = r.strides;
  });
  Ty.getset(A, "ndim", (a: NDArray) => a.ndim);
  Ty.getset(A, "size", (a: NDArray) => a.size);
  Ty.getset(A, "dtype", (a: NDArray) => a.dt);
  Ty.getset(A, "itemsize", (a: NDArray) => a.dt.itemsize);
  Ty.getset(A, "nbytes", (a: NDArray) => a.dt.itemsize * a.size);
  Ty.getset(A, "strides", (a: NDArray) => tuple(a.strides.map((s) => s * a.dt.itemsize)));
  Ty.getset(A, "T", (a: NDArray) => transpose(a, null));
  Ty.getset(A, "mT", (a: NDArray) => transpose(a, [...a.shape.keys()].map((i) => (i === a.ndim - 1 ? a.ndim - 2 : i === a.ndim - 2 ? a.ndim - 1 : i))));
  Ty.getset(A, "base", (a: NDArray) => a.base ?? a.bufBase);
  Ty.getset(A, "flags", (a: NDArray) => new FlagsObj(a));
  M("setflags", (a: NDArray, write: any = null, align: any = null, uic: any = null) => {
    if (uic !== null && uic !== undefined && O.truth(uic)) raise(T.ValueError, "cannot set WRITEBACKIFCOPY flag to True");
    if (align !== null && align !== undefined) a.unaligned = !O.truth(align);
    if (write !== null && write !== undefined) setWriteable(a, O.truth(write));
    return null;
  }, Obj.sig(["self", "write", "align", "uic"]));
  const FT = Ty.builtinTypeFor("flagsobj", FlagsObj, "numpy", () => raise(T.TypeError, "cannot create 'numpy.flagsobj' instances"));
  const FM = (name: string, f: any) => Ty.method(FT, name, f);
  // (each flag: its attribute, its keys, and its value)
  // (each flag from the snapshot's bits n)
  const has = (n: number, bit: number) => (n & bit) !== 0;
  const FLAG: [string, string[], (n: number) => boolean][] = [
    ["c_contiguous", ["C", "CONTIGUOUS", "C_CONTIGUOUS"], (n) => has(n, F_C)],
    ["f_contiguous", ["F", "FORTRAN", "F_CONTIGUOUS"], (n) => has(n, F_F)],
    ["owndata", ["O", "OWNDATA"], (n) => has(n, F_OWN)],
    ["writeable", ["W", "WRITEABLE"], (n) => has(n, F_WRITE)],
    ["aligned", ["A", "ALIGNED"], (n) => has(n, F_ALIGNED)],
    ["writebackifcopy", ["X", "WRITEBACKIFCOPY"], () => false],
    ["fnc", ["FNC"], (n) => has(n, F_F) && !has(n, F_C)],
    ["forc", ["FORC"], (n) => has(n, F_F) || has(n, F_C)],
    ["behaved", ["B", "BEHAVED"], (n) => has(n, F_ALIGNED) && has(n, F_WRITE)],
    ["carray", ["CA", "CARRAY"], (n) => has(n, F_C) && has(n, F_ALIGNED) && has(n, F_WRITE)],
    // (NumPy's farray: any of F, aligned, writeable, and not C contiguous)
    ["farray", ["FA", "FARRAY"], (n) => (n & (F_F | F_ALIGNED | F_WRITE)) !== 0 && !has(n, F_C)],
  ];
  const setFlag = (a: NDArray, name: string, v: any) => {
    if (name === "writeable") setWriteable(a, O.truth(v));
    else if (name === "aligned") a.unaligned = !O.truth(v);
    else if (O.truth(v)) raise(T.ValueError, "cannot set WRITEBACKIFCOPY flag to True");
  };
  for (const [name, , get] of FLAG) {
    const settable = name === "writeable" || name === "aligned" || name === "writebackifcopy";
    Ty.getset(FT, name, (f: FlagsObj) => get(f.num), settable ? (f: FlagsObj, v: any) => setFlag(f.a, name, v) : () => raise(T.AttributeError, `attribute '${name}' of 'numpy._core.multiarray.flagsobj' objects is not writable`));
  }
  Ty.getset(FT, "num", (f: FlagsObj) => f.num);
  const keyOf = (k: any): [string, (n: number) => boolean] | undefined => {
    if (typeof k !== "string") return undefined;
    for (const [name, keys, get] of FLAG) if (keys.includes(k)) return [name, get];
    return undefined;
  };
  FM("__getitem__", (f: FlagsObj, k: any) => {
    const hit = keyOf(k);
    if (hit === undefined) throw T.KeyError("Unknown flag");
    return hit[1](f.num);
  });
  FM("__setitem__", (f: FlagsObj, k: any, v: any) => {
    const hit = keyOf(k);
    if (hit === undefined || !["writeable", "aligned", "writebackifcopy"].includes(hit[0])) throw T.KeyError("Unknown flag");
    setFlag(f.a, hit[0], v);
    return null;
  });
  const flagsText = (f: FlagsObj) =>
    ["C_CONTIGUOUS", "F_CONTIGUOUS", "OWNDATA", "WRITEABLE", "ALIGNED", "WRITEBACKIFCOPY"]
      .map((k, i) => `  ${k} : ${FLAG[i][2](f.num) ? "True" : "False"}`).join("\n") + "\n";
  FM("__repr__", flagsText);
  FM("__str__", flagsText);
  FM("__eq__", (f: FlagsObj, g: any) => (g instanceof FlagsObj ? f.num === g.num : Obj.NotImplemented));
  Ty.getset(A, "real", (a: NDArray) => realPart(a), (a: NDArray, v: any) => assign(realPart(a), asarray(v)));
  Ty.getset(A, "imag", (a: NDArray) => imagPart(a), (a: NDArray, v: any) => assign(imagPart(a), asarray(v)));
  // (a noncontiguous array's .flat is a copy: read-only, so that a write
  // raises instead of being silently lost)
  Ty.getset(A, "flat", (a: NDArray) => {
    if (a.isC()) return ravel(a);
    const c = ravel(copy(a));
    c.ro = true;
    return c;
  });
  Ty.getset(A, "__array_priority__", () => 0);
  M("__len__", (a: NDArray) => (a.ndim === 0 ? raise(T.TypeError, "len() of unsized object") : a.shape[0]));
  M("__getitem__", (a: NDArray, k: any) => getitem(a, k));
  M("__setitem__", (a: NDArray, k: any, v: any) => (setitem(a, k, v), null));
  M("__iter__", (a: NDArray) => {
    if (a.ndim === 0) raise(T.TypeError, "iteration over a 0-d array");
    const items = new Array(a.shape[0]);
    for (let i = 0; i < a.shape[0]; i++) items[i] = getitem(a, i);
    return new O.ListIter(items);
  });
  M("__repr__", (a: NDArray) => arrayRepr(a));
  M("__str__", (a: NDArray) => arrayStr(a));
  M("__bool__", (a: NDArray) => {
    if (a.size !== 1) raise(T.ValueError, "The truth value of an array with more than one element is ambiguous. Use a.any() or a.all()");
    return a.dt.cplx ? a.data[2 * a.offset] !== 0 || a.data[2 * a.offset + 1] !== 0 : a.data[a.offset] !== 0;
  });
  const scalarOf = (a: NDArray) => {
    if (a.size !== 1) raise(T.TypeError, "only length-1 arrays can be converted to Python scalars");
    const c = ascontig(a);
    return pyPlain(a.dt, c.data, 0);
  };
  M("__float__", (a: NDArray) => O.mkfloat(toNum(scalarOf(a))));
  M("__int__", (a: NDArray) => Math.trunc(toNum(scalarOf(a))));
  M("__complex__", (a: NDArray) => {
    const v = scalarOf(a);
    return v instanceof PyComplex ? v : new PyComplex(toNum(v), 0);
  });
  M("__index__", (a: NDArray) => {
    if (!a.dt.isInt || a.size !== 1) raise(T.TypeError, "only integer scalar arrays can be converted to a scalar index");
    return scalarOf(a);
  });
  M("__hash__", () => raise(T.TypeError, "unhashable type: 'numpy.ndarray'"));
  A.$dict.set("__hash__", null);
  const BINOPS: [string, string][] = [
    ["add", "add"], ["sub", "subtract"], ["mul", "multiply"], ["truediv", "true_divide"], ["floordiv", "floor_divide"],
    ["mod", "remainder"], ["pow", "power"], ["and", "bitwise_and"], ["or", "bitwise_or"], ["xor", "bitwise_xor"],
    ["lshift", "left_shift"], ["rshift", "right_shift"],
  ];
  const isOperand = (o: any) => o instanceof NDArray || pyScalar(o) !== null || Array.isArray(o);
  const boolOp = (op: string) => (op === "bitwise_and" ? "logical_and" : op === "bitwise_or" ? "logical_or" : op === "bitwise_xor" ? "logical_xor" : op);
  for (const [py, op] of BINOPS) {
    const pick = (a: any, b: any) => {
      const both = operand(a).arr.dt.kind === "b" && operand(b).arr.dt.kind === "b";
      return both ? boolOp(op) : op;
    };
    M(`__${py}__`, (a: NDArray, o: any) => {
      if (!isOperand(o)) return NotImplemented;
      const f = py === "pow" ? fastScalarPower(a, o) : null;
      return (O.FRESH.v = f !== null ? unary(f, a) : binary(pick(a, o), a, o));
    }).$fresh = true;
    M(`__r${py}__`, (a: NDArray, o: any) => (isOperand(o) ? (O.FRESH.v = binary(pick(o, a), o, a)) : NotImplemented)).$fresh = true;
    M(`__i${py}__`, (a: NDArray, o: any) => {
      if (!isOperand(o)) return NotImplemented;
      // (the target is the output: NumPy's words, before any computing)
      outWritable(a);
      const f = py === "pow" ? fastScalarPower(a, o) : null;
      if (f !== null) {
        const r = unary(f, a);
        if (r.dt !== a.dt && !(promote(r.dt, a.dt) === a.dt)) raise(T.UFuncTypeError ?? T.TypeError, `Cannot cast ufunc '${f}' output from dtype('${r.dt.name}') to dtype('${a.dt.name}') with casting rule 'same_kind'`);
        assign(a, r);
        return a;
      }
      // in place when the result has a's dtype and shape and o is a itself or
      // shares no memory with it
      if ((o === a || !(o instanceof NDArray && o.data.buffer === a.data.buffer)) && binary(pick(a, o), a, o, a, true) !== undefined) return a;
      const r = binary(pick(a, o), a, o);
      const rt = r.dt;
      if (rt !== a.dt && !(promote(rt, a.dt) === a.dt)) raise(T.UFuncTypeError ?? T.TypeError, `Cannot cast ufunc '${op}' output from dtype('${rt.name}') to dtype('${a.dt.name}') with casting rule 'same_kind'`);
      assign(a, r);
      return a;
    });
  }
  M("__matmul__", (a: NDArray, o: any) => matmul(a, o));
  M("__rmatmul__", (a: NDArray, o: any) => matmul(o, a));
  M("__divmod__", (a: NDArray, o: any) => tuple([binary("floor_divide", a, o), binary("remainder", a, o)]));
  const CMPS: [string, string][] = [["eq", "equal"], ["ne", "not_equal"], ["lt", "less"], ["le", "less_equal"], ["gt", "greater"], ["ge", "greater_equal"]];
  for (const [py, op] of CMPS) M(`__${py}__`, (a: NDArray, o: any) => (isOperand(o) ? binary(op, a, o) : py === "eq" ? false : py === "ne" ? true : NotImplemented));
  M("__neg__", (a: NDArray) => (O.FRESH.v = unary("negative", a))).$fresh = true;
  // reuse a temporary operand t (see FRESH in ops.ts) for t op o or o op t
  const REUSE: Record<string, string> = { add: "add", sub: "subtract", mul: "multiply", truediv: "true_divide" };
  const plainOperand = (o: any) => (o instanceof NDArray ? Obj.typeOf(o) === A : typeof o === "number" || typeof o === "boolean" || o instanceof Obj.FloatBox);
  O.FRESH.inplace = (op: string, t: any, o: any, tLeft: boolean) => {
    if (!(t instanceof NDArray) || t.dt.kind === "b" || !plainOperand(o)) return undefined;
    const r = tLeft ? binary(REUSE[op], t, o, t, true) : binary(REUSE[op], o, t, t, true);
    if (r === undefined) return undefined;
    O.FRESH.v = r;
    return r;
  };
  M("__pos__", (a: NDArray) => unary("positive", a));
  M("__abs__", (a: NDArray) => unary("absolute", a));
  M("__invert__", (a: NDArray) => unary("invert", a));
  M("__copy__", (a: NDArray) => copy(a));
  M("__deepcopy__", (a: NDArray) => copy(a));
  M("__array__", (a: NDArray) => a);
  M("copy", (a: NDArray) => copy(a));
  M("tolist", (a: NDArray) => tolist(a));
  M("item", (a: NDArray, ...idx: any[]) => {
    if (idx.length === 0) return scalarOf(a);
    const c = ascontig(a);
    let i = intNum(idx.length === 1 ? idx[0] : 0);
    if (idx.length > 1) i = idx.reduce((acc: number, v: any, d: number) => acc * a.shape[d] + intNum(v), 0);
    if (i < 0) i += a.size;
    return pyPlain(a.dt, c.data, i);
  });
  M("reshape", (a: NDArray, ...s: any[]) => reshape(a, shapeArg(s.length === 1 ? s[0] : tuple(s))));
  M("ravel", (a: NDArray) => ravel(a));
  M("flatten", (a: NDArray) => copy(ravel(a)));
  M("transpose", (a: NDArray, ...axes: any[]) => transpose(a, axes.length === 0 || (axes.length === 1 && axes[0] === null) ? null : shapeArg(axes.length === 1 ? axes[0] : tuple(axes))));
  M("swapaxes", (a: NDArray, x: any, y: any) => {
    const order = a.shape.map((_, i) => i);
    const i = normAxis(Number(x), a.ndim), j = normAxis(Number(y), a.ndim);
    [order[i], order[j]] = [order[j], order[i]];
    return transpose(a, order);
  });
  M("fill", (a: NDArray, v: any) => (assign(a, operand(v).arr), null));
  M("conj", (a: NDArray) => conj(a));
  M("conjugate", (a: NDArray) => conj(a));
  M("view", (a: NDArray) => viewOf(new NDArray(a.dt, a.data, a.shape.slice(), a.strides.slice(), a.offset, a.base ?? a), a));
  m.ndarray = A;

  const shapeArg = (s: any): number[] => {
    if (Array.isArray(s)) return s.map((x: any) => intNum(x));
    if (s instanceof NDArray) return tolist(ravel(s)).map((x: any) => intNum(x));
    return [intNum(s)];
  };
  const conj = (a: NDArray) => {
    if (!a.dt.cplx) return copy(a);
    const c = copy(a);
    for (let k = 0; k < c.size; k++) c.data[2 * k + 1] = -c.data[2 * k + 1];
    return c;
  };

  // creation
  fn("array", (obj: any, dtype: any = null, copyFlag: any = true, ndmin: any = 0) => {
    let r = obj instanceof NDArray ? (copyFlag === false && (dtype === null || toDtype(dtype) === obj.dt) ? obj : copy(obj, dtype === null ? obj.dt : toDtype(dtype))) : fromPy(obj, dtype);
    while (r.ndim < Number(ndmin)) r = reshape(r, [1, ...r.shape]);
    return r;
  });
  fn("asarray", (obj: any, dtype: any = null) => asarray(obj, dtype));
  fn("empty", (shape: any, dtype: any = null) => empty(shapeArg(shape), toDtype(dtype)));
  fn("zeros", (shape: any, dtype: any = null) => empty(shapeArg(shape), toDtype(dtype)));
  fn("ones", (shape: any, dtype: any = null) => {
    const a = empty(shapeArg(shape), toDtype(dtype));
    if (a.dt.cplx) for (let k = 0; k < a.size; k++) a.data[2 * k] = 1;
    else a.data.fill(1);
    return a;
  });
  fn("full", (shape: any, value: any, dtype: any = null) => {
    // (a Python value into int64/uint64 converted once, by the admission)
    if (dtype !== null && isWide(toDtype(dtype)) && !(value instanceof NDArray)) {
      const a = empty(shapeArg(shape), toDtype(dtype));
      assign(a, fromPy(value, a.dt));
      return a;
    }
    const v = operand(value);
    const dt = dtype !== null ? toDtype(dtype) : v.weak ? scalarDtype(v.weak) : v.arr.dt;
    const a = empty(shapeArg(shape), dt);
    assign(a, isWide(dt) && !(value instanceof NDArray) ? fromPy(value, dt) : v.arr);
    return a;
  });
  fn("arange", (start: any, stop: any = null, step: any = null, dtype: any = null) => {
    if (stop === null) {
      stop = start;
      start = 0;
    }
    if (step === null) step = 1;
    const ws = [start, stop, step].map((v) => pyScalar(v));
    const isint = ws.every((w) => w && (w.kind === "i" || w.kind === "b") && (!w.dt || w.dt.isInt));
    const s0 = toNum(start), s1 = toNum(stop), st = toNum(step);
    if (st === 0) raise(T.ZeroDivisionError, "division by zero");
    // (the length as NumPy's _calc_length: ceil((stop - start) / step); a
    // quotient that underflows to 0 from a nonzero span is 1 element, or 0
    // if negative; NaN or past intp refused)
    const span = s1 - s0, q = span / st;
    let n: number;
    if (q === 0 && span !== 0) n = Object.is(q, -0) ? 0 : 1;
    else {
      const c = Math.ceil(q);
      if (Number.isNaN(c)) raise(T.ValueError, "arange: cannot compute length");
      if (!(c >= -9223372036854775808 && c <= 9223372036854775807)) raise(T.ValueError, "Maximum allowed size exceeded");
      n = Math.max(0, c);
    }
    const dt = dtype !== null ? toDtype(dtype) : isint ? D.int64 : D.float64;
    // (an integer progression into int64/uint64: computed exactly, each
    // value admitted: arange(2**53, 2**53 + 4) never rounds)
    if (isint && isWide(dt)) {
      const big = (w: Weak) => w.big ?? BigInt(w.v);
      const [b0, b1, bs] = ws.map((w) => big(w!));
      const span = b1 - b0;
      const nb = span <= 0n === bs > 0n ? 0n : (span + bs - (bs > 0n ? 1n : -1n)) / bs;
      // (the same admission as every array's, before the length is a number)
      admitArray([nb < 0n ? 0n : nb], dt);
      const N = Number(nb < 0n ? 0n : nb);
      const out = empty([N], dt);
      for (let i = 0; i < N; i++) out.data[i] = admitWide(b0 + BigInt(i) * bs, dt);
      return out;
    }
    // (the values as NumPy's: the first two set from start and start + step,
    // the rest filled in the dtype's own arithmetic from them, start + i *
    // delta with delta = second - first (arraytypes.c.src, @NAME@_fill): so
    // arange(-1, 1, 0.1)[10] is -2.220446049250313e-16, and
    // arange(0, 5, 0.5, dtype=int) is all zeros, as NumPy's)
    if (dt.kind === "b" && n > 2) raise(T.TypeError, "arange() is only supported for booleans when the result has at most length 2.");
    const a = empty([n], dt);
    const d = a.data, w = dt.cplx ? 2 : 1;
    if (n > 0) d[0] = castNum(dt, s0);
    if (n > 1) d[w] = castNum(dt, s0 + st);
    if (n > 2) {
      const x0 = d[0], x1 = d[w];
      if (dt.cplx) {
        // (the imaginary parts are 0 + i * 0: real arguments only reach here)
        const del = x1 - x0;
        const f32 = dt.ctor === Float32Array;
        for (let i = 2; i < n; i++) d[2 * i] = f32 ? Math.fround(x0 + Math.fround(Math.fround(i) * Math.fround(del))) : x0 + i * del;
      } else if (dt.kind === "f" && dt.ctor === Float32Array) {
        // (float arithmetic, as C's: i converted to float, each operation rounded)
        const del = Math.fround(x1 - x0);
        for (let i = 2; i < n; i++) d[i] = Math.fround(x0 + Math.fround(Math.fround(i) * del));
      } else if (dt.kind === "f") {
        const del = x1 - x0;
        for (let i = 2; i < n; i++) d[i] = x0 + i * del;
      } else if (isWide(dt)) {
        // (int64 and uint64: exact, and refused past what the store holds)
        const b0 = BigInt(x0), del = BigInt(x1) - b0;
        for (let i = 2; i < n; i++) d[i] = admitWide(b0 + BigInt(i) * del, dt);
      } else {
        // (a narrower integer: delta and each value wrap to the type, as C's store)
        const wrap = new (dt.ctor as any)(1);
        wrap[0] = x1 - x0;
        const del = wrap[0];
        for (let i = 2; i < n; i++) d[i] = x0 + i * del;
      }
    }
    return a;
  });
  fn("linspace", (start: any, stop: any, num: any = 50, endpoint: any = true, dtype: any = null) => {
    // (num as operator.index takes it: an int, not a float; admitted before
    // anything is allocated or computed)
    // (a NumPy scalar refused by its NumPy name, as NumPy's TypeError says it,
    // 'numpy.float32'; NumPy 2's bool has no __index__; astra's CORR-PR55-1)
    const nt = Obj.typeOf(num);
    const npName = nt.$module === "numpy" ? `numpy.${nt.$qualname}` : null;
    const notIndex = () => raise(T.TypeError, `'${npName}' object cannot be interpreted as an integer`);
    if (npName !== null && nt.$qualname === "bool") notIndex();
    let ni: number | bigint;
    try {
      ni = O.index(num);
    } catch (e) {
      if (npName !== null && Obj.isinstance(e, T.TypeError)) notIndex();
      throw e;
    }
    if (ni < 0) raise(T.ValueError, `Number of samples, ${ni}, must be non-negative.`);
    const dt = dtype !== null ? toDtype(dtype) : D.float64;
    admitArray([typeof ni === "bigint" ? ni : BigInt(ni)], dt);
    const n = Number(ni);
    const a = toNum(start), b = toNum(stop);
    const div = O.truth(endpoint) ? n - 1 : n;
    const delta = b - a;
    const step = div > 0 ? delta / div : NaN;
    const out = empty([n], dt);
    // as NumPy's linspace, in float64: arange(num) * step + start (with a
    // step that underflows to 0, arange(num) / div * delta; with div <= 0,
    // arange(num) * delta, so linspace(0, inf, 1) is nan); the end point set
    // exactly; floored for an integer dtype before the cast
    // (each value computed and stored in one pass: no scratch array)
    const last = O.truth(endpoint) && n > 1 ? n - 1 : -1;
    const floor = dt.kind === "i" || dt.kind === "u";
    for (let i = 0; i < n; i++) {
      const y = i === last ? b : (div > 0 ? (step === 0 ? (i / div) * delta : i * step) : i * delta) + a;
      out.data[(dt.cplx ? 2 : 1) * i] = castNum(dt, floor ? Math.floor(y) : y);
    }
    return out;
  });
  fn("eye", (n: any, mm: any = null, k: any = 0, dtype: any = null) => {
    const N = Number(n), Mm = mm === null ? N : Number(mm), K = Number(k);
    const a = empty([N, Mm], toDtype(dtype));
    for (let i = 0; i < N; i++) {
      const j = i + K;
      if (j >= 0 && j < Mm) a.data[(a.dt.cplx ? 2 : 1) * (i * Mm + j)] = 1;
    }
    return a;
  });

  // operations
  for (const op of Object.keys(BIN)) fn("u_" + op, (x: any, y: any) => binary(op, x, y));
  for (const op of Object.keys(UN)) fn("u_" + op, (x: any) => {
    const r = unary(op, x);
    return x instanceof NDArray ? r : r.ndim === 0 ? pyScalarOf(r.dt, r.data, 0) : r;
  });
  fn("binary", (op: string, x: any, y: any) => {
    // two real scalars (np.float64(1.5) + 2 ...): compute directly
    if (!(x instanceof NDArray) && !(y instanceof NDArray)) {
      const wa = pyScalar(x), wb = pyScalar(y);
      const spec = BIN[op];
      if (wa && wb && wa.kind !== "c" && wb.kind !== "c" && spec && !spec.noBool) {
        const A = { arr: { dt: wa.dt ?? scalarDtype(wa) } as NDArray, weak: wa.dt ? null : wa };
        const B = { arr: { dt: wb.dt ?? scalarDtype(wb) } as NDArray, weak: wb.dt ? null : wb };
        let ct = resultType(A, B);
        // (floats only: integers take binary()'s checked kernel)
        if (ct.kind === "f") {
          const rt = spec.out === "bool" ? D.bool : ct;
          const f = spec.f;
          const v = castNum(rt, f(wa.v, wb.v));
          return pyScalarOf(rt, [v], 0);
        }
      }
    }
    const r = binary(op, x, y);
    return x instanceof NDArray || y instanceof NDArray || Array.isArray(x) || Array.isArray(y) ? r : pyScalarOf(r.dt, r.data, 0);
  });
  fn("sum", (a: any, axis: any = null, keepdims: any = false, dtype: any = null) => sum(asarray(a), opt(axis), !!keepdims, opt(dtype)));
  // sum((a - m)**2) over a whole C-contiguous float64 array, or None
  fn("sqdev_sum", (x: any, m: any) => {
    const a = asarray(x);
    if (a.dt !== D.float64 || !a.isC() || a.size === 0) return null;
    return 0 + pairwiseSqDev(a.data, a.offset, a.size, toNum(m));
  });
  fn("prod", (a: any, axis: any = null, keepdims: any = false, dtype: any = null, initial: any = null) => {
    const x = asarray(a);
    const rt = dtype !== null ? toDtype(dtype) : sumType(x.dt);

    // (complex: real and imaginary parts multiplied together; a real fold
    // read only the real parts)
    if (x.dt.cplx || rt.cplx) return finish(complexProd(x, axesArg(axis, x.ndim), !!keepdims, rt, initial === null ? null : toC(initial)), axis, !!keepdims);
    // (in rt, as NumPy's multiply loop: each element cast to rt, each product
    // rounded to it or wrapped to its integer width; from initial, in the
    // reduced elements' memory order: prodReduce)
    const init = initial === null ? 1 : rt.isInt ? toNum(initial, rt) : castNum(rt, toNum(initial));
    return finish(prodReduce(x, axesArg(axis, x.ndim), !!keepdims, rt, init, initial !== null), axis, !!keepdims);
  });
  fn("amax", (a: any, axis: any = null, keepdims: any = false) => minmax(asarray(a), opt(axis), !!keepdims, true));
  fn("amin", (a: any, axis: any = null, keepdims: any = false) => minmax(asarray(a), opt(axis), !!keepdims, false));
  fn("argmax", (a: any, axis: any = null) => argminmax(asarray(a), opt(axis), true));
  fn("argmin", (a: any, axis: any = null) => argminmax(asarray(a), opt(axis), false));
  fn("all", (a: any, axis: any = null, keepdims: any = false) => {
    const x = asarray(a);
    return finish(reduceAxes(x.dt.cplx ? unary("logical_not", unary("logical_not", x)) : x, axesArg(axis, x.ndim), !!keepdims, D.bool, 1, (p, v) => +(p !== 0 && v !== 0)), axis, !!keepdims);
  });
  fn("any", (a: any, axis: any = null, keepdims: any = false) => {
    const x = asarray(a);
    return finish(reduceAxes(x.dt.cplx ? unary("logical_not", unary("logical_not", x)) : x, axesArg(axis, x.ndim), !!keepdims, D.bool, 0, (p, v) => +(p !== 0 || v !== 0)), axis, !!keepdims);
  });
  fn("cumsum", (a: any, axis: any = null, dtype: any = null) => cumulative(asarray(a), opt(axis), false, opt(dtype)));
  fn("cumprod", (a: any, axis: any = null, dtype: any = null) => cumulative(asarray(a), opt(axis), true, opt(dtype)));
  fn("reshape", (a: any, shape: any) => reshape(asarray(a), shapeArg(shape)));
  fn("transpose", (a: any, axes: any = null) => transpose(asarray(a), axes === null ? null : shapeArg(axes)));
  fn("ravel", (a: any) => ravel(asarray(a)));
  fn("copy", (a: any) => copy(asarray(a)));
  // raw bytes in and out (little-endian, or '>' dtypes byte-swapped)
  fn("frombuffer", (buffer: any, dtype: any = null, count: any = -1, offset: any = 0) => {
    const spec = typeof dtype === "string" ? dtype : null;
    const big = spec !== null && spec.startsWith(">");
    const dt = toDtype(dtype, D.float64);
    const raw0 = O.bufferOf(buffer);
    if (raw0 === undefined) raise(T.TypeError, "a bytes-like object is required");
    const raw = raw0!;
    const off = Number(offset);
    const isz = dt.itemsize;
    let n = Number(count);
    if (n < 0) {
      if ((raw.length - off) % isz) raise(T.ValueError, "buffer size must be a multiple of element size");
      n = (raw.length - off) / isz;
    }
    if (off + n * isz > raw.length) raise(T.ValueError, "buffer is smaller than requested size");
    // (admitted before anything is allocated, as every array: daybreak2's
    // LIMIT-PR55-2; int64 and uint64 in one allocation, the output, read
    // from the buffer in place, each value kept only if a double holds it
    // exactly (admitWide), never rounded)
    if (isWide(dt)) {
      const out = empty([n], dt);
      const dv = new DataView(raw.buffer, raw.byteOffset + off, n * isz);
      for (let i = 0; i < n; i++) out.data[i] = admitWide(dt.name === "int64" ? dv.getBigInt64(8 * i, !big) : dv.getBigUint64(8 * i, !big), dt);
      return fromBytes(out, buffer);
    }
    admitArray([n], dt);
    const bytes = raw.slice(off, off + n * isz); // aligned copy: the array's own storage
    if (big) {
      const w = dt.cplx ? isz / 2 : isz;
      for (let i = 0; i < bytes.length; i += w) bytes.subarray(i, i + w).reverse();
    }
    return fromBytes(new NDArray(dt, new dt.ctor(bytes.buffer), [n], [1]), buffer);
  });
  fn("_tobytes", (a: any) => {
    // (a contiguous copy, a 64-bit integer staging buffer, and the bytes; LIMIT-PR55-3)
    const a0 = asarray(a);
    admitWork(a0.size * (2 * a0.dt.itemsize + 8), "tobytes");
    const c = ascontig(a0);
    const dt = c.dt;
    const n = c.size * (dt.cplx ? 2 : 1);
    let view: Uint8Array;
    if (dt.name === "int64") view = new Uint8Array(BigInt64Array.from(c.data.subarray(c.offset, c.offset + n), (v: number) => BigInt(Math.trunc(v))).buffer);
    else if (dt.name === "uint64") view = new Uint8Array(BigUint64Array.from(c.data.subarray(c.offset, c.offset + n), (v: number) => BigInt(Math.trunc(v))).buffer);
    else {
      const d = c.data;
      view = new Uint8Array(d.buffer, d.byteOffset + c.offset * d.BYTES_PER_ELEMENT, n * d.BYTES_PER_ELEMENT).slice();
    }
    return new Obj.PyBytes(view);
  });
  fn("astype", (a: any, dtype: any) => copy(asarray(a), toDtype(dtype)));
  fn("nonzero", (a: any) => tuple(nonzero(asarray(a))));
  fn("matmul", (a: any, b: any) => matmul(a, b));
  fn("concatenate", (arrays: any, axis: any = 0) => {
    const arrs = O.toArray(arrays).map((x: any) => asarray(x));
    if (axis === null) return concat(arrs.map(ravel), 0);
    return concat(arrs, Number(axis));
  });
  fn("broadcast_to", (a: any, shape: any) => {
    const x = asarray(a), sh = shapeArg(shape);
    // read-only, as in NumPy: a write would change every repeated element
    const v = new NDArray(x.dt, x.data, sh, bstrides(x, sh), x.offset, x.base ?? x);
    v.ro = true;
    return v;
  });
  fn("broadcast_shapes", (...shapes: any[]) => tuple(broadcastShapes(...shapes.map(shapeArg))));
  // (lib/numpy's: a view over a copy no one else holds, made the owner of
  // that copy's data, as NumPy's asfortranarray result is)
  fn("_own", (a: any) => {
    if (!(a instanceof NDArray)) raise(T.TypeError, "_own: an ndarray is required");
    a.base = null;
    return a;
  });
  fn("where3", (c: any, x: any, y: any) => {
    const C = asarray(c), X = operand(x), Y = operand(y);
    const rt = resultType(X, Y);
    const shape = broadcastShapes(C.shape, X.arr.shape, Y.arr.shape);
    const xa = copy(X.arr, rt), ya = copy(Y.arr, rt);
    const out = empty(shape, rt);
    const w = rt.cplx ? 2 : 1;
    loop3(shape, bstrides(C, shape), C.offset, bstrides(xa, shape), xa.offset, bstrides(ya, shape), ya.offset, (pc, px, py, k) => {
      const src = C.data[pc] !== 0 ? xa : ya, p = C.data[pc] !== 0 ? px : py;
      for (let j = 0; j < w; j++) out.data[w * k + j] = src.data[w * p + j];
    });
    return out;
  });
  fn("sort", (a: any, axis: any = -1) => {
    const x = asarray(a);
    if (axis === null) return sortAxis(ravel(x), 0, false);
    return sortAxis(x, normAxis(Number(axis), x.ndim), false);
  });
  fn("argsort", (a: any, axis: any = -1) => {
    const x = asarray(a);
    if (axis === null) return sortAxis(ravel(x), 0, true);
    return sortAxis(x, normAxis(Number(axis), x.ndim), true);
  });
  fn("result_type", (...xs: any[]) => {
    // (a Python scalar is weak, NEP 50: np.result_type(1, 'i1') is int8)
    let r: DType | null = null;
    const weak: Weak[] = [];
    for (const x of xs) {
      const dt = x instanceof DType ? x : x instanceof NDArray ? x.dt : (() => { try { return toDtype(x); } catch (e) { if (typeof x === "string" || Obj.isinstance(e, T.NotImplementedError)) throw e; // (float16, longdouble: refused, not float64; an unknown name: TypeError)
 const w = pyScalar(x); if (w && !w.dt) { weak.push(w); return null; } return w ? scalarDtype(w) : D.float64; } })();
      if (dt !== null) r = r ? promote(r, dt) : dt;
    }
    for (const w of weak) r = r ? weakType(r, w) : scalarDtype(w);
    return r ?? D.float64;
  });
  // sorted distinct values of a real array (np.unique without extras)
  fn("unique1d", (x: any) => {
    const a = asarray(x);
    const s = copy(ravel(a));
    if (!(s.data instanceof Float64Array && wasmSort(s.data))) s.data.sort();
    const d = s.data, n = d.length;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const v = d[i];
      if (m === 0 || !(v === d[m - 1] || (v !== v && d[m - 1] !== d[m - 1]))) d[m++] = v;
    }
    const out = empty([m], a.dt);
    out.data.set(d.subarray(0, m));
    return out;
  });
  // histogram counts with uniform bins, as NumPy (then a correction at the edges)
  fn("hist_uniform", (x: any, lo: any, hi: any, nb: any, edges: any) => {
    const a = ascontig(asarray(x, D.float64));
    const L = toNum(lo), H = toNum(hi), N = Number(nb), e = ascontig(edges).data;
    // (the counts and the output admitted together before either is allocated: LIMIT-PR55-2)
    if (!Number.isSafeInteger(N) || N < 0) raise(T.ValueError, "`bins` must be a positive integer");
    admitArray([N], D.int64, 8 * N);
    const counts = new Float64Array(N);
    const d = a.data, norm = N / (H - L);
    for (let i = 0; i < a.size; i++) {
      const v = d[i];
      if (!(v >= L && v <= H)) continue;
      let k = Math.trunc((v - L) * norm);
      if (k >= N) k = N - 1;
      if (v < e[k]) k--;
      else if (k < N - 1 && v >= e[k + 1]) k++;
      counts[k]++;
    }
    const out = empty([N], D.int64);
    out.data.set(counts);
    return out;
  });
  fn("dtype_of_scalar", (x: any) => {
    const w = pyScalar(x);
    return w ? scalarDtype(w) : null;
  });
  // Python-defined methods (with keyword arguments) installed on ndarray
  fn("install", (name: string, f: any) => {
    A.$dict.set(name, f);
    Obj.bumpVersion(A);
    return null;
  });
  fn("register_scalar", (name: string, cls: any) => {
    scalarCtors[name] = cls;
    typeDtypes.set(cls, D[name]);
    return null;
  });
  // (lib/numpy's set_printoptions validates and passes every option)
  fn("set_printoptions", (precision: any, threshold: any, edgeitems: any, linewidth: any, suppress: any, sign: any, floatmode: any, nanstr: any, infstr: any, fb: any, fi: any, ff: any, fc: any, overrideRepr: any) => {
    printopts.precision = Number(precision);
    printopts.threshold = Number(threshold);
    printopts.edgeitems = Number(edgeitems);
    printopts.linewidth = Number(linewidth);
    printopts.suppress = O.truth(suppress);
    printopts.sign = String(sign);
    printopts.floatmode = String(floatmode);
    printopts.nanstr = String(nanstr);
    printopts.infstr = String(infstr);
    printopts.fmt = { b: fb, i: fi, f: ff, c: fc };
    printopts.overrideRepr = overrideRepr;
    return null;
  });
  // np.array2string's text (prefix: what the first line follows, for the indent)
  fn("array_text", (a: any, sep: any, prefix: any, suffix: any) => {
    const arr = asarray(a);
    if (arr.size === 0) return "[]";
    return arrayText(arr, String(sep), String(prefix), String(suffix));
  });
  fn("array_repr", (a: any) => arrayRepr(asarray(a), false));
  fn("array_str", (a: any) => arrayStr(asarray(a)));
  const trimOf = (t: any): Trim => t as Trim;
  const optInt = (v: any) => (v === null || v === undefined ? null : Number(v));
  fn("format_float_positional", (x: any, precision: any, unique: any, fractional: any, trim: any, sign: any, padLeft: any, padRight: any, minDigits: any, f32: any) =>
    dragon4Positional(toNum(x), { precision: optInt(precision), unique: O.truth(unique), fractional: O.truth(fractional), trim: trimOf(trim), sign: O.truth(sign), padLeft: optInt(padLeft), padRight: optInt(padRight), minDigits: optInt(minDigits), f32: O.truth(f32) }));
  fn("format_float_scientific", (x: any, precision: any, unique: any, trim: any, sign: any, padLeft: any, expDigits: any, minDigits: any, f32: any) =>
    dragon4Scientific(toNum(x), { precision: optInt(precision), unique: O.truth(unique), trim: trimOf(trim), sign: O.truth(sign), padLeft: optInt(padLeft), expDigits: optInt(expDigits), minDigits: optInt(minDigits), f32: O.truth(f32) }));
  fn("printopt", (k: string) => (typeof k === "string" && Object.hasOwn(printopts, k) ? (printopts as any)[k] : null));
  fn("format_float", (x: any) => positional(toNum(x), printopts.precision, true));
  // (a float32 scalar's repr and str, as NumPy's: its shortest digits,
  // positional when 1e-4 <= |x| < 1e6 (float32's six decimal digits) or
  // zero, else scientific with a two-digit exponent: 3.8923753e+13, 1e+06)
  fn("format_f32", (x: any) => {
    const v = toNum(x);
    if (!Number.isFinite(v)) return F.floatRepr(v);
    const a = Math.abs(v), sign = v < 0 || Object.is(v, -0) ? "-" : "";
    const d = Number(shortestF32(a));
    if (a === 0 || (a >= 1e-4 && a < 1e6)) return F.floatRepr(d * (sign ? -1 : 1));
    return sign + d.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  });
  fn("from_flat", (data: any, shape: any, dtype: any) => {
    // a Python list of numbers -> array (fast path for lib code)
    const sh = shapeArg(shape);
    const dt = toDtype(dtype);
    const a = empty(sh, dt);
    const items = O.toArray(data);
    for (let i = 0; i < items.length; i++) a.data[i] = castNum(dt, toNum(items[i]));
    return a;
  });
});

function concat(arrs: NDArray[], axis: number): NDArray {
  if (arrs.length === 0) raise(T.ValueError, "need at least one array to concatenate");
  const nd = arrs[0].ndim;
  if (nd === 0) raise(T.ValueError, "zero-dimensional arrays cannot be concatenated");
  const ax = normAxis(axis, nd);
  let dt = arrs[0].dt;
  for (const a of arrs.slice(1)) {
    if (a.ndim !== nd) raise(T.ValueError, `all the input array dimensions except for the concatenation axis must match exactly, but along dimension 0, the array at index 0 has ${nd} dimension(s) and the array at index 1 has ${a.ndim} dimension(s)`);
    dt = promote(dt, a.dt);
  }
  const shape = arrs[0].shape.slice();
  shape[ax] = arrs.reduce((s, a) => s + a.shape[ax], 0);
  const out = empty(shape, dt);
  let at = 0;
  for (const a of arrs) {
    const key = out.shape.map((_, d) => (d === ax ? new O.PySlice(at, at + a.shape[ax], null) : new O.PySlice(null, null, null)));
    const r = resolveIndex(out, tuple(key));
    assign((r as { view: NDArray }).view, a);
    at += a.shape[ax];
  }
  return out;
}
