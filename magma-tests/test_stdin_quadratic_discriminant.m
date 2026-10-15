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
