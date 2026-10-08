"""Sandpiles (the abelian sandpile model and chip-firing on graphs), as in
Sage: Sandpile(g, sink), SandpileConfig, SandpileDivisor, sandpiles.Complete,
Cycle, Diamond, House, Grid, Wheel, Fan; stabilization, recurrent and
superstable configurations, the sandpile group (order, invariant factors,
identity), burning configurations, Baker-Norine rank and linear
equivalence of divisors, the sandpile ideal (by Groebner bases), h-vectors
and Hilbert functions.  Printed as Sage prints them (configurations and
divisors are dicts)."""

import itertools
import math
import random as _random
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _Z(n):
    return _sa().Integer(n)


def _sorted(vs):
    try:
        return sorted(vs)
    except TypeError:
        return sorted(vs, key=repr)


# ------------------------------------------------------------------ the sandpile graph

class Sandpile:
    """A weighted directed graph with a sink, for chip-firing.

    EXAMPLES::

        sage: g = {0: {}, 1: {0: 1, 2: 1, 3: 2}, 2: {1: 1, 3: 1}, 3: {1: 1, 2: 1}}
        sage: S = Sandpile(g, 0)
        sage: sorted(S.recurrents(verbose=False))
        [[2, 1, 1], [3, 1, 0], [3, 1, 1]]
        sage: S.group_order(), S.invariant_factors()
        (3, [1, 1, 3])
    """

    def __init__(self, g=None, sink=None):
        import _sage_graph as G
        self._name = "sandpile graph"
        w = {}
        if isinstance(g, G.GenericGraph):
            directed = g.is_directed()
            self._name = (g.name() or "sandpile graph") if not hasattr(g, "_sandpile_name") else g._sandpile_name
            for v in g.vertices(sort=False):
                w.setdefault(v, {})
            for u, v, l in g.edges(sort=False):
                wt = 1 if (l is None or not isinstance(l, (int, _F)) and type(l).__name__ not in ("Integer", "Rational")) else int(l)
                w[u][v] = w[u].get(v, 0) + wt
                if not directed and u != v:
                    w[v][u] = w[v].get(u, 0) + wt
            if g.name():
                self._name = g.name()
        elif isinstance(g, dict):
            for v in g:
                w.setdefault(v, {})
            for v, nb in g.items():
                if isinstance(nb, dict):
                    for u, c in nb.items():
                        w[v][u] = w[v].get(u, 0) + int(c)
                        w.setdefault(u, {})
                else:
                    for u in nb:
                        w[v][u] = w[v].get(u, 0) + 1
                        w.setdefault(u, {})
        elif isinstance(g, Sandpile):
            w = {u: dict(d) for u, d in g._w.items()}
            sink = g._sink if sink is None else sink
            self._name = g._name
        else:
            raise TypeError("cannot make a sandpile from %r" % (g,))
        self._w = w
        self._order = list(w)  # the graph's own vertex order (for dicts)
        self._verts = _sorted(w)
        self._sink = sink if sink is not None else self._verts[0]
        if self._sink not in w:
            raise ValueError("the sink is not a vertex")
        self._nonsink = [v for v in self._verts if v != self._sink]
        self._idx = {v: i for i, v in enumerate(self._nonsink)}
        self._outdeg = {v: sum(w[v].values()) for v in self._verts}
        self._cache = {}

    # ---- the graph
    def __repr__(self):
        return "%s: %d vertices, sink = %s" % (self._name, len(self._verts), self._sink)

    def __str__(self):
        return self._name

    def name(self):
        """The name.

        EXAMPLES::

            sage: sandpiles.Complete(4).name()
            'Complete sandpile graph'
        """
        return self._name

    def vertices(self, sort=True):
        """The vertices.

        EXAMPLES::

            sage: sandpiles.Diamond().vertices(sort=True)
            [0, 1, 2, 3]
        """
        return list(self._verts)

    def sink(self):
        """The sink.

        EXAMPLES::

            sage: sandpiles.Diamond().sink()
            0
        """
        return self._sink

    def nonsink_vertices(self):
        """The vertices other than the sink.

        EXAMPLES::

            sage: sandpiles.Diamond().nonsink_vertices()
            [1, 2, 3]
        """
        return list(self._nonsink)

    def num_verts(self):
        """The number of vertices.

        EXAMPLES::

            sage: sandpiles.Diamond().num_verts(), sandpiles.Diamond().n_vertices()
            (4, 4)
        """
        return _Z(len(self._verts))

    n_vertices = order = num_verts

    def dict(self):
        """The graph as {vertex: {neighbour: weight}}.

        EXAMPLES::

            sage: Sandpile({0: [], 1: [0, 3, 4], 2: [0, 3, 5], 3: [2, 5], 4: [1, 3], 5: [2, 3]}, 0).dict()
            {0: {}, 1: {0: 1, 3: 1, 4: 1}, 2: {0: 1, 3: 1, 5: 1}, 3: {2: 1, 5: 1}, 4: {1: 1, 3: 1}, 5: {2: 1, 3: 1}}
        """
        return {v: {u: _Z(self._w[v][u]) for u in _sorted(self._w[v])} for v in self._verts}

    def out_degree(self, v=None):
        """The out-degree of v, or {vertex: out-degree}.

        EXAMPLES::

            sage: sandpiles.Diamond().out_degree()
            {0: 2, 1: 3, 2: 3, 3: 2}
        """
        if v is not None:
            return _Z(self._outdeg[v])
        return {u: _Z(self._outdeg[u]) for u in self._verts}

    def in_degree(self, v=None):
        """The in-degree of v, or {vertex: in-degree}.

        EXAMPLES::

            sage: sandpiles.Diamond().in_degree()
            {0: 2, 1: 3, 2: 3, 3: 2}
        """
        ind = {u: 0 for u in self._verts}
        for u in self._verts:
            for x, c in self._w[u].items():
                ind[x] += c
        if v is not None:
            return _Z(ind[v])
        return {u: _Z(ind[u]) for u in self._verts}

    def is_undirected(self):
        """Whether every edge has its reverse, with the same weight.

        EXAMPLES::

            sage: sandpiles.Diamond().is_undirected()
            True
        """
        return all(self._w[v].get(u, 0) == c for u in self._verts for v, c in self._w[u].items())

    def edges(self, sort=True, labels=True):
        """The edges (u, v, weight).

        EXAMPLES::

            sage: Sandpile({0: {}, 1: {0: 2}}, 0).edges()
            [(1, 0, 2)]
        """
        out = [(u, v, _Z(c)) for u in self._verts for v, c in sorted(self._w[u].items(), key=lambda t: self._verts.index(t[0]))]
        return out if labels else [(a, b) for a, b, _ in out]

    def laplacian(self):
        """The Laplacian matrix (D - A, rows for the vertices in order).

        EXAMPLES::

            sage: sandpiles.Diamond().laplacian()
            [ 2 -1 -1  0]
            [-1  3 -1 -1]
            [-1 -1  3 -1]
            [ 0 -1 -1  2]
        """
        vs = self._verts
        rows = [[(self._outdeg[u] if u == v else 0) - self._w[u].get(v, 0) for v in vs] for u in vs]
        return _sa().matrix(_sa().ZZ, rows)

    def reduced_laplacian(self):
        """The Laplacian without the sink's row and column.

        EXAMPLES::

            sage: sandpiles.Diamond().reduced_laplacian()
            [ 3 -1 -1]
            [-1  3 -1]
            [-1 -1  2]
        """
        vs = self._nonsink
        rows = [[(self._outdeg[u] if u == v else 0) - self._w[u].get(v, 0) for v in vs] for u in vs]
        return _sa().matrix(_sa().ZZ, rows)

    def _rlap(self):
        if "rlap" not in self._cache:
            vs = self._nonsink
            self._cache["rlap"] = [[(self._outdeg[u] if u == v else 0) - self._w[u].get(v, 0) for v in vs] for u in vs]
        return self._cache["rlap"]

    def distance(self, u, v):
        """The length of a shortest directed path from u to v.

        EXAMPLES::

            sage: S = Sandpile({0: [], 1: [0, 3, 4], 2: [0, 3, 5], 3: [2, 5], 4: [1, 3], 5: [2, 3]}, 0)
            sage: [S.distance(v, 0) for v in S.vertices(sort=True)]
            [0, 1, 1, 2, 2, 2]
        """
        if u == v:
            return _Z(0)
        seen = {u: 0}
        fr = [u]
        while fr:
            nx = []
            for x in fr:
                for y in self._w[x]:
                    if y not in seen:
                        seen[y] = seen[x] + 1
                        if y == v:
                            return _Z(seen[y])
                        nx.append(y)
            fr = nx
        return _sa().infinity

    def show(self, **kwds):
        """Show the graph (nothing here).

        EXAMPLES::

            sage: sandpiles.Diamond().show()  # sagebrush only
        """
        return None

    show3d = show

    @staticmethod
    def version():
        """The version of the sandpile module.

        EXAMPLES::

            sage: Sandpile.version()
            Sage Sandpiles Version 2.4
        """
        print("Sage Sandpiles Version 2.4")

    def max_stable_div(self):
        """The maximal stable divisor: out-degree minus 1 at every vertex.

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable_div()
            {0: 1, 1: 2, 2: 2, 3: 1}
        """
        return self._div([self._outdeg[v] - 1 for v in self._verts])

    def smith_form(self):
        """The Smith form of the Laplacian: (D, U, V) with U L V = D.

        EXAMPLES::

            sage: D, U, V = sandpiles.Complete(4).smith_form(); D.diagonal()
            [1, 4, 4, 0]
        """
        return self.laplacian().smith_form()

    # ---- configurations
    def _config(self, vals):
        return SandpileConfig(self, list(vals))

    def zero_config(self):
        """The configuration with no chips.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config()
            {1: 0, 2: 0, 3: 0}
        """
        return self._config([0] * len(self._nonsink))

    _zero_config = zero_config

    def max_stable(self):
        """The maximal stable configuration (out-degree minus 1 everywhere).

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable()
            {1: 2, 2: 2, 3: 1}
        """
        return self._config([self._outdeg[v] - 1 for v in self._nonsink])

    def all_k_config(self, k):
        """The configuration with k chips on every vertex.

        EXAMPLES::

            sage: sandpiles.Diamond().all_k_config(7)
            {1: 7, 2: 7, 3: 7}
        """
        return self._config([int(k)] * len(self._nonsink))

    def _stabilize(self, c):
        """(stable c, firing vector) for a tuple c of nonsink values."""
        c = list(c)
        n = len(c)
        idx = self._idx
        deg = [self._outdeg[v] for v in self._nonsink]
        fire = [0] * n
        nbrs = [[(idx[u], w) for u, w in self._w[v].items() if u in idx] for v in self._nonsink]
        stack = [i for i in range(n) if c[i] >= deg[i]]
        while stack:
            i = stack.pop()
            if c[i] < deg[i]:
                continue
            k = c[i] // deg[i]
            c[i] -= k * deg[i]
            fire[i] += k
            for j, w in nbrs[i]:
                before = c[j]
                c[j] += k * w
                if before < deg[j] <= c[j]:
                    stack.append(j)
            if c[i] >= deg[i]:
                stack.append(i)
        return tuple(c), tuple(fire)

    def _is_stable_t(self, c):
        return all(x < self._outdeg[v] for x, v in zip(c, self._nonsink))

    def burning_script(self):
        """The minimal burning script: the least sigma >= 1 with sigma times
        the reduced Laplacian nonnegative.

        EXAMPLES::

            sage: g = {0: {}, 1: {0: 1, 3: 1, 4: 1}, 2: {0: 1, 3: 1, 5: 1}, 3: {2: 1, 5: 1}, 4: {1: 1, 3: 1}, 5: {2: 1, 3: 1}}
            sage: Sandpile(g, 0).burning_script()
            {1: 1, 2: 3, 3: 5, 4: 1, 5: 4}
        """
        return self._config(self._burning()[1])

    def burning_config(self):
        """The minimal burning configuration: the burning script times the
        reduced Laplacian.

        EXAMPLES::

            sage: g = {0: {}, 1: {0: 1, 3: 1, 4: 1}, 2: {0: 1, 3: 1, 5: 1}, 3: {2: 1, 5: 1}, 4: {1: 1, 3: 1}, 5: {2: 1, 3: 1}}
            sage: Sandpile(g, 0).burning_config()
            {1: 2, 2: 0, 3: 1, 4: 1, 5: 0}
        """
        return self._config(self._burning()[0])

    def _burning(self):
        if "burn" not in self._cache:
            vs = self._nonsink
            n = len(vs)
            idx = self._idx
            deg = [self._outdeg[v] for v in vs]
            inn = [[] for _ in range(n)]
            for u in vs:
                for v, w in self._w[u].items():
                    if v in idx and v != u:
                        inn[idx[v]].append((idx[u], w))
            sig = [1] * n
            changed = True
            while changed:
                changed = False
                for i in range(n):
                    loop = self._w[vs[i]].get(vs[i], 0)
                    need = -((-sum(sig[j] * w for j, w in inn[i])) // (deg[i] - loop)) if deg[i] - loop > 0 else sig[i]
                    if need > sig[i]:
                        sig[i] = need
                        changed = True
            L = self._rlap()
            b = [sum(sig[i] * L[i][j] for i in range(n)) for j in range(n)]
            self._cache["burn"] = (tuple(b), tuple(sig))
        return self._cache["burn"]

    def _is_recurrent_t(self, c):
        if not self._is_stable_t(c):
            return False
        b = self._burning()[0]
        s, _ = self._stabilize([x + y for x, y in zip(c, b)])
        return tuple(s) == tuple(c)

    def _superstables_t(self):
        if "ss" not in self._cache:
            ms = [self._outdeg[v] - 1 for v in self._nonsink]
            n = len(ms)
            zero = tuple([0] * n)
            out = [zero]
            seen = {zero}
            frontier = [zero]
            while frontier:
                nxt = []
                for c in frontier:
                    for i in range(n):
                        d = list(c)
                        d[i] += 1
                        d = tuple(d)
                        if d in seen or d[i] > ms[i]:
                            continue
                        if self._is_recurrent_t(tuple(m - x for m, x in zip(ms, d))):
                            seen.add(d)
                            out.append(d)
                            nxt.append(d)
                frontier = nxt
            self._cache["ss"] = out
        return self._cache["ss"]

    def superstables(self, verbose=True):
        """The superstable configurations (by increasing degree).

        EXAMPLES::

            sage: sandpiles.Complete(3).superstables()
            [{1: 0, 2: 0}, {1: 0, 2: 1}, {1: 1, 2: 0}]
        """
        out = [list(c) for c in self._superstables_t()]
        out.sort(key=lambda c: (sum(c), [-x for x in reversed(c)]))
        if verbose:
            return [self._config(c) for c in out]
        return [[_Z(x) for x in c] for c in out]

    def recurrents(self, verbose=True):
        """The recurrent configurations (the duals of the superstables).

        EXAMPLES::

            sage: sandpiles.Complete(3).recurrents(verbose=False)
            [[1, 1], [1, 0], [0, 1]]
        """
        ms = [self._outdeg[v] - 1 for v in self._nonsink]
        out = [[m - x for m, x in zip(ms, c)] for c in self.superstables(verbose=False)]
        if verbose:
            return [self._config(c) for c in out]
        return [[_Z(x) for x in c] for c in out]

    def max_superstables(self, verbose=True):
        """The maximal superstable configurations.

        EXAMPLES::

            sage: sorted(sandpiles.Diamond().max_superstables(False))
            [[0, 1, 1], [0, 2, 0], [1, 0, 1], [2, 0, 0]]
        """
        ss = [tuple(c) for c in self.superstables(verbose=False)]
        st = set(ss)
        n = len(self._nonsink)
        out = [c for c in ss if not any(tuple(c[j] + (j == i) for j in range(n)) in st for i in range(n))]
        out.sort(key=lambda c: (-sum(c), [-x for x in reversed(c)]))
        return [self._config(c) for c in out] if verbose else [list(c) for c in out]

    def min_recurrents(self, verbose=True):
        """The minimal recurrent configurations.

        EXAMPLES::

            sage: sorted(sandpiles.Diamond().min_recurrents(verbose=False))
            [[0, 2, 1], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
        """
        ms = [self._outdeg[v] - 1 for v in self._nonsink]
        out = [[m - x for m, x in zip(ms, c)] for c in self.max_superstables(verbose=False)]
        return [self._config(c) for c in out] if verbose else [[_Z(x) for x in c] for c in out]

    def _is_recurrent(self, c):
        return self._is_recurrent_t(tuple(c.values()) if isinstance(c, dict) else tuple(c))

    def identity(self, verbose=True):
        """The identity of the sandpile group: the stabilization of
        2 max_stable - (2 max_stable)^o.

        EXAMPLES::

            sage: sandpiles.Diamond().identity()
            {1: 2, 2: 2, 3: 0}
        """
        ms = [self._outdeg[v] - 1 for v in self._nonsink]
        a, _ = self._stabilize([2 * m for m in ms])
        e, _ = self._stabilize([2 * m - x for m, x in zip(ms, a)])
        return self._config(e) if verbose else [_Z(x) for x in e]

    def group_order(self):
        """The order of the sandpile group (the determinant of the reduced
        Laplacian).

        EXAMPLES::

            sage: sandpiles.Diamond().group_order()
            8
        """
        if not self._nonsink:
            return _Z(1)
        return _Z(abs(self.reduced_laplacian().det()))

    def invariant_factors(self):
        """The invariant factors of the sandpile group.

        EXAMPLES::

            sage: sandpiles.Complete(4).invariant_factors()
            [1, 4, 4]
        """
        return [_Z(d) for d in self.reduced_laplacian().elementary_divisors()]

    def _smith(self):
        if "smith" not in self._cache:
            self._cache["smith"] = self.reduced_laplacian().smith_form()
        return self._cache["smith"]

    def group_gens(self, verbose=True):
        """Generators of the sandpile group (recurrent configurations), one
        for each invariant factor greater than 1.

        EXAMPLES::

            sage: len(sandpiles.Diamond().group_gens())
            1
        """
        D, U, V = self._smith()
        n = len(self._nonsink)
        # Z^n / Z^n L ~ Z^n / Z^n D via x -> x V; generators: the rows of V^-1
        Vi = V.inverse()
        gens = []
        for i in range(n):
            if D[i, i] != 1:
                row = [int(Vi[i, j]) for j in range(n)]
                gens.append(self._equiv_recurrent(row))
        out = [self._config(g) for g in gens]
        return tuple(out) if verbose else tuple(list(c.values()) for c in out)

    group_generators = group_gens

    def _equiv_recurrent(self, c):
        """The recurrent configuration equivalent to c (modulo the reduced
        Laplacian): (c' + e)^o for c' = c plus multiples of the group order
        (nonnegative) and e the identity."""
        c = [int(x) for x in c]
        if not c:
            return []
        d = int(self.group_order())
        m = min(c)
        if m < 0:
            k = (-m + d - 1) // d
            c = [x + k * d for x in c]
        e = self.identity(verbose=False)
        s, _ = self._stabilize([x + int(y) for x, y in zip(c, e)])
        return list(s)

    def h_vector(self):
        """The number of superstables of each degree.

        EXAMPLES::

            sage: sandpiles.House().h_vector()
            [1, 4, 6]
        """
        degs = [sum(c) for c in self._superstables_t()]
        m = max(degs)
        return [_Z(degs.count(d)) for d in range(m + 1)]

    def hilbert_function(self):
        """The Hilbert function of the homogeneous sandpile ideal: the
        partial sums of the h-vector.

        EXAMPLES::

            sage: sandpiles.House().hilbert_function()
            [1, 5, 11]
        """
        out, s = [], 0
        for h in self.h_vector():
            s += h
            out.append(_Z(s))
        return out

    def postulation(self):
        """The largest degree of a superstable configuration.

        EXAMPLES::

            sage: sandpiles.House().postulation()
            2
        """
        return _Z(len(self.h_vector()) - 1)

    def genus(self):
        """The genus of an undirected sandpile: edges - vertices + 1.

        EXAMPLES::

            sage: sandpiles.House().genus()
            2
        """
        if not self.is_undirected():
            raise UserWarning("The underlying graph must be undirected.")
        e = sum(c for u in self._verts for v, c in self._w[u].items()) // 2
        return _Z(e - len(self._verts) + 1)

    def stable_configs(self, smax=None):
        """A generator of all the stable configurations (at most smax).

        EXAMPLES::

            sage: len(list(sandpiles.Cycle(3).stable_configs()))
            4
        """
        ms = [self._outdeg[v] - 1 for v in self._nonsink] if smax is None else list(smax.values() if isinstance(smax, dict) else smax)
        for c in itertools.product(*[range(m + 1) for m in ms]):
            yield self._config(c)

    def symmetric_recurrents(self, orbits):
        """The recurrent configurations constant on the given orbits.

        EXAMPLES::

            sage: sandpiles.Complete(4).symmetric_recurrents([[1, 2, 3]])
            [{1: 2, 2: 2, 3: 2}]
        """
        out = []
        for c in self.recurrents():
            if all(len({c[v] for v in o}) == 1 for o in orbits):
                out.append(c)
        return out

    def markov_chain(self, state, distrib=None):
        """The sandpile Markov chain from state (a configuration: add a grain
        at a random vertex and stabilize; a divisor: add a grain).

        EXAMPLES::

            sage: m = sandpiles.Complete(4).markov_chain([0, 0, 0]); next(m).deg()
            1
        """
        if isinstance(state, (SandpileConfig, SandpileDivisor)):
            st = state
        elif len(list(state)) == len(self._verts):
            st = SandpileDivisor(self, list(state))
        else:
            st = SandpileConfig(self, list(state))
        div = isinstance(st, SandpileDivisor)
        verts = self._verts if (div or (distrib is not None and len(distrib) == len(self._verts))) else self._nonsink
        if distrib is None:
            distrib = [1.0 / len(verts)] * len(verts)
        while True:
            r = _random.random()
            acc = 0.0
            v = verts[-1]
            for u, pr in zip(verts, distrib):
                acc += float(pr)
                if r < acc:
                    v = u
                    break
            d = dict(st)
            if v in d:
                d[v] += 1
            st = type(st)(self, d)
            if not div:
                st = st.stabilize()
            yield st

    def stationary_density(self):
        """The stationary density of the sandpile (the average degree of a
        recurrent configuration, divided by the number of nonsink
        vertices).

        EXAMPLES::

            sage: sandpiles.Complete(3).stationary_density()
            10/9
        """
        R = self.recurrents(verbose=False)
        ds = self._outdeg[self._sink]
        tot = sum(sum(c) + ds for c in R)
        from _sage_poly import _norm
        return _norm(_F(tot, len(R) * len(self._verts)))

    # ---- divisors
    def _div(self, vals):
        return SandpileDivisor(self, list(vals))

    def zero_div(self):
        """The zero divisor.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_div()
            {0: 0, 1: 0, 2: 0, 3: 0}
        """
        return self._div([0] * len(self._verts))

    _zero_div = zero_div

    def all_k_div(self, k):
        """The divisor with k chips on every vertex.

        EXAMPLES::

            sage: sandpiles.House().all_k_div(7)
            {0: 7, 1: 7, 2: 7, 3: 7, 4: 7}
        """
        return self._div([int(k)] * len(self._verts))

    def canonical_divisor(self):
        """The canonical divisor: out-degree minus 2 at each vertex
        (undirected sandpiles).

        EXAMPLES::

            sage: sandpiles.Complete(4).canonical_divisor()
            {0: 1, 1: 1, 2: 1, 3: 1}
        """
        if not self.is_undirected():
            raise UserWarning("Only for undirected graphs.")
        return self._div([self._outdeg[v] - self._w[v].get(v, 0) - 2 for v in self._verts])

    def nonspecial_divisors(self, verbose=True):
        """The nonspecial divisors: the maximal superstables minus the
        sink.

        EXAMPLES::

            sage: N = sandpiles.Complete(4).nonspecial_divisors(); len(N), N[0]
            (6, {0: -1, 1: 0, 2: 1, 3: 2})
        """
        out = []
        for c in self.max_superstables(verbose=False):
            d = [0] * len(self._verts)
            for v, x in zip(self._nonsink, c):
                d[self._verts.index(v)] = x
            d[self._verts.index(self._sink)] = -1
            out.append(d)
        out.sort()
        return [self._div(d) for d in out] if verbose else [[_Z(x) for x in d] for d in out]

    def jacobian_representatives(self, verbose=True):
        """Representatives of the Jacobian group: the divisors s - deg(s) sink
        for the superstables s (one per class modulo the Laplacian's row
        space, for a directed sandpile).

        EXAMPLES::

            sage: sandpiles.Complete(3).jacobian_representatives(False)
            [[0, 0, 0], [-1, 0, 1], [-1, 1, 0]]
        """
        return self.picard_representatives(0, verbose)

    def picard_representatives(self, d, verbose=True):
        """Representatives of the divisor classes of degree d.

        EXAMPLES::

            sage: sandpiles.Complete(3).picard_representatives(3, False)
            [[3, 0, 0], [2, 0, 1], [2, 1, 0]]
        """
        out = []
        iq = self._verts.index(self._sink)
        for c in self.superstables(verbose=False):
            e = [0] * len(self._verts)
            for v, x in zip(self._nonsink, c):
                e[self._verts.index(v)] = int(x)
            e[iq] = int(d) - sum(int(x) for x in c)
            out.append(e)
        if not self.is_undirected():
            keep = []
            for e in out:
                if not any(_in_row_lattice(self, [a - b for a, b in zip(e, f)]) for f in keep):
                    keep.append(e)
            out = keep
        return [self._div(x) for x in out] if verbose else [[_Z(t) for t in x] for x in out]

    # ---- algebra
    def ring(self):
        """The polynomial ring of the sandpile ideal: variables x_v for the
        vertices, in decreasing order, with the reverse lexicographic
        order.

        EXAMPLES::

            sage: sandpiles.Diamond().ring()
            Multivariate Polynomial Ring in x3, x2, x1, x0 over Rational Field
        """
        if "ring" not in self._cache:
            # x_k for the k-th vertex; the variables ordered by decreasing
            # distance to the sink (then decreasing index)
            order = sorted(self._verts, key=lambda u: (-self._dist_to_sink(u), -self._verts.index(u)))
            self._cache["varnames"] = {u: "x%d" % self._verts.index(u) for u in self._verts}
            names = [self._cache["varnames"][u] for u in order]
            self._cache["ring"] = _sa().PolynomialRing(_sa().QQ, names, order="degrevlex")
        return self._cache["ring"]

    def _var(self, v):
        """x_i for the i-th vertex by distance to the sink (as Sage numbers
        the ring's variables)."""
        R = self.ring()
        return R.gen(R._names.index(self._cache["varnames"][v]))

    def unsaturated_ideal(self):
        """The ideal of the binomials x^(sigma L)^+ - x^(sigma L)^- for
        sigma the unit vectors of the nonsink vertices.

        EXAMPLES::

            sage: sandpiles.Diamond().unsaturated_ideal().gens()
            [x1^3 - x3*x2*x0, x2^3 - x3*x1*x0, x3^2 - x2*x1]
        """
        R = self.ring()
        gens = []
        for v in self._nonsink:
            pos = self._var(v) ** self._outdeg[v]
            neg = R(1)
            for u, c in self._w[v].items():
                if u != v:
                    neg = neg * self._var(u) ** c
            gens.append(pos - neg)
        return R.ideal(gens)

    def ideal(self, gens=False):
        """The saturated homogeneous sandpile ideal (the lattice ideal of the
        image of the reduced Laplacian), by a Groebner basis.

        EXAMPLES::

            sage: sandpiles.Diamond().ideal().gens()
            [x2*x1 - x0^2, x3^2 - x0^2, x1^3 - x3*x2*x0, x3*x1^2 - x2^2*x0, x2^3 - x3*x1*x0, x3*x2^2 - x1^2*x0]
        """
        if "ideal" not in self._cache:
            self._cache["ideal"] = self._saturated_ideal()
        I = self._cache["ideal"]
        return I.gens() if gens else I

    def _saturated_ideal(self):
        """Saturate the unsaturated ideal by the product of the variables
        (x_sink = 1 in the affine ideal, then homogenize)."""
        import _sage_mpoly as M
        R = self.ring()
        J = self.unsaturated_ideal()
        # saturation by x0 (the sink variable) and the others: compute in
        # R[t] the elimination of t from J + (t*prod(x) - 1)
        n = len(self._verts)
        T = M.MPolynomialRing(R._base, None, ("_t",) + R._names, "degrevlex")
        t = T.gen(0)
        lift = lambda f: M.MPolynomial(T, {(0,) + e: c for e, c in f._d.items()})
        prod = T.one()
        for i in range(n):
            prod = prod * T.gen(1 + i)
        E = M.MPolynomialIdeal(T, [lift(g) for g in J.gens()] + [t * prod - 1]).elimination_ideal([t])
        G = [M.MPolynomial(R, {e[1:]: c for e, c in g._d.items()}) for g in E._gens]
        G = M.groebner_basis(G, R)
        # Sage's order: by increasing leading monomial
        G.sort(key=lambda g: R._key(g._leading()[0]))
        return M.MPolynomialIdeal(R, [_binomial_normal(g) for g in G])

    def groebner(self):
        """The reduced Groebner basis of the sandpile ideal (by decreasing
        leading monomial).

        EXAMPLES::

            sage: sandpiles.Diamond().groebner()
            [x3*x2^2 - x1^2*x0, x2^3 - x3*x1*x0, x3*x1^2 - x2^2*x0, x1^3 - x3*x2*x0, x3^2 - x0^2, x2*x1 - x0^2]
        """
        import _sage_mpoly as M
        return M.PolynomialSequence(self.ring(), list(reversed(list(self.ideal().gens()))))

    def avalanche_polynomial(self, multivariable=True):
        """The avalanche polynomial: sum over the recurrents c and the
        vertices v of the monomial of the vertices fired when a chip is
        added to c at v (multivariable), or of x0^(number of firings).

        EXAMPLES::

            sage: sandpiles.Complete(4).avalanche_polynomial()
            9*x0*x1*x2 + 2*x0*x1 + 2*x0*x2 + 2*x1*x2 + 3*x0 + 3*x1 + 3*x2 + 24
            sage: sandpiles.Complete(4).avalanche_polynomial(False)
            9*x0^3 + 6*x0^2 + 9*x0 + 24
        """
        n = len(self._nonsink)
        R = _sa().PolynomialRing(_sa().ZZ, n, "x") if n > 1 else _sa().PolynomialRing(_sa().ZZ, "x0")
        xs = R.gens()
        total = R(0)
        for c in self.recurrents(verbose=False):
            for i in range(n):
                d = list(c)
                d[i] += 1
                _, f = self._stabilize(d)
                m = R(1)
                if multivariable:
                    for j in range(n):
                        if f[j]:
                            m = m * xs[j] ** f[j]
                else:
                    m = xs[0] ** sum(f)
                total = total + m
        return total

    def tutte_polynomial(self):
        """The Tutte polynomial of the underlying undirected graph.

        EXAMPLES::

            sage: sandpiles.Cycle(3).tutte_polynomial()
            x^2 + x + y
        """
        import _sage_graph as G
        g = G.Graph()
        for v in self._verts:
            g.add_vertex(v)
        for u in self._verts:
            for v in self._w[u]:
                g.add_edge(u, v)
        return g.tutte_polynomial()

    def reorder_vertices(self):
        """The same sandpile with vertices relabelled 0..n-1 by increasing
        distance from the sink.

        EXAMPLES::

            sage: sandpiles.Diamond().reorder_vertices().dict()
            {0: {1: 1, 2: 1}, 1: {0: 1, 2: 1, 3: 1}, 2: {0: 1, 1: 1, 3: 1}, 3: {1: 1, 2: 1}}
        """
        order = sorted(self._verts, key=lambda v: (self._dist_to_sink(v), self._verts.index(v)))
        rel = {v: i for i, v in enumerate(order)}
        g = {rel[u]: {rel[v]: c for v, c in self._w[u].items()} for u in self._verts}
        return Sandpile(g, rel[self._sink])

    def _dist_to_sink(self, v):
        d = self.distance(v, self._sink)
        return int(d) if d != _sa().infinity else 10 ** 9


def _in_row_lattice(S, x):
    """Whether x is an integer combination of the rows of the Laplacian."""
    L = S.laplacian()
    n = L.nrows()
    rows = [[int(L[i, j]) for j in range(n)] for i in range(n)]
    from sagebrush import nf
    H = [r for r in nf.hermite_form(rows) if any(r)]
    v = list(x)
    for r in H:
        p = next(j for j, t in enumerate(r) if t)
        if v[p] % r[p]:
            return False
        q = v[p] // r[p]
        v = [a - q * b for a, b in zip(v, r)]
    return not any(v)


def _binomial_normal(g):
    """A binomial with its leading coefficient 1 (as Singular prints)."""
    return g


# ------------------------------------------------------------------ configurations

class SandpileConfig(dict):
    """A configuration: chips on the nonsink vertices.

    EXAMPLES::

        sage: g = {0: {}, 1: {0: 1, 2: 1, 3: 2}, 2: {1: 1, 3: 1}, 3: {1: 1, 2: 1}}
        sage: S = Sandpile(g, 0); c = SandpileConfig(S, {1: 5, 2: 0, 3: 1}); c
        {1: 5, 2: 0, 3: 1}
        sage: c.fire_vertex(1), c.stabilize(), ~c
        ({1: 1, 2: 1, 3: 3}, {1: 2, 2: 1, 3: 1}, {1: 2, 2: 1, 3: 1})
    """

    def __init__(self, S, c):
        self._S = S
        if isinstance(c, dict):
            vals = [int(c.get(v, 0)) for v in S._nonsink]
        else:
            c = list(c)
            if len(c) != len(S._nonsink):
                raise ValueError("wrong number of vertices")
            vals = [int(x) for x in c]
        super().__init__((v, _Z(x)) for v, x in zip(S._nonsink, vals))

    def _t(self):
        return tuple(int(self[v]) for v in self._S._nonsink)

    def sandpile(self):
        """The sandpile.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config().sandpile()
            Diamond sandpile graph: 4 vertices, sink = 0
        """
        return self._S

    def values(self):
        """The values in the order of the nonsink vertices (a list).

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable().values()
            [2, 2, 1]
        """
        return [self[v] for v in self._S._nonsink]

    def deg(self):
        """The number of chips.

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable().deg()
            5
        """
        return _Z(sum(self._t()))

    def support(self):
        """The vertices with chips.

        EXAMPLES::

            sage: SandpileConfig(sandpiles.Diamond(), [0, 1, 0]).support()
            [2]
        """
        return [v for v in self._S._nonsink if self[v] != 0]

    def __hash__(self):
        return hash(self._t())

    def _new(self, vals):
        return SandpileConfig(self._S, list(vals))

    def __add__(self, o):
        if isinstance(o, SandpileConfig):
            return self._new(a + b for a, b in zip(self._t(), o._t()))
        return NotImplemented

    def __sub__(self, o):
        if isinstance(o, SandpileConfig):
            return self._new(a - b for a, b in zip(self._t(), o._t()))
        return NotImplemented

    def __neg__(self):
        return self._new(-a for a in self._t())

    def __mul__(self, o):
        if isinstance(o, SandpileConfig):
            # the sandpile group operation: the recurrent element equivalent
            # to the sum
            return (self + o).equivalent_recurrent()
        return self._new(a * int(o) for a in self._t())

    def __rmul__(self, o):
        return self._new(a * int(o) for a in self._t())

    def __and__(self, o):
        return (self + o).stabilize()

    def __pow__(self, k):
        k = int(k)
        if k == 0:
            return self._S.identity()
        if k < 0:
            return (-self) ** (-k)
        r = self.equivalent_recurrent()
        for _ in range(k - 1):
            r = r * self
        return r

    def _inverse(self):
        S = self._S
        e = S.identity()
        c = self.equivalent_recurrent()
        for x in S.recurrents():
            if (c & x) == e:
                return x
        raise ArithmeticError("no inverse")

    def __invert__(self):
        return self.stabilize()

    def __le__(self, o):
        return all(a <= b for a, b in zip(self._t(), o._t()))

    def __lt__(self, o):
        return self <= o and self != o

    def __ge__(self, o):
        return o <= self

    def __gt__(self, o):
        return o < self

    def __eq__(self, o):
        if isinstance(o, SandpileConfig):
            return self._t() == o._t()
        return dict.__eq__(self, o)

    def __ne__(self, o):
        return not self == o

    def fire_vertex(self, v):
        """Fire v once (without checking that it is unstable).

        EXAMPLES::

            sage: SandpileConfig(sandpiles.Diamond(), [3, 0, 0]).fire_vertex(1)
            {1: 0, 2: 1, 3: 1}
        """
        S = self._S
        c = list(self._t())
        i = S._idx[v]
        c[i] -= S._outdeg[v]
        for u, w in S._w[v].items():
            if u in S._idx:
                c[S._idx[u]] += w
        return self._new(c)

    def fire_script(self, sigma):
        """Fire each vertex v sigma[v] times.

        EXAMPLES::

            sage: SandpileConfig(sandpiles.Diamond(), [3, 3, 3]).fire_script([1, 1, 0])
            {1: 1, 2: 1, 3: 5}
        """
        S = self._S
        sig = [int(sigma[v]) for v in S._nonsink] if isinstance(sigma, dict) else [int(x) for x in (sigma.values() if isinstance(sigma, SandpileConfig) else sigma)]
        c = list(self._t())
        L = S._rlap()
        for i, s in enumerate(sig):
            if s:
                for j in range(len(c)):
                    c[j] -= s * L[i][j]
        return self._new(c)

    def unstable(self):
        """The unstable vertices.

        EXAMPLES::

            sage: SandpileConfig(sandpiles.Diamond(), [3, 3, 0]).unstable()
            [1, 2]
        """
        S = self._S
        return [v for v in S._nonsink if self[v] >= S._outdeg[v]]

    def fire_unstable(self):
        """Fire every unstable vertex once.

        EXAMPLES::

            sage: SandpileConfig(sandpiles.Diamond(), [3, 3, 0]).fire_unstable()
            {1: 1, 2: 1, 3: 2}
        """
        c = self
        S = self._S
        sig = [1 if self[v] >= S._outdeg[v] else 0 for v in S._nonsink]
        return self.fire_script(sig)

    def stabilize(self, with_firing_vector=False):
        """The stabilization (and the firing vector).

        EXAMPLES::

            sage: SandpileConfig(sandpiles.Diamond(), [5, 0, 1]).stabilize(with_firing_vector=True)
            [{1: 2, 2: 1, 3: 0}, {1: 2, 2: 1, 3: 2}]
        """
        s, f = self._S._stabilize(self._t())
        self.__dict__["_stabilize"] = (s, f)
        if with_firing_vector:
            return [self._new(s), self._new(f)]
        return self._new(s)

    def is_stable(self):
        """Whether no vertex is unstable.

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable().is_stable()
            True
        """
        return self._S._is_stable_t(self._t())

    def is_recurrent(self):
        """Whether the configuration is recurrent.

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable().is_recurrent(), sandpiles.Diamond().zero_config().is_recurrent()
            (True, False)
        """
        return self._S._is_recurrent_t(self._t())

    def is_superstable(self):
        """Whether the configuration is superstable (its dual is
        recurrent).

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config().is_superstable()
            True
        """
        S = self._S
        ms = [S._outdeg[v] - 1 for v in S._nonsink]
        t = self._t()
        if any(x < 0 or x > m for x, m in zip(t, ms)):
            return False
        return S._is_recurrent_t(tuple(m - x for m, x in zip(ms, t)))

    def is_symmetric(self, orbits):
        """Whether the configuration is constant on each orbit.

        EXAMPLES::

            sage: sandpiles.Complete(4).max_stable().is_symmetric([[1, 2, 3]])
            True
        """
        return all(len({self[v] for v in o}) == 1 for o in orbits)

    def dualize(self):
        """max_stable - self.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config().dualize()
            {1: 2, 2: 2, 3: 1}
        """
        return self._S.max_stable() - self

    def equivalent_recurrent(self, with_firing_vector=False):
        """The recurrent configuration equivalent to self.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config().equivalent_recurrent()
            {1: 2, 2: 2, 3: 0}
        """
        r = self._new(self._S._equiv_recurrent(list(self._t())))
        if with_firing_vector:
            return [r, self._firing_between(r)]
        return r

    def equivalent_superstable(self, with_firing_vector=False):
        """The superstable configuration equivalent to self.

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable().equivalent_superstable()
            {1: 0, 2: 0, 3: 1}
        """
        S = self._S
        # the dual of the recurrent configuration equivalent to
        # max_stable - self
        d = (S.max_stable() - self).equivalent_recurrent()
        s = S.max_stable() - d
        if with_firing_vector:
            return [s, self._firing_between(s)]
        return s

    def _firing_between(self, other):
        """sigma with self - sigma L = other."""
        S = self._S
        n = len(S._nonsink)
        diff = [a - b for a, b in zip(self._t(), other._t())]
        L = S.reduced_laplacian()
        sig = L.solve_left(_sa().vector(diff))
        return self._new([int(x) for x in sig])

    def add_random(self, distrib=None):
        """Add a chip at a random nonsink vertex.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config().add_random().deg()
            1
        """
        S = self._S
        v = _random.choice(S._nonsink)
        c = dict(self)
        c[v] += 1
        return SandpileConfig(S, c)

    def burst_size(self, v):
        """The amount of sand that goes into the sink when a grain is added
        at v to the recurrent c' with (c' + v)^o = self (1 if v is the
        sink).

        EXAMPLES::

            sage: s = sandpiles.Diamond(); [i.burst_size(0) for i in s.recurrents()]
            [1, 1, 1, 1, 1, 1, 1, 1]
        """
        S = self._S
        if v == S._sink:
            return _Z(1)
        i = S._idx[v]
        t = self._t()
        for c in S.recurrents(verbose=False):
            d = [int(x) for x in c]
            d[i] += 1
            st, f = S._stabilize(d)
            if tuple(st) == t:
                into = sum(f[S._idx[u]] * S._w[u].get(S._sink, 0) for u in S._nonsink)
                return _Z(into)
        raise ValueError("not a recurrent configuration")

    def order(self):
        """The order of the (recurrent equivalent) configuration in the
        sandpile group.

        EXAMPLES::

            sage: sandpiles.Diamond().max_stable().order()
            2
        """
        S = self._S
        e = S.identity()
        c = self.equivalent_recurrent()
        x = c
        k = 1
        while x != e:
            x = x & c
            k += 1
        return _Z(k)

    def show(self, **kwds):
        """Show the configuration (nothing here).

        EXAMPLES::

            sage: sandpiles.Diamond().zero_config().show()  # sagebrush only
        """
        return None


# ------------------------------------------------------------------ divisors

class SandpileDivisor(dict):
    """A divisor: an integer on every vertex.

    EXAMPLES::

        sage: G = sandpiles.Complete(5); D = SandpileDivisor(G, [1, 2, 2, 0, 2])
        sage: D.rank(), D.effective_div(False)
        (2, [[0, 1, 1, 4, 1], [1, 2, 2, 0, 2], [4, 0, 0, 3, 0]])
    """

    def __init__(self, S, D):
        self._S = S
        if isinstance(D, dict):
            vals = [int(D.get(v, 0)) for v in S._verts]
        else:
            D = list(D)
            if len(D) != len(S._verts):
                raise ValueError("wrong number of vertices")
            vals = [int(x) for x in D]
        super().__init__((v, _Z(x)) for v, x in zip(S._verts, vals))

    def _t(self):
        return tuple(int(self[v]) for v in self._S._verts)

    def sandpile(self):
        """The sandpile.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_div().sandpile()
            Diamond sandpile graph: 4 vertices, sink = 0
        """
        return self._S

    def values(self):
        """The values in the order of the vertices (a list).

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [1, 0, 2, 0]).values()
            [1, 0, 2, 0]
        """
        return [self[v] for v in self._S._verts]

    def deg(self):
        """The degree (the total number of chips).

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [1, 0, 2, -1]).deg()
            2
        """
        return _Z(sum(self._t()))

    def support(self):
        """The vertices with nonzero value.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [1, 0, 2, 0]).support()
            [0, 2]
        """
        return [v for v in self._S._verts if self[v] != 0]

    def __hash__(self):
        return hash(self._t())

    def _new(self, vals):
        return SandpileDivisor(self._S, list(vals))

    def __add__(self, o):
        if isinstance(o, SandpileDivisor):
            return self._new(a + b for a, b in zip(self._t(), o._t()))
        return NotImplemented

    def __sub__(self, o):
        if isinstance(o, SandpileDivisor):
            return self._new(a - b for a, b in zip(self._t(), o._t()))
        return NotImplemented

    def __neg__(self):
        return self._new(-a for a in self._t())

    def __rmul__(self, k):
        return self._new(int(k) * a for a in self._t())

    __mul__ = __rmul__

    def __le__(self, o):
        return all(a <= b for a, b in zip(self._t(), o._t()))

    def __lt__(self, o):
        return self <= o and self != o

    def __ge__(self, o):
        return o <= self

    def __gt__(self, o):
        return o < self

    def add_random(self, distrib=None):
        """Add a grain at a random vertex.

        EXAMPLES::

            sage: sandpiles.Diamond().zero_div().add_random().deg()
            1
        """
        S = self._S
        v = _random.choice(S._verts)
        d = dict(self)
        d[v] += 1
        return SandpileDivisor(S, d)

    def __eq__(self, o):
        if isinstance(o, SandpileDivisor):
            return self._t() == o._t()
        return dict.__eq__(self, o)

    def __ne__(self, o):
        return not self == o

    def _is_effective(self):
        return min(self._t()) >= 0

    def fire_vertex(self, v):
        """Fire v once.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [0, 3, 0, 0]).fire_vertex(1)
            {0: 1, 1: 0, 2: 1, 3: 1}
        """
        S = self._S
        d = list(self._t())
        i = S._verts.index(v)
        d[i] -= S._outdeg[v]
        for u, w in S._w[v].items():
            d[S._verts.index(u)] += w
        return self._new(d)

    def fire_script(self, sigma):
        """Fire each vertex v sigma[v] times.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [0, 3, 0, 0]).fire_script([0, 1, 0, 0])
            {0: 1, 1: 0, 2: 1, 3: 1}
        """
        S = self._S
        sig = [int(sigma[v]) for v in S._verts] if isinstance(sigma, dict) else [int(x) for x in sigma]
        d = list(self._t())
        n = len(S._verts)
        for i, s in enumerate(sig):
            if s:
                v = S._verts[i]
                d[i] -= s * S._outdeg[v]
                for u, w in S._w[v].items():
                    d[S._verts.index(u)] += s * w
        return self._new(d)

    def unstable(self):
        """The vertices with at least as many chips as their out-degree.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [3, 3, 0, 0]).unstable()
            [0, 1]
        """
        S = self._S
        return [v for v in S._verts if self[v] >= S._outdeg[v]]

    def fire_unstable(self):
        """Fire every unstable vertex once.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [3, 3, 0, 0]).fire_unstable()
            {0: 2, 1: 1, 2: 2, 3: 1}
        """
        S = self._S
        return self.fire_script([1 if self[v] >= S._outdeg[v] else 0 for v in S._verts])

    def _reduce(self):
        """(q-reduced divisor, firing script): the divisor equivalent to self
        that is superstable away from the sink q (Dhar's algorithm)."""
        S = self._S
        q = S._sink
        iq = S._verts.index(q)
        d = list(self._t())
        n = len(S._verts)
        cfg = [d[S._verts.index(v)] for v in S._nonsink]
        ms = [S._outdeg[v] - 1 for v in S._nonsink]
        r = S._equiv_recurrent([m - x for m, x in zip(ms, cfg)])
        sup = [m - x for m, x in zip(ms, r)]
        out = [0] * n
        for v, x in zip(S._nonsink, sup):
            out[S._verts.index(v)] = x
        out[iq] = sum(d) - sum(sup)
        return out

    def q_reduced(self, verbose=True):
        """The divisor equivalent to self that is superstable away from the
        sink.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Complete(4), [2, 0, 0, 1]).q_reduced()
            {0: 2, 1: 0, 2: 0, 3: 1}
        """
        r = self._reduce()
        return self._new(r) if verbose else [_Z(x) for x in r]

    def is_q_reduced(self):
        """Whether self is superstable away from the sink.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Complete(4), [2, 0, 0, 1]).is_q_reduced()
            True
        """
        S = self._S
        c = SandpileConfig(S, [self[v] for v in S._nonsink])
        return c.is_superstable()

    def is_linearly_equivalent(self, D, with_firing_vector=False):
        """Whether D is linearly equivalent to self (and the firing vector).

        EXAMPLES::

            sage: S = sandpiles.Complete(4); D = SandpileDivisor(S, [1, 2, 0, 0])
            sage: D.is_linearly_equivalent(D.fire_vertex(1))
            True
        """
        if not isinstance(D, SandpileDivisor):
            D = SandpileDivisor(self._S, D)
        eq = self.deg() == D.deg() and self._reduce() == D._reduce()
        if not with_firing_vector:
            return eq
        if not eq:
            return _sa().vector(_sa().ZZ, [])
        return _firing_vector(self, D)

    def is_alive(self, cycle=False):
        """Whether the divisor stays unstable forever (no stable divisor is
        reached by firing unstable vertices).

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Cycle(6), [1, 1, 1, 1, 2, 0]).is_alive()
            True
        """
        seq = []
        index = {}
        D = self
        while True:
            if not D.unstable():
                return False
            t = D._t()
            if t in index:
                return seq[index[t]:] if cycle else True
            index[t] = len(seq)
            seq.append(D)
            D = D.fire_unstable()

    def effective_div(self, verbose=True, with_firing_vectors=False):
        """All effective divisors linearly equivalent to self.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Complete(5), [1, 2, 2, 0, 2]).effective_div(False)
            [[0, 1, 1, 4, 1], [1, 2, 2, 0, 2], [4, 0, 0, 3, 0]]
        """
        S = self._S
        d = sum(self._t())
        n = len(S._verts)
        if d < 0:
            return []
        target = self._reduce()
        out = []
        for comp in _compositions(d, n):
            E = SandpileDivisor(S, comp)
            if E._reduce() == target:
                out.append(list(comp))
        out.sort()
        if with_firing_vectors:
            return [(self._new(e) if verbose else [_Z(x) for x in e], _firing_vector(self, self._new(e))) for e in out]
        return [self._new(e) for e in out] if verbose else [[_Z(x) for x in e] for e in out]

    def rank(self, with_witness=False):
        """The Baker-Norine rank: -1 if self is not equivalent to an
        effective divisor, else the largest r such that self - E is for
        every effective E of degree r.

        EXAMPLES::

            sage: S = sandpiles.Complete(5); D = SandpileDivisor(S, [1, 2, 2, 0, 2])
            sage: K = S.canonical_divisor(); D.rank() - (K - D).rank() == D.deg() + 1 - S.genus()
            True
        """
        S = self._S
        memo = {}

        def eff(t):
            r = SandpileDivisor(S, list(t))._reduce()
            return r[S._verts.index(S._sink)] >= 0

        def rk(t):
            key = tuple(SandpileDivisor(S, list(t))._reduce())
            if key in memo:
                return memo[key]
            if not eff(t):
                memo[key] = -1
                return -1
            best = None
            for i in range(len(t)):
                u = list(t)
                u[i] -= 1
                r = rk(tuple(u))
                if best is None or r < best:
                    best = r
                if best == -1:
                    break
            memo[key] = best + 1
            return best + 1
        r = rk(self._t())
        if not with_witness:
            return _Z(r)
        # the witness: the first effective E of degree r + 1 (in Sage's
        # IntegerVectors order) with self - E not winnable
        t = self._t()
        for E in _int_vectors(r + 1, len(t)):
            if not eff(tuple(a - b for a, b in zip(t, E))):
                return (_Z(r), self._new(E))
        return (_Z(r), self._new([0] * len(t)))

    def is_weierstrass_pt(self, v="sink"):
        """Whether v is a Weierstrass point (nonzero Weierstrass weight).

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Cycle(4), [2, 0, 0, 0]).is_weierstrass_pt(0)
            True
        """
        return int(self.weierstrass_gap_seq(v, True)[1]) != 0

    def weierstrass_rank_seq(self, v="sink"):
        """The ranks of D, D - v, D - 2v, ... down to -1.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Cycle(4), [2, 0, 0, 0]).weierstrass_rank_seq()
            (1, 0, 0, -1)
        """
        S = self._S
        if v == "sink":
            v = S._sink
        i = S._verts.index(v)
        out = []
        t = list(self._t())
        while True:
            r = int(SandpileDivisor(S, t).rank())
            out.append(_Z(r))
            if r == -1:
                break
            t[i] -= 1
        return tuple(out)

    def weierstrass_gap_seq(self, v="sink", weight=True):
        """The k with rank(D - (k-1) v) != rank(D - k v), and (weight=True)
        the Weierstrass weight sum(k_i - i).

        EXAMPLES::

            sage: D = SandpileDivisor(sandpiles.Cycle(4), [2, 0, 0, 0])
            sage: D.weierstrass_gap_seq(), D.weierstrass_gap_seq(1, False)
            (((1, 3), 1), (1, 2))
        """
        seq = [int(x) for x in self.weierstrass_rank_seq(v)]
        gaps = tuple(_Z(k) for k in range(1, len(seq)) if seq[k - 1] != seq[k])
        if not weight:
            return gaps
        w = sum(int(g) - (i + 1) for i, g in enumerate(gaps))
        return (gaps, _Z(w))

    def weierstrass_pts(self, with_rank_seq=False):
        """The Weierstrass points.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Cycle(4), [2, 0, 0, 0]).weierstrass_pts()
            (0, 2)
        """
        pts = tuple(v for v in self._S._verts if self.is_weierstrass_pt(v))
        if with_rank_seq:
            return tuple((v, self.weierstrass_rank_seq(v)) for v in pts)
        return pts

    def weierstrass_div(self, verbose=True):
        """The divisor of Weierstrass weights.

        EXAMPLES::

            sage: SandpileDivisor(sandpiles.Diamond(), [4, 2, 1, 0]).weierstrass_div()
            {0: 1, 1: 0, 2: 2, 3: 1}
        """
        out = [int(self.weierstrass_gap_seq(v, True)[1]) for v in self._S._verts]
        return self._new(out) if verbose else [_Z(x) for x in out]

    def show(self, **kwds):
        """Show the divisor (nothing here).

        EXAMPLES::

            sage: sandpiles.Diamond().zero_div().show()  # sagebrush only
        """
        return None


def _firing_vector(D, E):
    """The vector v with v_sink = 0 and D - L v = E (L the Laplacian)."""
    S = D._S
    n = len(S._verts)
    iq = S._verts.index(S._sink)
    L = S.laplacian()
    diff = [a - b for a, b in zip(D._t(), E._t())]
    cols = [j for j in range(n) if j != iq]
    rows = [i for i in range(n) if i != iq]
    M = _sa().matrix(_sa().QQ, [[L[i, j] for j in cols] for i in rows])
    x = M.solve_right(_sa().vector([diff[i] for i in rows]))
    out = [0] * n
    for k, j in enumerate(cols):
        out[j] = int(x[k])
    return _sa().vector(_sa().ZZ, out)


def _int_vectors(d, n):
    """The vectors of n nonnegative integers with sum d, in Sage's
    IntegerVectors order: [d, 0, ...] first."""
    if n == 1:
        yield (d,)
        return
    for k in range(d, -1, -1):
        for rest in _int_vectors(d - k, n - 1):
            yield (k,) + rest


def _compositions(d, n):
    """All tuples of n nonnegative integers with sum d."""
    if n == 1:
        yield (d,)
        return
    for k in range(d + 1):
        for rest in _compositions(d - k, n - 1):
            yield (k,) + rest


# ------------------------------------------------------------------ generators

class _SandpileGenerators:
    """sandpiles: common sandpiles.

    EXAMPLES::

        sage: sandpiles.Complete(4)
        Complete sandpile graph: 4 vertices, sink = 0
    """

    def _named(self, g, sink, name):
        S = Sandpile(g, sink)
        S._name = name
        return S

    def Complete(self, n):
        """The complete graph on n vertices, sink 0.

        EXAMPLES::

            sage: sandpiles.Complete(4).group_order()
            16
        """
        n = int(n)
        return self._named({i: {j: 1 for j in range(n) if j != i} for i in range(n)}, 0, "Complete sandpile graph")

    def Cycle(self, n):
        """The cycle on n vertices, sink 0.

        EXAMPLES::

            sage: sandpiles.Cycle(5).dict()
            {0: {1: 1, 4: 1}, 1: {0: 1, 2: 1}, 2: {1: 1, 3: 1}, 3: {2: 1, 4: 1}, 4: {0: 1, 3: 1}}
        """
        n = int(n)
        g = {i: {} for i in range(n)}
        for i in range(n):
            a, b = (i - 1) % n, (i + 1) % n
            for j in sorted({a, b}):
                if j != i:
                    g[i][j] = 1
        return self._named(g, 0, "Cycle sandpile graph")

    def Diamond(self):
        """The diamond: two triangles sharing an edge, sink 0.

        EXAMPLES::

            sage: sandpiles.Diamond().dict()
            {0: {1: 1, 2: 1}, 1: {0: 1, 2: 1, 3: 1}, 2: {0: 1, 1: 1, 3: 1}, 3: {1: 1, 2: 1}}
        """
        g = {0: {1: 1, 2: 1}, 1: {0: 1, 2: 1, 3: 1}, 2: {0: 1, 1: 1, 3: 1}, 3: {1: 1, 2: 1}}
        return self._named(g, 0, "Diamond sandpile graph")

    def House(self):
        """The house: a square with a triangle on top, sink 0.

        EXAMPLES::

            sage: sandpiles.House().dict()
            {0: {1: 1, 2: 1}, 1: {0: 1, 3: 1}, 2: {0: 1, 3: 1, 4: 1}, 3: {1: 1, 2: 1, 4: 1}, 4: {2: 1, 3: 1}}
        """
        g = {0: {1: 1, 2: 1}, 1: {0: 1, 3: 1}, 2: {0: 1, 3: 1, 4: 1}, 3: {1: 1, 2: 1, 4: 1}, 4: {2: 1, 3: 1}}
        return self._named(g, 0, "House sandpile graph")

    def Wheel(self, n):
        """The wheel on n vertices (hub 0, the sink).

        EXAMPLES::

            sage: sandpiles.Wheel(4).dict()
            {0: {1: 1, 2: 1, 3: 1}, 1: {0: 1, 2: 1, 3: 1}, 2: {0: 1, 1: 1, 3: 1}, 3: {0: 1, 1: 1, 2: 1}}
        """
        n = int(n)
        m = n - 1
        g = {0: {i: 1 for i in range(1, n)}}
        for i in range(1, n):
            nb = {0, 1 + (i % m), 1 + ((i - 2) % m)}
            g[i] = {j: 1 for j in sorted(nb) if j != i}
        return self._named(g, 0, "Wheel sandpile graph")

    def Fan(self, n, deg_three_verts=False):
        """The fan: a path on n - 1 vertices joined to the vertex 0 (sink).

        EXAMPLES::

            sage: sandpiles.Fan(4).dict()
            {0: {1: 1, 2: 1, 3: 1}, 1: {0: 1, 2: 1}, 2: {0: 1, 1: 1, 3: 1}, 3: {0: 1, 2: 1}}
        """
        n = int(n)
        g = {0: {i: 1 for i in range(1, n)}}
        for i in range(1, n):
            nb = {0}
            if i > 1:
                nb.add(i - 1)
            if i < n - 1:
                nb.add(i + 1)
            g[i] = {j: 1 for j in sorted(nb)}
        return self._named(g, 0, "Wheel sandpile graph")

    def Grid(self, m, n):
        """The m x n grid with a sink (0, 0) joined to the boundary
        (twice at the corners).

        EXAMPLES::

            sage: sandpiles.Grid(2, 2).dict()
            {(0, 0): {(1, 1): 2, (1, 2): 2, (2, 1): 2, (2, 2): 2}, (1, 1): {(0, 0): 2, (1, 2): 1, (2, 1): 1}, (1, 2): {(0, 0): 2, (1, 1): 1, (2, 2): 1}, (2, 1): {(0, 0): 2, (1, 1): 1, (2, 2): 1}, (2, 2): {(0, 0): 2, (1, 2): 1, (2, 1): 1}}
        """
        m, n = int(m), int(n)
        g = {}
        sink = (0, 0)
        for i in range(1, m + 1):
            for j in range(1, n + 1):
                nb = {}
                for (a, b) in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)):
                    if 1 <= a <= m and 1 <= b <= n:
                        nb[(a, b)] = 1
                    else:
                        nb[sink] = nb.get(sink, 0) + 1
                d = dict(sorted([(k, v) for k, v in nb.items() if k != sink]))
                if sink in nb:
                    d[sink] = nb[sink]
                g[(i, j)] = d
        g[sink] = {}
        for v, nb in g.items():
            if v != sink and sink in nb:
                g[sink][v] = nb[sink]
        S = Sandpile(g, sink)
        S._name = "2D Grid sandpile graph for [%d, %d]" % (m + 2, n + 2)
        return S


