// Evaluate of a polynomial over a finite field at an element of another field of its characteristic: in the
// smallest field containing both, as Magma 2.18-5 does.
F<a> := GF(4);
K<b> := GF(16);
f := MinimalPolynomial(b, F);
print f;
print Evaluate(f, b), Evaluate(f, b^2);
print Parent(Evaluate(f, b));
P<x> := PolynomialRing(F);
g := x^3 + a*x + 1;
print [Evaluate(g, b^i) : i in [0..5]];
print Evaluate(P!0, b), Parent(Evaluate(P!0, b));
print Evaluate(P!a, b), Parent(Evaluate(P!a, b));
Q<y> := PolynomialRing(GF(2));
print Evaluate(y^4 + y + 1, b), Parent(Evaluate(y^4 + y + 1, b));
// a field neither in the other: their compositum
L<c> := GF(8);
z := Evaluate(x^2 + a*x, c);
print z;
print Parent(z);
print Evaluate(x + a, c);
// the polynomial's field the larger one: the subfield's element goes up
R<t> := PolynomialRing(K);
print Evaluate(t + b, a), Parent(Evaluate(t + b, a));
