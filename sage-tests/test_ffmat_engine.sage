# Linear algebra over prime fields (echelon forms, ranks, pivots,
# determinants, inverses, solving, kernels and subspaces): computed by the
# engine for p < 2^63 when the eliminated matrix ([A | B] when solving,
# [A | I] when inverting) has at most 1024 rows and columns and 400 * 401
# entries, in Python otherwise (larger p, empty and larger shapes).

def mat(F, r, c, seed, rank=None):
    # deterministic entries; with rank, a product of r x rank and rank x c
    if rank is None:
        return matrix(F, r, c, [F((i + seed) ** (j + 2) + 3 * i * j) for i in range(r) for j in range(c)])
    L = matrix(F, r, rank, [F((i + seed) ** (j + 1) + i + 2 * j) for i in range(r) for j in range(rank)])
    U = matrix(F, rank, c, [F((i + 2 * seed) ** (j + 3) + i * j) for i in range(rank) for j in range(c)])
    return L * U

def digest(M):
    # (a checksum of a large matrix's entries)
    return sum((i + 1) * (j + 7) * ZZ(M[i, j]) for i in range(M.nrows()) for j in range(M.ncols()))

def show(label, f, message=True):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, e if message else "")

for p in [2, 3, 7, 65537, 2^31 - 1, 2^61 - 1, 2^63 - 25, 2^63 + 29]:
    F = GF(p)
    print("p =", p)
    for (r, c, k) in [(1, 1, None), (2, 2, None), (3, 3, 2), (3, 5, None), (5, 3, None), (4, 6, 2), (6, 6, 4)]:
        A = mat(F, r, c, 2, k)
        E = A.echelon_form()
        print(r, c, A.rank(), A.pivots(), E.parent())
        print(E)
        if r == c:
            print("det", A.det(), A.is_invertible())
            show("inverse", lambda: A.inverse(), False)
        print("right kernel", A.right_kernel())
        print("left kernel", A.kernel())
    # solving: vectors and matrices of right-hand sides, consistent or not
    A = mat(F, 4, 4, 5)
    if A.det():
        b = vector(F, [1, 2, 3, 4])
        x = A.solve_right(b)
        print("solve", x, A * x == b, A.solve_left(b) * A == b)
        B = mat(F, 4, 3, 9)
        X = A.solve_right(B)
        print(X, A * X == B)
    S = mat(F, 4, 4, 1, 2)
    show("singular solve", lambda: S.solve_right(vector(F, [1, 0, 0, 0])))
    show("singular inverse", lambda: S.inverse(), False)
    y = S.solve_right(S * vector(F, [1, 2, 3, 4]))
    print("free variables zero", y, S * y == S * vector(F, [1, 2, 3, 4]))
    # a matrix right-hand side with one inconsistent column (the second)
    B = matrix(F, 4, 2, [S[i, 0] + S[i, 1] if j == 0 else (1 if i == 0 else 0) for i in range(4) for j in range(2)])
    show("one bad column", lambda: S.solve_right(B))
    show("solve_left matrix", lambda: S.solve_left(matrix(F, 2, 4, list(S.row(0)) + list(S.row(1)))))
    # subspaces
    V = VectorSpace(F, 4)
    W = V.subspace([V(list(S.row(0))), V(list(S.row(1))), V(list(S.row(2)))])
    print(W)
    print(V(list(S.row(3))) in W, V([1, 0, 0, 1]) in W)
    # larger: through the engine (or Python for p > 2^63), compared by checksums
    for (r, c, k) in [(30, 30, None), (40, 25, 20), (25, 60, 25), (60, 60, 45)]:
        A = mat(F, r, c, 3, k)
        E = A.echelon_form()
        print(r, c, A.rank(), len(A.pivots()), digest(E), A.det() if r == c else "-")
    A = mat(F, 30, 30, 7)
    if A.det():
        Ai = A.inverse()
        b = vector(F, range(30))
        print("inverse", digest(Ai), Ai * A == 1, A.solve_right(b) == Ai * b)
        B = mat(F, 30, 5, 11)
        print("solve", digest(A.solve_right(B)))

# empty shapes stay in Python
F = GF(7)
for (r, c) in [(0, 0), (0, 3), (3, 0)]:
    A = matrix(F, r, c, [])
    print(r, c, A.rank(), A.pivots(), A.echelon_form().dimensions(), A.right_kernel().dimension(), A.kernel().dimension())
print(matrix(F, 0, 0, []).det(), matrix(F, 0, 0, []).inverse().dimensions())
show("non-square det", lambda: matrix(F, 2, 3, range(6)).det())
show("non-square inverse", lambda: matrix(F, 2, 3, range(6)).inverse(), False)
show("wrong size", lambda: matrix(F, 2, 2, [1, 2, 3, 4]).solve_right(vector(F, [1, 2, 3])))

# larger than the engine's limits (more than 1024 columns): Python
A = mat(GF(65537), 2, 1100, 4)
print(A.rank(), A.pivots(), digest(A.echelon_form()))
# at them: a 400 x 400 system with one right-hand side
A = mat(GF(2^61 - 1), 400, 400, 6)
b = vector(GF(2^61 - 1), range(400))
x = A.solve_right(b)
print(A.rank(), A * x == b, sum(ZZ(t) for t in x))
