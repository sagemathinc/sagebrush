# Expected output (test_hermite_cyclic.out): SageMath version 10.10, Release Date: 2026-09-28.
# Hermite forms over ZZ of square nonsingular matrices from size 60 up,
# where the form [[I, h], [0, d]] is computed from a solve: random matrices
# (of that form or not), U H with U unimodular and d with many small prime
# factors, and U D with Z^n / L not cyclic.  The matrices come from a fixed
# generator, so Sage and this program build the same ones.
state = [12345]
def rnd(k):
    state[0] = (state[0] * 6364136223846793005 + 1442695040888963407) % 2^64
    return (state[0] >> 33) % k

def fingerprint(H):
    v = H.list()
    return (H.nrows(), H.det(), sum(v), sum(i * x for i, x in enumerate(v)))

def unimodular_times(H, n):
    M = [list(r) for r in H.rows()]
    for _ in range(4 * n):
        i, j = rnd(n), rnd(n)
        if i != j:
            k = rnd(5) - 2
            M[i] = [x + k * y for x, y in zip(M[i], M[j])]
    return matrix(ZZ, M)

for n, r in [(60, 3), (60, 201), (64, 21), (70, 3), (80, 201)]:
    A = matrix(ZZ, n, n, [rnd(r) - r // 2 for _ in range(n * n)])
    H = A.echelon_form()
    print("random", n, r, all(H[i, i] == 1 for i in range(n - 1)), fingerprint(H))

for n, d in [(60, 2 * 3 * 5 * 7 * 11 * 13), (66, 2^12), (72, 30030 * 17 * 19), (61, 1)]:
    H = identity_matrix(ZZ, n)
    for i in range(n - 1):
        H[i, n - 1] = rnd(d)
    H[n - 1, n - 1] = d
    A = unimodular_times(H, n)
    E = A.echelon_form()
    print("cyclic", n, d, E == H, fingerprint(E))

for n in [60, 65]:
    D = identity_matrix(ZZ, n)
    D[n - 2, n - 2] = 6
    D[n - 1, n - 1] = 6 * 35
    D[n - 3, n - 1] = 17
    A = unimodular_times(D, n)
    E = A.echelon_form()
    print("not cyclic", n, E[n - 2, n - 2], E[n - 1, n - 1], fingerprint(E))
    print(A.hermite_form() == E)
