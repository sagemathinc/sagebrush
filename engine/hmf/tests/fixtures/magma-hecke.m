// Magma fixtures for the Hilbert modular forms engine (tests only): Magma
// is used as a black box. Run from this directory with
//     magma -b magma-hecke.m > magma-hecke.txt
// Output lines "a b | c d | t": the trace t of HeckeOperator(M, P) on
// M = HilbertCuspForms(F, N), N = (a + b w), P = (c + d w), w^2 = w + 1.
// The primes reach norm 10009, beyond the LMFDB fixture (norm <= 30).
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: Trace(HeckeOperator(HilbertCuspForms(F, N), P))\n", va, vb, vc;
cases := [
  <-2 + 5*w, [2 + 0*w, 3 + 0*w, 13 - 4*w, 29 + 8*w, 91 + 27*w]>,
  <100 + 0*w, [3 + 0*w, 3 + w, 13 - 4*w, 29 + 8*w]>,
  <299 + w, [2 + 0*w, 3 + 0*w, 3 + w, 13 - 4*w]>
];
for c in cases do
  M := HilbertCuspForms(F, c[1]*O);
  for p in c[2] do
    a := Eltseq(c[1]); b := Eltseq(p);
    printf "%o %o | %o %o | %o\n", a[1], a[2], b[1], b[2], Trace(HeckeOperator(M, p*O));
  end for;
end for;
quit;
