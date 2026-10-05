// Integers and sequences
Factorization(2^64 - 1);
[ p : p in [1..100] | IsPrime(p) and IsPrime(p + 2) ];
&+[ 1/n : n in [1..10] ];
// Functions, procedures with reference arguments, recursion
fib := function(n) if n le 2 then return 1; end if; return $$(n-1) + $$(n-2); end function;
[ fib(n) : n in [1..20] ];
procedure Push(~L, x) Append(~L, x); end procedure;
L := [1, 2]; Push(~L, 3); L;
// Polynomials over the integers and the rationals
R<x> := PolynomialRing(Integers());
Factorization(x^12 - 1);
Q<y> := PolynomialRing(Rationals());
Roots((y^2 - 1/4)*(3*y + 2));
// Modular symbols and newforms (Sagebrush's Rust engine, in WebAssembly)
S := CuspidalSubspace(ModularSymbols(389, 2, 1));
S;
Factorization(HeckePolynomial(S, 2));
NewformDecomposition(NewSubspace(S));
// Elliptic curves
E := EllipticCurve("389a1");
E;
Rank(E), Conductor(E), TorsionSubgroup(E);
[ TraceOfFrobenius(E, p) : p in PrimesUpTo(50) ];
Newforms(CuspForms(37, 2));
