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
show("diagonal order:", lambda: matrix(SR, [[1, 1, 0], [0, 2, 0], [0, 0, 3]]).eigenvalues())
show("symbolic diagonal order:", lambda: matrix(SR, [[a, 0], [0, b]]).eigenvalues())
show("cubic order:", lambda: matrix(SR, [[0, 1, 0], [0, 0, 1], [2, 0, 0]]).eigenvalues())
show("rotation:", lambda: matrix(SR, [[cos(x), -sin(x)], [sin(x), cos(x)]]).eigenvalues())
show("charpoly:", lambda: M.charpoly())
