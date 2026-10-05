# Dimensions and Hecke polynomials over Gamma_0(N), any weight and sign
for N in range(1, 80):
    for k in (2, 4):
        G = Gamma0(N)
        print(N, k, G.dimension_cusp_forms(k), G.dimension_eis(k), G.dimension_modular_forms(k), G.dimension_new_cusp_forms(k))
for N in [11, 23, 37, 43, 53, 61, 67, 79, 89, 97, 101, 125, 128, 143, 169, 210, 389]:
    q = 2 if N % 2 else 3
    for sign in (1, 0, -1):
        M = ModularSymbols(N, 2, sign=sign)
        print(M)
        print(M.hecke_polynomial(q))
    print(ModularSymbols(N, 2, sign=1).T(5).charpoly('t'))
for N, k in [(11, 4), (13, 6), (7, 8), (15, 4), (23, 4), (1, 12), (1, 24), (2, 8), (3, 10), (5, 6)]:
    M = ModularSymbols(N, k, sign=1)
    print(M)
    print(M.hecke_polynomial(next_prime(N)))
    print(M.hecke_polynomial(2))
print(ModularSymbols(Gamma0(11), 2).hecke_polynomial(11))
print(ModularSymbols(Gamma0(37), 2, sign=1).T(37).charpoly())
print(CuspForms(389, 2), CuspForms(11, 2).new_subspace(), ModularForms(1, 12))
