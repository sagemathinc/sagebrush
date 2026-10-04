// Operators, comparison, hashing, truthiness, iteration and subscripting.
// Fast paths come first and only perform JS operations on already-checked
// types, so their V8 feedback stays clean when inlined into compiled code.

import {
  T, FloatBox, DONE, NotImplemented, PyDict, PyType, typeOf, typeName, lookupType, raise, isType, tuple,
  dictGet, dictSet, dictDelete, dictKeyOf, hooks, PyBytes, PyByteArray,
} from "./object";

const isInt = Number.isInteger;
const isSafe = Number.isSafeInteger;
const MINB = -9007199254740991n;
const MAXB = 9007199254740991n;

// Instances of Python subclasses of list/tuple/dict carry `$cls` on their
// prototype; plain values take the fast paths.
export const plainArr = (o: any): boolean => o.$cls === undefined;

const LAYOUT_DUNDERS = ["__len__", "__getitem__", "__setitem__", "__delitem__", "__iter__", "__contains__", "__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__", "__add__", "__mul__", "__bool__", "__hash__", "__repr__"];
// A subclass of list/tuple/dict/set that overrides none of the base type's
// dunders behaves exactly like its base for the operator fast paths.
export function layoutPlain(t: any): boolean {
  if (t.$lpVer === t.$ver) return t.$lp;
  const base = t.$mro.find((c: any) => c.$ctor === null && c.$jsBase !== undefined && c.$jsBase !== null);
  t.$lpVer = t.$ver;
  t.$lp = base !== undefined && LAYOUT_DUNDERS.every((n) => lookupType(t, n) === lookupType(base, n));
  return t.$lp;
}
export const plainDict = (o: any): boolean => o.$cls === T.dict;

export const normBig = (r: bigint): number | bigint => (r >= MINB && r <= MAXB ? Number(r) : r);
export const mkfloat = (r: number): any => (isInt(r) ? new FloatBox(r) : r);
export const fbox = (v: number) => new FloatBox(v);
const big = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

export function isPyInt(x: any): boolean {
  const t = typeof x;
  return (t === "number" && isInt(x)) || t === "bigint" || t === "boolean";
}
export function isPyFloat(x: any): boolean {
  return (typeof x === "number" && !isInt(x)) || x instanceof FloatBox;
}

// The binary64 value of an int or float, or undefined for other types.
export function fv(x: any): number | undefined {
  const t = typeof x;
  if (t === "number") return x;
  if (x instanceof FloatBox) return x.v;
  if (t === "bigint") return bigToFloat(x);
  if (t === "boolean") return +x;
  return undefined;
}

export function bigToFloat(x: bigint): number {
  const r = Number(x);
  if (!Number.isFinite(r)) raise(T.OverflowError, "int too large to convert to float");
  return r;
}

// Dunder lookup with a per-class cache, invalidated by the class version.
function special(o: any, name: string): any {
  const t: any = typeOf(o);
  let c = t.$dc;
  if (c === undefined || t.$dcVer !== t.$ver) {
    c = t.$dc = Object.create(null);
    t.$dcVer = t.$ver;
  }
  const v = c[name];
  if (v !== undefined) return v === MISSING ? undefined : v;
  let f = lookupType(t, name);
  if (f !== null && typeof f === "object" && f.asDunder !== undefined) f = f.asDunder();
  c[name] = f === undefined ? MISSING : f;
  return f;
}
const MISSING = {};

const OPS: Record<string, [string, string, string]> = {
  add: ["__add__", "__radd__", "+"],
  sub: ["__sub__", "__rsub__", "-"],
  mul: ["__mul__", "__rmul__", "*"],
  truediv: ["__truediv__", "__rtruediv__", "/"],
  floordiv: ["__floordiv__", "__rfloordiv__", "//"],
  mod: ["__mod__", "__rmod__", "%"],
  pow: ["__pow__", "__rpow__", "** or pow()"],
  lshift: ["__lshift__", "__rlshift__", "<<"],
  rshift: ["__rshift__", "__rrshift__", ">>"],
  and: ["__and__", "__rand__", "&"],
  or: ["__or__", "__ror__", "|"],
  xor: ["__xor__", "__rxor__", "^"],
  matmul: ["__matmul__", "__rmatmul__", "@"],
};

export function binaryDunder(a: any, b: any, op: string): any {
  const [name, rname, sym] = OPS[op];
  const ta = typeOf(a), tb = typeOf(b);
  const fa = special(a, name);
  const fb = ta === tb ? undefined : special(b, rname);
  if (fb !== undefined && tb.$mro.includes(ta) && fb !== special(a, rname)) {
    // A subclass's reflected method gets priority.
    const r = fb(b, a);
    if (r !== NotImplemented) return r;
    if (fa !== undefined) {
      const r2 = fa(a, b);
      if (r2 !== NotImplemented) return r2;
    }
  } else {
    if (fa !== undefined) {
      const r = fa(a, b);
      if (r !== NotImplemented) return r;
    }
    if (fb !== undefined) {
      const r = fb(b, a);
      if (r !== NotImplemented) return r;
    }
  }
  raise(T.TypeError, `unsupported operand type(s) for ${sym}: '${ta.$name}' and '${tb.$name}'`);
}

function inplace(a: any, b: any, op: string, iname: string): any {
  const f = special(a, iname);
  if (f !== undefined) {
    const r = f(a, b);
    if (r !== NotImplemented) return r;
  }
  return BIN[op](a, b);
}

// ------------------------------------------------------------------ arithmetic

export function add(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    if (isInt(a) && isInt(b)) return isSafe(r) ? r : normBig(BigInt(a) + BigInt(b));
    return isInt(r) ? new FloatBox(r) : r;
  }
  if (typeof a === "string" && typeof b === "string") return a + b;
  return addSlow(a, b);
}
function addSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) + big(b));
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) return mkfloat(x + y);
  if (Array.isArray(a) && Array.isArray(b) && (a as any).$t === (b as any).$t) {
    const r = a.concat(b);
    return (a as any).$t ? tuple(r) : r;
  }
  if (a instanceof PyBytes && b instanceof PyBytes) {
    const r = new Uint8Array(a.n + b.n);
    r.set(a.a.subarray(0, a.n), 0);
    r.set(b.a.subarray(0, b.n), a.n);
    return a instanceof PyByteArray ? new PyByteArray(r) : new PyBytes(r);
  }
  return binaryDunder(a, b, "add");
}

export function sub(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") {
    const r = a - b;
    if (isInt(a) && isInt(b)) return isSafe(r) ? r : normBig(BigInt(a) - BigInt(b));
    return isInt(r) ? new FloatBox(r) : r;
  }
  return subSlow(a, b);
}
function subSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) - big(b));
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) return mkfloat(x - y);
  if (a instanceof PySet && b instanceof PySet) return setOp(a, b, "sub");
  return binaryDunder(a, b, "sub");
}

