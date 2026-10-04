// memoryview: a one-dimensional view of the bytes of a buffer exporter
// (bytes, bytearray, array.array), sharing memory with it.

import { T, PyBytes, PyByteArray, NotImplemented, Ellipsis, raise, typeName, tuple, isinstance } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { PyArray, SIZES } from "./array";
import { builtins } from "./builtins";

const FORMATS: Record<string, number> = { ...SIZES, c: 1, "?": 1, n: 8, N: 8, P: 8, e: 2 };

export class PyMemoryView {
  released = false;
  constructor(
    public obj: any, // the exporter (bytes, bytearray or array)
    public fmt: string,
    public itemsize: number,
    public start: number, // byte offset of item 0
    public n: number, // number of items
    public step: number, // stride in items
    public readonly: boolean
  ) {}
  // The exporter's current bytes (re-read: a bytearray may reallocate).
  raw(): Uint8Array {
    if (this.released) raise(T.ValueError, "operation forbidden on released memoryview object");
    const o = this.obj;
    if (o instanceof PyBytes) return o.a.subarray(0, o.n);
    return (o as PyArray).bytes();
  }
  offset(i: number): number {
    return this.start + i * this.step * this.itemsize;
  }
  get(i: number): any {
    const b = this.raw();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const o = this.offset(i);
    switch (this.fmt) {
      case "B": return b[o];
      case "b": return dv.getInt8(o);
      case "c": return new PyBytes(b.slice(o, o + 1));
      case "?": return b[o] !== 0;
      case "h": return dv.getInt16(o, true);
      case "H": return dv.getUint16(o, true);
      case "i": return dv.getInt32(o, true);
      case "I": return dv.getUint32(o, true);
      case "u": return String.fromCodePoint(dv.getUint32(o, true));
      case "l": case "q": case "n": return O.normBig(dv.getBigInt64(o, true));
      case "L": case "Q": case "N": case "P": return O.normBig(dv.getBigUint64(o, true));
      case "f": return O.mkfloat(dv.getFloat32(o, true));
      case "d": return O.mkfloat(dv.getFloat64(o, true));
    }
    raise(T.NotImplementedError, `memoryview: format ${this.fmt} not supported`);
  }
  set(i: number, v: any) {
    if (this.readonly) raise(T.TypeError, "cannot modify read-only memory");
    const b = this.raw();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const o = this.offset(i);
    if (this.fmt === "c") {
      if (!(v instanceof PyBytes) || v.n !== 1) raise(T.ValueError, "memoryview: invalid value for format 'c'");
      b[o] = v.a[0];
      return;
    }
    if (this.fmt === "?") {
      b[o] = O.truth(v) ? 1 : 0;
      return;
    }
    if (this.fmt === "e") raise(T.NotImplementedError, "memoryview: format e not supported");
    let x: any;
    try {
      x = PyArray.prototype.conv.call({ tc: this.fmt === "n" ? "q" : this.fmt === "N" || this.fmt === "P" ? "Q" : this.fmt } as any, v);
    } catch (e: any) {
      if (isinstance(e, T.OverflowError)) raise(T.ValueError, `memoryview: invalid value for format '${this.fmt}'`);
      if (isinstance(e, T.TypeError)) raise(T.TypeError, `memoryview: invalid type for format '${this.fmt}'`);
      throw e;
    }
    switch (this.fmt) {
      case "B": b[o] = x; return;
      case "b": dv.setInt8(o, x); return;
      case "h": dv.setInt16(o, x, true); return;
      case "H": dv.setUint16(o, x, true); return;
      case "i": dv.setInt32(o, x, true); return;
      case "I": case "u": dv.setUint32(o, x, true); return;
      case "l": case "q": case "n": dv.setBigInt64(o, BigInt(x), true); return;
      case "L": case "Q": case "N": case "P": dv.setBigUint64(o, BigInt(x), true); return;
      case "f": dv.setFloat32(o, x, true); return;
      case "d": dv.setFloat64(o, x, true); return;
    }
  }
  bytes(): Uint8Array {
    const b = this.raw();
    if (this.step === 1) return b.slice(this.start, this.start + this.n * this.itemsize);
    const out = new Uint8Array(this.n * this.itemsize);
    for (let i = 0; i < this.n; i++) out.set(b.subarray(this.offset(i), this.offset(i) + this.itemsize), i * this.itemsize);
    return out;
  }
  items(): any[] {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.get(i);
    return out;
  }
}

function make(x: any): PyMemoryView {
  if (x instanceof PyMemoryView) {
    x.raw();
    return new PyMemoryView(x.obj, x.fmt, x.itemsize, x.start, x.n, x.step, x.readonly);
  }
  if (x instanceof PyBytes) return new PyMemoryView(x, "B", 1, 0, x.n, 1, !(x instanceof PyByteArray));
  if (x instanceof PyArray) return new PyMemoryView(x, x.tc, x.itemsize, 0, x.n, 1, false);
  raise(T.TypeError, `memoryview: a bytes-like object is required, not '${typeName(x)}'`);
}

// Items of another buffer, for comparisons and slice assignment.
function otherItems(o: any): [string, any[]] | undefined {
  if (o instanceof PyMemoryView) return [o.fmt, o.items()];
  if (o instanceof PyArray) return [o.tc, o.items()];
  if (o instanceof PyBytes) return ["B", Array.from(o.a.subarray(0, o.n))];
  return undefined;
}

