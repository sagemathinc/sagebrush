# The oracle for nf/proof.rs (the unconditional certificate): Sage's
# K.class_group(proof=True) (PARI's bnfinit + bnfcertify) and K.regulator()
# on fields of degree 2 to 6 from random small polynomials (reduced by
# polredabs, distinct), with |d_K| below a bound per degree.  Sage is only an
# oracle; none of its code is used.
#   sage oracle/make_proof_fixture.sage > tests/proof_fixture.txt
# Each line: coefficients (constant first) | d_K | invariants | regulator
import random
random.seed(int(20261014))
R.<x> = QQ[]
PER_DEGREE = 60
# (degree, coefficient range, |d_K| limit)
SPECS = [(2, 0, 10**8), (3, 40, 10**9), (4, 12, 10**10), (5, 6, 10**11), (6, 4, 10**12)]
seen = set()
for (n, crange, dmax) in SPECS:
    count = 0
    tries = 0
    while count < PER_DEGREE and tries < 50 * PER_DEGREE:
        tries += 1
        if n == 2:
            # x^2 - d, d of every size up to dmax/4, both signs
            d = random.choice([1, -1]) * random.randint(2, int(10**random.uniform(1, 8)) // 4 + 2)
            f = x**2 - d
        else:
            f = x**n + sum(random.randint(-crange, crange) * x**i for i in range(n))
        if not f.is_irreducible():
            continue
        g = R(pari(f).polredabs())
        if g in seen:
            continue
        K.<a> = NumberField(g)
        D = K.discriminant()
        if abs(D) > dmax:
            continue
        seen.add(g)
        G = K.class_group(proof=True)
        reg = K.regulator()
        print(",".join(str(c) for c in g.list()), "|", D, "|", ",".join(str(c) for c in G.invariants()), "|", reg.str(digits=15), flush=True)
        count += 1