export function mul(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") {
    const r = a * b;
    if (isInt(a) && isInt(b)) return isSafe(r) ? r + 0 : normBig(BigInt(a) * BigInt(b));
    return isInt(r) ? new FloatBox(r) : r;
  }
  return mulSlow(a, b);
}
function repeatCount(n: any): number | undefined {
  if (!isPyInt(n)) return undefined;
  const k = Number(n);
  return k < 0 ? 0 : k;
}
function mulSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) * big(b));
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) return mkfloat(x * y);
  if (typeof a === "string" && repeatCount(b) !== undefined) return a.repeat(repeatCount(b)!);
  if (typeof b === "string" && repeatCount(a) !== undefined) return b.repeat(repeatCount(a)!);
  if (Array.isArray(a) && repeatCount(b) !== undefined) return repeatArray(a, repeatCount(b)!);
  if (Array.isArray(b) && repeatCount(a) !== undefined) return repeatArray(b, repeatCount(a)!);
  if (a instanceof PyBytes && repeatCount(b) !== undefined) return repeatBytes(a, repeatCount(b)!);
  if (b instanceof PyBytes && repeatCount(a) !== undefined) return repeatBytes(b, repeatCount(a)!);
  return binaryDunder(a, b, "mul");
}
function repeatArray(a: any[], n: number): any[] {
  const len = a.length;
  const r = new Array(len * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < len; j++) r[i * len + j] = a[j];
  return (a as any).$t ? tuple(r) : r;
}

function repeatBytes(a: PyBytes, n: number): PyBytes {
  const total = a.n * n;
  const r = new Uint8Array(total);
  if (total > 0) {
    r.set(a.a.subarray(0, a.n), 0);
    for (let filled = a.n; filled < total; filled *= 2) r.copyWithin(filled, 0, Math.min(filled, total - filled));
  }
  return a instanceof PyByteArray ? new PyByteArray(r) : new PyBytes(r);
}

export function truediv(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && b !== 0) return mkfloat(a / b);
  return truedivSlow(a, b);
}
function truedivSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) === 0n) raise(T.ZeroDivisionError, "division by zero");
    return mkfloat(intTrueDiv(big(a), big(b)));
  }
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "float division by zero");
    return mkfloat(x / y);
  }
  return binaryDunder(a, b, "truediv");
}

const absBig = (x: bigint) => (x < 0n ? -x : x);
function bitLength(x: bigint): number {
  return x === 0n ? 0 : absBig(x).toString(2).length;
}

// Correctly rounded int / int, like CPython's long_true_divide.
export function intTrueDiv(a: bigint, b: bigint): number {
  if (absBig(a) <= MAXB && absBig(b) <= MAXB) return Number(a) / Number(b);
  const neg = a < 0n !== b < 0n;
  a = absBig(a);
  b = absBig(b);
  // Scale so the quotient has 55 significant bits plus a sticky bit, then
  // let Number() round to 53 bits (ties to even) exactly once.
  const shift = bitLength(a) - bitLength(b) - 55;
  let q: bigint, r: bigint;
  if (shift >= 0) {
    q = a / (b << BigInt(shift));
    r = a % (b << BigInt(shift));
  } else {
    q = (a << BigInt(-shift)) / b;
    r = (a << BigInt(-shift)) % b;
  }
  if (r !== 0n) q |= 1n;
  let result = Number(q) * Math.pow(2, shift);
  if (!Number.isFinite(result)) {
    result = Number(q) * Math.pow(2, shift - 64) * Math.pow(2, 64);
    if (!Number.isFinite(result)) raise(T.OverflowError, "integer division result too large for a float");
  }
  return neg ? -result : result;
}

// Python floor division and modulo on safe-integer numbers.  JS `%` on
// values outside int32 compiles to a slow fmod call, so outside int32 we
// divide in floating point and correct by one: with |a| + |b| < 2^53 the
// product q * b is exact, so r = a - q * b is exact.
const TWO53 = 9007199254740992;
function floorQuot(a: number, b: number): number {
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (b > 0 ? r < 0 : r > 0) q -= 1;
  else if (b > 0 ? r >= b : r <= b) q += 1;
  return q;
}

export function floordiv(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b !== 0) {
    if (Math.abs(a) + Math.abs(b) < TWO53) return floorQuot(a, b) + 0;
    const r = a % b; // exact for safe integers, so (a - r) / b is exact too
    const q = (a - r) / b;
    return (r !== 0 && r < 0 !== b < 0 ? q - 1 : q) + 0;
  }
  return floordivSlow(a, b);
}
function floordivSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    const x = big(a), y = big(b);
    if (y === 0n) raise(T.ZeroDivisionError, "integer division or modulo by zero");
    // One BigInt division; flooring only matters when the signs differ.
    let q = x / y;
    if (x < 0n !== y < 0n && q * y !== x) q -= 1n;
    return normBig(q);
  }
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "float floor division by zero");
    return mkfloat(floatDivmod(x, y)[0]);
  }
  return binaryDunder(a, b, "floordiv");
}

// CPython's _float_div_mod.
export function floatDivmod(vx: number, wx: number): [number, number] {
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1.0;
    }
  } else {
    mod = wx < 0 ? -0.0 : 0.0;
  }
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    const q = vx / wx;
    floordiv = q < 0 || Object.is(q, -0) ? -0.0 : 0.0;
  }
  return [floordiv, mod];
}

export function mod(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b !== 0) {
    if ((a | 0) === a && (b | 0) === b) {
      const r = a % b;
      return (r !== 0 && r < 0 !== b < 0 ? r + b : r) + 0;
    }
    if (Math.abs(a) + Math.abs(b) < TWO53) {
      let r = a - Math.floor(a / b) * b;
      if (b > 0) {
        if (r < 0) r += b;
        else if (r >= b) r -= b;
      } else if (r > 0) r += b;
      else if (r <= b) r -= b;
      return r + 0;
    }
    const r = a % b;
    return (r !== 0 && r < 0 !== b < 0 ? r + b : r) + 0;
  }
  if (typeof a === "string") return strFormatOpHook.f(a, b);
  return modSlow(a, b);
}
function modSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    const x = big(a), y = big(b);
    if (y === 0n) raise(T.ZeroDivisionError, "integer modulo by zero");
    let r = x % y;
    if (r !== 0n && r < 0n !== y < 0n) r += y;
    return normBig(r);
  }
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "float modulo by zero");
    return mkfloat(floatDivmod(x, y)[1]);
  }
  return binaryDunder(a, b, "mod");
}

export function divmod(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return tuple([floordiv(a, b), mod(a, b)]);
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "float divmod()");
    const [q, r] = floatDivmod(x, y);
    return tuple([mkfloat(q), mkfloat(r)]);
  }
  const f = special(a, "__divmod__");
  if (f !== undefined) {
    const r = f(a, b);
    if (r !== NotImplemented) return r;
  }
  raise(T.TypeError, `unsupported operand type(s) for divmod(): '${typeName(a)}' and '${typeName(b)}'`);
}