const MV = Ty.builtinTypeFor("memoryview", PyMemoryView, "builtins", make);
const M = (name: string, f: any) => Ty.method(MV, name, f);
M("__len__", (m: PyMemoryView) => (m.raw(), m.n));
M("__getitem__", (m: PyMemoryView, k: any) => {
  m.raw();
  if (k instanceof O.PySlice) {
    const [start, step, n] = O.sliceIndices(k, m.n);
    return new PyMemoryView(m.obj, m.fmt, m.itemsize, m.offset(start), n, m.step * step, m.readonly);
  }
  if (k === Ellipsis) return m;
  if (!O.isPyInt(k) && Ty.lookupDunder(k, "__index__") === undefined) raise(T.TypeError, "memoryview: invalid slice key");
  let i = Number(O.index(k));
  if (i < 0) i += m.n;
  if (i < 0 || i >= m.n) raise(T.IndexError, "index out of bounds on dimension 1");
  return m.get(i);
});
M("__setitem__", (m: PyMemoryView, k: any, v: any) => {
  if (m.readonly) raise(T.TypeError, "cannot modify read-only memory");
  if (k instanceof O.PySlice) {
    const [start, step, n] = O.sliceIndices(k, m.n);
    const src = otherItems(v);
    if (src === undefined) raise(T.TypeError, `a bytes-like object is required, not '${typeName(v)}'`);
    const [fmt, items] = src;
    if (fmt !== m.fmt || items.length !== n) raise(T.ValueError, "memoryview assignment: lvalue and rvalue have different structures");
    for (let i = 0, j = start; i < n; i++, j += step) m.set(j, items[i]);
    return null;
  }
  let i = Number(O.index(k));
  if (i < 0) i += m.n;
  if (i < 0 || i >= m.n) raise(T.IndexError, "index out of bounds on dimension 1");
  m.set(i, v);
  return null;
});
M("__iter__", (m: PyMemoryView) => new O.ListIter(m.items()));
M("__eq__", (m: PyMemoryView, o: any) => {
  if (m === o) return true;
  const b = otherItems(o);
  if (b === undefined) return NotImplemented;
  if (m.released || (o instanceof PyMemoryView && o.released)) return false;
  return O.seqCmp(m.items(), b[1], "__eq__");
});
M("__ne__", (m: PyMemoryView, o: any) => {
  const r = MV.$dict.get("__eq__")(m, o);
  return r === NotImplemented ? r : !r;
});
M("__hash__", (m: PyMemoryView) => {
  if (!m.readonly) raise(T.ValueError, "cannot hash writable memoryview object");
  return O.hashAny(new PyBytes(m.bytes()));
});
M("__repr__", (m: PyMemoryView) => `<${m.released ? "released " : ""}memory at 0x${O.id(m).toString(16)}>`);
M("__enter__", (m: PyMemoryView) => m);
M("__exit__", (m: PyMemoryView, ..._a: any[]) => ((m.released = true), null));
M("release", (m: PyMemoryView) => ((m.released = true), null));
M("tobytes", (m: PyMemoryView, _order: any = null) => new PyBytes(m.bytes()));
M("tolist", (m: PyMemoryView) => m.items());
M("hex", (m: PyMemoryView, sep: any = undefined, bps: any = undefined) => Ty.bytesHex(m.bytes(), sep, bps));
M("toreadonly", (m: PyMemoryView) => new PyMemoryView(m.obj, m.fmt, m.itemsize, m.start, m.n, m.step, true));
M("cast", (m: PyMemoryView, fmt: any, shape: any = null) => {
  if (typeof fmt !== "string" || !(fmt in FORMATS)) raise(T.ValueError, "memoryview: destination format must be a native single character format prefixed with an optional '@'");
  if (shape !== null) raise(T.NotImplementedError, "memoryview.cast with shape is not supported");
  if (m.step !== 1) raise(T.TypeError, "memoryview: casts are restricted to C-contiguous views");
  const nbytes = m.n * m.itemsize, size = FORMATS[fmt];
  if (nbytes % size !== 0) raise(T.TypeError, "memoryview: length is not a multiple of itemsize");
  return new PyMemoryView(m.obj, fmt, size, m.start, nbytes / size, 1, m.readonly);
});
Ty.getset(MV, "obj", (m: PyMemoryView) => m.obj);
Ty.getset(MV, "nbytes", (m: PyMemoryView) => m.n * m.itemsize);
Ty.getset(MV, "readonly", (m: PyMemoryView) => m.readonly);
Ty.getset(MV, "itemsize", (m: PyMemoryView) => m.itemsize);
Ty.getset(MV, "format", (m: PyMemoryView) => m.fmt);
Ty.getset(MV, "ndim", () => 1);
Ty.getset(MV, "shape", (m: PyMemoryView) => tuple([m.n]));
Ty.getset(MV, "strides", (m: PyMemoryView) => tuple([m.step * m.itemsize]));
Ty.getset(MV, "c_contiguous", (m: PyMemoryView) => m.step === 1);
Ty.getset(MV, "f_contiguous", (m: PyMemoryView) => m.step === 1);
Ty.getset(MV, "contiguous", (m: PyMemoryView) => m.step === 1);
Ty.getset(MV, "released", (m: PyMemoryView) => m.released);
builtins.memoryview = MV;
O.bufferHooks.push((x) => (x instanceof PyMemoryView ? x.bytes() : undefined));
