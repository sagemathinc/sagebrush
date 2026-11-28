// permutation groups' errors, in a session (each reported, the input going on)
G := PermutationGroup<4 | (1,2,3,4), (1,3)>;
G!(1,2);
sub<G | (1,2)>;
(1,2)(3,4) in G;
Alt(0);
CyclicGroup(0);
PermutationGroup<0 | >;
Orbit(G, 5);
Stabilizer(G, 0);
Orbits(5);
IsAbelian([1, 2]);
"end";
