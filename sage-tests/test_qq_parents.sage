# The parent of every entry or coefficient a QQ container hands out (Sage:
# QQ, the Rational Field, even for integral values; a ZZ container's stay
# ZZ).  Vectors and matrices are shown by their entries' parents.  (Left
# out: rank and nrows are an int in Sage, sagebrush's Integer; polynomial
# slices, QQ polynomial content and the zero polynomial's list differ
# otherwise: separate items.)
def par(r):
    if hasattr(r, 'dot_product') and hasattr(r, 'base_ring'):
        return "vec[" + ", ".join(par(x) for x in r) + "]"
    if hasattr(r, 'nrows') and hasattr(r, 'list'):
        return "mat[" + ", ".join(par(x) for x in r.list()) + "]"
    if isinstance(r, (list, tuple)):
        return "[" + ", ".join(par(x) for x in r) + "]"
    if isinstance(r, dict):
        return "{" + ", ".join("%r: %s" % (k, par(r[k])) for k in sorted(r)) + "}"
    if isinstance(r, bool):
        return "bool"
    if hasattr(r, 'parent'):
        p = r.parent()
        return {QQ: "QQ", ZZ: "ZZ"}.get(p, str(p))
    return type(r).__name__
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), "|", par(r))
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:80])
for B, bn in [(QQ, "QQ"), (ZZ, "ZZ")]:
    M = matrix(B, [[1, 2, 3], [4, 5, 6], [7, 8, 10]])
    show(bn + " M[1,2]", lambda: M[1, 2])
    show(bn + " M[-1,-1]", lambda: M[-1, -1])
    show(bn + " list(M)", lambda: list(M))
    show(bn + " iter first", lambda: next(iter(M)))
    show(bn + " M.list()", lambda: M.list())
    show(bn + " M.rows()", lambda: M.rows())
    show(bn + " M.columns()", lambda: M.columns())
    show(bn + " M.row(1)", lambda: M.row(1))
    show(bn + " M.column(2)", lambda: M.column(2))
    show(bn + " M[0]", lambda: M[0])
    show(bn + " M[0][1]", lambda: M[0][1])
    show(bn + " M[:,0]", lambda: M[:, 0])
    show(bn + " M[0:2,0:2]", lambda: M[0:2, 0:2])
    show(bn + " M[0:2,0:2][1,1]", lambda: M[0:2, 0:2][1, 1])
    show(bn + " M.dict()", lambda: M.dict())
    show(bn + " M.diagonal()", lambda: M.diagonal())
    show(bn + " M.trace()", lambda: M.trace())
    show(bn + " M.det()", lambda: M.det())
    show(bn + " sum(M.list())", lambda: sum(M.list()))
    show(bn + " max(M.list())", lambda: max(M.list()))
    show(bn + " M.charpoly()", lambda: M.charpoly())
    show(bn + " M.charpoly().list()", lambda: M.charpoly().list())
    show(bn + " (M*M)[0,0]", lambda: (M * M)[0, 0])
    show(bn + " (M+M)[0,0]", lambda: (M + M)[0, 0])
    show(bn + " (2*M)[0,0]", lambda: (2 * M)[0, 0])
    show(bn + " M.transpose()[0,1]", lambda: M.transpose()[0, 1])
    show(bn + " M.echelon_form()[0,0]", lambda: M.echelon_form()[0, 0])
    show(bn + " M*vector", lambda: M * vector(B, [1, 1, 1]))
    show(bn + " (M*vector)[0]", lambda: (M * vector(B, [1, 1, 1]))[0])
    Z = matrix(B, 0, 0)
    show(bn + " 0x0 trace", lambda: Z.trace())
    show(bn + " 0x0 det", lambda: Z.det())
    show(bn + " 0x0 list", lambda: Z.list())
if True:
    M = matrix(QQ, [[1/2, 2], [3, 1/3]])
    show("QQfrac M[0,0]", lambda: M[0, 0])
    show("QQfrac M[0,1]", lambda: M[0, 1])
    show("QQfrac list", lambda: M.list())
    show("QQfrac trace", lambda: M.trace())
    show("QQfrac det", lambda: M.det())
    show("QQfrac inverse", lambda: M.inverse())
    show("QQfrac inverse.list", lambda: M.inverse().list())
