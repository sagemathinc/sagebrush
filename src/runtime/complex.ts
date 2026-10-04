// complex numbers and the cmath module.  Mixed arithmetic goes through the
// generic dunder path: int/float return NotImplemented for complex operands
// and complex.__radd__ etc. take over.

import { T, FloatBox, NotImplemented, PyBytes, raise, typeName, tuple, unbox, typeOf, lookupType, bindArgs, sig, pyfn } from "./object";
import * as O from "./ops";
import * as Ty from "./types";
import { floatRepr, format } from "./format";
import { newBuiltinModule } from "./modules";

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
  const vabs = Math.hypot(ar, ai);
  let len = Math.pow(vabs, br);
  const at = Math.atan2(ai, ar);
  let phase = at * br;
  if (bi !== 0) {
    len /= Math.exp(at * bi);
    phase += bi * Math.log(vabs);
  }
  const r = new PyComplex(len * Math.cos(phase), len * Math.sin(phase));
  if (!Number.isFinite(r.re) && Number.isFinite(ar) && Number.isFinite(ai) && Number.isFinite(br) && Number.isFinite(bi)) raise(T.OverflowError, "complex exponentiation");
  return r;
}
export const complexPow = (x: number, y: number) => cpow([x, 0], [y, 0]);

function cdiv(a: [number, number], b: [number, number]): PyComplex {
  const [ar, ai] = a, [br, bi] = b;
  // Smith's algorithm, as CPython's _Py_c_quot
  const abr = Math.abs(br), abi = Math.abs(bi);
  if (abr >= abi) {
    if (abr === 0) raise(T.ZeroDivisionError, "division by zero");
    const ratio = bi / br, denom = br + bi * ratio;
    return new PyComplex((ar + ai * ratio) / denom, (ai - ar * ratio) / denom);
  }
  if (abi >= abr) {
    const ratio = br / bi, denom = br * ratio + bi;
    return new PyComplex((ar * ratio + ai) / denom, (ai * ratio - ar) / denom);
  }
  return new PyComplex(NaN, NaN);
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
  let t = s.trim().replace(/_/g, (m, i, all) => (/\d/.test(all[i - 1] ?? "") && /\d/.test(all[i + 1] ?? "") ? "" : "!"));
  if (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();
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

function asComplex(x: any, what: string): [number, number] {
  const c = toC(x);
  if (c !== undefined) return c;
  const f = lookupType(typeOf(x), "__complex__");
  if (f !== undefined) {
    const r = f(x);
    if (!(r instanceof PyComplex)) raise(T.TypeError, `__complex__ returned non-complex (type ${typeName(r)})`);
    return [r.re, r.im];
  }
  const v = Ty.floatCallSafe(x);
  if (v !== undefined) return [v, 0];
  raise(T.TypeError, `complex() ${what} must be a number, not '${typeName(x)}'`);
}

function complexCall(real: any = undefined, imag: any = undefined): PyComplex {
  if (typeof real === "string") {
    if (imag !== undefined) raise(T.TypeError, "complex() can't take second arg if first is a string");
    return parseComplex(real);
  }
  if (typeof imag === "string") raise(T.TypeError, "complex() second arg can't be a string");
  if (real instanceof PyComplex && imag === undefined && real.constructor === PyComplex) return real;
  // As CPython: components are only combined when an argument is complex,
  // so complex(0.0, -0.0) keeps its signed zero.
  const [ar, ai] = real === undefined ? [0, 0] : asComplex(real, "first argument");
  if (imag === undefined) return new PyComplex(ar, ai);
  const [br, bi] = asComplex(imag, "second argument");
  const realIsC = unbox(real) instanceof PyComplex, imagIsC = unbox(imag) instanceof PyComplex;
  return new PyComplex(imagIsC ? ar - bi : ar, realIsC ? ai + br : br);
}

export const complexType = Ty.builtinTypeFor("complex", PyComplex, "builtins", complexCall);
complexType.$kw = (pos: any[], names: string[], values: any[]) => {
  const b = bindArgs("complex", sig(["real", "imag"]), pos, names, values);
  return complexCall(b[0], b[1]);
};
Ty.subclassable(complexType, PyComplex);
{
  const M = (name: string, f: any) => Ty.method(complexType, name, f);
  const bin = (name: string, f: (a: [number, number], b: [number, number]) => PyComplex) => {
    M(`__${name}__`, (a: any, b: any) => {
      const y = toC(b);
      return y === undefined ? NotImplemented : f(toC(a)!, y);
    });
    M(`__r${name}__`, (a: any, b: any) => {
      const y = toC(b);
      return y === undefined ? NotImplemented : f(y, toC(a)!);
    });
  };
  bin("add", (a, b) => new PyComplex(a[0] + b[0], a[1] + b[1]));
  bin("sub", (a, b) => new PyComplex(a[0] - b[0], a[1] - b[1]));
  bin("mul", (a, b) => new PyComplex(a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]));
  bin("truediv", cdiv);
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
    const v = Math.hypot(r, i);
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

const C = (re: number, im: number) => new PyComplex(re, im);
function arg(x: any): [number, number] {
  const c = toC(x);
  if (c !== undefined) return c;
  return asComplex(x, "argument");
}
// The finite-value algorithms of CPython's Modules/cmathmodule.c.
function csqrt(re: number, im: number): PyComplex {
  if (!Number.isFinite(re) || !Number.isFinite(im)) {
    if (Math.abs(im) === Infinity) return C(Infinity, im);
    if (re === -Infinity) return C(im !== im ? NaN : 0, im !== im ? NaN : im < 0 || Object.is(im, -0) ? -Infinity : Infinity);
    if (re === Infinity) return C(Infinity, im !== im ? NaN : im < 0 || Object.is(im, -0) ? -0 : 0);
    return C(NaN, NaN);
  }
  if (re === 0 && im === 0) return C(0, im);
  let ax = Math.abs(re), ay = Math.abs(im), sr: number, d: number;
  if (ax < 2.2250738585072014e-308 && ay < 2.2250738585072014e-308) {
    ax = ax * 2 ** 53;
    sr = Math.sqrt((ax + Math.hypot(ax, ay * 2 ** 53)) / 2) * 2 ** -26.5;
  } else {
    ax /= 8;
    sr = 2 * Math.sqrt(ax + Math.hypot(ax, ay / 8));
  }
  d = ay / (2 * sr);
  const sgn = (v: number) => (im < 0 || Object.is(im, -0) ? -v : v);
  return re >= 0 ? C(sr, sgn(d)) : C(d, sgn(sr));
}
function cexp(re: number, im: number): PyComplex {
  const e = Math.exp(re);
  if (im === 0) return C(e, im);
  return C(e * Math.cos(im), e * Math.sin(im));
}
function clog(re: number, im: number): PyComplex {
  const ax = Math.abs(re), ay = Math.abs(im);
  if (ax === 0 && ay === 0) raise(T.ValueError, "math domain error");
  const h = Math.hypot(ax, ay);
  let lr: number;
  if (0.71 <= h && h <= 1.73) {
    const am = Math.max(ax, ay), an = Math.min(ax, ay);
    lr = Math.log1p((am - 1) * (am + 1) + an * an) / 2;
  } else lr = Math.log(h);
  return C(lr, Math.atan2(im, re));
}
const mul = (a: PyComplex, b: PyComplex) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: PyComplex, b: PyComplex) => cdiv([a.re, a.im], [b.re, b.im]);
function casinh(z: PyComplex): PyComplex {
  const s1 = csqrt(1 + z.im, -z.re), s2 = csqrt(1 - z.im, z.re);
  return C(Math.asinh(s1.re * s2.im - s2.re * s1.im), Math.atan2(z.im, s1.re * s2.re - s1.im * s2.im));
}
function casin(z: PyComplex): PyComplex {
  const s = casinh(C(-z.im, z.re));
  return C(s.im, -s.re);
}
function cacos(z: PyComplex): PyComplex {
  const s1 = csqrt(1 - z.re, -z.im), s2 = csqrt(1 + z.re, z.im);
  return C(2 * Math.atan2(s1.re, s2.re), Math.asinh(s2.re * s1.im - s2.im * s1.re));
}
function cacosh(z: PyComplex): PyComplex {
  const s1 = csqrt(z.re - 1, z.im), s2 = csqrt(z.re + 1, z.im);
  return C(Math.asinh(s1.re * s2.re + s1.im * s2.im), 2 * Math.atan2(s1.im, s2.re));
}
function catanh(z: PyComplex): PyComplex {
  if (z.re < 0) {
    const w = catanh(C(-z.re, -z.im));
    return C(-w.re, -w.im);
  }
  const ay = Math.abs(z.im);
  if (z.re === 1 && ay < 1.4916681462400413e-154) {
    if (ay === 0) raise(T.ValueError, "math domain error");
    return C(-Math.log(Math.sqrt(ay) / Math.sqrt(Math.hypot(ay, 2))), (z.im < 0 ? -1 : 1) * Math.atan2(2, -ay) / 2);
  }
  return C(Math.log1p((4 * z.re) / ((1 - z.re) * (1 - z.re) + ay * ay)) / 4, -Math.atan2(-2 * z.im, (1 - z.re) * (1 + z.re) - ay * ay) / 2);
}
function catan(z: PyComplex): PyComplex {
  const s = catanh(C(-z.im, z.re));
  return C(s.im, -s.re);
}

newBuiltinModule("cmath", (m) => {
  const fn = (name: string, f: any) => {
    f.__name__ = name;
    m[name] = f;
  };
  // As CPython, an infinite result from a finite argument is an OverflowError.
  const unary = (name: string, f: (z: PyComplex) => PyComplex) =>
    fn(name, (x: any) => {
      const z = C(...arg(x));
      const r = f(z);
      if (Number.isFinite(z.re) && Number.isFinite(z.im) && (Math.abs(r.re) === Infinity || Math.abs(r.im) === Infinity)) raise(T.OverflowError, "math range error");
      return r;
    });
  m.pi = Math.PI;
  m.e = Math.E;
  m.tau = 2 * Math.PI;
  m.inf = Infinity;
  m.nan = NaN;
  m.infj = C(0, Infinity);
  m.nanj = C(0, NaN);
  unary("sqrt", (z) => csqrt(z.re, z.im));
  unary("exp", (z) => cexp(z.re, z.im));
  fn("log", (x: any, base: any = undefined) => {
    const l = clog(...arg(x));
    return base === undefined ? l : div(l, clog(...arg(base)));
  });
  unary("log10", (z) => {
    const l = clog(z.re, z.im);
    return C(l.re / Math.LN10, l.im / Math.LN10);
  });
  unary("sin", (z) => C(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im)));
  unary("cos", (z) => C(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im)));
  unary("tan", (z) => div(C(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im)), C(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im))));
  unary("sinh", (z) => C(Math.sinh(z.re) * Math.cos(z.im), Math.cosh(z.re) * Math.sin(z.im)));
  unary("cosh", (z) => C(Math.cosh(z.re) * Math.cos(z.im), Math.sinh(z.re) * Math.sin(z.im)));
  unary("tanh", (z) => div(C(Math.sinh(z.re) * Math.cos(z.im), Math.cosh(z.re) * Math.sin(z.im)), C(Math.cosh(z.re) * Math.cos(z.im), Math.sinh(z.re) * Math.sin(z.im))));
  unary("asin", casin);
  unary("acos", cacos);
  unary("atan", catan);
  unary("asinh", casinh);
  unary("acosh", cacosh);
  unary("atanh", catanh);
  fn("phase", (x: any) => O.mkfloat(Math.atan2(arg(x)[1], arg(x)[0])));
  fn("polar", (x: any) => {
    const [r, i] = arg(x);
    return tuple([O.mkfloat(Math.hypot(r, i)), O.mkfloat(Math.atan2(i, r))]);
  });
  fn("rect", (r: any, phi: any) => {
    const a = O.fv(r)!, p = O.fv(phi)!;
    return C(a * Math.cos(p), a * Math.sin(p));
  });
  fn("isfinite", (x: any) => arg(x).every(Number.isFinite));
  fn("isinf", (x: any) => arg(x).some((v) => Math.abs(v) === Infinity));
  fn("isnan", (x: any) => arg(x).some((v) => v !== v));
  fn("isclose", (a: any, b: any) => {
    const x = arg(a), y = arg(b);
    const d = Math.hypot(x[0] - y[0], x[1] - y[1]);
    return d <= Math.max(1e-9 * Math.max(Math.hypot(...x), Math.hypot(...y)), 0);
  });
  m.isclose.$kw = (pos: any[], names: string[], values: any[]) => {
    const kw: any = { rel_tol: 1e-9, abs_tol: 0 };
    names.forEach((n, i) => (kw[n] = O.fv(values[i])));
    const x = arg(pos[0]), y = arg(pos[1]);
    if (x[0] === y[0] && x[1] === y[1]) return true;
    const d = Math.hypot(x[0] - y[0], x[1] - y[1]);
    return d <= Math.max(kw.rel_tol * Math.max(Math.hypot(...x), Math.hypot(...y)), kw.abs_tol);
  };
});
import { builtins } from "./builtins";
builtins.complex = complexType;
