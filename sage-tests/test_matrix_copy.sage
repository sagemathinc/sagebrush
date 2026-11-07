# copy(M) is a new mutable matrix, deepcopy keeps the immutability, and an
# exact matrix's eigenmatrix_right(B) / eigenvectors_right(B) (the
# generalized problem) is refused as Sage refuses it, not answered for A alone
from copy import copy, deepcopy
def show(label, f):
    try:
        print(label, '|', f())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:150]))
# the friction reproductions (W37)
M = matrix(QQ, [[0, 1], [1, 0]]); N = copy(M); N[0, 1] = 4
print(M[0, 1])
A = matrix(QQ, [[1, 0], [0, 2]]); B = 2*identity_matrix(QQ, 2)
try:
    D, P = A.eigenmatrix_right(B); print(A*P == B*P*D)
except Exception as e:
    print(type(e).__name__)
def copies(K):
    M = matrix(K, [[0, 1], [1, 0]]); N = copy(M); N[0, 1] = 4
    return M[0, 1], N[0, 1], N is M, M
def mut(K):
    M = matrix(K, [[0, 1], [1, 0]]); N = copy(M)
    return M.is_mutable(), N.is_mutable()
def imm(K):
    M = matrix(K, [[0, 1], [1, 0]]); M.set_immutable(); N = copy(M); N[0, 0] = 1
    return M[0, 0], N[0, 0], N.is_mutable(), M.is_mutable()
def deep(K):
    M = matrix(K, [[0, 1], [1, 0]]); D = deepcopy(M); D[1, 0] = 7
    return M[1, 0], D[1, 0]
def deepimm(K):
    M = matrix(K, [[0, 1], [1, 0]]); M.set_immutable(); D = deepcopy(M)
    return D.is_mutable(), D is M, D == M
def meth(K):
    M = matrix(K, [[0, 1], [1, 0]]); C = M.__copy__(); C[1, 1] = 3
    return M[1, 1], C[1, 1]
def subd(K):
    M = matrix(K, [[0, 1], [1, 0]]); M.subdivide(1, 1); N = copy(M); N.subdivide(); return M.subdivisions(), N.subdivisions()
def rowop(K):
    M = matrix(K, [[1, 2], [3, 4]]); N = copy(M); N[0, 0] = 9; N[1, 1] = N[0, 1] * 4
    return M, N
def hashes(K):
    M = matrix(K, [[1, 2], [3, 4]]); M.set_immutable(); N = copy(M); N.set_immutable(); return hash(M) == hash(N), N == M
for K in [QQ, ZZ, SR]:
    for n, f in [('copy', copies), ('mutable', mut), ('copy of immutable', imm), ('deepcopy', deep), ('deepcopy of immutable', deepimm), ('__copy__', meth), ('subdivisions', subd),
                 ('entries set on a copy', rowop), ('hashes', hashes)]:
        show(str(K) + ' ' + n, lambda: f(K))
for K in [RDF, CDF, GF(5), GF(4, 'a'), QQbar, QuadraticField(2, 'b'), Zmod(6)]:
    for n, f in [('copy', copies), ('deepcopy', deep), ('__copy__', meth)]:
        show(str(K) + ' ' + n, lambda: f(K))
for K in [QQ, ZZ, SR]:
    A = matrix(K, [[1, 0], [0, 2]]); B = 2*identity_matrix(K, 2)
    for n, f in [('eigenmatrix_right(B)', lambda: A.eigenmatrix_right(B)), ('eigenmatrix_left(B)', lambda: A.eigenmatrix_left(B)), ('eigenvectors_right(B)', lambda: A.eigenvectors_right(B)),
                 ('eigenvectors_left(B)', lambda: A.eigenvectors_left(B)), ('eigenmatrix_right(other=B)', lambda: A.eigenmatrix_right(other=B)), ('eigenvectors_left(other=B)', lambda: A.eigenvectors_left(other=B))]:
        show(str(K) + ' ' + n, f)
for K in [QQ, ZZ]:
    A = matrix(K, [[1, 0], [0, 2]])
    show(str(K) + ' eigenvalues(B) (B is extend)', lambda: A.eigenvalues(2*identity_matrix(K, 2)))
    show(str(K) + ' eigenmatrix_right(None)', lambda: A.eigenmatrix_right(None))
    show(str(K) + ' eigenmatrix_left(None)', lambda: A.eigenmatrix_left(None))