for B, bn in [(QQ, "QQ"), (ZZ, "ZZ")]:
    P = PolynomialRing(B, 'x'); x = P.gen()
    f = 3*x^3 - x + 2
    show(bn + " f.list()", lambda: f.list())
    show(bn + " f.coefficients()", lambda: f.coefficients())
    show(bn + " f.coefficients(sparse=False)", lambda: f.coefficients(sparse=False))
    show(bn + " f.dict()", lambda: f.dict())
    show(bn + " list(f)", lambda: list(f))
    show(bn + " f[0]", lambda: f[0])
    show(bn + " f[3]", lambda: f[3])
    show(bn + " f[7]", lambda: f[7])
    show(bn + " f.leading_coefficient()", lambda: f.leading_coefficient())
    show(bn + " f.constant_coefficient()", lambda: f.constant_coefficient())
    show(bn + " f(2)", lambda: f(2))
    show(bn + " f.degree()", lambda: f.degree())
    show(bn + " P(5).list()", lambda: P(5).list())
    show(bn + " f.derivative().list()", lambda: f.derivative().list())
    show(bn + " (f*f).list()", lambda: (f * f).list())
    show(bn + " f.monic().list()", lambda: f.monic().list())
for B, bn in [(QQ, "QQ"), (ZZ, "ZZ")]:
    v = vector(B, [1, 2, 3])
    show(bn + " v[0]", lambda: v[0])
    show(bn + " v[-1]", lambda: v[-1])
    show(bn + " list(v)", lambda: list(v))
    show(bn + " v.list()", lambda: v.list())
    show(bn + " iter first", lambda: next(iter(v)))
    show(bn + " v[0:2]", lambda: v[0:2])
    show(bn + " v[0:2][0]", lambda: v[0:2][0])
    show(bn + " v+v", lambda: v + v)
    show(bn + " (v+v)[0]", lambda: (v + v)[0])
    show(bn + " 2*v", lambda: 2 * v)
    show(bn + " (2*v)[0]", lambda: (2 * v)[0])
    show(bn + " v*v", lambda: v * v)
    show(bn + " v.dot_product(v)", lambda: v.dot_product(v))
    show(bn + " sum(v)", lambda: sum(v))
    show(bn + " v.dict()", lambda: v.dict())
    show(bn + " v.norm()^2", lambda: v.norm() ^ 2)
    show(bn + " tuple(v)", lambda: tuple(v))
V = VectorSpace(QQ, 3)
show("VectorSpace(QQ,3)(0)", lambda: V(0))
show("VectorSpace(QQ,3).zero()", lambda: V.zero())
show("VectorSpace(QQ,3).basis()[0]", lambda: V.basis()[0])
show("VectorSpace(QQ,3)([1,2,3])", lambda: V([1, 2, 3]))
show("sum(VectorSpace(QQ,3)([1,2,3]))", lambda: sum(V([1, 2, 3])))
show("sum(VectorSpace(QQ,3).zero())", lambda: sum(V.zero()))
show("vector([1/2,2])[1]", lambda: vector([1/2, 2])[1])
show("sum(vector([1/2,3/2]))", lambda: sum(vector([1/2, 3/2])))
# entries assigned into a QQ vector, vector-matrix products in every ring
# orientation and quotients, with integral results (astra's CORR-DE2-1/2)
w = vector(QQ, [1, 2]); w[0] = 3; w[1] = 4
show("assigned QQ vector", lambda: w)
show("sum(assigned QQ vector)", lambda: sum(w))
for vb, vn in [(QQ, "QQ"), (ZZ, "ZZ")]:
    for mb, mn in [(QQ, "QQ"), (ZZ, "ZZ")]:
        I = matrix(mb, [[1, 0], [0, 1]])
        u = vector(vb, [1, 2])
        show("%sv*%sm" % (vn, mn), lambda: u * I)
        show("%sm*%sv" % (mn, vn), lambda: I * u)
for vb, vn in [(QQ, "QQ"), (ZZ, "ZZ")]:
    u = vector(vb, [2, 4])
    show("%sv/2" % vn, lambda: u / 2)
    show("%sv/QQ(2)" % vn, lambda: u / QQ(2))
    show("%sv/2*1" % vn, lambda: (u / 2)[0])
