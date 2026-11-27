// Naming the shared ring three times: each name renames it everywhere, earlier elements included.
P<x> := PolynomialRing(Rationals());
f := x^2 - 2;
Q<y> := PolynomialRing(Rationals());
print f, P;
R<z> := PolynomialRing(Rationals());
print f, x, y, P eq R;
print [f, x + 1], Parent(f);
print "end";
