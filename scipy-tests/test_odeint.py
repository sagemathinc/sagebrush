# odeint: Sagebrush's is the Dormand-Prince 5(4) method, SciPy's LSODA, so
# results agree within a tolerance (here 2e-5 relative to max(|y|, 1): each
# is within about 1e-5 of the true solution at odeint's default tolerances,
# and Sagebrush's usually much closer).
import math
import numpy as np
from scipy.integrate import odeint
from _check import check

TOL = 2e-5


def scaled(name, y, rtol=TOL):
    """y within rtol of SciPy's, relative to max(|y|, 1)"""
    check(name, y, rtol, rtol)


def lotka_volterra(state, t):
    tuna, shark = state
    return [0.9 * tuna - 0.05 * shark * tuna, 0.5 * 0.05 * shark * tuna - 0.4 * shark]


def seimr(state, t, c, beta, alpha, gamma, w):
    S, E, I, M, R = state
    N = S + E + I + M + R
    return [-c * beta * I / N * S, c * beta * I / N * S - alpha * E, alpha * E - gamma * I, gamma * I - w * M, w * M]


t = np.linspace(0, 100, 1000)
sol = odeint(lotka_volterra, [60, 20], t)
print(sol.shape, sol.dtype, sol[0])
scaled("lotka-volterra", sol)
sol = odeint(seimr, [9990, 10, 0, 0, 0], t, args=(3, 0.2, 1, 0.1, 0.2))
print(sol.shape)
scaled("seimr", sol)
sol = odeint(seimr, [9990, 10, 0, 0, 0], np.linspace(0, 200, 1000), args=(0, 0.2, 1, 0.1, 0.2))
scaled("seimr c=0", sol)

# the lab's shark removal: a second run from the first one's last row.  Taking
# 50 of 52.4 sharks amplifies the first run's error (5e-7 in each), so the
# two odeints differ by 1e-4 here, though each is within 1e-6 of the solution.
sol2 = odeint(lotka_volterra, [85, 20], np.linspace(0, 30, 1000))
sv2 = sol2[-1, :]
sv2[1] = sv2[1] - 50
sol2b = odeint(lotka_volterra, sv2, np.linspace(0, 30, 1000))
scaled("removal", np.concatenate((sol2, sol2b), axis=0), 1e-3)

print(odeint(lambda y, t: -y, 1.0, [0.0, 1.0]).shape)
scaled("scalar y0", odeint(lambda y, t: -y, 1.0, np.linspace(0, 5, 11)))
scaled("tfirst", odeint(lambda t, y: [y[1], -y[0]], [0.0, 1.0], np.linspace(0, 10, 21), tfirst=True))
scaled("decreasing t", odeint(lambda y, t: [-0.5 * y[0]], [1.0], np.linspace(4, 0, 9)))
scaled("repeated t", odeint(lambda y, t: [-y[0]], [1.0], [0.0, 0.0, 1.0, 1.0, 2.0]))
scaled("one time", odeint(lambda y, t: [-y[0]], [3.0, 4.0], [2.0]))
scaled("vdp", odeint(lambda y, t, mu: [y[1], mu * (1 - y[0] ** 2) * y[1] - y[0]], [2.0, 0.0], np.linspace(0, 20, 201), args=(1.0,)))
scaled("kepler", odeint(lambda y, t: [y[2], y[3], -y[0] / (y[0] ** 2 + y[1] ** 2) ** 1.5, -y[1] / (y[0] ** 2 + y[1] ** 2) ** 1.5],
                        [0.4, 0.0, 0.0, 2.0], np.linspace(0, 20, 500)), 1e-3)
scaled("rtol atol", odeint(lotka_volterra, [60, 20], np.linspace(0, 20, 50), rtol=1e-10, atol=1e-10), 1e-7)
scaled("loose", odeint(lotka_volterra, [60, 20], np.linspace(0, 20, 50), rtol=1e-4, atol=1e-6), 2e-2)
scaled("atol vector", odeint(lotka_volterra, [60, 20], np.linspace(0, 20, 50), atol=[1e-9, 1e-6]))
scaled("hmax", odeint(lambda y, t: [math.cos(t)], [0.0], np.linspace(0, 10, 5), hmax=0.1))
scaled("h0", odeint(lambda y, t: [-y[0]], [1.0], np.linspace(0, 3, 4), h0=1e-3))
scaled("tcrit", odeint(lambda y, t: [1.0 if t < 1 else 0.0], [0.0], [0.0, 2.0], tcrit=[1.0]), 1e-6)
scaled("numpy return", odeint(lambda y, t: -np.array(y) * 2, [1.0, 2.0], np.linspace(0, 1, 5)))
scaled("tuple return", odeint(lambda y, t: (y[1], -y[0]), [1.0, 0.0], np.linspace(0, 3, 7)))
scaled("int y0", odeint(lambda y, t: [y[0] * 0.1], [3], [0, 1, 2]))

sol, info = odeint(lotka_volterra, [60, 20], np.linspace(0, 10, 5), full_output=True)
print(info["message"], len(info["hu"]), len(info["tcur"]), len(info["nst"]), len(info["nfe"]), info["nje"])
print(all(info["tcur"] >= np.linspace(0, 10, 5)[1:]), all(np.diff(info["nst"]) >= 0), all(info["hu"] > 0))
try:
    odeint(lambda y, t: [-y[0]], [1.0], [0.0, 2.0, 1.0])
except ValueError as e:
    print("ValueError", e)
