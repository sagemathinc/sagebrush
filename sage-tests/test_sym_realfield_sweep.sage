# Elements of RealField(p) in symbolic expressions against Sage, on seeded
# random arguments: each function and power at numbers, as Sage's symbolic
# ring computes it (some with RealNumber's own method, sinh, tanh, cot and
# the like through their identities, powers in the base's field), digits and
# field.
import random
random.seed(int(1632))
x = var('x')
PRECS = [10, 24, 30, 64, 100, 113, 200, 333]


def rnd(K, scale=1):
    v = K(random.randint(int(-10**6), int(10**6))) / K(random.randint(int(1), int(10**5)))
    return v / K(scale) if v != 0 else K(1) / K(3)


def show(label, r):
    try:
        print(label, "|", r, "|", r.pyobject().parent())
    except Exception as _err:
        print(label, "|", r, "| symbolic")


FS = ["sin", "cos", "tan", "cot", "sec", "csc", "arctan", "arccot", "sinh", "cosh", "tanh", "coth",
      "sech", "csch", "arcsinh", "exp", "abs", "sgn", "floor", "ceil", "heaviside"]
for f in FS:
    for p in PRECS:
        K = RealField(p)
        v = rnd(K, 100 if f in ("exp", "sinh", "cosh", "tanh", "coth", "sech", "csch") else 1)
        show("%s(%r)" % (f, v), eval(f)(SR(v)))
# (tanh and coth are one division of e^x and e^-x: rounded once, as Sage)
for i in range(60):
    K = RealField(random.choice(PRECS + [54, 300]))
    v = rnd(K, random.choice([1, 10, 100, 1000]))
    show("tanh(%r)" % v, tanh(SR(v)))
    show("coth(%r)" % v, coth(SR(v)))
for f in ["log", "sqrt", "arccosh", "gamma", "log_gamma", "factorial"]:
    for p in PRECS:
        K = RealField(p)
        v = abs(rnd(K)) + 1
        show("%s(%r)" % (f, v), eval(f)(SR(v)))
for f in ["arcsin", "arccos", "arctanh"]:
    for p in PRECS:
        K = RealField(p)
        v = rnd(K, 10**5)
        show("%s(%r)" % (f, v), eval(f)(SR(v)))
for i in range(24):
    K, L = RealField(random.choice(PRECS)), RealField(random.choice(PRECS))
    b, y = abs(rnd(K)) + 1, rnd(L, 10)
    q = random.choice([QQ(1)/3, QQ(3)/2, QQ(-5)/7, QQ(1)/2, QQ(-1)/2, QQ(7)/4, 2, -3])
    show("%r^%r" % (b, y), SR(b)^SR(y))
    show("%r^%s" % (b, q), SR(b)^q)
    show("%s^%r" % (q if q > 0 else -q, y), SR(q if q > 0 else -q)^SR(y))
    show("e^%r" % y, e^SR(y))
    show("atan2", atan2(SR(b), SR(y)))
    show("log2", log(SR(b), SR(abs(y) + 2)))
f = x
for i in range(70):
    f = sin(f)
show("sin^70", f.subs(x=SR(RealField(100)(1)/3)))
print(SR(RealField(100)(1)/3).is_numeric(), (SR(RealField(100)(1)/3)*x).is_numeric())
K = RealField(5000)
show("R5000", SR(K(1)/3) + 1)
K = RealField(4000)
show("tiny product", SR(K(2)^-90) * SR(K(2)^-10))
show("near the top", SR(RealField(100)(2)^4000) * 3)
# a sinh or tanh that cancels is the exact 0; a zero exponent the exact 1
show("sinh tiny", sinh(SR(RealField(24)(10)^-20)))
show("tanh tiny", tanh(SR(-RealField(24)(10)^-20)))
show("sinh 2^-200", sinh(SR(RealField(100)(2)^-200)))
show("tanh 2900", tanh(SR(RealField(100)(2900))))
for s in ["SR(R(2))^SR(S(0))", "e^SR(S(0))", "SR(R(-8))^SR(S(-0.0))", "SR(2)^SR(S(0))", "SR(R(0))^SR(S(0))", "SR(R(1))^SR(S(5.5))"]:
    R, S = RealField(100), RealField(30)
    show(s, eval(s.replace("^", "**")))
