# Generated from ../test_symbolic.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_1 = Integer(1); _sage_const_2 = Integer(2); _sage_const_3 = Integer(3); _sage_const_5 = Integer(5); _sage_const_6 = Integer(6); _sage_const_4 = Integer(4); _sage_const_7 = Integer(7); _sage_const_8 = Integer(8); _sage_const_12 = Integer(12); _sage_const_0 = Integer(0); _sage_const_1p0 = RealNumber('1.0')# Symbolic expressions (engine/sym): arithmetic, derivatives, series,
# exact values, printing.  Maxima-backed functions (limit, solve,
# taylor, simplify_*) are checked in engine/sym/corpus/calculus.json.
x, y, z, a, b, c = var('x y z a b c')
try:
    print(repr(x + x))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x + _sage_const_1 )**_sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(expand((x + _sage_const_1 )**_sage_const_3 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(expand((x - y)*(x + y))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(factor(x**_sage_const_2  - _sage_const_1 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(factor(x**_sage_const_3  - y**_sage_const_3 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(x**_sage_const_2 )/x))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(sin(x**_sage_const_2 )/x, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(x**_sage_const_5 , x, _sage_const_3 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(exp(x*y), x, y)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(log(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(tan(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(arctan(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(sqrt(_sage_const_1  - x**_sage_const_2 ), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(x**x, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(cos(x)**_sage_const_2 , x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(exp(-x**_sage_const_2 /_sage_const_2 ), x, _sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(a*x**_sage_const_2  + b*x + c, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(derivative(sinh(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(x).series(x, _sage_const_6 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(x).series(x, _sage_const_4 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(cos(x).series(x, _sage_const_7 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((_sage_const_1 /(_sage_const_1  - x)).series(x, _sage_const_5 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_8 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_12 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_4 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(-_sage_const_4 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_2 )**_sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_2 )*sqrt(_sage_const_3 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(pi/_sage_const_6 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(cos(pi/_sage_const_4 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(tan(pi/_sage_const_3 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(_sage_const_0 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(_sage_const_0 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(log(_sage_const_1 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(log(e)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(log(x))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(e**_sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(pi.n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(e.n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(_sage_const_2 ).n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((pi + e).n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(_sage_const_1p0 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(_sage_const_1 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(I**_sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((_sage_const_1  + I)**_sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((_sage_const_2  + _sage_const_3 *I)/(_sage_const_1  - I)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(abs(-_sage_const_3 *x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    f = x**_sage_const_3  - _sage_const_2 *x + _sage_const_1 
    print(repr(f.subs(x=_sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    f = x**_sage_const_3  - _sage_const_2 *x + _sage_const_1 
    print(repr(f(x=_sage_const_1 /_sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    f = sin(x)*cos(y)
    print(repr(f.subs(x=pi/_sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_2  + _sage_const_3 *x + _sage_const_2 ).coefficients(x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_4  + x).degree(x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_2 *y + _sage_const_3 *x).coefficient(x, _sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(((x + _sage_const_1 )/(x - _sage_const_1 )).numerator()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(((x + _sage_const_1 )/(x - _sage_const_1 )).denominator()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_2  + _sage_const_1 ).variables()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x + y + z).variables()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(sin(x**_sage_const_2 )/x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(sqrt(x) + _sage_const_1 /x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(x**(_sage_const_1 /_sage_const_3 ))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(exp(x)*cos(x))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(pi*x**_sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(arctan(x))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(x == _sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(x**_sage_const_2  + _sage_const_1  < _sage_const_5 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(bool(x + x == _sage_const_2 *x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(bool(pi > _sage_const_3 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(SR(_sage_const_3 )/_sage_const_5 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_2  - _sage_const_1 )/(x - _sage_const_1 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(_sage_const_1 /x + _sage_const_1 /y))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(x/y*y))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_2 )**(_sage_const_1 /_sage_const_2 )))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x**_sage_const_3 )**_sage_const_2 ))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(_sage_const_2 **x * _sage_const_2 **x))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(x)*exp(y)))
except Exception as _err:
    print('ERR', type(_err).__name__)