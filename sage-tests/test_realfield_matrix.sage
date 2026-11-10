# Dense linear algebra over RealField(p), p > 53: inverse, det and solve_right, as Sage.  Sagebrush computes
# them in the multiprecision core (mpmath's LU); Sage by its own elimination, so the last bits differ (even an
# integral inverse: Sage's 64-bit one ends -65.0000000000000001).  So results are printed rounded (integers,
# 15 digits), parents and errors exactly, and each result is checked against the exact one (over QQ) within
# 2^(16 - p) relative.
def rq(x):
    return QQ(x)
def close(M, exact, p):
    # max |M - exact| <= 2^(16 - p) * max(1, max |exact|), entrywise over the rows
    m = max(max(abs(rq(a) - b) for a, b in zip(r, s)) for r, s in zip(M, exact))
    big = max(1, max(abs(b) for r in exact for b in r))
    return m <= 2^(16 - p) * big
def rows(M):
    return [list(r) for r in M.rows()]
def ints(M):
    return [[ZZ(x.round()) for x in r] for r in M.rows()]
def digits(v):
    return [x.n(digits=15) for x in v]
for p in [64, 100, 333, 1000]:
    R = RealField(p)
    # integer matrices: their determinants (exact here in both)
    A = matrix(R, [[2, 1, 0], [1, 3, 1], [0, 1, 4]])
    print(p, A.det(), parent(A.det()))
    print(matrix(R, [[1, 2], [3, 4]]).det())
    # a unimodular matrix: its inverse integral
    Uq = matrix(QQ, [[1, 2, 3], [0, 1, 4], [0, 0, 1]]) * matrix(QQ, [[1, 0, 0], [5, 1, 0], [6, 7, 1]])
    U = Uq.change_ring(R)
    print(ints(U.inverse()), close(rows(U.inverse()), rows(Uq.inverse()), p))
    print(parent(U.inverse()))
    # a Hilbert matrix: its inverse's integer entries
    Hq = matrix(QQ, 5, 5, lambda i, j: 1 / (i + j + 1))
    H = Hq.change_ring(R)
    print(ints(H.inverse()), close(rows(H.inverse()), rows(Hq.inverse()), p - 20))
    # solve_right: a vector, a matrix of right-hand sides (over QQ too)
    B = matrix(R, [[4, 1], [2, 3]])
    print(digits(B.solve_right(vector(R, [1, 2]))))
    X = B.solve_right(matrix(QQ, 2, 2, [1, 0, 0, 1]))
    print([digits(r) for r in X.rows()], parent(X))
    print(parent(B.solve_right(vector(R, [1, 2]))))
    # singular
    S = matrix(R, [[1, 2], [2, 4]])
    try:
        S.inverse()
    except ZeroDivisionError as e:
        print("ZeroDivisionError:", e)
    print(S.det())
    # random well-conditioned matrices against their exact inverse, determinant and solution
    set_random_seed(p)
    for n in [4, 9]:
        Q = random_matrix(QQ, n, num_bound=50, den_bound=50) + 100 * identity_matrix(QQ, n)
        M = Q.change_ring(R)
        b = vector(QQ, range(1, n + 1))
        x = M.solve_right(vector(R, list(b)))
        print(n, close(rows(M.inverse()), rows(Q.inverse()), p), abs(rq(M.det()) - Q.det()) <= 2^(16 - p) * abs(Q.det()),
              close([list(x)], [list(Q.solve_right(b))], p))
