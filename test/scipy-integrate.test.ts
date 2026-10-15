import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/scipy/integrate.py where it is not SciPy (scipy-tests/ compares the
// rest with SciPy itself): what it does not implement raises an error, never
// a plausible answer, and odeint's failures are errors, not LSODA's warnings
// with garbage rows.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("scipy.integrate: unimplemented options raise NotImplementedError", () => {
  const out = py(`
import numpy as np
from scipy.integrate import odeint, solve_ivp, quad
f = lambda y, t: [-y[0]]
cases = [
    lambda: odeint(f, [1.0], [0, 1], Dfun=lambda y, t: [[-1.0]]),
    lambda: odeint(f, [1.0], [0, 1], ml=1, mu=1),
    lambda: odeint(f, [1.0], [0, 1], mxordn=4),
    lambda: odeint(f, [1.0], [0, 1], mxords=3),
    lambda: solve_ivp(lambda t, y: -y, [0, 1], [1.0], method="Radau"),
    lambda: solve_ivp(lambda t, y: -y, [0, 1], [1.0], method="BDF"),
    lambda: solve_ivp(lambda t, y: -y, [0, 1], [1.0], method="LSODA"),
    lambda: quad(lambda x: x, 0, 1, points=[0.5]),
    lambda: quad(lambda x: x, 0, 1, weight="cos", wvar=2),
]
for c in cases:
    try:
        c()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", str(e).split(" is not")[0])
`);
  assert.equal(out, [
    "NotImplementedError odeint: Dfun (a Jacobian for the stiff method)",
    "NotImplementedError odeint: ml and mu (a banded Jacobian for the stiff method)",
    "NotImplementedError odeint: mxordn and mxords (the orders of LSODA's methods)",
    "NotImplementedError odeint: mxordn and mxords (the orders of LSODA's methods)",
    "NotImplementedError solve_ivp: method='Radau' (an implicit method for stiff problems)",
    "NotImplementedError solve_ivp: method='BDF' (an implicit method for stiff problems)",
    "NotImplementedError solve_ivp: method='LSODA' (an implicit method for stiff problems)",
    "NotImplementedError quad: points (QUADPACK's QAGP)",
    "NotImplementedError quad: weight='cos' (QUADPACK's weighted rules)",
    "",
  ].join("\n"));
});

test("odeint: failures are errors; full_output's infodict has only honest keys", () => {
  const out = py(`
import warnings
import numpy as np
from scipy.integrate import odeint, ODEintWarning
# a stiff problem: an explicit method needs more than mxstep steps
try:
    odeint(lambda y, t: [-1e6 * (y[0] - np.cos(t))], [0.0], [0.0, 10.0], mxstep=200)
except RuntimeError as e:
    print("RuntimeError", str(e).split(" between")[0], "stiff" in str(e))
try:
    odeint(lambda y, t: [-y[0], 1.0], [1.0], [0.0, 1.0])
except ValueError as e:
    print("ValueError", e)
try:
    odeint(lambda y, t: [-y[0]], [1.0 + 1j], [0.0, 1.0])
except TypeError as e:
    print("TypeError", e)
# a solution that blows up: the step size collapses, which is an error
try:
    odeint(lambda y, t: [y[0] ** 2], [1.0], [0.0, 2.0])
except RuntimeError as e:
    print("RuntimeError", str(e)[:44])
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    odeint(lambda y, t: [-y[0]], [1.0], [0.0, 1.0], printmessg=True)
print([(x.category.__name__, str(x.message)) for x in w])
sol, info = odeint(lambda y, t: [-y[0]], [1.0], np.linspace(0, 1, 4), full_output=True)
print(sorted(info), info["nqu"], info["nje"], info["message"])
`);
  assert.equal(out, [
    "RuntimeError odeint: excess work done: more than mxstep=200 steps True",
    "ValueError odeint: the function returned an array of shape (2,); it must have the shape of y0, (1,)",
    "TypeError odeint: y0 is complex; odeint integrates real systems (use solve_ivp for complex ones)",
    "RuntimeError odeint: the step size became too small at t=",
    "[('ODEintWarning', 'Integration successful.')]",
    "['hu', 'message', 'nfe', 'nje', 'nqu', 'nst', 'tcur'] [5 5 5] [0 0 0] Integration successful.",
    "",
  ].join("\n"));
});
