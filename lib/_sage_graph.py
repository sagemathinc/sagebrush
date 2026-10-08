"""Graphs and directed graphs, as in Sage (a first part): Graph({0: [1, 2]}),
DiGraph({0: {1: 2}}), graphs.CycleGraph(5), ...; vertices, edges with
labels, degrees, adjacency and Laplacian matrices, distances, connected
components, printed as Sage prints them.  Simple graphs (with loops and edge
labels; no multiple edges yet)."""


def _sa():
    import sage_all
    return sage_all


def _vkey(v):
    """A sort key for vertices of mixed types (as Sage sorts them)."""
    return (str(type(v).__name__ != "int" and not isinstance(v, int)), v if isinstance(v, (int, tuple, str)) else repr(v))


def _sorted(vs):
    try:
        return sorted(vs)
    except TypeError:
        return sorted(vs, key=repr)


class GenericGraph:
    """Common code of Graph and DiGraph.

    EXAMPLES::

        sage: isinstance(graphs.CycleGraph(3), Graph), isinstance(digraphs.Circuit(3), DiGraph)
        (True, True)
    """

    _directed = False

    def __init__(self, data=None, name=None, loops=None, multiedges=None, weighted=None, format=None, **kwds):
        self._adj = {}      # v -> {w: label} (out-neighbours)
        self._in = {}       # v -> {u: label} (in-neighbours, directed only)
        self._name = name or ""
        self._weighted = weighted
        self._pos = None
        if data is None:
            return
        if isinstance(data, GenericGraph):
            for v in data.vertices(sort=False):
                self.add_vertex(v)
            for u, v, l in data.edges(sort=False):
                self.add_edge(u, v, l)
            if not name:
                self._name = data._name
            return
        if isinstance(data, int):
            for v in range(data):
                self.add_vertex(v)
            return
        if isinstance(data, dict):
            for v in data:
                self.add_vertex(v)
            for v, nb in data.items():
                if isinstance(nb, dict):
                    for w, l in nb.items():
                        self.add_edge(v, w, l)
                else:
                    for w in nb:
                        self.add_edge(v, w)
            return
        if isinstance(data, (list, tuple)):
            # a list of edges
            for e in data:
                if len(e) == 3:
                    self.add_edge(e[0], e[1], e[2])
                else:
                    self.add_edge(e[0], e[1])
            return
        if hasattr(data, "nrows") and hasattr(data, "ncols"):
            n = data.nrows()
            for v in range(n):
                self.add_vertex(v)
            for i in range(n):
                for j in range(n):
                    a = data[i, j]
                    if a and (self._directed or i <= j):
                        self.add_edge(i, j, None if a == 1 and not weighted else a)
            return
        raise TypeError("cannot make a graph from %r" % (data,))

    # ---- construction
    def add_vertex(self, v=None):
        """Add a vertex.

        EXAMPLES::

            sage: G = Graph(); G.add_vertex(3); G.vertices(sort=True)
            [3]
        """
        new = v is None
        if new:
            v = 0
            while v in self._adj:
                v += 1
        if v not in self._adj:
            self._adj[v] = {}
            self._in[v] = {}
        return v if new else None

    def add_vertices(self, vs):
        """Add several vertices.

        EXAMPLES::

            sage: G = Graph(); G.add_vertices([1, 2]); G.order()
            2
        """
        for v in vs:
            self.add_vertex(v)

    def add_edge(self, u, v=None, label=None):
        """Add an edge (u, v) with an optional label.

        EXAMPLES::

            sage: G = Graph(); G.add_edge(1, 2); G.edges(sort=True)
            [(1, 2, None)]
        """
        if v is None:
            if len(u) == 3:
                u, v, label = u
            else:
                u, v = u
        self.add_vertex(u)
        self.add_vertex(v)
        self._adj[u][v] = label
        if self._directed:
            self._in[v][u] = label
        else:
            self._adj[v][u] = label

    def add_edges(self, edges):
        """Add several edges.

        EXAMPLES::

            sage: G = Graph(); G.add_edges([(1, 2), (2, 3)]); G.size()
            2
        """
        for e in edges:
            self.add_edge(*e) if isinstance(e, tuple) and len(e) in (2, 3) else self.add_edge(e)

    def delete_edge(self, u, v=None, label=None):
        """Remove an edge.

        EXAMPLES::

            sage: G = graphs.CycleGraph(4); G.delete_edge(0, 1); G.size()
            3
        """
        if v is None:
            u, v = u[0], u[1]
        self._adj[u].pop(v, None)
        if self._directed:
            self._in[v].pop(u, None)
        else:
            self._adj[v].pop(u, None)

    def delete_vertex(self, v):
        """Remove a vertex and its edges.

        EXAMPLES::

            sage: G = graphs.CycleGraph(4); G.delete_vertex(0); G.order(), G.size()
            (3, 2)
        """
        for w in list(self._adj[v]):
            self.delete_edge(v, w)
        for u in list(self._in.get(v, {})):
            self.delete_edge(u, v)
        del self._adj[v]
        self._in.pop(v, None)

    # ---- data
    def name(self, new=None):
        """The name (or set it).

        EXAMPLES::

            sage: graphs.CycleGraph(5).name()
            'Cycle graph'
        """
        if new is not None:
            self._name = new
            return None
        return self._name

    def __repr__(self):
        kind = "Digraph" if self._directed else "Graph"
        if any(v in self._adj[v] for v in self._adj):
            kind = "Looped " + kind.lower()
        s = "%s on %d %s" % (kind, len(self._adj), "vertex" if len(self._adj) == 1 else "vertices")
        return (self._name + ": " + s) if self._name else s

    def __str__(self):
        return self._name if self._name else repr(self)

    def _latex_(self):
        return repr(self)

    def is_directed(self):
        """Whether the graph is directed.

        EXAMPLES::

            sage: Graph().is_directed(), DiGraph().is_directed()
            (False, True)
        """
        return self._directed

    def vertices(self, sort=True, key=None, degree=None, vertex_property=None):
        """The vertices (sorted by default).

        EXAMPLES::

            sage: graphs.CycleGraph(4).vertices(sort=True)
            [0, 1, 2, 3]
        """
        vs = list(self._adj)
        return _sorted(vs) if sort else vs

    def __iter__(self):
        return iter(self.vertices(sort=False))

    def __contains__(self, v):
        try:
            return v in self._adj
        except TypeError:
            return False

    def __len__(self):
        return len(self._adj)

    def order(self):
        """The number of vertices.

        EXAMPLES::

            sage: graphs.PetersenGraph().order()
            10
        """
        return _sa().Integer(len(self._adj))

    num_verts = n_vertices = order

    def edges(self, vertices=None, labels=True, sort=True, key=None, sort_vertices=True):
        """The edges (u, v, label), sorted by default.

        EXAMPLES::

            sage: graphs.CycleGraph(4).edges(sort=True)
            [(0, 1, None), (0, 3, None), (1, 2, None), (2, 3, None)]
            sage: graphs.CycleGraph(4).edges(sort=True, labels=False)
            [(0, 1), (0, 3), (1, 2), (2, 3)]
        """
        out = []
        seen = set()
        for u in self._adj:
            for v, l in self._adj[u].items():
                if not self._directed:
                    k = frozenset((id(u), id(v))) if False else None
                    a, b = (u, v)
                    try:
                        if b < a:
                            a, b = b, a
                    except TypeError:
                        if repr(b) < repr(a):
                            a, b = b, a
                    if (a, b) in seen:
                        continue
                    seen.add((a, b))
                    out.append((a, b, l))
                else:
                    out.append((u, v, l))
        if sort:
            try:
                out.sort(key=lambda e: (e[0], e[1]))
            except TypeError:
                out.sort(key=lambda e: (repr(e[0]), repr(e[1])))
        if not labels:
            return [(a, b) for a, b, _ in out]
        return out

    edge_iterator = edges

    def size(self):
        """The number of edges.

        EXAMPLES::

            sage: graphs.PetersenGraph().size()
            15
        """
        return _sa().Integer(len(self.edges(sort=False)))

    num_edges = n_edges = size

    def has_edge(self, u, v=None, label=None):
        """Whether (u, v) is an edge.

        EXAMPLES::

            sage: graphs.CycleGraph(4).has_edge(0, 1), graphs.CycleGraph(4).has_edge(0, 2)
            (True, False)
        """
        if v is None:
            u, v = u[0], u[1]
        return u in self._adj and v in self._adj[u]

    def edge_label(self, u, v):
        """The label of the edge (u, v).

        EXAMPLES::

            sage: DiGraph({0: {1: 'a'}}).edge_label(0, 1)
            'a'
        """
        return self._adj[u][v]

    def neighbors(self, v, closed=False):
        """The neighbours of v (out- and in-neighbours of a digraph).

        EXAMPLES::

            sage: graphs.CycleGraph(5).neighbors(0)
            [1, 4]
        """
        nb = list(self._adj[v])
        if self._directed:
            nb += [u for u in self._in[v] if u not in self._adj[v]]
        nb = _sorted(nb)
        return ([v] if closed else []) + nb

    neighbors_out_ = neighbors

    def neighbor_out_iterator(self, v):
        """An iterator over the out-neighbours.

        EXAMPLES::

            sage: sorted(DiGraph({0: [1, 2]}).neighbor_out_iterator(0))
            [1, 2]
        """
        return iter(self._adj[v])

    def neighbors_out(self, v):
        """The out-neighbours.

        EXAMPLES::

            sage: DiGraph({0: [1, 2], 1: [2]}).neighbors_out(0)
            [1, 2]
        """
        return _sorted(self._adj[v])

    def neighbors_in(self, v):
        """The in-neighbours.

        EXAMPLES::

            sage: DiGraph({0: [1, 2], 1: [2]}).neighbors_in(2)
            [0, 1]
        """
        return _sorted(self._in[v]) if self._directed else _sorted(self._adj[v])

    def degree(self, vertices=None, labels=False):
        """The degree of v, or the list of degrees.

        EXAMPLES::

            sage: graphs.CycleGraph(5).degree(), graphs.CycleGraph(5).degree(0)
            ([2, 2, 2, 2, 2], 2)
        """
        def deg(v):
            d = len(self._adj[v]) + (len(self._in[v]) if self._directed else 0)
            if not self._directed and v in self._adj[v]:
                d += 1
            return _sa().Integer(d)
        if vertices is None:
            vs = self.vertices(sort=False)
            if labels:
                return {v: deg(v) for v in vs}
            return [deg(v) for v in vs]
        if vertices in self._adj:
            return deg(vertices)
        return [deg(v) for v in vertices]

    def adjacency_matrix(self, sparse=None, vertices=None, **kwds):
        """The adjacency matrix (vertices in sorted order).

        EXAMPLES::

            sage: graphs.CycleGraph(4).adjacency_matrix()
            [0 1 0 1]
            [1 0 1 0]
            [0 1 0 1]
            [1 0 1 0]
        """
        vs = vertices if vertices is not None else self.vertices(sort=True)
        idx = {v: i for i, v in enumerate(vs)}
        n = len(vs)
        rows = [[0] * n for _ in range(n)]
        for u in vs:
            for v in self._adj[u]:
                rows[idx[u]][idx[v]] = 1
        return _sa().matrix(_sa().ZZ, rows)

    am = adjacency_matrix

    def weighted_adjacency_matrix(self, sparse=None, vertices=None):
        """The adjacency matrix with the edge labels as entries.

        EXAMPLES::

            sage: DiGraph({0: {1: 2}, 1: {2: 1}, 2: {}}).weighted_adjacency_matrix()
            [0 2 0]
            [0 0 1]
            [0 0 0]
        """
        vs = vertices if vertices is not None else self.vertices(sort=True)
        idx = {v: i for i, v in enumerate(vs)}
        n = len(vs)
        rows = [[0] * n for _ in range(n)]
        for u in vs:
            for v, l in self._adj[u].items():
                rows[idx[u]][idx[v]] = l if l is not None else 1
        return _sa().matrix(rows)

    def laplacian_matrix(self, weighted=None, vertices=None, **kwds):
        """D - A, with the (out-)degrees on the diagonal.

        EXAMPLES::

            sage: graphs.CycleGraph(4).laplacian_matrix()
            [ 2 -1  0 -1]
            [-1  2 -1  0]
            [ 0 -1  2 -1]
            [-1  0 -1  2]
        """
        A = self.weighted_adjacency_matrix(vertices=vertices) if weighted else self.adjacency_matrix(vertices=vertices)
        n = A.nrows()
        rows = [[(sum(A[i, k] for k in range(n)) if i == j else 0) - A[i, j] for j in range(n)] for i in range(n)]
        return _sa().matrix(_sa().ZZ, rows)

    kirchhoff_matrix = laplacian_matrix

    def to_dictionary(self, edge_labels=False, multiple_edges=False):
        """{vertex: neighbours} (or {vertex: {neighbour: label}}).

        EXAMPLES::

            sage: graphs.CycleGraph(4).to_dictionary()
            {0: [1, 3], 1: [0, 2], 2: [1, 3], 3: [0, 2]}
        """
        out = {}
        for v in self.vertices(sort=True):
            if edge_labels:
                out[v] = {w: self._adj[v][w] for w in _sorted(self._adj[v])}
            else:
                out[v] = _sorted(self._adj[v])
        return out

    def distance(self, u, v, by_weight=False):
        """The length of a shortest path from u to v (+Infinity if none).

        EXAMPLES::

            sage: graphs.CycleGraph(6).distance(0, 3)
            3
        """
        if u == v:
            return _sa().Integer(0)
        seen = {u: 0}
        frontier = [u]
        while frontier:
            nxt = []
            for x in frontier:
                for y in self._adj[x]:
                    if y not in seen:
                        seen[y] = seen[x] + 1
                        if y == v:
                            return _sa().Integer(seen[y])
                        nxt.append(y)
            frontier = nxt
        return _sa().infinity

    def shortest_path(self, u, v, by_weight=False):
        """A shortest path from u to v, as a list of vertices.

        EXAMPLES::

            sage: graphs.CycleGraph(6).shortest_path(0, 2)
            [0, 1, 2]
        """
        prev = {u: None}
        frontier = [u]
        while frontier and v not in prev:
            nxt = []
            for x in frontier:
                for y in _sorted(self._adj[x]):
                    if y not in prev:
                        prev[y] = x
                        nxt.append(y)
            frontier = nxt
        if v not in prev:
            return []
        path = [v]
        while prev[path[-1]] is not None:
            path.append(prev[path[-1]])
        return list(reversed(path))

    def connected_components(self, sort=True):
        """The connected components (lists of vertices, the biggest first).

        EXAMPLES::

            sage: Graph({0: [1], 2: [3], 4: []}).connected_components()
            [[0, 1], [2, 3], [4]]
        """
        seen = set()
        out = []
        for v in self.vertices(sort=True):
            if v in seen:
                continue
            comp = []
            st = [v]
            seen.add(v)
            while st:
                x = st.pop()
                comp.append(x)
                nb = list(self._adj[x]) + (list(self._in[x]) if self._directed else [])
                for y in nb:
                    if y not in seen:
                        seen.add(y)
                        st.append(y)
            out.append(_sorted(comp))
        out.sort(key=lambda c: -len(c))
        return out

    def is_connected(self):
        """Whether the (underlying) graph is connected.

        EXAMPLES::

            sage: graphs.CycleGraph(4).is_connected(), Graph({0: [], 1: []}).is_connected()
            (True, False)
        """
        return len(self.connected_components()) <= 1

    def copy(self, immutable=None):
        """A copy.

        EXAMPLES::

            sage: G = graphs.CycleGraph(4); H = G.copy(); H.add_edge(0, 2); G.size(), H.size()
            (4, 5)
        """
        H = type(self).__new__(type(self))
        GenericGraph.__init__(H, self)
        return H

    def show(self, *args, **kwds):
        """Display the graph (a picture in the notebook; nothing here).

        EXAMPLES::

            sage: graphs.CycleGraph(4).show()  # sagebrush only
        """
        return None

    def show3d(self, *args, **kwds):
        """Show a 3d picture (nothing here).

        EXAMPLES::

            sage: graphs.CycleGraph(4).show3d()  # sagebrush only
        """
        return None

    def plot(self, *args, **kwds):
        """A picture of the graph: vertices on a circle (or the given
        positions), edges as lines.

        EXAMPLES::

            sage: graphs.CycleGraph(4).plot()
            Graphics object consisting of 9 graphics primitives
        """
        import math
        sa = _sa()
        vs = self.vertices(sort=True)
        n = len(vs)
        pos = self._pos or {v: (math.cos(2 * math.pi * i / max(n, 1) + math.pi / 2), math.sin(2 * math.pi * i / max(n, 1) + math.pi / 2)) for i, v in enumerate(vs)}
        g = sa.Graphics()
        for u, v, _ in self.edges(sort=True):
            g += sa.line([pos[u], pos[v]], color="black")
        g += sa.points([pos[v] for v in vs], size=200, color="#fec7b8", zorder=2)
        for v in vs:
            g += sa.text(str(v), pos[v], color="black", zorder=3)
        g.axes(False)
        return g

    def __eq__(self, o):
        return isinstance(o, GenericGraph) and o._directed == self._directed and set(self._adj) == set(o._adj) and \
            sorted(map(repr, self.edges(sort=False))) == sorted(map(repr, o.edges(sort=False)))

    def __hash__(self):
        return hash((self._directed, len(self._adj)))

    def relabel(self, perm=None, inplace=True):
        """Relabel the vertices 0..n-1 (or by a dict).

        EXAMPLES::

            sage: G = graphs.GridGraph([2, 2]); G.relabel(); G.vertices(sort=True)
            [0, 1, 2, 3]
        """
        vs = self.vertices(sort=True)
        if perm is None:
            perm = {v: i for i, v in enumerate(vs)}
        elif not isinstance(perm, dict):
            perm = dict(zip(vs, perm))
        H = type(self)()
        H._name = self._name
        for v in vs:
            H.add_vertex(perm[v])
        for u, v, l in self.edges(sort=False):
            H.add_edge(perm[u], perm[v], l)
        if inplace:
            self._adj, self._in = H._adj, H._in
            return None
        return H


