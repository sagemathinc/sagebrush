# Symbolic floats of different parents (RR, RDF, CC, CDF) that are equal hash
# alike, directly and nested, so sets and dicts find them (Sage 10.9 and 10.10);
# and RDF to an integer power at the exponent's 64-bit boundaries.
# (x + RR(1.5) == x + 3/2 with different hashes is Sage's too, and is kept.
# SR(2)^(-2^63) is left out: Sage 10.9 and 10.10 abort in GMP there.  So is
# 0^-n: Sage raises ValueError, sagebrush ZeroDivisionError, for every base.
# The pairs are not printed: inside a function Sage shows the RR one as the
# RDF one made after it, sin(x + 1.5), sharing equal arguments.)
x = var('x')
pairs = [('RR/RDF', sin(x + RR(1.5)), sin(x + RDF(1.5))),
         ('CC/CDF', sin(x + CC(1, 2)), sin(x + CDF(1, 2))),
         ('RR/CC', sin(x + RR(1.5)), sin(x + CC(1.5))),
         ('RDF/CDF', sin(x + RDF(1.5)), sin(x + CDF(1.5))),
         ('direct', SR(RR(1.5)), SR(RDF(1.5))),
         ('direct c', SR(CC(1, 2)), SR(CDF(1, 2))),
         ('prod', RR(1.5)*x, RDF(1.5)*x),
         ('sum', x + RR(1.5), x + RDF(1.5)),
         ('sum c', x + CC(1, 2), x + CDF(1, 2)),
         ('pow', x^RR(2.5), x^RDF(2.5)),
         ('nested', sin(cos(x*RR(2.5)) + 1), sin(cos(x*RDF(2.5)) + 1)),
         ('nested c', exp(sin(x*CC(1, 2)) + x), exp(sin(x*CDF(1, 2)) + x)),
         ('names', sin(x + RR(1.5)) + SR.var('fd')*RR(2), sin(x + RDF(1.5)) + SR.var('fd')*RDF(2)),
         ('rel', x == RR(1.5), x == RDF(1.5)),
         ('RR/exact', x + RR(1.5), x + 3/2)]
for n, a, b in pairs:
    print(n, '|', bool(a == b), hash(a) == hash(b), len({a, b}), {a: 1}.get(b), b in {a})
M = -2^63
for n, e in [('MIN', M), ('MIN+1', M + 1), ('-1', -1), ('0', 0), ('MAX', -M - 1), ('-2^64', -2^64)]:
    for bn, b in [('2', RDF(2)), ('0.5', RDF(0.5)), ('-1', RDF(-1)), ('1', RDF(1))]:
        try:
            v = SR(b)^e
            print('RDF(%s)^%s' % (bn, n), '|', v)
        except Exception as ex:
            print('RDF(%s)^%s' % (bn, n), '| ERR', type(ex).__name__)
print('(x*RDF(2))^MIN', '|', (x*RDF(2))^M)
print('SR(1)^MIN', '|', SR(1)^M, '|', SR(-1)^(M + 1), '|', I^M)
