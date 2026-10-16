# Empty matrices keep their shape (astra's SAGE-940-2) and rref works over
# the fraction field (SAGE-940-3)
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__, str(e)[:150])
def D(M):
    return (M.dimensions(), M.base_ring(), M.list())
for R in (ZZ, QQ):
    A = matrix(R, 0, 3, [])
    T('%s 0x3' % R, lambda: (D(A), D(A.rref()), D(A.echelon_form())))
    B = matrix(R, 3, 0, [])
    T('%s 3x0' % R, lambda: (D(B.rref()), D(B.echelon_form())))
    for M in (matrix(R, 1, 1, [3]), identity_matrix(R, 2), matrix(R, [[1, 2], [2, 4]])):
        T('%s kernels %s' % (R, M.list()), lambda: [D(K.basis_matrix()) for K in (M.right_kernel(), M.kernel(), M.left_kernel())])
        T('%s kernel rref %s' % (R, M.list()), lambda: [D(K.basis_matrix().rref()) for K in (M.right_kernel(), M.kernel())])
    T('%s change_ring' % R, lambda: (D(A.change_ring(QQ)), D(A.change_ring(RDF))))
    T('%s solve_right' % R, lambda: D(matrix(R, 2, 0, []).solve_right(matrix(R, 2, 3, [0] * 6))))
for M in (matrix(ZZ, 1, 1, [2]), matrix(ZZ, [[2, 4], [3, 5]]), matrix(ZZ, [[2, 4, 6], [4, 8, 12]]), matrix(ZZ, [[0, 6, 3], [4, 2, 0]])):
    T('ZZ rref %s' % M.list(), lambda: (D(M.rref()), D(M.echelon_form())))
T('QQ rref', lambda: D(matrix(QQ, [[2, 4], [1, 3]]).rref()))
T('change_ring GF', lambda: D(matrix(ZZ, 0, 3, []).change_ring(GF(5))))
T('hermite', lambda: D(matrix(ZZ, 0, 3, []).hermite_form()))
T('smith', lambda: [D(X) for X in matrix(ZZ, 0, 3, []).smith_form()])
T('LLL', lambda: D(matrix(ZZ, 0, 3, []).LLL()))
T('block', lambda: D(block_matrix(ZZ, [[matrix(ZZ, 0, 2, []), matrix(ZZ, 0, 1, [])]])))
T('random', lambda: random_matrix(ZZ, 0, 3).dimensions())
T('transpose', lambda: (D(matrix(QQ, 0, 3, []).transpose()), D(matrix(QQ, 3, 0, []).transpose())))
