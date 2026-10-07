# GAP (oracle): generators and names of the transitive groups nTk, n <= 12.
# Run from engine/group: gap -q tests/gap-transitive.g
out := OutputTextFile("tests/data/gap-transitive.txt", false);
SetPrintFormattingStatus(out, false);
for n in [2..13] do
  for k in [1..NrTransitiveGroups(n)] do
    G := TransitiveGroup(n,k);
    s := Concatenation(String(n), " ", String(k), " ", String(Size(G)), " ; ");
    for g in GeneratorsOfGroup(G) do
      s := Concatenation(s, JoinStringsWithSeparator(List(ListPerm(g,n), String), ","), " ");
    od;
    s := Concatenation(s, "; ", Name(G));
    AppendTo(out, s, "\n");
  od;
od;
CloseStream(out);
QUIT;
