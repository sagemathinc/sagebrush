import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/scipy/special.py where it is not SciPy (scipy-tests/test_special.py
// compares the rest with SciPy itself): where Sagebrush computes no value it
// raises NotImplementedError, never a plausible answer; and where SciPy's own
// value is inaccurate (Cephes's y1 for large x), Sagebrush's is checked
// against mpmath instead.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("scipy.special: what Sagebrush doesn't compute raises NotImplementedError", () => {
  const out = py(`
import numpy as np
import scipy.special as sc
cases = [
    lambda: sc.jv(0, 1 + 1j),
    lambda: sc.yv(1, np.array([1j])),
    lambda: sc.eval_legendre(2.5, 0.3),
    lambda: sc.lpmv(1, 2.5, 0.3),
    lambda: sc.logsumexp([1 + 1j, 2]),
    lambda: sc.factorial(3, extend="complex"),
    lambda: sc.gamma(2.0, out=None),
    lambda: sc.zeta(2.0, out=np.empty(())),
]
for c in cases:
    try:
        c()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", e)
`);
  assert.equal(out, [
    "NotImplementedError scipy.special.jv: a complex argument is not supported in Sagebrush",
    "NotImplementedError scipy.special.yv: a complex argument is not supported in Sagebrush",
    "NotImplementedError scipy.special.eval_legendre(2.5, 0.3): a non-integer degree",
    "NotImplementedError scipy.special.lpmv(1.0, 2.5, 0.3): a non-integer degree or order",
    "NotImplementedError scipy.special.logsumexp: complex arguments are not supported in Sagebrush",
    "NotImplementedError scipy.special.factorial: extend='complex' is not supported in Sagebrush",
    "NotImplementedError scipy.special.gamma: keyword arguments (out) are not supported in Sagebrush",
    "NotImplementedError scipy.special.zeta: out= is not supported in Sagebrush",
    "",
  ].join("\n"));
});

test("scipy.special: a variable-work path beyond its bound is refused before its loop", () => {
  // (the Hurwitz zeta's head sum for a negative q and the Legendre
  // recurrence: 10**6 terms at most; just past it, and far past it, both
  // refuse at once, without the work; at the bound they compute,
  // scipy-tests/test_special.py)
  const out = py(`
import time
import scipy.special as sc
for f in [lambda: sc.zeta(2, -1000000.5), lambda: sc.zeta(2, -1e12 - 0.5), lambda: sc.eval_legendre(1000001, 0.3),
          lambda: sc.eval_legendre(1e12, 0.3), lambda: sc.eval_legendre(-1000002, 1e-6)]:
    t = time.time()
    try:
        f()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", e, time.time() - t < 0.5)
`);
  assert.equal(out, [
    "NotImplementedError scipy.special.zeta(2.0, -1000000.5): a q at or below -1000000 (its head sum's work) True",
    "NotImplementedError scipy.special.zeta(2.0, -1000000000000.5): a q at or below -1000000 (its head sum's work) True",
    "NotImplementedError scipy.special.eval_legendre(1000001.0, 0.3): a degree above 1000000 (its recurrence's work) True",
    "NotImplementedError scipy.special.eval_legendre(1000000000000.0, 0.3): a degree above 1000000 (its recurrence's work) True",
    "NotImplementedError scipy.special.eval_legendre(-1000002.0, 1e-06): a degree above 1000000 (its recurrence's work) True",
    "",
  ].join("\n"));
});

test("scipy.special.y1 for large x, where SciPy's (Cephes's) loses accuracy: mpmath's values", () => {
  // (mpmath.bessely(1, x) at 400 digits for 1e300, 60 elsewhere; SciPy 1.18's
  // y1 is 1.2e-8 off at the second and gives -6.5e-151 at the first)
  const want: [number, number][] = [
    [1e300, 7.8606730627240933e-151],
    [384105577.33329856, -1.8080110833523897e-5],
    [6558871.802643229, 1.2726715507243322e-5],
    [1954858.9326322945, 0.00029718065597076858],
    [142454.2272800709, -0.001024975121637093],
  ];
  const got = JSON.parse(py(`
import json
import scipy.special as sc
print(json.dumps([float(sc.y1(x)) for x in ${JSON.stringify(want.map((w) => w[0]))}]))
`));
  // (within a few units in the last place, as lib/_special.py's bessely
  // states; SciPy's are 1e-8 off at the second and wrong at the first)
  want.forEach(([x, v], i) => assert.ok(Math.abs(got[i] - v) <= 2e-15 * Math.abs(v), `y1(${x}) = ${got[i]}, mpmath ${v}`));
});

test("scipy.special: a submodule of scipy, listed by dir()", () => {
  assert.equal(py(`
import scipy
print("special" in dir(scipy), scipy.special.gamma(5.0), type(scipy.special.gamma(5.0)).__name__)
`), "True 24.0 float64\n");
});
