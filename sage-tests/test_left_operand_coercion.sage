# A number on the left of a symbolic expression, a polynomial, a matrix or a vector, as Sage coerces it (#716)
x = var("x")
R.<t> = QQ[]
M = matrix(QQ, [[1, 2], [3, 4]])
Z = matrix(ZZ, [[2, 4], [6, 8]])
S = matrix(QQ, [[1, 2], [2, 4]])
N = matrix(QQ, [[1, 2, 3], [4, 5, 6]])
X = matrix(SR, [[x, 1], [0, 2]])
G = matrix(GF(7), [[1, 2], [3, 4]])
v = vector(QQ, [1, 2])
w = vector(ZZ, [2, 4])
def show(label, f):
    try:
        r = f()
        print(label, "|", str(r).replace("\n", " ; "), "|", r.parent())
    except Exception as e:
        print(label, "| ERR", type(e).__name__)
# CC to a symbolic power: exp(log(z)*e), the logarithm in CC
for c, cn in [(CC(1, 2), "CC"), (CC(-1, 0), "CCneg"), (CC(2, 0), "CCreal"), (CDF(1, 2), "CDF"), (RR(1.5), "RR"), (RDF(1.5), "RDF")]:
    show(cn + " ^ x", lambda: c ^ x)
    show(cn + " ^ sin(x)", lambda: c ^ sin(x))
    show(cn + " ^ 2x", lambda: c ^ (2*x))
    if cn != "CDF":
        show("(" + cn + " ^ x)(x=2)", lambda: (c ^ x).subs(x=2))
# a symbolic expression takes a CC or CDF number into SR
for c, cn in [(CC(1, 2), "CC"), (CDF(1, 2), "CDF")]:
    for e, en in [(SR(0), "SR(0)"), (SR(1), "SR(1)"), (x, "x")]:
        show(cn + " * " + en, lambda: c * e)
        show(cn + " + " + en, lambda: c + e)
        show(cn + " - " + en, lambda: c - e)
        show(cn + " / " + en, lambda: c / e)
# a number over a matrix: X with X*M = c times the identity
for c, cn in [(2, "2"), (1/2, "1/2"), (0, "0"), (RR(1.5), "RR"), (RDF(1.5), "RDF"), (CC(1, 2), "CC"), (CDF(1, 2), "CDF"), (x, "x"), (sqrt(2), "sqrt(2)")]:
    for A, an in [(M, "M"), (Z, "Z"), (S, "S"), (N, "N"), (X, "X")]:
        if (cn, an) in [("RR", "S"), ("CC", "S")]:
            continue  # (Sage's numerical least-squares-like answer; sagebrush refuses)
        show(cn + " / " + an, lambda: c / A)
    show(cn + " / v", lambda: c / v)
    show(cn + " / w", lambda: c / w)
for c, cn in [(2, "2"), (0, "0"), (GF(7)(3), "GF(7)(3)")]:
    show(cn + " / G", lambda: c / G)
    if cn != "0":
        show(cn + " / N over GF(7)", lambda: c / N.change_ring(GF(7)))
show("2 / RDF matrix", lambda: 2 / matrix(RDF, [[1, 2], [3, 4]]))
show("RR(0) / S", lambda: RR(0) / S)
show("CC(0) / S", lambda: CC(0) / S)
show("0 / RR singular", lambda: 0 / matrix(RR, [[1, 2], [2, 4]]))
# a matrix or vector over a number
for c, cn in [(2, "2"), (1/2, "1/2"), (0, "0"), (x, "x"), (sqrt(2), "sqrt(2)"), (1.5r, "1.5r"), (complex(1, 2), "complex"), (GF(7)(3), "GF(7)(3)")]:
    for A, an in [(M, "M"), (Z, "Z"), (N, "N")]:
        show(an + " / " + cn, lambda: A / c)
    if cn != "GF(7)(3)":
        show("X / " + cn, lambda: X / c) if cn not in ("1.5r", "complex") else None
        show("v / " + cn, lambda: v / c)
        show("w / " + cn, lambda: w / c)
# a Python float or complex with a matrix or vector over ZZ or QQ: over RDF or CDF
for c, cn in [(1.5r, "1.5r"), (complex(1, 2), "complex")]:
    for A, an in [(M, "M"), (Z, "Z"), (N, "N"), (v, "v"), (w, "w")]:
        show(cn + " + " + an, lambda: c + A)
        show(an + " - " + cn, lambda: A - c)
        show(cn + " * " + an, lambda: c * A)
        show(an + " * " + cn, lambda: A * c)
# a number to a matrix or vector power, an inexact number over a polynomial
for c, cn in [(2, "2"), (1/2, "1/2"), (RR(1.5), "RR"), (RDF(1.5), "RDF"), (CDF(1, 2), "CDF")]:
    show(cn + " ^ M", lambda: c ^ M)
    show(cn + " ^ v", lambda: c ^ v)
    show(cn + " ^ t", lambda: c ^ t)
for c, cn in [(2, "2"), (1/2, "1/2"), (1.5r, "1.5r"), (complex(1, 2), "complex")]:
    show(cn + " / t", lambda: c / t)
    show(cn + " / (t^2 + 1)", lambda: c / (t^2 + 1))
# a relation, not a bool (the order of its sides is not checked here); CC's 0 to a symbolic power
for c in [CC(1, 2), CDF(1, 2), RDF(1.5), RR(1.5)]:
    print((c == x).is_relational(), (c != x).is_relational())
show("CC(0) ^ x", lambda: CC(0) ^ x)
show("(CC(0) ^ x)(x=2)", lambda: (CC(0) ^ x).subs(x=2))
print(log(CC(0)))
# a Python float or complex with a symbolic matrix stays inexact in SR (it prints as Sage's
# RR here, so only its form is checked: no exact rational such as 3/2)
for c in [1.5r, complex(1, 2)]:
    print(["/" in str(r) for r in [c * X, X * c, c + X, X - c, X / c]])