class Graph(GenericGraph):
    """An undirected graph.

    EXAMPLES::

        sage: G = Graph({0: [1, 2], 1: [2]}); G
        Graph on 3 vertices
        sage: G.edges(sort=True), G.degree(0)
        ([(0, 1, None), (0, 2, None), (1, 2, None)], 2)
    """

    _directed = False

    def to_directed(self):
        """The digraph with both orientations of every edge.

        EXAMPLES::

            sage: graphs.CycleGraph(3).to_directed()
            Cycle graph: Digraph on 3 vertices
        """
        D = DiGraph(name=self._name)
        for v in self.vertices(sort=False):
            D.add_vertex(v)
        for u, v, l in self.edges(sort=False):
            D.add_edge(u, v, l)
            D.add_edge(v, u, l)
        return D

    def to_undirected(self):
        return self.copy()

    def is_tree(self):
        """Whether the graph is a tree.

        EXAMPLES::

            sage: graphs.PathGraph(4).is_tree(), graphs.CycleGraph(4).is_tree()
            (True, False)
        """
        return self.is_connected() and self.size() == self.order() - 1

    def spanning_trees_count(self):
        """The number of spanning trees (Kirchhoff's theorem).

        EXAMPLES::

            sage: graphs.CompleteGraph(5).spanning_trees_count()
            125
        """
        L = self.laplacian_matrix()
        n = L.nrows()
        if n <= 1:
            return _sa().Integer(1)
        return _sa().Integer(_sa().matrix(_sa().ZZ, [[L[i, j] for j in range(1, n)] for i in range(1, n)]).det())

    def tutte_polynomial(self):
        """The Tutte polynomial (deletion-contraction).

        EXAMPLES::

            sage: graphs.CycleGraph(3).tutte_polynomial()
            x^2 + x + y
        """
        R = _sa().PolynomialRing(_sa().ZZ, "x,y")
        x, y = R.gens()
        edges = [(u, v) for u, v, _ in self.edges(sort=True)]
        verts = self.vertices(sort=True)
        memo = {}

        def comps(vs, es):
            parent = {v: v for v in vs}

            def f(a):
                while parent[a] != a:
                    parent[a] = parent[parent[a]]
                    a = parent[a]
                return a
            for a, b in es:
                ra, rb = f(a), f(b)
                if ra != rb:
                    parent[ra] = rb
            return len({f(v) for v in vs})

        def T(vs, es):
            key = (tuple(sorted(map(repr, vs))), tuple(sorted(repr(tuple(sorted(map(repr, e)))) for e in es)))
            if key in memo:
                return memo[key]
            if not es:
                r = R(1)
            else:
                (a, b), rest = es[0], es[1:]
                if a == b:
                    r = y * T(vs, rest)
                elif comps(vs, rest) > comps(vs, es):
                    # a bridge: contract
                    r = x * T(*_contract(vs, rest, a, b))
                else:
                    r = T(vs, rest) + T(*_contract(vs, rest, a, b))
            memo[key] = r
            return r
        return T(verts, edges)


