# ComplexField(p)'s own arithmetic and functions against Sage's ComplexNumber:
# products, quotients, inverses, integer and rational powers, other precisions
# and reals, the trigonometric and hyperbolic functions, exp, log, sqrt, abs,
# norm, arg (each step rounded, as Sage's complex_mpfr).  Each result is its
# parts' exact values, shown by a short digest per operation.
import hashlib
import random
random.seed(int(77))
PRECS = [2, 10, 24, 54, 64, 100, 200, 1000]
def part(R):
    v = R(random.randint(-2 ** 70, 2 ** 70)) / R(random.randint(1, 2 ** 70))
    return v * R(2) ** random.randint(-6, 3)
def k(v):
    return "%s %s" % (v.real().exact_rational(), v.imag().exact_rational())
for _ in range(300):
    p = random.choice(PRECS); C = ComplexField(p); R = RealField(p)
    a, b = C(part(R), part(R)), C(part(R), part(R))
    q = random.choice(PRECS); c = ComplexField(q)(part(RealField(q)), part(RealField(q)))
    r = part(RealField(random.choice(PRECS)))
    out = [k(a*b), k(a/b), k(~a), k(a^5), k(a^-3), k(a+c), k(a*c), k(a/c), k(a*r), k(r/a), k(a.sin()), k(a.cos()), k(a.tan()),
           k(a.sinh()), k(a.cosh()), k(a.tanh()), k(a.exp()), k(a.log()), k(a.sqrt()), k(a^(QQ(1)/3)), k(a^b),
           str(a.abs().exact_rational()), str(a.norm().exact_rational()), str(a.arg().exact_rational()), k(a.cot()), k(a.coth())]
    print(" ".join(hashlib.sha256(t.encode()).hexdigest()[:10] for t in out))
