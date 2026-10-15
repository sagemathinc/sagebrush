# Float floor division, modulo and divmod, and the math module's fmod,
# remainder, floor, ceil, trunc, modf, copysign and frexp, at signed zeros,
# infinities, nan, subnormals and the largest doubles, in every position
# and with ints mixed in: the values (the sign of a zero, nan) and the
# errors, as CPython prints them (test/float-divmod.test.ts compares).
import math

inf, nan = float("inf"), float("nan")
FLOATS = [0.0, -0.0, 1.0, -1.0, 2.5, -2.5, 3.0, -3.0, 0.1, -0.1, 1e308, -1e308, 5e-324, -5e-324, 2.0 ** 53, -(2.0 ** 53),
          inf, -inf, nan]
INTS = [0, 1, -1, 3, -3, 2 ** 53 + 1, -(2 ** 60), 10 ** 400]


def show(f):
    try:
        r = f()
    except Exception as e:  # (the error and its message)
        return "%s(%s)" % (type(e).__name__, e)
    return repr(r)


def binary(a, b):
    def aug_floordiv():
        x = a
        x //= b
        return x

    def aug_mod():
        x = a
        x %= b
        return x
    return [show(lambda: a // b), show(lambda: a % b), show(lambda: divmod(a, b)), show(aug_floordiv), show(aug_mod)]


for a in FLOATS:
    for b in FLOATS:
        print(repr(a), repr(b), *binary(a, b))
for a in FLOATS:
    for b in INTS:
        print(repr(a), repr(b), *binary(a, b))
        print(repr(b), repr(a), *binary(b, a))
for a in FLOATS:
    for b in FLOATS:
        print("fmod remainder copysign", repr(a), repr(b), show(lambda: math.fmod(a, b)), show(lambda: math.remainder(a, b)),
              show(lambda: math.copysign(a, b)))
for a in FLOATS:
    print("floor ceil trunc modf frexp", repr(a), show(lambda: math.floor(a)), show(lambda: math.ceil(a)), show(lambda: math.trunc(a)),
          show(lambda: math.modf(a)), show(lambda: math.frexp(a)), show(lambda: round(a)), show(lambda: round(a, 1)))
for a in FLOATS:
    for b in FLOATS:
        print("isclose", repr(a), repr(b), show(lambda: math.isclose(a, b)), show(lambda: math.isclose(a, b, rel_tol=0.5)),
              show(lambda: math.isclose(a, b, abs_tol=1.0)))
for xs in [[inf, 1.0], [inf, -inf], [nan, 1.0], [1e308, 1e308], [1e308, 1e308, -1e308], [0.1] * 10, [-0.0, -0.0], [-0.0], [],
           [1e100, 1.0, -1e100, 1e-100], [inf, inf], [-inf, nan]]:
    print("fsum", repr(xs), show(lambda: math.fsum(xs)))
for kw in [{"rel_tol": -1.0}, {"abs_tol": -1.0}, {"rel_tol": nan}]:
    print("isclose bad", kw, show(lambda: math.isclose(1.0, 1.0, **kw)))


# divmod's binary protocol: __divmod__, then the other operand's
# __rdivmod__, a subclass's reflected method first
class A:
    def __divmod__(self, o):
        return "A.divmod"

    def __rdivmod__(self, o):
        return "A.rdivmod"


class B(A):
    def __rdivmod__(self, o):
        return "B.rdivmod"


class C:
    def __divmod__(self, o):
        return NotImplemented


class Fl(float):
    def __rdivmod__(self, o):
        return "Fl.rdivmod"


for f in (lambda: divmod(A(), 1), lambda: divmod(1, A()), lambda: divmod(A(), B()), lambda: divmod(C(), 1), lambda: divmod(1, "x"),
          lambda: divmod(2.0, Fl(3)), lambda: divmod(Fl(3), 2.0), lambda: divmod(True, 2), lambda: divmod(-7.5, 2), lambda: divmod(2, -7.5)):
    print("protocol", show(f))
