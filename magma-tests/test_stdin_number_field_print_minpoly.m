// A number field printed after other values stays on their line, and a minimal polynomial is in the session's ring
// over the rationals, as Magma 2.18-5 has them.
K := QuadraticField(5);
L := QuadraticField(5);
print L eq K, K;
print 1, K;
print K, 1;
1, K;
K;
P<x> := PolynomialRing(Rationals());
M := NumberField(x^3 - 2);
print 1, M;
print M, 2;
print 1, 2, M;
Q<q> := QuadraticField(5);
MinimalPolynomial(Q.1);
Parent(MinimalPolynomial(Q.1));
MinimalPolynomial(q + 1);
MinimalPolynomial(Q!2);
W<w> := QuadraticField(-3);
MinimalPolynomial(w);
R<y> := PolynomialRing(Rationals());
MinimalPolynomial(w);
MinimalPolynomial(M.1);
MinimalPolynomial(M.1^2 + 1);
print "end";
