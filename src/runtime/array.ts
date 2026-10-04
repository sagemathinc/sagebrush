// array.array with typed storage.  Items are stored as raw JS numbers;
// 'd'/'f' items read back as Python floats, integer codes as ints.

import { T, FloatBox, NotImplemented, raise, typeName, tuple } from "./object";
import * as O from "./ops";
import { repr } from "./format";
import * as Ty from "./types";
import { newBuiltinModule } from "./modules";

const RANGES: Record<string, [number, number] | null> = {
  b: [-128, 127], B: [0, 255], h: [-32768, 32767], H: [0, 65535], i: [-2147483648, 2147483647], I: [0, 4294967295],
  l: [-(2 ** 63), 2 ** 63 - 1], L: [0, 2 ** 64 - 1], q: [-(2 ** 63), 2 ** 63 - 1], Q: [0, 2 ** 64 - 1], f: null, d: null, u: null,
};
const SIZES: Record<string, number> = { b: 1, B: 1, u: 4, h: 2, H: 2, i: 4, I: 4, l: 8, L: 8, q: 8, Q: 8, f: 4, d: 8 };

export class PyArray {
  a: Float64Array;
  n = 0;
  constructor(public tc: string, cap = 0) {
    this.a = new Float64Array(Math.max(cap, 4));
  }
  get isFloat() {
    return this.tc === "d" || this.tc === "f";
  }
  // Python value -> stored number, with CPython's type and range checks.
  conv(v: any): number {
    if (this.tc === "d" || this.tc === "f") {
      const x = O.fv(v);
      if (x === undefined || typeof v === "boolean" && false) raise(T.TypeError, `must be real number, not ${typeName(v)}`);
      return this.tc === "f" ? Math.fround(x!) : x!;
    }
    if (this.tc === "u") {
      if (typeof v !== "string" || [...v].length !== 1) raise(T.TypeError, "array item must be unicode character");
      return v.codePointAt(0)!;
    }
    if (!(typeof v === "number" && Number.isInteger(v)) && typeof v !== "bigint" && typeof v !== "boolean") raise(T.TypeError, `'${typeName(v)}' object cannot be interpreted as an integer`);
    const x = Number(v);
    const [lo, hi] = RANGES[this.tc]!;
    if (x < lo || x > hi) raise(T.OverflowError, `signed integer is ${x < lo ? "less than minimum" : "greater than maximum"}`);
    return x;
  }
  get(i: number): any {
    const x = this.a[i];
    if (this.tc === "d" || this.tc === "f") return O.mkfloat(x);
    if (this.tc === "u") return String.fromCodePoint(x);
    return x;
  }
  reserve(n: number) {
    if (n > this.a.length) {
      const b = new Float64Array(Math.max(n, this.a.length * 2));
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
  }
  push(x: number) {
    this.reserve(this.n + 1);
    this.a[this.n++] = x;
  }
  items(): any[] {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.get(i);
    return out;
  }
}

export function arrayGetitem(o: PyArray, k: any): any {
  if (typeof k === "number" && k >= 0 && k < o.n && Number.isInteger(k)) {
    const x = o.a[k];
    return o.tc === "d" ? (Number.isInteger(x) ? new FloatBox(x) : x) : o.get(k);
  }
  if (k instanceof O.PySlice) {
    const [start, step, n] = O.sliceIndices(k, o.n);
    const r = new PyArray(o.tc, n);
    for (let i = 0, j = start; i < n; i++, j += step) r.a[i] = o.a[j];
    r.n = n;
    return r;
  }
  return o.get(O.seqIndex(k, o.n, "array"));
}

export function arraySetitem(o: PyArray, k: any, v: any): void {
  if (typeof k === "number" && k >= 0 && k < o.n && Number.isInteger(k)) {
    o.a[k] = o.tc === "d" && typeof v === "number" ? v : o.conv(v);
    return;
  }
  if (k instanceof O.PySlice) {
    if (!(v instanceof PyArray) || v.tc !== o.tc) raise(T.TypeError, `can only assign array (not "${typeName(v)}") to array slice`);
    const src = v.a.slice(0, v.n);
    const [start, step, n] = O.sliceIndices(k, o.n);
    if (step === 1) {
      const tail = o.a.slice(start + n, o.n);
      o.reserve(start + src.length + tail.length);
      o.a.set(src, start);
      o.a.set(tail, start + src.length);
      o.n = start + src.length + tail.length;
      return;
    }
    if (src.length !== n) raise(T.ValueError, `attempt to assign array of size ${src.length} to extended slice of size ${n}`);
    for (let i = 0, j = start; i < n; i++, j += step) o.a[j] = src[i];
    return;
  }
  o.a[O.seqIndex(k, o.n, "array assignment")] = o.conv(v);
}

newBuiltinModule("array", (m) => {
  const make = (tc: any, init: any = undefined) => {
    if (typeof tc !== "string" || !(tc in SIZES)) raise(T.ValueError, "bad typecode (must be b, B, u, h, H, i, I, l, L, q, Q, f or d)");
    const r = new PyArray(tc);
    if (init !== undefined) {
      if (init instanceof PyArray) for (let i = 0; i < init.n; i++) r.push(r.conv(init.get(i)));
      else if (typeof init === "string" && tc === "u") for (const ch of init) r.push(ch.codePointAt(0)!);
      else O.forEach(init, (v) => r.push(r.conv(v)));
    }
    return r;
  };
  const A = Ty.builtinTypeFor("array", PyArray, "array", make);
  Ty.subclassable(A, PyArray);
  const M = (name: string, f: any) => Ty.method(A, name, f);
  Ty.getset(A, "typecode", (r) => r.tc);
  Ty.getset(A, "itemsize", (r) => SIZES[r.tc]);
  M("__len__", (r: PyArray) => r.n);
  M("__getitem__", (r: PyArray, k: any) => arrayGetitem(r, k));
  M("__setitem__", (r: PyArray, k: any, v: any) => (arraySetitem(r, k, v), null));
  M("__iter__", (r: PyArray) => new O.ListIter(r.items()));
  M("__contains__", (r: PyArray, v: any) => r.items().some((x) => O.eqBool(x, v)));
  M("__eq__", (r: PyArray, o: any) => (o instanceof PyArray ? O.seqCmp(r.items(), o.items(), "__eq__") : NotImplemented));
  M("__add__", (r: PyArray, o: any) => {
    if (!(o instanceof PyArray) || o.tc !== r.tc) return NotImplemented;
    const out = new PyArray(r.tc, r.n + o.n);
    out.a.set(r.a.subarray(0, r.n));
    out.a.set(o.a.subarray(0, o.n), r.n);
    out.n = r.n + o.n;
    return out;
  });
  const repeat = (r: PyArray, k: any) => {
    if (!O.isPyInt(k)) return NotImplemented;
    const times = Math.max(0, Number(k));
    const out = new PyArray(r.tc, r.n * times);
    for (let t = 0; t < times; t++) out.a.set(r.a.subarray(0, r.n), t * r.n);
    out.n = r.n * times;
    return out;
  };
  M("__mul__", repeat);
  M("__rmul__", repeat);
  M("__repr__", (r: PyArray) => (r.n === 0 ? `array('${r.tc}')` : `array('${r.tc}', ${r.tc === "u" ? repr(r.items().join("")) : repr(r.items())})`));
  M("append", (r: PyArray, v: any) => (r.push(r.conv(v)), null));
  M("extend", (r: PyArray, it: any) => (O.forEach(it, (v) => r.push(r.conv(v))), null));
  M("insert", (r: PyArray, i: any, v: any) => {
    const items = Array.from(r.a.subarray(0, r.n));
    let j = Number(i);
    if (j < 0) j = Math.max(0, j + r.n);
    items.splice(Math.min(j, r.n), 0, r.conv(v));
    r.a = Float64Array.from(items);
    r.n = items.length;
    return null;
  });
  M("pop", (r: PyArray, i: any = -1) => {
    if (r.n === 0) raise(T.IndexError, "pop from empty array");
    const j = O.seqIndex(i, r.n, "pop");
    const v = r.get(j);
    r.a.copyWithin(j, j + 1, r.n);
    r.n--;
    return v;
  });
  M("tolist", (r: PyArray) => r.items());
  M("count", (r: PyArray, v: any) => r.items().filter((x) => O.eqBool(x, v)).length);
  M("index", (r: PyArray, v: any) => {
    const i = r.items().findIndex((x) => O.eqBool(x, v));
    if (i < 0) raise(T.ValueError, "array.index(x): x not in array");
    return i;
  });
  M("reverse", (r: PyArray) => (r.a.subarray(0, r.n).reverse(), null));
  M("buffer_info", (r: PyArray) => tuple([O.id(r), r.n]));
  m.array = A;
  m.ArrayType = A;
  m.typecodes = "bBuhHiIlLqQfd";
});
