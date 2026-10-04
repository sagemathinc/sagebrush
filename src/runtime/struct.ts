// The struct module: pack/unpack of C structs via DataView, with CPython's
// native ('@') sizes and alignment for a 64-bit little-endian platform.

import { T, PyBytes, PyByteArray, raise, typeName, tuple, objectType, isinstance, callObj } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { newBuiltinModule } from "./modules";

interface Item {
  code: string;
  count: number; // repeat count, or the length for 's'/'p'
  size: number;
  offset: number;
}
interface Layout {
  items: Item[];
  size: number;
  little: boolean;
  nargs: number;
}

const STD: Record<string, number> = { x: 1, c: 1, b: 1, B: 1, "?": 1, h: 2, H: 2, i: 4, I: 4, l: 4, L: 4, q: 8, Q: 8, e: 2, f: 4, d: 8, s: 1, p: 1 };
const NATIVE: Record<string, number> = { ...STD, l: 8, L: 8, n: 8, N: 8, P: 8 };

let StructError: any;
const cache = new Map<string, Layout>();

function layout(fmt: any): Layout {
  if (fmt instanceof PyBytes) fmt = Ty.decode(fmt, "latin1");
  if (typeof fmt !== "string") raise(T.TypeError, `Struct() argument 1 must be a str or bytes object, not ${typeName(fmt)}`);
  let L = cache.get(fmt);
  if (L !== undefined) return L;
  let i = 0;
  let native = true, little = true;
  const c0 = fmt[0];
  if (c0 !== undefined && "@=<>!".includes(c0)) {
    i = 1;
    native = c0 === "@";
    little = c0 === "<" || ((c0 === "@" || c0 === "=") && true);
  }
  const sizes = native ? NATIVE : STD;
  const items: Item[] = [];
  let off = 0, nargs = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let count = 1, hasCount = false;
    const m = /^\d+/.exec(fmt.slice(i));
    if (m) {
      count = parseInt(m[0]);
      hasCount = true;
      i += m[0].length;
    }
    const code = fmt[i++];
    if (code === undefined) raise(StructError, "repeat count given without format specifier");
    const size = sizes[code];
    if (size === undefined) raise(StructError, "bad char in struct format");
    if (native && code !== "s" && code !== "p" && code !== "x" && size > 1) off = Math.ceil(off / size) * size;
    if (code === "s" || code === "p") {
      items.push({ code, count: hasCount ? count : 1, size: 1, offset: off });
      off += hasCount ? count : 1;
      nargs++;
    } else {
      for (let k = 0; k < count; k++) {
        if (code !== "x") {
          items.push({ code, count: 1, size, offset: off });
          nargs++;
        }
        off += size;
      }
    }
  }
  L = { items, size: off, little, nargs };
  cache.set(fmt, L);
  return L;
}

function intArg(v: any, code: string): bigint {
  if (typeof v === "boolean") return BigInt(+v);
  if (O.isPyInt(v)) return BigInt(v);
  const f = Ty.lookupDunder(v, "__index__");
  if (f === undefined) raise(StructError, "required argument is not an integer");
  return BigInt(f(v));
}

const RANGE: Record<string, [bigint, bigint]> = {};
for (const [c, bits, signed] of [["b", 8, 1], ["B", 8, 0], ["h", 16, 1], ["H", 16, 0], ["i", 32, 1], ["I", 32, 0], ["q", 64, 1], ["Q", 64, 0], ["n", 64, 1], ["N", 64, 0], ["P", 64, 0]] as const) {
  RANGE[c] = signed ? [-(1n << BigInt(bits - 1)), (1n << BigInt(bits - 1)) - 1n] : [0n, (1n << BigInt(bits)) - 1n];
}

