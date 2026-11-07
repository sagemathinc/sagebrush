# Improper integrals of powers on half-lines: a pole of the integrand
# outside the interval (the root scan of an infinite end, engine/sym
# definite.rs poly_roots), convergent and divergent.
def show(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, e)

show("1/x^2 on [1, oo):", lambda: integrate(1/x^2, x, 1, oo))
show("1/x^3 on [1, oo):", lambda: integrate(1/x^3, x, 1, oo))
show("x^(-3/2) on [1, oo):", lambda: integrate(x^(-3/2), x, 1, oo))
show("1/x^4 on [2, oo):", lambda: integrate(1/x^4, x, 2, oo))
show("1/x^2 on (-oo, -1]:", lambda: integrate(1/x^2, x, -oo, -1))
show("1/(x + 2)^2 on [-1, oo):", lambda: integrate(1/(x + 2)^2, x, -1, oo))
show("1/(x^2 + x) on [1, oo):", lambda: integrate(1/(x^2 + x), x, 1, oo))
show("x/(x^2 + 1)^2 on [0, oo):", lambda: integrate(x/(x^2 + 1)^2, x, 0, oo))
show("1/sqrt(x) on (0, 1]:", lambda: integrate(1/sqrt(x), x, 0, 1))
show("1/(1 + x^2) on [0, oo):", lambda: integrate(1/(1 + x^2), x, 0, oo))
show("exp(-2*x) on [0, oo):", lambda: integrate(exp(-2*x), x, 0, oo))
show("1/x on [1, oo):", lambda: integrate(1/x, x, 1, oo))
show("1/sqrt(x) on [1, oo):", lambda: integrate(1/sqrt(x), x, 1, oo))
show("1/x^2 on [-1, oo):", lambda: integrate(1/x^2, x, -1, oo))
