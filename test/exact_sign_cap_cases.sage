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
# 7. I counts as degree 2 in the tree's bound: I times five square roots is degree 64, so the whole constant is refused
#    before it is built (its factors, each under the cap, are still tried for a zero)
calls.clear(); _sage_qqbar._convert = _spy
try:
    e7 = I*(sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13) + sqrt(17)) - 20
    print(_sage_expr._exact_sign(e7), any(str(c) == str(e7) for c in calls), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
# 8. a Gaussian rational atom has no tree bound: the conversion runs under the armed cap (32), restored after
caps = []
def _cap_spy(x):
    caps.append(_sage_qqbar._degree_cap)
    return saved(x)
_sage_qqbar._convert = _cap_spy
try:
    print(_sage_expr._exact_sign((1 + 2*I)*(sqrt(2) + sqrt(3)) - 5), sorted(set(caps)), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
# 9. a constant past 4000 characters is refused at once, before any factor is pruned or converted
calls.clear(); _sage_qqbar._convert = _spy
try:
    big = d*sum(sqrt(k) for k in range(2, 400))
    print(len(big._s) > 4000, _sage_expr._exact_sign(big), len(calls), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
