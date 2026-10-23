// Finite fields, F2 of plan-finite-fields: PrimeField, Generator,
// DefiningPolynomial, IsSubfield, Embed, Trace, Norm, MinimalPolynomial,
// CharacteristicPolynomial (absolute and relative), Root and ext< >.
F<a> := GF(4); K<b> := GF(16); E<c> := GF(8); L<d> := GF(64); P := GF(7); Q<e> := GF(3^4);
PrimeField(F); PrimeField(K); PrimeField(P); PrimeField(Q);
Generator(F); Generator(K); Generator(P); Generator(GF(2)); Generator(K, F); Generator(K, K); Generator(K, GF(2));
DefiningPolynomial(F); DefiningPolynomial(K); DefiningPolynomial(P); DefiningPolynomial(GF(2)); DefiningPolynomial(GF(5));
DefiningPolynomial(GF(9)); DefiningPolynomial(GF(3^5)); DefiningPolynomial(Q);
Parent(DefiningPolynomial(K));
DefiningPolynomial(K, F); DefiningPolynomial(K, GF(2)); DefiningPolynomial(K, K); DefiningPolynomial(L, F); DefiningPolynomial(L, E);
IsSubfield(F, K); IsSubfield(E, K); IsSubfield(K, F); IsSubfield(GF(2), K); IsSubfield(K, K); IsSubfield(GF(3), K); IsSubfield(GF(9), GF(16));
Embed(F, K); Embed(F, F); Embed(GF(2), L);
// absolute
for x in [b, K!0, K!1, b^5, b^7] do Trace(x), Norm(x), MinimalPolynomial(x), CharacteristicPolynomial(x); end for;
for x in [e, Q!0, Q!2, e^10, e^20, e^41] do Trace(x), Norm(x), MinimalPolynomial(x), CharacteristicPolynomial(x); end for;
Trace(P!3); Norm(P!3); MinimalPolynomial(P!3); CharacteristicPolynomial(P!3);
Parent(Trace(b)); Parent(Norm(e)); Parent(MinimalPolynomial(b)); Parent(Trace(P!3));
// relative, towers 2 | 4 and 1 | 2 | 6
Trace(b, F); Norm(b, F); MinimalPolynomial(b, F); CharacteristicPolynomial(b, F);
Trace(K!a, F); Norm(K!a, F); MinimalPolynomial(K!a, F); CharacteristicPolynomial(K!a, F);
Trace(K!0, F); Norm(K!0, F); MinimalPolynomial(K!0, F);
Parent(Trace(b, F)); Parent(MinimalPolynomial(b, F));
Trace(b, K); Norm(b, K); MinimalPolynomial(b, K); CharacteristicPolynomial(b, K);
Trace(b, GF(2)); Norm(b, GF(2)); MinimalPolynomial(b, GF(2));
Trace(d, F); Norm(d, F); MinimalPolynomial(d, F); CharacteristicPolynomial(d, F);
Trace(d, E); Norm(d, E); MinimalPolynomial(d, E); CharacteristicPolynomial(d, E);
Trace(d^9, E); Norm(d^9, E); MinimalPolynomial(d^9, E); CharacteristicPolynomial(d^9, E);
Trace(d^21, F); MinimalPolynomial(d^21, F); CharacteristicPolynomial(d^21, F);
MinimalPolynomial(e^10, GF(9)); Trace(e, GF(9)); Norm(e, GF(9));
Trace(P!3, P); Norm(P!3, P); MinimalPolynomial(P!3, P);
// laws: the trace is additive, the norm multiplicative, transitive in towers
[Trace(x + y) eq Trace(x) + Trace(y) : x, y in [b, b^3, b^11]];
[Norm(x * y) eq Norm(x) * Norm(y) : x, y in [e, e^7, e^30]];
[Trace(Trace(x, F)) eq Trace(x) : x in [b, b^2, b^9, K!1]];
[Norm(Norm(x, F)) eq Norm(x) : x in [b, b^2, b^9, K!1]];
[Trace(Trace(x, E)) eq Trace(x) : x in [d, d^5, d^9]];
// roots
P13 := GF(13);
Root(P13!8, 5); Root(P13!2, 5); Root(P13!0, 2); Root(P13!1, 7);
Root(b, 2); Root(b^3, 2); Root(b, 7); Root(b^3, 4); Root(K!0, 3);
Root(e^2, 2); Root(e^4, 2); Root(Q!2, 2); Root(Q!1, 2); Root(e, 3); Root(e^3, 7);
Root(P!2, 2); Root(P!4, 2); Root(GF(11)!5, 2); Root(GF(9)!2, 2);
Root(P13!4, 25);
[Root(x, 2)^2 eq x : x in [e^2, e^6, e^50]];
// ext
G := ext<F | 2>; G; DefiningPolynomial(G); G eq K;
H<h> := ext<GF(3) | 4>; H; DefiningPolynomial(H); h^10; H eq Q;
G2<g>, m := ext<F | 3>; G2; m; m(a); g^21 eq m(a); Degree(G2); PrimeField(G2);
ext<GF(7) | 1>;
ext<F | 2>;
ext<GF(5) | 2>;
