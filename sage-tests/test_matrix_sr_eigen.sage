# Eigenvalues and eigenvectors of matrices over SR, and solving with a
# right-hand side over SR: exact entries given as SR numbers (SR(2)),
# symbolic entries, irrational eigenvalues as radicals (lib/_sage_matrix_sr.py
# eigenvalues, eigenvectors; lib/_sage_matrix.py solve_right).
var('a b')
def show(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, e)

M = matrix(SR, [[SR(2), SR(1)], [SR(1), SR(2)]])
show("SR numbers:", lambda: M.eigenvalues())
show("SR numbers, vectors:", lambda: M.eigenvectors_right())
show("SR numbers, entry parent:", lambda: M[0, 0].parent())
show("symbolic:", lambda: matrix(SR, [[a, b], [b, a]]).eigenvalues())
show("symbolic, right vectors:", lambda: matrix(SR, [[a, b], [b, a]]).eigenvectors_right())
show("symbolic, left vectors:", lambda: matrix(SR, [[a, b], [b, a]]).eigenvectors_left())
show("repeated symbolic:", lambda: matrix(SR, [[x, 1], [0, x]]).eigenvalues())
show("radicals:", lambda: matrix(SR, [[1, 2], [3, 4]]).eigenvalues())
show("radicals, right vectors:", lambda: matrix(SR, [[1, 2], [3, 4]]).eigenvectors_right())
show("radicals, left vectors:", lambda: matrix(SR, [[1, 2], [3, 4]]).eigenvectors_left())
show("ints over SR:", lambda: matrix(SR, [[2, 1], [1, 2]]).eigenvalues())
show("complex:", lambda: matrix(SR, [[0, 1], [-1, 0]]).eigenvalues())
show("scalar:", lambda: matrix(SR, [[2, 0], [0, 2]]).eigenvectors_right())
show("Jordan block:", lambda: matrix(SR, [[1, a], [0, 1]]).eigenvectors_right())
show("sqrt(2) entries:", lambda: matrix(SR, [[sqrt(2), 1], [1, sqrt(2)]]).eigenvalues())
show("change_ring(QQ):", lambda: M.change_ring(QQ).det())
show("QQ matrix, SR numbers:", lambda: matrix(QQ, [[1, 1], [1, -1]]).solve_right(vector(SR, [SR(3), SR(1)])))
show("its parent:", lambda: matrix(QQ, [[1, 1], [1, -1]]).solve_right(vector(SR, [SR(3), SR(1)])).parent())
show("QQ matrix, symbolic:", lambda: matrix(QQ, [[1, 1], [1, -1]]).solve_right(vector(SR, [a, b])))
show("QQ matrix, SR halves:", lambda: matrix(QQ, [[2, 0], [0, 4]]).solve_right(vector([SR(1)/2, SR(1)])))
show("QQ matrix times SR vector:", lambda: matrix(QQ, [[1, 2], [3, 4]]) * vector(SR, [SR(1), SR(2)]))
# The characteristic polynomial's variable is a fresh name: an entry's own
# sbEigenT (the internal name before the review's EIGEN-1) and a renamed
# control (cases whose order is not in question)
sbEigenT = var('sbEigenT'); u = var('u')
for s in (sbEigenT, u):
    show("1x1:", lambda: matrix(SR, [[2*s]]).eigenvalues())
    show("scalar:", lambda: matrix(SR, [[s, 0], [0, s]]).eigenvalues())
    show("scalar vectors:", lambda: matrix(SR, [[s, 0], [0, s]]).eigenvectors_right())
    show("Jordan right:", lambda: matrix(SR, [[s, 1], [0, s]]).eigenvectors_right())
    show("Jordan left:", lambda: matrix(SR, [[s, 1], [0, s]]).eigenvectors_left())
show("colliding symmetric:", lambda: matrix(SR, [[sbEigenT, 1], [1, sbEigenT]]).eigenvalues())
show("colliding symmetric vectors:", lambda: matrix(SR, [[sbEigenT, 1], [1, sbEigenT]]).eigenvectors_right())
# An irreducible quintic factor: no exact roots, Sage's ArithmeticError (not
# solve's implicit 0 == t^5 - t - 1 as an "eigenvalue")
C5 = matrix(SR, [[0, 0, 0, 0, 1], [1, 0, 0, 0, 1], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0]])
show("quintic:", lambda: C5.eigenvalues())
# A symbolic right-hand side given without a ring, and the right-hand sides
# Sage refuses (a list, a tuple, a generator)
A2 = matrix(QQ, [[1, 1], [1, -1]])
show("QQ matrix, symbolic, no ring:", lambda: A2.solve_right(vector([x, 1])))
show("its parent:", lambda: A2.solve_right(vector([x, 1])).parent())
for nm, M in (("QQ", A2), ("SR", matrix(SR, [[1, 1], [1, -1]])), ("ZZ", matrix(ZZ, [[1, 1], [1, -1]]))):
    show(nm + " list:", lambda: M.solve_right([3, 1]))
    show(nm + " tuple:", lambda: M.solve_right((3, 1)))
    show(nm + " generator:", lambda: M.solve_right((u for u in [3, 1])))
