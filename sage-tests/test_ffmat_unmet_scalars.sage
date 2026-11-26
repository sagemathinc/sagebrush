# Scalars whose parent never meets a finite ring (GF(p), Z/n or GF(q)) with
# a matrix over it, for *, + and - in both orders: Sage's TypeError naming
# the two parents (for a symbolic scalar times the matrix, the symbolic
# ring's own refusal); real and complex numerical fields, the symbolic ring,
# polynomials over QQ or over a coprime finite field, Z/m coprime to the
# ring, and QQ.
def show(f):
    try:
        r = f()
        print(parent(r))
        print(r)
    except TypeError as e:
        print("TypeError:", e)

x = polygen(QQ, 'x')
y = polygen(GF(5), 'y')
for R in [GF(5), GF(2), Zmod(12), GF(4, 'a'), GF(49, 'b')]:
    M = matrix(R, [[1, 0], [1, 1]])
    N = matrix(R, [[1, 0, 1]])
    scalars = [RR(1.5), RDF(1.5), RealField(100)(1.5), CC(1, 2), CDF(1, 2), x, SR(2), sqrt(2), QQ(1/3)]
    scalars += [s for s in [y, Zmod(3)(2), Zmod(11)(3)] if gcd(s.parent().base_ring().order() if s.parent() is y.parent() else s.parent().order(), R.order()) == 1]
    for s in scalars:
        print(R, "|", parent(s))
        show(lambda: s * M)
        show(lambda: M * s)
        show(lambda: M + s)
        show(lambda: s + M)
        show(lambda: M - s)
        show(lambda: s - M)
        show(lambda: s * N)
        show(lambda: N + s)
