# GF(p) matrix eigenvalues, eigenvectors, eigenspaces (Sage mode), as Sage gives them.
F = GF(101)
A = matrix(F, [[1, 2, 3], [4, 5, 6], [7, 8, 10]])
B = matrix(F, [[2, 1, 0], [0, 2, 0], [0, 0, 3]])
N = matrix(F, [[0, 1, 0], [0, 0, 1], [0, 0, 0]])
S = matrix(F, [[1, 2], [2, 1]])
E = matrix(F, 0, 0)
R = matrix(F, [[1, 2, 3], [4, 5, 6]])
C = matrix(F, [[0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]])
D = matrix(F, [[5, 0, 0, 0], [0, 5, 0, 0], [0, 0, 5, 1], [0, 0, 0, 5]])
Z = matrix(F, [[0, 1], [100, 0]])
G9.<a> = GF(9)
M9 = matrix(G9, [[a, 1], [0, a + 1]])
T2 = matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]])
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), flush=True)
    except Exception as e:
        print(label, "->", ("%s: %s" % (type(e).__name__, str(e).split(chr(10))[0])).rstrip(), flush=True)
show('B.eigenvalues()', lambda: B.eigenvalues())
show('S.eigenvalues()', lambda: S.eigenvalues())
show('N.eigenvalues()', lambda: N.eigenvalues())
show('D.eigenvalues()', lambda: D.eigenvalues())
show('C.eigenvalues()', lambda: C.eigenvalues())
show('Z.eigenvalues()', lambda: Z.eigenvalues())
show('E.eigenvalues()', lambda: E.eigenvalues())
show('R.eigenvalues()', lambda: R.eigenvalues())
show('M9.eigenvalues()', lambda: M9.eigenvalues())
show('matrix(F, [[3, 0], [0, 1]]).eigenvalues()', lambda: matrix(F, [[3, 0], [0, 1]]).eigenvalues())
show('matrix(F, [[1, 0], [0, 3]]).eigenvalues()', lambda: matrix(F, [[1, 0], [0, 3]]).eigenvalues())
show('matrix(F, [[1, 1], [1, 1]]).eigenvalues()', lambda: matrix(F, [[1, 1], [1, 1]]).eigenvalues())
show('B.eigenvectors_right()', lambda: B.eigenvectors_right())
show('S.eigenvectors_left()', lambda: S.eigenvectors_left())
show('S.eigenvectors_right()', lambda: S.eigenvectors_right())
show('D.eigenvectors_right()', lambda: D.eigenvectors_right())
show('N.eigenvectors_left()', lambda: N.eigenvectors_left())
show('M9.eigenvectors_right()', lambda: M9.eigenvectors_right())
show('matrix(F, [[3, 0], [0, 1]]).eigenvectors_right()', lambda: matrix(F, [[3, 0], [0, 1]]).eigenvectors_right())
show('B.eigenspaces_right()', lambda: B.eigenspaces_right())
show('B.eigenspaces_left()', lambda: B.eigenspaces_left())
show('D.eigenspaces_left()', lambda: D.eigenspaces_left())
show('S.eigenspaces_right()', lambda: S.eigenspaces_right())
show('N.eigenspaces_right()', lambda: N.eigenspaces_right())
show('A.eigenvectors_right()', lambda: A.eigenvectors_right())
show('Z.eigenspaces_right()', lambda: Z.eigenspaces_right())
show('B.right_eigenvectors()', lambda: B.right_eigenvectors())
show('B.left_eigenvectors()', lambda: B.left_eigenvectors())
show('B.eigenvectors_left()', lambda: B.eigenvectors_left())
show('R.eigenvectors_right()', lambda: R.eigenvectors_right())
show('R.eigenspaces_left()', lambda: R.eigenspaces_left())
show('E.eigenvectors_right()', lambda: E.eigenvectors_right())
show('E.eigenspaces_right()', lambda: E.eigenspaces_right())
show('matrix(F, [[2]]).eigenspaces_left()', lambda: matrix(F, [[2]]).eigenspaces_left())
show('len(D.eigenvectors_right()[0][1])', lambda: len(D.eigenvectors_right()[0][1]))
show('type(B.eigenvectors_right()[0][2])', lambda: type(B.eigenvectors_right()[0][2]))
# extend=False: only the eigenvalues in the field (mixed linear and irreducible factors)
X3 = matrix(GF(3), [[2, 0, 0], [0, 0, -1], [0, 1, 0]])
X7 = matrix(GF(7), [[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 3, 0], [0, 0, 0, 3]])
I7 = matrix(GF(7), [[0, 1], [-1, 0]])
B2 = matrix(F, [[2, 1], [0, 2]])
for nm in ['X3', 'X7', 'I7', 'B', 'Z', 'T2']:
    for c in ['eigenvalues(extend=False)', 'eigenvalues(False)', 'eigenvalues(extend=0)', 'eigenvalues(extend=None)',
              'eigenvectors_right(extend=False)', 'eigenvectors_left(extend=False)',
              'eigenvectors_right(None, False)', 'eigenvectors_left(None, False)', 'eigenvectors_right(False)',
              'eigenvectors_left(other=B2)', 'eigenvectors_right(bogus=1)']:
        show(nm + '.' + c, lambda: eval(nm + '.' + c))
# algebraic_multiplicity=True: (eigenvalue, space, multiplicity)
for nm in ['B2', 'B', 'D', 'X3', 'I7']:
    for c in ['eigenspaces_right(algebraic_multiplicity=True)', 'eigenspaces_left(algebraic_multiplicity=True)',
              'eigenspaces_right("all", "a", True)', 'eigenspaces_left(format="all", algebraic_multiplicity=True)',
              'eigenspaces_right(algebraic_multiplicity=1)', 'eigenspaces_left(algebraic_multiplicity=False)',
              'eigenspaces_right(algebraic_multiplicity="x")']:
        show(nm + '.' + c, lambda: eval(nm + '.' + c))
show('type(B2.eigenspaces_right(algebraic_multiplicity=True)[0][2])', lambda: type(B2.eigenspaces_right(algebraic_multiplicity=True)[0][2]))
# a duplicate binding of other
for c in ['B2.eigenvectors_right(None, other=B2)', 'B2.eigenvectors_left(None, other=B2)', 'B2.eigenvectors_right(None, other=None)', 'B2.eigenvectors_left(None, other=None)', 'B2.eigenvectors_left(None, extend=False)']:
    show(c, lambda: eval(c))
