# Scalars that don't coerce into a finite field (or Z/n) times, plus or minus
# a matrix over it, in both orders: Sage's TypeError naming the two parents;
# and the scalars that do coerce, for contrast.
def show(f):
    try:
        r = f()
        print("ok", parent(r))
        print(r)
    except TypeError as e:
        print("TypeError:", e)

for R in [GF(5), GF(2), Zmod(12)]:
    M = matrix(R, [[1, 2], [3, 4]])
    N = matrix(R, [[1, 2, 3]])
    for s in [QQ(1/2), QQ(2), 1/3, ZZ(3), 3, R(2)]:
        print(R, repr(s), parent(s))
        show(lambda: s * M)
        show(lambda: M * s)
        show(lambda: s * N)
        show(lambda: N * s)
        show(lambda: M + s)
        show(lambda: s - M)
    for s in [GF(7)(3), Zmod(49)(2)]:
        print(R, repr(s), parent(s))
        show(lambda: s * M)
        show(lambda: M * s)
