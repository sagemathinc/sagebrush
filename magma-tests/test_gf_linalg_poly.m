// linear algebra and polynomial arithmetic over prime fields (the engine's
// nmod_echelon and nmod_poly ops for word-size primes)
for p in [2, 7, 65537, 2^31 - 1, 2^61 - 1] do
    F := GF(p);
    A := Matrix(F, 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 10]);
    print p, Rank(A), Determinant(A);
    A^-1;
    A^-1 * A eq A * A^-1;
    S := Matrix(F, 3, 4, [1, 2, 3, 4, 2, 4, 6, 8, 1, 0, 1, 0]);
    print Rank(S);
    B := Matrix(F, 30, 30, [(F!(i + 3))^(j + 2) + i * j : j in [0..29], i in [0..29]]);
    print Rank(B), Determinant(B), Rank(B * Transpose(B));
    R<x> := PolynomialRing(F);
    f := &+[(F!(i + 1))^3 * x^i : i in [0..40]];
    g := &+[(F!(i + 2))^2 * x^i : i in [0..30]];
    h := x^5 + 3 * x + 1;
    print Degree(f * g), Coefficient(f * g, 35);
    q, r := Quotrem(f, g);
    q; r; q * g + r eq f;
    f div h, f mod h;
    GCD(f * h, g * h), GCD(f, f), GCD(f, R!0) eq GCD(f, f);
    F2 := &*[x^20 + (F!k) * x + 1 : k in [1..20]];
    G2 := &*[x^20 + (F!k) * x + 1 : k in [10..30]];
    print Degree(GCD(F2, G2)), Degree(F2 * G2), Degree(F2 mod G2);
end for;
