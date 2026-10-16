// Discriminant of a number field: its defining polynomial's (the equation
// order's), not the maximal order's
Zx<x> := PolynomialRing(Integers());
K := NumberField(x^3 - 9*x - 9);
Discriminant(K);
Discriminant(MaximalOrder(K));
Discriminant(x^3 - 9*x - 9);
L := NumberField(x^2 - 12);
Discriminant(L), Discriminant(MaximalOrder(L));
// QuadraticField(d): Q(sqrt(s)), s the squarefree part of d
for d in [12, 8, -4, -12, -1, 5, -3, 18, 2, -27, 1000] do
  Q := QuadraticField(d);
  print d, Discriminant(Q), Discriminant(MaximalOrder(Q)), Q.1^2;
end for;
QuadraticField(12);
QuadraticField(-27);
// their types
K := NumberField(x^3 - 2); O := MaximalOrder(K);
Type(K); Type(O); Type(K.1);
Q := QuadraticField(5); OQ := MaximalOrder(Q);
Type(Q); Type(OQ); Type(Q.1);
// the squarefree part by bounded work: two primes above the trial bound,
// a square of one, a large prime
p := NextPrime(10^6); q := NextPrime(2*10^6);
Q := QuadraticField(p*q); Discriminant(Q), Discriminant(MaximalOrder(Q));
Q := QuadraticField(3*p^2); Discriminant(Q);
Q := QuadraticField(NextPrime(10^40)); Discriminant(Q);
Q := QuadraticField(5 * NextPrime(10^30)^2); Discriminant(Q);
// within the 1024-bit cap: a 521-bit prime, 2^479 times it (1000 bits),
// and a square of a 127-bit prime times 3
Discriminant(QuadraticField(2^521 - 1)) eq 4*(2^521 - 1);
Discriminant(QuadraticField(2^479 * (2^521 - 1))) eq 8*(2^521 - 1);
Discriminant(QuadraticField(3 * (2^127 - 1)^2));
