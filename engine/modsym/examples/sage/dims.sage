# Reference dimensions of S_k(N, eps) and E_k(N, eps) (Sage's formulas) for
# Galois-orbit representatives of characters; one JSON object per line.
import json, sys
out = open(sys.argv[1], 'w')
for N in range(1, 151):
    G = DirichletGroup(N)
    e = G.zeta_order(); z = G.zeta(); logs = {z**i: i for i in range(e)}
    for chi in G.galois_orbits():
        eps = chi[0]
        exps = [int(logs[eps(m)]) if gcd(m, N) == 1 else None for m in range(N)]
        for k in range(2, 13):
            if (eps(-1) == 1) != (k % 2 == 0) or N * k > 1200:
                continue
            out.write(json.dumps(dict(N=int(N), k=int(k), e=int(e), exps=exps, conductor=int(eps.conductor()),
                cusp=int(CuspForms(eps, k).dimension()), eis=int(EisensteinForms(eps, k).dimension()))) + '\n')
