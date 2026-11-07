# Fraction-field elements as Sage keeps them: the normal form over ZZ and over
# a field (univariate and multivariate), exact quotients still fractions,
# printing, hashes, conversions, evaluation, partial fractions, zero division
def show(label, f):
    try:
        v = f()
        if isinstance(v, (bool, str, tuple)):
            print(label, '|', v)
        elif str(v.parent()).startswith('Fraction Field'):
            print(label, '|', v, '|', v.numerator(), '|', v.denominator(), '|', v.parent())
        else:
            print(label, '|', v, '|', v.parent())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:70]))

print("-- ZZ[x]")
R = ZZ['x']; x = R.gen(); F = R.fraction_field()
for n, f in [('(-x^2+1)/(x+1)', lambda: (-x^2 + 1)/(x + 1)), ('(x^2-1)/(-x-1)', lambda: (x^2 - 1)/(-x - 1)), ('(6x^2-6)/(-4x-4)', lambda: (6*x^2 - 6)/(-4*x - 4)),
             ('(-6x^2+6)/(4x-4)', lambda: (-6*x^2 + 6)/(4*x - 4)), ('(2x)/F(-4)', lambda: (2*x)/F(-4)), ('(-2x)/F(-4)', lambda: (-2*x)/F(-4)), ('(4x+2)/(6x)', lambda: (4*x + 2)/(6*x)),
             ('(-2x-4)/(-6x)', lambda: (-2*x - 4)/(-6*x)), ('2/(4x+6)', lambda: 2/(4*x + 6)), ('x/(-x+1)', lambda: x/(-x + 1)), ('1/(-2x)', lambda: 1/(-2*x)),
             ('(x+1)/(2x)*2', lambda: (x + 1)/(2*x)*2), ('(x+1)/(2x)+1', lambda: (x + 1)/(2*x) + 1), ('1/(2x)+1/(2x)', lambda: 1/(2*x) + 1/(2*x)), ('1/(2x)-1/(3x)', lambda: 1/(2*x) - 1/(3*x)),
             ('((x+1)/(2x))^2', lambda: ((x + 1)/(2*x))^2), ('((x+1)/(2x))^-2', lambda: ((x + 1)/(2*x))^-2), ('((-x-1)/(2x))^-1', lambda: ((-x - 1)/(2*x))^-1), ('1/((x+1)/(2x))', lambda: 1/((x + 1)/(2*x))),
             ('-(x+1)/(2x)', lambda: -((x + 1)/(2*x))), ('product to 1', lambda: (x + 1)/(2*x) * ((2*x)/(x + 1))), ('x/x', lambda: x/x), ('(-x)/x', lambda: (-x)/x), ('F(2)/F(-2)', lambda: F(2)/F(-2)),
             ('F(1/2)*x', lambda: F(1/2)*x), ('x/2', lambda: x/2), ('x/R(2)', lambda: x/R(2)), ('(2x)/R(2)', lambda: (2*x)/R(2)), ('2/x', lambda: 2/x), ('2/R(4)', lambda: 2/R(4)), ('R(4)/R(2)', lambda: R(4)/R(2)),
             ('(1/2)/x', lambda: (1/2)/x), ('x/(1/2)', lambda: x/(1/2)), ('F(x)+1/2', lambda: F(x) + 1/2), ('F(x)/(1/2)', lambda: F(x)/(1/2)), ('(2x)/F(1/2)', lambda: (2*x)/F(1/2)), ('-F(x)/2', lambda: -F(x)/2),
             ('F(2,4)', lambda: F(2, 4)), ('F(2x,-4)', lambda: F(2*x, -4)), ('F(x,-1)', lambda: F(x, -1)), ('F(-x,-1)', lambda: F(-x, -1)), ('F(1/2)', lambda: F(1/2)), ('x*(1/x)', lambda: x*(1/x)),
             ('QQ[x] gen + 1/x', lambda: QQ['x'].gen() + 1/x), ('0/(-x)', lambda: R(0)/(-x)), ('difference 0', lambda: (x + 1)/(2*x) - (x + 1)/(2*x)), ('x//x', lambda: x//x), ('(x^2-1)//(x-1)', lambda: (x^2 - 1)//(x - 1)),
             ('derivative', lambda: ((x + 1)/(2*x)).derivative()), ('at 1', lambda: ((x + 1)/(2*x))(1)), ('at 1/3', lambda: ((x + 1)/(2*x))(1/3)), ('(x^2-1)/(x-1) at 2', lambda: ((x^2 - 1)/(x - 1))(2)),
             ('(x+1)/x at y', lambda: ((x + 1)/x)(QQ['y'].gen())), ('equal', lambda: (x + 1)/(2*x) == (2*x + 2)/(4*x)), ('x/-2 == -x/2', lambda: F(x, -2) == F(-x, 2)),
             ('hash x/-2, -x/2', lambda: hash(F(x, -2)) == hash(F(-x, 2))), ('hash F(x), x', lambda: hash(F(x)) == hash(x)), ('hash equal', lambda: hash((x + 1)/(2*x)) == hash((2*x + 2)/(4*x))),
             ('latex x/-2', lambda: str(latex(F(x, -2)))), ('latex (x+1)/(-2x)', lambda: str(latex((x + 1)/(-2*x)))), ('latex x/x', lambda: str(latex(x/x))), ('(x/x).numerator()', lambda: (x/x).numerator()),
             ('R((x^2-1)/(x-1))', lambda: R((x^2 - 1)/(x - 1))), ('R(F(x,-1))', lambda: R(F(x, -1))), ('R(1/x)', lambda: R(1/x)), ('R(x/F(2))', lambda: R(x/F(2))),
             ('x/0', lambda: x/0), ('x/R(0)', lambda: x/R(0)), ('1/R(0)', lambda: 1/R(0)), ('R(0)/R(0)', lambda: R(0)/R(0)), ('F(x,0)', lambda: F(x, 0)), ('(1/x)/R(0)', lambda: (1/x)/R(0)),
             ('(1/x)/0', lambda: (1/x)/0), ('1/(x-x)', lambda: 1/(x - x)), ('(1/x)^-1', lambda: (1/x)^-1), ('F(0)^-1', lambda: F(0)^-1)]:
    show(n, f)

print("-- QQ[x]")
R = QQ['x']; x = R.gen(); F = R.fraction_field()
for n, f in [('(-x^2+1)/(x+1)', lambda: (-x^2 + 1)/(x + 1)), ('(6x^2-6)/(-4x-4)', lambda: (6*x^2 - 6)/(-4*x - 4)), ('x/x', lambda: x/x), ('(x+1)/(x+1)', lambda: (x + 1)/(x + 1)), ('2x/x', lambda: (2*x)/x),
             ('x/R(2)', lambda: x/R(2)), ('2/R(4)', lambda: 2/R(4)), ('(x^2-1)/(x-1)+1', lambda: (x^2 - 1)/(x - 1) + 1), ('(x+1)/(2x)', lambda: (x + 1)/(2*x)), ('1/(-2x)', lambda: 1/(-2*x)),
             ('R((x^2-1)/(x-1))', lambda: R((x^2 - 1)/(x - 1))), ('R(1/x)', lambda: R(1/x)), ('hash F(x), x', lambda: hash(F(x)) == hash(x)), ('x/x == 1', lambda: x/x == 1), ('at 1', lambda: (1/(x + 1))(1)),
             ('x/0', lambda: x/0), ('x/R(0)', lambda: x/R(0)), ('1/R(0)', lambda: 1/R(0)), ('F(x,0)', lambda: F(x, 0)), ('(1/x)/0', lambda: (1/x)/0), ('F(0)^-1', lambda: F(0)^-1)]:
    show(n, f)

print("-- GF(5)[x]")
R = GF(5)['x']; x = R.gen()
for n, f in [('x/x', lambda: x/x), ('(x^2-1)/(x-1)', lambda: (x^2 - 1)/(x - 1)), ('x/R(2)', lambda: x/R(2)), ('x/2', lambda: x/2), ('(x+1)/(2x)', lambda: (x + 1)/(2*x)), ('(2x^2-2)/(4x+4)', lambda: (2*x^2 - 2)/(4*x + 4))]:
    show(n, f)

for bn, R in [('QQ[x,y]', QQ['x,y']), ('ZZ[x,y]', ZZ['x,y']), ('GF(5)[x,y]', GF(5)['x,y'])]:
    print("--", bn)
    x, y = R.gens(); F = R.fraction_field()
    for n, f in [('(2x^2-2y^2)/(4x-4y)', lambda: (2*x^2 - 2*y^2)/(4*x - 4*y)), ('(x^2-y^2)/(-x+y)', lambda: (x^2 - y^2)/(-x + y)), ('(x^2-y^2)/(2x-2y)', lambda: (x^2 - y^2)/(2*x - 2*y)),
                 ('(xy)/(2x)', lambda: (x*y)/(2*x)), ('(3x)/(6xy)', lambda: (3*x)/(6*x*y)), ('(-2xy)/(4x)', lambda: (-2*x*y)/(4*x)), ('(6x^2)/(-4xy)', lambda: (6*x^2)/(-4*x*y)), ('(2x+2)/(4y)', lambda: (2*x + 2)/(4*y)),
                 ('3/(6x+9y)', lambda: 3/(6*x + 9*y)), ('(x/2)/(y/3)', lambda: (x/2)/(y/3)), ('1/(2x)+1/(2y)', lambda: 1/(2*x) + 1/(2*y)), ('(x/2)*(2/y)', lambda: (F(x)/2)*(F(2)/y)), ('(x+y)/(2x)*2', lambda: (x + y)/(2*x)*2),
                 ('x/x', lambda: x/x), ('(-x)/x', lambda: (-x)/x), ('(-x)/y', lambda: (-x)/y), ('x/(-2y)', lambda: x/(-2*y)), ('(-1)/y', lambda: F(-1)/y), ('2/(-y)', lambda: F(2)/(-y)), ('-1/(2xy)', lambda: -1/(2*x*y)),
                 ('(-x-y)/(x*y)', lambda: (-x - y)/(x*y)), ('(xy)/(-y)', lambda: (x*y)/(-y)), ('-(x/y)', lambda: -(x/y)), ('(x/y)^-1', lambda: (x/y)^-1), ('((x+1)/(2y))^2', lambda: ((x + 1)/(2*y))^2),
                 ('(x-y)/(y-x)', lambda: (x - y)/(y - x)), ('(y-x)/(x-y)^2', lambda: (y - x)/(x - y)^2), ('(x+y)/(-x-y)', lambda: (x + y)/(-x - y)), ('x/(y-x)', lambda: x/(y - x)), ('x/(2y-2x)', lambda: x/(2*y - 2*x)),
                 ('(2y-2x)/(4x)', lambda: (2*y - 2*x)/(4*x)), ('x/R(2)', lambda: x/R(2)), ('(2x)/R(2)', lambda: (2*x)/R(2)), ('x/2', lambda: x/2), ('F(x)/2', lambda: F(x)/2), ('2/F(-4)', lambda: 2/F(-4)),
                 ('hash x/(-y), (-x)/y', lambda: hash(F(x, -y)) == hash(F(-x, y))), ('hash F(x), x', lambda: hash(F(x)) == hash(x)), ('hash 3/(6y), 1/(2y)', lambda: hash(F(3, 6*y)) == hash(F(1, 2*y))),
                 ('x/0', lambda: x/0), ('x/R(0)', lambda: x/R(0)), ('1/R(0)', lambda: 1/R(0)), ('R(0)/R(0)', lambda: R(0)/R(0)), ('F(x,0)', lambda: F(x, 0)), ('(1/x)/R(0)', lambda: (1/x)/R(0)),
                 ('1/(x-x)', lambda: 1/(x - x)), ('F(0)^-1', lambda: F(0)^-1)]:
        if bn.startswith('GF') and n == 'x/0':
            continue
        show(n, f)

for bn, R in [('QQ[x]', QQ['x']), ('ZZ[x]', ZZ['x']), ('GF(5)[x]', GF(5)['x'])]:
    print("-- partial fractions over", bn)
    x = R.gen()
    for n, f in [('(x+1)/x^2', lambda: (x + 1)/x^2), ('1/((x+1)^2*x)', lambda: 1/((x + 1)^2*x)), ('(x^2+3)/(x+1)^3', lambda: (x^2 + 3)/(x + 1)^3), ('1/(x^2+1)^2', lambda: 1/(x^2 + 1)^2),
                 ('(x^3+x+1)/((x^2+1)^2*(x-1))', lambda: (x^3 + x + 1)/((x^2 + 1)^2*(x - 1))), ('x/(-x-1)', lambda: x/(-x - 1)), ('1/(-x^2+1)', lambda: 1/(-x^2 + 1)), ('x^4/(x^2-1)', lambda: x^4/(x^2 - 1)),
                 ('1/(x^2-x)', lambda: 1/(x^2 - x)), ('1/(x^2+3x+2)', lambda: 1/(x^2 + 3*x + 2)), ('1/(-x)', lambda: 1/(-x)), ('2/(-x^2-x)', lambda: 2/(-x^2 - x)), ('2/(x^2-1)', lambda: 2/(x^2 - 1)),
                 ('1/(2x)', lambda: 1/(2*x)), ('x^2/(x+1)', lambda: x^2/(x + 1)), ('3/(x^3-x)', lambda: 3/(x^3 - x)), ('(x^2+1)/x^2', lambda: (x^2 + 1)/x^2), ('5', lambda: R(5)/R(1))]:
        show(n, lambda: f().partial_fraction_decomposition())
