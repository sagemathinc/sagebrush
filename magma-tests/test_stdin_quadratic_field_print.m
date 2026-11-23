// QuadraticField(d)'s defining polynomial lives in the session's polynomial ring over the integers, as Magma 2.18-5
// has it: printed as $.1 while that ring is unnamed and no variable holds it, as P.1 when P holds it, and in its
// name once named (also for a field made before).
K := QuadraticField(5);
print K;
Q := PolynomialRing(Rationals());
print QuadraticField(-1);
P := PolynomialRing(Integers());
print K;
print QuadraticField(-3);
P2<w> := PolynomialRing(Integers());
print K;
print QuadraticField(12);
print NumberField(w^2 - 5);
Z<t> := PolynomialRing(Integers());
print K, QuadraticField(-7);
print Discriminant(K), Discriminant(QuadraticField(12));
print "end";
