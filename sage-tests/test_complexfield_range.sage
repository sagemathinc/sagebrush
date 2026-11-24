# A number of ComplexField(p), p > 53, meeting a 53-bit one in CC, each part
# at the edges of the doubles' normal range, inside it (rounded to 53 bits):
# the largest double, a value rounding to it, the smallest normal, a value
# rounding up to it, and 0, in either part, either sign, either side.  (Past
# them sagebrush's CC, of doubles, can't hold what Sage's does, and refuses:
# test/sage-sym-mp.test.ts.)
C = ComplexField(100)
MAXD = (2 - QQ(2)^-52) * 2^1023
vals = [("maxd", MAXD), ("maxd+h-e", MAXD + QQ(2)^970 - QQ(2)^930), ("minn", QQ(2)^-1022), ("minn-h", QQ(2)^-1022 - QQ(2)^-1076), ("zero", QQ(0))]
for nm, v in vals:
    for sgn in [1, -1]:
        for part in ["re", "im"]:
            z = C(sgn * v, 1) if part == "re" else C(1, sgn * v)
            for side, f in [("z+RR", lambda: z + RR(1)), ("CC*z", lambda: CC(1, 1) * z), ("RDF+z", lambda: RDF(1) + z)]:
                r = f()
                print(side, part, "-" if sgn < 0 else "+", nm, "|", r.parent(), r)
