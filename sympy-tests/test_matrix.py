# Matrix: vectors of expressions, jacobian, subs with a list of pairs, and a
# NumPy array of the result for numpy.linalg.eig.
import numpy as np
from sympy import Matrix, diff
from sympy.abc import N, P, X, Y


def show(label, v):
    lx = getattr(v, "_repr_latex_", None)
    print(label, "|", str(v), "|", lx() if lx else "")


F = Matrix([0.8*N*(1 - N/40) - 0.05*N*P, 0.02*N*P - 0.4*P])
show("F", F)
show("shape", F.shape)
J = F.jacobian(Matrix([N, P]))
show("J", J)
show("J by list", F.jacobian([N, P]))
eq = [(N, 20.0), (P, 8.0)]
Js = J.subs(eq)
show("J at eq", Js)
A = np.array(Js, dtype=float)
print(A.shape, A.dtype, [round(float(x), 6) for x in A.ravel()])
w = np.linalg.eig(A)[0]
print(sorted(round(float(np.real(x)), 6) for x in w), sorted(round(float(abs(np.imag(x))), 6) for x in w))
show("F at eq", F.subs(eq))
show("column", Matrix([X**2, 3*X*Y]))
show("rows", Matrix([[X, 1], [0, Y]]))
show("entry", J[0, 1])
show("flat", J[2])
print(len(J), list(Matrix([1, 2.5])))
show("diff", diff(Matrix([X**2, X*Y]), X))
try:
    np.array(J, dtype=float)
    print("no error")
except TypeError:
    print("TypeError")
