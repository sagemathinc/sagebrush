// binomials x^k (a x^m + b) over Z, factored from their cyclotomic
// structure (engine/poly/src/binomial.rs); expected output
// (test_factor_binomial.out) from Magma V2.18-5
R<x> := PolynomialRing(Integers());
for n in [240, 360, 1000] do
    for s in [-1, 1] do
        F := Factorization(x^n + s);
        print n, s, #F, &+[Degree(t[1]) * t[2] : t in F], Max([Max([Abs(c) : c in Coefficients(t[1])]) : t in F]);
    end for;
end for;
Factorization(x^30 - 1);
Factorization(x^24 + 1);
for f in [x^4 - 64, 9*x^4 - 4, 8*x^6 + 27, 16*x^12 - 81, 2*x^6 - 128, 27*x^9 + 8,
          -x^5 + 32, x^4 + 4, x^5 - 2, 3*x^10 - 3, x^7*(x^30 - 1), 9*x^2 - 4,
          27*x^3 + 8, x^4 - 16, x^8 - 16, 4*x^20 - 9, x^6 + 8, -8*x^6 - 27,
          1024*x^10 - 59049] do
    Factorization(f);
end for;
