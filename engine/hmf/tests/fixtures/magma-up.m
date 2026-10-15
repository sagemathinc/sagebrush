// Magma fixtures for the Hilbert modular forms engine (tests only): Magma
// is used as a black box. Run from this directory with
//     magma -b magma-up.m > magma-up.txt
// Output lines "a b | c d | t | f0 f1 ...": for the level N = (a + b w) and
// a prime P = (c + d w) dividing N, the trace t and the characteristic
// polynomial (constant term first) of HeckeOperator(HilbertCuspForms(F, N),
// P), i.e. U_P on the whole of S_2(N), old forms included.
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: HeckeOperator(HilbertCuspForms(F, N), P) for P | N\n", va, vb, vc;
cases := [<30 + 0*w, [2 + 0*w, 2 + w, 3 + 0*w]>, <24 + 0*w, [2 + 0*w, 3 + 0*w]>, <-38 + 2*w, [2 + 0*w, 7 - 2*w, 3 + w]>,
          <62 + 0*w, [2 + 0*w, 7 - 2*w]>, <45 + 0*w, [3 + 0*w, 2 + w]>, <99 + 0*w, [3 + 0*w, 3 + w, 4 - w]>];
for c in cases do
  M := HilbertCuspForms(F, c[1]*O);
  for p in c[2] do
    T := HeckeOperator(M, p*O);
    a := Eltseq(c[1]); b := Eltseq(p);
    cs := Eltseq(CharacteristicPolynomial(T));
    line := Sprint(cs[1]);
    for z in cs[2..#cs] do line cat:= " " cat Sprint(z); end for;
    printf "%o %o | %o %o | %o | %o\n", a[1], a[2], b[1], b[2], Trace(T), line;
  end for;
end for;
quit;
