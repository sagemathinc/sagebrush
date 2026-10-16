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

# labels and malformed edges (astra's CORR-C4A-1/2 on c4a4f79)
for C in (Graph, DiGraph):
    for action in ("g.delete_edges([(0,1,'blue')])", "g.delete_edges([(0,1,'red')])", "g.delete_edges([(0,1,None)])", "g.delete_edges([(0,1,'red','extra')])"):
        g=C([(0,1,'red')])
        try:
            eval(action)
            result='ok'
        except Exception as err:
            result=type(err).__name__ + ': ' + str(err)
        print(C.__name__, action, result, g.edges(sort=True))
    g=C([(0,1),(1,2)])
    try:
        g.delete_vertices([0,42])
    except Exception as err:
        print(C.__name__, 'atomic missing vertex', type(err).__name__, g.vertices(sort=True), g.edges(sort=True))
    g=C([(0,1),(1,2)])
    g.delete_vertices(v for v in [0,0,1])
    print(C.__name__, 'duplicates generator', g.vertices(sort=True), g.edges(sort=True))

# a label is matched by equality, as Sage: __eq__ and __ne__ may both be True
# (astra's CORR-CAC-1 on cac31e10)
class Label:
    def __eq__(self, other):
        return True
    def __ne__(self, other):
        return True
    def __hash__(self):
        return 0
    def __repr__(self):
        return 'Label()'
for C in (Graph, DiGraph):
    for name, f in (("delete_edges", lambda g, l: g.delete_edges([(0, 1, l)])),
                    ("delete_edge(u, v, l)", lambda g, l: g.delete_edge(0, 1, l)),
                    ("delete_edge((u, v, l))", lambda g, l: g.delete_edge((0, 1, l)))):
        for same in (True, False):
            l = Label()
            g = C([(0, 1, l)])
            f(g, l if same else Label())
            print(C.__name__, name, 'same' if same else 'equal', g.size())
