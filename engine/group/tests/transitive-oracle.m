// Magma: every transitive group of degree 2..15, one line each:
//   n k order primitive solvable abelian transitivity nblocksystems |G'| |G_1| ; gens as image lists
// (the oracle for tests/transitive.txt; Magma's answers, not its code)
SetColumns(0);
for n in [2..15] do
  for k in [1..NumberOfTransitiveGroups(n)] do
    G := TransitiveGroup(n, k);
    gens := [ [ i^g : i in [1..n] ] : g in Generators(G) ];
    s := Sprintf("%o %o %o %o %o %o %o %o %o %o ;", n, k, #G,
      IsPrimitive(G) select 1 else 0, IsSolvable(G) select 1 else 0, IsAbelian(G) select 1 else 0,
      Transitivity(G), #AllPartitions(G), #DerivedSubgroup(G), #Stabilizer(G, 1));
    for g in gens do
      s cat:= " " cat &cat[ Sprintf("%o,", x) : x in g ];
    end for;
    print s;
  end for;
end for;
quit;