def _contract(vs, es, a, b):
    """Contract the edge (a, b): b becomes a."""
    nv = [v for v in vs if v != b]
    ne = [(a if u == b else u, a if v == b else v) for u, v in es]
    return nv, ne


class DiGraph(GenericGraph):
    """A directed graph.

    EXAMPLES::

        sage: D = DiGraph({0: {1: 2}, 1: {2: 1}, 2: {}}); D
        Digraph on 3 vertices
        sage: D.edges(sort=True), D.out_degree(), D.in_degree()
        ([(0, 1, 2), (1, 2, 1)], [1, 1, 0], [0, 1, 1])
    """

    _directed = True

    def out_degree(self, vertices=None, labels=False):
        """The out-degree of v, or the list of out-degrees.

        EXAMPLES::

            sage: DiGraph({0: [1, 2], 1: [2]}).out_degree(0)
            2
        """
        if vertices is None:
            vs = self.vertices(sort=False)
            if labels:
                return {v: _sa().Integer(len(self._adj[v])) for v in vs}
            return [_sa().Integer(len(self._adj[v])) for v in vs]
        if vertices in self._adj:
            return _sa().Integer(len(self._adj[vertices]))
        return [_sa().Integer(len(self._adj[v])) for v in vertices]

    def in_degree(self, vertices=None, labels=False):
        """The in-degree of v, or the list of in-degrees.

        EXAMPLES::

            sage: DiGraph({0: [1, 2], 1: [2]}).in_degree(2)
            2
        """
        if vertices is None:
            vs = self.vertices(sort=False)
            if labels:
                return {v: _sa().Integer(len(self._in[v])) for v in vs}
            return [_sa().Integer(len(self._in[v])) for v in vs]
        if vertices in self._adj:
            return _sa().Integer(len(self._in[vertices]))
        return [_sa().Integer(len(self._in[v])) for v in vertices]

    def to_undirected(self):
        """The underlying graph.

        EXAMPLES::

            sage: DiGraph({0: [1], 1: [0, 2]}).to_undirected().size()
            2
        """
        G = Graph(name=self._name)
        for v in self.vertices(sort=False):
            G.add_vertex(v)
        for u, v, l in self.edges(sort=False):
            G.add_edge(u, v, l)
        return G

    def to_directed(self):
        return self.copy()

    def reverse(self):
        """The digraph with every edge reversed.

        EXAMPLES::

            sage: DiGraph({0: [1]}).reverse().edges(sort=True)
            [(1, 0, None)]
        """
        D = DiGraph(name=self._name)
        for v in self.vertices(sort=False):
            D.add_vertex(v)
        for u, v, l in self.edges(sort=False):
            D.add_edge(v, u, l)
        return D

    def strongly_connected_components(self):
        """The strongly connected components.

        EXAMPLES::

            sage: DiGraph({0: [1], 1: [0, 2], 2: []}).strongly_connected_components()
            [[2], [0, 1]]
        """
        index = {}
        low = {}
        stack = []
        on = set()
        out = []
        counter = [0]

        def strong(v):
            index[v] = low[v] = counter[0]
            counter[0] += 1
            stack.append(v)
            on.add(v)
            for w in self._adj[v]:
                if w not in index:
                    strong(w)
                    low[v] = min(low[v], low[w])
                elif w in on:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(_sorted(comp))
        for v in self.vertices(sort=True):
            if v not in index:
                strong(v)
        return out


