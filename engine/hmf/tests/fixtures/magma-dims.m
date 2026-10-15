// Magma fixtures for the Hilbert modular forms engine (tests only): Magma
// is used as a black box. Run from this directory with
//     magma -b magma-dims.m > magma-dims.txt
// Output lines: "a b dim" for the level (a + b w), w^2 = w + 1, where dim =
// Dimension(HilbertCuspForms(F, N)).
//
// Levels: the rational integers n = 2..100 (norms up to 10^4, beyond the
// LMFDB's range; PSAGE's todo.txt compared these with Magma), and the two
// primes of norm 2069, where the LMFDB lacks two newform orbits.
SetColumns(0);
R<x> := PolynomialRing(Rationals());
F<w> := NumberField(x^2 - x - 1);
O := Integers(F);
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: Dimension(HilbertCuspForms(F, N)), F = Q(w), w^2 = w + 1\n", va, vb, vc;
levels := [F | n : n in [2..100]] cat [45 + w, 46 - w];
for g in levels do
    c := Eltseq(g);
    printf "%o %o %o\n", c[1], c[2], Dimension(HilbertCuspForms(F, g*O));
end for;
quit;
