// Magma fixtures for real quadratic fields (engine/hmf/src/rqf.rs; tests
// only): Magma is used as a black box. Run from this directory with
//     magma -b magma-rqf.m > magma-rqf.txt
// For each field Q(sqrt d) below and each prime P of norm <= 100, a line
//     d | p | x y | o | o+
// with P = (p, x + y w) (w the generator of the maximal order with
// w^2 = w + (d - 1)/4 or w^2 = d, as in rqf.rs), the order o of the class
// of P in ClassGroup and o+ that in NarrowClassGroup (orders do not depend
// on the identification of the groups), after a line
//     d | [invariant factors of Cl] | [invariant factors of Cl+]
// The fields from 1259 on are those of @sagebrush-astra's review of hmf-qf
// 73a3eaa (CORR-73A-2), beyond the LMFDB fixture's D <= 5000.
SetColumns(0);
R<x> := PolynomialRing(Rationals());
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: ClassGroup, NarrowClassGroup, Decomposition\n", va, vb, vc;
for d in [3, 6, 10, 15, 34, 57, 65, 79, 82, 85, 106, 145, 226, 229, 254, 290, 410, 1155,
          1259, 2003, 5003, 5005, 5010, 10001, 10005, 10007, 15013, 20011, 32767, 65537] do
  if d mod 4 eq 1 then
    K<w> := NumberField(x^2 - x - (d - 1) div 4);
  else
    K<w> := NumberField(x^2 - d);
  end if;
  O := EquationOrder(K);
  assert O eq MaximalOrder(K);
  G, m := ClassGroup(O : Proof := "Full");
  H, n := NarrowClassGroup(O);
  printf "%o | %o | %o\n", d, Invariants(G), Invariants(H);
  for p in [q : q in [2..100] | IsPrime(q)] do
    for t in Decomposition(O, p) do
      P := t[1];
      if Norm(P) gt 100 then continue; end if;
      // P = (p, x + y w) with y = 0 or 1: a generator besides p
      gs := Generators(P);
      g := [e : e in gs | Eltseq(K!e)[2] ne 0];
      e := #g eq 0 select [p, 0] else [Integers()!c : c in Eltseq(K!g[1])];
      printf "%o | %o | %o %o | %o | %o\n", d, p, e[1], e[2], Order(P @@ m), Order(P @@ n);
    end for;
  end for;
end for;
quit;
