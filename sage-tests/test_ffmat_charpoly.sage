# Characteristic polynomials of matrices over prime fields (computed by the
# engine for p < 2^63, in Python for larger p and for GF(p^k)), with their
# parents, variable names and printing.

def mat(F, n, seed):
    # a deterministic dense matrix: entries (i + seed)^(j + 3) in F
    return matrix(F, n, n, [F(i + seed) ** (j + 3) for i in range(n) for j in range(n)])

for p in [2, 3, 7, 65537, 2^31 - 1, 2^61 - 1, 2^63 - 25, 2^63 + 29, 2^127 - 1]:
    F = GF(p)
    for n in [1, 2, 3, 5, 8, 13]:
        A = mat(F, n, 2)
        f = A.charpoly()
        # (Sage adds "(using NTL)" to the parent's name past 2^64)
        print(p, n, f, f.parent() if p < 2^64 else f.parent().variable_name(), f(A) == 0)

F = GF(65537)
A = mat(F, 6, 5)
print(A.charpoly("y"), A.charpoly("y").parent())
print(A.characteristic_polynomial(), A.characteristic_polynomial().variable_name())
print(matrix(F, 4, 4).charpoly())                      # zero matrix
print(identity_matrix(F, 5).charpoly())
N = matrix(F, 4, 4, lambda i, j: 1 if j == i + 1 else 0)
print(N.charpoly(), N.minpoly())                       # nilpotent
D = diagonal_matrix(F, [1, 2, 2, 3])
print(D.charpoly(), D.charpoly().factor())
print(matrix(F, 0, 0).charpoly())
print(matrix(GF(2), [[1, 1], [1, 0]]).charpoly())
print(matrix(GF(9, "a"), [[1, 2], [3, 4]]).charpoly())  # not a prime field
B = mat(GF(101), 30, 3)
f = B.charpoly()
print(f.degree(), f[0] == B.det() * (-1) ^ 30, f[29] == -B.trace(), f(B) == 0)
