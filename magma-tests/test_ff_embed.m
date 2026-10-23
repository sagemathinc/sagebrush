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
// in: x coerced into the collection's field first (false where it doesn't
// go in, though equal in a larger field), literal and declared
F!1 in {E!1}; F!1 in [E!1]; F!1 in {E | 1}; F!1 in [E | 1]; F!1 in {F!1, E!1}; F!1 in [F!1, E!1];
a in {L | d^21}; b^5 in [a]; b in [a]; b^5 in {F | a}; c in [d^9]; a in [d^21, d^9];
P!1 in {E!1}; P!1 in [K | 1]; 1 in {E!1}; E!1 in [P!1]; b^0 in [P!1]; Index([c, a], a); Index([F | 1, a], b^5);
// set equality and operations by value in the common field (astra CORR-PR45-2)
{a} eq {b^5}; {a, b^5} eq {a}; {F!1} eq {E!1}; {a} eq {d^21}; {c} eq {d^9}; {a} ne {b^5}; {P!1} eq {F!1}; {a} eq {b};
X := {a} join {b^5}; #X; X; Universe(X); Y := {a} join {c}; #Y; Universe(Y); #({P!1} join {a}); {P!1} join {a};
#({F!1} join {E!1}); {F!1} meet {E!1}; {a} diff {b^5}; {a} sdiff {b^5}; #({a, b} diff {b^5});
{a} subset {b^5, b}; {a} subset {c}; {F!1} subset {E!1}; {a} notsubset {b};
// declared universes and nested collections too (astra CORR-PR45-2)
{F|a} eq {K|b^5}; #({F|a} join {K|b^5}); {F|a} meet {K|b^5}; Universe({F|a} join {K|b^5}); {F|a} diff {K|b^5};
{F|a} subset {K|b^5, b}; {F|1} eq {E|1}; Universe({F|1} join {E|1}); {F|a} eq {b^5}; {a} eq {K|b^5};
{{a}} eq {{b^5}}; #({{a}} join {{b^5}}); {a} in {{b^5}}; {{F!1}} eq {{E!1}}; {F!1} in {{E!1}}; [a] in {[b^5]}; {[a]} eq {[b^5]};
<a, 1> in {<b^5, 1>}; {<a>} eq {<b^5>}; {{a}} eq {{b}}; {{a}, {b}} eq {{b^5}, {b}};
// the prime field's elements with one extension: the extension's (astra CORR-PR45-3)
S := {P!1, F!1}; Universe(S); Include(S, a);
// larger fields
G<g> := GF(2^12); a in G; c in G; G!a; G!c; Parent(a + c); a + c;
Q := GF(3^6); R := GF(9); T := GF(27); R.1 + Q.1; T.1 * Q.1; R.1 in Q; Q!T.1;
// each tuple coordinate its own universe; nested literals keyed in the common field (CORR-PR45-2)
h := R.1; <a, c> in {<b^5, c>}; {<a, c>} eq {<b^5, c>}; {<a, h>} eq {<b^5, h>}; #({<a, h>} join {<b^5, h>}); <a, h> in {<b^5, h>};
#{{a}, {b^5}}; #{<a>, <b^5>}; #[{a}, {b^5}]; #{[a], [b^5]};
// every member is evidence, not just the first (which may be empty)
{a} in {{}, {b^5}}; {a} in {{b^5}, {}}; {a} in {{}, {b^5}, {}, {b}}; {a} in {{}, {}}; {b} in {{}, {a}}; [a] in [[], [b^5]]; {F!1} in {{}, {E!1}};
// a descent from GF(2^20) (q - 1 = 3 * 5^2 * 11 * 31 * 41)
// (GF(2^5), not GF(16): with GF(4) already in GF(16), Magma picks either of
// two embeddings of GF(16) into GF(2^20) at random, run to run)
H<h> := GF(2^20); M<m> := GF(2^10); N<n> := GF(2^5);
M!(h^1025); M!(h^(1025 * 7)); h^1025 in M; h^1024 in M; N!(h^(33825 * 3)); h^33825 in N;
m + n; Parent(m * n) eq M; m eq h^1025; n eq h^33825; m + h; Parent(m + h) eq H;
"end";
