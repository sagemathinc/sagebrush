// The shared ring over the rationals cached unnamed, then named: what is derived from its polynomials (a gcd,
// a square-free factorization, a change of ring from the integers) prints by the name it was given.
U := PolynomialRing(Rationals());
f := U.1^2 - 1;
P<x> := PolynomialRing(Rationals());
f, Parent(f);
SquarefreeFactorization((x - 1)^2*(x + 2));
Gcd(x^2 - 1, x^2 + 2*x + 1);
R<y> := PolynomialRing(Integers());
g := ChangeRing(y^2 + 3, Rationals()); g, Parent(g);
Gcd(2*y^2 - 2, 4*y + 4);
SquarefreeFactorization(-6*(y + 1)^2*(y^2 - 3));
Parent(Integral(x)), Integral(3*x^2);
print "end";
