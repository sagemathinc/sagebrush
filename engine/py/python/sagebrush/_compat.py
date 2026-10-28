"""What the package uses of Python 3.12's standard library, on 3.10 and 3.11
(the floor is 3.10).  Imported first, by the package's __init__.

fractions.Fraction gains the two methods of 3.12's that the Sage layer uses
(Rational._from_coprime_ints, Fraction's is_integer), as 3.12 defines them,
and only where they are missing: on 3.12+ nothing is set, so that path is the
standard library's own, unchanged.  Remove this module once the floor is 3.12.
"""

from fractions import Fraction

if not hasattr(Fraction, "_from_coprime_ints"):
    def _from_coprime_ints(cls, numerator, denominator, /):
        obj = super(Fraction, cls).__new__(cls)
        obj._numerator = numerator
        obj._denominator = denominator
        return obj
    Fraction._from_coprime_ints = classmethod(_from_coprime_ints)
if not hasattr(Fraction, "is_integer"):
    def is_integer(self):
        return self._denominator == 1
    Fraction.is_integer = is_integer
