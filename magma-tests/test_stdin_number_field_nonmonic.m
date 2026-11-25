// Number fields of a non-monic or rational polynomial, as Magma 2.18-5 has them: over the rationals the field is
// defined by the polynomial made monic, over the integers by the polynomial as given; the generator is its root,
// elements print and give coordinates on its powers, and Discriminant(K) is the primitive integral polynomial's.
P<x> := PolynomialRing(Rationals());
K<a> := NumberField(3*x^2 + 1);
K;
a^2;
Discriminant(K);
Eltseq(a/2 + 1);
K![1, 2];
(a + 1)^2;
(a + 1)/(a - 1);
Norm(a); Trace(a);
Degree(K);
MaximalOrder(K);
Integers(K);
Signature(K);
ClassNumber(K);
M<c> := NumberField(2*x^3 - 1/2*x + 5);
M;
c^3;
Discriminant(M);
Eltseq(c^2/3);
L := NumberField(x^2 - 1/2);
L;
L.1^2;
Discriminant(L);
MaximalOrder(L);
R<y> := PolynomialRing(Integers());
N<b> := NumberField(2*y^2 - 3);
N;
b^2;
Discriminant(N);
Eltseq(b/2);
N2 := NumberField(3*y^3 - 2);
N2;
N2.1^3;
Discriminant(N2);
K eq NumberField(x^2 + 1/3);
// over the integers the polynomial is made primitive with a positive leading coefficient: 4*x^2 + 2 is 2*x^2 + 1
Z<x> := PolynomialRing(Integers());
K := NumberField(-x^2 + 2); K; MaximalOrder(K); Discriminant(K);
K := NumberField(4*x^2 + 2); K; MaximalOrder(K); Discriminant(K);
K := NumberField(6*x^2 + 4*x + 2); K; MaximalOrder(K); Discriminant(K);
K<b> := NumberField(-2*x^2 + 7); K; b^2; Eltseq(b); MaximalOrder(K); Discriminant(K);
for f in [6*x^2 + 2, -2*x^2 + 3, 3*x^2 + 3*x + 1, 3*x^3 - 2] do
    K<a> := NumberField(f);
    K; a^2; a^3; Eltseq((a + 1)^2/2); Eltseq(1/(a + 1)); Norm(a); Trace(a); Discriminant(K); MaximalOrder(K);
end for;
P<x> := PolynomialRing(Rationals());
for f in [6*x^2 + 2, -2*x^2 + 3, 3*x^2 + 3*x + 1, 2/3*x^3 + 1/6*x + 1] do
    K<a> := NumberField(f);
    K; a^2; a^3; Eltseq((a + 1)^2/2); Eltseq(1/(a + 1)); Norm(a); Trace(a); Discriminant(K); MaximalOrder(K);
end for;
print "end";
