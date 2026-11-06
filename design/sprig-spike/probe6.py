import sys, traceback
sys.path.insert(0, "/scratch/matlab-tmp/wtmx/lib")
import _sprig as W
import sage_all as S
for src in ["Sum[(-1)^k/(2 k + 1), {k, 0, Infinity}]", "Solve[x^2 + y^2 == 1 && x == y, {x, y}]"]:
    try:
        print(W.form(W.ev(W.parse(src)[0])))
    except Exception:
        traceback.print_exc(limit=-4)
x, y, z = S.var("x y z")
print((x*y + x*z + y).collect(x) if hasattr(x, "collect") else "no collect")
q = S.QQ(3)/4
print(type(q).__name__, [m for m in ("numerator", "denominator") if callable(getattr(q, m, None))], q.numerator)
