import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// scipy.integrate.ode: SciPy's class interface to its ODE integrators. Sagebrush integrates with embedded Runge-Kutta
// pairs under each integrator's tolerances, so the numbers are checked within tolerance: against exact solutions,
// and against SciPy 1.18's own results (the Lotka-Volterra values, from CPython). The return codes, warnings and
// errors are SciPy's exactly.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
const close = (got: number, want: number, rel: number, what: string) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${what}: ${got} is not within ${rel} of ${want}`);

test("each integrator, stepped with integrate(r.t + dt), against exact solutions and SciPy's values", () => {
  const out = py(`
import json, math
from scipy.integrate import ode
res = {}
for name, kw in (("vode", {}), ("vode", {"method": "bdf"}), ("lsoda", {}), ("dopri5", {}), ("dop853", {})):
    key = name + ("-bdf" if kw else "")
    r = ode(lambda t, y, k: [-k * y[0]]).set_integrator(name, **kw)
    r.set_initial_value(2.0, 0.0).set_f_params(0.5)
    while r.successful() and r.t < 3.99:
        r.integrate(r.t + 0.25)
    osc = ode(lambda t, y: [y[1], -y[0]]).set_integrator(name, **kw).set_initial_value([1.0, 0.0], 0.0)
    osc.integrate(math.pi)
    lv = ode(lambda t, y, a, b: [a * y[0] - y[0] * y[1], -b * y[1] + y[0] * y[1]]).set_integrator(name, **kw)
    lv.set_initial_value([1.0, 0.5], 0.0).set_f_params(1.1, 0.4)
    for _ in range(5):
        lv.integrate(lv.t + 2.0)
    res[key] = [r.t, r.y.tolist(), osc.y.tolist(), lv.t, lv.y.tolist(), r.successful(), r.get_return_code(), type(r.y).__name__]
print(json.dumps(res))
`);
  const res = JSON.parse(out);
  const codes: Record<string, number> = { vode: 2, "vode-bdf": 2, lsoda: 2, dopri5: 1, dop853: 1 };
  for (const [k, [t, y, osc, tl, lv, ok, code, typ]] of Object.entries(res) as any) {
    assert.equal(t, 4.0, k);
    close(y[0], 2 * Math.exp(-2), 1e-5, `${k} decay`);
    close(osc[0], -1, 1e-5, `${k} cos(pi)`);
    assert.ok(Math.abs(osc[1]) < 1e-5, `${k} -sin(pi)`);
    // (SciPy's vode for this system: 0.55551689, 0.36591570; its integrators differ among themselves by about 2e-5)
    assert.equal(tl, 10.0);
    close(lv[0], 0.55551689, 1e-4, `${k} prey`);
    close(lv[1], 0.3659157, 1e-4, `${k} predators`);
    assert.deepEqual([ok, code, typ], [true, codes[k], "ndarray"], k);
  }
});

test("a subclass overrides integrate and set_initial_value and calls ode's, as SciPy's allows", () => {
  const out = py(`
from scipy.integrate import ode
class Logged(ode):
    def __init__(self, f):
        self.seen = []
        ode.__init__(self, f)
        self.set_f_params(None)
    def integrate(self, t, step=0, relax=0):
        ode.integrate(self, t, step, relax)
        self.seen.append(round(self.t, 6))
        return self.y
    def set_initial_value(self, y):
        ode.set_initial_value(self, y, 0.0)
d = Logged(lambda t, y, extra: -0.5 * y)
d.set_initial_value(2.0)
ys = [d.integrate(d.t + 0.5)[0] for _ in range(4)]
print(d.seen, round(ys[-1], 6), d.f_params)
d.set_f_params([1, 2])
print(d.f_params, isinstance(d, ode))
`);
  assert.equal(out, "[0.5, 1.0, 1.5, 2.0] 0.735759 (None,)\n([1, 2],) True\n");
});

test("a stiff method asked for (vode's bdf, lsoda) is said, once per integrate() call, to run on a non-stiff solver", () => {
  const out = py(`
import warnings
from scipy.integrate import ode
for name, kw in (("vode", {"method": "bdf"}), ("lsoda", {}), ("vode", {}), ("dopri5", {}), ("dop853", {})):
    r = ode(lambda t, y: [-y[0]]).set_integrator(name, **kw).set_initial_value([1.0], 0.0)
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r.integrate(0.5)
        r.integrate(1.0)
    print(name, kw, len(w), [x.category.__name__ for x in w][:1], str(w[0].message) if w else "", round(float(r.y[0]), 5))
