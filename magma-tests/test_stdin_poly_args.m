// polynomial, finite field and real intrinsics at the edges of their
// arguments, as Magma takes them (their refusals: test/magma.test.ts)
P<x> := PolynomialRing(Integers()); Q<t> := PolynomialRing(Rationals());
Coefficients(P!0); Coefficients(Q!0); Coefficient(x^2 + 3, 5);
IsIrreducible(P!7); IsIrreducible(Q!(2/3)); IsIrreducible(-x); IsIrreducible(3*x + 6); IsIrreducible(3*t + 6);
Derivative(x^4 + 2*x, 0); Derivative(x^4 + 2*x, 2); Derivative(x^4 + 2*x, 9); Derivative(P!3, 4); Derivative(t^3/6, 3);
Roots(9*x^2 - 4); Roots(9*x^2 - 4, Rationals()); Roots(t^2 - 9/4, Rationals()); Roots(t^2 - 9, Integers());
Roots((x + 3)^3 * (x - 5), Integers());
Log(3.0, 81.0); Log(10.0, 0.001); Log(RealField(10)!2, RealField(20)!32); Log(RealField(10)!2, RealField(10)!32); Log(RealField(10)!3, 2.0);
"end";
