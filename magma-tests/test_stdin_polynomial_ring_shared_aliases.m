// The same ring whatever the base ring is called.
A := PolynomialRing(Rationals());
B := PolynomialRing(RationalField());
C := PolynomialRing(Integers());
D := PolynomialRing(IntegerRing());
print A eq B, C eq D, A.1 eq B.1;
E<v> := PolynomialRing(RationalField());
print A.1, B.1;
print "end";
