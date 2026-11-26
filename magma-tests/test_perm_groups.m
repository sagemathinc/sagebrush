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
// computed subgroups by content, not only their order: equal to the subgroup Magma names, their
// orbits and invariants
S := Stabilizer(Sym(5), 3); S eq sub<Sym(5) | (1,2), (1,2,4,5)>; [Set(o) : o in Orbits(S)]; IsTransitive(S); #S;
DerivedSubgroup(Sym(4)) eq Alt(4); DerivedSubgroup(Alt(4)) eq sub<Alt(4) | (1,2)(3,4), (1,3)(2,4)>; IsAbelian(DerivedSubgroup(Alt(4)));
D := DerivedSubgroup(DihedralGroup(6)); D eq sub<DihedralGroup(6) | (1,3,5)(2,4,6)>; [Set(o) : o in Orbits(D)]; IsAbelian(D);
T := Stabilizer(PermutationGroup<6 | (1,2,3,4,5,6), (1,6)(2,5)(3,4)>, 1); T eq sub<Sym(6) | (2,6)(3,5)>; [Set(o) : o in Orbits(T)];
Sym(5)!(1,2,3) in Stabilizer(Sym(5), 5); Sym(5)!(1,5) in Stabilizer(Sym(5), 5);
// sets of groups: equal groups are one element, and a group made a key has its order known
#{G, sub<Sym(4) | (1,2,3,4), (1,3)>}; #{Alt(4), Alt(4)}; #{Alt(4), Sym(4)}; #{DihedralGroup(4), sub<Sym(4) | (1,2,3,4), (1,3)>};
F := sub<Sym(4) | (1,2), (1,2,3,4)>; F; X := {F, Sym(4)}; #X; F;
U := PermutationGroup<4 | (1,2,3,4)>; Y := {U}; U;
// membership of groups in sets and sequences, a built-in group and a constructed one either way; equal
// order but not equal (C4 and the Klein group) is not a member
G := sub<Sym(4) | (1,2), (1,2,3,4)>; G in {Sym(4)}; Sym(4) in {G};
A := Alt(4); H := sub<Sym(4) | (1,2,3), (1,2)(3,4)>; H in {A}; A in {H};
D := DihedralGroup(4); K := PermutationGroup<4 | (1,2,3,4), (1,3)>; K in {D}; D in {K}; K in {Alt(4)};
C := CyclicGroup(4); E := sub<Sym(4) | (1,2)(3,4), (1,3)(2,4)>; #C eq #E; C in {E}; E in {C};
S := [G, Alt(4), K]; Sym(4) in S; CyclicGroup(4) in S; #{G, Sym(4), A, H, K, D};
