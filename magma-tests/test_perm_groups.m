// permutation groups on Sagebrush's group engine: PermutationGroup< n | ... >, sub< G | ... >,
// Alt(n), CyclicGroup(n); the order printed once Magma knows it; generators, membership and
// coercion, eq and subset, orbits in Magma's order, and the invariants
G := PermutationGroup<4 | (1,2,3,4), (1,3)>; G; Order(G); #G; G;
H := sub<Sym(5) | (1,2), (3,4,5)>; H; #H; H;
K := sub<G | G.1^2>; K; Order(K);
A := Alt(4); A; #A;
Alt(5); Alt(6); Alt(7); Alt(3); Alt(2);
C := CyclicGroup(6); C; C.1; CyclicGroup(1); CyclicGroup(2);
G.1; G.2; Ngens(G); Ngens(A); Ngens(CyclicGroup(7)); Ngens(Sym(5)); Degree(G); Degree(Sym(7)); Type(G); Parent(G.1);
P := PermutationGroup<5 | (1,2,3)(4,5), [2,1,3,4,5]>; P; #P; IsAbelian(P); IsTransitive(P);
Q := PermutationGroup<4 | >; Q; #Q; Q;
R := PermutationGroup<3 | (1,2), (1,2)>; R; #R;
Orbits(H); Orbit(H, 3); Orbit(H, 1); Type(Orbit(H, 3)); #Orbit(H, 3); 4 in Orbit(H, 3);
X := PermutationGroup<8 | (1,5,3)(2,8), (4,6)>; Orbits(X); Orbit(X, 3); Orbit(X, 8); Orbit(X, 7);
Orbits(PermutationGroup<6 | (1,6,2,5)>); Orbit(PermutationGroup<5 | (1,2,3,4,5), (2,5)(3,4)>, 3);
Orbit(Sym(5), 3); Orbit(Alt(5), 2); Orbit(DihedralGroup(5), 2); Orbit(CyclicGroup(5), 3); Orbits(Sym(4)); Orbit(Alt(4), 1);
IsTransitive(G); IsTransitive(H); IsTransitive(Sym(5)); IsTransitive(Alt(1));
IsAbelian(C); IsAbelian(G); IsAbelian(Sym(2)); IsAbelian(Alt(4)); IsAbelian(DihedralGroup(4));
IsSolvable(Alt(5)); IsSolvable(G); IsSolvable(Sym(4)); IsSolvable(Alt(6));
#Stabilizer(G, 1); #Stabilizer(Sym(6), 2); #Stabilizer(Alt(5), 5); #Stabilizer(H, 3);
#DerivedSubgroup(Sym(4)); #DerivedSubgroup(G); #DerivedSubgroup(Alt(5)); #DerivedSubgroup(C);
G.1*G.2 in G; Sym(4)!(1,2) in G; Sym(4)!(1,3) in G; (Sym(4)!(1,2,3)) in Alt(4);
G!(1,3); G!(1,3)(2,4); Alt(4)!(1,2)(3,4); G!G.1;
G eq sub<Sym(4) | (1,2,3,4), (1,3)>; G eq Sym(4); Alt(4) eq sub<Sym(4) | (1,2,3), (2,3,4)>; Sym(3) eq PermutationGroup<3 | (1,2), (1,2,3)>;
G subset Sym(4); Alt(4) subset Sym(4); Sym(4) subset Alt(4); K subset G; G subset Alt(4);
G1 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := G1.1*G1.2 in G1; G1;
G2 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := Sym(4)!(1,2) in G2; G2;
G3 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := IsSolvable(G3); G3;
G4 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := IsAbelian(G4); y := Orbits(G4); z := IsTransitive(G4); G4;
G5 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := G5 subset Sym(4); G5; x := Sym(4) subset G5; G5;
G6 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := G6!(1,3); G6;
G7 := PermutationGroup<4 | (1,2,3,4), (1,3)>; x := Stabilizer(G7, 1); G7;
