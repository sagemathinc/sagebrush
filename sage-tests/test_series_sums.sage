# Infinite sums: s^k r(k) with s = 1 or -1 and r rational (poles at
# integers and half-integers: zeta, eta and beta values, logarithms,
# telescoping), the sine, cosine, sinh and cosh series, and the
# divergent 1/k^s with s <= 1 (lib/_sage_expr.py symbolic_sum).
var('k')
def show(i, f, a):
    # (by number: how an input prints is not what is tested)
    try:
        print(i, "from", a, ":", sum(f, k, a, oo))
    except Exception as e:
        print(i, "from", a, ":", type(e).__name__, e)

for i, (f, a) in enumerate([((-1)^k/(2*k + 1), 0), ((-1)^k/k, 1), ((-1)^(k + 1)/k, 1), ((-1)^k/k^2, 1),
             ((-1)^k/k^3, 1), ((-1)^k/k^4, 1), ((-1)^k/(k + 1), 0), ((-1)^k/(k + 1)^2, 0),
             ((-1)^k/(2*k + 1)^3, 0), ((-1)^k/(2*k - 1), 1), ((-1)^k/(2*k + 3), 0),
             ((-1)^k/(k*(k + 1)), 1), ((-1)^k*(2*k + 1)/(k*(k + 1)), 1), ((-1)^(2*k + 1)/k^2, 1),
             (1/(k*(k + 1)), 1), (1/(k*(k + 2)), 1), (1/((2*k + 1)*(2*k + 3)), 0), (1/(k^2 - 1), 2),
             (1/(4*k^2 - 1), 1), (1/(k*(k + 1)*(k + 2)), 1), (1/k^2, 2), (1/(k + 1)^2, 0),
             (1/(2*k + 1)^2, 0), (1/(2*k + 1)^4, 0), (1/k^3, 1), (1/(k^2*(k + 1)), 1),
             ((2*k + 1)/(k^2*(k + 1)^2), 1), (1/(k*(2*k + 1)), 1), (3/(k*(k + 3)), 1),
             (1/k, 1), (k^2, 1), (1/sqrt(k), 1),
             ((-1)^k*x^(2*k + 1)/factorial(2*k + 1), 0), ((-1)^k*x^(2*k)/factorial(2*k), 0),
             (x^(2*k + 1)/factorial(2*k + 1), 0), (x^(2*k)/factorial(2*k), 0),
             (3*(-1)^k*x^(2*k)/factorial(2*k), 0), ((-1)^k*x^(2*k + 1)/factorial(2*k), 0)]):
    show(i, f, a)
