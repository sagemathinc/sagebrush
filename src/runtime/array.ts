// array.array with typed storage: each typecode keeps its items in the
// matching JS typed array (64-bit codes in BigInt64Array/BigUint64Array), so
// values are exact and the bytes are available for the buffer protocol.

import { T, PyBytes, NotImplemented, raise, typeName, tuple, typeOf } from "./object";
import * as O from "./ops";
import { repr } from "./format";
import * as Ty from "./types";
import { newBuiltinModule } from "./modules";

type TA = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array | Float32Array | Float64Array;
const CTORS: Record<string, any> = {
  b: Int8Array, B: Uint8Array, u: Uint32Array, h: Int16Array, H: Uint16Array, i: Int32Array, I: Uint32Array,
  l: BigInt64Array, L: BigUint64Array, q: BigInt64Array, Q: BigUint64Array, f: Float32Array, d: Float64Array,
};
const RANGES: Record<string, [bigint, bigint]> = {
  b: [-128n, 127n], B: [0n, 255n], h: [-32768n, 32767n], H: [0n, 65535n], i: [-2147483648n, 2147483647n], I: [0n, 4294967295n],
  l: [-(2n ** 63n), 2n ** 63n - 1n], L: [0n, 2n ** 64n - 1n], q: [-(2n ** 63n), 2n ** 63n - 1n], Q: [0n, 2n ** 64n - 1n],
};
export const SIZES: Record<string, number> = { b: 1, B: 1, u: 4, h: 2, H: 2, i: 4, I: 4, l: 8, L: 8, q: 8, Q: 8, f: 4, d: 8 };
const BIG = new Set(["l", "L", "q", "Q"]);

export class PyArray {
  a: TA;
  n = 0;
  constructor(public tc: string, cap = 0) {
    this.a = new CTORS[tc](Math.max(cap, 4));
  }
  get isFloat() {
    return this.tc === "d" || this.tc === "f";
  }
  get itemsize() {
    return SIZES[this.tc];
  }
  // Python value -> stored value, with CPython's type and range checks.
  conv(v: any): any {
    if (this.tc === "d" || this.tc === "f") {
      const x = O.fv(v) ?? Ty.floatCallSafe(v);
      if (x === undefined) raise(T.TypeError, `must be real number, not ${typeName(v)}`);
      return x;
    }
    if (this.tc === "u") {
      if (typeof v !== "string" || [...v].length !== 1) raise(T.TypeError, `array item must be a unicode character, not ${typeName(v)}`);
      return v.codePointAt(0)!;
    }
    let x: bigint;
    if (typeof v === "boolean") x = BigInt(+v);
    else if (O.isPyInt(v)) x = BigInt(v);
    else {
      const f = Ty.lookupDunder(v, "__index__");
      if (f === undefined) raise(T.TypeError, `'${typeName(v)}' object cannot be interpreted as an integer`);
      x = BigInt(f(v));
    }
    const [lo, hi] = RANGES[this.tc];
    if (x < lo || x > hi) {
      if (lo === 0n && x < 0n) raise(T.OverflowError, "unsigned integer is less than minimum");
      raise(T.OverflowError, `${lo === 0n ? "unsigned" : "signed"} integer is ${x < lo ? "less than minimum" : "greater than maximum"}`);
    }
    return BIG.has(this.tc) ? x : Number(x);
  }
  get(i: number): any {
    const x = this.a[i];
    if (typeof x === "bigint") return O.normBig(x);
    if (this.tc === "d" || this.tc === "f") return O.mkfloat(x);
    if (this.tc === "u") return String.fromCodePoint(x);
    return x;
  }
  reserve(n: number) {
    if (n > this.a.length) {
      const b = new CTORS[this.tc](Math.max(n, this.a.length * 2));
      b.set(this.a.subarray(0, this.n) as any);
      this.a = b;
    }
  }
  push(x: any) {
    this.reserve(this.n + 1);
    this.a[this.n++] = x;
  }
  items(): any[] {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.get(i);
    return out;
  }
  // The items' bytes (native little-endian), a live view.
  bytes(): Uint8Array {
    return new Uint8Array(this.a.buffer, this.a.byteOffset, this.n * this.itemsize);
  }
  frombytes(b: Uint8Array) {
    const sz = this.itemsize;
    if (b.length % sz !== 0) raise(T.ValueError, "bytes length not a multiple of item size");
    const k = b.length / sz;
    this.reserve(this.n + k);
    new Uint8Array(this.a.buffer, this.a.byteOffset + this.n * sz, b.length).set(b);
    this.n += k;
  }
}

