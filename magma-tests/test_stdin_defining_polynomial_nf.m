// DefiningPolynomial of a number field, as Magma 2.18-5 has it: in the ring it was given in (a quadratic field's in
// the session's ring over the integers).
K := QuadraticField(5);
f := DefiningPolynomial(K);
f;
Parent(f);
Parent(f) eq PolynomialRing(Integers());
R<t> := PolynomialRing(Integers());
f;
DefiningPolynomial(QuadraticField(12));
DefiningPolynomial(QuadraticField(-1));
P<x> := PolynomialRing(Rationals());
g := x^3 - 2;
L := NumberField(g);
DefiningPolynomial(L);
DefiningPolynomial(L) eq g;
Parent(DefiningPolynomial(L));
DefiningPolynomial(NumberField(t^2 - 2));
Parent(DefiningPolynomial(NumberField(t^2 - 2)));
DefiningPolynomial(GF(9));
print "end";
