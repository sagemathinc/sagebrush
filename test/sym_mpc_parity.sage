# Elements of ComplexField(p), p != 53, in symbolic expressions against
# ComplexNumberMP (test/sage-sym-mp.test.ts): each symbolic sum, product,
# quotient and integer power of such numbers, with numbers of other
# precisions (complex or real), rationals and Gaussian rationals, must give
# exactly the number, the field and the digits that ComplexNumberMP's own
# operation gives, which is Sage's ComplexNumber's (each step rounded,
# sage-tests/test_sym_complexfield.sage against Sage itself).  A quotient is
# b times the inverse of a in a's own field, as Sage's symbolic ring
# computes it.  Zeros,
# infinities and NaN parts are Sage's symbolic rules, not ComplexNumber's:
# they are left out here (test_sym_complexfield.sage has the zeros).
import random
random.seed(int(16322))
PRECS = [2, 3, 10, 24, 30, 52, 54, 64, 100, 200, 1000]


def part(R):
    k = random.random()
    if k < 0.08:
        return R(random.choice([-1, 1])) * R(2) ** random.randint(-1000, 1000)
    v = R(random.randint(-2 ** 70, 2 ** 70)) / R(random.randint(1, 2 ** 70))
    return v * R(2) ** random.randint(-60, 60)


def mpc(p):
    C = ComplexField(p)
    R = RealField(p)
    re, im = part(R), part(R)
    if random.random() < 0.05:
        re = R(0)
    return C(re, im)


def other(p):
    k = random.random()
    if k < 0.45:
        return mpc(random.choice(PRECS))
    if k < 0.65:
        return part(RealField(random.choice(PRECS)))
    if k < 0.85:
        return QQ(random.randint(-10 ** 30, 10 ** 30)) / random.randint(1, 10 ** 20)
    # (a Gaussian rational, as its parts)
    return ("g", QQ(random.randint(-10 ** 9, 10 ** 9)) / random.randint(1, 10 ** 6), QQ(random.randint(-10 ** 9, 10 ** 9)) / random.randint(1, 10 ** 6))


def key(v):
    return (str(v), str(v.parent()), str(v.real().exact_rational()) if hasattr(v, 'real') else "", str(v.imag().exact_rational()) if hasattr(v, 'imag') else "")


def huge(v):
    # past the values a symbolic expression holds (2^-4097 <= |part| < 2^4096)
    parts = (v.real(), v.imag()) if type(v).__name__ == "ComplexNumberMP" else (v,)
    return any(type(t).__name__ == "RealNumberMP" and t._m != 0 and abs(t._e + abs(t._m).bit_length()) > 4096 for t in parts)


def special(v):
    parts = (v.real(), v.imag()) if type(v).__name__ == "ComplexNumberMP" else (v,)
    return any(getattr(t, "_special", None) for t in parts)


def as_c(v, p):
    # a Gaussian rational or a rational as an element of ComplexField(p), each
    # part rounded once; a number of a field as it is
    C = ComplexField(p)
    if isinstance(v, tuple):
        return C(C._real_field()(v[1]), C._real_field()(v[2]))
    if type(v).__name__ in ("ComplexNumberMP", "RealNumberMP"):
        return v
    return C(C._real_field()(v), C._real_field()(0))


def sr(v):
    return SR(v[1]) + I * SR(v[2]) if isinstance(v, tuple) else SR(v)


checked = refused = bad = 0


def check(label, sym, want):
    global checked, refused, bad
    try:
        w = want()
    except ZeroDivisionError:
        return
    if special(w):
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
    except NotImplementedError:
        # (an intermediate past the range, in a power)
        refused += 1
        return
    except Exception as _err:
        g = "%s: %s" % (type(_err).__name__, _err)
        if bad < 8:
            print("ERR", label, g)
        bad += 1
        return
    if key(g) != key(w):
        if bad < 8:
            print("BAD", label, key(g), key(w))
        bad += 1
    checked += 1


for _ in range(1500):
    p = random.choice(PRECS)
    a, b = mpc(p), other(p)
    bp = b.prec() if type(b).__name__ in ("ComplexNumberMP", "RealNumberMP") else p
    A, B = as_c(a, p), as_c(b, bp)
    label = "%r ~ %r" % (a, b)
    check("+ " + label, lambda: SR(a) + sr(b), lambda: A + B)
    check("* " + label, lambda: SR(a) * sr(b), lambda: A * B)
    check("- " + label, lambda: sr(b) - SR(a), lambda: B - A)
    if a:
        check("/ " + label, lambda: sr(b) / SR(a), lambda: B * ~A)
    n = random.choice([2, 3, 5, 8, 13, -1, -2, -7, 31])
    check("^%d %r" % (n, a), lambda: SR(a) ^ n, lambda: A ** n)
print("checked", checked, "refused", refused, "bad", bad)
