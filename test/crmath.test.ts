import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/runtime/crmath.ts: correctly rounded sin, cos, tan, asin, acos, atan, atan2, asinh,
// acosh, atanh, log2 and hypot (the double nearest the exact value), the same bits in every
// JavaScript engine, as Python's math module and numpy use them.  scripts/libm-sweep.py
// compares them with CPython's (glibc's) on 300000 inputs per function.

const runtime = join(__dirname, "..", "src", "runtime");
const CR = require(join(runtime, "crmath.js"));
const cli = (...args: string[]) => execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), ...args], { encoding: "utf8" });
function has(cmd: string, ...args: string[]): boolean {
  try {
    execFileSync(cmd, args.length ? args : ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// [function, arguments, the correctly rounded value (mpmath at 300 bits)]
const REF: [string, number[], number][] = [
  ["acosh", [3.0], 1.762747174039086],
  ["acosh", [2.0], 1.3169578969248168],
  ["acosh", [100.0], 5.298292365610485],
  ["atanh", [0.5], 0.5493061443340549],
  ["asinh", [0.1], 0.09983407889920756],
  ["sin", [1e+22], -0.8522008497671888],
  ["cos", [1e+22], 0.523214785395139],
  ["tan", [1.5707963267948966], 1.633123935319537e+16],
  ["sin", [3.141592653589793], 1.2246467991473532e-16],
  ["atan", [2.0], 1.1071487177940904],
  ["atan", [5670970675416363.0], 1.5707963267948963],
  ["atan", [-1176827452331645.8], -1.5707963267948957],
  ["asin", [0.5], 0.5235987755982989],
  ["acos", [-0.5], 2.0943951023931957],
  ["log2", [10.0], 3.321928094887362],
  ["log2", [3.0], 1.584962500721156],
  ["asinh", [1e+300], 691.4686750787737],
  ["acosh", [1e+300], 691.4686750787737],
  ["atanh", [0.9999999999999999], 18.714973875118524],
  ["sin", [1e+300], -0.8178819121159085],
  ["tan", [1e-05], 1.0000000000333334e-05],
  ["hypot", [1.0, 3.0], 3.1622776601683795],
  ["hypot", [-1e-300, -1.0], 1.0],
  ["hypot", [5e-324, 5e-324], 5e-324],
  ["hypot", [3e-320, 4e-320], 5e-320],
  ["hypot", [1e+308, 1e+308], 1.4142135623730951e+308],
  ["atan2", [1.0, -1.0], 2.356194490192345],
  ["atan2", [1e-320, 1.0], 1e-320],
  ["atan2", [-2.0, -3.0], -2.5535900500422257],
  ["atan2", [0.5, 1e-300], 1.5707963267948966],
];

test("correctly rounded values, where fdlibm and V8 are an ulp off (acosh(3), atanh(0.5), asinh(0.1) ...)", () => {
  for (const [f, args, want] of REF) assert.ok(Object.is(CR[f](...args), want), `${f}(${args}) = ${CR[f](...args)}, not ${want}`);
  // (powers of two exactly; special values as C99's Annex F)
  assert.equal(CR.log2(1024), 10);
  assert.equal(CR.log2(5e-324), -1074);
  assert.ok(Object.is(CR.sin(-0), -0) && Object.is(CR.atan(-0), -0) && Object.is(CR.asinh(-0), -0));
  assert.equal(CR.acosh(1), 0);
  assert.equal(CR.atanh(1), Infinity);
  assert.ok(Number.isNaN(CR.asin(1.5)) && Number.isNaN(CR.acosh(0.5)) && Number.isNaN(CR.sin(Infinity)));
  assert.equal(CR.hypot(Infinity, NaN), Infinity);
  assert.equal(CR.hypotN([3, 4, 12]), 13);
});

// random inputs per function: log-uniform magnitudes and a typical range
function inputs(seed: number, n: number): number[] {
  let s = seed;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s ^= s << 13; s >>>= 0; return s / 4294967296; };
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i % 2 ? (rnd() - 0.5) * 20 : (rnd() < 0.5 ? -1 : 1) * 2 ** (rnd() * 120 - 60));
  return xs;
}
const DOMAIN: Record<string, (x: number) => number> = {
  sin: (x) => x, cos: (x) => x, tan: (x) => x, atan: (x) => x, asinh: (x) => x, log2: Math.abs,
  asin: (x) => (Math.abs(x) <= 1 ? x : 1 / x), acos: (x) => (Math.abs(x) <= 1 ? x : 1 / x),
  atanh: (x) => (Math.abs(x) < 1 ? x : 1 / x / 2), acosh: (x) => 1 + Math.abs(x),
};

// the doubles nearest multiples of pi/2 and their neighbours, up to 2^20 pi/2: there the reduced
// argument is tiny, and the reduction must be accurate relative to it
const NEAR: number[] = [];
for (const n of [1, 2, 3, 4, 5, 7, 10, 100, 1000, 12345, 1 << 19, (1 << 20) - 1]) {
  const x = n * 1.5707963267948966;
  for (let k = -3; k <= 3; k++) NEAR.push(x + k * x * 2.220446049250313e-16);
}

test("correctly rounded on 3000 inputs per function (mpmath)", { skip: !has("python3", "-c", "import mpmath") && "no mpmath here" }, () => {
  const xs = inputs(4242, 3000);
  const data: Record<string, [number[], number[]]> = {};
  for (const [f, d] of Object.entries(DOMAIN)) {
    const a = ["sin", "cos", "tan"].includes(f) ? xs.concat(NEAR) : xs.map(d);
    data[f] = [a, a.map((x) => CR[f](x))];
  }
  const ys = inputs(99, 3000);
  data.atan2 = [xs.concat(ys), xs.map((x, i) => CR.atan2(x, ys[i]))];
  data.hypot = [xs.concat(ys), xs.map((x, i) => CR.hypot(x, ys[i]))];
  const file = join(mkdtempSync(join(tmpdir(), "crmath-")), "in.json");
  writeFileSync(file, JSON.stringify(data));
  const bad = JSON.parse(execFileSync("python3", ["-c", `
import json, math, mpmath
d = json.load(open(${JSON.stringify(file)}))
F = {"log2": lambda t: mpmath.log(t, 2)}
bad = []
for f, (a, got) in d.items():
    n = len(got)
    for i in range(n):
        # (as doubles: JSON prints a large integer-valued double as an integer, which Python
        # would read exactly, a different number)
        args = [float(a[i]), float(a[n + i])] if f in ("atan2", "hypot") else [float(a[i])]
        e = max([0] + [math.frexp(v)[1] for v in args if v])
        with mpmath.workprec(160 + e):
            want = float((F[f] if f in F else getattr(mpmath, f))(*[mpmath.mpf(v) for v in args]))
        if want != float(got[i]):
            bad.append([f, args, got[i], want])
print(json.dumps(bad[:10]))`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  assert.deepEqual(bad, []);
});

test("the same bits in V8 (node) and JavaScriptCore (bun)", { skip: !has("bun") && "no bun here" }, () => {
  const file = join(mkdtempSync(join(tmpdir(), "crmath-")), "bits.js");
  writeFileSync(file, `
const CR = require(${JSON.stringify(join(runtime, "crmath.js"))});
const xs = ${JSON.stringify(inputs(7, 20000))};
const F = new Float64Array(1), U = new Uint32Array(F.buffer), out = {};
for (const f of ["sin", "cos", "tan", "asin", "acos", "atan", "asinh", "acosh", "atanh", "log2", "atan2", "hypot"]) {
  let h = 0x811c9dc5;
  xs.forEach((x, i) => {
    const v = f === "atan2" || f === "hypot" ? CR[f](x, xs[(i * 7) % xs.length]) : CR[f](f === "acosh" ? 1 + Math.abs(x) : f === "log2" ? Math.abs(x) : Math.abs(x) <= 1 || !f.startsWith("a") || f === "atan" || f === "asinh" ? x : 1 / x / 2);
    F[0] = v === v ? v : NaN;
    if (v !== v) { U[0] = 0; U[1] = 0x7ff80000; }
    h = Math.imul(h ^ U[0], 16777619) ^ U[1];
    h = Math.imul(h, 16777619) >>> 0;
  });
  out[f] = h;
}
console.log(JSON.stringify(out));`);
  const v8 = JSON.parse(execFileSync(process.execPath, [file], { encoding: "utf8" }));
  const jsc = JSON.parse(execFileSync("bun", [file], { encoding: "utf8" }));
  assert.equal(Object.keys(v8).length, 12);
  assert.deepEqual(jsc, v8);
});

test("Python's math and numpy use them; math.pow raises only for finite arguments; numpy's exp2 is math's", () => {
  const out = cli("-c", `
import math
import numpy as np
print(repr(math.acosh(3)), repr(math.atanh(0.5)), repr(math.asinh(0.1)), repr(math.hypot(3, 4, 12)))
print(repr(float(np.arccosh(np.array([3.0]))[0])), repr(float(np.arctanh(np.array([0.5]))[0])), repr(float(np.sin(np.array([1e22]))[0])))
print(math.pow(0.0, -math.inf), math.pow(-math.inf, 0.5), math.pow(-math.inf, -0.5), math.pow(-0.0, -math.inf))
for a, b in ((0.0, -1.0), (-8.0, 1 / 3)):
    try:
        math.pow(a, b)
    except ValueError as e:
        print("ValueError", e)
xs = [0.1 * k - 40 for k in range(800)]
print(all(float(v) == math.exp2(x) for v, x in zip(np.exp2(np.array(xs)), xs)))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "1.762747174039086 0.5493061443340549 0.09983407889920756 13.0",
    "1.762747174039086 0.5493061443340549 -0.8522008497671888",
    "inf inf 0.0 inf",
    "ValueError math domain error",
    "ValueError math domain error",
    "True",
  ]);
});

test("norms decide midpoints exactly, and atan2's tiny ratios round below a subnormal midpoint (CORR-343-1, CORR-343-2)", () => {
  // (a = s^2: a^2 + s^2 = (a + 1/2)^2 - 1/4, just below the midpoint, so a; Fraction's oracle below)
  const s = 67108865, a = s * s;
  assert.equal(CR.hypot(a, s), a);
  assert.equal(CR.hypotN([a, s, 0]), a);
  // (1 + 2^-52 + 2^-106 is (1 + 2^-53)^2 exactly: a tie, to the even 1; 2^-108 more rounds up)
  assert.equal(CR.hypotN([1, 2 ** -26, 2 ** -53]), 1);
  assert.equal(CR.hypotN([1, 2 ** -26, 2 ** -53, 2 ** -54]), 1 + 2 ** -52);
  // (u = 2^-1074: 3u/2 and 3 2^-500 / 2^575 = 3u/2 are midpoints, atan just below them)
  const u = 5e-324;
  assert.equal(CR.atan2(3 * u, 2), u);
  assert.equal(CR.atan2(-3 * u, 2), -u);
  assert.equal(CR.atan2(3 * 2 ** -500, 2 ** 575), u);
  for (let K = 1; K < 400; K += 2) {
    assert.equal(CR.atan2(K * u, 2), ((K - 1) / 2) * u, `atan2(${K}u, 2)`);
    assert.equal(CR.atan2(K * u, 4), Math.round(K / 4) * u, `atan2(${K}u, 4)`); // (never a tie)
  }
  // the square-midpoint family at many scales, two and three coordinates, and vectors near
  // ties, against an exact oracle (Python's Fraction: midpoints compared with the square sum)
  const cases: number[][] = [];
  for (let k = 1; k < 120; k += 2) {
    const t = 2 ** 26 + k;
    for (const j of [-1020, -1000, -600, -60, 0, 60, 500, 900, 971]) {
      cases.push([t * t * 2 ** j, t * 2 ** j], [t * t * 2 ** j, t * 2 ** j, 0], [t * 2 ** j, t * t * 2 ** j, -0]);
    }
  }
  for (let k = 0; k < 60; k++) {
    cases.push([1 + k * 2 ** -52, 2 ** -26, 2 ** -53, 2 ** -54], [1 + k * 2 ** -52, 2 ** -26 * (1 + k * 2 ** -52), 2 ** -53]);
  }
  let r = 12345;
  for (let i = 0; i < 300; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    const m = r & 0xfffff;
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    cases.push([m * u, (r & 0xfffff) * u], [m * u, (r & 0xff) * u, 3 * u]); // (subnormal results)
  }
  const got = cases.map((c) => (c.length === 2 ? CR.hypot(c[0], c[1]) : CR.hypotN(c)));
  const file = join(mkdtempSync(join(tmpdir(), "crmath-")), "norms.json");
  writeFileSync(file, JSON.stringify(cases.map((c, i) => [c.map((v) => v.toString()), got[i].toString()])));
  const bad = JSON.parse(execFileSync("python3", ["-c", `
import json, math
from fractions import Fraction as F
def nearest(S):
    # (a first guess, scaled: float(S) itself can overflow or underflow)
    h = (S.numerator.bit_length() - S.denominator.bit_length()) // 2
    c = math.ldexp(math.sqrt(float(S / F(2) ** (2 * h))), h)
    def up(c):  # the root is at or above the midpoint of c and its upper neighbour
        m = (F(c) + F(math.nextafter(c, math.inf))) / 2
        return S > m * m or (S == m * m and math.frexp(c)[0] * 2**53 % 2 == 1)
    while up(c): c = math.nextafter(c, math.inf)
    while c > 0 and not up(math.nextafter(c, 0)): c = math.nextafter(c, 0)
    return c
bad = []
for xs, got in json.load(open(${JSON.stringify(file)})):
    xs = [float(v) for v in xs]
    want = nearest(sum(F(v) ** 2 for v in xs))
    if want != float(got): bad.append([xs, got, want])
print(json.dumps([len(bad)] + bad[:5]))`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  assert.deepEqual(bad, [0]);
});
