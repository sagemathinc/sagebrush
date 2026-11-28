# np.interp as NumPy computes it: an exact knot its own value, never through a slope that overflows (R02 P2-7); a NaN
# from the left knot retried from the right one, then the equal values themselves; per part for a complex fp. Exact
# values printed as hex.
import numpy as np, warnings
warnings.simplefilter("ignore")
inf, nan = np.inf, np.nan
def show(tag, f):
    try: print(tag, "|", [float(v).hex() if not isinstance(v, complex) else (float(v.real).hex(), float(v.imag).hex()) for v in np.atleast_1d(f()).tolist()])
    except Exception as e: print(tag, "| !!", type(e).__name__)
X = [-1., 0., 0.25, 0.5, 1., 1.5, 2., 3., nan, inf, -inf]
FP = [[-1e308, 1e308, 0.], [1e308, 1e308, 1e308], [-inf, inf, 0.], [inf, inf, 1.], [nan, 1., 2.], [0., nan, 2.], [-inf, -inf, -inf], [1., 2., 3.], [5e307, -1.7e308, 1.7e308]]
XP = [[0., 1., 2.], [0., 0., 2.], [0., 1., 1.], [0., 1e-300, 2.]]
for xp in XP:
    for fp in FP:
        show(f"interp {xp} {fp}", lambda: np.interp(X, xp, fp))
        show(f"interp cplx {xp} {fp}", lambda: np.interp(X, xp, np.array(fp) + 1j * np.array(fp[::-1])))
        show(f"interp lr {xp} {fp}", lambda: np.interp(X, xp, fp, left=-7., right=7.))
show("r02 witness", lambda: np.interp([0., 1.], [0., 1.], [-1e308, 1e308]))
show("scalar knot", lambda: np.interp(1.0, [0., 1., 2.], [-1e308, 1e308, -1e308]))
show("period knot", lambda: np.interp([0., 90., 360.], [0., 90., 180., 270.], [-1e308, 1e308, -1e308, 1e308], period=360))
# a complex fp's slope by the reciprocal of the knots' distance (rounded otherwise than a division); a part's retry
# from the right knot; a NaN x gives NaN+0j
rng = np.random.RandomState(7)
xp = np.sort(rng.uniform(0, 10, 40)); fp = rng.standard_normal(40) * 1e3
xq = rng.uniform(0, 10, 200)
show("random real", lambda: np.interp(xq, xp, fp))
show("random complex", lambda: np.interp(xq, xp, fp + 1j * fp[::-1]))
show("complex part retry", lambda: np.interp([0.5], [0., 1.], [complex(inf, 1.0), complex(1.0, inf)]))
show("complex part equal", lambda: np.interp([0.5], [0., 1.], [complex(inf, -inf), complex(inf, -inf)]))
show("complex nan x", lambda: np.interp([nan, 0.5], [0., 1.], [1 + 2j, 3 + 4j]))
