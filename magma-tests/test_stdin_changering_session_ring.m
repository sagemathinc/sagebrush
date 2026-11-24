// ChangeRing to the integers or the rationals gives the session's own polynomial ring over it, as Magma 2.18-5 has
// it: PolynomialRing(Integers()) is the same ring, and its variable prints by the global that holds it.
P<x> := PolynomialRing(Rationals());
S, h := ChangeRing(P, Integers());
S;
S.1;
h;
S eq PolynomialRing(Integers());
T := PolynomialRing(Integers());
T.1;
S.1 + 1;
h(x^2 + 1);
Parent(h(x^2 + 1));
R<y> := PolynomialRing(Integers());
S;
ChangeRing(x^2 + 1, Integers());
Parent(ChangeRing(x^2 + 1, Integers()));
U := ChangeRing(R, Rationals());
U;
U eq P;
U.1;
ChangeRing(y^2 + 1, Rationals());
ChangeRing(y^2 + 1, GF(5));
print "end";
