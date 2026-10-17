# int's real, imag, numerator and denominator, of small and big ints, bools
# and an int subclass: compared with CPython by coverage-fixes.test.ts
class N(int):
    pass
for v in [7, -3, 2**53 + 1, 10**300, -(10**400), True, False, N(5), N(10**30)]:
    print(type(v).__name__, v.real, v.imag, v.numerator, v.denominator, type(v.real).__name__, type(v.numerator).__name__)
from fractions import Fraction
print(Fraction(1, 10**400) < 10**300, Fraction(10**400) > 2**53, Fraction(3, 2) == 1.5)