export function pow(a: any, b: any, m?: any): any {
  if (m !== undefined && m !== null) return powMod(a, b, m);
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b >= 0) {
    const r = Math.pow(a, b);
    if (isSafe(r)) return r + 0;
    return normBig(BigInt(a) ** BigInt(b));
  }
  return powSlow(a, b);
}
function powSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) >= 0n) return normBig(big(a) ** big(b));
    if (big(a) === 0n) raise(T.ZeroDivisionError, "0.0 cannot be raised to a negative power");
    return floatPow(fv(a)!, fv(b)!);
  }
  const x = fv(a), y = fv(b);
  if (x !== undefined && y !== undefined) return floatPow(x, y);
  return binaryDunder(a, b, "pow");
}
function floatPow(x: number, y: number): any {
  if (x === 0 && y < 0) raise(T.ZeroDivisionError, "zero to a negative power");
  if (x < 0 && !isInt(y) && Number.isFinite(y)) raise(T.ValueError, "complex numbers are not supported");
  const r = Math.pow(x, y);
  if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) raise(T.OverflowError, "(34, 'Numerical result out of range')");
  return mkfloat(r);
}
function powMod(a: any, b: any, m: any): any {
  if (!(isPyInt(a) && isPyInt(b) && isPyInt(m))) raise(T.TypeError, "pow() 3rd argument not allowed unless all arguments are integers");
  let base = big(a), e = big(b), n = big(m);
  if (n === 0n) raise(T.ValueError, "pow() 3rd argument cannot be 0");
  const neg = n < 0n;
  if (neg) n = -n;
  if (e < 0n) {
    base = modInverse(base, n);
    e = -e;
  }
  let r = 1n % n;
  base %= n;
  if (base < 0n) base += n;
  while (e > 0n) {
    if (e & 1n) r = (r * base) % n;
    base = (base * base) % n;
    e >>= 1n;
  }
  if (neg && r !== 0n) r -= n;
  return normBig(r);
}
function modInverse(a: bigint, n: bigint): bigint {
  let [r0, r1, s0, s1] = [((a % n) + n) % n, n, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) raise(T.ValueError, "base is not invertible for the given modulus");
  return ((s0 % n) + n) % n;
}

const I32 = (x: any) => typeof x === "number" && (x | 0) === x;

export function lshift(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b >= 0 && b < 53) {
    const r = a * Math.pow(2, b);
    if (isSafe(r)) return r + 0;
  }
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) < 0n) raise(T.ValueError, "negative shift count");
    return normBig(big(a) << big(b));
  }
  return binaryDunder(a, b, "lshift");
}
export function rshift(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b >= 0) {
    return b > 60 ? (a < 0 ? -1 : 0) : Math.floor(a / Math.pow(2, b)) + 0;
  }
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) < 0n) raise(T.ValueError, "negative shift count");
    return normBig(big(a) >> big(b));
  }
  return binaryDunder(a, b, "rshift");
}
export function and(a: any, b: any): any {
  if (I32(a) && I32(b)) return a & b;
  if (typeof a === "boolean" && typeof b === "boolean") return a && b;
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) & big(b));
  if (a instanceof PySet && b instanceof PySet) return setOp(a, b, "and");
  return binaryDunder(a, b, "and");
}
export function or(a: any, b: any): any {
  if (I32(a) && I32(b)) return a | b;
  if (typeof a === "boolean" && typeof b === "boolean") return a || b;
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) | big(b));
  if (a instanceof PySet && b instanceof PySet) return setOp(a, b, "or");
  if (a instanceof PyDict && b instanceof PyDict) {
    const r = dictCopy(a);
    dictUpdate(r, b);
    return r;
  }
  return binaryDunder(a, b, "or");
}
export function xor(a: any, b: any): any {
  if (I32(a) && I32(b)) return a ^ b;
  if (typeof a === "boolean" && typeof b === "boolean") return a !== b;
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) ^ big(b));
  if (a instanceof PySet && b instanceof PySet) return setOp(a, b, "xor");
  return binaryDunder(a, b, "xor");
}
export function matmul(a: any, b: any): any {
  return binaryDunder(a, b, "matmul");
}

const BIN: Record<string, (a: any, b: any) => any> = { add, sub, mul, truediv, floordiv, mod, pow: (a, b) => pow(a, b), lshift, rshift, and, or, xor, matmul };

export function iadd(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return add(a, b);
  if (typeof a === "string" && typeof b === "string") return a + b;
  if (Array.isArray(a) && (a as any).$t !== true) {
    if (Array.isArray(b)) {
      const n = b.length;
      for (let i = 0; i < n; i++) a.push(b[i]);
    } else forEach(b, (v) => void a.push(v));
    return a;
  }
  return inplace(a, b, "add", "__iadd__");
}
export function isub(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return sub(a, b);
  return inplace(a, b, "sub", "__isub__");
}
export function imul(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return mul(a, b);
  if (Array.isArray(a) && (a as any).$t !== true && repeatCount(b) !== undefined) {
    const r = repeatArray(a, repeatCount(b)!);
    a.length = 0;
    for (const v of r) a.push(v);
    return a;
  }
  return inplace(a, b, "mul", "__imul__");
}
export const itruediv = (a: any, b: any) => inplace(a, b, "truediv", "__itruediv__");
export const ifloordiv = (a: any, b: any) => (typeof a === "number" && typeof b === "number" ? floordiv(a, b) : inplace(a, b, "floordiv", "__ifloordiv__"));
export const imod = (a: any, b: any) => (typeof a === "number" && typeof b === "number" ? mod(a, b) : inplace(a, b, "mod", "__imod__"));
export const ipow = (a: any, b: any) => inplace(a, b, "pow", "__ipow__");
export const ilshift = (a: any, b: any) => inplace(a, b, "lshift", "__ilshift__");
export const irshift = (a: any, b: any) => inplace(a, b, "rshift", "__irshift__");
export const imatmul = (a: any, b: any) => inplace(a, b, "matmul", "__imatmul__");
export const iand = (a: any, b: any) => (a instanceof PySet && b instanceof PySet ? setInplace(a, b, "and") : inplace(a, b, "and", "__iand__"));
export const ixor = (a: any, b: any) => (a instanceof PySet && b instanceof PySet ? setInplace(a, b, "xor") : inplace(a, b, "xor", "__ixor__"));
export const ior = (a: any, b: any) => {
  if (a instanceof PySet && b instanceof PySet) return setInplace(a, b, "or");
  if (a instanceof PyDict) {
    dictUpdate(a, b);
    return a;
  }
  return inplace(a, b, "or", "__ior__");
};

export function neg(a: any): any {
  if (typeof a === "number") {
    if (isInt(a)) return a === 0 ? 0 : -a;
    return -a;
  }
  if (typeof a === "bigint") return normBig(-a);
  if (typeof a === "boolean") return a ? -1 : 0;
  if (a instanceof FloatBox) return mkfloat(-a.v);
  return unaryDunder(a, "__neg__", "-");
}
export function pos(a: any): any {
  if (typeof a === "number" || typeof a === "bigint" || a instanceof FloatBox) return a;
  if (typeof a === "boolean") return +a;
  return unaryDunder(a, "__pos__", "+");
}
export function invert(a: any): any {
  if (typeof a === "number" && isInt(a)) return -a - 1;
  if (isPyInt(a)) return normBig(-big(a) - 1n);
  return unaryDunder(a, "__invert__", "~");
}
function unaryDunder(a: any, name: string, sym: string): any {
  const f = special(a, name);
  if (f !== undefined) return f(a);
  raise(T.TypeError, `bad operand type for unary ${sym}: '${typeName(a)}'`);
}

export function abs(a: any): any {
  if (typeof a === "number") return isInt(a) ? Math.abs(a) : Math.abs(a);
  if (typeof a === "bigint") return a < 0n ? -a : a;
  if (typeof a === "boolean") return +a;
  if (a instanceof FloatBox) return new FloatBox(Math.abs(a.v));
  return unaryDunder(a, "__abs__", "abs()");
}

