// intrinsics agents reached for in the first evaluation
// Integers(m): the integers modulo m
R := Integers(10); R; Type(R); a := R!7; a; Type(a); Parent(a);
a + 5; a * 9; a - 9; -a; a^3; a^-1; 3 / a; a^0; R!(-13); R!(3/7);
IsUnit(R!4); IsUnit(a); IsZero(R!20); IsOne(R!11); Order(a); Order(R!9); Order(R!5);
#R; Characteristic(R); [x : x in Integers(4)]; a eq 17; a eq R!7; a eq 8; Integers()!a;
S := Integers(97); &*[S!k : k in [1..96]]; (S!5)^96; Order(S!5);
// vectors, solutions and submatrices
v := Vector([2, -3, 5]); v; Type(v); Parent(v); v[2]; v + v; v - v; -v; 3 * v; v * 2;
w := Vector(Rationals(), [1/2, 1]); w; Type(w); Parent(w); w * Matrix(Rationals(), 2, 2, [2, 0, 1, 3]);
B := Matrix(Integers(), 2, 3, [1, 0, 2, -1, 3, 1]); Vector([1, 1]) * B; Vector([2, -1]) * B;
A := Matrix(Rationals(), 3, 3, [2, 1, 0, 1, 3, 1, 0, 1, 4]); u := Solution(A, Vector(Rationals(), [3, 5, 5])); u; u * A;
Solution(Matrix(Integers(), 2, 2, [3, 1, 1, 2]), Vector(Integers(), [7, 4]));
M := Matrix(Integers(), 3, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
Submatrix(M, 1, 1, 3, 4); Submatrix(M, 2, 3, 2, 2); Submatrix(M, 3, 1, 1, 4); Submatrix(M, 1, 4, 3, 1);
// subsets and the digits of an integer
#Subsets({1..6}); #Subsets({1..6}, 4); #Subsets({}); #Subsets({5, 6}, 3); { #T : T in Subsets({7, 8, 9}) };
&+[ &+T : T in Subsets({1, 2, 3, 4}, 2) ];
Intseq(6, 2, 5); Intseq(6, 2, 2); Intseq(0, 7, 2);
// the symmetric group
G := Sym(4); G; #G; Type(G); p := G!(1, 3, 2, 4); p; Type(p); [i^p : i in [1..4]];
q := G!(1, 2)(3, 4); q; p * q; q * p; p^2; p^-1; p^4; p^q; Order(p); Order(q); Sign(p); Sign(q); Identity(G);
G![4, 3, 2, 1]; Order(G![2, 3, 1, 4]); &+[ Order(x) : x in Sym(4) ]; #{ x : x in Sym(4) | Sign(x) eq 1 };
"end";
