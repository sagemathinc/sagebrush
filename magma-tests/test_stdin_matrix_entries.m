// a matrix's entries A[i, j] and rows A[i], also of the matrices arithmetic makes
A := Matrix(Rationals(), 2, 2, [2, 1, 5, 3]); B := A^-1;
printf "%o %o %o %o\n", B[1,1], B[1,2], B[2,1], B[2,2];
A[1,1]; A[2,1]; B[1,2]; A[2]; B[2];
C := Matrix(Integers(), 2, 3, [1, -2, 3, 4, 5, -6]); D := C * Transpose(C);
C[2,3]; D[1,2]; D[2,2]; (C * Transpose(C))[2,1]; (A^2)[1,2]; (A * B)[2,2]; (A^-2)[2,1]; Transpose(C)[3,2];
E := Matrix(Rationals(), 3, 3, [1/2, 0, 1, 2, 3, 0, 0, 1, 4]); F := E^-1; F[1,1]; F[3,2]; (E * F)[3,3]; &+[ F[i,i] : i in [1..3] ];
[ D[i,j] : i, j in [1..2] ]; [ C[2,j] : j in [1..3] ];
// assigned, as Magma does: a new value of A, with the entry in A's ring
A[1,1] := 7; A; A[2][2] := 1/2; A; G := A; A[1,2] := -1; G; A;
C[1,3] := 9; C; C[2][1] := -4; C;
for i in [1..2] do C[i,i] := 0; end for; C;
"end";