// ------------------------------------------------------------------ comparison

const REFLECT: Record<string, string> = { __lt__: "__gt__", __le__: "__ge__", __gt__: "__lt__", __ge__: "__le__", __eq__: "__eq__", __ne__: "__ne__" };
const SYM: Record<string, string> = { __lt__: "<", __le__: "<=", __gt__: ">", __ge__: ">=" };

// -1, 0, 1 or NaN (unordered) when both are numbers, else undefined.
function numCmp(a: any, b: any): number | undefined {
  let x = a, y = b;
  if (x instanceof FloatBox) x = x.v;
  if (y instanceof FloatBox) y = y.v;
  const tx = typeof x, ty = typeof y;
  if ((tx === "number" || tx === "bigint" || tx === "boolean") && (ty === "number" || ty === "bigint" || ty === "boolean")) {
    if (tx === "boolean") x = +x;
    if (ty === "boolean") y = +y;
    return x < y ? -1 : x > y ? 1 : x == y ? 0 : NaN;
  }
  return undefined;
}

function cmpResult(c: number, op: string): boolean {
  switch (op) {
    case "__lt__": return c < 0;
    case "__le__": return c <= 0;
    case "__gt__": return c > 0;
    case "__ge__": return c >= 0;
    case "__eq__": return c === 0;
    default: return c !== 0;
  }
}

export function seqCmp(a: any[], b: any[], op: string): any {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i] || eqBool(a[i], b[i])) continue;
    if (op === "__eq__") return false;
    if (op === "__ne__") return true;
    return richCompare(a[i], b[i], op);
  }
  return cmpResult(a.length - b.length, op);
}

export function richCompare(a: any, b: any, op: string): any {
  const c = numCmp(a, b);
  if (c !== undefined) return cmpResult(c, op);
  if (typeof a === "string" && typeof b === "string") return cmpResult(a < b ? -1 : a > b ? 1 : 0, op);
  if (Array.isArray(a) && Array.isArray(b) && (a as any).$t === (b as any).$t && (a as any).$cls === undefined && (b as any).$cls === undefined) return seqCmp(a, b, op);
  if (a instanceof PySet && b instanceof PySet && (a.$cls === T.set || a.$cls === T.frozenset) && (b.$cls === T.set || b.$cls === T.frozenset)) {
    const na = a.$d.$m.size, nb = b.$d.$m.size;
    switch (op) {
      case "__eq__": return na === nb && setSubset(a, b);
      case "__ne__": return !(na === nb && setSubset(a, b));
      case "__le__": return setSubset(a, b);
      case "__lt__": return na < nb && setSubset(a, b);
      case "__ge__": return setSubset(b, a);
      default: return na > nb && setSubset(b, a);
    }
  }
  if (a instanceof PyBytes && b instanceof PyBytes) {
    const n = Math.min(a.n, b.n);
    let c = 0;
    for (let i = 0; i < n && c === 0; i++) c = a.a[i] - b.a[i];
    return cmpResult(c !== 0 ? c : a.n - b.n, op);
  }
  if (a instanceof PyDict && b instanceof PyDict && a.$cls === T.dict && b.$cls === T.dict && (op === "__eq__" || op === "__ne__")) {
    const same = dictEquals(a, b);
    return op === "__eq__" ? same : !same;
  }
  const ta = typeOf(a), tb = typeOf(b);
  const rop = REFLECT[op];
  const reflectedFirst = ta !== tb && tb.$mro.includes(ta) && lookupType(tb, rop) !== lookupType(ta, rop);
  const left = () => {
    const f = lookupType(ta, op);
    return f === undefined ? NotImplemented : f(a, b);
  };
  const right = () => {
    const f = lookupType(tb, rop);
    return f === undefined ? NotImplemented : f(b, a);
  };
  let r = reflectedFirst ? right() : left();
  if (r !== NotImplemented) return r;
  r = reflectedFirst ? left() : right();
  if (r !== NotImplemented) return r;
  if (op === "__eq__") return a === b;
  if (op === "__ne__") return a !== b;
  raise(T.TypeError, `'${SYM[op]}' not supported between instances of '${ta.$name}' and '${tb.$name}'`);
}

export function dictEquals(a: PyDict, b: PyDict): boolean {
  if (a.$m.size !== b.$m.size) return false;
  for (const [k, v] of a.$m) {
    const w = dictGet(b, dictKeyOf(a, k));
    if (w === undefined || !eqBool(v, w)) return false;
  }
  return true;
}

export function lt(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a < b : richCompare(a, b, "__lt__");
}
export function le(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a <= b : richCompare(a, b, "__le__");
}
export function gt(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a > b : richCompare(a, b, "__gt__");
}
export function ge(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a >= b : richCompare(a, b, "__ge__");
}
export function eq(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a === null && b === null) return true;
  if (identityEq(a, b)) return a === b;
  return richCompare(a, b, "__eq__");
}
export function ne(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a !== b;
  if (typeof a === "string" && typeof b === "string") return a !== b;
  if (a === null && b === null) return false;
  if (identityEq(a, b)) return a !== b;
  return richCompare(a, b, "__ne__");
}

// True when == between a and b reduces to identity: both are instances of
// Python classes (or None) whose __eq__/__ne__ are object's.
function identityEq(a: any, b: any): boolean {
  if (a === null || typeof a !== "object" || (b !== null && typeof b !== "object")) return false;
  const ta = a.$cls;
  if (ta === undefined || ta.$ctor === null || ta.$jsBase !== null || !defaultEq(ta)) return false;
  if (b === null) return true;
  const tb = b.$cls;
  return tb !== undefined && tb.$ctor !== null && tb.$jsBase === null && defaultEq(tb);
}
function defaultEq(t: any): boolean {
  if (t.$eqVer === t.$ver) return t.$eqDefault;
  t.$eqVer = t.$ver;
  t.$eqDefault = lookupType(t, "__eq__") === objectEq && lookupType(t, "__ne__") === objectNe;
  return t.$eqDefault;
}
// Equality as a JS boolean, with Python's identity shortcut for containers.
export function eqBool(a: any, b: any): boolean {
  if (a === b) return typeof a !== "number" || a === a;
  return truth(eq(a, b));
}
export function is(a: any, b: any): boolean {
  return a === b || (a !== a && b !== b);
}

// `x in c`
export function arrContains(c: any[], x: any): boolean {
  for (let i = 0; i < c.length; i++) if (c[i] === x || eqBool(c[i], x)) return true;
  return false;
}
export function contains(c: any, x: any): boolean {
  if (Array.isArray(c) && ((c as any).$cls === undefined || layoutPlain((c as any).$cls))) return arrContains(c, x);
  if (typeof c === "string") {
    if (typeof x !== "string") raise(T.TypeError, `'in <string>' requires string as left operand, not ${typeName(x)}`);
    return c.includes(x);
  }
  if (c instanceof PyDict && c.$cls === T.dict) return dictGet(c, x) !== undefined;
  if (c instanceof PySet && (c.$cls === T.set || c.$cls === T.frozenset)) return dictGet(c.$d, x) !== undefined;
  if (c instanceof PyBytes) {
    if (isPyInt(x)) return c.a.subarray(0, c.n).includes(Number(x));
    if (!(x instanceof PyBytes)) raise(T.TypeError, `a bytes-like object is required, not '${typeName(x)}'`);
    return Buffer.from(c.a.buffer, c.a.byteOffset, c.n).includes(Buffer.from(x.a.buffer, x.a.byteOffset, x.n));
  }
  const f = special(c, "__contains__");
  if (f !== undefined) return truth(f(c, x));
  const it = iter(c);
  for (let v = it.$next(); v !== DONE; v = it.$next()) if (eqBool(v, x)) return true;
  return false;
}

