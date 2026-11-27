# Empty matrices over a finite field (or Z/n) print as Sage prints them: [] for
# no rows or no columns, by print, repr and str, alone and inside a list.
for F in [GF(101), GF(2), Zmod(12)]:
    for r, c in [(0, 0), (0, 2), (2, 0), (1, 0), (0, 1)]:
        M = matrix(F, r, c, [])
        print(r, c, M.parent())
        print(M)
        print(repr(M), str(M))
        print([M, M])
        print(M.nrows(), M.ncols(), M.dimensions())
