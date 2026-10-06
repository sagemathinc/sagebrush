# Generated from ../test_poly.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_1 = Integer(1); _sage_const_2 = Integer(2); _sage_const_3 = Integer(3); _sage_const_4 = Integer(4); _sage_const_12 = Integer(12); _sage_const_6 = Integer(6); _sage_const_5 = Integer(5); _sage_const_7 = Integer(7); _sage_const_60 = Integer(60); _sage_const_90 = Integer(90); _sage_const_360 = Integer(360); _sage_const_389 = Integer(389); _sage_const_15 = Integer(15); _sage_const_30 = Integer(30); _sage_const_36 = Integer(36); _sage_const_105 = Integer(105); _sage_const_16 = Integer(16); _sage_const_10 = Integer(10); _sage_const_8 = Integer(8); _sage_const_40 = Integer(40); _sage_const_352 = Integer(352); _sage_const_960 = Integer(960); _sage_const_576 = Integer(576); _sage_const_12345 = Integer(12345); _sage_const_1103515245 = Integer(1103515245); _sage_const_31 = Integer(31); _sage_const_21 = Integer(21); _sage_const_37 = Integer(37); _sage_const_67 = Integer(67)
R = ZZ['x']; (x,) = R._first_ngens(1)
S = PolynomialRing(QQ, names=('y',)); (y,) = S._first_ngens(1)
print(R, S, R.gen(), parent(x))
f = (x-_sage_const_1 )**_sage_const_2 *(_sage_const_2 *x+_sage_const_3 )*(x**_sage_const_2 +_sage_const_1 )
print(f, f.roots(), f.roots(multiplicities=False), f.degree(), f.list(), f.coefficients())
g = (_sage_const_2 *y**_sage_const_2  - _sage_const_2 )*(_sage_const_3 *y+_sage_const_1 )
print(g.factor(), g.roots(), (y**_sage_const_2 /_sage_const_2  + _sage_const_1 /_sage_const_3 ), (y**_sage_const_2 /_sage_const_2 +_sage_const_1 /_sage_const_3 ).factor())
print((x**_sage_const_4 -_sage_const_1 ).factor().unit(), list((x**_sage_const_4 -_sage_const_1 ).factor()), len((_sage_const_12 *x+_sage_const_12 ).factor()))
print(f.discriminant(), (x**_sage_const_3 -_sage_const_2 ).discriminant(), (x**_sage_const_2 +_sage_const_1 ).resultant(x**_sage_const_2 -_sage_const_1 ), gcd(x**_sage_const_4 -_sage_const_1 , x**_sage_const_6 -_sage_const_1 ), f.derivative(), f(_sage_const_2 ), f(x+_sage_const_1 ))
print((x**_sage_const_2 -_sage_const_1 ) // (x-_sage_const_1 ), (x**_sage_const_3 +_sage_const_1 ) % (x-_sage_const_1 ), (x**_sage_const_2 -_sage_const_1 )/(x-_sage_const_1 ))
print(x.is_irreducible(), (x**_sage_const_2 +_sage_const_1 ).is_irreducible(), (x**_sage_const_2 -_sage_const_1 ).is_irreducible())
print(ZZ, QQ, ZZ['t'], QQ['z'])
for h in [x**_sage_const_3  - x**_sage_const_2  - _sage_const_6 *x, (x-_sage_const_3 )*(x+_sage_const_2 )*(x-_sage_const_5 )*(x+_sage_const_7 ), (x**_sage_const_2 +_sage_const_1 )*(x**_sage_const_2 -_sage_const_2 )*(x**_sage_const_2 +_sage_const_3 *x+_sage_const_1 )*(x-_sage_const_1 )*(x+_sage_const_1 ), _sage_const_12 *(x+_sage_const_1 )*(x-_sage_const_1 )**_sage_const_2 , -(x**_sage_const_2 -_sage_const_1 ), (_sage_const_3 *x+_sage_const_1 )*(_sage_const_2 *x-_sage_const_1 )*(x+_sage_const_5 ), (x-_sage_const_1 )**_sage_const_3 *(x+_sage_const_1 )**_sage_const_2 *(x+_sage_const_5 ), _sage_const_60 *(x+_sage_const_1 ), _sage_const_90 *x, -_sage_const_6 *(x+_sage_const_1 ), _sage_const_360 *(x**_sage_const_2 +_sage_const_1 )**_sage_const_2 *(x-_sage_const_1 ), _sage_const_4 *x, R(_sage_const_12 ), R(-_sage_const_1 ), -x, _sage_const_7 *(x+_sage_const_1 )**_sage_const_2 *(x-_sage_const_1 )**_sage_const_2 ]:
    print(h.factor())
print(ModularSymbols(_sage_const_389 ,_sage_const_2 ,sign=_sage_const_1 ).hecke_polynomial(_sage_const_2 ).factor())
print(factor(x**_sage_const_6  - _sage_const_1 ), ZZ(_sage_const_5 ), QQ(_sage_const_3 ))

# cyclotomic and classical hard cases
for n in [_sage_const_12 , _sage_const_15 , _sage_const_30 , _sage_const_36 , _sage_const_60 , _sage_const_105 ]:
    print(n, (x**n - _sage_const_1 ).factor())
print((x**_sage_const_16  + _sage_const_1 ).factor(), (x**_sage_const_4  - _sage_const_10 *x**_sage_const_2  + _sage_const_1 ).factor(), (x**_sage_const_8  - _sage_const_40 *x**_sage_const_6  + _sage_const_352 *x**_sage_const_4  - _sage_const_960 *x**_sage_const_2  + _sage_const_576 ).factor())

# deterministic pseudo-random products (a small LCG, so Sage and sagebrush agree)
seed = _sage_const_12345 
def rnd(m):
    global seed
    seed = (_sage_const_1103515245 *seed + _sage_const_12345 ) % _sage_const_2 **_sage_const_31 
    return seed % m
for trial in range(_sage_const_60 ):
    f = R(_sage_const_1 )
    for j in range(_sage_const_1  + rnd(_sage_const_4 )):
        d = _sage_const_1  + rnd(_sage_const_5 )
        g = R([rnd(_sage_const_21 ) - _sage_const_10  for i in range(d)] + [_sage_const_1  + rnd(_sage_const_3 )])
        f *= g**(_sage_const_1  + rnd(_sage_const_2 ))
    F = f.factor()
    print(F, F.value() == f, [r for r in f.roots()])

# over QQ
for h in [(y**_sage_const_2  - _sage_const_1 /_sage_const_4 )*(_sage_const_2 *y + _sage_const_1 /_sage_const_3 ), y**_sage_const_3 /_sage_const_7  - _sage_const_1 , _sage_const_3 *(y - _sage_const_1 /_sage_const_2 )**_sage_const_2 *(y**_sage_const_2  + _sage_const_2 )]:
    print(h.factor(), h.roots(), h.monic())

# Hecke polynomials
for N in [_sage_const_37 , _sage_const_67 , _sage_const_389 ]:
    print(N, ModularSymbols(N, _sage_const_2 , sign=_sage_const_1 ).hecke_polynomial(_sage_const_2 ).factor())