// ------------------------------------------------------------------ truth, len, hash

export function truth(x: any): boolean {
  if (x === true) return true;
  if (x === false) return false;
  if (typeof x === "number") return x !== 0;
  return truthSlow(x);
}
function truthSlow(x: any): boolean {
  if (x === null) return false;
  if (typeof x === "string") return x.length !== 0;
  if (typeof x === "bigint") return x !== 0n;
  if (x instanceof FloatBox) return x.v !== 0;
  if (Array.isArray(x) && ((x as any).$cls === undefined || layoutPlain((x as any).$cls))) return x.length !== 0;
  if (x instanceof PyDict && (x.$cls === T.dict || layoutPlain(x.$cls))) return x.$m.size !== 0;
  if (x instanceof PyBytes) return x.n !== 0;
  if (typeof x === "function") return true;
  let f = special(x, "__bool__");
  if (f !== undefined) {
    const r = f(x);
    if (typeof r !== "boolean") raise(T.TypeError, `__bool__ should return bool, returned ${typeName(r)}`);
    return r;
  }
  f = special(x, "__len__");
  if (f !== undefined) return truth(f(x));
  return true;
}

export function len(x: any): number {
  if (typeof x === "string") return x.length;
  if (Array.isArray(x) && ((x as any).$cls === undefined || layoutPlain((x as any).$cls))) return x.length;
  if (x instanceof PyDict && (x.$cls === T.dict || layoutPlain(x.$cls))) return x.$m.size;
  if (x instanceof PySet && (x.$cls === T.set || x.$cls === T.frozenset)) return x.$d.$m.size;
  if (x instanceof PyBytes) return x.n;
  const f = special(x, "__len__");
  if (f !== undefined) {
    const n = f(x);
    if (!isPyInt(n)) raise(T.TypeError, `'${typeName(n)}' object cannot be interpreted as an integer`);
    if (n < 0) raise(T.ValueError, "__len__() should return >= 0");
    return Number(n);
  }
  raise(T.TypeError, `object of type '${typeName(x)}' has no len()`);
}

const HASH_MOD = (1n << 61n) - 1n;

function hashInt(x: number | bigint): number {
  if (typeof x === "number" && x >= -1073741824 && x < 1073741824) return x === -1 ? -2 : x;
  const b = big(x);
  const neg = b < 0n;
  let h = (neg ? -b : b) % HASH_MOD;
  if (neg) h = -h;
  const r = Number(h);
  return r === -1 ? -2 : r;
}

// CPython's _Py_HashDouble.
function hashFloat(v: number): number {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 0 : v > 0 ? 314159 : -314159;
  if (isInt(v)) return hashInt(isSafe(v) ? v : BigInt(v));
  let m = Math.abs(v);
  let e = 0;
  while (m >= 1) {
    m /= 2;
    e++;
  }
  while (m < 0.5) {
    m *= 2;
    e--;
  }
  let x = 0n;
  while (m) {
    x = ((x << 28n) & HASH_MOD) | (x >> 33n);
    m *= 268435456.0;
    e -= 28;
    const y = Math.floor(m);
    m -= y;
    x += BigInt(y);
    if (x >= HASH_MOD) x -= HASH_MOD;
  }
  const ee = ((e % 61) + 61) % 61;
  x = ((x << BigInt(ee)) & HASH_MOD) | (x >> BigInt(61 - ee));
  let r = Number(x);
  if (v < 0) r = -r;
  return r === -1 ? -2 : r;
}

// FNV-1a.  CPython randomizes str hashes per process, so programs cannot
// depend on their values.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h === -1 ? -2 : h;
}

let idCounter = 0x7f0000001000;
const ids = new WeakMap<object, number>();
export function id(x: any): number {
  if (x === null || (typeof x !== "object" && typeof x !== "function")) return 0x7e0000000000 + (hashAny(x) & 0xffffff) * 32;
  let v = ids.get(x);
  if (v === undefined) {
    v = idCounter += 32;
    ids.set(x, v);
  }
  return v;
}

export function hashAny(x: any): number {
  switch (typeof x) {
    case "number":
      return isInt(x) ? hashInt(x) : hashFloat(x);
    case "bigint":
      return hashInt(x);
    case "string":
      return hashStr(x);
    case "boolean":
      return x ? 1 : 0;
  }
  if (x === null) return 0x5f5e1;
  if (x instanceof FloatBox) return hashFloat(x.v);
  if (Array.isArray(x) && (x as any).$cls === undefined) {
    if ((x as any).$t !== true) raise(T.TypeError, "unhashable type: 'list'");
    return hashTuple(x);
  }
  if (x instanceof PySet && x.$frozen) {
    let h = 0;
    for (const v of setItems(x)) h ^= hashAny(v) * 3644798167;
    return h | 0;
  }
  const t = typeOf(x);
  const f = lookupType(t, "__hash__");
  if (f === null) raise(T.TypeError, `unhashable type: '${t.$name}'`);
  if (f !== undefined && f !== objectHash) {
    const r = f(x);
    if (typeof r === "number" && isInt(r)) return r;
    if (typeof r === "boolean") return +r;
    if (typeof r === "bigint") return hashInt(r);
    raise(T.TypeError, "__hash__ method should return an integer");
  }
  return id(x) / 32;
}

export function hashTupleOf(a: any[]): number {
  return hashTuple(a);
}
// CPython's tuplehash (xxHash-based) on 64-bit lanes.
function hashTuple(a: any[]): number {
  const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P5 = 2870177450012600261n, M = (1n << 64n) - 1n;
  let acc = P5;
  for (const v of a) {
    const lane = BigInt.asUintN(64, BigInt(hashAny(v)));
    acc = (acc + lane * P2) & M;
    acc = ((acc << 31n) | (acc >> 33n)) & M;
    acc = (acc * P1) & M;
  }
  acc = (acc + (BigInt(a.length) ^ (P5 ^ 3527539n))) & M;
  if (acc === M) return 1546275796;
  return Number(BigInt.asIntN(64, acc));
}

function markPy(f: any, name: string) {
  f.$pyfn = true;
  f.__name__ = name;
  f.__qualname__ = name;
  return f;
}
export const objectHash = markPy(function __hash__(self: any) {
  return id(self) / 32;
}, "__hash__");
export const objectEq = markPy(function __eq__(self: any, other: any) {
  return self === other ? true : NotImplemented;
}, "__eq__");
export const objectNe = markPy(function __ne__(self: any, other: any) {
  const eq = lookupType(typeOf(self), "__eq__");
  const r = eq === undefined ? NotImplemented : eq(self, other);
  return r === NotImplemented ? r : !truth(r);
}, "__ne__");

