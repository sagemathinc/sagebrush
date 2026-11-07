// An unnamed polynomial ring over Z or GF(5): an exact division and a GCD go through the ring over Q in the same
// unnamed variable, an internal ring that must not meet the user-name check (grader's r776e IT1).
R := PolynomialRing(Integers());
f := R.1^2 - 1;
f div (R.1 - 1);
GCD(f, 2*R.1 - 2);
Quotrem(f, R.1 + 1);
S := PolynomialRing(GF(5));
h := S.1^2 + 1;
h div (S.1 - 2);
GCD(h, S.1 - 2);
