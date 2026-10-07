# GAP (oracle) for tests/maximal.rs: the maximal transitive subgroups of each nTk, n <= 12,
# by transitive identification number.  Run from engine/group: gap -q -o 8g tests/gap-maximal.g
# For each nTk (n<=12): transitive maximal subgroups up to conjugacy, as the
# list of their transitive identification numbers.
out := OutputTextFile("tests/data/gap-maximal.txt", false);
SetPrintFormattingStatus(out, false);
for n in [2..12] do
  for k in [1..NrTransitiveGroups(n)] do
    G := TransitiveGroup(n,k);
    if Size(G) = Factorial(n) or (n > 2 and Size(G) = Factorial(n)/2) then
      continue;
    fi;
    M := Filtered(MaximalSubgroupClassReps(G), H -> IsTransitive(H, [1..n]));
    ids := SortedList(List(M, TransitiveIdentification));
    AppendTo(out, n, " ", k, " ; ", JoinStringsWithSeparator(List(ids, String), " "), "\n");
  od;
od;
CloseStream(out);
out := OutputTextFile("tests/data/gap-maximal-sa.txt", false);
SetPrintFormattingStatus(out, false);
for n in [3..12] do
  for k in [NrTransitiveGroups(n)-1, NrTransitiveGroups(n)] do
    G := TransitiveGroup(n,k);
    M := Filtered(MaximalSubgroupClassReps(G), H -> IsTransitive(H, [1..n]));
    ids := SortedList(List(M, TransitiveIdentification));
    AppendTo(out, n, " ", k, " ; ", JoinStringsWithSeparator(List(ids, String), " "), "\n");
  od;
od;
CloseStream(out);
QUIT;
