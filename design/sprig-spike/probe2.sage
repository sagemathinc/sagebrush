x, y = var('x y')
import operator
for e in [x^2 + 3*x*y - sin(x)/2, (x-1)*exp(x), sqrt(2)*x, 1/(x+1), x == 2, I*x + pi, log(x, 2), arctan(x), x^(-1/2), oo, -oo, 2^(1/3)]:
    try:
        print(repr(e), "| op:", e.operator(), "| operands:", e.operands())
    except Exception as ex:
        print(repr(e), "!!", type(ex).__name__, ex)
f = SR(3)/4
print(type(f), f.pyobject() if hasattr(f, 'pyobject') else None, f.is_numeric() if hasattr(f,'is_numeric') else None)
print(type(SR(3)/4), (SR(3)/4).operator(), type(QQ(3)/4))
print(SR(2.5).operator(), type(SR(2.5).pyobject()))
print(exp(x).operator(), exp(x).operator() is exp, sin(x).operator() == sin, (x^2).operator() is operator.pow)
print(e.operator().__name__ if hasattr(e.operator(),'__name__') else e.operator())
print([type(o) for o in (x+y).operands()], (x*y).operator() is operator.mul, (x+y).operator() is operator.add)
print(SR(I).operator(), SR(I).pyobject(), pi.operator(), type(pi), e.is_symbol() if hasattr(e,'is_symbol') else 'nosym')
print(x.is_symbol(), SR(3).is_integer(), (x*y).operator())
print(x.series(x==0, 4) if hasattr(x,'series') else 'noseries', sin(x).series(x, 6))
print(sin(x).series(x, 6).truncate(), sin(x).series(x,6).operands() if hasattr(sin(x).series(x,6),'operands') else '')
print(type(plot(sin(x),(x,0,1))), [m for m in dir(plot(sin(x),(x,0,1))) if not m.startswith('_')][:40])
