# conjugacy classes: SymmetricGroup(n)'s representatives and order as GAP's; every group's number of
# classes and their (element order, length), as Sage's; a class's printing, cardinality and membership
for n in range(1,9):
    G=SymmetricGroup(n); print(n, [str(r) for r in G.conjugacy_classes_representatives()])
for H in [SymmetricGroup(4), DihedralGroup(4), DihedralGroup(7), AlternatingGroup(5), AlternatingGroup(6), CyclicPermutationGroup(6), PermutationGroup(['(1,2,3,4)','(1,3)']), PermutationGroup(['(1,2,3)(4,5,6)','(1,4)'])]:
    C = H.conjugacy_classes()
    print(len(C), sorted((int(c.representative().order()), int(c.cardinality())) for c in C))
G = SymmetricGroup(4); C = G.conjugacy_class(G('(1,2)')); print(C); print(C.cardinality(), G('(3,4)') in C, G('(1,2,3)') in C)
P = PermutationGroup(['(1,2,3,4)','(1,3)']); print(P.conjugacy_class(P('(1,3)')).cardinality())
print(G.conjugacy_classes()[2])
