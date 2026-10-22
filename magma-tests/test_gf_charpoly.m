// characteristic polynomials over prime fields, small and word-size primes
for p in [2, 3, 7, 65537, 2^31 - 1, 2^61 - 1] do
    F := GF(p);
    for n in [1, 2, 3, 5, 8, 13] do
        A := Matrix(F, n, n, [(F!(i + 2))^(j + 3) : j in [0..n-1], i in [0..n-1]]);
        f := CharacteristicPolynomial(A);
        print p, n, f, Degree(f), Coefficient(f, 0) eq (-1)^n * Determinant(A);
    end for;
end for;
F := GF(65537);
CharacteristicPolynomial(Matrix(F, 4, 4, [0 : i in [1..16]]));
CharacteristicPolynomial(Matrix(F, 5, 5, [i eq j select 1 else 0 : j in [1..5], i in [1..5]]));
A := Matrix(F, 4, 4, [0,1,0,0, 0,0,1,0, 0,0,0,1, 0,0,0,0]);
CharacteristicPolynomial(A);
f := CharacteristicPolynomial(Matrix(F, 4, 4, [1,0,0,0, 0,2,0,0, 0,0,2,0, 0,0,0,3])); f; Factorization(f);
B := Matrix(GF(101), 30, 30, [(GF(101)!(i + 3))^(j + 3) : j in [0..29], i in [0..29]]);
f := CharacteristicPolynomial(B);
Degree(f), Coefficient(f, 0) eq Determinant(B), Coefficient(f, 29) eq -Trace(B);
