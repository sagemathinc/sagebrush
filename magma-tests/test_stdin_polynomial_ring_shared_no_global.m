// The unnamed ring with no global holding it, then a global, then the global rebound.
print PolynomialRing(Rationals()).1;
P := PolynomialRing(Rationals());
f := P.1 + 1;
print f;
P := 0;
print f, Parent(f);
R := PolynomialRing(Rationals());
print f, R.1;
print "end";
