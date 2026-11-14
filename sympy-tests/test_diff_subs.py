# diff (partial derivatives too) and subs with Python and NumPy numbers; a
# fully substituted expression is a Float that works as a number.
import numpy as np
import sympy
from sympy import diff
from sympy.abc import X, Y, N


def show(label, v):
    lx = getattr(v, "_repr_latex_", None)
    print(label, "|", str(v), "|", lx() if lx else "")


k = 2.5 ** 3.2
f = 1.25 * X**3.2 / (k + X**3.2)
show("f", f)
show("f'", diff(f, X))
show("quartic'", diff(X**4 - 3*X**2, X))
show("poly'", diff(X**3 - 4*X**2 + X, X))
show("partial Y", diff(3*X*Y, Y))
show("partial X", diff(3*X*Y + X**2*Y, X))
show("mixed", diff(X**2*Y**3, X, Y))
show("logistic'", diff(0.3*N*(1 - N/50), N))
show("sympy.diff", sympy.diff(X**4, X))

g = X**2 + X**3
for v in [0.5, np.float64(0.5), np.linspace(0.0, 2.0, 5)[3], 2, -1.5]:
    show("g(%r)" % (float(v),), g.subs(X, v))
m = diff(f, X).subs(X, 1.75)
show("slope", m)
show("round", round(m, 4))
show("round2", round(g.subs(X, 1.2345), 2))
show("arith", g.subs(X, 0.5) * 2 + 1)
show("float", float(g.subs(X, 0.5)))
show("pairs", (3*X*Y + Y).subs([(X, 2.0), (Y, 0.25)]))
show("dict", (3*X*Y).subs({X: 2.0}))
show("partial subs", (3*X*Y + X).subs(X, 2.0))

# a tangent line at a point
x0 = 1.5
line = f.subs(X, x0) + diff(f, X).subs(X, x0) * (X - x0)
show("tangent", line)
xs = np.linspace(0.5, 3.0, 6)
print([round(float(line.subs(X, x)), 6) for x in xs])
print([round(float(f.subs(X, x)), 6) for x in xs])
try:
    float(f)
except TypeError as e:
    print("TypeError")
