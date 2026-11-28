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
