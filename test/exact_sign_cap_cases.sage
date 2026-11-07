# _exact_sign's degree cap (test/exact-sign-cap.test.ts): a constant past the cap is refused from its tree's
# degree bound before any algebraic number is built and stays undecided (None: bool() is False, as Sage leaves an
# unprovable relation), a stricter cap already set stays, abs is bounded by 2*deg^2, the cap is restored every
# time; and a product with a factor proven 0 (under the cap) is 0 without building the rest
import _sage_expr, _sage_qqbar
d = sqrt(sqrt(3) + 2) - (sqrt(6) + sqrt(2))/2
s6 = sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13) + sqrt(17) + sqrt(19)
saved = _sage_qqbar._convert
calls = []
def _spy(x):
    calls.append(x)
    return saved(x)
# 1. past the cap: refused before anything is built (the conversion is never reached), undecided
_sage_qqbar._convert = _spy
try:
    print(_sage_expr._exact_sign(s6 - 20), len(calls), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
# 2. a stricter cap already set is kept, and restored as it was
_sage_qqbar._degree_cap = 4
print(_sage_expr._exact_sign(sqrt(2) + sqrt(3) - sqrt(5 + 2*sqrt(6))), _sage_qqbar._degree_cap)
_sage_qqbar._degree_cap = None
# 3. abs() in the bound: refused as early
calls.clear(); _sage_qqbar._convert = _spy
try:
    print(_sage_expr._exact_sign(abs(sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13)) - 9), len(calls), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
# 4. a zero factor is proven alone: d*s6 is 0, and only d is converted
calls.clear(); _sage_qqbar._convert = _spy
try:
    print(_sage_expr._exact_sign(d*s6), len(calls) > 0 and not any("19" in str(c) for c in calls), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
# 5. and the relations are decided as Sage decides them
print(bool(d*s6 == 0), bool(d*s6 != 0), bool(d*s6 + 2^-100 > 0), bool(s6 - 20 == 0), _sage_qqbar._degree_cap is None)
# 6. a small one is still exact
print(_sage_expr._exact_sign(sqrt(2) + sqrt(3) - sqrt(5 + 2*sqrt(6))), _sage_qqbar._degree_cap is None)