# ------------------------------------------------------------------ generators

class _GraphGenerators:
    """graphs: constructors of common graphs.

    EXAMPLES::

        sage: graphs.CycleGraph(5)
        Cycle graph: Graph on 5 vertices
    """

    def _make(self, name, n, edges, pos=None):
        G = Graph(name=name)
        for v in (range(n) if isinstance(n, int) else n):
            G.add_vertex(v)
        for e in edges:
            G.add_edge(*e)
        G._pos = pos
        return G

    def CycleGraph(self, n):
        """The cycle on n vertices.

        EXAMPLES::

            sage: graphs.CycleGraph(5).edges(sort=True, labels=False)
            [(0, 1), (0, 4), (1, 2), (2, 3), (3, 4)]
        """
        n = int(n)
        return self._make("Cycle graph", n, [(i, (i + 1) % n) for i in range(n)] if n > 2 else [(i, i + 1) for i in range(n - 1)])

    def PathGraph(self, n):
        """The path on n vertices.

        EXAMPLES::

            sage: graphs.PathGraph(4).edges(sort=True, labels=False)
            [(0, 1), (1, 2), (2, 3)]
        """
        n = int(n)
        return self._make("Path graph", n, [(i, i + 1) for i in range(n - 1)])

    def CompleteGraph(self, n):
        """The complete graph on n vertices.

        EXAMPLES::

            sage: graphs.CompleteGraph(4).size()
            6
        """
        n = int(n)
        return self._make("Complete graph", n, [(i, j) for i in range(n) for j in range(i + 1, n)])

    def StarGraph(self, n):
        """The star with n leaves.

        EXAMPLES::

            sage: graphs.StarGraph(3).edges(sort=True, labels=False)
            [(0, 1), (0, 2), (0, 3)]
        """
        n = int(n)
        return self._make("Star graph", n + 1, [(0, i) for i in range(1, n + 1)])

    def WheelGraph(self, n):
        """The wheel: a hub joined to a cycle on n - 1 vertices.

        EXAMPLES::

            sage: graphs.WheelGraph(5).edges(sort=True, labels=False)
            [(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (1, 4), (2, 3), (3, 4)]
        """
        n = int(n)
        m = n - 1
        return self._make("Wheel graph", n, [(0, i) for i in range(1, n)] + [(1 + i, 1 + (i + 1) % m) for i in range(m)])

    def CompleteBipartiteGraph(self, p, q):
        """K_{p,q}.

        EXAMPLES::

            sage: graphs.CompleteBipartiteGraph(2, 3).size()
            6
        """
        p, q = int(p), int(q)
        G = self._make("Complete bipartite graph of order %d+%d" % (p, q), p + q, [(i, p + j) for i in range(p) for j in range(q)])
        return G

    def PetersenGraph(self):
        """The Petersen graph.

        EXAMPLES::

            sage: graphs.PetersenGraph().degree()
            [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]
        """
        e = [(i, (i + 1) % 5) for i in range(5)] + [(i, i + 5) for i in range(5)] + [(5 + i, 5 + (i + 2) % 5) for i in range(5)]
        return self._make("Petersen graph", 10, e)

    def HouseGraph(self):
        """The house: a square with a roof.

        EXAMPLES::

            sage: graphs.HouseGraph().edges(sort=True, labels=False)
            [(0, 1), (0, 2), (1, 3), (2, 3), (2, 4), (3, 4)]
        """
        return self._make("House Graph", 5, [(0, 1), (0, 2), (1, 3), (2, 3), (2, 4), (3, 4)])

    def HouseXGraph(self):
        """The house with an X in the square.

        EXAMPLES::

            sage: graphs.HouseXGraph().edges(sort=True, labels=False)
            [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3), (2, 4), (3, 4)]
        """
        return self._make("House Graph", 5, [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3), (2, 4), (3, 4)])

    def DiamondGraph(self):
        """The diamond: K_4 minus an edge.

        EXAMPLES::

            sage: graphs.DiamondGraph().size()
            5
        """
        return self._make("Diamond Graph", 4, [(0, 1), (0, 2), (1, 2), (1, 3), (2, 3)])

    def GridGraph(self, dims):
        """The grid graph with the given dimensions.

        EXAMPLES::

            sage: graphs.GridGraph([2, 3]).vertices(sort=True)
            [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]
        """
        import itertools
        dims = [int(d) for d in dims]
        verts = list(itertools.product(*[range(d) for d in dims]))
        vs = set(verts)
        edges = []
        for v in verts:
            for k in range(len(dims)):
                w = tuple(v[i] + (1 if i == k else 0) for i in range(len(dims)))
                if w in vs:
                    edges.append((v, w))
        return self._make("Grid Graph for %s" % dims, verts, edges)

    def Grid2dGraph(self, m, n):
        """The m x n grid.

        EXAMPLES::

            sage: graphs.Grid2dGraph(2, 2).size()
            4
        """
        G = self.GridGraph([m, n])
        G._name = "2D Grid Graph"
        return G

    def CubeGraph(self, n):
        """The n-dimensional cube on the binary strings of length n.

        EXAMPLES::

            sage: graphs.CubeGraph(3).order(), graphs.CubeGraph(3).size()
            (8, 12)
        """
        n = int(n)
        verts = [format(i, "0%db" % n) if n else "" for i in range(2 ** n)]
        edges = [(a, b) for a in verts for b in verts if a < b and sum(x != y for x, y in zip(a, b)) == 1]
        return self._make("%d-Cube" % n, verts, edges)

    def RandomGNP(self, n, p, seed=None):
        """A random graph G(n, p).

        EXAMPLES::

            sage: graphs.RandomGNP(10, 0.5).order()
            10
        """
        import random as _r
        n = int(n)
        return self._make("Random graph", n, [(i, j) for i in range(n) for j in range(i + 1, n) if _r.random() < float(p)])

    def EmptyGraph(self):
        """The graph with no vertices.

        EXAMPLES::

            sage: graphs.EmptyGraph()
            Graph on 0 vertices
        """
        return Graph()


