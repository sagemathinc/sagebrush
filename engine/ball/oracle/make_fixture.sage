# The oracle for sagebrush-ball's tests: Arb (Sage's RealBallField) at 4000
# bits evaluates each function at exact dyadic inputs m 2^e.  Arb is only an
# independent check; no Arb code is used.
#   sage oracle/make_fixture.sage > tests/fixture.txt
# Each line: fn prec m e | M E RM RE  (Arb's ball: M 2^E +/- RM 2^RE).
import random
random.seed(int(20261010))
R = RealBallField(4000)

def out(fn, prec, m, e, b):
    s, M, E = b.mid().sign_mantissa_exponent()
    _, RM, RE = b.rad().sign_mantissa_exponent()
    print(fn, prec, m, e, "|", s * M, E, RM, RE)

def x_of(m, e):
    return R(Integer(m)) * R(2)**e

PRECS = [53, 100, 256, 1000]
cases = []
for _ in range(25):
    m = random.randint(1, 2**random.randint(1, 200)) * random.choice([1, -1])
    e = random.randint(-210, 10) - (Integer(abs(m)).nbits() - 1)
    cases.append((m, e))
# adversarial: near 1, tiny, huge, near multiples of pi, exact small integers
adv = [(1, 0), (3, 0), (-1, 0), (2**100 + 1, -100), (2**100 - 1, -100), (1, -1000), (-5, -2000), (1, 50), (12345, 30),
       (355, 0), (884279719003555, -48), (2**200 + 3, -200), (7, 3000), (1, -60), (710, 0), (-700, 0)]
cases += adv
for prec in PRECS:
    for (m, e) in cases:
        x = x_of(m, e)
        if abs(x) < 2**30:
            out("exp", prec, m, e, x.exp())
        if x > 0:
            out("log", prec, m, e, x.log())
            out("sqrt", prec, m, e, x.sqrt())
        if abs(x) < 2**60:
            out("sin", prec, m, e, x.sin())
            out("cos", prec, m, e, x.cos())
        out("atan", prec, m, e, x.arctan())
for prec in PRECS + [2000]:
    out("pi", prec, 0, 0, R.pi())
    out("ln2", prec, 0, 0, R(2).log())
    out("gamma", prec, 0, 0, R.euler_constant())
    out("catalan", prec, 0, 0, R.catalan_constant())
C = ComplexBallField(4000)
for prec in [53, 100, 256]:
    for (m, e) in [(1, -1), (1, -2), (3, -2), (1, 0), (2**60 - 1, -60), (1, -40), (12345, -14), (99, -7), (7, -3), (1, -1000), (2**100 - 2**40, -100)]:
        x = x_of(m, e)
        out("li2", prec, m, e, C(x).polylog(2).real())
        out("ti2", prec, m, e, C(0, x).polylog(2).imag())
