# Elements of RealField(p), p != 53, in symbolic expressions against
# RealNumberMP (test/sage-sym-mp.test.ts): each symbolic operation on
# numbers must give exactly the number, the field and the digits that
# RealNumberMP's own operation gives, as Sage's symbolic ring computes them
# with RealNumber.  Division is a times the inverse of b, each rounded, as
# Sage's (a/b is a*b^-1 there; checked against Sage 10.9 on 3000 quotients).
# A zero term of a sum and a zero base of a power are Sage's symbolic
# rules, not RealNumber's (SR(RealField(10)(0)) + RDF(1.5) is 1.5 in RDF,
# SR(RealField(10)(0))^3 the exact 0): those are left out here and are in
# sage-tests/test_sym_realfield.sage, against Sage itself.  So is a function
# at a zero (Sage's sin(0.0) is the exact 0, for RR as for RealField(p)), and
# a power of NaN (Sage's NaN^2 stays as it is).
import random
random.seed(int(1632))
PRECS = [2, 3, 10, 24, 30, 52, 54, 64, 100, 200, 1000]


def mp(p):
    R = RealField(p)
    k = random.random()
    if k < 0.06:
        return random.choice([R(0), -R(0), R('inf'), -R('inf'), R('nan')])
    if k < 0.1:
        return R(random.choice([-1, 1])) * R(2) ** random.randint(-3000, 3000)
    v = R(random.randint(-2 ** 70, 2 ** 70)) / R(random.randint(1, 2 ** 70))
    return v * R(2) ** random.randint(-60, 60)


def other(p):
    k = random.random()
    if k < 0.4:
        return mp(random.choice(PRECS))
    if k < 0.6:
        return QQ(random.randint(-10 ** 30, 10 ** 30)) / random.randint(1, 10 ** 20)
    if k < 0.8:
        return RR(random.uniform(-1e6, 1e6))
    return RDF(random.uniform(-1e6, 1e6))


def key(v):
    return (str(v), str(v.parent()))


def is_mp(v):
    return type(v).__name__ == "RealNumberMP"


def huge(v):
    # past the values a symbolic expression holds (2^-4096 <= |v| < 2^4096),
    # or an element of RR past the doubles
    import _sage_expr
    if _sage_expr._rr_args((v,)) == 2:
        return True
    return is_mp(v) and v._m != 0 and abs(v._e + abs(v._m).bit_length()) > 4096


checked = refused = bad = 0


def check(label, sym, want):
    global checked, refused, bad
    try:
        w = want()
    except ZeroDivisionError:
        return
    if huge(w):
        try:
            sym()
            print("NOT REFUSED", label)
            bad += 1
        except NotImplementedError:
            refused += 1
        return
    try:
        g = sym().pyobject()
    except Exception as _err:
        g = "%s: %s" % (type(_err).__name__, _err)
        if bad < 8:
            print("ERR", label, g)
        bad += 1
        return
    if key(g) != key(w):
        if bad < 8:
            print("MISMATCH", label, key(g), key(w))
        bad += 1
    checked += 1


def inv(b):
    return b ** -1 if is_mp(b) else (RR(1) / b if b.parent() is RR else RDF(1) / b if b.parent() is RDF else 1 / b)


for i in range(700):
    a = mp(random.choice(PRECS))
    b = other(a.prec())
    lab = "%r [%d] %r [%s]" % (a, a.prec(), b, b.parent())
    if a != 0 and b != 0:
        check("add " + lab, lambda: SR(a) + SR(b), lambda: a + b)
        check("radd " + lab, lambda: SR(b) + SR(a), lambda: b + a if is_mp(b) else a.__radd__(b))
        check("sub " + lab, lambda: SR(a) - SR(b), lambda: a - b)
    check("mul " + lab, lambda: SR(a) * SR(b), lambda: a * b)
    check("rmul " + lab, lambda: SR(b) * SR(a), lambda: b * a if is_mp(b) else a.__rmul__(b))
    if b != 0 and b == b:
        check("div " + lab, lambda: SR(a) / SR(b), lambda: a * inv(b))
    n = random.choice([-7, -3, -2, -1, 2, 3, 5, 10, 31, 64, 1000])
    if a != 0 and a == a:
        check("pow %d %s" % (n, lab), lambda: SR(a) ^ n, lambda: a ** n)
    # (the functions Sage's symbolic ring computes with RealNumber's own
    # method; sinh, tanh, cot and the like it computes through identities:
    # sage-tests/test_sym_realfield_sweep.sage)
    f = random.choice(["sin", "cos", "tan", "exp", "arctan", "arcsinh", "log", "sqrt"])
    x0 = abs(a) if f in ("log", "sqrt") else a
    if x0 == x0 and x0 != 0 and abs(x0) < 2 ** 20:
        check("%s %r [%d]" % (f, x0, x0.prec()), lambda: globals()[f](SR(x0)),
              lambda: getattr(x0, f)())
print("checked", checked, "refused", refused, "bad", bad)
