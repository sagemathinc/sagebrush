# Determinants over Z/n with zero divisors (and over prime powers and Z/1),
# where elimination meets non-unit pivots: the value Sage gives, and whether
# the matrix is invertible (its determinant a unit).
_s = [2174]
def _next():
    _s[0] = (_s[0] * 6364136223846793005 + 1442695040888963407) % 2**64
    return _s[0] >> 11
def _below(n):
    # (two draws for a wide n)
    return (_next() * 2**53 + _next()) % n

A = matrix(Zmod(12), [[5, 2], [9, 0]])
print(A.det(), A.determinant(), parent(A.det()), A.is_invertible())
print(matrix(Zmod(12), [[2, 3], [3, 2]]).det(), matrix(Zmod(12), [[5, 0], [0, 7]]).det())
print(matrix(Zmod(12), [[4, 6], [6, 3]]).det(), matrix(Zmod(12), [[0, 0], [0, 0]]).det())
print(matrix(Zmod(12), 0, 0).det(), matrix(Zmod(12), [[6]]).det())
print(matrix(Zmod(1), [[0, 0], [0, 0]]).det(), matrix(Zmod(1), 0, 0).det())

for n in [4, 6, 8, 9, 12, 30, 49, 360, 2**20, 2**64, 3**41, 2**64 * 3 + 6, 10**30]:
    R = Zmod(n)
    for size in [1, 2, 3, 4, 5, 7]:
        for trial in range(3):
            M = matrix(R, size, size, [_below(n) for _ in range(size * size)])
            # (entries that share factors with n, so pivots are often non-units)
            S = matrix(R, size, size, [[0, 2, 3, 6, n // 2, n - 2][_below(6)] for _ in range(size * size)])
            print(n, size, trial, M.det(), S.det(), M.is_invertible(), S.is_invertible())

# triangular, a zero column, repeated rows, and a unit determinant
R = Zmod(24)
print(matrix(R, [[2, 5, 7], [0, 3, 1], [0, 0, 4]]).det())
print(matrix(R, [[2, 0, 7], [6, 0, 1], [10, 0, 4]]).det())
print(matrix(R, [[2, 4, 6], [2, 4, 6], [1, 1, 1]]).det())
U = matrix(R, [[1, 2, 3], [0, 1, 4], [5, 6, 1]])
print(U.det(), U.is_invertible())
