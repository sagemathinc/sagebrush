// Magma fixtures for the Hilbert modular forms engine (tests only): Magma
// is used as a black box. Run from this directory with
//     magma -b magma-eigen.m > magma-eigen.txt
// For each newform orbit (NewformDecomposition(NewSubspace(...))) at levels
// beyond the LMFDB's range, a line
//     a b | d | c1 d1:f0,f1,... c2 d2:... | z: f0,f1,...
// with N = (a + b w), the orbit's dimension d, then for each prime P = (c + d w)
// of norm <= 30, in Magma's order, the characteristic polynomial over Q of
// the Hecke eigenvalue a_P of Eigenform(orbit), constant term first, and
// last that of z = sum_k (k + 1) a_(P_k) over those P not dividing N, in order.
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: Eigenform/HeckeEigenvalue on NewformDecomposition(NewSubspace(HilbertCuspForms(F, N)))\n", va, vb, vc;
function cp(a)
  if Type(a) in {RngIntElt, FldRatElt} then return [-Rationals()!a, 1]; end if;
  K := AbsoluteField(Parent(a));
  return Eltseq(CharacteristicPolynomial(K!a));
end function;
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
    parts := "";
    z := 0; k := 0;
    for P in Ps do
      a := HeckeEigenvalue(f, P);
      _, g := IsPrincipal(P);
      e := Eltseq(F!g);
      parts cat:= Sprintf("%o %o:%o ", e[1], e[2], js(cp(a)));
      if not N subset P then k +:= 1; z := z + (k + 1) * a; end if;
    end for;
    printf "%o 0 | %o | %o| z: %o\n", n, Dimension(D), parts, js(cp(z));
  end for;
end for;
quit;
