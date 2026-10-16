var('x y z a b n')
def S(r):
    # a sum as the sorted list of its terms (the order of terms is the
    # printer's, compared elsewhere)
    if isinstance(r, tuple):
        return tuple(S(u) for u in r)
    try:
        if 'add' in str(r.operator()) or 'mul' in str(r.operator()):
            return sorted(str(u) for u in r.operands())
    except AttributeError:
        pass
    return r
def t(l, F):
    try: print(l, "=", S(F()))
    except Exception as _err: print(l, "!", type(_err).__name__, _err)
print("== expand_trig")
for i, e in enumerate([sin(2*x), cos(2*x), sin(3*x), cos(3*x), cos(4*x), sin(5*x), tan(2*x), tan(3*x), sin(x+y), cos(x+y), sin(x-y), cos(x+y+z), sin(2*x+y), sin(x/2), cos(-2*x), sin(2*x)^2, sin(x+y)*cos(x), sinh(2*x), cosh(x+y), tanh(x+y), sin(2*x)+cos(2*x), sin(x)+1, sin(n*x), sin(x+pi/2), cos(x+pi/3), sin(2*(x+y)), exp(sin(2*x)), sin(1/2*x+y), cos(3/2*x), sin(-x-y)]):
    t("expand_trig[%d]" % i, lambda: e.expand_trig())
t("trig_expand", lambda: (sin(2*x)).trig_expand())
print("== reduce_trig")
for i, e in enumerate([sin(x)^2, cos(x)^2, sin(x)^3, cos(x)^3, sin(x)^4, cos(x)^4, sin(x)*cos(x), sin(x)^2*cos(x)^2, sin(x)*cos(y), sin(x)*sin(y), cos(x)*cos(y), sin(x)^2 + cos(x)^2, sin(2*x)^2, sin(x)^5, cos(x)^6, tan(x)^2, sin(x)^2*cos(y), sinh(x)^2, cosh(x)^3, sin(x)*cos(x)*sin(2*x), x*sin(x)^2, exp(x)*cos(x)^2, (sin(x) + cos(x))^2, sin(x+y)^2]):
    t("reduce_trig[%d]" % i, lambda: e.reduce_trig())
t("trig_reduce", lambda: (sin(x)^2).trig_reduce())
print("== expand_log")
for i, e in enumerate([log(x*y), log(x^10), log(x/y), log(2*x), log(x^y), log(sqrt(x)), log(x*y*z), log(x^2*y^3), log(3/4), log(2^x), log(exp(x)*y), log((x+1)^2), log(x)+log(y*z), log(x*y)^2, sin(log(x*y)), log(-x*y), log(1/x), log(x^(1/3)*y^2), log(10*x)]):
    t("expand_log[%d]" % i, lambda: e.expand_log())
t("log_expand", lambda: log(x*y).log_expand())
t("expand_log powers", lambda: log(x^2*y).expand_log(algorithm='powers'))
t("expand_log all", lambda: log(6*x).expand_log(algorithm='all'))
print("== simplify_log")
for i, e in enumerate([log(2)+log(x), log(x)+log(y), log(x)-log(y), 2*log(x), log(x)+log(y)-log(z), 3*log(2), log(x)/2, x*log(y)+log(z), log(x)+1, log(x)^2+log(y), log(a)+log(b)+x, 1/2*log(x)+log(y), -log(x), log(x) - 2*log(y)]):
    t("simplify_log[%d]" % i, lambda: e.simplify_log())
t("log_simplify", lambda: (log(x)+log(y)).log_simplify())
print("== collect")
for (e, v) in [(x^2 + a*x^2 + b*x + x + 1, x), (a*x + b*x + y, x), (x*y + x*z + y, x), ((x+a)^2, x), (expand((x+a)^2*(x+b)), x), (x^2*y + x*y^2 + x*y, y), (a*x^2 + x^2 + 3, x), (sin(x)*a + sin(x)*b, sin(x))]:
    t("collect(%s, %s)" % (e, v), lambda: e.collect(v))
