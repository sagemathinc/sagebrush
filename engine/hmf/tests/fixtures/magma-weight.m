// Magma fixtures for Hilbert modular forms of weight k != (2, 2) over
// Q(sqrt 5) (tests only): Magma is used as a black box. Run from this
// directory with
//     magma -b magma-weight.m > magma-weight.txt
// Levels N = (a + b w) and primes P = (c + d w) are given by generators.
// Magma 2.18's NewSubspace raises a runtime error in non-parallel weight at
// most composite levels, so new subspaces are taken at prime levels only;
// at composite levels the full space is compared.
//
//   D a b | k1 k2 | dim
//       Dimension(HilbertCuspForms(F, N, [k1, k2])) for every N of norm
//       <= 50 in all ten weights below, and of norm <= 100 in the first
//       four;
//   H a b | k1 k2 | c d | f0;f1;...;fn
//       the characteristic polynomial of HeckeOperator(M, P) on the full
//       space M (U_P when P | N), coefficients in F as x,y = x + y w,
//       constant term first;
//   O a b | k1 k2 | d | field: f0,...,fe | c d:q0,q1,... ...
//       for each newform orbit at a prime level (NewformDecomposition of
//       NewSubspace), its dimension d over F, the defining polynomial of the
//       absolute field of the eigenvalues of Eigenform(orbit) and each
//       HeckeEigenvalue at the primes of norm <= 30 in its power basis;
//   E a b | k1 k2 | Magma raised an error
//       where Magma 2.18 fails on a space at a prime level; not compared.
//       NewSubspace raises an InsertBlock error when there are forms of
//       level one (e.g. weight (6, 6), where dim S_k(1) = 1), and Eigenform
//       fails an internal assertion on some orbits (e.g. weight (2, 6) at
//       level (6 - w), weight (2, 4) at level (w - 9)).
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: HilbertCuspForms(F, N, k), HeckeOperator, NewformDecomposition, Eigenform, HeckeEigenvalue\n", va, vb, vc;
function js(s, sep)
  line := Sprint(s[1]);
  for z in s[2..#s] do line cat:= sep cat Sprint(z); end for;
  return line;
end function;
function gen(I)
  _, g := IsPrincipal(I);
  e := Eltseq(F!g);
  return Sprintf("%o %o", e[1], e[2]);
end function;
weights := [[2,4],[4,2],[4,4],[2,6],[6,2],[4,6],[6,6],[2,8],[3,3],[3,5]];
for N in IdealsUpTo(100, F) do
  if Norm(N) eq 1 then continue; end if;
  for k in (Norm(N) le 50 select weights else weights[1..4]) do
    printf "D %o | %o %o | %o\n", gen(N), k[1], k[2], Dimension(HilbertCuspForms(F, N, k));
  end for;
end for;
// HeckeOperator's matrices are over K = Q(i, sqrt 5), defined by
// x^4 + 3x^2 + 1, and their characteristic polynomials have coefficients in
// the image of F. Magma's eigenvalues (HeckeEigenvalue, in F) fix how the
// package embeds F in K: at level (3 + w) in weight (2, 4), a_2 = 4w - 12
// and T_2 = 4 K.1^2 - 4, so w = K.1^2 + 2, which is not Magma's default
// coercion of F into K (w = -K.1^2 - 1). This is asserted here, and the
// coefficients are read back through that embedding (the K-coordinates of
// t 1, K.1 and K.1^3 must vanish).
M := HilbertCuspForms(F, (3+w)*O, [2, 4]);
P2 := Factorization(2*O)[1][1];
T := HeckeOperator(M, P2);
K := BaseRing(Parent(T));
assert DefiningPolynomial(K) eq x^4 + 3*x^2 + 1;
assert T[1,1] eq 4*K.1^2 - 4;
assert HeckeEigenvalue(Eigenform(NewformDecomposition(NewSubspace(M))[1]), P2) eq 4*w - 12;
function toF(c)
  s := Eltseq(c);
  assert DefiningPolynomial(Parent(c)) eq x^4 + 3*x^2 + 1 and s[2] eq 0 and s[4] eq 0;
  return [s[1] - 2*s[3], s[3]];
end function;
Ps := PrimesUpTo(11, F);
for g in [3+w, 2*(3+w), 6+0*w, 5+0*w, 7+2*w, 3*(3+w), 4+0*w] do
  N := g*O;
  for k in [[2,4],[4,4],[2,6],[4,6]] do
    M := HilbertCuspForms(F, N, k);
    for P in Ps do
      c := CharacteristicPolynomial(HeckeOperator(M, P));
      cs := [toF(a) : a in Coefficients(c)];
      printf "H %o | %o %o | %o | %o\n", gen(N), k[1], k[2], gen(P), js([Sprintf("%o,%o", e[1], e[2]) : e in cs], ";");
    end for;
  end for;
end for;
Qs := PrimesUpTo(30, F);
for P in PrimesUpTo(100, F) do
  for k in [[2,4],[4,2],[4,4],[2,6],[6,6]] do
    // all of a space's orbits, or an E line if Magma raises an error
    lines := [];
    ok := true;
    try
      M := HilbertCuspForms(F, P, k);
      for D in NewformDecomposition(NewSubspace(M)) do
        f := Eigenform(D);
        as := [HeckeEigenvalue(f, Q) : Q in Qs];
        L := AbsoluteField(Parent(as[1]));
        pol := Eltseq(DefiningPolynomial(L));
        parts := "";
        for i in [1..#Qs] do
          parts cat:= Sprintf(" %o:%o", gen(Qs[i]), js(Eltseq(L!as[i]), ","));
        end for;
        Append(~lines, Sprintf("O %o | %o %o | %o | field: %o |%o", gen(P), k[1], k[2], Dimension(D), js(pol, ","), parts));
      end for;
    catch e
      ok := false;
    end try;
    if ok then
      for l in lines do printf "%o\n", l; end for;
    else
      printf "E %o | %o %o | Magma raised an error\n", gen(P), k[1], k[2];
    end if;
  end for;
end for;
quit;
