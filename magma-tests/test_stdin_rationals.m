// a rational stays a rational when it is integral: type, parent, universe
// (CORR-765-1)
x := 9/3; x; Type(x); Parent(x);
y := Rationals()!7; y; Type(y); Parent(y); y eq 7; Universe([y]);
z := Rationals()![12, 4]; z; Type(z);
w := 5/1; Type(w); Type(w + 2); Type(w * 3); Type(w - w); Type(-w); Type(Abs(w));
Type(Floor(w)); Type(Ceiling(w)); Type(Numerator(w)); Type(Denominator(w));
// in sequences and sets over the rationals
S := [Rationals()| 6]; S; Type(S[1]); Parent(S[1]); Universe([S[1]]);
T := [1/3, 8]; T; Type(T[2]); Universe(T);
T[1] := 5; Type(T[1]);
Append(~T, 2); Type(T[3]);
Insert(~T, 1, 4); Type(T[1]);
U := T[2..3]; Type(U[1]);
V := T; Type(V[2]);
N := [[1/5, 3]]; Type(N[1][2]);
P := [<1/7, 2>]; Type(P[1][1]);
Q := <2/9, [1/2, 6]>; Type(Q[2][2]);
I := {@ 1/4, 3 @}; Type(I[2]);
J := { 1/6, 10 }; 10 in J;
K := {* 1/8, 2, 2 *}; #K;
E := [3, 11]; E[1] := 12/4; Type(E[1]); E;
// arithmetic, comparison, sets and coercion back to the integers
a := 12/3;
a eq 4; a lt 5; a + 1; a * a; a / 2; Type(a / 2);
{a, 4}; #{a, 4};
Integers()!a; Type(Integers()!a);
[1..a];
a ^ 2; Type(a ^ 2);
// integer-only operations refuse a rational, an integral one too
a div 1;
7 div a;
a mod 3;
S[a];
// (the intrinsics' refusals are in test/magma.test.ts: their caret is at
// the call)
// a rational power is a real
3^(1/2);
Type((9/1)^(2/1)); (9/1)^(2/1);
(1/9)^(1/2);
9^(1/2); Type(9^(1/2));
(-27)^(1/3);
3^(-2/1); Type(3^(-2/1));
(3/5)^(-2); Type((3/5)^(-2));
0^(1/3);
2^a; Type(2^a);
