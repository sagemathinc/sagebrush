# Generated from ../test_ff_rootssplit.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_0 = Integer(0); _sage_const_5 = Integer(5); _sage_const_2 = Integer(2); _sage_const_3 = Integer(3); _sage_const_1 = Integer(1); _sage_const_4 = Integer(4); _sage_const_25 = Integer(25); _sage_const_16 = Integer(16); _sage_const_8 = Integer(8); _sage_const_20 = Integer(20)# Splitting fields of polynomials over finite fields and the roots there
# (F3 of plan-finite-fields, Magma's RootsInSplittingField): splitting_field
# (with map=True) and roots(ring) in an overfield, by the shared core.
# Expected output from Sage 10.9.
def check(label, f):
    try:
        v = f()
        print(label, v)
    except Exception as e:
        print(label, "ERR", type(e).__name__, str(e).splitlines()[_sage_const_0 ])
R = GF(_sage_const_5 )['x']; (x,) = R._first_ngens(1)
f = x**_sage_const_2  + _sage_const_2 
check('sf', lambda: f.splitting_field('b'))
check('sf map', lambda: f.splitting_field('b', map=True))
K = f.splitting_field(names=('b',)); (b,) = K._first_ngens(1)
check('roots K', lambda: f.roots(K))
check('roots K nomult', lambda: f.roots(K, multiplicities=False))
check('sf cubic', lambda: (x**_sage_const_3  + x + _sage_const_1 ).splitting_field('c'))
check('sf mixed', lambda: ((x**_sage_const_2  + _sage_const_2 )*(x**_sage_const_3  + x + _sage_const_1 )).splitting_field('c'))
check('sf linear', lambda: (x - _sage_const_1 ).splitting_field('c'))
check('sf linear map', lambda: (x - _sage_const_1 ).splitting_field('c', map=True))
check('sf const', lambda: R(_sage_const_3 ).splitting_field('c'))
check('sf const map', lambda: R(_sage_const_3 ).splitting_field('c', map=True))
check('sf names tuple', lambda: (x**_sage_const_2  + _sage_const_2 ).splitting_field(('b',)))
L = ((x**_sage_const_2  + _sage_const_2 )*(x**_sage_const_3  + x + _sage_const_1 )).splitting_field(names=('c',)); (c,) = L._first_ngens(1)
check('roots mixed', lambda: ((x**_sage_const_2  + _sage_const_2 )*(x**_sage_const_3  + x + _sage_const_1 )).roots(L))
check('roots in GF(5^4)', lambda: (x**_sage_const_2  + _sage_const_2 ).roots(GF(_sage_const_5 **_sage_const_4 , 'e')))
check('roots none', lambda: (x**_sage_const_3  + x + _sage_const_1 ).roots(GF(_sage_const_25 , 'b')))
check('roots mixed 25', lambda: ((x**_sage_const_2 +_sage_const_2 )*(x**_sage_const_3 +x+_sage_const_1 )*(x-_sage_const_1 )).roots(GF(_sage_const_25 , 'b')))
check('roots zero', lambda: R(_sage_const_0 ).roots(GF(_sage_const_25 , 'b')))
check('roots const', lambda: R(_sage_const_3 ).roots(GF(_sage_const_25 , 'b')))
check('roots rep', lambda: ((x**_sage_const_2  + _sage_const_2 )**_sage_const_2 *(x - _sage_const_1 )).roots(GF(_sage_const_25 , 'b')))
check('roots mult=False', lambda: ((x**_sage_const_2 +_sage_const_2 )**_sage_const_2 ).roots(GF(_sage_const_25 ,'b'), multiplicities=False))
F4 = GF(_sage_const_4 , names=('a',)); (a,) = F4._first_ngens(1)
S = F4['t']; (t,) = S._first_ngens(1)
check('sf F4', lambda: (t**_sage_const_2  + t + a).splitting_field('d'))
check('sf F4 map', lambda: (t**_sage_const_2  + t + a).splitting_field('d', map=True))
check('roots F4 in GF16', lambda: (t**_sage_const_2  + t + a).roots(GF(_sage_const_16 , 'e')))
G4 = GF(_sage_const_4 )
P4 = G4['s']; (s,) = P4._first_ngens(1)
check('prefix roots', lambda: (s**_sage_const_2  + s + G4.gen()).roots(GF(_sage_const_16 )))
G2 = GF(_sage_const_2 )['y']; (y,) = G2._first_ngens(1)
check('roots GF2 in GF16', lambda: (y**_sage_const_4  + y + _sage_const_1 ).roots(GF(_sage_const_16 , 'g')))
check('roots GF2 in GF8', lambda: (y**_sage_const_4  + y + _sage_const_1 ).roots(GF(_sage_const_8 , 'h')))