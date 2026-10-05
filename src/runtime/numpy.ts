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
import { glibcLog, glibcExp, EXP_TABLES, LOG_TABLES } from "./libm";
import { gemmBuffers, wasmUnary, wasmSort, wasmArgsort } from "./kernels";

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

const D: Record<string, DType> = {};
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
const ALIASES: Record<string, string> = {
  bool: "bool", bool_: "bool", "?": "bool", b1: "bool",
  int8: "int8", i1: "int8", byte: "int8", int16: "int16", i2: "int16", short: "int16", int32: "int32", i4: "int32", intc: "int32",
  int64: "int64", i8: "int64", int: "int64", int_: "int64", intp: "int64", long: "int64", longlong: "int64", l: "int64", q: "int64",
  uint8: "uint8", u1: "uint8", ubyte: "uint8", B: "uint8", uint16: "uint16", u2: "uint16", uint32: "uint32", u4: "uint32", uint: "uint64",
  uint64: "uint64", u8: "uint64", uintp: "uint64", float16: "float32", half: "float32", f2: "float32",
  float32: "float32", f4: "float32", single: "float32", f: "float32", float64: "float64", f8: "float64", float: "float64", double: "float64", d: "float64",
  float_: "float64", longdouble: "float64", complex64: "complex64", c8: "complex64", F: "complex64", csingle: "complex64",
  complex128: "complex128", c16: "complex128", complex: "complex128", D: "complex128", cdouble: "complex128", complex_: "complex128",
};
const RANGE: Record<string, [number, number]> = {
  int8: [-128, 127], int16: [-32768, 32767], int32: [-2147483648, 2147483647], uint8: [0, 255], uint16: [0, 65535], uint32: [0, 4294967295],
};

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
    if (n) return D[n];
    raise(T.TypeError, `data type '${x}' not understood`);
  }
  const t = typeDtypes.get(x);
  if (t) return t;
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
type Weak = { kind: "b" | "i" | "f" | "c"; v: number; im?: number; dt: DType | null };
function pyScalar(x: any): Weak | null {
  if (typeof x === "boolean") return { kind: "b", v: +x, dt: null };
  if (typeof x === "number") return Number.isInteger(x) ? { kind: "i", v: x, dt: null } : { kind: "f", v: x, dt: null };
  if (typeof x === "bigint") return { kind: "i", v: Number(x), dt: null };
  if (x instanceof Obj.FloatBox) return { kind: "f", v: x.v, dt: null };
  if (x instanceof PyComplex) return { kind: "c", v: x.re, im: x.im, dt: typeDtypes.get(Obj.typeOf(x)) ?? null };
  if (x instanceof Obj.PrimBox) {
    const dt = typeDtypes.get(Obj.typeOf(x)) ?? null; // a NumPy scalar keeps its dtype
    const s = pyScalar(x.$v);
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

export function empty(shape: number[], dt: DType): NDArray {
  const n = prod(shape);
  return new NDArray(dt, new dt.ctor(dt.cplx ? 2 * n : n), shape.slice(), cStrides(shape));
}

// Store a JS number into an array of dtype dt (truncating and wrapping as C does).
function castNum(dt: DType, v: number): number {
  switch (dt.kind) {
    case "b":
      return v !== 0 ? 1 : 0;
    case "i":
    case "u":
      if (dt.ctor === Float64Array) {
        if (!Number.isFinite(v)) return dt.kind === "i" ? -9223372036854775808 : 0;
        v = Math.trunc(v);
        if (dt.kind === "u" && v < 0) v += 18446744073709551616;
        return v;
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
    for (let j = 0; j < L; j++, p += s) f(p, k++);
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

// out[...] = src (an array, broadcast to out's shape), casting as needed.
function assign(out: NDArray, src: NDArray) {
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
  } else if (dt.kind === "f" || dt.ctor !== Float64Array && dt.kind !== "b" && src.dt.isInt) {
    loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => (od[p] = sd[q]));
  } else {
    loop2(out.shape, out.strides, out.offset, sb, src.offset, (p, q) => (od[p] = castNum(dt, sd[q])));
  }
}

// ------------------------------------------------------------------ from Python values

let scalarCtors: Record<string, any> = {}; // dtype name -> NumPy scalar type (registered by lib/numpy)

function isSeq(x: any): boolean {
  return Array.isArray(x) || (x !== null && typeof x === "object" && typeName(x) === "range");
}
function seqItems(x: any): any[] {
  return Array.isArray(x) ? x : O.toArray(x);
}

// Shape and dtype of nested Python data.
function discover(x: any, depth: number, shape: number[] & { leaf?: number }, kinds: { dt: DType | null }) {
  if (x instanceof NDArray) {
    const s = x.shape;
    for (let i = 0; i < s.length; i++) setDim(shape, depth + i, s[i]);
    kinds.dt = kinds.dt ? promote(kinds.dt, x.dt) : x.dt;
    return;
  }
  if (isSeq(x)) {
    const items = seqItems(x);
    setDim(shape, depth, items.length);
    for (const it of items) discover(it, depth + 1, shape, kinds);
    if (items.length === 0 && shape.length === depth + 1) return;
    return;
  }
  if (shape.length > depth) inhomogeneous(depth);
  shape.leaf ??= depth;
  if (shape.leaf !== depth) inhomogeneous(Math.min(depth, shape.leaf));
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
function checkPyInt(dt: DType, v: number) {
  const rg = RANGE[dt.name];
  if (rg && (v < rg[0] || v > rg[1])) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
  if (dt.kind === "u" && v < 0) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
}

function toNum(v: any, dt?: DType): number {
  if (typeof v === "number") {
    if (dt && dt.isInt && Number.isInteger(v)) checkPyInt(dt, v);
    return v;
  }
  if (typeof v === "boolean") return +v;
  if (typeof v === "bigint") {
    if (dt && dt.isInt && dt.itemsize === 8 && (v > 18446744073709551615n || v < -9223372036854775808n)) raise(T.OverflowError, `Python integer ${v} out of bounds for ${dt.name}`);
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
  discover(x, 0, shape, kinds);
  const dt = dtype !== null && dtype !== undefined ? toDtype(dtype) : (kinds.dt ?? D.float64);
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
    return { view: new NDArray(a.dt, a.data, shape, strides, off, a.base ?? a) };
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
  let i = Number(Obj.unbox(k));
  if (i < 0) i += n;
  if (i < 0 || i >= n) raise(T.IndexError, `index ${Number(Obj.unbox(k))} is out of bounds for axis ${axis} with size ${n}`);
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
  const r = resolveIndex(a, key);
  const src = value instanceof NDArray ? value : operand(value).arr;
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
  return new NDArray(c.dt, c.data, shape, cStrides(shape), c.offset, c === a ? (a.base ?? a) : null);
}
function transpose(a: NDArray, axes: number[] | null): NDArray {
  const ax = axes ?? a.shape.map((_, i) => a.ndim - 1 - i);
  if (ax.length !== a.ndim) raise(T.ValueError, "axes don't match array");
  const norm = ax.map((x) => normAxis(x, a.ndim));
  return new NDArray(a.dt, a.data, norm.map((i) => a.shape[i]), norm.map((i) => a.strides[i]), a.offset, a.base ?? a);
}

// ------------------------------------------------------------------ elementwise operations

type Bin = (x: number, y: number) => number;
type CBin = (ar: number, ai: number, br: number, bi: number) => [number, number];

// Python-semantics floor division and modulo for floats (as NumPy's npy_divmod).
function fdivmod(a: number, b: number): [number, number] {
  if (b === 0) return [a / b, NaN];
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod) {
    if (b < 0 !== mod < 0) {
      mod += b;
      div -= 1;
    }
  } else mod = b < 0 ? -0 : 0;
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else floordiv = (a / b < 0 ? -0 : 0);
  return [floordiv, mod];
}

const BIN: Record<string, { f: Bin; c?: CBin; out?: "bool" | "float"; int?: Bin; noBool?: boolean }> = {
  add: { f: (x, y) => x + y, c: (a, b, c, d) => [a + c, b + d] },
  subtract: { f: (x, y) => x - y, c: (a, b, c, d) => [a - c, b - d], noBool: true },
  multiply: { f: (x, y) => x * y, c: (a, b, c, d) => [a * c - b * d, a * d + b * c] },
  true_divide: { f: (x, y) => x / y, out: "float", c: cdiv },
  floor_divide: { f: (x, y) => fdivmod(x, y)[0], int: (x, y) => (y === 0 ? 0 : Math.floor(x / y)) },
  remainder: { f: (x, y) => fdivmod(x, y)[1], int: (x, y) => (y === 0 ? 0 : x - Math.floor(x / y) * y) },
  power: { f: Math.pow, c: cpow, int: ipow },
  maximum: { f: (x, y) => (x !== x || y !== y ? NaN : Math.max(x, y)) },
  minimum: { f: (x, y) => (x !== x || y !== y ? NaN : Math.min(x, y)) },
  fmax: { f: (x, y) => (x !== x ? y : y !== y ? x : Math.max(x, y)) },
  fmin: { f: (x, y) => (x !== x ? y : y !== y ? x : Math.min(x, y)) },
  arctan2: { f: Math.atan2, out: "float" },
  hypot: { f: Math.hypot, out: "float" },
  copysign: { f: (x, y) => (Object.is(Math.sign(y), -0) || y < 0 ? -Math.abs(x) : Math.abs(x)), out: "float" },
  logaddexp: { f: (x, y) => { const m = Math.max(x, y); return m === -Infinity ? m : m + Math.log1p(Math.exp(-Math.abs(x - y))); }, out: "float" },
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
};
function cdiv(a: number, b: number, c: number, d: number): [number, number] {
  // Smith's algorithm, as NumPy
  if (Math.abs(c) >= Math.abs(d)) {
    if (c === 0 && d === 0) return [a / Math.abs(c), b / Math.abs(c)];
    const r = d / c, den = c + d * r;
    return [(a + b * r) / den, (b - a * r) / den];
  }
  const r = c / d, den = c * r + d;
  return [(a * r + b) / den, (b * r - a) / den];
}
function cpow(a: number, b: number, c: number, d: number): [number, number] {
  if (c === 0 && d === 0) return [1, 0];
  if (a === 0 && b === 0) return c > 0 && d === 0 ? [0, 0] : [NaN, NaN];
  if (d === 0 && Number.isInteger(c) && Math.abs(c) < 100) {
    let rr = 1, ri = 0, br = a, bi = b, n = Math.abs(c);
    while (n) {
      if (n & 1) [rr, ri] = [rr * br - ri * bi, rr * bi + ri * br];
      [br, bi] = [br * br - bi * bi, 2 * br * bi];
      n >>= 1;
    }
    return c < 0 ? cdiv(1, 0, rr, ri) : [rr, ri];
  }
  const logr = Math.log(Math.hypot(a, b)), th = Math.atan2(b, a);
  const mr = Math.exp(c * logr - d * th), ang = d * logr + c * th;
  return [mr * Math.cos(ang), mr * Math.sin(ang)];
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
  power: (x, y) => `Math.pow(${x}, ${y})`,
};
const kernels = new Map<string, any>();
function fastKernel(op: string, kind: string): any {
  const key = op + kind;
  let k = kernels.get(key);
  if (k === undefined) {
    const e = FAST_EXPR[op];
    const x = kind === "sa" ? "av" : "ad[ao + i]", y = kind === "as" ? "bv" : "bd[bo + i]";
    k = new Function("ad", "ao", "av", "bd", "bo", "bv", "od", "n", `for (let i = 0; i < n; i++) od[i] = ${e(x, y)};`);
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
    k = new Function("ad", "ao", "as", "bd", "bo", "bs", "od", "shape", `
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
      }`);
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
  const A = operand(x), B = operand(y);
  let ct = resultType(A, B); // type the computation runs in
  if (spec.noBool && ct.kind === "b") raise(T.TypeError, `numpy boolean ${op}, the \`-\` operator, is not supported, use the bitwise_xor, the \`^\` operator, or the logical_xor function instead.`);
  if (op.startsWith("bitwise") || op.endsWith("_shift")) {
    if (ct.kind === "f" || ct.kind === "c") raise(T.TypeError, `ufunc '${op}' not supported for the input types, and the inputs could not be safely coerced to any supported types according to the casting rule ''safe''`);
  }
  for (const w of [A.weak, B.weak]) if (w && w.kind === "i" && ct.isInt) checkPyInt(ct, w.v);
  if (spec.out === "float" && (ct.kind === "b" || ct.isInt)) ct = D.float64;
  if (op === "power" && ct.kind === "b") ct = D.int8;
  const rt = spec.out === "bool" ? D.bool : ct;
  const a = A.arr, b = B.arr;
  const shape = broadcastShapes(a.shape, b.shape);
  if (tryOut && (rt !== out!.dt || out!.offset !== 0 || !out!.isC() || shape.length !== out!.ndim || shape.some((v, i) => v !== out!.shape[i]))) return undefined;
  // fast paths: real dtypes whose arithmetic needs no wrapping or truncation
  const plain = (d: DType) => d.kind === "f" || d.kind === "b" || (d.isInt && d.ctor !== Float64Array) || d === D.int64;
  if ((!out || tryOut) && !ct.cplx && FAST_EXPR[op] && plain(ct) && plain(rt) && !(op === "power" && ct.isInt) && !(ct === D.int64 && op === "multiply")
      && (rt.kind !== "b" || spec.out === "bool") && !(rt.kind === "b" && spec.out !== "bool")) {
    const n = prod(shape);
    const aScalar = a.ndim === 0, bScalar = b.ndim === 0;
    const sameShape = a.ndim === b.ndim && a.shape.every((v, i) => v === b.shape[i]);
    if ((sameShape && isFlat(a) && isFlat(b)) || (aScalar && isFlat(b) && b.ndim > 0) || (bScalar && isFlat(a) && a.ndim > 0)) {
      const res = out ?? empty(shape, rt);
      const kind = aScalar && !bScalar ? "sa" : bScalar && !aScalar ? "as" : "aa";
      const av = aScalar ? a.data[a.offset] : 0, bv = bScalar ? b.data[b.offset] : 0;
      // operands of different storage types (int8 + float64 ...) read fine as numbers
      fastKernel(op, kind)(a.data, a.offset, av, b.data, b.offset, bv, res.data, n);
      return res;
    }
    if (shape.length >= 1 && n > 0) {
      const res = out ?? empty(shape, rt);
      stridedKernel(op)(a.data, a.offset, bstrides(a, shape), b.data, b.offset, bstrides(b, shape), res.data, shape);
      return res;
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
  const f = ct.isInt || ct.kind === "b" ? (spec.int ?? spec.f) : spec.f;
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

type Un = (x: number) => number;
type CUn = (re: number, im: number) => [number, number];
const UN: Record<string, { f: Un; c?: CUn; float?: boolean; keepInt?: boolean; out?: "bool" }> = {
  negative: { f: (x) => -x, c: (a, b) => [-a, -b], keepInt: true },
  positive: { f: (x) => x, c: (a, b) => [a, b], keepInt: true },
  absolute: { f: Math.abs, keepInt: true },
  sign: { f: (x) => (x !== x ? NaN : x > 0 ? 1 : x < 0 ? -1 : 0), keepInt: true },
  square: { f: (x) => x * x, c: (a, b) => [a * a - b * b, 2 * a * b], keepInt: true },
  sqrt: { f: Math.sqrt, c: csqrt, float: true },
  cbrt: { f: Math.cbrt, float: true },
  exp: { f: glibcExp, c: (a, b) => [glibcExp(a) * Math.cos(b), glibcExp(a) * Math.sin(b)], float: true },
  exp2: { f: (x) => 2 ** x, float: true },
  expm1: { f: Math.expm1, float: true },
  log: { f: glibcLog, c: (a, b) => [glibcLog(Math.hypot(a, b)), Math.atan2(b, a)], float: true },
  log2: { f: Math.log2, float: true },
  log10: { f: Math.log10, float: true },
  log1p: { f: Math.log1p, float: true },
  sin: { f: Math.sin, c: (a, b) => [Math.sin(a) * Math.cosh(b), Math.cos(a) * Math.sinh(b)], float: true },
  cos: { f: Math.cos, c: (a, b) => [Math.cos(a) * Math.cosh(b), -Math.sin(a) * Math.sinh(b)], float: true },
  tan: { f: Math.tan, float: true },
  arcsin: { f: Math.asin, float: true },
  arccos: { f: Math.acos, float: true },
  arctan: { f: Math.atan, float: true },
  sinh: { f: Math.sinh, float: true },
  cosh: { f: Math.cosh, float: true },
  tanh: { f: Math.tanh, float: true },
  arcsinh: { f: Math.asinh, float: true },
  arccosh: { f: Math.acosh, float: true },
  arctanh: { f: Math.atanh, float: true },
  deg2rad: { f: (x) => (x * Math.PI) / 180, float: true },
  rad2deg: { f: (x) => (x * 180) / Math.PI, float: true },
  floor: { f: Math.floor, keepInt: true },
  ceil: { f: Math.ceil, keepInt: true },
  trunc: { f: Math.trunc, keepInt: true },
  rint: { f: roundHalfEven, keepInt: true },
  reciprocal: { f: (x) => 1 / x, c: (a, b) => cdiv(1, 0, a, b), keepInt: true },
  isnan: { f: (x) => +(x !== x), out: "bool", c: (a, b) => [+(a !== a || b !== b), 0] },
  isinf: { f: (x) => +(x === Infinity || x === -Infinity), out: "bool" },
  isfinite: { f: (x) => +Number.isFinite(x), out: "bool", c: (a, b) => [+(Number.isFinite(a) && Number.isFinite(b)), 0] },
  signbit: { f: (x) => +(x < 0 || Object.is(x, -0)), out: "bool" },
  logical_not: { f: (x) => +(x === 0), out: "bool", c: (a, b) => [+(a === 0 && b === 0), 0] },
  invert: { f: (x) => -x - 1, keepInt: true },
};
function csqrt(a: number, b: number): [number, number] {
  if (a === 0 && b === 0) return [0, b];
  const t = Math.sqrt((Math.abs(a) + Math.hypot(a, b)) / 2);
  return a >= 0 ? [t, b / (2 * t)] : [Math.abs(b) / (2 * t), b >= 0 ? t : -t];
}
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Tight loops for unary operations on real data: contiguous or strided.
const UN_EXPR: Record<string, string> = {
  negative: "-v", positive: "v", absolute: "Math.abs(v)", square: "v * v", sqrt: "Math.sqrt(v)", cbrt: "Math.cbrt(v)",
  exp: "EXP(v)", exp2: "2 ** v", expm1: "Math.expm1(v)", log: "LOG(v)", log2: "Math.log2(v)", log10: "Math.log10(v)",
  log1p: "Math.log1p(v)", sin: "Math.sin(v)", cos: "Math.cos(v)", tan: "Math.tan(v)", arcsin: "Math.asin(v)",
  arccos: "Math.acos(v)", arctan: "Math.atan(v)", sinh: "Math.sinh(v)", cosh: "Math.cosh(v)", tanh: "Math.tanh(v)",
  arcsinh: "Math.asinh(v)", arccosh: "Math.acosh(v)", arctanh: "Math.atanh(v)", floor: "Math.floor(v)", ceil: "Math.ceil(v)",
  trunc: "Math.trunc(v)", isnan: "+(v !== v)", isfinite: "+(v - v === 0)", isinf: "+(v === Infinity || v === -Infinity)",
  deg2rad: "v * (Math.PI / 180)", rad2deg: "v * (180 / Math.PI)", logical_not: "+(v === 0)",
};
const unKernels = new Map<string, any>();
function unaryKernel(op: string, contiguous: boolean): any {
  const key = op + contiguous;
  let k = unKernels.get(key);
  if (k === undefined) {
    const body = contiguous
      ? `for (let i = 0; i < n; i++) { const v = ad[ao + i]; od[i] = ${UN_EXPR[op]}; }`
      : `const nd = shape.length, last = nd - 1, L = shape[last], s = st[last];
         const idx = new Array(nd).fill(0);
         let p = ao, o = 0;
         for (;;) {
           let x = p;
           for (let i = 0; i < L; i++, x += s) { const v = ad[x]; od[o++] = ${UN_EXPR[op]}; }
           let d = nd - 2;
           for (; d >= 0; d--) { p += st[d]; if (++idx[d] < shape[d]) break; p -= st[d] * shape[d]; idx[d] = 0; }
           if (d < 0) return;
         }`;
    k = new Function("EXP", "LOG", "ad", "ao", "st", "shape", "od", "n", body).bind(null, glibcExp, glibcLog);
    unKernels.set(key, k);
  }
  return k;
}

export function unary(op: string, x: any): any {
  const spec = UN[op];
  const a = operand(x).arr;
  if (op === "invert" && a.dt.kind === "b") {
    const out = empty(a.shape, D.bool);
    loop1(a.shape, a.strides, a.offset, (p, k) => (out.data[k] = a.data[p] ? 0 : 1));
    return out;
  }
  if (op === "absolute" && a.dt.cplx) {
    const out = empty(a.shape, a.dt === D.complex64 ? D.float32 : D.float64);
    loop1(a.shape, a.strides, a.offset, (p, k) => (out.data[k] = Math.hypot(a.data[2 * p], a.data[2 * p + 1])));
    return out;
  }
  if (op === "negative" && a.dt.kind === "b") raise(T.TypeError, "The numpy boolean negative, the `-` operator, is not supported, use the `~` operator or the logical_not function instead.");
  let rt: DType;
  if (spec.out === "bool") rt = D.bool;
  else if (a.dt.cplx) rt = a.dt;
  else if (spec.float && (a.dt.isInt || a.dt.kind === "b")) rt = a.dt.itemsize <= 2 && a.dt.kind !== "b" ? D.float32 : a.dt.kind === "b" ? D.float32 : D.float64;
  else if (op === "reciprocal" && a.dt.kind === "b") rt = D.int8;
  else rt = a.dt;
  if (spec.float && a.dt.kind === "b") rt = D.float32; // NumPy: sin(bool) is float16; the nearest we have
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
  if (Array.isArray(axis)) return axis.map((x) => normAxis(Number(Obj.unbox(x)), nd));
  return [normAxis(Number(Obj.unbox(axis)), nd)];
}

function sumType(dt: DType): DType {
  if (dt.kind === "b" || (dt.kind === "i" && dt.itemsize < 8)) return D.int64;
  if (dt.kind === "u" && dt.itemsize < 8) return D.uint64;
  return dt;
}

function sum(a: NDArray, axis: any, keepdims: boolean, dtype: any = null): any {
  const rt = dtype !== null ? toDtype(dtype) : sumType(a.dt);
  if (a.dt.cplx) {
    const re = realPart(a), im = imagPart(a);
    const r = sum(re, axis, keepdims), i = sum(im, axis, keepdims);
    return combineComplex(r, i, rt.cplx ? rt : a.dt);
  }
  const src = rt !== a.dt && rt.kind === "f" ? copy(a, rt) : a;
  if (rt === D.float32) return finish(reduceAxes(src, axesArg(axis, a.ndim), keepdims, rt, 0, (x, y) => f32(x + y), pairwise32), axis, keepdims);
  return finish(reduceAxes(src, axesArg(axis, a.ndim), keepdims, rt, 0, (x, y) => x + y, rt.kind === "f" ? pairwise : undefined), axis, keepdims);
}
function finish(r: NDArray, axis: any, keepdims: boolean): any {
  return r.ndim === 0 && !keepdims ? pyScalarOf(r.dt, r.data, r.offset) : r;
}
function realPart(a: NDArray): NDArray {
  if (!a.dt.cplx) return a;
  const dt = a.dt === D.complex64 ? D.float32 : D.float64;
  return new NDArray(dt, a.data, a.shape, a.strides.map((s) => 2 * s), 2 * a.offset, a);
}
function imagPart(a: NDArray): NDArray {
  if (!a.dt.cplx) {
    const z = empty(a.shape, a.dt);
    return z;
  }
  const dt = a.dt === D.complex64 ? D.float32 : D.float64;
  return new NDArray(dt, a.data, a.shape, a.strides.map((s) => 2 * s), 2 * a.offset + 1, a);
}
function combineComplex(r: any, i: any, dt: DType): any {
  if (!(r instanceof NDArray)) {
    const v = new PyComplex(Obj.unbox(r) as number, Obj.unbox(i) as number);
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
  const ax = axis === null || axis === undefined ? 0 : normAxis(Number(Obj.unbox(axis)), a.ndim);
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

function cumulative(a: NDArray, axis: any, isProd: boolean, dtype: any): NDArray {
  if (axis === null || axis === undefined) a = ravel(a);
  if (a.ndim === 1 && a.isC() && (dtype === null || dtype === undefined) && a.dt.kind === "f") {
    const out = empty(a.shape, a.dt), d = a.data, od = out.data, n = a.size;
    let acc = isProd ? 1 : 0;
    if (a.dt === D.float32) for (let i = 0; i < n; i++) od[i] = acc = Math.fround(isProd ? acc * d[a.offset + i] : acc + d[a.offset + i]);
    else for (let i = 0; i < n; i++) od[i] = acc = isProd ? acc * d[a.offset + i] : acc + d[a.offset + i];
    return out;
  }
  const ax = axis === null || axis === undefined ? 0 : normAxis(Number(Obj.unbox(axis)), a.ndim);
  const rt = dtype !== null && dtype !== undefined ? toDtype(dtype) : sumType(a.dt);
  const out = empty(a.shape, rt);
  const t = moveAxisToEnd(a, ax), o = moveAxisToEnd(out, ax);
  const n = t.shape[t.ndim - 1], st = t.strides[t.ndim - 1], ost = o.strides[o.ndim - 1];
  loop2(t.shape.slice(0, -1), t.strides.slice(0, -1), t.offset, o.strides.slice(0, -1), o.offset, (p, q) => {
    let acc = isProd ? 1 : 0;
    for (let i = 0; i < n; i++) {
      acc = isProd ? acc * t.data[p + i * st] : acc + t.data[p + i * st];
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
  const coords: number[][] = Array.from({ length: nd }, () => []);
  const shape = a.ndim ? a.shape : [1];
  const strides = a.ndim ? a.strides : [0];
  const idx = new Array(nd).fill(0);
  const cplx = a.dt.cplx;
  loop1(shape, strides, a.offset, (p, k) => {
    const nz = cplx ? a.data[2 * p] !== 0 || a.data[2 * p + 1] !== 0 : a.data[p] !== 0;
    if (nz) {
      let r = k;
      for (let d = nd - 1; d >= 0; d--) {
        idx[d] = r % shape[d];
        r = Math.floor(r / shape[d]);
      }
      for (let d = 0; d < nd; d++) coords[d].push(idx[d]);
    }
  });
  return coords.map((c) => {
    const out = empty([c.length], D.int64);
    out.data.set(c);
    return out;
  });
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

export const printopts = { precision: 8, threshold: 1000, edgeitems: 3, linewidth: 75, suppress: false, sign: "-" };

// Shortest round-trip digits of x: [digits, exponent] with x = 0.d1d2... * 10^exp
// (round-tripping through float32 while a float32 array is being printed).
let printingF32 = false;
function shortestDigits(x: number): [string, number] {
  const s = printingF32 ? shortestF32(Math.abs(x)) : Math.abs(x).toExponential();
  const [m, e] = s.split("e");
  return [m.replace(".", ""), Number(e) + 1];
}
function shortestF32(x: number): string {
  for (let p = 1; p < 10; p++) {
    const s = x.toExponential(p - 1);
    if (Math.fround(Number(s)) === x) return s;
  }
  return x.toExponential(8);
}

// np.format_float_positional with unique=True, fractional=True.
function positional(x: number, precision: number, trimZeros: boolean, minDigits = 0): string {
  if (x === 0) {
    const neg = Object.is(x, -0) ? "-" : "";
    return neg + "0." + "0".repeat(minDigits);
  }
  const [digits, exp] = shortestDigits(x);
  let frac = Math.max(0, digits.length - exp);
  let s: string;
  if (frac > precision) {
    s = Math.abs(x).toFixed(precision);
    frac = precision;
  } else {
    const intPart = exp > 0 ? (digits.slice(0, exp) + "0".repeat(Math.max(0, exp - digits.length))) : "0";
    const fracPart = exp >= 0 ? digits.slice(exp) : "0".repeat(-exp) + digits;
    s = intPart + "." + fracPart;
  }
  if (!s.includes(".")) s += ".";
  let [ip, fp] = s.split(".");
  if (trimZeros) fp = fp.replace(/0+$/, "");
  if (fp.length < minDigits) fp = fp + "0".repeat(minDigits - fp.length);
  return (x < 0 ? "-" : "") + ip + "." + fp;
}
// np.format_float_scientific with unique=True: mantissa digits, exponent.
function scientific(x: number, precision: number, minDigits: number, expDigits: number): string {
  if (x === 0) return (Object.is(x, -0) ? "-" : "") + "0." + "0".repeat(minDigits) + "e+" + "0".repeat(Math.max(2, expDigits));
  let [digits, exp] = shortestDigits(x);
  if (digits.length - 1 > precision) {
    const t = Math.abs(x).toExponential(precision);
    const [m, e] = t.split("e");
    digits = m.replace(".", "");
    exp = Number(e) + 1;
  }
  let frac = digits.slice(1).replace(/0+$/, "");
  if (frac.length < minDigits) frac += "0".repeat(minDigits - frac.length);
  const e = exp - 1;
  const es = String(Math.abs(e)).padStart(Math.max(2, expDigits), "0");
  return (x < 0 ? "-" : "") + digits[0] + "." + frac + "e" + (e < 0 ? "-" : "+") + es;
}

type Fmt = (x: number) => string;
function floatFormatter(vals: number[], signPlus = false): Fmt {
  const finite = vals.filter((v) => Number.isFinite(v));
  const abs = finite.map(Math.abs).filter((v) => v !== 0);
  const prec = printopts.precision;
  let expFormat = false;
  if (abs.length) {
    const mx = Math.max(...abs), mn = Math.min(...abs);
    if (mx >= 1e8 || (!printopts.suppress && (mn < 0.0001 || mx / mn > 1000))) expFormat = true;
  }
  const sign = (s: string) => (signPlus && !s.startsWith("-") ? "+" + s : s);
  let padLeft = 0, padRight = 0;
  let precision = prec, expSize = 0;
  if (finite.length && expFormat) {
    const strs = finite.map((v) => scientific(v, prec, 0, 2));
    const fracs = strs.map((s) => s.split("e")[0].split(".")[1]);
    const ints = strs.map((s) => sign(s).split(".")[0]);
    const exps = strs.map((s) => s.split("e")[1]);
    expSize = Math.max(...exps.map((e) => e.length)) - 1;
    precision = Math.max(...fracs.map((f) => f.length));
    padLeft = Math.max(...ints.map((s) => s.length));
    padRight = expSize + 2 + precision;
  } else if (finite.length) {
    const strs = finite.map((v) => sign(positional(v, prec, true)));
    padLeft = Math.max(...strs.map((s) => s.split(".")[0].length));
    padRight = Math.max(...strs.map((s) => s.split(".")[1].length));
  }
  // room for nan and inf (FloatingFormat.fillFormat)
  if (finite.length !== vals.length) {
    const neginf = signPlus || vals.some((v) => v === -Infinity) ? 1 : 0;
    const offset = padRight + 1;
    padLeft = Math.max(padLeft, 3 - offset, 3 + neginf - offset);
  }
  const width = padLeft + padRight + 1;
  const fmt: Fmt = expFormat
    ? (x) => {
        const s = sign(scientific(x, precision, precision, expSize));
        const [ip, rest] = s.split(".");
        return ip.padStart(padLeft) + "." + rest.padEnd(padRight);
      }
    : (x) => {
        const s = sign(positional(x, prec, true));
        const [ip, fp] = s.split(".");
        return ip.padStart(padLeft) + "." + fp.padEnd(padRight);
      };
  return (x) => {
    if (Number.isFinite(x)) return fmt(x);
    const s = x !== x ? (signPlus ? "+nan" : "nan") : x > 0 ? (signPlus ? "+inf" : "inf") : "-inf";
    return s.padStart(width);
  };
}

function elementFormatter(a: NDArray, items: number[] | [number, number][]): (i: number) => string {
  const dt = a.dt;
  if (dt.kind === "b") {
    const vals = items as number[];
    const w = a.ndim === 0 ? 0 : 5; // NumPy's BoolFormat: " True" in arrays
    return (i) => (vals[i] ? "True" : "False").padStart(w);
  }
  if (dt.isInt) {
    const strs = (items as number[]).map((v) => String(Number.isSafeInteger(v) ? v : BigInt(v)));
    const w = Math.max(0, ...strs.map((s) => s.length));
    return (i) => strs[i].padStart(w);
  }
  if (dt.cplx) {
    const pairs = items as [number, number][];
    const rf = floatFormatter(pairs.map((p) => p[0]));
    const imf = floatFormatter(pairs.map((p) => p[1]), true);
    return (i) => {
      const r = rf(pairs[i][0]);
      const im = imf(pairs[i][1]);
      const sp = im.trimEnd().length;
      return r + im.slice(0, sp) + "j" + " ".repeat(im.length - sp);
    };
  }
  const f = floatFormatter(items as number[]);
  return (i) => f((items as number[])[i]);
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
  // the elements shown, in order, for one shared formatter
  const shown: number[] = [];
  const collect = (d: number, off: number) => {
    const n = a.shape[d];
    const idx = summarize && n > 2 * edge ? [...Array(edge).keys(), ...Array.from({ length: edge }, (_, i) => n - edge + i)] : [...Array(n).keys()];
    for (const i of idx) {
      if (d === a.ndim - 1) shown.push(off + i * a.strides[d]);
      else collect(d + 1, off + i * a.strides[d]);
    }
  };
  if (a.ndim === 0) shown.push(a.offset);
  else collect(0, a.offset);
  const vals: any[] = a.dt.cplx ? shown.map((p) => [a.data[2 * p], a.data[2 * p + 1]]) : shown.map((p) => a.data[p]);
  const fmt = elementFormatter(a, vals);
  if (a.ndim === 0) return fmt(0);
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

export function arrayRepr(a: NDArray): string {
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
  return arrayText(a, " ", "");
}

// ------------------------------------------------------------------ sorting

// argsort of a 1-D integer array of moderate size and range: pack value and
// index into one double (v * 2^21 + i) and use the native numeric sort; stable.
function argsortInts(a: NDArray): NDArray | null {
  const n = a.size;
  if (a.ndim !== 1 || !a.dt.isInt && a.dt.kind !== "b" || n >= 1 << 21) return null;
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
  Ty.getset(A, "base", (a: NDArray) => a.base);
  Ty.getset(A, "real", (a: NDArray) => realPart(a), (a: NDArray, v: any) => assign(realPart(a), asarray(v)));
  Ty.getset(A, "imag", (a: NDArray) => imagPart(a), (a: NDArray, v: any) => assign(imagPart(a), asarray(v)));
  Ty.getset(A, "flat", (a: NDArray) => ravel(a.isC() ? a : copy(a)));
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
    M(`__${py}__`, (a: NDArray, o: any) => (isOperand(o) ? (O.FRESH.v = binary(pick(a, o), a, o)) : NotImplemented)).$fresh = true;
    M(`__r${py}__`, (a: NDArray, o: any) => (isOperand(o) ? (O.FRESH.v = binary(pick(o, a), o, a)) : NotImplemented)).$fresh = true;
    M(`__i${py}__`, (a: NDArray, o: any) => {
      if (!isOperand(o)) return NotImplemented;
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
    let i = Number(Obj.unbox(idx.length === 1 ? idx[0] : 0));
    if (idx.length > 1) i = idx.reduce((acc: number, v: any, d: number) => acc * a.shape[d] + Number(Obj.unbox(v)), 0);
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
  M("view", (a: NDArray) => new NDArray(a.dt, a.data, a.shape.slice(), a.strides.slice(), a.offset, a.base ?? a));
  m.ndarray = A;

  const shapeArg = (s: any): number[] => {
    if (Array.isArray(s)) return s.map((x: any) => Number(Obj.unbox(x)));
    if (s instanceof NDArray) return tolist(ravel(s)).map(Number);
    const n = Number(Obj.unbox(s));
    if (!Number.isInteger(n)) raise(T.TypeError, `'${typeName(s)}' object cannot be interpreted as an integer`);
    return [n];
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
    const v = operand(value);
    const dt = dtype !== null ? toDtype(dtype) : v.weak ? scalarDtype(v.weak) : v.arr.dt;
    const a = empty(shapeArg(shape), dt);
    assign(a, v.arr);
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
    const n = Math.max(0, Math.ceil((s1 - s0) / st));
    const dt = dtype !== null ? toDtype(dtype) : isint ? D.int64 : D.float64;
    const a = empty([n], dt);
    for (let i = 0; i < n; i++) a.data[i] = castNum(dt, s0 + i * st);
    return a;
  });
  fn("linspace", (start: any, stop: any, num: any = 50, endpoint: any = true, dtype: any = null) => {
    const n = Number(num);
    if (n < 0) raise(T.ValueError, `Number of samples, ${n}, must be non-negative.`);
    const a = toNum(start), b = toNum(stop);
    const div = endpoint ? n - 1 : n;
    const step = div > 0 ? (b - a) / div : NaN;
    const dt = dtype !== null ? toDtype(dtype) : D.float64;
    const out = empty([n], dt);
    // as NumPy: arange(num) * step + start, and the end point set exactly
    for (let i = 0; i < n; i++) out.data[i] = castNum(dt, div > 0 ? i * step + a : a);
    if (endpoint && n > 1) out.data[n - 1] = castNum(dt, b);
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
        if (ct.kind === "f" || (ct.isInt && ct.ctor === Float64Array && op !== "power" && op !== "multiply" && op !== "left_shift")) {
          for (const w of [A.weak, B.weak]) if (w && w.kind === "i" && ct.isInt) checkPyInt(ct, w.v);
          if (spec.out === "float" && ct.isInt) ct = D.float64;
          const rt = spec.out === "bool" ? D.bool : ct;
          const f = ct.isInt ? (spec.int ?? spec.f) : spec.f;
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
    return 0 + pairwiseSqDev(a.data, a.offset, a.size, Number(Obj.unbox(m)));
  });
  fn("prod", (a: any, axis: any = null, keepdims: any = false, dtype: any = null) => {
    const x = asarray(a);
    const rt = dtype !== null ? toDtype(dtype) : sumType(x.dt);
    return finish(reduceAxes(x, axesArg(axis, x.ndim), !!keepdims, rt, 1, (p, v) => p * v), axis, !!keepdims);
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
    return new NDArray(x.dt, x.data, sh, bstrides(x, sh), x.offset, x.base ?? x);
  });
  fn("broadcast_shapes", (...shapes: any[]) => tuple(broadcastShapes(...shapes.map(shapeArg))));
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
    let r: DType | null = null;
    for (const x of xs) {
      const dt = x instanceof DType ? x : x instanceof NDArray ? x.dt : (() => { try { return toDtype(x); } catch { const w = pyScalar(x); return w ? scalarDtype(w) : D.float64; } })();
      r = r ? promote(r, dt) : dt;
    }
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
  fn("set_printoptions", (precision: any, threshold: any, edgeitems: any, linewidth: any, suppress: any) => {
    if (precision !== null) printopts.precision = Number(precision);
    if (threshold !== null) printopts.threshold = Number(threshold);
    if (edgeitems !== null) printopts.edgeitems = Number(edgeitems);
    if (linewidth !== null) printopts.linewidth = Number(linewidth);
    if (suppress !== null) printopts.suppress = !!suppress;
    return null;
  });
  fn("printopt", (k: string) => (printopts as any)[k]);
  fn("format_float", (x: any) => positional(toNum(x), printopts.precision, true));
  fn("format_f32", (x: any) => {
    const v = toNum(x);
    if (!Number.isFinite(v)) return F.floatRepr(v);
    return F.floatRepr(Number(shortestF32(Math.abs(v))) * (v < 0 || Object.is(v, -0) ? -1 : 1));
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
