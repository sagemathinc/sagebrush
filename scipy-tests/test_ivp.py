# solve_ivp's explicit Runge-Kutta methods follow SciPy's step control, so the
# steps taken (their number, nfev, the messages) must be SciPy's exactly,
# except at tight tolerances (accurate() below), where they are not
# reproducible across CPUs even for SciPy itself.  The
# values agree to 1e-6: the error estimates are sums with heavy cancellation
# (DOP853's especially), which SciPy's BLAS adds in another order, so step
# sizes differ in the 8th digit (DOP853's values, over long runs at loose
# tolerances, agree to 1e-4, still well within its rtol).
import math
import numpy as np
from scipy.integrate import solve_ivp, RK45
from _check import check


def summary(name, r):
    print(name, r.status, r.success, r.message, len(r.t), r.y.shape, r.nfev, r.njev, r.nlu)
    tol = (1e-4, 1e-6) if name.startswith("DOP853") else (1e-6, 1e-9)
    check(name + " t", r.t, *tol)
    check(name + " y", r.y.real, *tol)
    if np.iscomplexobj(r.y):
        check(name + " y.imag", r.y.imag, *tol)


def accurate(name, r, tol):
    """A run at a tight tolerance, compared on a fixed grid of times only:
    its steps depend on the last bits of the error estimates, which are sums
    with heavy cancellation that SciPy adds with NumPy's BLAS, in an order
    that depends on the CPU (on CI's runner the steps of RK45 at rtol 1e-9
    moved by 1e-7).  Each run is within its own tolerance of the solution,
    so the two agree to tol."""
    print(name, r.status, r.success, r.message, r.t.shape, r.y.shape)
    check(name + " t", r.t, 0.0, 0.0)
    check(name + " y", r.y.real, tol, tol)


def osc(t, y):
    return [y[1], -y[0] + 0.1 * math.sin(t)]


def vdp(t, y, mu):
    return [y[1], mu * (1 - y[0] ** 2) * y[1] - y[0]]


for method in ["RK45", "RK23", "DOP853"]:
    summary(method + " osc", solve_ivp(osc, [0, 10], [1.0, 0.0], method=method))
    accurate(method + " osc tight", solve_ivp(osc, [0, 10], [1.0, 0.0], method=method, rtol=1e-9, atol=1e-11,
                                               t_eval=np.linspace(0, 10, 41)), 1e-7)
    if method == "DOP853":
        # (DOP853 at rtol 1e-3 here: steps 2e-5 apart where y changes fast, so tighter, on a grid)
        accurate(method + " vdp", solve_ivp(vdp, [0, 20], [2.0, 0.0], method=method, args=(1.0,), rtol=1e-8, atol=1e-10,
                                            t_eval=np.linspace(0, 20, 41)), 1e-6)
    else:
        summary(method + " vdp", solve_ivp(vdp, [0, 20], [2.0, 0.0], method=method, args=(1.0,)))
    summary(method + " backward", solve_ivp(lambda t, y: -2 * y, [3, 0], [1.0], method=method))
    summary(method + " max_step", solve_ivp(lambda t, y: np.cos(t) * y, [0, 5], [1.0], method=method, max_step=0.3))
    summary(method + " first_step", solve_ivp(lambda t, y: -y, [0, 2], [1.0], method=method, first_step=0.01))
    summary(method + " atol vector", solve_ivp(osc, [0, 5], [1.0, 0.0], method=method, atol=[1e-8, 1e-3]))
    summary(method + " complex", solve_ivp(lambda t, y: 1j * y, [0, 3], [1.0 + 0j], method=method))
    te = np.linspace(0, 10, 7)
    r = solve_ivp(osc, [0, 10], [1.0, 0.0], method=method, t_eval=te, dense_output=True)
    summary(method + " t_eval", r)
    tol = (1e-4, 1e-6) if method == "DOP853" else (1e-6, 1e-9)
    check(method + " sol(3.3)", r.sol(3.3), *tol)
    check(method + " sol(array)", r.sol(np.linspace(0, 10, 13)), *tol)
    r = solve_ivp(osc, [0, 10], [1.0, 0.0], method=method, dense_output=True)
    summary(method + " dense", r)
    check(method + " dense sol", r.sol(np.linspace(0, 10, 23)), *tol)
    print(r.sol.n_segments, r.sol.t_min, r.sol.t_max)

# events
def ground(t, y):
    return y[0]


ground.terminal = True
ground.direction = -1


def apex(t, y):
    return y[1]


r = solve_ivp(lambda t, y: [y[1], -9.81], [0, 10], [10.0, 5.0], events=[ground, apex])
summary("ball", r)
check("ball t_events", np.concatenate(r.t_events), 1e-9)
check("ball y_events", np.concatenate([np.ravel(v) for v in r.y_events]), 1e-6, 1e-9)


def zero_cross(t, y):
    return y[0]


r = solve_ivp(lambda t, y: [y[1], -y[0]], [0, 20], [1.0, 0.0], events=zero_cross, dense_output=True)
summary("crossings", r)
check("crossings t", r.t_events[0], 1e-9)
counted = lambda t, y: y[0]
counted.terminal = 3
r = solve_ivp(lambda t, y: [y[1], -y[0]], [0, 20], [1.0, 0.0], events=counted)
summary("terminal 3", r)
check("terminal 3 t", r.t_events[0], 1e-9)
r = solve_ivp(lambda t, y, k: -k * y, [0, 5], [2.0], args=(0.5,), events=lambda t, y, k: y[0] - 1, t_eval=[0, 1, 2, 3, 4, 5])
summary("args events t_eval", r)
check("args events", r.t_events[0], 1e-9)
print(repr(solve_ivp(lambda t, y: -0.5 * y, [0, 10], [2, 4, 8])))

# the solver class directly
s = RK45(lambda t, y: -y, 0.0, [1.0, 2.0], 1.0)
while s.status == "running":
    s.step()
print(s.status, s.t, s.nfev)
check("RK45 class y", s.y, 1e-9)
for bad in [dict(t_eval=[0, 20]), dict(t_eval=[[0, 1]]), dict(first_step=-1), dict(max_step=0), dict(method="nope")]:
    try:
        solve_ivp(lambda t, y: -y, [0, 10], [1.0], **bad)
    except ValueError as e:
        print("ValueError", str(e)[:24])
