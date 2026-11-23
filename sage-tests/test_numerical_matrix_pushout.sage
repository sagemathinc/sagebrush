# Matrices and vectors over two different numerical fields meet as Sage's coercion has it: the lower
# precision, the left one of RDF and RR or CDF and CC, complex when either is (CDF with a real field
# of at least 53 bits, else ComplexField of the lower precision); augment keeps the left matrix's field,
# stack is over the pushout
def show(label, f):
    try:
        r = f()
        print(label, "|", str(r).replace("\n", " ; "), "|", r.parent())
    except Exception as e:
        print(label, "| ERR", type(e).__name__)
Fs = [("RDF", RDF), ("RR", RR), ("CDF", CDF), ("CC", CC), ("R30", RealField(30)), ("C100", ComplexField(100))]
def M(F):
    return matrix(F, [[1, 2], [3, 4]]) if F in (RDF, RR, RealField(30)) else matrix(F, [[1, 2], [3, 1 + 2*I]])
for an, A in Fs:
    for bn, B in Fs:
        if an == bn:
            continue
        show(an + " * " + bn, lambda: M(A) * M(B))
        show(an + " + " + bn, lambda: M(A) + M(B))
        show(an + " - " + bn, lambda: M(A) - M(B))
        show(an + " augment " + bn, lambda: M(A).augment(matrix(B, [[5], [6]])))
        show(an + " stack " + bn, lambda: M(A).stack(matrix(B, [[5, 6]])))
for an, A in Fs[:4]:
    for bn, B in Fs[:4]:
        if an == bn:
            continue
        w = vector(B, [1, 2]) if B in (RDF, RR) else vector(B, [1, I])
        show(an + " * v" + bn, lambda: M(A) * w)
        show("v" + bn + " * " + an, lambda: w * M(A))
show("RDF 1x3 * CDF 3x2", lambda: matrix(RDF, [[1, 2, 3]]) * matrix(CDF, [[1, 2], [3, 4], [5, 6]]))
show("CDF 2x2 * RDF 2x3", lambda: matrix(CDF, [[1, 2], [3, I]]) * matrix(RDF, [[1, 2, 3], [4, 5, 6]]))
show("RDF 2x2 * CDF 3x3", lambda: matrix(RDF, [[1, 2], [3, 4]]) * matrix(CDF, 3, 3, range(9)))
show("RDF augment CDF with i", lambda: matrix(RDF, [[1], [2]]).augment(matrix(CDF, [[I], [1]])))
# a CDF number into ComplexField(p): its two doubles, rounded
for f, fn in [(lambda: ComplexField(30)(CDF(1, 2)), "C30(CDF(1, 2))"), (lambda: ComplexField(100)(CDF(1.5, -2)), "C100(CDF(1.5, -2))"), (lambda: ComplexField(30)(CDF(1/3, 1/7)), "C30(CDF(1/3, 1/7))")]:
    show(fn, f)
