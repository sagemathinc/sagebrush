# Generated from ../test_characters.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_1 = Integer(1); _sage_const_61 = Integer(61); _sage_const_12 = Integer(12); _sage_const_7 = Integer(7); _sage_const_2 = Integer(2); _sage_const_3 = Integer(3); _sage_const_13 = Integer(13); _sage_const_15 = Integer(15); _sage_const_20 = Integer(20); _sage_const_21 = Integer(21); _sage_const_28 = Integer(28); _sage_const_29 = Integer(29); _sage_const_31 = Integer(31); _sage_const_9 = Integer(9); _sage_const_4 = Integer(4); _sage_const_16 = Integer(16); _sage_const_0 = Integer(0)# Dirichlet groups and characters, and modular symbols with a character
for N in range(_sage_const_1 , _sage_const_61 ):
    G = DirichletGroup(N)
    print(G)
    print(G.gens(), len(G))
    for chi in G:
        print(chi.order(), chi.conductor(), chi.is_even(), [chi(a) for a in range(min(N, _sage_const_12 ))])
seen = set()
for N, k in [(_sage_const_7 , _sage_const_2 ), (_sage_const_7 , _sage_const_3 ), (_sage_const_13 , _sage_const_2 ), (_sage_const_15 , _sage_const_2 ), (_sage_const_20 , _sage_const_3 ), (_sage_const_21 , _sage_const_2 ), (_sage_const_28 , _sage_const_2 ), (_sage_const_29 , _sage_const_2 ), (_sage_const_31 , _sage_const_2 ), (_sage_const_13 , _sage_const_3 ), (_sage_const_9 , _sage_const_4 ), (_sage_const_16 , _sage_const_2 )]:
    G = DirichletGroup(N)
    for chi in G:
        m = chi.order()
        key = (N, k, tuple(sorted(str((chi ** a)) for a in range(_sage_const_1 , m + _sage_const_1 ) if gcd(a, m) == _sage_const_1 )))
        if key in seen or chi.is_even() != (k % _sage_const_2  == _sage_const_0 ) or m == _sage_const_1 :
            continue
        seen.add(key)
        M = ModularSymbols(chi, k, sign=_sage_const_1 )
        print(M)
        print(M.hecke_polynomial(next_prime(N)))
        print(CuspForms(chi, k))