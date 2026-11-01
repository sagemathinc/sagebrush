# Matrices over SR (lane 4b): sagebrush-only checks of the guards (plan r3 R1/T5/T8, astra3's admission
# contract d07cd196).  No Sage counterpart: the .out is ours, each line a structural fact.  Spies make a
# helper that must not be reached raise; boundary pairs use stub matrices (only their shape), never a
# large allocation.  One statement per line; an error prints as its type (and which guard, where it matters).
import sys
# T8: ZZ/QQ matrix work leaves the SR module unloaded; the first SR operation loads it
A = matrix(ZZ, [[1, 2], [3, 4]]); A.det(), A.rank(), matrix(QQ, [[1, 2], [3, 5]]).inverse(), A.echelon_form()
print('_sage_matrix_sr' in sys.modules)
matrix(SR, [[x, 1], [1, x]]).rank()
print('_sage_matrix_sr' in sys.modules)
import _sage_matrix_sr as S
import _sage_matrix as M
CAP = M._MAX_ENTRIES
class Stub:
    def __init__(self, m, n):
        # (rows only for a small stub: a large one must be refused before its rows are read)
        self.m, self.n = m, n
        self._rows = [[0] * n for _ in range(m)] if m * n <= 64 else None
    def nrows(self):
        return self.m
    def ncols(self):
        return self.n
def which(f):
    try:
        f()
        return 'ok'
    except Exception as e:
        t = type(e).__name__
        s = str(e)
        return t + (' symbolic' if 'symbolic' in s else ' shape' if 'matrix' in s else ' other') if t == 'SagebrushMemoryError' else t
def spied(name, f):
    orig = getattr(S, name)
    def boom(*a, **k):
        raise RuntimeError('reached ' + name)
    setattr(S, name, boom)
    try:
        return which(f)
    finally:
        setattr(S, name, orig)
def limited(chars, f):
    orig = S._SR_MAX_CHARS
    S._SR_MAX_CHARS = chars
    try:
        return which(f)
    finally:
        S._SR_MAX_CHARS = orig
# _sr_guard on workspaces (n = max(rows, augmented width) <= 16): rank/rref admit 16, refuse 17; inverse admits 8, refuses 9
print(which(lambda: matrix(SR, 16, 16, lambda i, j: sqrt(2) if i == j else 0).rank()))
print(which(lambda: matrix(SR, 17, 17, lambda i, j: sqrt(2) if i == j else 0).rank()))
print(which(lambda: matrix(SR, 16, 16, lambda i, j: sqrt(2) if i == j else 0).rref().rank()))
print(which(lambda: matrix(SR, 8, 8, lambda i, j: sqrt(2) if i == j else 0).inverse()))
print(which(lambda: matrix(SR, 9, 9, lambda i, j: sqrt(2) if i == j else 0).inverse()))
print(spied('_identity_rows', lambda: matrix(SR, 9, 9, lambda i, j: sqrt(2) if i == j else 0).inverse()))
print(which(lambda: matrix(SR, 8, 8, lambda i, j: x if i == j else 0).solve_right(matrix(SR, 8, 8, lambda i, j: 1))))
print(which(lambda: matrix(SR, 8, 8, lambda i, j: x if i == j else 0).solve_right(matrix(SR, 8, 9, lambda i, j: 1))))
# _shape on the inverse's n x 2n workspace, before the identity: n = 1449 is past the cap, 1448 is within it
print(spied('_identity_rows', lambda: S.inverse(Stub(1449, 1449))))
print(spied('_identity_rows', lambda: S.inverse(Stub(1448, 1448))))
# solve: _shape(m, n + k), then _shape(n, k), then _sr_guard, all before the workspace (one row; a vector, k = 1)
print(spied('_echelon', lambda: S.solve_right(Stub(1, CAP), vector([1]))))
print(spied('_echelon', lambda: S.solve_right(Stub(1, CAP - 1), vector([1]))))
print(spied('_echelon', lambda: S.solve_right(Stub(1, 15), vector([1]))))
print(spied('_echelon', lambda: S.solve_right(Stub(1, 2048), matrix(SR, 1, 2049, 0))))
# kernels: degree-zero spaces return early; the identity-basis orientations are refused by _shape first
print(spied('_identity_rows', lambda: matrix(SR, 0, 100000, []).right_kernel()))
print(spied('_identity_rows', lambda: matrix(SR, 100000, 0, []).left_kernel()))
print(spied('Matrix', lambda: S.left_kernel(matrix(SR, 100000, 0, []))))
print(which(lambda: matrix(SR, 100000, 0, []).right_kernel().degree()))
print(which(lambda: matrix(SR, 0, 100000, []).left_kernel().degree()))
print(spied('_echelon', lambda: matrix(SR, 100000, 0, []).right_kernel()))
print(spied('_identity_rows', lambda: matrix(SR, 0, 2048, []).right_kernel()))
print(spied('_identity_rows', lambda: matrix(SR, 0, 2049, []).right_kernel()))
print(which(lambda: matrix(SR, 0, 20, []).right_kernel().dimension()))
# jacobian: _shape(functions, variables) before any derivative
print(spied('_norm', lambda: S.jacobian([x] * 2049, [x] * 2048)))
print(spied('_norm', lambda: S.jacobian([x] * 2048, [x] * 2048)))
# no identity or transform for rank, rref, echelon_form, pivots
print(spied('_identity_rows', lambda: matrix([[x, 1], [1, x]]).rank()))
print(spied('_identity_rows', lambda: matrix([[x, 1], [1, x]]).rref()))
print(spied('_identity_rows', lambda: matrix([[x, 1], [1, x]]).echelon_form()))
print(spied('_identity_rows', lambda: matrix([[x, 1], [1, x]]).pivots()))
# the expression-size check after each row operation (the measure: the engine strings' total length)
print(S._SR_MAX_CHARS)
print(sum(S._chars(e) for e in matrix([[x, 1, 2], [3, x, 4], [5, 6, x]]).list()))
print(limited(sum(S._chars(e) for e in matrix([[x, 1, 2], [3, x, 4], [5, 6, x]]).list()), lambda: matrix([[x, 1, 2], [3, x, 4], [5, 6, x]]).echelon_form()))
print(limited(sum(S._chars(e) for e in matrix(SR, [[2, x]]).list()), lambda: matrix(SR, [[2, x]]).echelon_form()))
print(limited(10**6, lambda: matrix([[x, 1, 2], [3, x, 4], [5, 6, x]]).echelon_form() is not None))
# the unsupported sizes are refused before any work
print(spied('_echelon', lambda: matrix(SR, 4, 4, lambda i, j: x^(i + j)).det()))
print(spied('det', lambda: matrix(SR, 5, 5, lambda i, j: x^(i + j)).adjugate()))
print(spied('det', lambda: matrix(SR, 4, 4, lambda i, j: x^(i + j)).adjugate()))
