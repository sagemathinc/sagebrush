// complex numbers and the cmath module.  Mixed arithmetic goes through the
// generic dunder path: int/float return NotImplemented for complex operands
// and complex.__radd__ etc. take over.

import { T, FloatBox, NotImplemented, PyBytes, raise, typeName, tuple, unbox, typeOf, lookupType, bindArgs, sig, pyfn } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { floatRepr, format, repr } from "./format";
import { newBuiltinModule } from "./modules";
import * as FD from "./fdlibm";
import * as CR from "./crmath";
import { glibcExp, glibcLog, glibcLog1p, glibcPow } from "./libm";

export class PyComplex {
  constructor(public re: number, public im: number) {}
}

// [re, im] of an int, float, bool or complex (or a subclass), else undefined.
export function toC(x: any): [number, number] | undefined {
  x = unbox(x);
  if (x instanceof PyComplex) return [x.re, x.im];
  const v = O.fv(x);
  return v === undefined ? undefined : [v, 0];
}

function cpow(a: [number, number], b: [number, number]): PyComplex {
  const [ar, ai] = a, [br, bi] = b;
  if (br === 0 && bi === 0) return new PyComplex(1, 0);
  if (ar === 0 && ai === 0) {
    if (bi !== 0 || br < 0) raise(T.ZeroDivisionError, "zero to a negative or complex power");
    return new PyComplex(0, 0);
  }
  if (bi === 0 && Number.isInteger(br) && Math.abs(br) <= 100) {
    // repeated squaring, as CPython's c_powi
    let n = Math.abs(br), rr = 1, ri = 0, xr = ar, xi = ai;
    while (n > 0) {
      if (n & 1) [rr, ri] = [rr * xr - ri * xi, rr * xi + ri * xr];
      [xr, xi] = [xr * xr - xi * xi, 2 * xr * xi];
      n >>= 1;
    }
    if (br < 0) return cdiv([1, 0], [rr, ri]);
    return new PyComplex(rr, ri);
  }
  const vabs = CR.hypot(ar, ai);
  let len = glibcPow(vabs, br);
  const at = CR.atan2(ai, ar);
  let phase = at * br;
  if (bi !== 0) {
    len /= glibcExp(at * bi);
    phase += bi * glibcLog(vabs);
  }
  const r = new PyComplex(len * CR.cos(phase), len * CR.sin(phase));
  if (!Number.isFinite(r.re) && Number.isFinite(ar) && Number.isFinite(ai) && Number.isFinite(br) && Number.isFinite(bi)) raise(T.OverflowError, "complex exponentiation");
  return r;
}
export const complexPow = (x: number, y: number) => cpow([x, 0], [y, 0]);

const isInf = (x: number) => x === Infinity || x === -Infinity;
const isFin = Number.isFinite;
const sgn = (one: boolean, x: number) => (x < 0 || Object.is(x, -0) ? (one ? -1 : -0) : one ? 1 : 0);
const copysign0 = (x: number) => (x !== x ? 0 : x); // (a NaN becomes 0; C's copysign(0, nan) is +0 for these NaNs)

// a * b, with C11 Annex G's recovery of infinities (as CPython 3.14's
// _Py_c_prod): when both parts come out NaN but an operand is infinite, the
// infinite one is reduced to its direction and the product taken again
function cmul(ar: number, ai: number, br: number, bi: number): PyComplex {
  const ac = ar * br, bd = ai * bi, ad = ar * bi, bc = ai * br;
  let x = ac - bd, y = ad + bc;
  if (x !== x && y !== y) {
    let a = ar, b = ai, c = br, d = bi, recalc = false;
    if (isInf(a) || isInf(b)) {
      a = sgn(isInf(a), a);
      b = sgn(isInf(b), b);
      if (c !== c) c = copysign0(c);
      if (d !== d) d = copysign0(d);
      recalc = true;
    }
    if (isInf(c) || isInf(d)) {
      c = sgn(isInf(c), c);
      d = sgn(isInf(d), d);
      if (a !== a) a = copysign0(a);
      if (b !== b) b = copysign0(b);
      recalc = true;
    }
    if (!recalc && (isInf(ac) || isInf(bd) || isInf(ad) || isInf(bc))) {
      if (a !== a) a = copysign0(a);
      if (b !== b) b = copysign0(b);
      if (c !== c) c = copysign0(c);
      if (d !== d) d = copysign0(d);
      recalc = true;
    }
    if (recalc) {
      x = Infinity * (a * c - b * d);
      y = Infinity * (a * d + b * c);
    }
  }
  return new PyComplex(x, y);
}

// a / b: Smith's algorithm, as CPython's _Py_c_quot, then (when both parts
// are NaN) C11 Annex G's recovery of infinities and zeros, as CPython 3.14's
function cdiv(a: [number, number], b: [number, number]): PyComplex {
  const [ar, ai] = a, [br, bi] = b;
  const abr = Math.abs(br), abi = Math.abs(bi);
  let x: number, y: number;
  if (abr >= abi) {
    if (abr === 0) raise(T.ZeroDivisionError, "division by zero");
    const ratio = bi / br, denom = br + bi * ratio;
    x = (ar + ai * ratio) / denom;
    y = (ai - ar * ratio) / denom;
  } else if (abi >= abr) {
    const ratio = br / bi, denom = br * ratio + bi;
    x = (ar * ratio + ai) / denom;
    y = (ai * ratio - ar) / denom;
  } else {
    x = y = NaN;
  }
  if (x !== x && y !== y) [x, y] = recoverQuot(ar, ai, br, bi, x, y);
  return new PyComplex(x, y);
}
// (real: a real dividend, whose absent imaginary part has no terms here
// either, so a zero keeps its sign, as CPython 3.14's _Py_rc_quot)
function recoverQuot(a: number, b: number, c: number, d: number, x: number, y: number, real = false): [number, number] {
  if ((isInf(a) || isInf(b)) && isFin(c) && isFin(d)) {
    a = sgn(isInf(a), a);
    b = sgn(isInf(b), b);
    return real ? [Infinity * (a * c), Infinity * (-a * d)] : [Infinity * (a * c + b * d), Infinity * (b * c - a * d)];
  }
  if ((isInf(c) || isInf(d)) && isFin(a) && isFin(b)) {
    c = sgn(isInf(c), c);
    d = sgn(isInf(d), d);
    return real ? [0 * (a * c), 0 * (-a * d)] : [0 * (a * c + b * d), 0 * (b * c - a * d)];
  }
  return [x, y];
}

