# extend=False keeps only the base ring's eigenvalues (ZZ and QQ matrices), and
# a Hecke index must be an integer (Codex audit R04b).  Every matrix is made
# fresh: Sage caches eigenvalues per matrix.
def show(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, e)

ROWS = [[[0, 2], [1, 0]], [[1, 1, 0], [0, 2, 0], [0, 0, 3]],
        [[2, 1, 0, 0], [0, 2, 0, 0], [0, 0, 0, -1], [0, 0, 1, 0]],
        [[1, 2], [3, 4]], [[0, 4], [-1, 0]], [[3, 0, 0], [0, 3, 0], [0, 0, 1]],
        [[2, 0], [0, 2]], [[QQ(1)/2, 0], [1, QQ(-3)/4]]]
for R in [ZZ, QQ]:
    for rows in ROWS:
        if R is ZZ and any(x not in ZZ for r in rows for x in r):
            continue
        A = lambda: matrix(R, rows)
        show((R, rows, "eigenvalues"), lambda: A().eigenvalues(extend=False))
        show((R, rows, "parents"), lambda: [x.parent() for x in A().eigenvalues(extend=False)])
        for side in ["right", "left"]:
            def ev():
                return [(lam, list(vs), m) for lam, vs, m in getattr(A(), "eigenvectors_" + side)(extend=False)]
            show((R, rows, side), ev)
            show((R, rows, side, "parents"), lambda: [lam.parent() for lam, vs, m in getattr(A(), "eigenvectors_" + side)(extend=False)])
        # (extend=True unchanged; not for the matrix with eigenvalues +-i, which Sage prints
        # as 1*I and Sagebrush as I)
        if len(rows) != 4:
            show((R, rows, "extend=True"), lambda: A().eigenvalues())
show(("empty",), lambda: (matrix(QQ, 0, 0, []).eigenvalues(extend=False), matrix(ZZ, 0, 0, []).eigenvectors_right(extend=False)))

# Hecke indices: a fresh space for each, so no T_n is cached (Sage keeps T_n by
# int(n) and checks the type only when it makes one; Sagebrush checks every
# time, the fresh-space behaviour)
for n in [QQ(5)/2, QQ(7)/3, 2.5, QQ(4)/2, QQ(2), 2.0, RR(3)]:
    show(("hecke_operator", n), lambda: ModularSymbols(11, 2, sign=1).hecke_operator(n))
    show(("hecke_polynomial", n), lambda: ModularSymbols(11, 2, sign=1).hecke_polynomial(n))
    show(("T", n), lambda: ModularSymbols(11, 2, sign=1).T(n).charpoly())
for n in [2, 3, ZZ(5), int(7)]:
    show(("hecke_polynomial", n), lambda: ModularSymbols(11, 2, sign=1).hecke_polynomial(n))
    show(("T", n), lambda: ModularSymbols(37, 2).T(n).charpoly())
M = ModularSymbols(11, 2, sign=1)
show(("same operator",), lambda: M.T(3) is M.hecke_operator(int(3)))
