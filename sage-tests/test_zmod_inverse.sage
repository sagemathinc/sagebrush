# Inverses over Z/n with zero divisors, where elimination meets non-unit
# pivots: Sage's inverse for every matrix whose determinant is a unit, and
# its ZeroDivisionError for the others; ~M and negative powers too.
_s = [2181]
def _next():
    _s[0] = (_s[0] * 6364136223846793005 + 1442695040888963407) % 2**64
    return _s[0] >> 11
def _below(n):
    return (_next() * 2**53 + _next()) % n

def show(f):
    try:
        r = f()
        print(r.parent())
        print(r)
    except ZeroDivisionError as e:
        print("ZeroDivisionError:", e)

def unimodular(R, k):
    # (a random lower times upper unitriangular matrix, rows then permuted:
    # determinant +-1, with pivots that are zero divisors once mixed)
    n = R.order()
    L = matrix(R, k, k, lambda i, j: 1 if i == j else (_below(n) if i > j else 0))
    U = matrix(R, k, k, lambda i, j: 1 if i == j else (_below(n) if i < j else 0))
    P = matrix(R, k, k, lambda i, j: 1 if j == (i + 1) % k else 0)
    return P * L * U

R = Zmod(12)
for rows in [[[5, 2], [9, 0]], [[2, 0], [0, 1]], [[6, 1], [1, 0]], [[2, 3], [3, 2]], [[4, 3], [3, 4]], [[3]], [[5]]]:
    M = matrix(R, rows)
    print(rows, M.det(), M.is_invertible())
    show(lambda: M.inverse())
    show(lambda: ~M)
    show(lambda: M**-1)
show(lambda: matrix(R, 0, 0).inverse())
M = matrix(R, [[6, 1], [1, 0]])
show(lambda: M**-3)
print(M**-3 * M**3 == 1)

for n in [4, 6, 8, 9, 12, 30, 36, 72, 2**20, 2**64, 3 * 2**64 + 6, 10**30]:
    R = Zmod(n)
    for k in [1, 2, 3, 4, 6]:
        for trial in range(2):
            U = unimodular(R, k)
            print(n, k, trial, U.det())
            show(lambda: U.inverse())
            M = matrix(R, k, k, [[0, 1, 2, 3, n // 2, n - 1][_below(6)] for _ in range(k * k)])
            print(M.det(), M.is_invertible())
            show(lambda: M.inverse())

# Z/1 (these rows follow Sage 10.9: Sage 10.10 fails internally on a
# nonempty matrix over Z/1, ValueError from its own code, not a refusal)
# Z/1: every determinant is 0, which is a unit there, yet Sage refuses the
# inverse of a nonempty matrix (and gives the empty one)
M = matrix(Zmod(1), [[0]])
print(M.det(), M.is_invertible())
show(lambda: M.inverse())
show(lambda: matrix(Zmod(1), 0, 0).inverse())
