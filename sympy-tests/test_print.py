# Printed and LaTeX forms: SymPy's order of terms and factors, its Floats
# (15 digits alone, short inside an expression), quotients and powers.
from sympy.abc import X, Y, N, P, a, b


def show(e):
    lx = getattr(e, "_repr_latex_", None)
    print(str(e), "|", lx() if lx else "")


k = 2.5 ** 3.2
for e in [
    X**2 + X**3, 4*X**3 - 2*X + 7, X**2 - X, -X**3 + X**2, X - 1, -X + 1, -X**2 + 1, -2*X + 3,
    -X*Y + 1, -X + Y, Y - X, 1 - X - Y, -X**2 + Y, 2*X**2 - X,
    X**0.5 + X + 1, X**2 + X**0.5 + 1, X**1.5 + X, X**1.5 + X**2, X**3.5 + X**8.0, Y**0.5 + X,
    1.25 * X**3.2 / (k + X**3.2), 0.4 * Y**1.5 / (0.6**1.5 + Y**1.5), 6.0 / (1 + X**2.5),
    X / (X + 1), X**2 / (X + 1) + X, X / (X + 1) + X**2, 1 / (X + 1) + X, 1 / X, 1 / X**2, 1 / X + 1 / X**2 + 3,
    (X + 1)**2 + X, X*(2 - X) - 3*X, N*(1 - N) - N*P, 0.3*N*(1 - N/50), P*(N - 1),
    X / 2, 3*X/2 + Y/3, X**2/2 + X/3, a*X + b, b*X**2 + a*X, 3*X*Y, 2.5*X + 0.1, 1e-7*X + 1, 1e20*X,
    -X, -X / (X + 1) + 1, 2 - (X + 1)**2, 4.0 + 1.5*(X - 2.0), X**(-2.5) + 1,
]:
    show(e)