`);
  assert.equal(out, [
    "vode {'method': 'bdf'} 2 ['RuntimeWarning'] scipy.integrate.ode: vode(method='bdf') is integrated with a non-stiff Runge-Kutta solver in Sagebrush, not SciPy's stiff/multistep method 0.36788",
    "lsoda {} 2 ['RuntimeWarning'] scipy.integrate.ode: lsoda is integrated with a non-stiff Runge-Kutta solver in Sagebrush, not SciPy's stiff/multistep method 0.36788",
    "vode {} 0 []  0.36788",
    "dopri5 {} 0 []  0.36788",
    "dop853 {} 0 []  0.36788",
    "",
  ].join("\n"));
});

test("the options reach the solver: tight rtol and atol give a tight result; max_step with nsteps stops it where they say", () => {
  const out = py(`
import math, warnings
from scipy.integrate import ode
for name in ("vode", "lsoda", "dopri5", "dop853"):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r = ode(lambda t, y: [-y[0]]).set_integrator(name, rtol=1e-12, atol=1e-14).set_initial_value([1.0], 0.0)
        err = abs(float(r.integrate(4.0)[0]) - math.exp(-4))
        s = ode(lambda t, y: [-y[0]]).set_integrator(name, max_step=0.01, nsteps=10).set_initial_value([1.0], 0.0)
        y = float(s.integrate(1.0)[0])
    budget = [str(x.message) for x in w if x.category is UserWarning]
    print(name, err < 1e-12, round(s.t, 10), s.successful(), s.get_return_code(), len(budget), abs(y - math.exp(-s.t)) < 1e-9)
`);
  // (tight tolerances: errors near 1e-14, never the 1e-8 of the defaults; ten steps of at most 0.01: t = 0.1, a failure)
  assert.equal(out, [
    "vode True 0.1 False -1 1 True",
    "lsoda True 0.1 False -1 1 True",
    "dopri5 True 0.1 False -2 1 True",
    "dop853 True 0.1 False -2 1 True",
    "",
  ].join("\n"));
});

test("the step budget, the return codes and SciPy's warnings and errors", () => {
  const out = py(`
import warnings
from scipy.integrate import ode
for name in ("vode", "lsoda", "dopri5", "dop853"):
    r = ode(lambda t, y: [y[1], -1000 * y[0]]).set_integrator(name, nsteps=5)
    r.set_initial_value([1.0, 0.0], 0)
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r.integrate(10.0)
    print(name, r.successful(), r.get_return_code(), [str(x.message) for x in w], [x.category.__name__ for x in w])
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    r = ode(lambda t, y: -y).set_integrator("dopri5").set_integrator("rk4")
print([str(x.message) for x in w], r.set_initial_value(1.0).integrate(1.0).round(4), r.get_return_code())
for bad in (lambda: ode(None).set_integrator("vode", method="euler"), lambda: ode(None).set_integrator("vode", tol=1)):
    try:
        bad()
    except (ValueError, TypeError) as e:
        print(type(e).__name__, e)
for bad in (lambda: ode(None).set_integrator("zvode"), lambda: ode(lambda t, y: y).set_initial_value(1.0).integrate(1.0, step=True)):
    try:
        bad()
    except NotImplementedError as e:
        print("NotImplementedError", e)
`);
  assert.equal(out, [
    "vode False -1 ['vode: Excess work done on this call. (Perhaps wrong MF.)'] ['UserWarning']",
    "lsoda False -1 [\"scipy.integrate.ode: lsoda is integrated with a non-stiff Runge-Kutta solver in Sagebrush, not SciPy's stiff/multistep method\", 'lsoda: Excess work done on this call (perhaps wrong Dfun type).'] ['RuntimeWarning', 'UserWarning']",
    "dopri5 False -2 ['dopri5: larger nsteps is needed'] ['UserWarning']",
    "dop853 False -2 ['dop853: larger nsteps is needed'] ['UserWarning']",
    "[\"No integrator name match with 'rk4' or is not available.\"] [0.3679] 1",
    "ValueError Unknown integration method euler",
    "TypeError vode.__init__() got an unexpected keyword argument 'tol'. Did you mean 'rtol'?",
    "NotImplementedError scipy.integrate.ode: the zvode integrator is not supported in Sagebrush",
    "NotImplementedError scipy.integrate.ode.integrate: step= and relax= are not supported in Sagebrush",
    "",
  ].join("\n"));
});
