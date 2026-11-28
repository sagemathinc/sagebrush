// Insert past the end (undefined elements), multiset meet/diff by multiplicities,
// Numerator/Denominator of number field elements, matrices and vectors, Eltseq of a matrix
S := [1,2];
T := Insert(S,5,9); print #T, T, S;
U := [1,2]; Insert(~U,5,9); print #U, U;
print Insert([1,2], 3, 9), Insert([1,2], 1, 9), Insert([Integers()|], 3, 7);
V := [1, 2]; V[6] := 4; print Insert(V, 4, 0);
A := {* 1,1,2 *}; B := {* 1 *};
print A meet B, B meet A, A diff B;
print #(A meet B), #(B meet A), #(A diff B);
C := {* 1, 1, 1, 2, 2, 5 *}; D := {* 1, 1, 2, 2, 2, 2, 7 *};
print C meet D, C diff D, D diff C, C join D;
print {1,2} meet {2,3}, {1,2} diff {2};
P<x> := PolynomialRing(Rationals());
K<a> := NumberField(x^3-2);
z := (a+1)/2;
print Denominator(z), Numerator(z), Eltseq(Numerator(z));
print Denominator(a^2/6 + a/4 + 1/3), Numerator(a^2/6 + a/4 + 1/3), Denominator(K!5), Numerator(K!(3/7));
M := Matrix(Rationals(),2,2,[1/2,1/3,1/4,1/5]);
print Denominator(M);
print Denominator(Matrix(Integers(), 2, 2, [1,2,3,4])), Denominator(Matrix(Rationals(), 1, 2, [3, 5]));
N := Matrix(Integers(),2,3,[1,2,3,4,5,6]);
print #Eltseq(N), Eltseq(N), &+Eltseq(N);
print Eltseq(M), Eltseq(Matrix(Rationals(), 0, 2, []));
print Insert([1,2], 0, 9);
print Insert([1,2], -1, 9);
print Numerator(Matrix(Rationals(),1,2,[1/2,1/3]));
print Numerator(Matrix(Integers(),1,2,[1,2]));
print Denominator(Vector(Rationals(),[1/2,1/3])), Universe(Eltseq(N)), Universe(Eltseq(M));
// a grid: every pair of small multisets over {1, 2, 3} (multiplicities 0..2), meet and diff
ms := [];
for a in [0..2] do for b in [0..2] do for c in [0..2] do
  Append(~ms, {* Integers() | 1 : j in [1..a] *} join {* 2 : j in [1..b] *} join {* 3 : j in [1..c] *});
end for; end for; end for;
print #ms, [ #(A meet B) : A, B in ms ];
print [ #(A diff B) : A, B in ms ];
print &and[ (A meet B) eq (B meet A) : A, B in ms ], &and[ #(A diff B) + #(A meet B) eq #A : A, B in ms ];
// insertion at every position 1..7 of sequences of lengths 0..3
print [ [ #Insert([Integers() | 7 : j in [1..n]], i, 0) : i in [1..7] ] : n in [0..3] ];
print [ Insert([7, 9], i, 0) : i in [1..5] ];
U := [4, 5]; for i in [1..3] do Insert(~U, 2*i + 2, i); end for; print U, #U;
// Eltseq of a matrix: its universe is the matrix's ring, as Magma's
M := Matrix(Integers(),1,2,[1,2]); S := Eltseq(M);
print Universe(S) eq Integers(), Type(Universe(S)), Type(S[1]), Universe(S);
N := Matrix(Rationals(),1,3,[1,1/2,3]); T := Eltseq(N);
print Universe(T) eq Rationals(), Type(Universe(T)), Type(T[1]), Type(T[2]), Universe(T);
U := Eltseq(Matrix(Rationals(),0,2,[])); print U, Universe(U);
print Eltseq(N) cat [Rationals() | 7];
Append(~S, 3); print S, Universe(S);
Append(~T, 1/4); print T;
// Insert's position: Magma's bound (2^30) and argument types
print Insert([1,2], 2^30, 9);
print Insert([1,2], true, 9);
print Insert([1,2], 3/1, 9);
print #Insert([1,2], 1000, 9);
