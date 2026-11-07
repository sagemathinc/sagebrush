# _exact_sign's degree cap (test/exact-sign-cap.test.ts): a constant past the cap is refused from its tree's
# degree bound before any algebraic number is built, a stricter cap already set stays, a constant the bound cannot
# see as a plain node (abs) is bounded by 2*deg^2 and refused as early, and the cap is restored every time
import _sage_expr, _sage_qqbar
d = sqrt(sqrt(3) + 2) - (sqrt(6) + sqrt(2))/2
big = d*(sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13) + sqrt(17))
# 1. refused before anything is built: the conversion is never reached
saved = _sage_qqbar._convert
def _boom(x):
    raise RuntimeError("built")
_sage_qqbar._convert = _boom
try:
    print(_sage_expr._exact_sign(big), _sage_qqbar._degree_cap is None)
finally:
    _sage_qqbar._convert = saved
# 2. a stricter cap already set is kept, and restored as it was
_sage_qqbar._degree_cap = 4
print(_sage_expr._exact_sign(sqrt(2) + sqrt(3) - sqrt(5 + 2*sqrt(6))), _sage_qqbar._degree_cap)
_sage_qqbar._degree_cap = None
# 3. abs() in the bound: refused as early
print(_sage_expr._exact_sign(d*abs(sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13))), _sage_qqbar._degree_cap is None)
# 4. and the relation is still decided, as Sage decides it
print(bool(big == 0), bool(big != 0), bool(big < 1), _sage_qqbar._degree_cap is None)
# 5. a small one is still exact
print(_sage_expr._exact_sign(sqrt(2) + sqrt(3) - sqrt(5 + 2*sqrt(6))), _sage_qqbar._degree_cap is None)
