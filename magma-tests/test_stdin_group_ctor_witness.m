// A quantifier's witness in a PermutationGroup< ... > or sub< ... > generator is assigned in the scope around it, as
// Magma's: found, it holds the witness; not found, it is unassigned, a value it had before included.
G := PermutationGroup<3 | exists(w){i : i in [1..3] | i gt 1} select (1,2) else (2,3)>;
#G; w;
v := 7;
H := PermutationGroup<3 | exists(v){i : i in [1..3] | i gt 5} select (1,2) else (2,3)>;
#H; v;
K := sub<G | exists(u){i : i in [1..3] | i gt 2} select (1,2) else (2,3)>;
#K; u;
(1,2);
print "end";
