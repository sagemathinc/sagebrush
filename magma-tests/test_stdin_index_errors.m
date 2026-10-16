// reading S[i] outside a sequence, string, tuple or indexed set: Magma's
// words, at the "["
a := [1,2,3];
a[5];
a[0];
a[-1];
b := a[7];
s := "abc"; s[5];
s[0];
t := <1,2>; t[3];
a[2] := 9; a[6] := 1; a;
a[4];
a[7];
e := [ ]; e[1];
e[0];
I := {@ 4, 5 @}; I[3];
I[0];
J := {@ @}; J[1];
c := [ [1,2], [3] ]; c[2][2];
c[1,2];
c[3,1];
c[1,3];
a[[1,9]];
a[1..9];
x := a[1.5];
x := a[true];
a[2], a[6];
// a tuple is not an index; S[i, j] is S[i][j] while it can be indexed
T := [[5,6],[7]]; T[<1,2>];
T[<2>];
T[<>];
T[1,2];
T[1,2,1];
// index lists: of an empty sequence, of a string (the place in the list
// names the index), of a tuple, of an indexed set; undefined elements kept
E := []; E[[2]];
w := "xyz"; w[[2,7]];
w[2..5];
u := <5,6>; u[[1,2]];
u[2..1];
I := {@ 6, 7 @}; I[[2,1]];
I[[1,4]];
I[3..1];
N := {@ @}; N[true];
N[1..0];
V := [5]; V[4] := 9; V[1..4];
V[2..3];
// selections of an empty sequence, explicit lists and steps over undefined
// elements, an empty indexed set's selections
E[1..0];
E[[]];
V[[1,2]];
V[[4,1]];
V[4..1 by -1];
V[1..4 by 3];
N[[1]];
N[[true]];
N[[]];
// typed empty collections, and a selection's universe
S := [Integers()|]; S[[1]];
S[1..0];
T := {@ Integers() | @}; T[[1]];
T[1];
U := {@ Rationals() | 2, 5 @}; V := U[[1]]; Universe(V);
W := U[1..0]; Universe(W);
X := [Rationals() | 2, 5]; Universe(X[[1]]); Universe(X[1..0]);
Y := [Rationals() | ]; Y[1];
// an inferred universe kept; an empty range selected from
A := {@ 2, 5/2 @}; Universe(A[[1]]); Universe(A[1..0]);
B := [ 2, 5/2 ]; Universe(B[[1]]); Universe(B[1..0]);
R := [1..0]; R[[1]];
R[1..1];
// the inferred universe of integers too, and of a sequence with holes
Universe(A[[]]); Universe(A[2..1]);
P := [2/3]; P[3] := 5/4; Universe(P[2..2]); Universe(P[[]]);
C := [2,5]; Universe(C[[]]); Universe(C[[1]]);
Q := [1..2]; Universe(Q[[]]); Universe(Q[[1]]);
Universe(R[1..0]);
G := {@ 2/3, 1 @}; Universe(G[[]]);
// a universe is fixed when made: what doesn't go in is refused, never widened
I := [2,5]; I[1] := 1/3;
I;
T := [2,5][[]]; T[1] := "x";
K := [2/3,5]; K[1] := 4; Universe(K); Universe(K[[]]); K := Append(K, 1/2); K;
J := [Integers() | 2, 5]; J[2] := 1/2;
R := [1..3]; R[1] := 1/2;
Universe(Reverse([2/3, 1]));
Universe(Reverse([Rationals() | 1, 2]));
L := [2/3, 1]; L := Exclude(L, 2/3); Universe(L);
M := [Rationals() | 1]; M := Include(M, 3); Universe(M);
E := []; E := Append(E, 1/2); E[1] := 4; Universe(E);
// a refused write changes nothing; the first defined value fixes the
// universe, after holes too; a sequence of sequences takes a whole new
// element only into its elements' universe
I := [2,5]; I[4] := 1/3;
I;
T := [Integers()|]; T[3] := 1/2;
T;
S := []; S[3] := 2; S[4] := 1/2;
S;
S[1] := "x";
U := []; U[3] := 2/3; U[3] := 4; Universe(U);
A := [[2,5],[3,4]]; A[1] := [1/3,5];
A;
B := [[2/3,5],[3,4]]; B[1] := [6,7]; B[1][1] := 1/2; B;
C := []; C[1][1] := 2;
D := [[2,5],[3,4]]; D[3][2] := 1/2;
D;
D[3][2] := 7;
F := [[2,5]]; F[3] := [1]; F;
G := [1]; G[3][1] := 2;
H := [[2,5],[3]]; H[2][3] := 9; H;
K := [[2,5]]; K[1] := 3;
// one recursive admission for tuples, every kind of set and nested sequences (CORR-400-1/2);
// Append and Include refusals are in test/magma.test.ts (their caret is at the call)
A := [<2,"p">];
A[1] := <3/1,"q">; A;
A[1] := <5,7>;
A;
Append(~A, <6,"r">); A;
B := [{2,3}];
Include(~B, {8});
B;
B[1] := {* 6, 6 *}; B;
C := [{@ 4 @}];
Append(~C, {9}); C;
D := [<[2],5>];
D[1] := <[1/3],5>;
D[1] := <[4],8>; D;
E := [[[3]]];
Append(~E, [[11]]); E;
F := [[true]];
F[1] := [3];
F;
G := [["u"]];
G[1] := [1]; G;
H := [{* 2 *}];
H[1] := {3, 4}; H;
// after leading holes, the first defined element fixes the universe (HARD-400-1)
S := []; S[3] := "x";
4 in S;
"y" in S;
Append(~S, "z"); #S;
T := []; T[2] := <1,"a">;
T[5] := <2,3>;
T[5] := <2,"b">; #T;
// coercion into a finite field, and into a child emptied of its elements (CORR-9348-1, CORR-9348-FU1)
K := GF(11);
A := [K|4,6]; A[1] := 7; A; Universe(A);
A[2] := 2/3; A;
A[2] := 1/11;
B := [K!4, K!6]; B[2] := 9; B; Parent(B[2]);
C := [[K|4,6]]; C[1] := [8,9]; C; Parent(C[1][1]);
D := [K|]; D[2] := 5; Parent(D[2]);
Append(~A, 10); A;
Include(~B, 3); B;
E := [3,5]; E[1] := K!7; E; Parent(E[1]);
F := [1/2]; F[1] := K!7;
L := GF(5);
G := [K|4]; G[1] := L!2;
H := [K!4]; H[1] := L!2;
M := GF(11, 2);
P := [M|1]; P[1] := 5; P; Parent(P[1]);
Q := [M.1]; Q[1] := 6; Parent(Q[1]);
R := [["q"]]; Remove(~R[1], 1); R;
Append(~R, ["w"]); R;
T := [["q"]]; Remove(~T[1], 1); T[1] := [3];
T;
// an empty sequence or indexed set over a finite field coerces into it
D := [K|]; Append(~D, 5); Parent(D[1]);
D2 := [K|]; Include(~D2, 1/2); D2; Parent(D2[1]);
D3 := [K|]; D3[1] := 1/11;
I := {@ K | @}; Include(~I, 4); Parent(I[1]);
// a copy keeps the element standing for its universe (CORR-47D-1)
S := [<2/3,"q">]; S[1] := <4,"r">; T := S; T[1] := <1/3,"s">; S; T;
S2 := [<2/7,"q">]; S2[1] := <5,"r">; T2 := Append(S2, <6,"s">); T2[1] := <1/7,"t">; T2;
S3 := [<3/5,"q">]; S3[1] := <2,"r">; T3 := Include(S3, <9,"z">); T3[1] := <1/5,"t">; T3;
S4 := [<3/5,"q">]; S4[1] := <2,"r">; T4 := Reverse(S4); T4[1] := <1/5,"t">; T4;
// a selection keeps the element standing for its universe (CORR-765-2)
S := [<2/3,"q">]; S[1] := <4,"r">; T := S[1..1]; T[1] := <1/3,"s">; T;
U := S[[1]]; U[1] := <1/9,"v">; U;
V := S[[]]; Append(~V, <1/4,"w">); V;
