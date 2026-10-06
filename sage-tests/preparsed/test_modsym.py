# Generated from ../test_modsym.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_1 = Integer(1); _sage_const_80 = Integer(80); _sage_const_2 = Integer(2); _sage_const_4 = Integer(4); _sage_const_11 = Integer(11); _sage_const_23 = Integer(23); _sage_const_37 = Integer(37); _sage_const_43 = Integer(43); _sage_const_53 = Integer(53); _sage_const_61 = Integer(61); _sage_const_67 = Integer(67); _sage_const_79 = Integer(79); _sage_const_89 = Integer(89); _sage_const_97 = Integer(97); _sage_const_101 = Integer(101); _sage_const_125 = Integer(125); _sage_const_128 = Integer(128); _sage_const_143 = Integer(143); _sage_const_169 = Integer(169); _sage_const_210 = Integer(210); _sage_const_389 = Integer(389); _sage_const_3 = Integer(3); _sage_const_0 = Integer(0); _sage_const_5 = Integer(5); _sage_const_13 = Integer(13); _sage_const_6 = Integer(6); _sage_const_7 = Integer(7); _sage_const_8 = Integer(8); _sage_const_15 = Integer(15); _sage_const_12 = Integer(12); _sage_const_24 = Integer(24); _sage_const_10 = Integer(10)# Dimensions and Hecke polynomials over Gamma_0(N), any weight and sign
for N in range(_sage_const_1 , _sage_const_80 ):
    for k in (_sage_const_2 , _sage_const_4 ):
        G = Gamma0(N)
        print(N, k, G.dimension_cusp_forms(k), G.dimension_eis(k), G.dimension_modular_forms(k), G.dimension_new_cusp_forms(k))
for N in [_sage_const_11 , _sage_const_23 , _sage_const_37 , _sage_const_43 , _sage_const_53 , _sage_const_61 , _sage_const_67 , _sage_const_79 , _sage_const_89 , _sage_const_97 , _sage_const_101 , _sage_const_125 , _sage_const_128 , _sage_const_143 , _sage_const_169 , _sage_const_210 , _sage_const_389 ]:
    q = _sage_const_2  if N % _sage_const_2  else _sage_const_3 
    for sign in (_sage_const_1 , _sage_const_0 , -_sage_const_1 ):
        M = ModularSymbols(N, _sage_const_2 , sign=sign)
        print(M)
        print(M.hecke_polynomial(q))
    print(ModularSymbols(N, _sage_const_2 , sign=_sage_const_1 ).T(_sage_const_5 ).charpoly('t'))
for N, k in [(_sage_const_11 , _sage_const_4 ), (_sage_const_13 , _sage_const_6 ), (_sage_const_7 , _sage_const_8 ), (_sage_const_15 , _sage_const_4 ), (_sage_const_23 , _sage_const_4 ), (_sage_const_1 , _sage_const_12 ), (_sage_const_1 , _sage_const_24 ), (_sage_const_2 , _sage_const_8 ), (_sage_const_3 , _sage_const_10 ), (_sage_const_5 , _sage_const_6 )]:
    M = ModularSymbols(N, k, sign=_sage_const_1 )
    print(M)
    print(M.hecke_polynomial(next_prime(N)))
    print(M.hecke_polynomial(_sage_const_2 ))
print(ModularSymbols(Gamma0(_sage_const_11 ), _sage_const_2 ).hecke_polynomial(_sage_const_11 ))
print(ModularSymbols(Gamma0(_sage_const_37 ), _sage_const_2 , sign=_sage_const_1 ).T(_sage_const_37 ).charpoly())
print(CuspForms(_sage_const_389 , _sage_const_2 ), CuspForms(_sage_const_11 , _sage_const_2 ).new_subspace(), ModularForms(_sage_const_1 , _sage_const_12 ))