function packInto(L: Layout, dv: DataView, base: number, args: any[]) {
  if (args.length !== L.nargs) raise(StructError, `pack expected ${L.nargs} items for packing (got ${args.length})`);
  L.items.forEach((it, k) => {
    const v = args[k];
    const o = base + it.offset;
    const code = it.code;
    switch (code) {
      case "s":
      case "p": {
        if (!(v instanceof PyBytes)) raise(StructError, `argument for '${code}' must be a bytes object`);
        let n = Math.min(v.n, code === "p" ? Math.max(it.count - 1, 0) : it.count);
        if (code === "p" && it.count > 0) {
          dv.setUint8(o, Math.min(n, 255));
          for (let j = 0; j < n; j++) dv.setUint8(o + 1 + j, v.a[j]);
        } else for (let j = 0; j < n; j++) dv.setUint8(o + j, v.a[j]);
        break;
      }
      case "c":
        if (!(v instanceof PyBytes) || v.n !== 1) raise(StructError, "char format requires a bytes object of length 1");
        dv.setUint8(o, v.a[0]);
        break;
      case "?":
        dv.setUint8(o, O.truth(v) ? 1 : 0);
        break;
      case "e":
      case "f":
      case "d": {
        let x = O.fv(v);
        if (x === undefined) {
          const f = Ty.lookupDunder(v, "__float__") ?? Ty.lookupDunder(v, "__index__");
          if (f === undefined) raise(StructError, "required argument is not a float");
          x = O.fv(f(v))!;
        }
        if (code === "d") dv.setFloat64(o, x, L.little);
        else if (code === "f") {
          if (Number.isFinite(x) && Math.abs(x) > 3.4028235677973366e38) raise(T.OverflowError, "float too large to pack with f format");
          dv.setFloat32(o, x, L.little);
        } else dv.setUint16(o, toHalf(x), L.little);
        break;
      }
      default: {
        let n = intArg(v, code);
        const sz = it.size;
        const r = RANGE[code] ?? (code === "l" ? (sz === 8 ? RANGE.q : RANGE.i) : code === "L" ? (sz === 8 ? RANGE.Q : RANGE.I) : RANGE.q);
        if (n < r[0] || n > r[1]) {
          const signed = r[0] < 0n;
          raise(StructError, signed ? `'${code}' format requires ${r[0]} <= number <= ${r[1]}` : `'${code}' format requires 0 <= number <= ${r[1]}`);
        }
        if (n < 0n) n += 1n << BigInt(8 * sz);
        for (let j = 0; j < sz; j++) {
          dv.setUint8(o + (L.little ? j : sz - 1 - j), Number(n & 255n));
          n >>= 8n;
        }
      }
    }
  });
}

function unpackFrom(L: Layout, a: Uint8Array, base: number): any[] {
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
  return L.items.map((it) => {
    const o = base + it.offset;
    switch (it.code) {
      case "s":
        return new PyBytes(a.slice(o, o + it.count));
      case "p": {
        const n = Math.min(a[o], Math.max(it.count - 1, 0));
        return new PyBytes(a.slice(o + 1, o + 1 + n));
      }
      case "c":
        return new PyBytes(a.slice(o, o + 1));
      case "?":
        return a[o] !== 0;
      case "d":
        return O.mkfloat(dv.getFloat64(o, L.little));
      case "f":
        return O.mkfloat(dv.getFloat32(o, L.little));
      case "e":
        return O.mkfloat(fromHalf(dv.getUint16(o, L.little)));
      default: {
        const sz = it.size;
        let n = 0n;
        for (let j = 0; j < sz; j++) n = (n << 8n) | BigInt(a[o + (L.little ? sz - 1 - j : j)]);
        const r = RANGE[it.code] ?? (it.code === "l" ? (sz === 8 ? RANGE.q : RANGE.i) : sz === 8 ? RANGE.Q : RANGE.I);
        if (r[0] < 0n && n > r[1]) n -= 1n << BigInt(8 * sz);
        return O.normBig(n);
      }
    }
  });
}

function toHalf(x: number): number {
  const f32 = new Float32Array([x]);
  const u = new Uint32Array(f32.buffer)[0];
  const sign = (u >>> 16) & 0x8000;
  let exp = ((u >>> 23) & 0xff) - 127 + 15;
  let mant = u & 0x7fffff;
  if (Number.isNaN(x)) return 0x7e00 | sign;
  if (exp >= 31) {
    if (Number.isFinite(x)) raise(T.OverflowError, "float too large to pack with e format");
    return sign | 0x7c00;
  }
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1 && ((mant & ((1 << (shift - 1)) - 1)) || h & 1)) h++;
    return sign | h;
  }
  let h = sign | (exp << 10) | (mant >> 13);
  if (mant & 0x1000 && (mant & 0xfff || h & 1)) h++;
  return h;
}
function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function buffer(b: any): Uint8Array {
  const r = O.bufferOf(b);
  if (r !== undefined) return r;
  raise(T.TypeError, `a bytes-like object is required, not '${typeName(b)}'`);
}

