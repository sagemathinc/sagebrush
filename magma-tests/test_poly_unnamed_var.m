// An unnamed univariate polynomial ring's variable prints as P.1 for the
// oldest global P that holds the ring now, and as $.1 when none does.
P := PolynomialRing(Rationals());
P.1 + 1;
P;
Q := P;
P.1;
Q.1;
f := P.1^3 - 1;
g := P.1 - 1;
f div g;
GCD(f, g);
Factorization(P.1^2 - 2);
[P.1, P.1^2];
printf "%o\n", P.1 + 1;
Sprint(P.1);
// a scalar division stays in the ring; GCD and Factorization make monic results
P.1/2;
(P.1 + 1)/3;
GCD(2*P.1^2 - 2, 4*P.1 - 4);
Factorization(2*P.1^2 - 4);
// a rational function is in another structure, which no global names
(P.1 + 1)/(P.1 - 1);
(P.1^2 - 1)/(P.1 - 1);
K := NumberField(P.1^2 - 2);
K;
x := P.1;
P := 5;
x;
Q := 7;
x;
Z := Parent(x);
x;
X := PolynomialRing(Integers());
y := X.1;
y^2 + 2;
(y + 1)/(y - 1);
A := X;
X := 3;
A.1;
AssignNames(~A, ["w"]);
y;
