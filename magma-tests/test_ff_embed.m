// Subfields of finite fields (GF(p^m) in GF(p^n) for m | n, by Conway
// polynomials) and the smallest field containing two: arithmetic, eq,
// in, ! and collections, as Magma's.  Sagebrush's own inputs.
F<a> := GF(4); K<b> := GF(16); E<c> := GF(8); P := GF(2);
// nested: up and down
a*b^3; a - b; b / a; a^2 + b; Parent(a*b); a eq K!a; K!a eq a; a ne b;
F!(b^5); F!(b^10); K!a; a in K; b^5 in F; b in F; b^0 in P; b^5 in P;
P!(K!1); K!(P!1); F!(P!1); E!(P!1); P!1 in F; P!0 in E; 3 in K; 1 in E;
// fields neither in the other: false, even for 0 and 1
a in E; c in F; F!0 in E; F!1 in E; F!0 eq E!0; F!1 eq E!1; a eq c; a ne c;
// the smallest field containing both, unnamed, then named
a + c; c / a; a^-1 * c; (a + c)^7; Parent(a + c);
[a, c, 1]; Universe([a, c]); Universe({F!1, E!1}); [F!1, E!1]; {F!1, E!1};
x := [a, c]; Parent(x[1]); x[1] eq a; Index([c, a], a); a in [c]; Position([c, a], a);
[P!1, a]; {a, b^5}; #{F!0, E!0, K!0}; {@ a, c @};
L<d> := GF(64);
a + c; [a, c]; a in {d^21}; a in [d^21]; c in {d^21};
Include({d^21}, a); Exclude({d^21}, a); #{a, d^21};
S := {d^21}; Include(~S, a); S; Index([d^9, d^21], a);
[K | a]; [F | b^5]; [P | b^0]; w := [K | b]; Append(~w, a); w;
// larger fields
G<g> := GF(2^12); a in G; c in G; G!a; G!c; Parent(a + c); a + c;
Q := GF(3^6); R := GF(9); T := GF(27); R.1 + Q.1; T.1 * Q.1; R.1 in Q; Q!T.1;
// a descent from GF(2^20) (q - 1 = 3 * 5^2 * 11 * 31 * 41)
// (GF(2^5), not GF(16): with GF(4) already in GF(16), Magma picks either of
// two embeddings of GF(16) into GF(2^20) at random, run to run)
H<h> := GF(2^20); M<m> := GF(2^10); N<n> := GF(2^5);
M!(h^1025); M!(h^(1025 * 7)); h^1025 in M; h^1024 in M; N!(h^(33825 * 3)); h^33825 in N;
m + n; Parent(m * n) eq M; m eq h^1025; n eq h^33825; m + h; Parent(m + h) eq H;
"end";
