// Magma fixtures for the Hilbert modular forms engine (tests only): Magma
// is used as a black box. Run from this directory with
//     magma -b magma-newforms.m > magma-newforms.txt
// Output lines "a b | d1 d2 ... | t": for the level N = (a + b w), the
// dimensions of the newform orbits (NewformDecomposition(NewSubspace(
// HilbertCuspForms(F, N)))), sorted, and the CPU time Magma took (seconds).
// Levels: rational integers of norm beyond the LMFDB's range (4999),
// including PSAGE's todo.txt levels (81), (87), (93), (99).
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: dimensions of NewformDecomposition(NewSubspace(HilbertCuspForms(F, N)))\n", va, vb, vc;
for n in [71, 79, 81, 87, 89, 93, 99] do
  t := Cputime();
  D := NewformDecomposition(NewSubspace(HilbertCuspForms(F, n*O)));
  d := Sort([Dimension(f) : f in D]);
  printf "%o 0 | %o | %o\n", n, &cat[Sprintf("%o ", x) : x in d] , Cputime(t);
end for;
quit;