function pack(fmt: any, ...args: any[]): PyBytes {
  const L = layout(fmt);
  const a = new Uint8Array(L.size);
  packInto(L, new DataView(a.buffer), 0, args);
  return new PyBytes(a);
}
function unpack(fmt: any, b: any): any {
  const L = layout(fmt);
  const a = buffer(b);
  if (a.length !== L.size) raise(StructError, `unpack requires a buffer of ${L.size} bytes`);
  return tuple(unpackFrom(L, a, 0));
}
function unpackFromImpl(fmt: any, b: any, offset: any = 0): any {
  const L = layout(fmt);
  const a = buffer(b);
  let off = Number(offset);
  if (off < 0) off += a.length;
  if (off < 0 || a.length - off < L.size) raise(StructError, `unpack_from requires a buffer of at least ${L.size + off} bytes for unpacking ${L.size} bytes at offset ${off} (actual buffer size is ${a.length})`);
  return tuple(unpackFrom(L, a, off));
}
function packIntoImpl(fmt: any, b: any, offset: any, ...args: any[]): any {
  const L = layout(fmt);
  if (!(b instanceof PyByteArray)) raise(T.TypeError, `argument must be read-write bytes-like object, not ${typeName(b)}`);
  let off = Number(offset);
  if (off < 0) off += b.n;
  if (off < 0 || b.n - off < L.size) raise(StructError, `pack_into requires a buffer of at least ${L.size + off} bytes for packing ${L.size} bytes at offset ${off} (actual buffer size is ${b.n})`);
  packInto(L, new DataView(b.a.buffer, b.a.byteOffset, b.a.byteLength), off, args);
  return null;
}
function iterUnpack(fmt: any, b: any): any {
  const L = layout(fmt);
  const a = buffer(b);
  if (L.size === 0) raise(StructError, "cannot iteratively unpack with a struct of length 0");
  if (a.length % L.size !== 0) raise(StructError, `iterative unpacking requires a buffer of a multiple of ${L.size} bytes`);
  const out: any[] = [];
  for (let o = 0; o < a.length; o += L.size) out.push(tuple(unpackFrom(L, a, o)));
  return O.iter(out);
}

newBuiltinModule("struct", (m) => {
  StructError = objectType("error", [T.Exception], new Map(), "struct");
  m.error = StructError;
  const fn = (name: string, f: any) => {
    f.__name__ = name;
    m[name] = f;
  };
  fn("calcsize", (fmt: any) => layout(fmt).size);
  fn("pack", pack);
  fn("unpack", unpack);
  fn("unpack_from", unpackFromImpl);
  m.unpack_from.$kw = (pos: any[], names: string[], values: any[]) => unpackFromImpl(pos[0], pos[1], names[0] === "offset" ? values[0] : pos[2] ?? 0);
  fn("pack_into", packIntoImpl);
  fn("iter_unpack", iterUnpack);
  const Struct = objectType("Struct", [T.object], new Map(), "struct");
  Ty.method(Struct, "__init__", (self: any, fmt: any) => {
    layout(fmt);
    self.format = fmt instanceof PyBytes ? Ty.decode(fmt, "latin1") : fmt;
    self.size = layout(fmt).size;
    return null;
  });
  Ty.method(Struct, "pack", (self: any, ...a: any[]) => pack(self.format, ...a));
  Ty.method(Struct, "unpack", (self: any, b: any) => unpack(self.format, b));
  Ty.method(Struct, "unpack_from", (self: any, b: any, off: any = 0) => unpackFromImpl(self.format, b, off));
  Ty.method(Struct, "pack_into", (self: any, b: any, off: any, ...a: any[]) => packIntoImpl(self.format, b, off, ...a));
  Ty.method(Struct, "iter_unpack", (self: any, b: any) => iterUnpack(self.format, b));
  m.Struct = Struct;
  void isinstance;
  void callObj;
});
