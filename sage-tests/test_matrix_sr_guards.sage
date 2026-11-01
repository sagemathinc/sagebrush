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
# the zero-proof stage's contract (astra3's A3 ruling 17cfbcee): G40-52; the reducer's one call is S._reduce_trig
def val(f):
    try:
        return str(f())
    except Exception as e:
        return type(e).__name__
def counted(f):
    orig, n = S._reduce_trig, [0]
    def spy(x):
        n[0] += 1
        return orig(x)
    S._reduce_trig = spy
    try:
        return '%s %d' % (which(f), n[0])
    finally:
        S._reduce_trig = orig
def raising(exc, f):
    orig = S._reduce_trig
    def spy(x):
        raise exc
    S._reduce_trig = spy
    try:
        f()
        return 'ok'
    except BaseException as e:
        return type(e).__name__
    finally:
        S._reduce_trig = orig
def outcome(f):
    orig, log = S._reduce_trig, []
    def spy(x):
        try:
            r = orig(x)
        except NotImplementedError:
            log.append('refused')
            raise
        log.append('reduced')
        return r
    S._reduce_trig = spy
    try:
        return '%s %s' % (which(f), ' '.join(log))
    finally:
        S._reduce_trig = orig
def before(chars, f):
    orig = S._reduce_trig
    def boom(x):
        raise RuntimeError('reached _reduce_trig')
    S._reduce_trig = boom
    try:
        return limited(chars, f)
    finally:
        S._reduce_trig = orig
var('a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 a10')
W10 = prod(sin(v) for v in [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9]); W11 = W10 * sin(a10)
print(val(lambda: matrix([[sin(0.1*x)*cos(x)]]).rank()))
print(raising(S._memory_error('a spy', 2, 1), lambda: matrix([[sin(x)*cos(x)]]).rank()))
print(raising(KeyboardInterrupt(), lambda: matrix([[sin(x)*cos(x)]]).rank()))
print(raising(ValueError('a spy'), lambda: matrix([[sin(x)*cos(x)]]).rank()))
print(limited(len(SR(sin(x)^2)._s), lambda: matrix([[sin(x)^2]]).rank()))
print(before(len(SR(sin(x)^2)._s) - 1, lambda: matrix([[sin(x)^2]]).rank()))
print(counted(lambda: matrix([[x, 1], [1, x^2]]).rank()))
print(counted(lambda: matrix([[sinh(x)*cosh(x)]]).rank()))
print(counted(lambda: matrix([[arcsin(x)]]).rank()))
print(counted(lambda: matrix([[sin(x)*cos(x), 1], [x, x^2]]).rank()))
print(outcome(lambda: matrix([[W10]]).rank()))
print(outcome(lambda: matrix([[W11]]).rank()))
print(val(lambda: matrix([[(x + 1)^2 - x^2 - 2*x - 1]]).rank()))
