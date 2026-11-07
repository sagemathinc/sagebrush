# Evaluating a polynomial over an inexact field, the zero polynomial too, at a matrix, at a
# polynomial of another ring, at a number and at a symbolic variable: the value is in the
# argument's codomain, as Sage 10.9 and 10.10 (daybreak3's EVAL-1 on #784).
# Left out: RDF, CDF and RealField(100) coefficients in SR (they print as RR there until 1d-i
# and 1d-ii), and CC or CDF coefficients at a matrix over RR (a matrix over RR meeting CC is
# over CC in Sage, a 1c follow-up).
def show(label, f):
    try:
        v = f()
        print(label, '|', str(v).replace('\n', ' ; '), '|', v.parent())
    except Exception as e:
        print(label, '| ERR', type(e).__name__)
U = PolynomialRing(CDF, 'u'); u = U.gen()
for bn, B in [('RR', RR), ('RDF', RDF), ('CC', CC), ('CDF', CDF), ('R100', RealField(100))]:
    P = PolynomialRing(B, 't'); t = P.gen()
    z, f = P(0), t^2 + 1
    args = [('QQ mat', matrix(QQ, [[1, 2], [3, 4]])), ('CDF mat', matrix(CDF, [[1, 2], [3, 4]])),
            ('CDF u', u), ('QQ s', QQ['s'].gen()), ('t+1', t + 1), ('2', 2), ('RDF 2', RDF(2))]
    if bn in ('RR', 'RDF', 'R100'):
        args.append(('RR mat', matrix(RR, [[1, 2], [3, 4]])))
    if bn in ('RR', 'CC'):
        args.append(('x', SR.var('x')))
    for n, x in args:
        show('%s zero(%s)' % (bn, n), lambda: z(x))
        show('%s f(%s)' % (bn, n), lambda: f(x))