// a real a divided by a complex b, as CPython 3.14's _Py_rc_quot: Smith's
// algorithm without the terms of a's (absent) imaginary part
function rcdiv(a: number, b: [number, number]): PyComplex {
  const [br, bi] = b;
  const abr = Math.abs(br), abi = Math.abs(bi);
  let x: number, y: number;
  if (abr >= abi) {
    if (abr === 0) raise(T.ZeroDivisionError, "division by zero");
    const ratio = bi / br, denom = br + bi * ratio;
    x = a / denom;
    y = (-a * ratio) / denom;
  } else if (abi >= abr) {
    const ratio = br / bi, denom = br * ratio + bi;
    x = (a * ratio) / denom;
    y = -a / denom;
  } else {
    x = y = NaN;
  }
  if (x !== x && y !== y) [x, y] = recoverQuot(a, 0, br, bi, x, y, true);
  return new PyComplex(x, y);
}

function part(x: number): string {
  if (x !== x) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const s = floatRepr(x);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
export function complexRepr(c: PyComplex): string {
  if (c.re === 0 && !Object.is(c.re, -0)) return part(c.im) + "j";
  const neg = c.im < 0 || Object.is(c.im, -0) || (c.im !== c.im && false);
  return `(${part(c.re)}${neg ? "-" : "+"}${part(Math.abs(c.im))}j)`;
}

function parseComplex(s: string): PyComplex {
  const bad = () => raise(T.ValueError, "complex() arg is a malformed string");
  // (an underscore not between two digits is CPython's other error, found
  // up to a non-ASCII character that is neither a digit nor a space, after
  // which the string is just malformed)
  let t = Ty.stripAscii(Ty.asciiNumeral(s));
  const head = t.split("\0")[0];
  if (/(?<!\d)_|_(?!\d)/.test(head)) raise(T.ValueError, `could not convert string to complex: ${repr(s)}`);
  if (head.length < t.length) bad();
  t = t.replace(/_/g, "");
  if (t.startsWith("(") && t.endsWith(")")) t = Ty.stripAscii(t.slice(1, -1));
  const num = "(?:(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?|inf(?:inity)?|nan)";
  let m = new RegExp(`^([+-]?${num})$`, "i").exec(t);
  if (m) return new PyComplex(parseF(m[1]), 0);
  m = new RegExp(`^([+-]?${num})?([+-])(${num})?[jJ]$`, "i").exec(t);
  if (m) return new PyComplex(m[1] ? parseF(m[1]) : 0, (m[2] === "-" ? -1 : 1) * (m[3] ? parseF(m[3]) : 1));
  m = new RegExp(`^([+-]?${num})?[jJ]$`, "i").exec(t);
  if (m) {
    const v = m[1] === undefined || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseF(m[1]);
    return new PyComplex(0, v);
  }
  return bad();
}
function parseF(s: string): number {
  const l = s.toLowerCase().replace(/^\+/, "");
  if (/^-?inf(inity)?$/.test(l)) return l.startsWith("-") ? -Infinity : Infinity;
  if (/^-?nan$/.test(l)) return NaN;
  return parseFloat(l);
}

// __complex__'s result: a complex; a strict subclass's value with CPython's
// DeprecationWarning; else TypeError
function complexResult(r: any): [number, number] {
  // (numpy's complex64 is no complex subclass in NumPy, complex128 is:
  // as int's and float's results, CORR-970-3)
  const shim = r instanceof PyComplex ? O.shimName(r, "complex") : null;
  if (!(r instanceof PyComplex) || shim !== null) raise(T.TypeError, `__complex__ returned non-complex (type ${shim ?? typeName(r)})`);
  if (typeOf(r) !== complexType) O.deprecatedSubclass("__complex__", r, "complex");
  return [r.re, r.im];
}
function asComplex(x: any, what: string): [number, number] {
  const c = toC(x);
  if (c !== undefined) return c;
  if (lookupType(typeOf(x), "__complex__") !== undefined) return complexResult(O.lookupSpecial(x, "__complex__")(x));
  const v = Ty.floatCallSafe(x);
  if (v !== undefined) return [v, 0];
  raise(T.TypeError, `complex() ${what} must be a number, not '${typeName(x)}'`);
}

// complex(x), one positional argument, as CPython's actual_complex_new: an
// exact complex as it is, a str parsed, else __complex__ (bound as a special
// method, its result checked), else a real number's PyFloat_AsDouble
function complexCall(real: any = undefined, imag: any = undefined): PyComplex {
  if (imag !== undefined) return complexParts(real, imag);
  if (real === undefined) return new PyComplex(0, 0);
  if (real instanceof PyComplex && real.constructor === PyComplex) return real;
  if (typeof real === "string") return parseComplex(real);
  if (complexHook(real)) return new PyComplex(...complexResult(O.lookupSpecial(real, "__complex__")(real)));
  const v = isNumberLike(real) ? Ty.asDouble(real) : undefined;
  if (v === undefined) raise(T.TypeError, `complex() argument must be a string or a number, not ${typeName(real)}`);
  return new PyComplex(v, 0);
}
// (a __complex__ hook as CPython's types have it: float's here, which
// CPython's float has not, is no hook)
const complexHook = (x: any) => {
  const f = lookupType(typeOf(x), "__complex__");
  // (None is a hook too, one that is not callable: CPython's TypeError)
  return f !== undefined && (f === null || f.$owner !== T.float); // (not float's, nor a float subclass's unboxing wrapper of it)
};
// (a number: an int or float, a complex, or anything with __float__ or __index__)
const isNumberLike = (x: any) => typeof x === "number" || typeof x === "bigint" || typeof x === "boolean" || x instanceof FloatBox || x instanceof PyComplex
  || lookupType(typeOf(x), "__float__") !== undefined || lookupType(typeOf(x), "__index__") !== undefined;
// complex(real, imag), or by keyword, as CPython's complex_new_impl: real
// converted by its __complex__; each part a number or TypeError; a complex
// part's value (with the DeprecationWarning), else PyNumber_Float (a float
// subclass's own __float__); the parts combined only where complex, so
// complex(0.0, -0.0) keeps its signed zero
function complexParts(real: any, imag: any): PyComplex {
  if (typeof real === "string") raise(T.TypeError, "complex() can't take second arg if first is a string");
  if (typeof imag === "string") raise(T.TypeError, "complex() second arg can't be a string");
  const orig = real === undefined ? 0 : real; // (only an omitted real is 0: None is refused, CORR-D5F-1)
  let r = orig;
  if (complexHook(r)) r = new PyComplex(...complexResult(O.lookupSpecial(r, "__complex__")(r)));
  if (!isNumberLike(r)) raise(T.TypeError, `complex() argument 'real' must be a real number, not ${typeName(r)}`);
  if (imag !== undefined && !isNumberLike(imag)) raise(T.TypeError, `complex() argument 'imag' must be a real number, not ${typeName(imag)}`);
  let cr: [number, number], crIsC = false;
  if (r instanceof PyComplex) {
    cr = [r.re, r.im];
    crIsC = true;
    // (CPython warns when the argument itself is no real number: its type
    // has neither nb_float nor nb_index; numpy's scalars have nb_float in
    // NumPy, which the shims here do not show; CORR-D5F-3)
    const ot = typeOf(orig);
    if (lookupType(ot, "__float__") === undefined && lookupType(ot, "__index__") === undefined && !ot.$mro.some((c: any) => c.$module === "numpy")) {
      O.deprecationWarning(`complex() argument 'real' must be a real number, not ${typeName(orig)}`);
    }
  } else cr = [O.fv(Ty.floatCall(r))!, 0];
  let ci: [number, number] = [cr[1], 0], ciIsC = false;
  if (imag !== undefined) {
    if (imag instanceof PyComplex) {
      O.deprecationWarning(`complex() argument 'imag' must be a real number, not ${typeName(imag)}`);
      ci = [imag.re, imag.im];
      ciIsC = true;
    } else ci = [O.fv(Ty.floatCall(imag))!, 0];
  }
  let re = cr[0], im = ci[0];
  if (ciIsC) re -= ci[1];
  if (crIsC && imag !== undefined) im += cr[1];
  return new PyComplex(re, im);
}

export const complexType = Ty.builtinTypeFor("complex", PyComplex, "builtins", complexCall);
complexType.$kw = (pos: any[], names: string[], values: any[]) => {
  const b = bindArgs("complex", sig(["real", "imag"]), pos, names, values);
  // (a keyword takes complex_new_impl's way, as CPython's: complex(real=x))
  return names.length ? complexParts(b[0], b[1]) : complexCall(b[0], b[1]);
};
Ty.subclassable(complexType, PyComplex, ["re", "im"]);
{
  const M = (name: string, f: any) => Ty.method(complexType, name, f);
  // (complex with a real operand, as CPython 3.14's mixed-mode arithmetic:
  // the real is not made complex(r, 0), so no 0 term meets an infinity and
  // a zero's sign is kept: complex(inf, 1) * 2 is (inf+2j))
  const real = (x: any): number | undefined => (unbox(x) instanceof PyComplex ? undefined : O.fv(x));
  const mixed = (name: string, cr: (c: [number, number], r: number) => PyComplex, rc: (r: number, c: [number, number]) => PyComplex, cc: (a: [number, number], b: [number, number]) => PyComplex) => {
    M(`__${name}__`, (a: any, b: any) => {
      const r = real(b);
      if (r !== undefined) return cr(toC(a)!, r);
      const y = toC(b);
      return y === undefined ? NotImplemented : cc(toC(a)!, y);
    });
    M(`__r${name}__`, (a: any, b: any) => {
      const r = real(b);
      if (r !== undefined) return rc(r, toC(a)!);
      const y = toC(b);
      return y === undefined ? NotImplemented : cc(y, toC(a)!);
    });
  };
  mixed("add", (c, r) => new PyComplex(c[0] + r, c[1]), (r, c) => new PyComplex(r + c[0], c[1]), (a, b) => new PyComplex(a[0] + b[0], a[1] + b[1]));
  mixed("sub", (c, r) => new PyComplex(c[0] - r, c[1]), (r, c) => new PyComplex(r - c[0], -c[1]), (a, b) => new PyComplex(a[0] - b[0], a[1] - b[1]));
  mixed("mul", (c, r) => new PyComplex(c[0] * r, c[1] * r), (r, c) => new PyComplex(r * c[0], r * c[1]), (a, b) => cmul(a[0], a[1], b[0], b[1]));
  mixed("truediv", (c, r) => {
    if (r === 0) raise(T.ZeroDivisionError, "division by zero");
    return new PyComplex(c[0] / r, c[1] / r);
  }, rcdiv, cdiv);
  M("__pow__", (a: any, b: any, m: any = null) => {
    if (m !== null) raise(T.ValueError, "complex modulo");
    const y = toC(b);
    return y === undefined ? NotImplemented : cpow(toC(a)!, y);
  });
  M("__rpow__", (a: any, b: any) => {
    const y = toC(b);
    return y === undefined ? NotImplemented : cpow(y, toC(a)!);
  });
  M("__neg__", (a: any) => new PyComplex(-toC(a)![0], -toC(a)![1]));
  M("__pos__", (a: any) => new PyComplex(...toC(a)!));
  M("__abs__", (a: any) => {
    const [r, i] = toC(a)!;
    const v = CR.hypot(r, i);
    if (!Number.isFinite(v) && Number.isFinite(r) && Number.isFinite(i)) raise(T.OverflowError, "absolute value too large");
    return O.mkfloat(v);
  });
  M("__bool__", (a: any) => toC(a)![0] !== 0 || toC(a)![1] !== 0);
  M("__eq__", (a: any, b: any) => {
    const x = toC(a)!;
    b = unbox(b);
    if (O.isPyInt(b)) return x[1] === 0 && O.eqBool(O.mkfloat(x[0]), b);
    const y = toC(b);
    return y === undefined ? NotImplemented : x[0] === y[0] && x[1] === y[1];
  });
  M("__ne__", (a: any, b: any) => {
    const r = complexType.$dict.get("__eq__")(a, b);
    return r === NotImplemented ? r : !r;
  });
  M("__hash__", (a: any) => {
    const [r, i] = toC(a)!;
    const h = BigInt(O.hashAny(O.mkfloat(r))) + 1000003n * BigInt(O.hashAny(O.mkfloat(i)));
    let x = BigInt.asIntN(64, h);
    if (x === -1n) x = -2n;
    return O.normBig(x);
  });
  M("__repr__", (a: any) => complexRepr(new PyComplex(...toC(a)!)));
  M("__format__", (a: any, spec: string) => {
    const c = new PyComplex(...toC(a)!);
    if (spec === "") return complexRepr(c);
    const m = /^(.*?)([eEfFgGn%]?)$/.exec(spec)!;
    const re = format(O.mkfloat(c.re), m[1].replace(/^[<>=^]?/, "") + (m[2] || "g"));
    const im = format(O.mkfloat(c.im), "+" + m[1].replace(/^[<>=^]?[-+ ]?/, "") + (m[2] || "g"));
    return `${m[2] ? "" : "("}${re}${im}j${m[2] ? "" : ")"}`;
  });
  M("conjugate", (a: any) => new PyComplex(toC(a)![0], -toC(a)![1]));
  M("__complex__", (a: any) => new PyComplex(...toC(a)!));
  M("__getnewargs__", (a: any) => tuple([O.mkfloat(toC(a)![0]), O.mkfloat(toC(a)![1])]));
  Ty.getset(complexType, "real", (a: any) => O.mkfloat(toC(a)![0]));
  Ty.getset(complexType, "imag", (a: any) => O.mkfloat(toC(a)![1]));
  // float has these too
  Ty.method(T.float, "__complex__", (x: any) => new PyComplex(O.fv(unbox(x))!, 0));
  complexType.$dict.set("from_number", new Ty.PyClassMethod(pyfn((_c: any, x: any) => new PyComplex(...asComplex(x, "argument")), "from_number")));
}
void FloatBox;
void PyBytes;

// ------------------------------------------------------------------ cmath

// A port of CPython's Modules/cmathmodule.c (PSF license, NOTICE.md): each
// function's special-value table for infinite and NaN parts, its
// large-argument formulas, and its errno: EDOM is "math domain error"
// (ValueError), ERANGE "math range error" (OverflowError).  The real
// primitives are the math module's.
const C = (re: number, im: number) => new PyComplex(re, im);
function arg(x: any): [number, number] {
  const c = toC(x);
  if (c !== undefined) return c;
  return asComplex(x, "argument");
}
// (a real number as CPython's PyFloat_AsDouble, as the math module's: a
// float, an int, or an object's __float__ or __index__)
function realArg(x: any): number {
  const v = Ty.asDouble(x);
  return v === undefined ? raise(T.TypeError, `must be real number, not ${typeName(x)}`) : v;
}
const EDOM = 1, ERANGE = 2;
let errno = 0;
const DBL_MAX = 1.7976931348623157e308, DBL_MIN = 2.2250738585072014e-308, DBL_MANT_DIG = 53;
const CM_LARGE_DOUBLE = DBL_MAX / 4;
const CM_SQRT_LARGE_DOUBLE = Math.sqrt(CM_LARGE_DOUBLE);
const CM_LOG_LARGE_DOUBLE = glibcLog(CM_LARGE_DOUBLE);
const CM_SQRT_DBL_MIN = Math.sqrt(DBL_MIN);
const CM_SCALE_UP = 2 * Math.floor(DBL_MANT_DIG / 2) + 1, CM_SCALE_DOWN = -Math.floor((CM_SCALE_UP + 1) / 2);
const M_LN2 = 0.6931471805599453094, M_LN10 = 2.302585092994045684, PI = 3.141592653589793, E = 2.718281828459045;
const ldexp = (x: number, e: number) => x * 2 ** e; // (exact here: e is CM_SCALE_UP, CM_SCALE_DOWN or DBL_MANT_DIG)
const signBuf = new DataView(new ArrayBuffer(8));
const signbit = (y: number) => {
  signBuf.setFloat64(0, y);
  return (signBuf.getUint8(0) & 0x80) !== 0;
};
const copysign = (x: number, y: number) => (signbit(y) ? -Math.abs(x) : Math.abs(x));
const isfinite = Number.isFinite;
const isinf = (x: number) => x === Infinity || x === -Infinity;
const isnan = (x: number) => x !== x;

// special_type: 0 -inf, 1 negative, 2 -0, 3 +0, 4 positive, 5 +inf, 6 NaN
function specialType(d: number): number {
  if (isfinite(d)) {
    if (d !== 0) return signbit(d) ? 1 : 4;
    return signbit(d) ? 2 : 3;
  }
  if (isnan(d)) return 6;
  return signbit(d) ? 0 : 5;
}
const P = PI, P14 = 0.25 * PI, P12 = 0.5 * PI, P34 = 0.75 * PI, INF = Infinity, N = NaN, U = -9.5426319407711027e33;
type Table = [number, number][][];
const special = (z: PyComplex, table: Table): PyComplex => {
  const [re, im] = table[specialType(z.re)][specialType(z.im)];
  return C(re, im);
};
const nonfinite = (z: PyComplex) => !isfinite(z.re) || !isfinite(z.im);

const acosTable: Table = [
  [[P34, INF], [P, INF], [P, INF], [P, -INF], [P, -INF], [P34, -INF], [N, INF]],
  [[P12, INF], [U, U], [U, U], [U, U], [U, U], [P12, -INF], [N, N]],
  [[P12, INF], [U, U], [P12, 0], [P12, -0], [U, U], [P12, -INF], [P12, N]],
  [[P12, INF], [U, U], [P12, 0], [P12, -0], [U, U], [P12, -INF], [P12, N]],
  [[P12, INF], [U, U], [U, U], [U, U], [U, U], [P12, -INF], [N, N]],
  [[P14, INF], [0, INF], [0, INF], [0, -INF], [0, -INF], [P14, -INF], [N, INF]],
  [[N, INF], [N, N], [N, N], [N, N], [N, N], [N, -INF], [N, N]],
];
function cacos(z: PyComplex): PyComplex {
  if (nonfinite(z)) {
    errno = 0;
    return special(z, acosTable);
  }
  let r: PyComplex;
  if (Math.abs(z.re) > CM_LARGE_DOUBLE || Math.abs(z.im) > CM_LARGE_DOUBLE) {
    // (avoid unnecessary overflow for large arguments)
    r = C(CR.atan2(Math.abs(z.im), z.re), -copysign(glibcLog(CR.hypot(z.re / 2, z.im / 2)) + M_LN2 * 2, z.im));
  } else {
    const s1 = csqrt(C(1 - z.re, -z.im)), s2 = csqrt(C(1 + z.re, z.im));
    r = C(2 * CR.atan2(s1.re, s2.re), CR.asinh(s2.re * s1.im - s2.im * s1.re));
  }
  errno = 0;
  return r;
}

const acoshTable: Table = [
  [[INF, -P34], [INF, -P], [INF, -P], [INF, P], [INF, P], [INF, P34], [INF, N]],
  [[INF, -P12], [U, U], [U, U], [U, U], [U, U], [INF, P12], [N, N]],
  [[INF, -P12], [U, U], [0, -P12], [0, P12], [U, U], [INF, P12], [N, P12]],
  [[INF, -P12], [U, U], [0, -P12], [0, P12], [U, U], [INF, P12], [N, P12]],
  [[INF, -P12], [U, U], [U, U], [U, U], [U, U], [INF, P12], [N, N]],
  [[INF, -P14], [INF, -0], [INF, -0], [INF, 0], [INF, 0], [INF, P14], [INF, N]],
  [[INF, N], [N, N], [N, N], [N, N], [N, N], [INF, N], [N, N]],
];
function cacosh(z: PyComplex): PyComplex {
  if (nonfinite(z)) {
    errno = 0;
    return special(z, acoshTable);
  }
  let r: PyComplex;
  if (Math.abs(z.re) > CM_LARGE_DOUBLE || Math.abs(z.im) > CM_LARGE_DOUBLE) {
    r = C(glibcLog(CR.hypot(z.re / 2, z.im / 2)) + M_LN2 * 2, CR.atan2(z.im, z.re));
  } else {
    const s1 = csqrt(C(z.re - 1, z.im)), s2 = csqrt(C(z.re + 1, z.im));
    r = C(CR.asinh(s1.re * s2.re + s1.im * s2.im), 2 * CR.atan2(s1.im, s2.re));
  }
  errno = 0;
  return r;
}

// asin(z) = -i asinh(iz)
function casin(z: PyComplex): PyComplex {
  const s = casinh(C(-z.im, z.re));
  return C(s.im, -s.re);
}

const asinhTable: Table = [
  [[-INF, -P14], [-INF, -0], [-INF, -0], [-INF, 0], [-INF, 0], [-INF, P14], [-INF, N]],
  [[-INF, -P12], [U, U], [U, U], [U, U], [U, U], [-INF, P12], [N, N]],
  [[-INF, -P12], [U, U], [-0, -0], [-0, 0], [U, U], [-INF, P12], [N, N]],
  [[INF, -P12], [U, U], [0, -0], [0, 0], [U, U], [INF, P12], [N, N]],
  [[INF, -P12], [U, U], [U, U], [U, U], [U, U], [INF, P12], [N, N]],
  [[INF, -P14], [INF, -0], [INF, -0], [INF, 0], [INF, 0], [INF, P14], [INF, N]],
  [[INF, N], [N, N], [N, -0], [N, 0], [N, N], [INF, N], [N, N]],
];
function casinh(z: PyComplex): PyComplex {
  if (nonfinite(z)) {
    errno = 0;
    return special(z, asinhTable);
  }
  let r: PyComplex;
  if (Math.abs(z.re) > CM_LARGE_DOUBLE || Math.abs(z.im) > CM_LARGE_DOUBLE) {
    const l = glibcLog(CR.hypot(z.re / 2, z.im / 2)) + M_LN2 * 2;
    r = C(z.im >= 0 ? copysign(l, z.re) : -copysign(l, -z.re), CR.atan2(z.im, Math.abs(z.re)));
  } else {
    const s1 = csqrt(C(1 + z.im, -z.re)), s2 = csqrt(C(1 - z.im, z.re));
    r = C(CR.asinh(s1.re * s2.im - s2.re * s1.im), CR.atan2(z.im, s1.re * s2.re - s1.im * s2.im));
  }
  errno = 0;
  return r;
}

// atan(z) = -i atanh(iz)
function catan(z: PyComplex): PyComplex {
  const s = catanh(C(-z.im, z.re));
  return C(s.im, -s.re);
}

const atanhTable: Table = [
  [[-0, -P12], [-0, -P12], [-0, -P12], [-0, P12], [-0, P12], [-0, P12], [-0, N]],
  [[-0, -P12], [U, U], [U, U], [U, U], [U, U], [-0, P12], [N, N]],
  [[-0, -P12], [U, U], [-0, -0], [-0, 0], [U, U], [-0, P12], [-0, N]],
  [[0, -P12], [U, U], [0, -0], [0, 0], [U, U], [0, P12], [0, N]],
  [[0, -P12], [U, U], [U, U], [U, U], [U, U], [0, P12], [N, N]],
  [[0, -P12], [0, -P12], [0, -P12], [0, P12], [0, P12], [0, P12], [0, N]],
  [[0, -P12], [N, N], [N, N], [N, N], [N, N], [0, P12], [N, N]],
];
function catanh(z: PyComplex): PyComplex {
  if (nonfinite(z)) {
    errno = 0;
    return special(z, atanhTable);
  }
  // (reduced to z.real >= 0, as atanh(z) = -atanh(-z))
  if (z.re < 0) {
    const w = catanh(C(-z.re, -z.im));
    return C(-w.re, -w.im);
  }
  const ay = Math.abs(z.im);
  if (z.re > CM_SQRT_LARGE_DOUBLE || ay > CM_SQRT_LARGE_DOUBLE) {
    // (abs(z) large: atanh(z) ~ 1/z +/- i pi/2)
    const h = CR.hypot(z.re / 2, z.im / 2); // (safe from overflow)
    errno = 0;
    return C(z.re / 4 / h / h, copysign(PI / 2, z.im));
  }
  if (z.re === 1 && ay < CM_SQRT_DBL_MIN) {
    // (atanh(1 +/- 0i) is inf +/- 0i, a domain error)
    if (ay === 0) {
      errno = EDOM;
      return C(INF, z.im);
    }
    errno = 0;
    return C(-glibcLog(Math.sqrt(ay) / Math.sqrt(CR.hypot(ay, 2))), copysign(CR.atan2(2, -ay) / 2, z.im));
  }
  errno = 0;
  return C(glibcLog1p((4 * z.re) / ((1 - z.re) * (1 - z.re) + ay * ay)) / 4, -CR.atan2(-2 * z.im, (1 - z.re) * (1 + z.re) - ay * ay) / 2);
}

// cos(z) = cosh(iz)
const ccos = (z: PyComplex) => ccosh(C(-z.im, z.re));

const coshTable: Table = [
  [[INF, N], [U, U], [INF, 0], [INF, -0], [U, U], [INF, N], [INF, N]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[N, 0], [U, U], [1, 0], [1, -0], [U, U], [N, 0], [N, 0]],
  [[N, 0], [U, U], [1, -0], [1, 0], [U, U], [N, 0], [N, 0]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[INF, N], [U, U], [INF, -0], [INF, 0], [U, U], [INF, N], [INF, N]],
  [[N, N], [N, N], [N, 0], [N, 0], [N, N], [N, N], [N, N]],
];
function ccosh(z: PyComplex): PyComplex {
  let r: PyComplex;
  if (nonfinite(z)) {
    // (cosh(+/-inf + iy), y finite and nonzero: infinities signed by cos y, sin y)
    if (isinf(z.re) && isfinite(z.im) && z.im !== 0) {
      r = z.re > 0 ? C(copysign(INF, CR.cos(z.im)), copysign(INF, CR.sin(z.im))) : C(copysign(INF, CR.cos(z.im)), -copysign(INF, CR.sin(z.im)));
    } else r = special(z, coshTable);
    errno = isinf(z.im) && !isnan(z.re) ? EDOM : 0;
    return r;
  }
  if (Math.abs(z.re) > CM_LOG_LARGE_DOUBLE) {
    // (cosh(z.real) overflows where cosh(z) need not)
    const x1 = z.re - copysign(1, z.re);
    r = C(CR.cos(z.im) * FD.cosh(x1) * E, CR.sin(z.im) * FD.sinh(x1) * E);
  } else r = C(CR.cos(z.im) * FD.cosh(z.re), CR.sin(z.im) * FD.sinh(z.re));
  errno = isinf(r.re) || isinf(r.im) ? ERANGE : 0;
  return r;
}

const expTable: Table = [
  [[0, 0], [U, U], [0, -0], [0, 0], [U, U], [0, 0], [0, 0]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[N, N], [U, U], [1, -0], [1, 0], [U, U], [N, N], [N, N]],
  [[N, N], [U, U], [1, -0], [1, 0], [U, U], [N, N], [N, N]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[INF, N], [U, U], [INF, -0], [INF, 0], [U, U], [INF, N], [INF, N]],
  [[N, N], [N, N], [N, -0], [N, 0], [N, N], [N, N], [N, N]],
];
function cexp(z: PyComplex): PyComplex {
  let r: PyComplex;
  if (nonfinite(z)) {
    if (isinf(z.re) && isfinite(z.im) && z.im !== 0) {
      r = z.re > 0 ? C(copysign(INF, CR.cos(z.im)), copysign(INF, CR.sin(z.im))) : C(copysign(0, CR.cos(z.im)), copysign(0, CR.sin(z.im)));
    } else r = special(z, expTable);
    // (EDOM: an infinite imaginary part, and a real part finite or +inf)
    errno = isinf(z.im) && (isfinite(z.re) || (isinf(z.re) && z.re > 0)) ? EDOM : 0;
    return r;
  }
  if (z.re > CM_LOG_LARGE_DOUBLE) {
    const l = glibcExp(z.re - 1);
    r = C(l * CR.cos(z.im) * E, l * CR.sin(z.im) * E);
  } else {
    const l = glibcExp(z.re);
    r = C(l * CR.cos(z.im), l * CR.sin(z.im));
  }
  errno = isinf(r.re) || isinf(r.im) ? ERANGE : 0;
  return r;
}

const logTable: Table = [
  [[INF, -P34], [INF, -P], [INF, -P], [INF, P], [INF, P], [INF, P34], [INF, N]],
  [[INF, -P12], [U, U], [U, U], [U, U], [U, U], [INF, P12], [N, N]],
  [[INF, -P12], [U, U], [-INF, -P], [-INF, P], [U, U], [INF, P12], [N, N]],
  [[INF, -P12], [U, U], [-INF, -0], [-INF, 0], [U, U], [INF, P12], [N, N]],
  [[INF, -P12], [U, U], [U, U], [U, U], [U, U], [INF, P12], [N, N]],
  [[INF, -P14], [INF, -0], [INF, -0], [INF, 0], [INF, 0], [INF, P14], [INF, N]],
  [[INF, N], [N, N], [N, N], [N, N], [N, N], [INF, N], [N, N]],
];
function clog(z: PyComplex): PyComplex {
  if (nonfinite(z)) {
    errno = 0;
    return special(z, logTable);
  }
  const ax = Math.abs(z.re), ay = Math.abs(z.im);
  let lr: number;
  if (ax > CM_LARGE_DOUBLE || ay > CM_LARGE_DOUBLE) {
    lr = glibcLog(CR.hypot(ax / 2, ay / 2)) + M_LN2;
  } else if (ax < DBL_MIN && ay < DBL_MIN) {
    if (ax > 0 || ay > 0) {
      // (hypot(ax, ay) subnormal: rescaled)
      lr = glibcLog(CR.hypot(ldexp(ax, DBL_MANT_DIG), ldexp(ay, DBL_MANT_DIG))) - DBL_MANT_DIG * M_LN2;
    } else {
      // (log(+/-0 +/- 0i))
      errno = EDOM;
      return C(-INF, CR.atan2(z.im, z.re));
    }
  } else {
    const h = CR.hypot(ax, ay);
    if (0.71 <= h && h <= 1.73) {
      const am = ax > ay ? ax : ay, an = ax > ay ? ay : ax;
      lr = glibcLog1p((am - 1) * (am + 1) + an * an) / 2;
    } else lr = glibcLog(h);
  }
  errno = 0;
  return C(lr, CR.atan2(z.im, z.re));
}
function clog10(z: PyComplex): PyComplex {
  const r = clog(z);
  return C(r.re / M_LN10, r.im / M_LN10);
}

// sin(z) = -i sinh(iz)
function csin(z: PyComplex): PyComplex {
  const s = csinh(C(-z.im, z.re));
  return C(s.im, -s.re);
}

const sinhTable: Table = [
  [[INF, N], [U, U], [-INF, -0], [-INF, 0], [U, U], [INF, N], [INF, N]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[0, N], [U, U], [-0, -0], [-0, 0], [U, U], [0, N], [0, N]],
  [[0, N], [U, U], [0, -0], [0, 0], [U, U], [0, N], [0, N]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[INF, N], [U, U], [INF, -0], [INF, 0], [U, U], [INF, N], [INF, N]],
  [[N, N], [N, N], [N, -0], [N, 0], [N, N], [N, N], [N, N]],
];
function csinh(z: PyComplex): PyComplex {
  let r: PyComplex;
  if (nonfinite(z)) {
    if (isinf(z.re) && isfinite(z.im) && z.im !== 0) {
      r = z.re > 0 ? C(copysign(INF, CR.cos(z.im)), copysign(INF, CR.sin(z.im))) : C(-copysign(INF, CR.cos(z.im)), copysign(INF, CR.sin(z.im)));
    } else r = special(z, sinhTable);
    errno = isinf(z.im) && !isnan(z.re) ? EDOM : 0;
    return r;
  }
  if (Math.abs(z.re) > CM_LOG_LARGE_DOUBLE) {
    const x1 = z.re - copysign(1, z.re);
    r = C(CR.cos(z.im) * FD.sinh(x1) * E, CR.sin(z.im) * FD.cosh(x1) * E);
  } else r = C(CR.cos(z.im) * FD.sinh(z.re), CR.sin(z.im) * FD.cosh(z.re));
  errno = isinf(r.re) || isinf(r.im) ? ERANGE : 0;
  return r;
}

const sqrtTable: Table = [
  [[INF, -INF], [0, -INF], [0, -INF], [0, INF], [0, INF], [INF, INF], [N, INF]],
  [[INF, -INF], [U, U], [U, U], [U, U], [U, U], [INF, INF], [N, N]],
  [[INF, -INF], [U, U], [0, -0], [0, 0], [U, U], [INF, INF], [N, N]],
  [[INF, -INF], [U, U], [0, -0], [0, 0], [U, U], [INF, INF], [N, N]],
  [[INF, -INF], [U, U], [U, U], [U, U], [U, U], [INF, INF], [N, N]],
  [[INF, -INF], [INF, -0], [INF, -0], [INF, 0], [INF, 0], [INF, INF], [INF, N]],
  [[INF, -INF], [N, N], [N, N], [N, N], [N, N], [INF, INF], [N, N]],
];
// sqrt of x + iy, x, y >= 0: s = sqrt((x + hypot(x, y))/2), d = (y/2)/s, as
// s = 2 sqrt(x/8 + hypot(x/8, y/8)) against overflow, and both scaled up
// first when subnormal
function csqrt(z: PyComplex): PyComplex {
  if (nonfinite(z)) {
    errno = 0;
    return special(z, sqrtTable);
  }
  if (z.re === 0 && z.im === 0) return C(0, z.im);
  let ax = Math.abs(z.re);
  const ay = Math.abs(z.im);
  let s: number;
  if (ax < DBL_MIN && ay < DBL_MIN) {
    ax = ldexp(ax, CM_SCALE_UP);
    s = ldexp(Math.sqrt(ax + CR.hypot(ax, ldexp(ay, CM_SCALE_UP))), CM_SCALE_DOWN);
  } else {
    ax /= 8;
    s = 2 * Math.sqrt(ax + CR.hypot(ax, ay / 8));
  }
  const d = ay / (2 * s);
  errno = 0;
  return z.re >= 0 ? C(s, copysign(d, z.im)) : C(d, copysign(s, z.im));
}

// tan(z) = -i tanh(iz)
function ctan(z: PyComplex): PyComplex {
  const s = ctanh(C(-z.im, z.re));
  return C(s.im, -s.re);
}

const tanhTable: Table = [
  [[-1, 0], [U, U], [-1, -0], [-1, 0], [U, U], [-1, 0], [-1, 0]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[-0, N], [U, U], [-0, -0], [-0, 0], [U, U], [-0, N], [-0, N]],
  [[0, N], [U, U], [0, -0], [0, 0], [U, U], [0, N], [0, N]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[1, 0], [U, U], [1, -0], [1, 0], [U, U], [1, 0], [1, 0]],
  [[N, N], [N, N], [N, -0], [N, 0], [N, N], [N, N], [N, N]],
];
// tanh(x+iy) = (tanh(x)(1+tan(y)^2) + i tan(y)(1-tanh(x)^2)) / (1+tan(y)^2 tanh(x)^2),
// 1-tanh(x)^2 as 1/cosh(x)^2, or 4 exp(-2|x|) when |x| is large
function ctanh(z: PyComplex): PyComplex {
  let r: PyComplex;
  if (nonfinite(z)) {
    if (isinf(z.re) && isfinite(z.im) && z.im !== 0) {
      r = C(z.re > 0 ? 1 : -1, copysign(0, 2 * CR.sin(z.im) * CR.cos(z.im)));
    } else r = special(z, tanhTable);
    errno = isinf(z.im) && isfinite(z.re) ? EDOM : 0;
    return r;
  }
  if (Math.abs(z.re) > CM_LOG_LARGE_DOUBLE) {
    r = C(copysign(1, z.re), 4 * CR.sin(z.im) * CR.cos(z.im) * glibcExp(-2 * Math.abs(z.re)));
  } else {
    const tx = FD.tanh(z.re), ty = CR.tan(z.im), cx = 1 / FD.cosh(z.re);
    const txty = tx * ty, denom = 1 + txty * txty;
    r = C((tx * (1 + ty * ty)) / denom, ((ty / denom) * cx) * cx);
  }
  errno = 0;
  return r;
}

// _Py_c_quot (Objects/complexobject.c): Smith's algorithm, a zero divisor
// EDOM, and the infinities and zeros C11 Annex G recovers from nan+nanj
function cquot(a: PyComplex, b: PyComplex): PyComplex {
  const abr = Math.abs(b.re), abi = Math.abs(b.im);
  let re: number, im: number;
  if (abr >= abi) {
    if (abr === 0) {
      errno = EDOM;
      re = im = 0;
    } else {
      const ratio = b.im / b.re, denom = b.re + b.im * ratio;
      re = (a.re + a.im * ratio) / denom;
      im = (a.im - a.re * ratio) / denom;
    }
  } else if (abi >= abr) {
    const ratio = b.re / b.im, denom = b.re * ratio + b.im;
    re = (a.re * ratio + a.im) / denom;
    im = (a.im * ratio - a.re) / denom;
  } else re = im = NaN;
  if (isnan(re) && isnan(im)) {
    if ((isinf(a.re) || isinf(a.im)) && isfinite(b.re) && isfinite(b.im)) {
      const x = copysign(isinf(a.re) ? 1 : 0, a.re), y = copysign(isinf(a.im) ? 1 : 0, a.im);
      re = INF * (x * b.re + y * b.im);
      im = INF * (y * b.re - x * b.im);
    } else if ((isinf(abr) || isinf(abi)) && isfinite(a.re) && isfinite(a.im)) {
      const x = copysign(isinf(b.re) ? 1 : 0, b.re), y = copysign(isinf(b.im) ? 1 : 0, b.im);
      re = 0 * (a.re * x + a.im * y);
      im = 0 * (a.im * x - a.re * y);
    }
  }
  return C(re, im);
}

// _Py_c_abs: an infinite part gives inf, else a NaN part NaN; overflow ERANGE
function cabs(z: PyComplex): number {
  if (nonfinite(z)) {
    if (isinf(z.re)) {
      errno = 0;
      return Math.abs(z.re);
    }
    if (isinf(z.im)) {
      errno = 0;
      return Math.abs(z.im);
    }
    return NaN;
  }
  const r = CR.hypot(z.re, z.im);
  errno = isfinite(r) ? 0 : ERANGE;
  return r;
}

const rectTable: Table = [
  [[INF, N], [U, U], [-INF, 0], [-INF, -0], [U, U], [INF, N], [INF, N]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[0, 0], [U, U], [-0, 0], [-0, -0], [U, U], [0, 0], [0, 0]],
  [[0, 0], [U, U], [0, -0], [0, 0], [U, U], [0, 0], [0, 0]],
  [[N, N], [U, U], [U, U], [U, U], [U, U], [N, N], [N, N]],
  [[INF, N], [U, U], [INF, -0], [INF, 0], [U, U], [INF, N], [INF, N]],
  [[N, N], [N, N], [N, 0], [N, 0], [N, N], [N, N], [N, N]],
];
function crect(r: number, phi: number): PyComplex {
  errno = 0;
  if (!isfinite(r) || !isfinite(phi)) {
    let z: PyComplex;
    // (r infinite, phi finite and nonzero: infinities signed by cos phi, sin phi)
    if (isinf(r) && isfinite(phi) && phi !== 0) {
      z = r > 0 ? C(copysign(INF, CR.cos(phi)), copysign(INF, CR.sin(phi))) : C(-copysign(INF, CR.cos(phi)), -copysign(INF, CR.sin(phi)));
    } else {
      const [re, im] = rectTable[specialType(r)][specialType(phi)];
      z = C(re, im);
    }
    // (EDOM: r a nonzero number and phi infinite)
    errno = r !== 0 && !isnan(r) && isinf(phi) ? EDOM : 0;
    return z;
  }
  if (phi === 0) return C(r, r * phi);
  return C(r * CR.cos(phi), r * CR.sin(phi));
}

function mathError(): never {
  if (errno === EDOM) raise(T.ValueError, "math domain error");
  raise(T.OverflowError, "math range error");
}

newBuiltinModule("cmath", (m) => {
  const fn = (name: string, f: any) => {
    f.__name__ = name;
    m[name] = f;
  };
  // (errno cleared, the function, then its errno raised, as CPython's
  // Py_complex_protected converters)
  const unary = (name: string, f: (z: PyComplex) => PyComplex) =>
    fn(name, (x: any) => {
      const z = C(...arg(x));
      errno = 0;
      const r = f(z);
      if (errno !== 0) mathError();
      return r;
    });
  m.pi = Math.PI;
  m.e = Math.E;
  m.tau = 2 * Math.PI;
  m.inf = Infinity;
  m.nan = NaN;
  m.infj = C(0, Infinity);
  m.nanj = C(0, NaN);
  unary("sqrt", csqrt);
  unary("exp", cexp);
  fn("log", (x: any, base: any = undefined) => {
    // (x converted and its log taken before base is converted, as CPython's)
    const z = C(...arg(x));
    errno = 0;
    let r = clog(z);
    if (base !== undefined) r = cquot(r, clog(C(...arg(base))));
    if (errno !== 0) mathError();
    return r;
  });
  unary("log10", clog10);
  unary("sin", csin);
  unary("cos", ccos);
  unary("tan", ctan);
  unary("sinh", csinh);
  unary("cosh", ccosh);
  unary("tanh", ctanh);
  unary("asin", casin);
  unary("acos", cacos);
  unary("atan", catan);
  unary("asinh", casinh);
  unary("acosh", cacosh);
  unary("atanh", catanh);
  fn("phase", (x: any) => {
    const [re, im] = arg(x);
    return O.mkfloat(CR.atan2(im, re));
  });
  fn("polar", (x: any) => {
    const z = C(...arg(x));
    const phi = CR.atan2(z.im, z.re);
    errno = 0;
    const r = cabs(z);
    if (errno !== 0) mathError();
    return tuple([O.mkfloat(r), O.mkfloat(phi)]);
  });
  fn("rect", (r: any, phi: any) => {
    const z = crect(realArg(r), realArg(phi));
    if (errno !== 0) mathError();
    return z;
  });
  fn("isfinite", (x: any) => arg(x).every(Number.isFinite));
  fn("isinf", (x: any) => arg(x).some((v) => Math.abs(v) === Infinity));
  fn("isnan", (x: any) => arg(x).some((v) => v !== v));
  // (CPython's cmath_isclose_impl: equal values are close, an infinity is
  // close only to itself, tolerances must be non-negative; the keywords bound
  // by its signature, isclose(a, b, *, rel_tol, abs_tol))
  // (the operands converted first, then the tolerances checked, as CPython's
  // argument parsing; CORR-71C-3)
  const isclose = (x: number[], y: number[], rel: number, abs: number) => {
    if (rel < 0 || abs < 0) raise(T.ValueError, "tolerances must be non-negative");
    if (x[0] === y[0] && x[1] === y[1]) return true;
    if ([x[0], x[1], y[0], y[1]].some((v) => Math.abs(v) === Infinity)) return false;
    const d = CR.hypot(x[0] - y[0], x[1] - y[1]);
    return d <= rel * CR.hypot(y[0], y[1]) || d <= rel * CR.hypot(x[0], x[1]) || d <= abs;
  };
  fn("isclose", (a: any, b: any) => isclose(arg(a), arg(b), 1e-9, 0));
  m.isclose.$kw = (pos: any[], names: string[], values: any[]) => {
    const [a, b, rel, abs] = bindArgs("isclose", sig(["a", "b"], { kwonly: ["rel_tol", "abs_tol"] }), pos, names, values);
    if (a === undefined) raise(T.TypeError, "isclose() missing required argument 'a' (pos 1)");
    if (b === undefined) raise(T.TypeError, "isclose() missing required argument 'b' (pos 2)");
    const x = arg(a), y = arg(b);
    return isclose(x, y, rel === undefined ? 1e-9 : realArg(rel), abs === undefined ? 0 : realArg(abs));
  };
});
import { builtins } from "./builtins";
builtins.complex = complexType;