class _DiGraphGenerators:
    """digraphs: constructors of common digraphs.

    EXAMPLES::

        sage: digraphs.DeBruijn(2, 2)
        De Bruijn digraph (k=2, n=2): Looped digraph on 4 vertices
    """

    def DeBruijn(self, k, n, vertices="strings"):
        """The De Bruijn digraph B(k, n).

        EXAMPLES::

            sage: digraphs.DeBruijn(2, 2).edges(sort=True)
            [('00', '00', '0'), ('00', '01', '1'), ('01', '10', '0'), ('01', '11', '1'), ('10', '00', '0'), ('10', '01', '1'), ('11', '10', '0'), ('11', '11', '1')]
        """
        import itertools
        k, n = int(k), int(n)
        alpha = [str(i) for i in range(k)]
        words = ["".join(w) for w in itertools.product(alpha, repeat=n)]
        D = DiGraph(name="De Bruijn digraph (k=%d, n=%d)" % (k, n))
        for w in words:
            D.add_vertex(w)
        for w in words:
            for a in alpha:
                D.add_edge(w, w[1:] + a, a)
        return D

    def Circuit(self, n):
        """The directed cycle.

        EXAMPLES::

            sage: digraphs.Circuit(3).edges(sort=True, labels=False)
            [(0, 1), (1, 2), (2, 0)]
        """
        n = int(n)
        D = DiGraph(name="Circuit")
        for i in range(n):
            D.add_vertex(i)
        for i in range(n):
            D.add_edge(i, (i + 1) % n)
        return D

    def RandomDirectedGNC(self, n, seed=None):
        """A random growing network with copying (a random tree-like digraph
        whose vertex 0 is reachable from all others).

        EXAMPLES::

            sage: digraphs.RandomDirectedGNC(6).order()
            6
        """
        import random as _r
        n = int(n)
        D = DiGraph(name="Random directed GNC")
        D.add_vertex(0)
        if n > 1:
            D.add_edge(1, 0)
        for v in range(2, n):
            t = _r.randrange(v)
            D.add_edge(v, t)
            for w in list(D._adj[t]):
                D.add_edge(v, w)
        return D


graphs = _GraphGenerators()
digraphs = _DiGraphGenerators()


Graph.__module__ = "sage.graphs.graph"
DiGraph.__module__ = "sage.graphs.digraph"
