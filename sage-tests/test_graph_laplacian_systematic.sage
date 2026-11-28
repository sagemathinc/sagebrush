# Laplacians weighted by the graph's own weighted flag, a digraph's in- or
# out-degree, over the weights' ring, and the spanning-tree count through
# them; a linear code's systematic generator matrix in given positions
def show(label, f):
    try:
        v = f(); print(label, "|", v if not hasattr(v, "nrows") else (v.rows(), v.base_ring()))
    except Exception as e:
        print(label, "|", type(e).__name__, e)
G = Graph([(0,1,3)], weighted=True); H = Graph([(0,1,3)]); D = DiGraph([(0,1,3)], weighted=True); E = DiGraph([(0,1,3)])
for name, g in [("G weighted", G), ("H unweighted", H), ("D weighted", D), ("E unweighted", E)]:
    show(name+" lap()", lambda: g.laplacian_matrix())
    show(name+" lap(weighted=True)", lambda: g.laplacian_matrix(weighted=True))
    show(name+" lap(weighted=False)", lambda: g.laplacian_matrix(weighted=False))
    show(name+" lap(indegree=True)", lambda: g.laplacian_matrix(indegree=True))
    show(name+" lap(indegree=False)", lambda: g.laplacian_matrix(indegree=False))
    show(name+" kirchhoff", lambda: g.kirchhoff_matrix())
    show(name+" stc", lambda: g.spanning_trees_count())
W = Graph([(0,1,3),(1,2,2),(0,2,5)], weighted=True)
show("W lap", lambda: W.laplacian_matrix()); show("W stc", lambda: W.spanning_trees_count())
Q = Graph([(0,1,1/2),(1,2,2)], weighted=True)
show("Q lap", lambda: Q.laplacian_matrix()); show("Q stc", lambda: Q.spanning_trees_count())
DD = DiGraph([(0,1,3),(1,2,2),(2,0,5),(0,2,1)], weighted=True)
for kw in [{}, {"indegree": True}, {"indegree": False}, {"weighted": False}]:
    show("DD lap %s" % kw, lambda: DD.laplacian_matrix(**kw))
show("DD stc", lambda: DD.spanning_trees_count())
for F, G in [(GF(2), matrix(GF(2), [[1,1,0,1,0,0,1],[0,1,1,0,1,0,1],[1,0,1,0,0,1,1]])), (GF(3), matrix(GF(3), [[1, 2, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])), (GF(5), matrix(GF(5), [[1,2,3,4,0],[0,1,1,2,3]]))]:
    C = LinearCode(G); k = G.nrows()
    show("%s default" % F, lambda: C.systematic_generator_matrix())
    for pos in [tuple(range(1, k+1)), tuple(range(G.ncols()-k, G.ncols())), (0,) + tuple(range(2, k+1)), tuple(reversed(range(1, k+1)))]:
        show("%s pos=%s" % (F, pos), lambda: C.systematic_generator_matrix(systematic_positions=pos))
C = LinearCode(matrix(GF(2), [[1,1,0,0],[0,0,1,1]]))
show("GF(2) non-information set (0,1)", lambda: C.systematic_generator_matrix(systematic_positions=(0,1)))
# a digraph's spanning out-trees from root_vertex (default: the first vertex
# in the graph's own order), the empty graph's none, and the count's type
L = DiGraph({'b': ['a', 'c'], 'a': ['c'], 'c': ['b']})
show("L stc", lambda: L.spanning_trees_count())
for r in ['a', 'b', 'c', 'z']:
    show("L stc root %s" % r, lambda: L.spanning_trees_count(root_vertex=r))
for r in [0, 1, 2]:
    show("DD stc root %s" % r, lambda: DD.spanning_trees_count(r))
P = DiGraph([(0,1),(1,2),(0,2),(2,3)])
for r in [None, 0, 3]:
    show("P stc root %s" % r, lambda: P.spanning_trees_count(root_vertex=r))
show("W stc root 2", lambda: W.spanning_trees_count(root_vertex=2))
show("Graph() stc", lambda: Graph().spanning_trees_count()); show("DiGraph() stc", lambda: DiGraph().spanning_trees_count())
for name, g in [("Graph(1)", Graph(1)), ("DiGraph(1)", DiGraph(1)), ("K4", graphs.CompleteGraph(4)), ("W", W), ("Q", Q), ("DD", DD)]:
    show(name + " stc and parent", lambda: (lambda v: (v, v.parent()))(g.spanning_trees_count()))
# signless and normalized Laplacians
for name, g in [("path", graphs.PathGraph(3)), ("W", W), ("DD", DD), ("isolated", Graph({0: [1], 2: []}))]:
    for kw in [{"signless": True}, {"normalized": True}, {"normalized": True, "signless": True}, {"signless": True, "indegree": False}]:
        show("%s lap %s" % (name, sorted(kw.items())), lambda: g.laplacian_matrix(**kw))
# systematic positions as Sage checks them
C = LinearCode(matrix(GF(2), [[1,0,1,1],[0,1,1,0]]))
for pos in [(-1, 1), (0.5, 1), ('0', '1'), (0, 0), (0, 4), (0,), (0, 1, 2), (), [], None, [3, 1], (int(2), ZZ(0)), (float(1), 2), (RDF(1), 2), (QQ(1), 2), (Zmod(7)(1), 2), (True, 2)]:
    show("C pos=%r" % (pos,), lambda: C.systematic_generator_matrix(systematic_positions=pos))
show("C no keyword", lambda: C.systematic_generator_matrix((1, 3)))
# a negative weight: the digraph's count is the determinant's absolute value
N = DiGraph([(0, 1, -2)], weighted=True)
show("N stc, root 1", lambda: (N.spanning_trees_count(), N.spanning_trees_count(1)))
show("C pos=iter(())", lambda: C.systematic_generator_matrix(systematic_positions=iter(())))
show("C pos=iter((1, 3))", lambda: C.systematic_generator_matrix(systematic_positions=iter((1, 3))))
