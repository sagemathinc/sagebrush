# complex ** complex as CPython 3.14's complex_pow: values (repr, so signed
# zeros and every digit) and errors, over a grid of special and ordinary
# values, compared line by line with CPython (test/complex-pow.test.ts).
# (Three pairs are left out: in them glibc's cos or sin, which CPython calls,
# is not correctly rounded, 0.5000082, 0.5000082 and 0.5033 ulp from the
# exact value, and Sagebrush's correctly rounded ones differ in the last bit.)
import math
inf, nan = math.inf, math.nan
parts = [0.0, -0.0, 1.0, -1.0, 2.0, -2.0, 0.5, -0.5, 3.0, 1e-300, -1e-300, 1e300, -1e300, 1.5, -2.25, inf, -inf, nan, 7.123456789, -0.1, 1e-320]
expo = [0.0, -0.0, 1.0, -1.0, 2.0, -2.0, 3.0, -3.0, 0.5, -0.5, 100.0, -100.0, 101.0, 2.5, 1e-10, 1e10, -1e10, inf, -inf, nan, 1/3, 17.0, -17.0]
bases = [complex(r, i) for r in parts for i in parts]
exps = [complex(r, i) for r in expo for i in [0.0, -0.0, 1.0, -1.0, 0.5, 2.0, inf, nan]]


SKIP = {(complex(-2, 1.5), complex(2, -1)), (complex(-2, 1.5), complex(-2, 1)), (complex(1.5, 1), complex(-1, 0.5))}


def show(a, b):
    try:
        r = a ** b
        return repr(r)
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


n = 0
for a in bases:
    for b in exps[::7] if abs(a) not in (0.0, 1.0) else exps:
        if (a, b) in SKIP:
            continue
        print(repr(a), repr(b), show(a, b))
        n += 1
# sage2's cases and some ordinary values
for a, b in [(complex(inf), complex(3, 0)), (complex(inf), complex(0, 1)), (complex(inf), complex(0.5, 0)), (complex(-inf), complex(-1, 0)),
             (complex(-2, 0), complex(0, 1)), (2j, 3.5 + 1j), (1 + 1j, 1 + 1j), (-1 - 1j, 0.25), (3, 1j), (1j, 1j), (0.5 + 0.5j, -2.5)]:
    print(repr(a), repr(b), show(a, b))
# mixed: float ** complex, complex ** int and float, negative float ** fraction
for a, b in [(2.0, 1j), (-8.0, 1 / 3), (-2.0, 0.5), (1j, 2), (1j, -3), (1 + 2j, 2.0), (0.0, -1), (0j, -1), (0j, 0), (0j, 1j), (0j, -1j), (0j, 0.5), (0j, -0.5)]:
    print(repr(a), repr(b), show(a, b))
for x in range(-30, 31):
    print('int pow', x, show(1.1 + 0.3j, x), show(-0.7 + 1.9j, x / 4))
print(n)
