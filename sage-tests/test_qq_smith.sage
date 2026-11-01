# Smith and Hermite forms over QQ, a field (kernel lane 4a): they were the
# integer forms of an integral QQ matrix, a silent wrong answer.  The .out
# is HAND-WRITTEN by @sagebrush-sage2.  D and the Hermite form are determined
# by the matrix; U and V are not printed, only checked.  One line per item,
# an error printed as its name.
def rows(f):
    try:
        return f().rows()
    except Exception as ex:
        return type(ex).__name__
def base(f):
    try:
        return f().base_ring()
    except Exception as ex:
        return type(ex).__name__
def check(A):
    try:
        D, U, V = A.smith_form()
        return (U * A * V == D, U.det() != 0, V.det() != 0, D.rows(), D.base_ring())
    except Exception as ex:
        return type(ex).__name__
B = matrix(QQ, [[1, 2], [3, 4]])
C = matrix(QQ, [[1, 2, 3], [2, 4, 6]])
E = matrix(QQ, [[1/2, 1], [1, 3]])
F = matrix(QQ, [[0, 0, 2], [0, 0, 4], [1, 0, 0]])
print(check(B))
print(rows(lambda: B.hermite_form()))
print(base(lambda: B.hermite_form()))
print(check(C))
print(rows(lambda: C.hermite_form()))
print(check(E))
print(rows(lambda: E.hermite_form()))
print(check(F))
print(rows(lambda: matrix(ZZ, [[2, 4], [6, 8]]).smith_form()[0]))
print(rows(lambda: matrix(ZZ, [[2, 4, 6], [3, 5, 7]]).hermite_form()))
print(B.elementary_divisors(), C.elementary_divisors())
print(check(matrix(QQ, 0, 2)))
print(check(matrix(QQ, 2, 0)))
# the allocations are checked before any is made (astra3 R1): a helper that must NOT be reached is
# made to raise; the boundary pairs on the guard itself (_MAX_ENTRIES = 2^22: 2048^2 = 2^22)
import _sage_matrix as _M
def spied(name, f):
    orig = getattr(_M.Matrix, name)
    def boom(*a, **k):
        raise RuntimeError("reached " + name)
    setattr(_M.Matrix, name, boom)
    try:
        return f()
    except Exception as ex:
        return type(ex).__name__
    finally:
        setattr(_M.Matrix, name, orig)
def guard(m, n):
    try:
        _M._smith_field_shapes(m, n)
        return "ok"
    except Exception as ex:
        return type(ex).__name__
print(spied("_smith_field_reduce", lambda: matrix(QQ, 1, 100000).smith_form()))
print(spied("_smith_field_reduce", lambda: matrix(QQ, 100000, 1).smith_form()))
print(guard(1, 2048), guard(1, 2049))
print(guard(2048, 0), guard(2049, 0))
print(guard(2047, 2), guard(2047, 3))
print(spied("_smith_field_reduce", lambda: matrix(QQ, [[1, 2], [3, 4]]).smith_form()))