hooks.hash = hashAny;
hooks.eq = eqBool;

// ------------------------------------------------------------------ iteration
//
// Every iterator answers $next(), returning DONE when exhausted.  Compiled
// for-loops call $next() directly; no {value, done} objects are allocated.

export class ListIter {
  i = 0;
  constructor(public a: any[]) {}
  $next(): any {
    const a = this.a;
    return this.i < a.length ? a[this.i++] : DONE;
  }
}
export class RangeIter {
  constructor(public cur: number, public stop: number, public step: number) {}
  $next(): any {
    const c = this.cur;
    if (this.step > 0 ? c < this.stop : c > this.stop) {
      this.cur = c + this.step;
      return c;
    }
    return DONE;
  }
}
export class StrIter {
  i = 0;
  constructor(public s: string) {}
  $next(): any {
    const s = this.s;
    if (this.i >= s.length) return DONE;
    const cp = s.codePointAt(this.i)!;
    const ch = String.fromCodePoint(cp);
    this.i += ch.length;
    return ch;
  }
}
// kind: 0 keys, 1 values, 2 items
export class DictIter {
  it: Iterator<any>;
  size: number;
  constructor(public d: PyDict, public kind: number) {
    this.it = kind === 1 ? d.$m.values() : kind === 0 ? d.$m.keys() : d.$m.entries();
    this.size = d.$m.size;
  }
  $next(): any {
    if (this.d.$m.size !== this.size) {
      this.size = -1;
      raise(T.RuntimeError, "dictionary changed size during iteration");
    }
    const r = this.it.next();
    if (r.done) return DONE;
    if (this.kind === 0) return dictKeyOf(this.d, r.value);
    if (this.kind === 1) return r.value;
    return tuple([dictKeyOf(this.d, r.value[0]), r.value[1]]);
  }
}
export class BytesIter {
  i = 0;
  constructor(public b: PyBytes) {}
  $next(): any {
    return this.i < this.b.n ? this.b.a[this.i++] : DONE;
  }
}
export class GenIter {
  constructor(public g: Generator) {}
  $next(): any {
    const r = genStep(this.g, false, undefined);
    return r.done ? DONE : r.value;
  }
}

// The GeneratorExit being thrown into a generator by close(), if any.
export const closing: { e: any } = { e: null };

// One step of a generator (next/send, or throw), with Python's rules: a
// StopIteration escaping the body becomes RuntimeError (PEP 479), re-entry is
// a ValueError, and a just-started generator only accepts None.
export function genStep(g: any, isThrow: boolean, arg: any): IteratorResult<any> {
  if (g.$started !== true) {
    if (!isThrow && arg !== undefined && arg !== null) raise(T.TypeError, "can't send non-None value to a just-started generator");
    g.$started = true;
  }
  try {
    const r = isThrow ? g.throw(arg) : g.next(arg);
    if (r.done && r.value === undefined) r.value = null;
    return r;
  } catch (e: any) {
    if (isExc(e, T.StopIteration)) {
      const err = T.RuntimeError(g.$async ? "coroutine raised StopIteration" : "generator raised StopIteration");
      err.__cause__ = e;
      throw err;
    }
    if (e instanceof TypeError && /already running/.test(e.message)) raise(T.ValueError, "generator already executing");
    throw e;
  }
}
// The StopIteration a ProtoIter swallowed most recently, so wrappers such as
// enumerate and map can re-raise it with its value.
export const lastStop: { e: any } = { e: null };

// Any object implementing __next__.
export class ProtoIter {
  nx: any;
  constructor(public o: any) {
    const f = lookupType(typeOf(o), "__next__");
    if (f === undefined) raise(T.TypeError, `iter() returned non-iterator of type '${typeName(o)}'`);
    this.nx = f;
  }
  $next(): any {
    try {
      return this.nx(this.o);
    } catch (e: any) {
      if (isExc(e, T.StopIteration)) {
        lastStop.e = e;
        return DONE;
      }
      throw e;
    }
  }
}
class GetitemIter {
  i = 0;
  constructor(public o: any, public gi: any) {}
  $next(): any {
    try {
      return this.gi(this.o, this.i++);
    } catch (e: any) {
      if (isExc(e, T.IndexError) || isExc(e, T.StopIteration)) return DONE;
      throw e;
    }
  }
}
function isExc(e: any, cls: PyType): boolean {
  return e !== null && typeof e === "object" && e.$cls !== undefined && e.$cls.$mro.includes(cls);
}
const isGen = (x: any) => x !== null && typeof x === "object" && x[Symbol.toStringTag] === "Generator";

export function iter(x: any): any {
  if (Array.isArray(x) && ((x as any).$cls === undefined || layoutPlain((x as any).$cls))) return new ListIter(x);
  if (typeof x === "string") return new StrIter(x);
  if (x !== null && typeof x === "object") {
    if (typeof x.$next === "function") return x;
    if (x instanceof PyDict && x.$cls === T.dict) return new DictIter(x, 0);
    if (x instanceof PySet && (x.$cls === T.set || x.$cls === T.frozenset)) return new DictIter(x.$d, 0);
    if (x instanceof PyBytes) return new BytesIter(x);
    if (isGen(x)) return new GenIter(x);
    const f = special(x, "__iter__");
    if (f !== undefined) {
      const it = f(x);
      if (it !== null && typeof it === "object" && typeof it.$next === "function") return it;
      if (isGen(it)) return new GenIter(it);
      return new ProtoIter(it);
    }
    const gi = special(x, "__getitem__");
    if (gi !== undefined) return new GetitemIter(x, gi);
  }
  raise(T.TypeError, `'${typeName(x)}' object is not iterable`);
}

export function next(it: any, dflt?: any): any {
  if (it !== null && typeof it === "object" && typeof it.$next === "function") {
    lastStop.e = null;
    const v = it.$next();
    if (v !== DONE) return v;
    if (dflt !== undefined) return dflt;
    throw lastStop.e ?? T.StopIteration();
  }
  if (isGen(it)) {
    const r = genStep(it, false, undefined);
    if (!r.done) return r.value;
    if (dflt !== undefined) return dflt;
    throw stopIteration(r.value);
  }
  const f = special(it, "__next__");
  if (f === undefined) raise(T.TypeError, `'${typeName(it)}' object is not an iterator`);
  if (dflt === undefined) return f(it);
  try {
    return f(it);
  } catch (e: any) {
    if (isExc(e, T.StopIteration)) return dflt;
    throw e;
  }
}

export function stopIteration(value: any): any {
  return T.StopIteration(...(value === undefined || value === null ? [] : [value]));
}

export function forEach(x: any, f: (v: any) => void) {
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) f(x[i]);
    return;
  }
  const it = iter(x);
  for (let v = it.$next(); v !== DONE; v = it.$next()) f(v);
}

export function toArray(x: any): any[] {
  if (Array.isArray(x)) return x.slice();
  const out: any[] = [];
  const it = iter(x);
  for (let v = it.$next(); v !== DONE; v = it.$next()) out.push(v);
  return out;
}

