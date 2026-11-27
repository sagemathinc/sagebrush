// A polynomial over the integers div and mod an integer, as Magma 2.18-5 does it: coefficient by coefficient, with
// floor division (the remainder has the divisor's sign).  (A session: an error is reported and the input goes on.)
P<x> := PolynomialRing(Integers());
print x div 2;
print (3*x + 6) div 3;
print (3*x + 7) div 2;
print (3*x + 7) mod 2;
print (-3*x - 7) div 2;
print (-3*x - 7) mod 2;
print (3*x + 7) div -2;
print (3*x + 7) mod -2;
print (5*x^2 + 3*x + 7) div 3, (5*x^2 + 3*x + 7) mod 3;
f := 5*x^2 + 3*x + 7;
print f eq 3*(f div 3) + (f mod 3);
print P!7 div 2, P!7 mod 2;
print P!0 div 5, P!0 mod 5;
q, r := Quotrem(3*x + 7, P!2);
print q, r;
print (3*x + 7) div 0;
print (3*x + 7) mod 0;
print "end";
