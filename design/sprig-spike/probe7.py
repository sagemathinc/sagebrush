import sys, traceback
sys.path.insert(0, "/scratch/matlab-tmp/wtmx/lib")
import _sprig as W
import sage_all as S
x = S.var("x")
print("int1", S.integrate(1/x**2, x, 1, S.oo))
print("int2", S.integrate(S.exp(-x), x, 0, S.oo))
print("int3", S.integrate(1/x**2, x, S.SR(1), S.oo))
try:
    print(W.form(W.ev(W.parse("LinearSolve[{{1, 1}, {1, -1}}, {3, 1}]")[0])))
except Exception:
    traceback.print_exc(limit=-3)
try:
    print(W.form(W.ev(W.parse("Integrate[1/x^2, {x, 1, Infinity}]")[0])))
except Exception:
    traceback.print_exc(limit=-3)