// `a, b = x`
export function unpack(x: any, n: number): any[] {
  if (Array.isArray(x)) {
    if (x.length === n) return x;
    if (x.length < n) raise(T.ValueError, `not enough values to unpack (expected ${n}, got ${x.length})`);
    raise(T.ValueError, `too many values to unpack (expected ${n})`);
  }
  const it = iter(x);
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const v = it.$next();
    if (v === DONE) raise(T.ValueError, `not enough values to unpack (expected ${n}, got ${i})`);
    out.push(v);
  }
  if (it.$next() !== DONE) raise(T.ValueError, `too many values to unpack (expected ${n})`);
  return out;
}
// `a, *b, c = x` -> [a, [b...], c]
export function unpackEx(x: any, before: number, after: number): any[] {
  const all = toArray(x);
  if (all.length < before + after) raise(T.ValueError, `not enough values to unpack (expected at least ${before + after}, got ${all.length})`);
  return [...all.slice(0, before), all.slice(before, all.length - after), ...all.slice(all.length - after)];
}

// ------------------------------------------------------------------ sets

// A set is a dict whose values are all `true`.
export class PySet {
  declare $cls: any;
  $d = new PyDict();
  $frozen = false;
}
export function newSet(items?: any, frozen = false): PySet {
  const s = new PySet();
  s.$frozen = frozen;
  if (items !== undefined) forEach(items, (v) => dictSet(s.$d, v, true));
  return s;
}
export function setAdd(s: PySet, v: any) {
  dictSet(s.$d, v, true);
}
export function setItems(s: PySet): any[] {
  const out: any[] = [];
  for (const k of s.$d.$m.keys()) out.push(dictKeyOf(s.$d, k));
  return out;
}
// Sets whose keys all normalize to JS primitives share one key space, so
// set algebra can work on the underlying Map keys directly.
const flat = (s: PySet) => s.$d.$buckets === null;

export function setSubset(a: PySet, b: PySet): boolean {
  if (a.$d.$m.size > b.$d.$m.size) return false;
  if (flat(a) && flat(b)) {
    const bm = b.$d.$m;
    for (const k of a.$d.$m.keys()) if (!bm.has(k)) return false;
    return true;
  }
  return setItems(a).every((v) => dictGet(b.$d, v) !== undefined);
}

export function setOp(a: PySet, b: PySet, op: string): PySet {
  const r = new PySet();
  r.$frozen = a.$frozen;
  if (flat(a) && flat(b)) {
    const am = a.$d.$m, bm = b.$d.$m, rm = r.$d.$m;
    // Equal keys keep the version CPython keeps: union and difference take
    // a's, intersection takes the smaller (iterated) set's.
    const ao = a.$d.$orig, bo = b.$d.$orig;
    let ro: Map<any, any> | null = null;
    const add = (k: any, orig: Map<any, any> | null) => {
      rm.set(k, true);
      const o = orig?.get(k);
      if (o !== undefined) (ro ??= new Map()).set(k, o);
    };
    if (op === "or") {
      for (const k of am.keys()) add(k, ao);
      for (const k of bm.keys()) if (!am.has(k)) add(k, bo);
    } else if (op === "and") {
      const aSmall = am.size <= bm.size;
      const [x, y, xo] = aSmall ? [am, bm, ao] : [bm, am, bo];
      for (const k of x.keys()) if (y.has(k)) add(k, xo);
    } else if (op === "sub") {
      for (const k of am.keys()) if (!bm.has(k)) add(k, ao);
    } else {
      for (const k of am.keys()) if (!bm.has(k)) add(k, ao);
      for (const k of bm.keys()) if (!am.has(k)) add(k, bo);
    }
    r.$d.$orig = ro;
    return r;
  }
  if (op === "or") {
    for (const v of setItems(a)) setAdd(r, v);
    for (const v of setItems(b)) setAdd(r, v);
  } else if (op === "and") {
    for (const v of setItems(a)) if (dictGet(b.$d, v) !== undefined) setAdd(r, v);
  } else if (op === "sub") {
    for (const v of setItems(a)) if (dictGet(b.$d, v) === undefined) setAdd(r, v);
  } else {
    for (const v of setItems(a)) if (dictGet(b.$d, v) === undefined) setAdd(r, v);
    for (const v of setItems(b)) if (dictGet(a.$d, v) === undefined) setAdd(r, v);
  }
  return r;
}
function setInplace(a: PySet, b: PySet, op: string): PySet {
  a.$d = setOp(a, b, op).$d;
  return a;
}

// ------------------------------------------------------------------ dict helpers

export function dictCopy(d: PyDict): PyDict {
  const r = new PyDict();
  for (const [k, v] of d.$m) dictSet(r, dictKeyOf(d, k), v);
  return r;
}
export function dictUpdate(d: PyDict, other: any) {
  if (other instanceof PyDict) {
    for (const [k, v] of other.$m) dictSet(d, dictKeyOf(other, k), v);
    return;
  }
  const keys = special(other, "keys");
  if (keys !== undefined) {
    forEach(keys(other), (k) => dictSet(d, k, getitem(other, k)));
    return;
  }
  let i = 0;
  forEach(other, (item) => {
    const kv = toArray(item);
    if (kv.length !== 2) raise(T.ValueError, `dictionary update sequence element #${i} has length ${kv.length}; 2 is required`);
    dictSet(d, kv[0], kv[1]);
    i++;
  });
}

// ------------------------------------------------------------------ subscripting

export class PySlice {
  constructor(public start: any, public stop: any, public step: any) {}
}

export function index(x: any): number | bigint {
  if (typeof x === "number" && isInt(x)) return x;
  if (typeof x === "bigint") return x;
  if (typeof x === "boolean") return +x;
  const f = special(x, "__index__");
  if (f !== undefined) return f(x);
  raise(T.TypeError, `'${typeName(x)}' object cannot be interpreted as an integer`);
}

// CPython's PySlice_GetIndicesEx: [start, step, count].
// slice.indices(len): CPython's PySlice_AdjustIndices.
export function sliceAdjust(s: PySlice, len: number): [number, number, number] {
  const step = s.step === null ? 1 : Number(index(s.step));
  if (step === 0) raise(T.ValueError, "slice step cannot be zero");
  const lo = step < 0 ? -1 : 0, hi = step < 0 ? len - 1 : len;
  const fix = (v: any, dflt: number) => {
    if (v === null) return dflt;
    const n = Number(index(v));
    if (n < 0) return Math.max(n + len, lo);
    return Math.min(n, hi);
  };
  return [fix(s.start, step < 0 ? hi : lo), fix(s.stop, step < 0 ? lo : hi), step];
}

export function sliceIndices(s: PySlice, len: number): [number, number, number] {
  const [start, stop, step] = sliceAdjust(s, len);
  let n = 0;
  if (step > 0 ? start < stop : start > stop) n = Math.floor((stop - start - (step > 0 ? 1 : -1)) / step) + 1;
  return [start, step, n];
}

export function seqIndex(i: any, len: number, what: string): number {
  let j: number;
  if (typeof i === "number" && isInt(i)) j = i;
  else if (typeof i === "boolean") j = +i;
  else if (typeof i === "bigint") j = i < 0n ? -Infinity : Infinity;
  else {
    const f = special(i, "__index__");
    if (f === undefined) raise(T.TypeError, `${what} indices must be integers or slices, not ${typeName(i)}`);
    j = Number(f(i));
  }
  if (j < 0) j += len;
  if (j < 0 || j >= len) raise(T.IndexError, `${what} index out of range`);
  return j;
}

