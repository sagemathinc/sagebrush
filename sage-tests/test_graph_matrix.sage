# matrix of a graph: its adjacency matrix, as Sage; a graph before other
# arguments is Sage's TypeError (astra's hunt at e4a9ce94 and CORR-EA6-1)
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__)
G = Graph([(0, 1)])
T('graph matrix', lambda: (matrix(G).dimensions(), matrix(G).list(), matrix(G).base_ring()))
T('QQ', lambda: (matrix(QQ, G).list(), matrix(QQ, G).base_ring()))
T('GF5', lambda: (matrix(GF(5), Graph([(0, 1), (1, 2)])).list(), matrix(GF(5), G).base_ring()))
T('digraph', lambda: matrix(DiGraph([(0, 1), (1, 2)])).list())
T('loops', lambda: matrix(Graph([(0, 0), (0, 1)], loops=True)).list())
T('path', lambda: matrix(graphs.PathGraph(4)).list())
T('empty', lambda: matrix(Graph()).dimensions())
T('labelled', lambda: matrix(Graph([(0, 1, 'a')])).list())
for name, f in [('G,2', lambda: matrix(G, 2)), ('ZZ,G,2', lambda: matrix(ZZ, G, 2)), ('G,2,2', lambda: matrix(G, 2, 2)), ('2,G', lambda: matrix(2, G)), ('2,2,G', lambda: matrix(2, 2, G)), ('QQ,2,2,G', lambda: matrix(QQ, 2, 2, G)), ('G,G', lambda: matrix(G, G)), ('G', lambda: matrix(G).list()), ('QQ,G', lambda: matrix(QQ, G).list()), ('G sparse', lambda: matrix(G, sparse=True).list())]:
    T(name, f)
