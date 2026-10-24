// ChangeRing, F3 of plan-finite-fields: a univariate polynomial ring over
// the integers, the rationals or a finite field, or one of its polynomials,
// over another of these rings (embedding into an overfield, descent into a
// subfield), and the map ChangeRing(P, R) returns.
P<x> := PolynomialRing(Integers());
f := 3*x^2 - x + 7;
ChangeRing(P, Rationals());
ChangeRing(P, GF(5));
ChangeRing(P, GF(25));
g := ChangeRing(f, GF(5)); g; Parent(g);
h := ChangeRing(f, Rationals()); h; Parent(h);
k := ChangeRing(f, GF(25)); k; Parent(k);
f eq h;
ChangeRing(f, Integers()); ChangeRing(x, Integers());
ChangeRing(P!0, GF(5)); ChangeRing(x^5 + 5, GF(5)); ChangeRing(5*x^2, GF(5)); Degree(ChangeRing(x^5 + 5, GF(5)));
R<y> := PolynomialRing(Rationals());
ChangeRing(2*y + 1, Integers());
ChangeRing(y/2 + 1, GF(5)); ChangeRing(y/3 + 1, GF(5)); ChangeRing(y/3 + 1, GF(25));
ChangeRing(f, Rationals());
S<z> := PolynomialRing(GF(5));
ChangeRing(z^2 + 3, Integers()); ChangeRing(z^2 + 3, GF(25)); ChangeRing(z + 1, GF(5^2));
ChangeRing(S, Integers()); ChangeRing(S, Rationals());
// between finite fields: into an overfield, into a subfield, by value into the prime field
F4<a> := GF(4); T<t> := PolynomialRing(F4);
ChangeRing(t^2 + a*t + 1, GF(16));
F16<b> := GF(16);
ChangeRing(t^2 + a*t + 1, F16);
U<u> := PolynomialRing(F16);
ChangeRing(u^2 + b^5*u + 1, F4);
ChangeRing(u^2 + 1, GF(2)); ChangeRing(t + F4!1, GF(2)); ChangeRing(t + F4!1, Integers());
ChangeRing(T!0, GF(8)); ChangeRing(T!0, GF(9)); ChangeRing(T!0, Rationals());
ChangeRing(T!0, GF(16)); ChangeRing(T!a, GF(16));
ChangeRing(T, GF(16)); ChangeRing(T, Integers()); ChangeRing(T, GF(8));
Parent(ChangeRing(t, GF(16))) eq PolynomialRing(GF(16));
PolynomialRing(GF(16)) eq ChangeRing(T, GF(16));
Parent(ChangeRing(x^2, Integers())) eq P;
// descent from GF(2^20), and the map
K<c> := GF(2^20); V<v> := PolynomialRing(K);
ChangeRing(v^2 + c^((2^20-1) div 3)*v + 1, F4);
ChangeRing(v^100 + 1, F4);
Q, m := ChangeRing(P, Rationals());
m(f); Parent(m(f)) eq Q;
S2, m2 := ChangeRing(T, F16); m2; m2(t + a);
