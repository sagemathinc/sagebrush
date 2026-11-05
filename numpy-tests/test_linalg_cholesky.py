# numpy.linalg.cholesky reads the triangle it is asked for: upper=True the upper one (LAPACK uplo='U'), the
# lower triangle unread, so a matrix whose upper triangle is positive definite and whose lower part is garbage
# factors with upper=True and is refused without it, and the other way round. Sizes on both sides of
# engine/nd's crossover (n >= 48), stacks, a non-contiguous input, and the input left unchanged. Then: an
# array of fewer than 2 dimensions refused by every square-matrix function with NumPy's LinAlgError.
import numpy as np

L = np.linalg


def spd(n, seed):
    rng = np.random.default_rng(seed)
    B = rng.standard_normal((n, n))
    return B @ B.T + n * np.eye(n)


def show(tag, f, A):
    # (A: the symmetric matrix the factor should reproduce. Printed: the shape, whether the factor is triangular
    # on the side asked for, whether it reproduces A, and its values to 10 decimals for small n)
    try:
        R = f()
    except Exception as e:
        print(tag, "->", type(e).__name__, str(e)[:80])
        return
    upper = "upper=True" in tag
    tri = bool(np.all(np.tril(R, -1) == 0)) if upper else bool(np.all(np.triu(R, 1) == 0))
    back = np.swapaxes(R, -1, -2) @ R if upper else R @ np.swapaxes(R, -1, -2)
    print(tag, "->", R.shape, R.dtype, "triangular", tri, "reproduces", bool(np.allclose(back, A, rtol=1e-12, atol=1e-12)),
          np.round(R, 10).tolist() if R.size <= 16 else "")


for n in (2, 4, 33, 47, 48, 64):
    A = spd(n, n)
    G = np.triu(A) + np.tril(np.full((n, n), -7.0), -1)   # upper triangle positive definite, garbage below
    W = np.tril(A) + np.triu(np.full((n, n), -7.0), 1)    # lower triangle positive definite, garbage above
    G0, W0 = G.copy(), W.copy()
    show("n=%d upper=True, upper PD, lower garbage" % n, lambda: L.cholesky(G, upper=True), A)
    show("n=%d upper=False, upper PD, lower garbage" % n, lambda: L.cholesky(G), A)
    show("n=%d upper=True, lower PD, upper garbage" % n, lambda: L.cholesky(W, upper=True), A)
    show("n=%d upper=False, lower PD, upper garbage" % n, lambda: L.cholesky(W), A)
    show("n=%d symmetric upper=True" % n, lambda: L.cholesky(A, upper=True), A)
    show("n=%d symmetric upper=False" % n, lambda: L.cholesky(A), A)
    show("n=%d upper=True of a transposed (non-contiguous) view" % n, lambda: L.cholesky(W.T, upper=True), A)
    print("n=%d inputs unchanged" % n, bool(np.array_equal(G, G0)), bool(np.array_equal(W, W0)))
    # (upper=True of a symmetric matrix is the transpose of its lower factor, to rounding)
    print("n=%d symmetric: upper = lower.T" % n, bool(np.allclose(L.cholesky(A, upper=True), L.cholesky(A).T, rtol=1e-12, atol=1e-12)))

S = np.stack([spd(3, 1), spd(3, 2)])
Sg = np.triu(S) + np.tril(np.full((2, 3, 3), 5.0), -1)
show("stack (2,3,3) upper=True, upper PD", lambda: L.cholesky(Sg, upper=True), S)
show("stack (2,3,3) upper=False, upper PD", lambda: L.cholesky(Sg), S)
S4 = np.stack([np.stack([spd(4, 10 * i + j) for j in range(2)]) for i in range(2)])
S4g = np.tril(S4) + np.triu(np.full((2, 2, 4, 4), -3.0), 1)
show("stack (2,2,4,4) upper=True, lower PD", lambda: L.cholesky(S4g, upper=True), S4)
show("stack (2,2,4,4) upper=False, lower PD", lambda: L.cholesky(S4g), S4)
show("int input upper=True", lambda: L.cholesky(np.array([[4, 2], [9, 3]]), upper=True), np.array([[4.0, 2.0], [2.0, 3.0]]))
show("list input upper=True", lambda: L.cholesky([[4.0, 2.0], [-1.0, 3.0]], upper=True), np.array([[4.0, 2.0], [2.0, 3.0]]))
show("not PD upper=True", lambda: L.cholesky(np.array([[1.0, 2.0], [0.0, 1.0]]), upper=True), np.eye(2))

fs = [("det", lambda a: L.det(a)), ("slogdet", lambda a: L.slogdet(a)), ("solve", lambda a: L.solve(a, np.ones(2))),
      ("inv", lambda a: L.inv(a)), ("matrix_power", lambda a: L.matrix_power(a, 2)), ("cholesky", lambda a: L.cholesky(a)),
      ("cholesky upper", lambda a: L.cholesky(a, upper=True)), ("eig", lambda a: L.eig(a)), ("eigvals", lambda a: L.eigvals(a)),
      ("eigh", lambda a: L.eigh(a)), ("eigvalsh", lambda a: L.eigvalsh(a))]
for name, f in fs:
    for a in (np.array([4.0, 1.0]), np.array(4.0), np.zeros((2, 3)), [3.0]):
        try:
            f(a)
            print(name, np.ndim(a), "-> ok")
        except Exception as e:
            print(name, np.ndim(a), np.shape(a), "->", type(e).__name__, str(e)[:80])
