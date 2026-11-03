# Agent simulation run 3 engine gaps (Sage 10.9): PermutationGroup.is_isomorphic (TransitiveGroup included); one line per statement
def show(n, f):
    try:
        print('S%02d %s' % (n, str(f()).replace('\n', ' ; ')))
    except Exception as e:
        print('S%02d ERR %s: %s' % (n, type(e).__name__, str(e)[:200]))
show(2, lambda: SymmetricGroup(3).is_isomorphic(DihedralGroup(3)))
show(3, lambda: CyclicPermutationGroup(4).is_isomorphic(KleinFourGroup()))
show(4, lambda: TransitiveGroup(5, 5).is_isomorphic(SymmetricGroup(5)))
show(5, lambda: AlternatingGroup(4).is_isomorphic(DihedralGroup(6)))
show(7, lambda: CyclicPermutationGroup(6).is_isomorphic(PermutationGroup([(1, 2), (3, 4, 5)])))
show(8, lambda: TransitiveGroup(4, 3).is_isomorphic(DihedralGroup(4)))
show(9, lambda: TransitiveGroup(6, 2).is_isomorphic(SymmetricGroup(3)))
show(10, lambda: DihedralGroup(6).is_isomorphic(PermutationGroup([(1, 2), (3, 4, 5, 6, 7, 8)])))
show(11, lambda: SymmetricGroup(4).is_isomorphic(PermutationGroup([[(1, 2, 3, 4)], [(1, 2)]])))
show(12, lambda: SymmetricGroup(4).is_isomorphic(TransitiveGroup(6, 8)))
show(13, lambda: SymmetricGroup(3).is_isomorphic(SymmetricGroup(4)))
show(14, lambda: SymmetricGroup(3).is_isomorphic(5))
show(15, lambda: AlternatingGroup(5).is_isomorphic(PermutationGroup([(1, 2, 3, 4, 5), (1, 2, 3)])))
show(16, lambda: DihedralGroup(4).is_isomorphic(PermutationGroup([(1, 2), (3, 4), (5, 6)])))
