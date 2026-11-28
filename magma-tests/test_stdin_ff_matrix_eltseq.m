// Eltseq of a matrix or vector over a finite field: its entries, row by row, in the field
F := GF(5);
N := Matrix(F, 2, 3, [1,2,3,4,0,1]); S := Eltseq(N); print S, Universe(S), Type(S[1]), #S, &+S;
G := GF(9); w := PrimitiveElement(G);
T := Eltseq(Matrix(G, 2, 2, [w, 1, w^2, 0])); print T, Universe(T);
print Eltseq(N[2]), Universe(Eltseq(N[1]));
Append(~S, F!2); print S;
