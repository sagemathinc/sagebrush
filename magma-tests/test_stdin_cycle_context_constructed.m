// A group built by PermutationGroup< ... > makes cycles in its constructor, in sub< ... > and in G!( ... ), the
// exists form there included; no context outlives each of them, so a bare cycle after it is still refused.
G := PermutationGroup<3 | (1,2), (1,2,3)>;
#G;
(1,2);
H := sub<G | (1,2)>;
#H;
(1,3);
x := G!(1,2); x;
(2,3);
y := G!(exists(w){w : w in [1..3] | w gt 5} select (1,2) else (2,3)); y;
(1,3);
z := G!(exists(w){w : w in [1..3] | w gt 1} select (1,2,3) else (2,3)); z;
(1,2);
print "end";
