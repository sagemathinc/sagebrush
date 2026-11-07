# A vector over a real or complex field meeting a number of another such field (daybreak3's #767 ENGINE review,
# PREC-BELOW-DOUBLE-1 and PREC-COMPLEX-REAL-1), as Sage 10.10: when the number's field coerces into the vector's
# (its precision at least the vector's, and a complex number only into a complex field), the vector's field;
# otherwise the field of the lower precision, complex when either is, RDF or CDF only for two doubles (a double
# counting as 53 bits). v*s, s*v and v/s over every pair of RDF, RealField(20), RR, RealField(80),
# RealField(100), CDF, ComplexField(20), CC, ComplexField(80), ComplexField(100). (5/8, not 5/7: ComplexField(20)(5)/7 is
# 0.71428 in Sage and 0.71429 here, a scalar division of its own, reported.)
fields = [("RDF", RDF), ("R20", RealField(20)), ("RR", RR), ("R80", RealField(80)), ("R100", RealField(100)), ("CDF", CDF), ("C20", ComplexField(20)), ("CC", CC), ("C80", ComplexField(80)), ("C100", ComplexField(100))]
def short(P):
    for n, F in fields:
        if P == F:
            return n
    return str(P)
for vn, V in fields:
    v = vector(V, [2, -3, V(5)/8])
    for sn, S in fields:
        s = S(3) if "R" in sn else S(3, 2)
        for op in ("v*s", "s*v", "v/s"):
            try:
                r = v * s if op == "v*s" else (s * v if op == "s*v" else v / s)
                print(vn, sn, op, short(r.base_ring()), r)
            except Exception as e:
                print(vn, sn, op, "%s: %s" % (type(e).__name__, e))
