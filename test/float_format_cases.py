# A float's digits under format()'s e, f, g and % types, and under str % and bytes %, at every power of ten a
# double reaches and the doubles just below and above each (where the decimal exponent is off by one if it is
# taken from log10: 1e-7's double is just below 10^-7, so '%.17g' is '9.9999999999999995e-08', not '1e-07'),
# and an int too large for a float under a float type (OverflowError, never 'inf'), as CPython prints them
# (test/float-divmod.test.ts compares).
import math

SPECS = [".17g", ".16g", ".15g", ".1g", ".3g", ".20g", "g", "#.17g", ".0g", ".17e", ".0e", ".3f", ".2%"]


def show(f):
    try:
        return f()
    except Exception as e:  # (the error and its message)
        return "%s(%s)" % (type(e).__name__, e)


values = []
for k in range(-323, 309):
    x = float("1e%d" % k)
    values += [math.nextafter(x, 0.0), x, math.nextafter(x, math.inf)]
values += [5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 0.1, 0.3, 1 / 3, 2 / 3, 2.5, 0.15, 4.35, 9.5, 99.5]
for x in values:
    print(repr(x), " ".join(format(x, s) for s in SPECS))
    print(" ", "%.17g %.17e %.3g" % (x, x, -x), b"%.17g %g" % (x, x))

# (times 100 in double precision: past the largest float, 'inf%')
for x in [1.7976931348623157e308, 1e306, 1.8e306, -1.7976931348623157e308]:
    print(format(x, "%"), format(x, ".2%"), format(x, "E"))

# (an int under a float type is float(v) first: past the largest float, OverflowError)
BIG = [2**1024, -2**1024, 2**1024 - 2**970, 2**1024 - 2**970 - 1, 10**400, 2**1023]
for v in BIG:
    print(" ".join(show(lambda: format(v, s)) for s in ["f", ".2f", "e", "g", "%", "G", ".3E", ""])[:200])
    print(" ", " ".join(show(lambda: t % v) for t in ["%f", "%e", "%g", "%.3e"])[:200])
