// R0a rational function fields.  Printing and answers are a black-box
// Magma 2.18-5 oracle fixture (2026-10-22); no Magma source was inspected.
Q := Rationals(); P<t> := PolynomialRing(Q);
A<a> := FunctionField(Q); B<b> := FieldOfFractions(P); C<c> := RationalFunctionField(Q);
A eq B; A eq C; A.1; B.1; C.1; t;
Type(A); Type(c); Parent(c) eq A;
ISA(Type(A), Fld); ISA(Type(A), Rng); ISA(Type(A), Str);
ISA(Type(c), FldFunRatElt); ISA(Type(c), FldElt); ISA(Type(c), RngElt);
A; BaseRing(A); BaseField(A); CoefficientRing(A); IntegerRing(A); Characteristic(A);
f := (c^2 + 1)/(c - 1); f;
Numerator(f); Denominator(f); Degree(f); Degree(c^-3);
Evaluate(f, 2); Derivative(f); Derivative(c^3, 2);
Degree(A!0); Degree(Derivative(A!7)); Degree(f-f);
Degree(c/(c+1) - c/(c+1));
(123456789012345678901234567890123456789012345678901234567890123456789*c+1)/(c+1);
A![t, t-1]; A!t; A!1/2; A![1,2,3];

k := GF(5); U<u> := PolynomialRing(k); K<x> := FunctionField(k);
K; Type(K); Type(x); BaseRing(K); BaseField(K); CoefficientRing(K);
IntegerRing(K); Characteristic(K); U eq IntegerRing(K); FieldOfFractions(U) eq K;
g := (x + 1)/(x^2 + 1); g; Numerator(g); Denominator(g); Derivative(g);
Degree(K!0);
K![1,2]; K![u,u-1];

Z := Integers(); R<z> := PolynomialRing(Z);
L<v> := FieldOfFractions(R); M<w> := FunctionField(Z); N<n> := RationalFunctionField(Z);
L eq M; M eq N; L.1; M.1; N.1; z;
N; BaseRing(N); CoefficientRing(N); IntegerRing(N); Characteristic(N);
Numerator(N!1/2); Denominator(N!1/2); N![z,z-1];
zf := 1/(2*n + 1); zf; Derivative(zf);

H<s> := FunctionField(RationalField()); S<y> := IntegerRing(H);
h := ((s + 1)^8 - 1) / ((s^3 - 1)*(s + 1)^2*(s^2 - 4)^2);
SD := SquarefreePartialFractionDecomposition(h); SD;
&+[H!q[3] / H!q[1]^q[2] : q in SD] eq h;
D := PartialFractionDecomposition(h); D;
&+[H!q[3] / H!q[1]^q[2] : q in D] eq h;

J<r> := FunctionField(IntegerRing()); T<q> := IntegerRing(J);
j := 1/(r^2 - 1); SquarefreePartialFractionDecomposition(j); PartialFractionDecomposition(j);
"end";
