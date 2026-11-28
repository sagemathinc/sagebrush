// conjugacy classes of any permutation group: the number of classes and each class's element
// order and length, in Magma's order (by order, then length); Sym(n)'s count for a large n
NumberOfClasses(Sym(4)); Nclasses(Sym(4)); Nclasses(Sym(40));
G := PermutationGroup<4 | (1,2,3,4), (1,3)>; Nclasses(G); [<c[1], c[2]> : c in ConjugacyClasses(G)];
D4 := DihedralGroup(4); Nclasses(D4); [<c[1], c[2]> : c in ConjugacyClasses(D4)];
D7 := DihedralGroup(7); Nclasses(D7); [<c[1], c[2]> : c in ConjugacyClasses(D7)];
A5 := Alt(5); Nclasses(A5); [<c[1], c[2]> : c in ConjugacyClasses(A5)];
A6 := Alt(6); Nclasses(A6); [<c[1], c[2]> : c in ConjugacyClasses(A6)];
C6 := CyclicGroup(6); Nclasses(C6); [<c[1], c[2]> : c in ConjugacyClasses(C6)];
P := PermutationGroup<6 | (1,2,3)(4,5,6), (1,4)>; Nclasses(P); [<c[1], c[2]> : c in ConjugacyClasses(P)];
H := sub<Sym(5) | (1,2), (3,4,5)>; Nclasses(H); [<c[1], c[2]> : c in ConjugacyClasses(H)];
M := PermutationGroup<7 | (1,2,3,4,5,6,7), (2,3,5)(4,7,6)>; #M; Nclasses(M); [<c[1], c[2]> : c in ConjugacyClasses(M)];
&+[c[2] : c in ConjugacyClasses(A6)] eq #A6; #ConjugacyClasses(Alt(7));
