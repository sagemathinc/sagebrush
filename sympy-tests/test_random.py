# Random sums of products and quotients of powers (integer and float
# exponents, integer, rational and float coefficients), and their
# derivatives: their printed and LaTeX forms.  Denominators are a power plus
# a positive constant, so nothing divides by zero.
import random
from sympy import diff
from sympy.abc import X, Y, N, P

rng = random.Random(20261114)
syms = ["X", "Y", "N", "P"]
coefs = ["2", "3", "-1", "-2", "0.5", "1.5", "-0.25", "10", "1/2"]
pows = ["2", "3", "-1", "-2", "0.5", "1.5", "2.5", "4.5"]


def atom():
    s = rng.choice(syms[:2] if rng.random() < 0.7 else syms)
    r = rng.random()
    if r < 0.4:
        return s
    if r < 0.8:
        return "%s**%s" % (s, rng.choice(pows))
    return rng.choice(coefs)


def term():
    parts = [atom() for _ in range(rng.randint(1, 3))]
    if rng.random() < 0.5:
        parts.insert(0, rng.choice(coefs))
    t = "*".join("(%s)" % p for p in parts)
    if rng.random() < 0.25:
        t = "(%s)/(%s**%s + %s)" % (t, rng.choice(syms[:2]), rng.choice(["1", "2", "2.5"]), rng.choice(["1", "3", "0.5"]))
    return t


for i in range(300):
    src = " + ".join(term() for _ in range(rng.randint(1, 4)))
    want_d = rng.random() < 0.5
    e = eval(src)
    lx = getattr(e, "_repr_latex_", None)
    line = "%d %s => %s | %s" % (i, src, e, lx() if lx else "")
    if want_d and hasattr(e, "subs"):
        line += " || %s" % diff(e, X)
    print(line)