export function getitem(o: any, k: any): any {
  if (Array.isArray(o) && (o as any).$cls === undefined) {
    if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) return o[k];
    return arrGet(o, k);
  }
  if (o instanceof PyDict && o.$cls === T.dict) {
    const v = dictGet(o, k);
    if (v !== undefined) return v;
    throw T.KeyError(k);
  }
  return getitemSlow(o, k);
}
export function arrGet(o: any[], k: any): any {
  {
    if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) return o[k];
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.length);
      const r = new Array(n);
      for (let i = 0, j = start; i < n; i++, j += step) r[i] = o[j];
      return (o as any).$t === true ? tuple(r) : r;
    }
    return o[seqIndex(k, o.length, (o as any).$t === true ? "tuple" : "list")];
  }
}
export function dictGetitem(o: PyDict, k: any): any {
  const v = dictGet(o, k);
  if (v !== undefined) return v;
  return dictMissing(o, k);
}
export const arrayHooks: { cls: any; get: any; set: any } = { cls: null, get: null, set: null };

function getitemSlow(o: any, k: any): any {
  if (o !== null && typeof o === "object") {
    const c = o.$cls;
    // Instances of Python classes: straight to the (cached) __getitem__.
    if (c !== undefined && c.$ctor !== null && c.$jsBase === null) {
      const f = special(o, "__getitem__");
      if (f !== undefined) return f(o, k);
    }
  }
  if (arrayHooks.cls !== null && o instanceof arrayHooks.cls) return arrayHooks.get(o, k);
  if (Array.isArray(o) || o instanceof PyDict) {
    const f = special(o, "__getitem__");
    return f(o, k);
  }
  if (o instanceof PyBytes) {
    if (typeof k === "number" && k >= 0 && k < o.n && isInt(k)) return o.a[k];
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.n);
      const r = new Uint8Array(n);
      for (let i = 0, j = start; i < n; i++, j += step) r[i] = o.a[j];
      return o instanceof PyByteArray ? new PyByteArray(r) : new PyBytes(r);
    }
    return o.a[seqIndex(k, o.n, "index")];
  }
  if (typeof o === "string") {
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.length);
      if (step === 1) return o.slice(start, start + n);
      let r = "";
      for (let i = 0, j = start; i < n; i++, j += step) r += o[j];
      return r;
    }
    return o[seqIndex(k, o.length, "string")];
  }
  if (isType(o)) {
    const cg = lookupType(o, "__class_getitem__");
    if (cg !== undefined) return cg(o, k);
    if (o.$module === "builtins") return o; // list[int] and friends: annotations only
  }
  const f = special(o, "__getitem__");
  if (f !== undefined) return f(o, k);
  raise(T.TypeError, `'${typeName(o)}' object is not subscriptable`);
}

function dictMissing(d: PyDict, k: any): any {
  const t = typeOf(d);
  if (t !== T.dict) {
    const m = lookupType(t, "__missing__");
    if (m !== undefined) return m(d, k);
  }
  throw T.KeyError(k);
}

function byteValue(v: any): number {
  if (!isPyInt(v)) raise(T.TypeError, `'${typeName(v)}' object cannot be interpreted as an integer`);
  const n = Number(v);
  if (n < 0 || n > 255) raise(T.ValueError, "byte must be in range(0, 256)");
  return n;
}

function bytearraySetSlice(o: PyByteArray, k: PySlice, v: any) {
  const src: Uint8Array = v instanceof PyBytes ? v.a.slice(0, v.n) : Uint8Array.from(toArray(v).map(byteValue));
  const [start, step, n] = sliceIndices(k, o.n);
  if (step === 1) {
    const r = new Uint8Array(o.n - n + src.length);
    r.set(o.a.subarray(0, start), 0);
    r.set(src, start);
    r.set(o.a.subarray(start + n, o.n), start + src.length);
    o.a = r;
    o.n = r.length;
    return;
  }
  if (src.length !== n) raise(T.ValueError, `attempt to assign bytes of size ${src.length} to extended slice of size ${n}`);
  const a = o.a;
  for (let i = 0, j = start; i < n; i++, j += step) a[j] = src[i];
}

export function arrSet(o: any[], k: any, v: any): void {
  if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) o[k] = v;
  else if (k instanceof PySlice) setSlice(o, k, v);
  else o[seqIndex(k, o.length, "list")] = v;
}

export function setitem(o: any, k: any, v: any): void {
  if (o !== null && typeof o === "object" && !Array.isArray(o)) {
    const c = o.$cls;
    if (c !== undefined && c.$ctor !== null && c.$jsBase === null) {
      const f = special(o, "__setitem__");
      if (f !== undefined) {
        f(o, k, v);
        return;
      }
    }
  }
  if (Array.isArray(o) && (o as any).$t !== true && (o as any).$cls === undefined) {
    if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) {
      o[k] = v;
      return;
    }
    if (k instanceof PySlice) return setSlice(o, k, v);
    o[seqIndex(k, o.length, "list")] = v;
    return;
  }
  if (o instanceof PyDict && o.$cls === T.dict) {
    dictSet(o, k, v);
    return;
  }
  if (arrayHooks.cls !== null && o instanceof arrayHooks.cls) return arrayHooks.set(o, k, v);
  if (o instanceof PyByteArray) {
    if (k instanceof PySlice) return bytearraySetSlice(o, k, v);
    o.a[seqIndex(k, o.n, "bytearray")] = byteValue(v);
    return;
  }
  const f = special(o, "__setitem__");
  if (f !== undefined) {
    f(o, k, v);
    return;
  }
  raise(T.TypeError, `'${typeName(o)}' object does not support item assignment`);
}

function setSlice(o: any[], k: PySlice, v: any) {
  const items = toArray(v);
  const [start, step, n] = sliceIndices(k, o.length);
  if (step === 1) {
    o.splice(start, n, ...items);
    return;
  }
  if (items.length !== n) raise(T.ValueError, `attempt to assign sequence of size ${items.length} to extended slice of size ${n}`);
  for (let i = 0, j = start; i < n; i++, j += step) o[j] = items[i];
}

export function delitem(o: any, k: any): void {
  if (Array.isArray(o) && (o as any).$t !== true && (o as any).$cls === undefined) return arrDel(o, k);
  if (o instanceof PyDict && o.$cls === T.dict) {
    if (!dictDelete(o, k)) throw T.KeyError(k);
    return;
  }
  const f = special(o, "__delitem__");
  if (f !== undefined) {
    f(o, k);
    return;
  }
  raise(T.TypeError, `'${typeName(o)}' object doesn't support item deletion`);
}
export function arrDel(o: any[], k: any): void {
  {
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.length);
      if (step === 1) o.splice(start, n);
      else {
        const drop = new Set<number>();
        for (let i = 0, j = start; i < n; i++, j += step) drop.add(j);
        const keep = o.filter((_, i) => !drop.has(i));
        o.length = 0;
        o.push(...keep);
      }
      return;
    }
    o.splice(seqIndex(k, o.length, "list"), 1);
    return;
  }
}

// `str % args`, filled in by format.ts.
export const strFormatOpHook: { f: (s: string, args: any) => string } = { f: () => "" };
