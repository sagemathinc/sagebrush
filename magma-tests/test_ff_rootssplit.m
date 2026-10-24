// RootsInSplittingField, F3 of plan-finite-fields: the roots of a polynomial
// over a finite field in its splitting field (the lcm of its factors'
// degrees over the coefficient field), with multiplicities, and that field.
P<x> := PolynomialRing(GF(5));
RootsInSplittingField(x^2 + 2);
RootsInSplittingField(x^3 + x + 1);
RootsInSplittingField((x^2 + 2)^2);
RootsInSplittingField((x^2 + 2)*(x^3 + x + 1));
RootsInSplittingField(x^2 - 1);
RootsInSplittingField(x - 1);
RootsInSplittingField(P!3);
RootsInSplittingField((x^2 + 2)*(x - 1));
RootsInSplittingField((x^2 + 2)*(x - 1)^3*(x + 1));
RootsInSplittingField(3*x^2 + 1);
RootsInSplittingField(x^5 - x);
RootsInSplittingField(x^25 - x);
RootsInSplittingField(x^4 + 2);
RootsInSplittingField(x^2); RootsInSplittingField(x^5); RootsInSplittingField(x^10 - 1);
Q<y> := PolynomialRing(GF(2));
RootsInSplittingField(y^4 + y + 1);
RootsInSplittingField(y^2 + y + 1);
RootsInSplittingField((y + 1)^2);
RootsInSplittingField(y^3 + y + 1);
F<w> := GF(25); S<s> := PolynomialRing(F);
RootsInSplittingField(s^2 + w);
RootsInSplittingField(s - w);
RootsInSplittingField(s^3 + s + w);
F4<a> := GF(4); T<t> := PolynomialRing(F4);
RootsInSplittingField(t^2 + t + a);
L<c> := GF(16);
RootsInSplittingField(t^2 + t + a);
Parent(RootsInSplittingField(x^2 + 2)[1][1]);
R2<z> := PolynomialRing(GF(2));
RootsInSplittingField(z^5 + z^2 + 1);
RootsInSplittingField((z^5 + z^2 + 1)*(z^2 + z + 1));
