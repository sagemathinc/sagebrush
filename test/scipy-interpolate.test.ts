import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/scipy/interpolate.py where it is not SciPy (scipy-tests/test_interpolate.py
// compares the rest with SciPy itself): what it does not implement raises
// NotImplementedError naming it, never a plausible answer; scipy.interpolate
// loads as a submodule of scipy.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("scipy.interpolate: what is not ported raises NotImplementedError", () => {
  const out = py(`
import numpy as np
import scipy.interpolate as si
from scipy.interpolate import interp1d, CubicSpline, PPoly
x, y = [0.0, 1.0, 2.0, 3.0], [0.0, 1.0, 4.0, 9.0]
cases = [
    lambda: interp1d(x, y, kind="cubic"),
    lambda: interp1d(x, y, kind=2),
    lambda: si.make_interp_spline,
    lambda: si.RegularGridInterpolator,
    lambda: CubicSpline(x, y).roots(),
    lambda: PPoly(np.ones((2, 2)), [2.0, 1.0, 0.0])(0.5),
]
for c in cases:
    try:
        c()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", str(e).split(" is not")[0].split(":")[0])
try:
    si.no_such_name
except AttributeError as e:
    print("AttributeError", e)
`);
  assert.equal(out, [
    "NotImplementedError scipy.interpolate.interp1d(kind='cubic')",
    "NotImplementedError scipy.interpolate.interp1d(kind=2)",
    "NotImplementedError scipy.interpolate.make_interp_spline",
    "NotImplementedError scipy.interpolate.RegularGridInterpolator",
    "NotImplementedError scipy.interpolate.PPoly.roots",
    "NotImplementedError scipy.interpolate",
    "AttributeError module 'scipy.interpolate' has no attribute 'no_such_name'",
    "",
  ].join("\n"));
});

test("scipy.interpolate as an attribute of scipy, and the rows of the gap first seen in published notebooks", () => {
  const out = py(`
import scipy
print(scipy.interpolate.__name__)
from scipy.interpolate import interp1d, CubicSpline
f = interp1d([0, 1, 2], [0, 10, 20])
print(abs(float(f(1.5)) - 15) < 1e-12, abs(float(CubicSpline([0, 1, 2, 3], [0, 1, 8, 27])(1.5)) - 3.375) < 0.2)
print(float(CubicSpline([0, 1, 2, 3], [0, 1, 8, 27])(1.5)))
`);
  assert.equal(out, "scipy.interpolate\nTrue True\n3.375000000000001\n"); // (as SciPy prints it)
});
