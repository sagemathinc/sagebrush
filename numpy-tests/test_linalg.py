import numpy as np
np.random.seed(7)
def show(name, x, digits=10):
    x = np.asarray(x)
    # + 0.0 turns the -0.0 of rounding noise into 0.0
    print(name, x.shape, x.dtype.kind, (np.round(np.real(x), digits) + 0.0).tolist(), (np.round(np.imag(x), digits) + 0.0).tolist() if x.dtype.kind == "c" else "")
A = np.random.rand(5, 5)
b = np.random.rand(5)
S = A + A.T
show("det", np.linalg.det(A)); show("solve", np.linalg.solve(A, b)); show("inv", np.linalg.inv(A))
show("inv check", np.linalg.inv(A) @ A); show("slogdet", np.linalg.slogdet(A))
w, v = np.linalg.eigh(S)
show("eigh w", w); show("eigh recon", v @ np.diag(w) @ v.T - S); show("eigh orth", v.T @ v)
show("eigvalsh", np.linalg.eigvalsh(S))
w2 = np.linalg.eigvals(A)
show("eig sorted", np.sort_complex(w2) if hasattr(np, "sort_complex") else sorted(w2.tolist(), key=lambda z: (z.real, z.imag)))
w3, v3 = np.linalg.eig(A)
show("eig recon", A @ v3 - v3 * w3, 8)
show("eig norms", np.linalg.norm(v3, axis=0))
R = np.array([[0.0, -1], [1, 0]])
w4, v4 = np.linalg.eig(R)
show("rot eig", sorted(w4.tolist(), key=lambda z: z.imag)); show("rot recon", R @ v4 - v4 * w4)
u, s, vh = np.linalg.svd(np.random.rand(4, 3))
show("svd s", s); show("svd shapes", [u.shape, vh.shape])
M = np.random.rand(4, 3)
u, s, vh = np.linalg.svd(M, full_matrices=False)
show("svd recon", u @ np.diag(s) @ vh - M); show("svd uorth", u.T @ u)
u, s, vh = np.linalg.svd(np.random.rand(3, 5))
show("svd wide", s); show("svd wide shapes", [u.shape, vh.shape]); show("svd full orth", vh @ vh.T)
q, r = np.linalg.qr(M)
show("qr recon", q @ r - M); show("qr orth", q.T @ q); show("qr shapes", [q.shape, r.shape]); show("r lower zero", np.tril(r, -1))
P = S @ S.T + 5 * np.eye(5)
L = np.linalg.cholesky(P)
show("chol", L @ L.T - P); show("chol lower", np.triu(L, 1))
show("pinv", np.linalg.pinv(M) @ M); show("rank", np.linalg.matrix_rank(M)); show("rank1", np.linalg.matrix_rank(np.ones((3, 3))))
x, res, rank, sv = np.linalg.lstsq(np.random.rand(6, 2), np.random.rand(6), rcond=None)
show("lstsq", x); show("res", res); print("rank", rank); show("sv", sv)
for o in [None, 1, 2, np.inf, -np.inf, "fro", "nuc"]:
    show("norm %s" % o, np.linalg.norm(A, o))
for o in [None, 1, 2, np.inf, 0, 3]:
    show("vnorm %s" % o, np.linalg.norm(b, o))
show("cond", np.linalg.cond(A)); show("mpow", np.linalg.matrix_power(A, 3)); show("mpow0", np.linalg.matrix_power(A, 0))
show("stack det", np.linalg.det(np.stack([A, 2 * A]))); show("stack inv", np.linalg.inv(np.stack([A, A]))[1] @ A)
try:
    np.linalg.inv(np.ones((3, 3)))
except np.linalg.LinAlgError as err:
    print("LinAlgError:", err)
try:
    np.linalg.cholesky(-np.eye(2))
except np.linalg.LinAlgError as err:
    print("LinAlgError:", err)
