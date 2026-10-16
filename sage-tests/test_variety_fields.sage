# variety over AA, QQbar and the real and complex fields (the sagebook, p.
# 212): computed exactly and converted; printed in a fixed order (Sage's
# order of the points is its own). Cases where Sage's floating answer is less
# accurate (I3 in RR, RDF, CC, CDF) or qqbar displays differ are doctests.
R.<x,y> = QQ[]
C = ideal(x^2+y^2-1); D = ideal((x+2*y-1)*(x+2*y+1)); J2 = C + D
S.<a,b,c> = QQ[]
I3 = S.ideal(a^2-2, b^2-a, c-a*b)
I4 = S.ideal((a-1)^2, b-a, c)
for (nm, I, Ks) in [('J2', J2, [RealField(51), RR, RDF, CC, ComplexField(20)]), ('I3', I3, [AA]),
                    ('I4', I4, [RealField(51), RR, RDF, CC, CDF, ComplexField(20), AA, QQbar])]:
    for K in Ks:
        v = I.variety(K)
        print(nm, K, len(v), sorted(str(p) for p in v))
