# Dirichlet groups and characters, and modular symbols with a character
for N in range(1, 61):
    G = DirichletGroup(N)
    print(G)
    print(G.gens(), len(G))
    for chi in G:
        print(chi.order(), chi.conductor(), chi.is_even(), [chi(a) for a in range(min(N, 12))])
seen = set()
for N, k in [(7, 2), (7, 3), (13, 2), (15, 2), (20, 3), (21, 2), (28, 2), (29, 2), (31, 2), (13, 3), (9, 4), (16, 2)]:
    G = DirichletGroup(N)
    for chi in G:
        m = chi.order()
        key = (N, k, tuple(sorted(str((chi ** a)) for a in range(1, m + 1) if gcd(a, m) == 1)))
        if key in seen or chi.is_even() != (k % 2 == 0) or m == 1:
            continue
        seen.add(key)
        M = ModularSymbols(chi, k, sign=1)
        print(M)
        print(M.hecke_polynomial(next_prime(N)))
        print(CuspForms(chi, k))
