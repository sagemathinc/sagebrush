# Exact reference charpolys for general_exact.rs: coefficients of T_q's
# charpoly on ModularSymbols(eps, k, sign) in the power basis of
# CyclotomicField(ord eps) (QQ for ord <= 2), plus Sage's time.
import json, time, sys
out = open(sys.argv[1], 'w')
def record(N, k, sign, eps, G, q):
    e = G.zeta_order(); z = G.zeta(); logs = {z**i: i for i in range(e)}
    exps = [int(logs[eps(m)]) if gcd(m, N) == 1 else None for m in range(N)]
    o = eps.order()
    K2 = CyclotomicField(o) if o > 2 else QQ
    t = time.time()
    M = ModularSymbols(eps, k, sign)
    f = M.hecke_matrix(q).charpoly()
    secs = time.time() - t
    coeffs = []
    for c in f.list():
        c = K2(c)
        coeffs.append([str(x) for x in (c.list() if o > 2 else [c])])
    out.write(json.dumps(dict(N=int(N), k=int(k), sign=int(sign), e=int(e), exps=exps, q=int(q), order=int(o), dim=int(M.dimension()), coeffs=coeffs, sage_seconds=secs)) + '\n')
    out.flush()
if sys.argv[2] == 'grid':
    for N in range(1, 31):
        G = DirichletGroup(N)
        for chi in G.galois_orbits():
            eps = chi[0]
            for k in range(2, 7):
                if (eps(-1) == 1) != (k % 2 == 0) or N * k > 120:
                    continue
                for sign in [1, -1, 0]:
                    for q in [2, 3]:
                        record(N, k, sign, eps, G, q)
else:
    def chi_of(N, order, k):
        G = DirichletGroup(N)
        for c in G.galois_orbits():
            if c[0].order() == order and c[0](-1) == (-1)**k:
                return G, c[0]
    for N, k, sign, order, q in [(1, 24, 1, 1, 2), (50, 12, 1, 1, 3), (91, 2, 0, 6, 2), (200, 4, 1, 2, 3), (131, 3, 1, 2, 2), (61, 6, 0, 10, 2), (151, 2, 1, 15, 2), (105, 2, 1, 12, 2), (37, 10, 1, 9, 2)]:
        G, eps = chi_of(N, order, k)
        record(N, k, sign, eps, G, q)
