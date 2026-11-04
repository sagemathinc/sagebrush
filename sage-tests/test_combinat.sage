# Enumerative combinatorics and finite sets (kernel lane 3).  The .out is
# HAND-WRITTEN by @sagebrush-sage2, not generated: the local real Sage cannot
# start (libgap cannot find lib/init.g).  Regenerate from real Sage when the
# oracle is available.
print(number_of_partitions(10), number_of_partitions(100))
print(stirling_number2(5, 2), stirling_number2(10, 4), stirling_number1(5, 2))
print([bell_number(n) for n in range(8)])
print(Partitions(5))
print(Partitions(5).list())
print(Partitions(5).cardinality())
print(Partitions(6, length=2).list())
print(Partitions(5, max_part=2).list())
p = Partition([3, 1])
print(p, p.conjugate(), p.hook_lengths())
print(Partition([4, 2, 1]).conjugate())
print([3, 1] in Partitions(4), [2, 3] in Partitions(5))
print(Compositions(4).cardinality())
print(Compositions(3).list())
A = Set([1, 2, 3]); B = Set([3, 4])
print(A, B)
print(A.union(B), A.intersection(B), A.difference(B))
print(A.cardinality(), 2 in A, 5 in A)
print(Set([3, 1, 2, 1]), Set([]))
print(Subsets([1, 2, 3]).list())
print(Subsets(4, 2))
print(Subsets(4, 2).cardinality(), Subsets(10).cardinality())
print(Subsets(4, 2).list())
print(A.subsets().cardinality())
print(Combinations([1, 2, 3], 2).list())
print(Combinations(4, 2).cardinality())
print(Combinations([1, 2, 3], 2))
q = Permutation([2, 1, 3])
print(q, q.cycle_tuples(), q.inverse(), q.sign(), q(1))
print(Permutation('(1,3)(2,4)'))
print(Permutation([3, 1, 2, 5, 4]).order(), Permutation([3, 1, 2]).number_of_inversions())
print(Permutations(3))
print(Permutations(3).list())
print(Permutations(4).cardinality())
print(Permutations([1, 1, 2]).list())
print(Permutations(['a', 'b', 'c'], 2).list())
print(Permutations(['a', 'b', 'c'], 2).cardinality())
print(p.size(), p.length())
print(Partitions(6, min_part=2).list())
print(A.symmetric_difference(B))
print(A.subsets(2), A.subsets(2).list())
print(Combinations([1, 1, 2], 2).list())
r = Permutation([2, 3, 1])
print(r.inverse(), r.cycle_tuples(), r.sign())
print(Permutation('(1,2,3)'), Permutation([(1, 2, 3)]))
print(Permutation([2, 1, 4, 3]).order())
print(Permutation([3, 1, 2]).descents(), Permutation([3, 1, 2]).inversions())
print(Permutation([3, 1, 2, 5, 4]).cycle_string())
# multisets by equality, generated from multiplicities (astra3 R1, R3)
print(Combinations([1, 2, 1], 2).list(), Combinations([1, 2, 1], 2).cardinality())
print(Permutations([1, 2, 1]).list())
print(Permutations([1]*20).cardinality(), Combinations([1]*40, 20).cardinality())
print(Permutations([1, 1, 2], 2).list(), Permutations([1, 1, 2], 2).cardinality())
# domains: refused, never truncated (astra3 R2); the exception names are sagebrush's
def err(f):
    try:
        return "no error: %s" % (f(),)
    except Exception as ex:
        return type(ex).__name__
print(err(lambda: Partition([2.9, 1])))
print(err(lambda: Permutation([1.5, 2])))
print(err(lambda: Partitions(5/2)))
print(err(lambda: Compositions(-1)))
print(err(lambda: Partitions(-1)))
print(err(lambda: Permutations(-1)))
print(err(lambda: Subsets(4, -1)))
print(Partition([2, 1]) == [2.9, 1], Compositions(0).list(), Compositions(0).cardinality(), stirling_number2(0, -1), Subsets(4, 5).cardinality(), Subsets(4, 5).list())
# structural (astra3 R3a, R3b): a helper that must NOT be reached is made to raise for one call
import _sage_combinat as _C
def spied(name, f):
    orig = getattr(_C, name)
    def boom(*a, **k):
        raise RuntimeError("reached " + name)
    setattr(_C, name, boom)
    try:
        return f()
    except Exception as ex:
        return "%s: %s" % (type(ex).__name__, ex)
    finally:
        setattr(_C, name, orig)
print(spied("_choice_poly", lambda: Combinations([1, 1], 10**9).cardinality()))
print(spied("_falling", lambda: Permutations([1, 2], 10**9).cardinality()))
print(spied("_arrangement_poly", lambda: (Permutations([1, 1, 2, 2, 3]).cardinality(), Permutations([1]*40).cardinality())))
print(Permutations([1, 1, 2], 2).cardinality(), Permutations([1, 2, 1, 3, 2], 3).cardinality())
# R1's checklist: equality, not repr, decides the groups (hashable or not)
print(Combinations([1, 1.0, 2], 2).list())
class Same:
    def __init__(self, v):
        self.v = v
    def __repr__(self):
        return "x"
    def __eq__(self, other):
        return isinstance(other, Same) and self.v == other.v
print(Combinations([Same(1), Same(2)], 1).cardinality())
print(Combinations([[1], [1], [2]], 2).list(), Combinations([[1], [1], [2]], 2).cardinality(), Permutations([[1], [1], [2]]).cardinality())
