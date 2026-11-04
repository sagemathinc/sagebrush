# minimize (BFGS, CG, Nelder-Mead) and minimize_scalar (Brent, bounded,
# golden): SciPy's algorithms followed line for line, so the results, the
# iterates and the counts (nfev, njev, nit) must be SciPy's exactly, each
# result printed whole as SciPy prints an OptimizeResult.  Except BFGS in two
# or more dimensions: its inverse Hessian update is a matrix product, which
# NumPy hands to OpenBLAS, whose kernels (fused multiply-adds, chosen per CPU)
# round differently from Sagebrush's in the last bit, and from each other on
# different machines; so its results are compared within a tolerance (check()).
import warnings
import numpy as np
from _check import check
from scipy.optimize import (minimize, minimize_scalar, rosen, rosen_der, rosen_hess, rosen_hess_prod, approx_fprime,
                            brent, golden, bracket, fminbound, fmin, fmin_bfgs, fmin_cg, line_search, OptimizeResult)

np.set_printoptions(precision=17)


def quad(x):
    return (x[0] - 1.5) ** 2 + 3 * (x[1] + 0.5) ** 2 + 0.1 * x[0] * x[1]


def quad_grad(x):
    return np.array([2 * (x[0] - 1.5) + 0.1 * x[1], 6 * (x[1] + 0.5) + 0.1 * x[0]])


def show(label, res):
    print("==", label)
    print(res)


def show_bfgs(label, res):
    print("==", label, res.success, res.message)
    check(label + " x", res.x, 1e-6, 1e-9)
    check(label + " fun", [res.fun], 1e-6, 1e-12)


# BFGS, the default: finite-difference gradients, an analytic one, jac=True, args, tol, options
show_bfgs("bfgs rosen 5", minimize(rosen, [1.3, 0.7, 0.8, 1.9, 1.2]))
show_bfgs("bfgs rosen jac", minimize(rosen, [1.3, 0.7, 0.8], jac=rosen_der))
show_bfgs("bfgs jac=True", minimize(lambda x: (quad(x), quad_grad(x)), [0.0, 0.0], jac=True))
show_bfgs("bfgs args", minimize(lambda x, a, b: (x[0] - a) ** 2 + (x[1] - b) ** 4, [0.0, 0.0], args=(1.0, -2.0)))
show_bfgs("bfgs tol", minimize(quad, [3.0, 3.0], jac=quad_grad, tol=1e-10))
show_bfgs("bfgs maxiter", minimize(rosen, [-1.2, 1.0], options={"maxiter": 5}))
show_bfgs("bfgs 3-point", minimize(quad, [0.0, 0.0], jac="3-point"))
show("bfgs scalar x0", minimize(lambda x: (x[0] - 3.0) ** 2, 1.0))
# CG
show("cg quad", minimize(quad, [0.0, 0.0], method="CG"))
show("cg rosen jac", minimize(rosen, [-1.2, 1.0], method="CG", jac=rosen_der))
show("cg gtol", minimize(quad, [5.0, -5.0], method="cg", options={"gtol": 1e-8}))
# Nelder-Mead
show("nm rosen", minimize(rosen, [1.3, 0.7], method="Nelder-Mead"))
show("nm tol", minimize(quad, [0.0, 0.0], method="nelder-mead", tol=1e-8))
show("nm adaptive", minimize(rosen, [1.3, 0.7, 0.8], method="Nelder-Mead", options={"adaptive": True}))
# callbacks: the classic form and intermediate_result, and StopIteration
seen = []
minimize(quad, [0.0, 0.0], method="BFGS", callback=lambda xk: seen.append(xk.copy()))
print("callback xk", len(seen))
check("callback xk", seen[-1], 1e-6, 1e-9)
stops = []


def stop(intermediate_result):
    stops.append(intermediate_result.fun)
    if len(stops) == 2:
        raise StopIteration


show_bfgs("bfgs callback stop", minimize(rosen, [-1.2, 1.0], callback=stop))
# minimize_scalar
f3 = lambda x: (x - 2) * x * (x + 2) ** 2
show("brent", minimize_scalar(f3))
show("brent bracket", minimize_scalar(f3, bracket=(0, 1, 2)))
show("bounded", minimize_scalar(f3, bounds=(-3, -1), method="bounded"))
show("golden", minimize_scalar(lambda x: (x - 1) ** 2, method="golden"))
show("brent tol", minimize_scalar(lambda x: np.cos(x) + 0.1 * x, tol=1e-12))
print("brent fn", brent(f3, full_output=True))
print("golden fn", golden(lambda x: (x - 1) ** 2, full_output=True))
print("bracket", bracket(f3))
print("fminbound", fminbound(np.cos, 3, 4, full_output=True))
# the classic interfaces
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    print("fmin", fmin(rosen, [1.3, 0.7], disp=False, full_output=True))
    r = fmin_bfgs(quad, [0.0, 0.0], disp=False, full_output=True)
    check("fmin_bfgs", list(r[0]) + [r[1]], 1e-6, 1e-9)
    print("fmin_cg", fmin_cg(quad, [0.0, 0.0], disp=False, full_output=True))
# helpers
x = np.array([0.5, 1.5, -0.3])
print("rosen", rosen(x), rosen_der(x), rosen_hess(x), rosen_hess_prod(x, np.array([1.0, 2.0, 3.0])))
print("approx_fprime", approx_fprime(x, rosen), approx_fprime(x, rosen, 1e-6))
print("line_search", line_search(quad, quad_grad, np.array([0.0, 0.0]), -quad_grad(np.array([0.0, 0.0]))))
r = OptimizeResult(x=np.array([1.0, 2.0]), fun=3.0, success=True)
print("result", r.x, r.fun, sorted(r.keys()))
# errors: SciPy's messages
for label, f in [("bad x0", lambda: minimize(quad, [[1.0, 2.0]])), ("bounded no bounds", lambda: minimize_scalar(f3, method="bounded")),
                 ("brent bounds", lambda: minimize_scalar(f3, bounds=(0, 1), method="brent")), ("unknown", lambda: minimize_scalar(f3, method="nope"))]:
    try:
        f()
        print(label, "no error")
    except Exception as e:
        print(label, type(e).__name__, e)
