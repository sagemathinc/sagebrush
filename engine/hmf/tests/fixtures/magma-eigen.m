// Magma fixtures for the Hilbert modular forms engine (tests only): Magma
// is used as a black box. Run from this directory with
//     magma -b magma-eigen.m > magma-eigen.txt
// For each newform orbit (NewformDecomposition(NewSubspace(...))) at levels
// beyond the LMFDB's range, its Hecke eigenvalues exactly as Magma gives
// them, in a line
//     a b | d | field: f0,f1,...,fd | c1 d1:q0,q1,... c2 d2:... ...
// with N = (a + b w), the orbit's dimension d, the defining polynomial f of
// the absolute field K of the eigenvalues of Eigenform(orbit) (constant term
// first), and for each prime P = (c + d w) of norm <= 30, in Magma's order,
// HeckeEigenvalue(f, P) in K as q0 + q1 t + ... + q_(d-1) t^(d-1), t the
// generator of K (a root of f).
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: Eigenform/HeckeEigenvalue on NewformDecomposition(NewSubspace(HilbertCuspForms(F, N)))\n", va, vb, vc;
function js(s)
  line := Sprint(s[1]);
  for z in s[2..#s] do line cat:= "," cat Sprint(z); end for;
  return line;
end function;
Ps := PrimesUpTo(30, F);
for n in [71, 81, 87, 93, 99] do
  N := n*O;
  for D in NewformDecomposition(NewSubspace(HilbertCuspForms(F, N))) do
    f := Eigenform(D);
    as := [HeckeEigenvalue(f, P) : P in Ps];
    d := Dimension(D);
    if d eq 1 then
      pol := [0, 1];
      cs := [[Rationals()!a] : a in as];
    else
      K := AbsoluteField(Parent(as[1]));
      assert Degree(K) eq d;
      pol := Eltseq(DefiningPolynomial(K));
      cs := [Eltseq(K!a) : a in as];
    end if;
    parts := "";
    for i in [1..#Ps] do
      _, g := IsPrincipal(Ps[i]);
      e := Eltseq(F!g);
      parts cat:= Sprintf(" %o %o:%o", e[1], e[2], js(cs[i]));
    end for;
    printf "%o 0 | %o | field: %o |%o\n", n, d, js(pol), parts;
  end for;
end for;
quit;
