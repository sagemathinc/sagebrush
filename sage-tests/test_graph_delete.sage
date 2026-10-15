# Deleting edges and vertices (Computational Mathematics with SageMath, p. 364:
# delete_edges was missing, so the book's graph kept its edges)
def show(label, f):
    try:
        print(label, '->', f())
    except Exception as e:
        print(label, '!!', type(e).__name__, str(e)[:90])
def G0():
    g = Graph(); g.add_vertices([1, 2, 5, 9]); g.add_edges([(1,5), (9,2), (2,5), (1,9)]); g.add_edge("Madrid", "Edinburgh"); return g
g = G0(); g.delete_edges([(1,5), (2,5)]); show('pairs', lambda: (g.order(), g.size(), g.edges(sort=True, key=str)))
g = G0(); show('triples', lambda: (g.delete_edges([(1,5,None), (2,5,None)]), g.size()))
g = G0(); show('missing edge', lambda: (g.delete_edge(1, 2), g.size()))
g = G0(); show('missing vertex', lambda: (g.delete_edge(1, 77), g.size()))
g = G0(); show('missing both', lambda: (g.delete_edge(66, 77), g.size()))
g = G0(); show('delete_edges missing', lambda: (g.delete_edges([(1, 2), (1,5)]), g.size()))
g = G0(); show('delete_vertices', lambda: (g.delete_vertices([1, 2]), g.order(), g.size()))
g = G0(); show('delete_vertex missing', lambda: g.delete_vertex(42))
g = G0(); show('delete_vertices missing', lambda: g.delete_vertices([1, 42]))
g = G0(); show('edges iter', lambda: (g.delete_edges(e for e in [(1, 5)]), g.size()))


d = DiGraph([(1, 2), (2, 1)]); d.delete_edges([(1, 2)]); show('digraph', lambda: d.edges(sort=True))
g = G0(); show('edge with label arg', lambda: (g.delete_edge((1, 5, None)), g.size()))
