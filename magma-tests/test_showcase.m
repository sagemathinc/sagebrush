// the showcase of an online Magma calculator, as one program: primes, Sym(5) and its
// classes, an elliptic curve's rank and its points over GF(101), a factorization and a
// matrix's determinant and trace
IsPrime(2^31 - 1); NextPrime(10^9);
G := Sym(5); Order(G); #ConjugacyClasses(G);
E := EllipticCurve([0, -1, 1, -10, -10]); Rank(E); #ChangeRing(E, GF(101));
R<x> := PolynomialRing(Integers()); Factorization(x^6 - 1);
M := Matrix(Rationals(), 2, 2, [1,2,3,4]); Determinant(M); Trace(M);
