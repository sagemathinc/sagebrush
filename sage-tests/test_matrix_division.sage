# A / B for a matrix B: X with X*B = A, as Sage's B.solve_left(A), over the ring where A and B meet;
# a vector over a matrix likewise; and solve_left/solve_right with a vector right-hand side over QQ
def show(label, f):
    try:
        r = f()
        print(label, "|", str(r).replace("\n", " ; "), "|", r.parent())
    except Exception as e:
        # (numpy's LinAlgError text differs between versions: its type only)
        print(label, "| ERR", type(e).__name__, "" if type(e).__name__ == "LinAlgError" else str(e)[:100])
x = var("x")
rowsA = [[1, 2], [3, 4]]
rowsB = [[2, 1], [1, 1]]
rowsU = [[1, 1], [0, 2]]
Rs = [("ZZ", ZZ), ("QQ", QQ), ("SR", SR), ("RR", RR), ("RDF", RDF)]
for an, P in Rs:
    for bn, Q in Rs:
        show(an + "/" + bn, lambda: matrix(P, rowsA) / matrix(Q, rowsU))
for an, P in [("ZZ", ZZ), ("QQ", QQ), ("GF7", GF(7))]:
    for bn, Q in [("ZZ", ZZ), ("QQ", QQ), ("GF7", GF(7))]:
        show(an + "/" + bn + " B", lambda: matrix(P, rowsA) / matrix(Q, rowsB))
show("QQ/RDF exact", lambda: matrix(QQ, rowsA) / matrix(RDF, [[2, 0], [0, 4]]))
show("CDF/RDF", lambda: matrix(CDF, [[1, 2], [3, I]]) / matrix(RDF, [[2, 0], [0, 4]]))
show("A/A", lambda: matrix(QQ, rowsA) / matrix(QQ, rowsA))
show("A/S", lambda: matrix(QQ, rowsA) / matrix(QQ, [[1, 2], [2, 4]]))
show("S/S", lambda: matrix(QQ, [[1, 2], [2, 4]]) / matrix(QQ, [[1, 2], [2, 4]]))
show("GF7 S/S", lambda: matrix(GF(7), [[1, 2], [2, 4]]) / matrix(GF(7), [[1, 2], [2, 4]]))
show("N/N", lambda: matrix(QQ, [[1, 2, 3], [4, 5, 6]]) / matrix(QQ, [[1, 2, 3], [4, 5, 6]]))
show("N/B", lambda: matrix(QQ, [[1, 2, 3], [4, 5, 6]]) / matrix(QQ, rowsB))
show("B/N", lambda: matrix(QQ, rowsB) / matrix(QQ, [[1, 2, 3], [4, 5, 6]]))
show("3x2 / 2x2", lambda: matrix(QQ, [[1, 2], [3, 4], [5, 6]]) / matrix(QQ, rowsB))
show("I3/I3", lambda: identity_matrix(3) / identity_matrix(3))
show("0x0/0x0", lambda: matrix(QQ, 0, 0) / matrix(QQ, 0, 0))
show("X/B", lambda: matrix(SR, [[x, 1], [0, x]]) / matrix(QQ, rowsB))
show("B/X", lambda: matrix(QQ, rowsB) / matrix(SR, [[x, 1], [0, x]]))
show("QQ/GF7", lambda: matrix(QQ, rowsA) / matrix(GF(7), rowsB))
show("v/B", lambda: vector(QQ, [1, 2]) / matrix(QQ, rowsB))
show("vZZ/BZZ", lambda: vector(ZZ, [1, 2]) / matrix(ZZ, rowsB))
show("v/S", lambda: vector(QQ, [1, 2]) / matrix(QQ, [[1, 2], [2, 4]]))
show("vRR/B", lambda: vector(RR, [1, 2]) / matrix(QQ, rowsU))
show("v/BRR", lambda: vector(QQ, [1, 2]) / matrix(RR, rowsU))
show("vGF7/BGF7", lambda: vector(GF(7), [1, 2]) / matrix(GF(7), rowsB))
for F in [ZZ, QQ]:
    A = matrix(F, rowsB)
    for w in [vector(ZZ, [1, 2]), vector(QQ, [1, 2]), vector(ZZ, [2, 2])]:
        show(str(F)[:8] + " solve_right " + str(w), lambda: A.solve_right(w))
        show(str(F)[:8] + " solve_left " + str(w), lambda: A.solve_left(w))
show("solve_left shape", lambda: matrix(QQ, rowsB).solve_left(matrix(QQ, [[1, 2, 3], [4, 5, 6]])))
# a complex numerator over a real numerical matrix: the real and imaginary parts solved apart
show("CDF/RDF diag", lambda: matrix(CDF, [[1, 2], [3, I]]) / matrix(RDF, [[2, 0], [0, 4]]))
show("CC/RR unit", lambda: matrix(CC, [[1, 2*I], [3, 1 + I]]) / matrix(RR, rowsU))
show("vCDF/RDF", lambda: vector(CDF, [1, I]) / matrix(RDF, [[2, 0], [0, 4]]))
show("CDF/RDF singular", lambda: matrix(CDF, [[1, I], [1, 1]]) / matrix(RDF, [[1, 2], [2, 4]]))
