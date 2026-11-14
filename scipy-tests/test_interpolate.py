# interp1d, PPoly and the cubic splines: SciPy's algorithms followed line for
# line, so every value printed (to the last bit: tolist()) must be SciPy's.
import numpy as np
from scipy.interpolate import interp1d, CubicSpline, PchipInterpolator, PPoly, CubicHermiteSpline, pchip_interpolate
x = np.array([0.0, 1.0, 2.5, 4.0, 4.5, 7.0])
y = np.array([1.0, -2.0, 0.5, 3.0, 2.0, -1.0])
xs = np.linspace(-1, 8, 19)
def show(name, f):
    try:
        v = f()
        print(name, repr(v.tolist()) if hasattr(v, "tolist") else repr(v))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)
show("lin", lambda: interp1d(x, y)(np.array([0.5, 2.0, 4.25])))
show("lin-extrap", lambda: interp1d(x, y, fill_value="extrapolate")(xs))
show("lin-fill", lambda: interp1d(x, y, bounds_error=False, fill_value=(9.0, -9.0))(xs))
show("lin-err", lambda: interp1d(x, y)(8.0))
show("lin-2d", lambda: interp1d(x, np.vstack([y, 2 * y]))(np.array([0.5, 3.0])))
show("nearest", lambda: interp1d(x, y, kind="nearest", fill_value="extrapolate")(xs))
show("nearest-up", lambda: interp1d(x, y, kind="nearest-up", bounds_error=False)(xs))
show("previous", lambda: interp1d(x, y, kind="previous", fill_value="extrapolate")(xs))
show("next", lambda: interp1d(x, y, kind="next", fill_value="extrapolate")(xs))
show("unsorted", lambda: interp1d([2.0, 0.0, 1.0], [4.0, 0.0, 1.0])(1.5))
show("scalar", lambda: interp1d(x, y)(1.5))
for bc in ("not-a-knot", "natural", "clamped", ((1, 2.0), (2, -1.0))):
    show("cs-" + str(bc), lambda: CubicSpline(x, y, bc_type=bc)(xs))
show("cs-c", lambda: CubicSpline(x, y).c)
show("cs-deriv", lambda: CubicSpline(x, y)(xs, 1))
show("cs-deriv2", lambda: CubicSpline(x, y)(xs, 2))
show("cs-derivative", lambda: CubicSpline(x, y).derivative()(xs))
show("cs-anti", lambda: CubicSpline(x, y).antiderivative()(xs))
show("cs-integrate", lambda: CubicSpline(x, y).integrate(0.3, 6.1))
show("cs-integrate-rev", lambda: CubicSpline(x, y).integrate(6.1, -0.5))
yp = y.copy(); yp[-1] = yp[0]
show("cs-periodic", lambda: CubicSpline(x, yp, bc_type="periodic")(xs))
show("cs-periodic-int", lambda: CubicSpline(x, yp, bc_type="periodic").integrate(-3, 20))
show("cs-3pts", lambda: CubicSpline([0, 1, 3], [1, 5, 2])(xs))
show("cs-2pts", lambda: CubicSpline([0, 1], [1, 5])(xs))
show("cs-2d", lambda: CubicSpline(x, np.vstack([y, y ** 2]).T)(np.array([0.5, 3.3])))
show("cs-axis1", lambda: CubicSpline(x, np.vstack([y, y ** 2]), axis=1)(np.array([0.5, 3.3])))
show("cs-noext", lambda: CubicSpline(x, y, extrapolate=False)(xs))
show("cs-gap", lambda: CubicSpline([0, 1, 2, 3], [0, 1, 8, 27])(1.5))
show("pchip", lambda: PchipInterpolator(x, y)(xs))
show("pchip-fn", lambda: pchip_interpolate(x, y, xs, der=1))
show("hermite", lambda: CubicHermiteSpline(x, y, np.cos(x))(xs))
show("ppoly", lambda: PPoly(np.array([[1.0, 2.0], [0.0, -1.0], [3.0, 3.0]]), [0, 1, 2])(np.array([0.5, 1.5, 2.5])))
show("bad-x", lambda: CubicSpline([0, 0, 1], [1, 2, 3]))
show("bad-per", lambda: CubicSpline(x, y, bc_type="periodic"))

# random data: every boundary condition, derivatives and integrals, both sides
rng = np.random.default_rng(3)
for trial in range(12):
    m = int(rng.integers(4, 30))
    xx = np.sort(rng.uniform(-5, 5, m)); yy = rng.normal(size=m)
    q = np.linspace(xx[0] - 1, xx[-1] + 1, 41)
    bc = ("not-a-knot", "natural", "clamped", ((1, 0.5), (2, -0.25)))[trial % 4]
    s = CubicSpline(xx, yy, bc_type=bc)
    show("rand-cs-%d" % trial, lambda: [s(q).tolist(), s(q, 1).tolist(), s.integrate(xx[0] - 0.5, xx[-1] - 0.1).tolist()])
    show("rand-pchip-%d" % trial, lambda: PchipInterpolator(xx, yy)(q))
    show("rand-lin-%d" % trial, lambda: interp1d(xx, yy, fill_value="extrapolate")(q))