print("== sage_eval")
t("sage_eval('2^10')", lambda: sage_eval('2^10'))
t("sage_eval('x^2+1', locals={'x':3})", lambda: sage_eval('x^2+1', locals={'x':3}))
t("sage_eval('1/3 + 1/6')", lambda: sage_eval('1/3 + 1/6'))
t("sage_eval('[1..5]')", lambda: sage_eval('[1..5]'))
t("sage_eval('sqrt(8)')", lambda: sage_eval('sqrt(8)'))
t("sage_eval('t^2', locals={'t': x+1})", lambda: sage_eval('t^2', locals={'t': x+1}))
t("sage_eval('a', locals={'a': 2})", lambda: sage_eval('a', locals={'a': 2}))
t("sage_eval('1.5^2')", lambda: sage_eval('1.5^2'))
t("parent", lambda: sage_eval('2/4').parent())
t("sage_eval(cmds)", lambda: sage_eval(('y = 3', 'y^2')))

print("== more")
t("expand_trig full", lambda: (sin(2*x + y).expand_trig(full=True).expand(), sin(2*x+2*y).expand_trig(full=True).expand(), cos(3*x + y).expand_trig(full=True).expand()))
t("collect sin", lambda: ((a*x+b*x+x^2*a + sin(x)*x).collect(x), (x^2*sin(x) + x*sin(x) + 2*x^2).collect(x)))
t("expand_log nothing", lambda: log(x*y).expand_log(algorithm='nothing'))
t("expand_trig(tan(x + y))", lambda: (tan(x + y).expand_trig() - (tan(x) + tan(y))/(1 - tan(x)*tan(y))).simplify_rational())
print("== canonicalize_radical")
for i, e in enumerate([sqrt(x^2*y^2), (x^6)^(1/3), sqrt(8*x^3), sqrt(x^2), sqrt(4*x^2), (x^2)^(3/2), sqrt(x)*sqrt(y), sqrt(x*y), sqrt(x^2+2*x+1), exp(log(x)), log(exp(x)), log(x*y), sqrt(12), (8*x^3*y^6)^(1/3), sqrt(x^3), x^(1/2)*x^(1/3), (x^(1/2))^2, sqrt(x^4*y), sqrt(2)*sqrt(6), 1/sqrt(x^2), sqrt(-x^2), (x^3)^(2/3), (1/x^2)^(1/2), sqrt(x^2)/x, (x+1)^(3/2)/(x+1)^(1/2), sqrt(a^2*b), exp(2*log(x)), log(x^2)]):
    t("canonicalize_radical[%d]" % i, lambda: e.canonicalize_radical())
print("== partial_fraction")
for i, e in enumerate([1/(x^2-1), 1/(x*(x+1)), (x+2)/(x^2+3*x+2), x^3/(x^2-1), 1/(x^2+1), 1/(x^3-1), 1/((x-1)^2*(x+1)), (x^2+1)/(x*(x-1)^3), 1/(x^4-1), 3/(2*x+1)/(x-2), 1/(x^2+x+1), x/(x^2-4)]):
    t("partial_fraction[%d]" % i, lambda: e.partial_fraction())
print("== simplify_factorial")
for i, e in enumerate([factorial(n+1)/factorial(n), factorial(n)/factorial(n-1), factorial(n+2)/factorial(n), binomial(n, 2), binomial(n, 3), factorial(2*n)/factorial(n), gamma(n+1)/gamma(n), factorial(n+1)*factorial(n-1)/factorial(n)^2]):
    t("simplify_factorial[%d]" % i, lambda: e.simplify_factorial())
t("sage_eval 3-tuple", lambda: sage_eval(("a=2", "a+b", {"b": 3}), locals={"b": 7}))
_d = {"x": 2}
t("sage_eval cmds update locals", lambda: (sage_eval("x", locals=_d, cmds="x=3"), _d["x"]))
_e = {}
t("sage_eval cmds update empty locals", lambda: (sage_eval("z+1", locals=_e, cmds="z=4"), _e["z"]))
def _se_del():
    d = {'x': 2}; sage_eval('1', locals=d, cmds='del x'); return 'x' in d
def _se_raise():
    d = {'x': 2}
    try:
        sage_eval('1', locals=d, cmds="x=3; raise ValueError('oops')")
    except ValueError:
        pass
    return d['x']
def _se_walrus():
    d = {'x': 2}; return (sage_eval('(x := 4)', locals=d), d['x'])
def _se_tuple_copy():
    d = {'b': 3}; return (sage_eval(('a=2', 'a+b', d)), sorted(d))
t("sage_eval del in cmds", _se_del)
t("sage_eval cmds raising", _se_raise)
t("sage_eval walrus", _se_walrus)
t("sage_eval tuple locals copied", _se_tuple_copy)
t("sage_eval comprehension", lambda: sage_eval('[t*i for i in range(3)]', locals={'t': 2}))