sandpiles = _SandpileGenerators()


def firing_graph(S, eff):
    """The digraph whose vertices are the divisors eff, with an edge D -> E
    when E is obtained from D by firing a vertex.

    EXAMPLES::

        sage: S = sandpiles.Cycle(4); eff = SandpileDivisor(S, [1, 1, 0, 0]).effective_div()
        sage: firing_graph(S, eff)
        Digraph on 2 vertices
    """
    import _sage_graph as G
    D = G.DiGraph()
    keys = [tuple(e.values()) for e in eff]
    for k in keys:
        D.add_vertex(k)
    ks = set(keys)
    for e, k in zip(eff, keys):
        for v in S.vertices():
            f = tuple(e.fire_vertex(v).values())
            if f in ks:
                D.add_edge(k, f, v)
    return D


def parallel_firing_graph(S, eff):
    """Like firing_graph, with an edge for firing all unstable vertices.

    EXAMPLES::

        sage: S = sandpiles.Cycle(4); eff = SandpileDivisor(S, [1, 1, 0, 0]).effective_div()
        sage: parallel_firing_graph(S, eff)
        Digraph on 2 vertices
    """
    import _sage_graph as G
    D = G.DiGraph()
    keys = [tuple(e.values()) for e in eff]
    for k in keys:
        D.add_vertex(k)
    ks = set(keys)
    for e, k in zip(eff, keys):
        f = tuple(e.fire_unstable().values())
        if f in ks and f != k:
            D.add_edge(k, f)
    return D
