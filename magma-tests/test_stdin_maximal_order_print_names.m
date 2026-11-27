// A maximal order's polynomial is printed in x whatever the field's variable, and is the integral one for a
// polynomial over the rationals; a non-monic polynomial's order is the maximal order of its equation order.
P<t> := PolynomialRing(Integers()); K := NumberField(t^3 - 2); MaximalOrder(K);
Q<u> := PolynomialRing(Rationals()); L := NumberField(u^2 - 1/2); MaximalOrder(L);
M := NumberField(2*t^2 - 3); MaximalOrder(M);
N := NumberField(t^2 - 5); MaximalOrder(N);
F := NumberField(t^7 - 123456*t^5 + 98765*t^3 - 4567*t + 1234567); MaximalOrder(F);
print "end";
