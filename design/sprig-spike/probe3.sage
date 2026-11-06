x, y = var('x y')
f = function('f')
items = ["SR(3)", "SR(3)/4", "SR(2.5)", "SR(I)", "2+3*I", "pi", "e", "exp(x)", "SR(oo)", "-SR(oo)", "x", "sqrt(x)", "log(x)", "sin(x)", "arctan2(y,x)", "abs(x)", "factorial(x)", "binomial(x,2)", "f(x)", "diff(f(x),x)", "diff(f(x),x,2)", "gamma(x)", "floor(x)", "SR(10)^100", "euler_gamma", "golden_ratio", "sinh(x)", "arcsin(x)", "sec(x)", "real_part(x)", "conjugate(x)", "erf(x)", "x==2", "x<3", "SR(2.5).n(digits=30)", "SR(2).n(digits=30)", "SR(NaN)", "unsigned_infinity", "x^y", "sqrt(2)", "1/sqrt(2)", "-x", "x-y"]
for it in items:
    try:
        e = eval(it)
        print(it, "=>", repr(e), "|", e._s[:60], "|", e._op()[:3])
    except Exception as ex:
        print(it, "!!", type(ex).__name__, str(ex)[:100])
s = sin(x).series(x, 6)
print(type(s), s, "|", s._s[:80], s._op()[:2])
print(s.truncate())
print([m for m in dir(s) if 'coef' in m or 'order' in m or 'trunc' in m or 'list' in m])