export function arrayGetitem(o: PyArray, k: any): any {
  if (typeof k === "number" && k >= 0 && k < o.n && Number.isInteger(k)) return o.get(k);
  if (k instanceof O.PySlice) {
    const [start, step, n] = O.sliceIndices(k, o.n);
    const r = new (Object.getPrototypeOf(o).constructor === PyArray ? PyArray : PyArray)(o.tc, n);
    for (let i = 0, j = start; i < n; i++, j += step) r.a[i] = o.a[j];
    r.n = n;
    return r;
  }
  return o.get(O.seqIndex(k, o.n, "array"));
}

export function arraySetitem(o: PyArray, k: any, v: any): void {
  if (typeof k === "number" && k >= 0 && k < o.n && Number.isInteger(k)) {
    o.a[k] = o.conv(v);
    return;
  }
  if (k instanceof O.PySlice) {
    if (!(v instanceof PyArray) || v.tc !== o.tc) raise(T.TypeError, `can only assign array (not "${typeName(v)}") to array slice`);
    const src = v.a.slice(0, v.n);
    const [start, step, n] = O.sliceIndices(k, o.n);
    if (step === 1) {
      const tail = o.a.slice(start + n, o.n);
      o.reserve(start + src.length + tail.length);
      o.a.set(src as any, start);
      o.a.set(tail as any, start + src.length);
      o.n = start + src.length + tail.length;
      return;
    }
    if (src.length !== n) raise(T.ValueError, `attempt to assign array of size ${src.length} to extended slice of size ${n}`);
    for (let i = 0, j = start; i < n; i++, j += step) o.a[j] = src[i];
    return;
  }
  o.a[O.seqIndex(k, o.n, "array assignment")] = o.conv(v);
}

export function arrayDelitem(o: PyArray, k: any): void {
  const items = Array.from(o.a.subarray(0, o.n) as any);
  if (k instanceof O.PySlice) {
    const [start, step, n] = O.sliceIndices(k, o.n);
    const drop = new Set<number>();
    for (let i = 0, j = start; i < n; i++, j += step) drop.add(j);
    const kept = items.filter((_, i) => !drop.has(i));
    o.a.set(kept as any);
    o.n = kept.length;
    return;
  }
  const j = O.seqIndex(k, o.n, "array assignment");
  o.a.copyWithin(j, j + 1, o.n);
  o.n--;
}

