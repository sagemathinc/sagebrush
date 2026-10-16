// Finite fields: GF(q), GF(p, n), FiniteField; elements, printing, intrinsics.
// Read on stdin (a session), so that the errors don't stop it.
K := GF(11);
K;
Type(K), #K, Characteristic(K), Degree(K);
[ x : x in K ];
a := K!25;
a, Type(a), Parent(a) eq K;
a + 7, a * 9, a^-1, a / 3, -a, a^10;
K!(2/5), K!(-3);
Integers()!(K!8);
[ Integers()!PrimitiveElement(GF(p)) : p in [2, 3, 5, 7, 11, 23, 41, 101, 257] ];
Order(K!3), Order(K!10), IsPrimitive(K!2), IsPrimitive(K!3);
Log(K!7), Log(K!3, K!4), Log(K!3, K!2);
IsSquare(K!5), IsSquare(K!6), Sqrt(K!3);
[ Sqrt(x) : x in GF(19) | x ne 0 and IsSquare(x) ];
// GF(p^n), named and not
F<t> := GF(5, 3);
F;
[ x : x in GF(4) ];
t^7, t^124, t^200, t + t^2, 2*t^3 + 1, 1/t;
Eltseq(t^10), Eltseq(F!3);
F![1, 0, 2];
F!(GF(5)!4);
Order(t^4), Log(t^31), Log(t^2, t^10);
Trace(t), Norm(t), Trace(t^62), Norm(F!2);
IsSquare(t), IsSquare(t^2);
Sqrt(t^6), Sqrt(t^90);
#F, Characteristic(F), Degree(F);
PrimitiveElement(F) eq t;
// naming the generator again renames it everywhere
G<u> := GF(5, 3);
t^3;
F eq G;
H := GF(2^6);
H.1^20;
GF(3^4).1^50;
// beyond 2^20 elements: polynomials in the generator
B := GF(2^21);
B.1^30;
L<z> := GF(1031^2);
z^7;
GF(7, 4)!0, GF(7, 4)!1;
// a finite field's element with integers, rationals, its prime field or
// an extension, and what Magma refuses
F := GF(19); E<e> := GF(19^2); x := F!3; G := GF(7);
x eq 3; x eq 22; x ne 0; x + 1/2; x eq 1/2;
x/2; x - 1/3; 1/3 - x; (2/5) * x; x / (1/4);
x + e; x eq e; x eq E!3; x / e; e - x;
x + 1/19;
x + G!2;
x + 1.5;
[ Sqrt(y) : y in GF(19) | y ne 0 and IsSquare(y) ];
// powers, div and mod, membership, sequences, collections (Magma's rules)
F<a> := GF(9); P := GF(3);
GF(3, 2);
a^(1/2);
a^2;
(P!2) div 2;
a div a;
a mod 2;
2 div a;
1 in F; (P!1) in F; (F!1) in P; a in P;
(GF(5)!1) in F;
1/2 in F;
2.5 in F;
F![1/2, 2];
F![a, 0];
F![1, 2];
F![P!1, P!2];
F![a];
[GF(3)!1, GF(5)!1];
[P!1, a];
[1, a];
Log(F!1, F!1);
Log(a^2, a);
// Random and iteration without all the field's elements
F := GF(1000003); x := Random(F); x in F;
exists(t){ y : y in F | y^2 eq 4 }; t;
r := Random(GF(3^5)); r in GF(3^5);
Random({* 7, 7, 7 *});
Random([1..10^30]) le 10^30;
