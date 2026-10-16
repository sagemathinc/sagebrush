# Generated from ../test_kronecker.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_2 = Integer(2); _sage_const_7 = Integer(7); _sage_const_1 = Integer(1); _sage_const_3 = Integer(3); _sage_const_8 = Integer(8); _sage_const_6 = Integer(6); _sage_const_4 = Integer(4); _sage_const_0 = Integer(0); _sage_const_5 = Integer(5); _sage_const_12 = Integer(12); _sage_const_100 = Integer(100); _sage_const_10 = Integer(10); _sage_const_30 = Integer(30); _sage_const_41 = Integer(41); _sage_const_25 = Integer(25); _sage_const_26 = Integer(26); _sage_const_64 = Integer(64); _sage_const_11 = Integer(11); _sage_const_14 = Integer(14); _sage_const_9 = Integer(9); _sage_const_15 = Integer(15); _sage_const_21 = Integer(21); _sage_const_20 = Integer(20)# Kronecker, Legendre and Jacobi symbols (Integer.kronecker returned None)
print(ZZ(_sage_const_2 ).kronecker(_sage_const_7 ), ZZ(-_sage_const_1 ).kronecker(-_sage_const_1 ), ZZ(_sage_const_3 ).kronecker(-_sage_const_8 ), ZZ(_sage_const_6 ).kronecker(_sage_const_4 ))
print([kronecker_symbol(a, _sage_const_0 ) for a in (-_sage_const_1 , _sage_const_0 , _sage_const_1 , _sage_const_5 )], [kronecker(a, _sage_const_2 ) for a in range(-_sage_const_4 , _sage_const_5 )])
print([kronecker_symbol(a, -_sage_const_12 ) for a in range(-_sage_const_6 , _sage_const_7 )])
print(kronecker_symbol(_sage_const_2 , _sage_const_3 **_sage_const_100  + _sage_const_2 ), kronecker(_sage_const_10 **_sage_const_30  + _sage_const_7 , -(_sage_const_3 **_sage_const_41 )), kronecker(_sage_const_3 /_sage_const_1 , _sage_const_5 ))
print(type(kronecker(_sage_const_2 , _sage_const_7 )) == type(ZZ(_sage_const_1 )))
vals = list(range(-_sage_const_25 , _sage_const_26 )) + [_sage_const_2 **_sage_const_64  + _sage_const_1 , -(_sage_const_3 **_sage_const_41 )]
print(sum(kronecker_symbol(a, n) * (i + _sage_const_1 ) for i, (a, n) in enumerate((a, n) for a in vals for n in vals)))
print([legendre_symbol(a, _sage_const_11 ) for a in range(_sage_const_11 )], legendre_symbol(_sage_const_14 , _sage_const_7 ), legendre_symbol(-_sage_const_1 , _sage_const_10 **_sage_const_9  + _sage_const_7 ))
print([jacobi_symbol(a, _sage_const_15 ) for a in range(_sage_const_15 )], jacobi_symbol(_sage_const_5 , -_sage_const_21 ), jacobi_symbol(_sage_const_0 , _sage_const_1 ))
for f, args in [(legendre_symbol, (_sage_const_2 , _sage_const_9 )), (legendre_symbol, (_sage_const_3 , _sage_const_2 )), (legendre_symbol, (-_sage_const_1 , -_sage_const_7 )), (jacobi_symbol, (_sage_const_5 , _sage_const_20 ))]:
    try:
        f(*args)
    except ValueError as e:
        print("ValueError:", e)