newBuiltinModule("array", (m) => {
  const make = (tc: any, init: any = undefined) => {
    if (typeof tc !== "string" || !(tc in SIZES)) raise(T.ValueError, "bad typecode (must be b, B, u, h, H, i, I, l, L, q, Q, f or d)");
    const r = new PyArray(tc);
    if (init !== undefined) {
      if (init instanceof PyArray) {
        if (tc === "u" && init.tc !== "u") raise(T.TypeError, `cannot use a unicode array to initialize an array with typecode '${tc}'`);
        for (let i = 0; i < init.n; i++) r.push(r.conv(init.get(i)));
      } else if (typeof init === "string") {
        if (tc !== "u") raise(T.TypeError, `cannot use a str to initialize an array with typecode '${tc}'`);
        for (const ch of init) r.push(ch.codePointAt(0)!);
      } else if (init instanceof PyBytes) r.frombytes(init.a.subarray(0, init.n));
      else O.forEach(init, (v) => r.push(r.conv(v)));
    }
    return r;
  };
  const A = Ty.builtinTypeFor("array", PyArray, "array", make);
  Ty.subclassable(A, PyArray);
  const M = (name: string, f: any) => Ty.method(A, name, f);
  const items = (o: any): any[] | undefined => (o instanceof PyArray ? o.items() : undefined);
  Ty.getset(A, "typecode", (r) => r.tc);
  Ty.getset(A, "itemsize", (r) => SIZES[r.tc]);
  M("__len__", (r: PyArray) => r.n);
  M("__getitem__", (r: PyArray, k: any) => arrayGetitem(r, k));
  M("__setitem__", (r: PyArray, k: any, v: any) => (arraySetitem(r, k, v), null));
  M("__delitem__", (r: PyArray, k: any) => (arrayDelitem(r, k), null));
  M("__iter__", (r: PyArray) => new O.ListIter(r.items()));
  M("__contains__", (r: PyArray, v: any) => r.items().some((x) => O.eqBool(x, v)));
  for (const op of ["__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__"]) {
    M(op, (r: PyArray, o: any) => {
      const b = items(o);
      return b === undefined ? NotImplemented : O.seqCmp(r.items(), b, op);
    });
  }
  A.$dict.set("__hash__", null);
  M("__add__", (r: PyArray, o: any) => {
    if (!(o instanceof PyArray)) return NotImplemented;
    if (o.tc !== r.tc) raise(T.TypeError, "bad argument type for built-in operation");
    const out = new PyArray(r.tc, r.n + o.n);
    out.a.set(r.a.subarray(0, r.n) as any);
    out.a.set(o.a.subarray(0, o.n) as any, r.n);
    out.n = r.n + o.n;
    return out;
  });
  M("__iadd__", (r: PyArray, o: any) => {
    if (!(o instanceof PyArray)) raise(T.TypeError, `can only extend array with array (not "${typeName(o)}")`);
    if (o.tc !== r.tc) raise(T.TypeError, "can only extend with array of same kind");
    const src = o.a.slice(0, o.n);
    r.reserve(r.n + src.length);
    r.a.set(src as any, r.n);
    r.n += src.length;
    return r;
  });
  const repeat = (r: PyArray, k: any) => {
    if (!O.isPyInt(k)) return NotImplemented;
    const times = Math.max(0, Number(k));
    const out = new PyArray(r.tc, r.n * times);
    for (let t = 0; t < times; t++) out.a.set(r.a.subarray(0, r.n) as any, t * r.n);
    out.n = r.n * times;
    return out;
  };
  M("__mul__", repeat);
  M("__rmul__", repeat);
  M("__imul__", (r: PyArray, k: any) => {
    const x = repeat(r, k);
    if (x === NotImplemented) return x;
    r.a = x.a;
    r.n = x.n;
    return r;
  });
  M("__repr__", (r: PyArray) => {
    const name = typeOf(r) === A ? "array" : typeOf(r).$name;
    return r.n === 0 ? `${name}('${r.tc}')` : `${name}('${r.tc}', ${r.tc === "u" ? repr(r.items().join("")) : repr(r.items())})`;
  });
  M("append", (r: PyArray, v: any) => (r.push(r.conv(v)), null));
  M("extend", (r: PyArray, it: any) => {
    if (it instanceof PyArray && it.tc !== r.tc) raise(T.TypeError, "can only extend with array of same kind");
    O.forEach(it, (v) => r.push(r.conv(v)));
    return null;
  });
  M("fromlist", (r: PyArray, l: any) => {
    if (!Array.isArray(l) || (l as any).$t) raise(T.TypeError, "arg must be list");
    const vals = l.map((v: any) => r.conv(v));
    for (const v of vals) r.push(v);
    return null;
  });
  M("frombytes", (r: PyArray, b: any) => (r.frombytes(O.bufferOf(b) ?? raise(T.TypeError, `a bytes-like object is required, not '${typeName(b)}'`)), null));
  M("tobytes", (r: PyArray) => new PyBytes(r.bytes().slice()));
  M("fromunicode", (r: PyArray, s: string) => {
    if (r.tc !== "u") raise(T.ValueError, "fromunicode() may only be called on unicode type arrays");
    for (const ch of s) r.push(ch.codePointAt(0)!);
    return null;
  });
  M("tounicode", (r: PyArray) => {
    if (r.tc !== "u") raise(T.ValueError, "tounicode() may only be called on unicode type arrays");
    return r.items().join("");
  });
  M("insert", (r: PyArray, i: any, v: any) => {
    const x = r.conv(v);
    let j = Number(i);
    if (j < 0) j = Math.max(0, j + r.n);
    j = Math.min(j, r.n);
    r.reserve(r.n + 1);
    r.a.copyWithin(j + 1, j, r.n);
    r.a[j] = x;
    r.n++;
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
  M("remove", (r: PyArray, v: any) => {
    const i = r.items().findIndex((x) => O.eqBool(x, v));
    if (i < 0) raise(T.ValueError, "array.remove(x): x not in array");
    r.a.copyWithin(i, i + 1, r.n);
    r.n--;
    return null;
  });
  M("tolist", (r: PyArray) => r.items());
  M("count", (r: PyArray, v: any) => r.items().filter((x) => O.eqBool(x, v)).length);
  M("index", (r: PyArray, v: any) => {
    const i = r.items().findIndex((x) => O.eqBool(x, v));
    if (i < 0) raise(T.ValueError, "array.index(x): x not in array");
    return i;
  });
  M("reverse", (r: PyArray) => (r.a.subarray(0, r.n).reverse(), null));
  M("byteswap", (r: PyArray) => {
    const sz = r.itemsize, b = r.bytes();
    for (let i = 0; i < b.length; i += sz) b.subarray(i, i + sz).reverse();
    return null;
  });
  M("buffer_info", (r: PyArray) => tuple([O.id(r), r.n]));
  M("__copy__", (r: PyArray) => arrayGetitem(r, new O.PySlice(null, null, null)));
  m.array = A;
  m.ArrayType = A;
  m.typecodes = "bBuhHiIlLqQfd";
});
