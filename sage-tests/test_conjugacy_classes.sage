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
# membership: an element of a larger symmetric group is made an element of the class's group first (an
# extra fixed point dropped), or refused if it isn't one
G3 = SymmetricGroup(3); C = G3.conjugacy_class(G3('(1,2)')); S4 = SymmetricGroup(4)
A4 = AlternatingGroup(4); D = A4.conjugacy_class(A4('(1,2,3)'))
print(S4('(1,2)') in C, S4('(2,3)') in C, S4('(1,2,3)') in C, SymmetricGroup(5)('(1,3,2)') in D, SymmetricGroup(5)('(1,3,4)') in D)
try:
    S4('(1,4)') in C
except ValueError:
    print('(1,4) refused')
# the trivial group with no generators: its one class
T = PermutationGroup([])
print([str(r) for r in T.conjugacy_classes_representatives()], len(T.conjugacy_classes()), T.conjugacy_classes()[0].cardinality())
