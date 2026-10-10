"""Polyhedra, as in Sage: Polyhedron(vertices=, rays=, lines=) or
Polyhedron(ieqs=, eqns=) over ZZ, QQ (exact, by the double description
method, with the representations listed in the order Sage's default PPL
backend gives them) and RDF; H- and V-representation objects, faces (in
Sage's face iterator order), f-vectors, volumes, lattice points, polar,
Minkowski sums, intersections, products, prisms, pyramids, plots and the
polytopes catalog."""

import itertools
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _gcd(a, b):
    while b:
        a, b = b, a % b
    return abs(a)


def _q(x):
    if isinstance(x, _F):
        return _F(x.numerator, x.denominator)
    if isinstance(x, bool):
        return _F(int(x))
    if isinstance(x, int):
        return _F(x)
    if isinstance(x, float):
        return x
    if hasattr(x, "numerator") and hasattr(x, "denominator"):
        n, d = x.numerator, x.denominator
        n = n() if callable(n) else n
        d = d() if callable(d) else d
        return _F(int(n), int(d))
    try:
        return _F(int(x))
    except Exception:
        return float(x)


def _out(f, ring):
    if ring == "RDF":
        return _sa().RDF(float(f))
    return _sa()._q(_F(f))


def _fmt(f, ring):
    if ring == "RDF":
        return repr(_sa().RDF(float(f) + 0.0))
    f = _F(f)
    return str(f.numerator) if f.denominator == 1 else "%d/%d" % (f.numerator, f.denominator)


def _dot(a, b):
    return sum((x * y for x, y in zip(a, b)), 0)


def _norm(r):
    """A primitive integer row (or, for floats, unchanged)."""
    if any(isinstance(x, float) for x in r):
        m = max(abs(float(x)) for x in r)
        return tuple(float(x) / m for x in r) if m else tuple(float(x) for x in r)
    den = 1
    for x in r:
        x = _F(x)
        den = den * x.denominator // _gcd(den, x.denominator)
    r = [int(_F(x) * den) for x in r]
    g = 0
    for x in r:
        g = _gcd(g, x)
    return tuple(x // g for x in r) if g else tuple(r)


def _lnorm(r):
    r = _norm(r)
    k = next((i for i, x in enumerate(r) if x != 0), None)
    if k is not None and r[k] < 0:
        r = tuple(-x for x in r)
    return r


def _rank(rows):
    M = [[_F(x) if not isinstance(x, float) else x for x in r] for r in rows]
    rk = 0
    ncol = len(M[0]) if M else 0
    for c in range(ncol):
        p = next((i for i in range(rk, len(M)) if not _iszero(M[i][c])), None)
        if p is None:
            continue
        M[rk], M[p] = M[p], M[rk]
        for i in range(len(M)):
            if i != rk and M[i][c] != 0:
                f = M[i][c] / M[rk][c]
                M[i] = [x - f * y for x, y in zip(M[i], M[rk])]
        rk += 1
    return rk


def _iszero(x):
    return abs(x) < 1e-9 if isinstance(x, float) else x == 0


# ------------------------------------------- the double description method

def _convert(src, N, kinds):
    """Convert a system (generators to constraints or back), processing the
    source rows in order (Chernikova's algorithm, organised as PPL does).
    kinds[t] == 'line' marks bidirectional rows (lines, equalities).
    Returns (dest rows, number of leading bidirectional dest rows)."""
    dest = [tuple(int(i == j) for j in range(N)) for i in range(N)]
    nlines = N
    sat = [set() for _ in dest]
    for t, g in enumerate(src):
        sp = [_dot(r, g) for r in dest]
        sp = [0 if _iszero(x) else x for x in sp]
        k = next((i for i in range(nlines - 1, -1, -1) if sp[i] != 0), None)
        isline = kinds[t] == "line"
        if k is not None:
            if sp[k] < 0:
                dest[k] = tuple(-x for x in dest[k])
                sp[k] = -sp[k]
            for j in range(len(dest)):
                if j != k and sp[j] != 0:
                    dest[j] = _norm(tuple(sp[k] * a - sp[j] * b for a, b in zip(dest[j], dest[k])))
                    sp[j] = 0
            for j in range(len(dest)):
                if j != k:
                    sat[j].add(t)
            last = nlines - 1
            dest[k], dest[last] = dest[last], dest[k]
            sat[k], sat[last] = sat[last], sat[k]
            nlines -= 1
            if isline:
                del dest[nlines]
                del sat[nlines]
            continue
        for j in range(len(dest)):
            if sp[j] == 0:
                sat[j].add(t)
        ineq = list(range(nlines, len(dest)))
        a = ineq[:]
        lo, mid, hi = 0, 0, len(a) - 1
        while mid <= hi:
            v = sp[a[mid]]
            if v == 0:
                a[lo], a[mid] = a[mid], a[lo]
                lo += 1
                mid += 1
            elif v > 0:
                mid += 1
            else:
                a[mid], a[hi] = a[hi], a[mid]
                hi -= 1
        keep, negs = a[:mid], a[mid:]
        posl = [i for i in keep if sp[i] > 0]

        def combos(ps, ns):
            new = []
            for p in ps:
                for q in ns:
                    common = sat[p] & sat[q]
                    if all(not (common <= sat[l]) for l in ineq if l not in (p, q)):
                        new.append((_norm(tuple(sp[p] * x - sp[q] * y for x, y in zip(dest[q], dest[p]))), common | {t}))
            return new
        if isline:
            zero = [i for i in keep if sp[i] == 0]
            new = combos(posl, negs)
            rows = [(dest[i], sat[i]) for i in range(nlines)] + [(dest[i], sat[i]) for i in zero] + new
        else:
            if not negs:
                continue
            new = combos(posl, negs)
            rows = [(dest[i], sat[i], sp[i]) for i in keep + negs] + [(r, s, 0) for r, s in new]
            i, n = 0, len(rows)
            while i < n:
                if rows[i][2] < 0:
                    rows[i], rows[n - 1] = rows[n - 1], rows[i]
                    n -= 1
                else:
                    i += 1
            rows = [(dest[i], sat[i]) for i in range(nlines)] + [(r, s) for r, s, _ in rows[:n]]
        dest = [r for r, s in rows]
        sat = [set(s) for r, s in rows]
    return dest, nlines


def _echelon(rows):
    """Equalities (or lines) as PPL leaves them: forward elimination and back
    substitution (pivot: first nonzero column), the last row first."""
    M = [[x if isinstance(x, float) else _F(x) for x in r] for r in rows]
    piv, out = [], []
    for r in M:
        for c, pr in zip(piv, out):
            if not _iszero(r[c]):
                f = r[c] / pr[c]
                r = [x - f * y for x, y in zip(r, pr)]
        c = next((j for j, x in enumerate(r[:-1]) if not _iszero(x)), None)
        if c is None:
            continue
        out.append(r)
        piv.append(c)
    for i in range(len(out)):
        for j in range(len(out)):
            if i != j and not _iszero(out[j][piv[i]]):
                f = out[j][piv[i]] / out[i][piv[i]]
                out[j] = [x - f * y for x, y in zip(out[j], out[i])]
    res = [_lnorm(r) for r in out]
    if res:
        res = [res[-1]] + res[:-1]
    return res


def _reduce(r, L, last=True):
    """Reduce a row modulo the rows L (eliminating their last or first
    nonzero column)."""
    r = [x if isinstance(x, float) else _F(x) for x in r]
    for l in L:
        cols = [j for j, x in enumerate(l[:-1]) if not _iszero(x)]
        c = cols[-1] if last else cols[0]
        if not _iszero(r[c]):
            f = r[c] / l[c]
            r = [x - f * y for x, y in zip(r, l)]
    return r


def _gen_row(r):
    """A primitive generator row with nonnegative last coordinate."""
    r = _norm(r)
    if r[-1] < 0 or (r[-1] == 0 and False):
        r = tuple(-x for x in r)
    return r


def _v_to_h(points, rays, lines, dim):
    """(equations, inequalities, lines, generators) from a V-description, in
    Sage's order."""
    rows = [(_lnorm(tuple(l) + (0,)), "line") for l in lines if any(not _iszero(x) for x in l)]
    rows += [(_norm(tuple(r) + (0,)), "ray") for r in rays if any(not _iszero(x) for x in r)]
    for p in points:
        rows.append((_norm(tuple(p) + (1,)) if not any(isinstance(x, float) for x in p) else tuple(p) + (1.0,), "ray"))
    seen, srt = set(), []
    for rk in sorted(rows, key=lambda rk: (0 if rk[1] == "line" else 1, rk[0])):
        if rk[0] not in seen:
            seen.add(rk[0])
            srt.append(rk)
    src = [r for r, k in srt]
    kinds = [k for r, k in srt]
    dest, nl = _convert(src, dim + 1, kinds)
    eqs = _echelon(dest[:nl])
    ineqs = [r for r in dest[nl:] if any(not _iszero(x) for x in r[:-1])]
    # generators: lines in echelon form, points and rays reduced modulo them,
    # redundant ones removed (swapped with the last)
    L = _echelon([r for r, k in srt if k == "line"])
    gens = []
    for r, k in srt:
        if k == "line":
            continue
        g = _reduce(r, L, last=True)
        if all(_iszero(x) for x in g):
            continue
        g = _norm(g) if not any(isinstance(x, float) for x in g) else tuple(g)
        if not _iszero(g[-1]) and g[-1] < 0:
            g = tuple(-x for x in g)
        gens.append(g)
    cons = ineqs + eqs
    need = dim + 1 - len(L) - 1
    i, n = 0, len(gens)
    while i < n:
        g = gens[i]
        satd = [c for c in cons if _iszero(_dot(c, g))]
        red = (_rank(satd) if satd else 0) < need
        if not red and any(o == g for o in gens[:i]):
            red = True
        if red:
            gens[i], gens[n - 1] = gens[n - 1], gens[i]
            n -= 1
        else:
            i += 1
    return eqs, ineqs, L, gens[:n]


def _h_to_v(ieqs, eqns, dim):
    """(equations, inequalities, lines, generators) from an H-description,
    in Sage's order; generators is None for the empty polyhedron."""
    rows = [(_lnorm(tuple(e[1:]) + (e[0],)), "line") for e in eqns if any(not _iszero(x) for x in e[1:]) or not _iszero(e[0])]
    rows += [(_norm(tuple(h[1:]) + (h[0],)), "ray") for h in ieqs]
    rows.append((tuple([0] * dim + [1]), "ray"))
    seen, srt = set(), []
    for rk in sorted(rows, key=lambda rk: (0 if rk[1] == "line" else 1, rk[0])):
        if rk[0] not in seen:
            seen.add(rk[0])
            srt.append(rk)
    src = [r for r, k in srt]
    kinds = [k for r, k in srt]
    dest, nl = _convert(src, dim + 1, kinds)
    Lg = [_lnorm(r) for r in dest[:nl]]
    gens = []
    for r in dest[nl:]:
        if all(_iszero(x) for x in r):
            continue
        gens.append(r if _iszero(r[-1]) or r[-1] > 0 else tuple(-x for x in r))
    if not any(not _iszero(g[-1]) for g in gens):
        return None
    L = _echelon(Lg)
    E = _echelon([r for r, k in srt if k == "line"])
    grank = _rank(gens + Lg)
    if grank < dim + 1 - len(E):
        # implicit equalities: compute the H-representation from the generators
        pts = [tuple(_F(x) / g[-1] for x in g[:-1]) if not isinstance(g[-1], float) else tuple(x / g[-1] for x in g[:-1]) for g in gens if not _iszero(g[-1])]
        rys = [g[:-1] for g in gens if _iszero(g[-1])]
        E2, I2, _, _ = _v_to_h(pts, rys, [l[:-1] for l in Lg], dim)
        return E2, I2, L, gens
    ies = [r for r, k in srt if k != "line"]
    allg = gens + Lg + [tuple(-x for x in l) for l in Lg]
    i, n = 0, len(ies)
    while i < n:
        r = ies[i]
        satd = [g for g in allg if _iszero(_dot(r, g))]
        red = (_rank(satd) if satd else 0) < dim - len(E)
        if not red and any(o == r for o in ies[:i]):
            red = True
        if red:
            ies[i], ies[n - 1] = ies[n - 1], ies[i]
            n -= 1
        else:
            i += 1
    out = []
    for r in ies[:n]:
        rr = _reduce(r, E, last=True)
        rr = _norm(rr) if not any(isinstance(x, float) for x in rr) else tuple(rr)
        if any(not _iszero(x) for x in rr[:-1]):
            out.append(rr)
    return E, out, L, gens


# ----------------------------------------------------- representation objects

class _HRep:
    """An inequality A x + b >= 0 or an equation A x + b == 0."""

    def __init__(self, P, row, eq, index):
        self._P, self._row, self._eq, self._index = P, tuple(row), eq, index

    def _a(self):
        return self._row[:-1]

    def _b(self):
        return self._row[-1]

    def __repr__(self):
        r = self._P._ring
        a = "(" + ", ".join(_fmt(x, r) for x in self._a()) + ")"
        b = self._b()
        neg = (b < 0)
        bs = _fmt(abs(b) if not isinstance(b, float) else abs(b), r)
        if self._eq:
            return "An equation %s x %s %s == 0" % (a, "-" if neg else "+", bs)
        return "An inequality %s x %s %s >= 0" % (a, "-" if neg else "+", bs)

    def __eq__(self, other):
        return isinstance(other, _HRep) and (self._row, self._eq) == (other._row, other._eq)

    def __hash__(self):
        return hash((self._row, self._eq))

    def A(self):
        """The coefficient vector A of A x + b.

        EXAMPLES::

            sage: H = Polyhedron(vertices=[[0.5, 0], [0, 0.5]], base_ring=QQ).Hrepresentation(0); H, H.A(), H.b()
            (An equation (2, 2) x - 1 == 0, (2, 2), -1)
        """
        return _sa().vector(self._P._ringobj(), [_out(x, self._P._ring) for x in self._a()])

    def b(self):
        """The constant b of A x + b.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.Hrepresentation(2).b()
            1
        """
        return _out(self._b(), self._P._ring)

    def vector(self):
        """The vector (b, A).

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).Hrepresentation(2).vector()
            (1, -1, -1)
        """
        return _sa().vector(self._P._ringobj(), [_out(x, self._P._ring) for x in (self._b(),) + tuple(self._a())])

    def is_equation(self):
        """Whether this is an equation.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0], [0, 1]]).Hrepresentation(0).is_equation()
            True
        """
        return self._eq

    def is_inequality(self):
        """Whether this is an inequality.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.Hrepresentation(0).is_inequality()
            True
        """
        return not self._eq

    def type(self):
        """0 for an inequality, 1 for an equation.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]]); [h.type() for h in P.Hrepresentation()]
            [1, 0, 0]
        """
        return _sa().Integer(1 if self._eq else 0)

    def index(self):
        """The index in the H-representation.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.Hrepresentation(2).index()
            2
        """
        return _sa().Integer(self._index)

    def polyhedron(self):
        """The polyhedron.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.Hrepresentation(0).polyhedron()
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 3 vertices
        """
        return self._P

    def eval(self, v):
        """A x + b at a point.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).Hrepresentation(2).eval(vector([1, 1]))
            -1
        """
        if isinstance(v, _VRep):
            if v._kind == "vertex":
                v = v._v
            else:
                return _out(_dot(self._a(), v._v), self._P._ring)
        v = tuple(_q(x) for x in v)
        return _out(_dot(self._a(), v) + self._b(), self._P._ring)

    def contains(self, v):
        """Whether a point satisfies the inequality (or equation).

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); h = P.Hrepresentation(2); h.contains(vector([1, 1])), h.contains(vector([0, 0]))
            (False, True)
        """
        x = self.eval(v)
        return x == 0 if self._eq else x >= 0

    def interior_contains(self, v):
        """Whether a point satisfies the inequality strictly.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); h = P.Hrepresentation(2); h.interior_contains(vector([0, 0])), h.interior_contains(vector([1, 0]))
            (True, False)
        """
        x = self.eval(v)
        return False if self._eq else x > 0

    def is_incident(self, other):
        """Whether the H-representation object and a V-representation object
        are incident.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0.5, 0], [0, 0.5]], base_ring=QQ); H = P.Hrepresentation()
            sage: H[0].is_incident(H[1])
            True
        """
        if isinstance(other, _HRep):
            P = self._P
            return any(self.is_incident(v) and other.is_incident(v) for v in P.Vrepresentation())
        return _iszero(_dot(self._row, other._homog()))

    def incident(self):
        """The incident V-representation objects.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); list(P.Hrepresentation(2).incident())
            [A vertex at (0, 1), A vertex at (1, 0)]
        """
        return [v for v in self._P.Vrepresentation() if self.is_incident(v)]

    def __getitem__(self, i):
        return self.vector()[i]

    def __iter__(self):
        return iter(self.vector())

    def __len__(self):
        return len(self._row)


class _VRep:
    """A vertex, ray or line."""

    def __init__(self, P, v, kind, index):
        self._P, self._v, self._kind, self._index = P, tuple(v), kind, index

    def __repr__(self):
        r = self._P._ring
        t = "(" + ", ".join(_fmt(x, r) for x in self._v) + ")"
        if self._kind == "vertex":
            return "A vertex at " + t
        if self._kind == "ray":
            return "A ray in the direction " + t
        return "A line in the direction " + t

    def __eq__(self, other):
        return isinstance(other, _VRep) and (self._v, self._kind) == (other._v, other._kind)

    def __hash__(self):
        return hash((self._v, self._kind))

    def _homog(self):
        return tuple(self._v) + ((1,) if self._kind == "vertex" else (0,))

    def vector(self):
        """The coordinates.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]]).vertices()[0].vector()
            (0, 1/2, 0)
        """
        return _sa().vector(self._P._ringobj(), [_out(x, self._P._ring) for x in self._v])

    def __iter__(self):
        return iter([_out(x, self._P._ring) for x in self._v])

    def __getitem__(self, i):
        return _out(self._v[i], self._P._ring)

    def __len__(self):
        return len(self._v)

    def is_vertex(self):
        """Whether this is a vertex.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); [v.is_vertex() for v in P.Vrepresentation()]
            [False, True, True, False]
        """
        return self._kind == "vertex"

    def is_ray(self):
        """Whether this is a ray.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); [v.is_ray() for v in P.Vrepresentation()]
            [False, False, False, True]
        """
        return self._kind == "ray"

    def is_line(self):
        """Whether this is a line.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); [v.is_line() for v in P.Vrepresentation()]
            [True, False, False, False]
        """
        return self._kind == "line"

    def type(self):
        """2 for a line, 3 for a ray, 4 for a vertex.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); [v.type() for v in P.Vrepresentation()]
            [4, 2, 2, 3]
        """
        return _sa().Integer({"vertex": 2, "ray": 3, "line": 4}[self._kind])

    def index(self):
        """The index in the V-representation.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.vertices()[2].index()
            2
        """
        return _sa().Integer(self._index)

    def polyhedron(self):
        """The polyhedron.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.vertices()[0].polyhedron()
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 3 vertices
        """
        return self._P

    def is_incident(self, other):
        """Whether two V-representation objects are incident (lie on a common
        facet), or a V- and an H-representation object are.

        EXAMPLES::

            sage: P2 = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]])
            sage: L, V, R = P2.Vrepresentation(0), P2.Vrepresentation(1), P2.Vrepresentation(3)
            sage: L.is_incident(V), R.is_incident(L)
            (True, False)
        """
        if isinstance(other, _HRep):
            return other.is_incident(self)
        # as in Sage: the H-representation object with the other's index
        H = self._P.Hrepresentation()
        return other._index < len(H) and H[other._index].is_incident(self)

    def incident(self):
        """The incident H-representation objects.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); list(P.vertices()[0].incident())
            [An inequality (1, 0) x + 0 >= 0, An inequality (0, 1) x + 0 >= 0]
        """
        return [h for h in self._P.Hrepresentation() if h.is_incident(self)]

    def neighbors(self):
        """The adjacent vertices.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); list(P.vertices()[0].neighbors())
            [A vertex at (1, 1, -1), A vertex at (1, -1, 1), A vertex at (-1, -1, -1)]
        """
        P = self._P
        return [w for w in P.Vrepresentation() if w is not self and P._adjacent(self, w)]

    adjacent = neighbors


# ----------------------------------------------------------- the polyhedron

def _ring_name(vals):
    if any(isinstance(x, float) for x in vals):
        return "RDF"
    if all(_F(x).denominator == 1 for x in vals):
        return "ZZ"
    return "QQ"


class Polyhedra_:
    """The parent: Polyhedra in R^n.

    EXAMPLES::

        sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.parent()
        Polyhedra in ZZ^2
        sage: P.parent().ambient_dim(), P.parent().base_ring()
        (2, Integer Ring)
    """

    def __init__(self, ring, n):
        self._ring, self._n = ring, n

    def __repr__(self):
        return "Polyhedra in %s^%d" % (self._ring, self._n)

    def __eq__(self, other):
        return isinstance(other, Polyhedra_) and (self._ring, self._n) == (other._ring, other._n)

    def __hash__(self):
        return hash(("Polyhedra", self._ring, self._n))

    def ambient_dim(self):
        """The dimension of the ambient space.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.parent().ambient_dim()
            2
        """
        return _sa().Integer(self._n)

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]); P.parent().base_ring()
            Rational Field
        """
        return getattr(_sa(), self._ring)


class Polyhedron_:
    """A convex polyhedron.

    EXAMPLES::

        sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P
        A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 3 vertices
        sage: P.Vrepresentation(), P.Hrepresentation()
        ((A vertex at (0, 0), A vertex at (0, 1), A vertex at (1, 0)), (An inequality (1, 0) x + 0 >= 0, An inequality (0, 1) x + 0 >= 0, An inequality (-1, -1) x + 1 >= 0))
    """

    def __init__(self, ring, dim, eqs, ieqs, lines, gens):
        self._ring = ring
        self._n = dim
        self._empty = gens is None
        eqs = eqs or []
        ieqs = ieqs or []
        self._H = [_HRep(self, r, True, 0) for r in eqs] + [_HRep(self, r, False, 0) for r in ieqs]
        for k, h in enumerate(self._H):
            h._index = k
        V = []
        if gens is not None:
            for l in lines:
                V.append(_VRep(self, l[:-1], "line", 0))
            for g in gens:
                if _iszero(g[-1]):
                    V.append(_VRep(self, g[:-1], "ray", 0))
                else:
                    d = g[-1]
                    V.append(_VRep(self, [x / d if isinstance(x, float) or isinstance(d, float) else _F(x) / d for x in g[:-1]], "vertex", 0))
        for k, v in enumerate(V):
            v._index = k
        self._V = V
        if self._empty:
            self._H = []

    def _ringobj(self):
        return getattr(_sa(), self._ring)

    # -- printing and basic data
    def __repr__(self):
        if self._empty:
            return "The empty polyhedron in %s^%d" % (self._ring, self._n)
        nv, nr, nl = self.n_vertices(), self.n_rays(), self.n_lines()
        parts = []
        parts.append("%d vert%s" % (nv, "ex" if nv == 1 else "ices"))
        extra = []
        if nr:
            extra.append("%d ray%s" % (nr, "" if nr == 1 else "s"))
        if nl:
            extra.append("%d line%s" % (nl, "" if nl == 1 else "s"))
        s = parts[0]
        if extra:
            if len(extra) == 1:
                s += " and " + extra[0]
            else:
                s += ", " + ", ".join(extra)
        return "A %d-dimensional polyhedron in %s^%d defined as the convex hull of %s" % (self.dim(), self._ring, self._n, s)

    def _latex_(self):
        return repr(self)

    def parent(self):
        """The parent.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]).parent()
            Polyhedra in QQ^2
        """
        return Polyhedra_(self._ring, self._n)

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.base_ring(), Polyhedron(vertices=[[0.5]]).base_ring()  # sagebrush only
            (Integer Ring, Real Double Field)
        """
        return self._ringobj()

    def ambient_dim(self):
        """The dimension of the ambient space.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.ambient_dim()
            3
        """
        return _sa().Integer(self._n)

    ambient_dimension = ambient_dim

    def dim(self):
        """The dimension.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0], [0, 1]]).dim()
            1
        """
        if self._empty:
            return _sa().Integer(-1)
        return _sa().Integer(self._n - len(self.equations()))

    dimension = dim

    def __eq__(self, other):
        if not isinstance(other, Polyhedron_):
            return False
        if self._empty or other._empty:
            return self._empty == other._empty and self._n == other._n
        return self._n == other._n and self._canon() == other._canon()

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash((self._n, len(self._V)))

    def _canon(self):
        def key(v):
            return (v._kind, tuple(round(x, 9) if isinstance(x, float) else x for x in (v._v if v._kind == "vertex" else _lnorm_any(v._v))))
        return sorted(key(v) for v in self._V if v._kind != "line"), _rank([v._v for v in self._V if v._kind == "line"])

    # -- representations
    def Hrepresentation(self, i=None):
        """The H-representation: equations, then inequalities.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]])
            sage: for h in P.Hrepresentation(): print(h)
            An inequality (1, 1) x - 1 >= 0
            An inequality (1, -1) x + 1 >= 0
            An inequality (-1, 1) x + 1 >= 0
        """
        return self._H[i] if i is not None else tuple(self._H)

    def Vrepresentation(self, i=None):
        """The V-representation: lines, then vertices and rays.

        EXAMPLES::

            sage: P1 = Polyhedron(vertices = [[-5,2], [4,4], [3,0], [1,0], [2,-4], [-3,-1], [-5,-3]])
            sage: P1.Vrepresentation()
            (A vertex at (-5, -3), A vertex at (-5, 2), A vertex at (4, 4), A vertex at (2, -4))
        """
        return self._V[i] if i is not None else tuple(self._V)

    def Hrep_generator(self):
        """An iterator over the H-representation.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); list(P.Hrep_generator())
            [An inequality (1, 0) x + 0 >= 0, An inequality (0, 1) x + 0 >= 0, An inequality (-1, -1) x + 1 >= 0]
        """
        return iter(self._H)

    def Vrep_generator(self):
        """An iterator over the V-representation.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]); list(P.Vrep_generator())
            [A vertex at (0, 1), A vertex at (1, 0), A ray in the direction (1, 1)]
        """
        return iter(self._V)

    def n_Hrepresentation(self):
        """The number of H-representation objects.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.n_Hrepresentation()
            3
        """
        return _sa().Integer(len(self._H))

    def n_Vrepresentation(self):
        """The number of V-representation objects.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.n_Vrepresentation()
            4
        """
        return _sa().Integer(len(self._V))

    def equations(self):
        """The equations.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1/2, 0], [0, 1/2]]).equations()
            (An equation (2, 2) x - 1 == 0,)
        """
        return tuple(h for h in self._H if h._eq)

    def inequalities(self):
        """The inequalities.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.inequalities()
            (An inequality (1, 0) x + 0 >= 0, An inequality (0, 1) x + 0 >= 0, An inequality (-1, -1) x + 1 >= 0)
        """
        return tuple(h for h in self._H if not h._eq)

    def equations_list(self):
        """The equations as lists [b, a_1, ...].

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0], [0, 1]]).equations_list()
            [[-1, 1, 1]]
        """
        return [list(h.vector()) for h in self.equations()]

    def inequalities_list(self):
        """The inequalities as lists [b, a_1, ...].

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.inequalities_list()
            [[0, 1, 0], [0, 0, 1], [1, -1, -1]]
        """
        return [list(h.vector()) for h in self.inequalities()]

    def vertices(self):
        """The vertices.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]).vertices()
            (A vertex at (0, 1/2, 0), A vertex at (1/2, 0, 0))
        """
        return tuple(v for v in self._V if v._kind == "vertex")

    def rays(self):
        """The rays.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.rays()
            (A ray in the direction (1, 1, 0),)
        """
        return tuple(v for v in self._V if v._kind == "ray")

    def lines(self):
        """The lines.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.lines()
            (A line in the direction (0, 0, 1),)
        """
        return tuple(v for v in self._V if v._kind == "line")

    def vertices_list(self):
        """The vertices, as lists.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.vertices_list()
            [[0, 0], [0, 1], [1, 0]]
        """
        return [list(v) for v in self.vertices()]

    def rays_list(self):
        """The rays, as lists.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.rays_list()
            [[1, 1, 0]]
        """
        return [list(v) for v in self.rays()]

    def lines_list(self):
        """The lines, as lists.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.lines_list()
            [[0, 0, 1]]
        """
        return [list(v) for v in self.lines()]

    def vertex_generator(self):
        """An iterator over the vertices.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); list(P.vertex_generator())
            [A vertex at (0, 0), A vertex at (0, 1), A vertex at (1, 0)]
        """
        return iter(self.vertices())

    def vertices_matrix(self, base_ring=None):
        """The vertices as the columns of a matrix.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]]).vertices_matrix()
            [  0 1/2]
            [1/2   0]
            [  0   0]
        """
        vs = self.vertices()
        R = self._ringobj() if self._ring != "ZZ" else _sa().ZZ
        return _sa().matrix(R, [[v[i] for v in vs] for i in range(self._n)])

    def n_vertices(self):
        """The number of vertices.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); P.n_vertices()
            8
        """
        return _sa().Integer(len(self.vertices()))

    def n_rays(self):
        """The number of rays.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.n_rays()
            1
        """
        return _sa().Integer(len(self.rays()))

    def n_lines(self):
        """The number of lines.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.n_lines()
            1
        """
        return _sa().Integer(len(self.lines()))

    def n_equations(self):
        """The number of equations.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0, 0], [0, 1, 0]]).n_equations()
            2
        """
        return _sa().Integer(len(self.equations()))

    def n_inequalities(self):
        """The number of inequalities (facets).

        EXAMPLES::

            sage: P = polytopes.hypercube(3); P.n_inequalities()
            6
        """
        return _sa().Integer(len(self.inequalities()))

    n_facets = n_inequalities

    def is_empty(self):
        """Whether the polyhedron is empty.

        EXAMPLES::

            sage: Polyhedron(ieqs=[[-1, 1], [-1, -1]]).is_empty(), Polyhedron(vertices=[[0]]).is_empty()
            (True, False)
        """
        return self._empty

    def is_universe(self):
        """Whether the polyhedron is the whole space.

        EXAMPLES::

            sage: Polyhedron(lines=[[1, 0], [0, 1]]).is_universe()
            True
        """
        return not self._empty and not self._H

    def is_compact(self):
        """Whether the polyhedron is bounded.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]).is_compact()
            False
        """
        return not self.rays() and not self.lines()

    is_bounded = is_compact

    def is_full_dimensional(self):
        """Whether the dimension equals the ambient dimension.

        EXAMPLES::

            sage: Polyhedron(vertices=[[1, 0], [0, 1]]).is_full_dimensional()
            False
        """
        return self.dim() == self._n

    def is_simplex(self):
        """Whether the polytope is a simplex.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.is_simplex(), polytopes.hypercube(2).is_simplex()
            (True, False)
        """
        return self.is_compact() and self.n_vertices() == self.dim() + 1

    def is_lattice_polytope(self):
        """Whether the polytope has integral vertices.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.is_lattice_polytope(), (P/2).is_lattice_polytope()
            (True, False)
        """
        return self.is_compact() and all(_F(x).denominator == 1 for v in self.vertices() for x in v._v) if self._ring != "RDF" else False

    # -- containment
    def contains(self, point):
        """Whether the point lies in the polyhedron.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.contains([1/3, 1/3]), P.contains([1, 1])
            (True, False)
        """
        if self._empty:
            return False
        p = tuple(_q(x) for x in point)
        if len(p) != self._n:
            return False
        return all(h.contains(p) for h in self._H)

    __contains__ = contains

    def interior_contains(self, point):
        """Whether the point is in the (topological) interior.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [2, 0], [0, 2]]).interior_contains([1/2, 1/2])
            True
        """
        p = tuple(_q(x) for x in point)
        if self.equations():
            return False
        return all(h.interior_contains(p) for h in self.inequalities())

    def relative_interior_contains(self, point):
        """Whether the point lies in the relative interior.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]]); P.relative_interior_contains([1/2, 1/2]), P.relative_interior_contains([1, 0])
            (True, False)
        """
        p = tuple(_q(x) for x in point)
        return all(h.contains(p) for h in self.equations()) and all(h.interior_contains(p) for h in self.inequalities())

    # -- derived data
    def center(self):
        """The average of the vertices.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).center()
            (1/3, 1/3)
        """
        vs = self.vertices()
        R = _sa().QQ if self._ring != "RDF" else _sa().RDF
        return _sa().vector(R, [_out(sum((v._v[i] for v in vs), 0) / len(vs) if self._ring == "RDF" else sum((_F(v._v[i]) for v in vs), _F(0)) / len(vs), self._ring if self._ring == "RDF" else "QQ") for i in range(self._n)])

    def representative_point(self):
        """A point in the relative interior.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]); P.representative_point()
            (3/2, 3/2)
        """
        c = list(self.center())
        for r in self.rays():
            c = [a + b for a, b in zip(c, r)]
        return _sa().vector(_sa().QQ if self._ring != "RDF" else _sa().RDF, c)

    def bounding_box(self, integral=False):
        """The coordinatewise minima and maxima of the vertices.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).bounding_box()
            ((0, 0), (1, 1))
        """
        vs = [v._v for v in self.vertices()]
        lo = tuple(_out(min(v[i] for v in vs), self._ring) for i in range(self._n))
        hi = tuple(_out(max(v[i] for v in vs), self._ring) for i in range(self._n))
        if integral:
            import math
            lo = tuple(_sa().Integer(math.floor(x)) for x in lo)
            hi = tuple(_sa().Integer(math.ceil(x)) for x in hi)
        return lo, hi

    def integral_points(self):
        """The lattice points (of a polytope), sorted.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [2, 0], [0, 2]]).integral_points()
            ((0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (2, 0))
        """
        if not self.is_compact():
            raise ValueError("can only enumerate points in a compact polyhedron")
        if self._empty:
            return ()
        import math
        vs = [v._v for v in self.vertices()]
        rngs = [range(math.ceil(min(v[i] for v in vs)), math.floor(max(v[i] for v in vs)) + 1) for i in range(self._n)]
        pts = [p for p in itertools.product(*rngs) if self.contains(p)]
        return tuple(_sa().vector(_sa().ZZ, list(p)) for p in sorted(pts))

    def integral_points_count(self):
        """The number of lattice points.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); P.integral_points_count()
            27
        """
        return _sa().Integer(len(self.integral_points()))

    def volume(self, measure="ambient", engine="auto"):
        """The volume (zero for lower dimensional polytopes).

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).volume()
            1/2
            sage: polytopes.hypercube(3).volume()
            8
        """
        if measure != "ambient" and not (measure == "induced" and self.dim() == self._n):
            raise NotImplementedError("volume: only measure='ambient' (or 'induced' for full-dimensional polyhedra) is implemented")
        if not self.is_compact():
            return _sa().oo
        if self.dim() < self._n:
            return _sa().Integer(0)
        tot = 0
        verts = [v._v for v in self.vertices()]
        for S in self._triangulation():
            pts = [verts[i] for i in S]
            M = [[x - y for x, y in zip(p, pts[0])] for p in pts[1:]]
            tot += abs(_det(M))
        import math
        r = tot / math.factorial(self._n) if isinstance(tot, float) else _F(tot) / math.factorial(self._n)
        return _out(r, self._ring if self._ring == "RDF" else "QQ")

    def _incidence(self):
        """For each vertex (and ray/line), the set of incident inequalities."""
        if getattr(self, "_inc", None) is None:
            self._inc = [frozenset(j for j, h in enumerate(self.inequalities()) if h.is_incident(v)) for v in self._V]
        return self._inc

    def _triangulation(self):
        """Simplices (tuples of vertex indices) triangulating the polytope."""
        verts = [i for i, v in enumerate(self._V) if v._kind == "vertex"]
        vpos = {i: k for k, i in enumerate(verts)}
        inc = self._incidence()
        nH = len(self.inequalities())

        def faces_below(face, d):
            # facets of a face (set of vertex indices) of dimension d
            out = []
            for j in range(nH):
                sub = frozenset(i for i in face if j in inc[i])
                if sub and sub != face and _affine_rank([self._V[i]._v for i in sub]) == d - 1:
                    if sub not in out:
                        out.append(sub)
            return out

        def tri(face, d):
            face = frozenset(face)
            if d == 0:
                return [(min(face),)]
            v = min(face)
            res = []
            for G in faces_below(face, d):
                if v in G:
                    continue
                for S in tri(G, d - 1):
                    res.append((v,) + S)
            return res
        return [tuple(vpos[i] for i in S) for S in tri(frozenset(verts), self.dim())]

    def f_vector(self):
        """The f-vector (numbers of faces of each dimension, from -1).

        EXAMPLES::

            sage: polytopes.hypercube(3).f_vector()
            (1, 8, 12, 6, 1)
        """
        if self._empty:
            return _sa().vector(_sa().ZZ, [1])
        d = int(self.dim())
        cnt = [0] * (d + 2)
        cnt[0] = 1
        cnt[-1] = 1
        for f in self._faces():
            cnt[f[1] + 1] += 1
        return _sa().vector(_sa().ZZ, cnt)

    def _faces(self):
        """All proper nonempty faces as (V-index set, dimension), in Sage's
        face iterator order (by codimension, depth first)."""
        if getattr(self, "_face_cache", None) is not None:
            return self._face_cache
        inc = self._incidence()
        nH = len(self.inequalities())
        nV = len(self._V)
        lines = frozenset(i for i, v in enumerate(self._V) if v._kind == "line")
        coatoms = [frozenset(i for i in range(nV) if j in inc[i]) | lines for j in range(nH)]
        d = int(self.dim())
        out = []

        def it(faces, dim, visited):
            visited = list(visited)
            for idx in range(len(faces) - 1, -1, -1):
                F = faces[idx]
                out.append((F, dim))
                if dim > 0 and not (F <= lines):
                    cands = []
                    for G in faces[:idx]:
                        I = F & G
                        if I and not (I <= lines):
                            cands.append(I)
                    maxi = []
                    for I in cands:
                        if any(I < J for J in cands):
                            continue
                        if I in maxi:
                            continue
                        if any(I <= V for V in visited):
                            continue
                        maxi.append(I)
                    if maxi:
                        it(maxi, dim - 1, [F & V for V in visited])
                visited.append(F)
        if d >= 1 and coatoms:
            it(coatoms, d - 1, [])
        self._face_cache = out
        return out

    def faces(self, face_dimension):
        """The faces of the given dimension (in Sage's order).

        EXAMPLES::

            sage: P = polytopes.hypercube(3)
            sage: [f.ambient_V_indices() for f in P.faces(2)]
            [(0, 3, 4, 5), (0, 1, 5, 6), (4, 5, 6, 7), (2, 3, 4, 7), (1, 2, 6, 7), (0, 1, 2, 3)]
        """
        k = int(face_dimension)
        d = int(self.dim())
        if k == -1:
            return (PolyhedronFace(self, frozenset(), -1),)
        if k == d:
            return (PolyhedronFace(self, frozenset(range(len(self._V))), d),)
        if k < -1 or k > d:
            return ()
        return tuple(PolyhedronFace(self, F, dd) for F, dd in self._faces() if dd == k)

    def facets(self):
        """The facets (in Sage's order).

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); [f.ambient_V_indices() for f in P.facets()]
            [(1, 2), (0, 2), (0, 1)]
        """
        return self.faces(int(self.dim()) - 1)

    def _adjacent(self, v, w):
        i, j = v._index, w._index
        return any(F == frozenset((i, j)) for F, dd in self._faces() if dd == 1)

    def vertex_adjacency_matrix(self):
        """The adjacency matrix of the vertices.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.vertex_adjacency_matrix()
            [0 1 1]
            [1 0 1]
            [1 1 0]
        """
        n = len(self._V)
        return _sa().matrix(_sa().ZZ, [[int(i != j and self._adjacent(self._V[i], self._V[j])) for j in range(n)] for i in range(n)])

    def graph(self):
        """The graph of vertices and edges.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); P.graph()
            Graph on 8 vertices
        """
        G = _sa().Graph()
        for v in self.vertices():
            G.add_vertex(v)
        for F, dd in self._faces():
            if dd == 1 and len(F) == 2:
                a, b = sorted(F)
                G.add_edge(self._V[a], self._V[b])
        return G

    vertex_graph = graph

    # -- constructions
    def polar(self, in_affine_span=False):
        """The polar: {w : <w, v> + 1 >= 0 for all v in P} for a full
        dimensional polytope containing the origin in its interior.

        EXAMPLES::

            sage: P1 = Polyhedron(vertices = [[-5,2], [4,4], [3,0], [1,0], [2,-4], [-3,-1], [-5,-3]])
            sage: P1.polar()
            A 2-dimensional polyhedron in QQ^2 defined as the convex hull of 4 vertices
        """
        if not self.is_compact() or self.dim() < self._n:
            raise ValueError("not a compact full-dimensional polyhedron")
        if not self.interior_contains([0] * self._n):
            raise ValueError("The polytope must have the IP property.")
        verts = [[x / h._b() if isinstance(x, float) else _F(x) / h._b() for x in h._a()] for h in self.inequalities()]
        return Polyhedron(vertices=verts, base_ring=_sa().QQ if self._ring != "RDF" else _sa().RDF)

    def minkowski_sum(self, other):
        """The Minkowski sum.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0]]); Q = Polyhedron(vertices=[[0, 0], [0, 1]])
            sage: P + Q
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 4 vertices
        """
        if not isinstance(other, Polyhedron_):
            return self.translation(other)
        vs = [[a + b for a, b in zip(u._v, v._v)] for u in self.vertices() for v in other.vertices()]
        rays = [r._v for r in self.rays()] + [r._v for r in other.rays()]
        lines = [r._v for r in self.lines()] + [r._v for r in other.lines()]
        return _make_V(vs, rays, lines, self._n, _join(self._ring, other._ring))

    __add__ = minkowski_sum

    def translation(self, displacement):
        """The translate by a vector.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0]]).translation([2, 1]).vertices()
            (A vertex at (2, 1), A vertex at (3, 1))
        """
        t = [_q(x) for x in displacement]
        vs = [[a + b for a, b in zip(v._v, t)] for v in self.vertices()]
        return _make_V(vs, [r._v for r in self.rays()], [l._v for l in self.lines()], self._n, _join(self._ring, _ring_name(t)))

    def __sub__(self, other):
        if isinstance(other, Polyhedron_):
            raise NotImplementedError("Minkowski differences are not available in sagebrush yet")
        return self.translation([-_q(x) for x in other])

    def __neg__(self):
        return self * (-1)

    def dilation(self, c):
        """The image under x -> c x.

        EXAMPLES::

            sage: (2 * Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]])).vertices()
            (A vertex at (0, 0), A vertex at (0, 2), A vertex at (2, 0))
        """
        c = _q(c)
        if c == 0:
            # every point (lines and rays too) goes to the origin
            return _make_V([[0] * self._n] if not self.is_empty() else [], [], [], self._n, self._ring)
        vs = [[c * x for x in v._v] for v in self.vertices()]
        rs = [[c * x for x in r._v] for r in self.rays()]
        ring = _join(self._ring, _ring_name([c]))
        return _make_V(vs, rs, [l._v for l in self.lines()], self._n, ring)

    def __mul__(self, other):
        if isinstance(other, Polyhedron_):
            return self.product(other)
        return self.dilation(other)

    def __rmul__(self, other):
        return self.dilation(other)

    def __truediv__(self, c):
        c = _q(c)
        return self.dilation(1 / c if not isinstance(c, float) else 1.0 / c)

    def product(self, other):
        """The Cartesian product.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0], [1]]); P.product(P)
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 4 vertices
        """
        n, m = self._n, other._n
        vs = [list(u._v) + list(v._v) for u in self.vertices() for v in other.vertices()]
        rs = [list(r._v) + [0] * m for r in self.rays()] + [[0] * n + list(r._v) for r in other.rays()]
        ls = [list(r._v) + [0] * m for r in self.lines()] + [[0] * n + list(r._v) for r in other.lines()]
        return _make_V(vs, rs, ls, n + m, _join(self._ring, other._ring))

    cartesian_product = product

    def intersection(self, other):
        """The intersection.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [2, 0], [0, 2]]); Q = Polyhedron(vertices=[[1, 1], [-1, 1], [1, -1]])
            sage: P & Q
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 4 vertices
        """
        ie = [h.vector() for h in self.inequalities()] + [h.vector() for h in other.inequalities()]
        eq = [h.vector() for h in self.equations()] + [h.vector() for h in other.equations()]
        ring = "RDF" if "RDF" in (self._ring, other._ring) else "QQ"
        P = _make_H([[_q(x) for x in r] for r in ie], [[_q(x) for x in r] for r in eq], self._n, ring)
        if self._ring == other._ring == "ZZ" and all(_F(x).denominator == 1 for v in P._V for x in v._v):
            P._ring = "ZZ"
        return P

    __and__ = intersection

    def convex_hull(self, other):
        """The convex hull of the union.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); Q = Polyhedron(vertices=[[1, 1]]); P.convex_hull(Q)
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 4 vertices
        """
        vs = [v._v for v in self.vertices()] + [v._v for v in other.vertices()]
        rs = [v._v for v in self.rays()] + [v._v for v in other.rays()]
        ls = [v._v for v in self.lines()] + [v._v for v in other.lines()]
        return _make_V(vs, rs, ls, self._n, _join(self._ring, other._ring))

    def prism(self):
        """The prism P x [0, 1].

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).prism()
            A 3-dimensional polyhedron in ZZ^3 defined as the convex hull of 6 vertices
        """
        vs = [list(v._v) + [0] for v in self.vertices()] + [list(v._v) + [1] for v in self.vertices()]
        return _make_V(vs, [list(r._v) + [0] for r in self.rays()], [list(r._v) + [0] for r in self.lines()], self._n + 1, self._ring)

    def pyramid(self):
        """The pyramid over the polytope (apex at the first new unit vector).

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).pyramid()
            A 3-dimensional polyhedron in QQ^3 defined as the convex hull of 4 vertices
        """
        c = list(self.center())
        vs = [[1] + [_q(x) for x in c]] + [[0] + list(v._v) for v in self.vertices()]
        return _make_V(vs, [], [], self._n + 1, "QQ" if self._ring != "RDF" else "RDF")

    def bipyramid(self):
        """The bipyramid over the polytope.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).bipyramid()
            A 3-dimensional polyhedron in QQ^3 defined as the convex hull of 5 vertices
        """
        c = [_q(x) for x in self.center()]
        vs = [[1] + c, [-1] + c] + [[0] + list(v._v) for v in self.vertices()]
        return _make_V(vs, [], [], self._n + 1, "QQ" if self._ring != "RDF" else "RDF")

    def integral_hull(self):
        """The convex hull of the lattice points (for polytopes) or of the
        lattice points and the rays.

        EXAMPLES::

            sage: P6 = Polyhedron(vertices=[[0, 0], [3/2, 0], [3/2, 3/2], [0, 3]]); P6.integral_hull()  # sagebrush only
            A 2-dimensional polyhedron in QQ^2 defined as the convex hull of 4 vertices
        """
        if not self.is_compact():
            # vertices rounded into the polyhedron along the rays
            import math
            pts = []
            for v in self.vertices():
                p = [math.ceil(x) for x in v._v]
                pts.append(p)
            return _make_V(pts, [r._v for r in self.rays()], [l._v for l in self.lines()], self._n, "QQ")
        pts = [list(p) for p in self.integral_points()]
        return _make_V([[_q(x) for x in p] for p in pts], [], [], self._n, "QQ")

    def schlegel_projection(self, facet=None, position=None):
        """The Schlegel projection (for plotting).

        EXAMPLES::

            sage: polytopes.hypercube(4).schlegel_projection(position=1/2)  # sagebrush only
            The projection of a polyhedron into 3 dimensions
        """
        return _SchlegelProjection(self)

    # -- cdd output
    def cdd_Vrepresentation(self):
        """The V-representation in cdd's format.

        EXAMPLES::

            sage: print(Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]).cdd_Vrepresentation())
            V-representation
            begin
             3 3 rational
             0 1 1
             1 0 1
             1 1 0
            end
        """
        kind = "real" if self._ring == "RDF" else "rational"
        lines = [v for v in self._V if v._kind == "line"]
        rays = [v for v in self._V if v._kind == "ray"]
        verts = [v for v in self._V if v._kind == "vertex"]
        rows = [(0, v._v) for v in lines] + [(0, v._v) for v in rays] + [(1, v._v) for v in verts]
        s = "V-representation\n"
        if lines:
            s += "linearity %d %s\n" % (len(lines), " ".join(str(i + 1) for i in range(len(lines))))
        s += "begin\n %d %d %s\n" % (len(rows), self._n + 1, kind)
        for t, v in rows:
            s += " " + " ".join([str(t)] + [_fmt(x, self._ring) for x in v]) + "\n"
        return s + "end"

    def cdd_Hrepresentation(self):
        """The H-representation in cdd's format.

        EXAMPLES::

            sage: print(Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).cdd_Hrepresentation())
            H-representation
            begin
             3 3 rational
             0 1 0
             0 0 1
             1 -1 -1
            end
        """
        kind = "real" if self._ring == "RDF" else "rational"
        eqs = list(self.equations())
        ies = list(self.inequalities())
        s = "H-representation\n"
        if eqs:
            s += "linearity %d %s\n" % (len(eqs), " ".join(str(i + 1) for i in range(len(eqs))))
        s += "begin\n %d %d %s\n" % (len(eqs) + len(ies), self._n + 1, kind)
        for h in eqs + ies:
            s += " " + " ".join(_fmt(x, self._ring) for x in (h._b(),) + tuple(h._a())) + "\n"
        return s + "end"

    # -- plots
    def plot(self, **options):
        """A picture (2d: the polygon, its edges and vertices; 3d: a 3d
        graphics object).

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).plot()
            Graphics object consisting of 5 graphics primitives
        """
        sa = _sa()
        if self._n >= 3:
            return _Graphics3dStub()
        g = sa.Graphics()
        if self._empty:
            return g
        pts = [tuple(float(x) for x in v._v) for v in self.vertices()]
        if self._n == 1:
            pts = [(p[0], 0.0) for p in pts]
        edges = [F for F, dd in self._faces() if dd == 1] if self.dim() >= 1 else []
        if self.dim() == 2:
            order = _polygon_order(self)
            g += sa.polygon([tuple(float(x) for x in self._V[i]._v) for i in order], alpha=0.5, color="green")
        for F in edges:
            idx = sorted(F)
            seg = []
            for i in idx:
                v = self._V[i]
                if v._kind == "vertex":
                    seg.append(tuple(float(x) for x in v._v))
            if len(idx) == 2 and len(seg) == 1:
                r = [v for v in (self._V[i] for i in idx) if v._kind != "vertex"][0]
                seg.append(tuple(a + float(b) for a, b in zip(seg[0], r._v)))
            if len(seg) == 2:
                g += sa.line(seg, color="blue")
        if self.dim() == 1 and not edges:
            g += sa.line(pts, color="blue")
        g += sa.points(pts, color="black", size=20)
        return g

    def show(self, **options):
        """Show the plot (nothing here).

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.show()  # sagebrush only
        """
        return None



class _Graphics3dStub:
    def __repr__(self):
        return "Graphics3d Object"

    def __add__(self, other):
        return self

    __radd__ = __add__

    def show(self, *a, **k):
        """Show (nothing here).

        EXAMPLES::

            sage: polytopes.hypercube(3).plot().show()  # sagebrush only
        """
        return None


class _SchlegelProjection:
    def __init__(self, P):
        self._P = P

    def plot(self, **kwds):
        """A plot (3d graphics).

        EXAMPLES::

            sage: polytopes.hypercube(4).schlegel_projection(position=1/2).plot()  # sagebrush only
            Graphics3d Object
        """
        return _Graphics3dStub()

    def show(self, **kwds):
        """Show (nothing here).

        EXAMPLES::

            sage: polytopes.hypercube(4).schlegel_projection().show()  # sagebrush only
        """
        return None

    def __repr__(self):
        return "The projection of a polyhedron into %d dimensions" % (self._P._n - 1)


def _polygon_order(P):
    """The vertices (and ray ends) of a 2d polyhedron in cyclic order."""
    import math
    vs = [i for i, v in enumerate(P._V) if v._kind == "vertex"]
    c = [sum(float(P._V[i]._v[k]) for i in vs) / len(vs) for k in range(2)]
    return sorted(vs, key=lambda i: math.atan2(float(P._V[i]._v[1]) - c[1], float(P._V[i]._v[0]) - c[0]))


class PolyhedronFace:
    """A face of a polyhedron.

    EXAMPLES::

        sage: P = polytopes.hypercube(3); F = P.faces(2)[0]; F
        A 2-dimensional face of a Polyhedron in ZZ^3 defined as the convex hull of 4 vertices
        sage: F.ambient_V_indices(), F.ambient_H_indices()
        ((0, 3, 4, 5), (5,))
    """

    def __init__(self, P, Vset, dim):
        self._P, self._F, self._dim = P, frozenset(Vset), dim

    def __repr__(self):
        nv = len([i for i in self._F if self._P._V[i]._kind == "vertex"])
        nr = len([i for i in self._F if self._P._V[i]._kind == "ray"])
        nl = len([i for i in self._F if self._P._V[i]._kind == "line"])
        s = "%d vert%s" % (nv, "ex" if nv == 1 else "ices")
        extra = []
        if nr:
            extra.append("%d ray%s" % (nr, "" if nr == 1 else "s"))
        if nl:
            extra.append("%d line%s" % (nl, "" if nl == 1 else "s"))
        if extra:
            s += (" and " + extra[0]) if len(extra) == 1 else (", " + ", ".join(extra))
        return "A %d-dimensional face of a Polyhedron in %s^%d defined as the convex hull of %s" % (self._dim, self._P._ring, self._P._n, s)

    def dim(self):
        """The dimension.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); [f.dim() for f in P.faces(1)][:3]
            [1, 1, 1]
        """
        return _sa().Integer(self._dim)

    def ambient_V_indices(self):
        """The indices of the V-representation objects in the face.

        EXAMPLES::

            sage: [f.ambient_V_indices() for f in Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).faces(1)]
            [(1, 2), (0, 2), (0, 1)]
        """
        return tuple(sorted(self._F))

    def ambient_H_indices(self):
        """The indices of the H-representation objects containing the face.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); [f.ambient_H_indices() for f in P.faces(1)][:4]
            [(4, 5), (3, 5), (2, 5), (0, 5)]
        """
        P = self._P
        if self._dim == -1:
            return tuple(range(len(P._H)))
        inc = P._incidence()
        neq = len(P.equations())
        idx = [k for k in range(len(P.inequalities())) if all(k in inc[i] for i in self._F)]
        return tuple(list(range(neq)) + [neq + k for k in idx])

    def ambient_Vrepresentation(self):
        """The V-representation objects of the face.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.faces(1)[0].ambient_Vrepresentation()
            (A vertex at (0, 1), A vertex at (1, 0))
        """
        return tuple(self._P._V[i] for i in self.ambient_V_indices())

    def ambient_Hrepresentation(self):
        """The H-representation objects containing the face.

        EXAMPLES::

            sage: Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]).faces(1)[0].ambient_Hrepresentation()
            (An inequality (-1, -1) x + 1 >= 0,)
        """
        return tuple(self._P._H[i] for i in self.ambient_H_indices())

    def vertices(self):
        """The vertices of the face.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.faces(1)[0].vertices()
            (A vertex at (0, 1), A vertex at (1, 0))
        """
        return tuple(v for v in self.ambient_Vrepresentation() if v._kind == "vertex")

    def rays(self):
        """The rays of the face.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1, 0], [0, 1]], rays=[[1, 1]]); [f.rays() for f in P.faces(1)]
            [(A ray in the direction (1, 1),), (A ray in the direction (1, 1),), ()]
        """
        return tuple(v for v in self.ambient_Vrepresentation() if v._kind == "ray")

    def lines(self):
        """The lines of the face.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[1/2, 0, 0], [0, 1/2, 0]], rays=[[1, 1, 0]], lines=[[0, 0, 1]]); P.faces(2)[0].lines()
            (A line in the direction (0, 0, 1),)
        """
        return tuple(v for v in self.ambient_Vrepresentation() if v._kind == "line")

    def n_vertices(self):
        """The number of vertices.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); P.faces(2)[0].n_vertices()
            4
        """
        return len(self.vertices())

    def polyhedron(self):
        """The polyhedron.

        EXAMPLES::

            sage: P = Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]); P.faces(1)[0].polyhedron()
            A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 3 vertices
        """
        return self._P

    def as_polyhedron(self):
        """The face as a polyhedron.

        EXAMPLES::

            sage: P = polytopes.hypercube(3); P.faces(2)[0].as_polyhedron()
            A 2-dimensional polyhedron in ZZ^3 defined as the convex hull of 4 vertices
        """
        vs = [v._v for v in self.vertices()]
        return _make_V(vs, [r._v for r in self.rays()], [l._v for l in self.lines()], self._P._n, self._P._ring)

    def __eq__(self, other):
        return isinstance(other, PolyhedronFace) and self._P is other._P and self._F == other._F

    def __hash__(self):
        return hash(self._F)


def _affine_rank(pts):
    if not pts:
        return -1
    return _rank([[x - y for x, y in zip(p, pts[0])] for p in pts[1:]]) if len(pts) > 1 else 0


def _det(M):
    n = len(M)
    A = [[x if isinstance(x, float) else _F(x) for x in r] for r in M]
    d = 1
    for c in range(n):
        p = next((i for i in range(c, n) if not _iszero(A[i][c])), None)
        if p is None:
            return 0
        if p != c:
            A[c], A[p] = A[p], A[c]
            d = -d
        d *= A[c][c]
        for i in range(c + 1, n):
            f = A[i][c] / A[c][c]
            A[i] = [x - f * y for x, y in zip(A[i], A[c])]
    return d


def _lnorm_any(v):
    if any(isinstance(x, float) for x in v):
        m = max(abs(x) for x in v)
        return tuple(round(x / m, 9) for x in v)
    return _lnorm(v) if False else _norm(v)


def _join(a, b):
    order = ["ZZ", "QQ", "RDF"]
    return order[max(order.index(a), order.index(b))]


def _exact(x):
    return _F(x) if isinstance(x, float) else x


def _make_V(vertices, rays, lines, n, ring):
    pts = [[_q(x) for x in v] for v in vertices]
    rs = [[_q(x) for x in r] for r in rays]
    ls = [[_q(x) for x in r] for r in lines]
    if ring != "RDF":
        pts = [[_exact(x) for x in v] for v in pts]
        rs = [[_exact(x) for x in v] for v in rs]
        ls = [[_exact(x) for x in v] for v in ls]
    if ring == "RDF":
        pts = [[float(x) for x in v] for v in pts]
        rs = [[float(x) for x in v] for v in rs]
        ls = [[float(x) for x in v] for v in ls]
    if not pts:
        if rs or ls:
            pts = [[0] * n]
        else:
            return Polyhedron_(ring, n, [], [], [], None)
    eqs, ieqs, L, gens = _v_to_h(pts, rs, ls, n)
    return _cdd_order(Polyhedron_(ring, n, eqs, ieqs, L, gens))


def _cdd_order(P):
    """Over RDF (cdd) the equations come last."""
    if P._ring == "RDF":
        P._H = [h for h in P._H if not h._eq] + [h for h in P._H if h._eq]
        for k, h in enumerate(P._H):
            h._index = k
    return P


def _make_H(ieqs, eqns, n, ring):
    if ring != "RDF":
        ieqs = [[_exact(x) for x in r] for r in ieqs]
        eqns = [[_exact(x) for x in r] for r in eqns]
    if ring == "RDF":
        ieqs = [[float(x) for x in r] for r in ieqs]
        eqns = [[float(x) for x in r] for r in eqns]
    r = _h_to_v(ieqs, eqns, n)
    if r is None:
        return Polyhedron_(ring, n, [], [], [], None)
    eqs, ies, L, gens = r
    return _cdd_order(Polyhedron_(ring, n, eqs, ies, L, gens))


_CLASSES = {}


def _set_class(P, backend):
    """Give the polyhedron a class named as Sage's (Polyhedra_QQ_ppl, ...)."""
    if backend in (None, "ppl"):
        backend = "cdd" if P._ring == "RDF" else "ppl"
    name = "Polyhedra_%s_%s_with_category.element_class" % (P._ring, backend)
    if name not in _CLASSES:
        cls = type("element_class", (Polyhedron_,), {})
        cls.__module__ = "sage.geometry.polyhedron.parent"
        cls.__qualname__ = name
        _CLASSES[name] = cls
    P.__class__ = _CLASSES[name]
    return P


def Polyhedron(vertices=None, rays=None, lines=None, ieqs=None, eqns=None, ambient_dim=None, base_ring=None, minimize=True, verbose=False, backend=None, mutable=False):
    """A polyhedron, from vertices, rays and lines (a V-representation) or
    from inequalities and equations (an H-representation: [b, a_1, ...]
    means b + a_1 x_1 + ... >= 0).

    EXAMPLES::

        sage: P1 = Polyhedron(vertices = [[-5,2], [4,4], [3,0], [1,0], [2,-4], [-3,-1], [-5,-3]]); P1
        A 2-dimensional polyhedron in ZZ^2 defined as the convex hull of 4 vertices
        sage: for q in P1.Hrepresentation(): print(q)
        An inequality (-4, 1) x + 12 >= 0
        An inequality (1, 7) x + 26 >= 0
        An inequality (1, 0) x + 5 >= 0
        An inequality (2, -9) x + 28 >= 0
        sage: Polyhedron(ieqs=[(0, 1, 0), (0, 0, 1), (1, -1, -1)])
        A 2-dimensional polyhedron in QQ^2 defined as the convex hull of 3 vertices
        sage: Polyhedron(vertices=[[0.5, 0], [0, 0.5]])  # sagebrush only
        A 1-dimensional polyhedron in RDF^2 defined as the convex hull of 2 vertices
    """
    if backend is not None and backend not in ("ppl", "cdd", "field", "normaliz", "polymake"):
        raise ValueError("No such backend (=%s)" % backend)
    got_V = vertices is not None or rays is not None or lines is not None
    got_H = ieqs is not None or eqns is not None
    rname = None
    if base_ring is not None:
        rname = {"Integer Ring": "ZZ", "Rational Field": "QQ", "Real Double Field": "RDF"}.get(repr(base_ring))
        if rname is None:
            if "Real Field with 53 bits" in repr(base_ring):
                rname = "RDF"
            elif "Real Field" in repr(base_ring):
                raise ValueError("the only allowed inexact ring is 'RDF' with backend 'cdd'")
            else:
                raise NotImplementedError("polyhedra over %r are not available in sagebrush yet" % (base_ring,))
    if got_V or not got_H:
        vs = [list(v) for v in (vertices or [])]
        rs = [list(r) for r in (rays or [])]
        ls = [list(l) for l in (lines or [])]
        allv = [x for v in vs + rs + ls for x in v]
        n = len((vs + rs + ls)[0]) if (vs + rs + ls) else (int(ambient_dim) if ambient_dim is not None else 0)
        conv = []
        for x in allv:
            conv.append(_coerce_number(x))
        if any(isinstance(x, _RF) for x in conv):
            raise ValueError("the only allowed inexact ring is 'RDF' with backend 'cdd'")
        ring = rname or _ring_name([float(x) if isinstance(x, float) else x for x in conv] or [0])
        if ring == "RDF" and backend not in (None, "cdd"):
            raise ValueError("No such backend (=%s) implemented for given basering (=Real Double Field)." % backend)
        cv = lambda v: [_coerce_number(x) for x in v]
        if ring == "ZZ" and rname is None and any(_F(x).denominator != 1 for x in conv if not isinstance(x, float)):
            ring = "QQ"
        if ring == "ZZ" and rname is None and vs and (rs or ls):
            ring = "QQ"
        P = _make_V([cv(v) for v in vs], [cv(r) for r in rs], [cv(l) for l in ls], n, ring)
        return _set_class(P, backend)
    ie = [[_coerce_number(x) for x in r] for r in (ieqs or [])]
    eq = [[_coerce_number(x) for x in r] for r in (eqns or [])]
    if not ie and not eq:
        if ambient_dim is None:
            raise ValueError("give the ambient dimension (ambient_dim) of a polyhedron without inequalities")
        n = int(ambient_dim)
    else:
        n = len((ie + eq)[0]) - 1
        if ambient_dim is not None and int(ambient_dim) != n:
            raise ValueError("the inequalities do not have ambient dimension %d" % int(ambient_dim))
    allv = [x for r in ie + eq for x in r]
    ring = rname or ("RDF" if any(isinstance(x, float) for x in allv) else "QQ")
    if ring == "ZZ":
        ring = "QQ"
    return _set_class(_make_H(ie, eq, n, ring), backend)


class _RF:
    pass


def _coerce_number(x):
    if isinstance(x, (int, _F)) and not isinstance(x, bool):
        return _F(x)
    if type(x).__name__ == "Expression":
        try:
            return _q(_sa().QQ(x))
        except Exception:
            raise ValueError("no default backend for computations with Symbolic Ring")
    if isinstance(x, float):
        return x
    s = type(x).__name__
    if hasattr(x, "_prec") and getattr(x, "_prec", 53) != 53:
        return _RF()
    if hasattr(x, "prec") and callable(x.prec) and s not in ("Rational", "Integer"):
        try:
            if int(x.prec()) != 53:
                return _RF()
            return float(x)
        except Exception:
            pass
    try:
        return _q(x)
    except Exception:
        return float(x)


# ------------------------------------------------------------- the catalog

class _Polytopes:
    """The catalog of polytopes (polytopes.hypercube(n), ...)."""

    def __repr__(self):
        return "The catalog of polytopes"

    def hypercube(self, dim, intervals=None, backend=None):
        """The n-cube [-1, 1]^n.

        EXAMPLES::

            sage: polytopes.hypercube(3)
            A 3-dimensional polyhedron in ZZ^3 defined as the convex hull of 8 vertices
            sage: polytopes.hypercube(4).f_vector()
            (1, 16, 32, 24, 8, 1)
        """
        n = int(dim)
        ieqs = [[1] + [-int(i == j) for j in range(n)] for i in range(n)] + [[1] + [int(i == j) for j in range(n)] for i in range(n)]
        verts = _cube_vertices(n)
        P = Polyhedron_("ZZ", n, [], [], [], [])
        P._H = [_HRep(P, tuple(r[1:]) + (r[0],), False, k) for k, r in enumerate(_cube_ieqs(n))]
        P._V = [_VRep(P, [_F(x) for x in v], "vertex", k) for k, v in enumerate(verts)]
        return P

    def cube(self, backend=None):
        """The cube [-1, 1]^3.

        EXAMPLES::

            sage: polytopes.cube()
            A 3-dimensional polyhedron in ZZ^3 defined as the convex hull of 8 vertices
        """
        return self.hypercube(3)

    def cross_polytope(self, dim, backend=None):
        """The cross polytope (convex hull of +-e_i).

        EXAMPLES::

            sage: polytopes.cross_polytope(3).Vrepresentation()
            (A vertex at (-1, 0, 0), A vertex at (0, -1, 0), A vertex at (0, 0, -1), A vertex at (0, 0, 1), A vertex at (0, 1, 0), A vertex at (1, 0, 0))
        """
        n = int(dim)
        vs = [[int(i == j) for j in range(n)] for i in range(n)] + [[-int(i == j) for j in range(n)] for i in range(n)]
        return Polyhedron(vertices=vs)

    def octahedron(self, backend=None):
        """The octahedron.

        EXAMPLES::

            sage: polytopes.octahedron().f_vector()
            (1, 6, 12, 8, 1)
        """
        return self.cross_polytope(3)

    def simplex(self, dim=3, project=False, base_ring=None, backend=None):
        """The standard simplex (convex hull of the unit vectors of R^{n+1}).

        EXAMPLES::

            sage: polytopes.simplex(3)
            A 3-dimensional polyhedron in ZZ^4 defined as the convex hull of 4 vertices
        """
        n = int(dim)
        return Polyhedron(vertices=[[int(i == j) for j in range(n + 1)] for i in range(n + 1)])

    def cyclic_polytope(self, dim, n, base_ring=None, backend=None):
        """The cyclic polytope: the convex hull of (t, t^2, ..., t^d), t = 0..n-1.

        EXAMPLES::

            sage: polytopes.cyclic_polytope(3, 10)
            A 3-dimensional polyhedron in QQ^3 defined as the convex hull of 10 vertices
        """
        d = int(dim)
        P = Polyhedron(vertices=[[t ** k for k in range(1, d + 1)] for t in range(int(n))])
        P._ring = "QQ"
        return P

    def regular_polygon(self, n, exact=True, base_ring=None, backend=None):
        """The regular n-gon (inexact).

        EXAMPLES::

            sage: polytopes.regular_polygon(5, exact=False)  # sagebrush only
            A 2-dimensional polyhedron in RDF^2 defined as the convex hull of 5 vertices
        """
        import math
        n = int(n)
        vs = [[math.sin(2 * math.pi * k / n), math.cos(2 * math.pi * k / n)] for k in range(n)]
        return Polyhedron(vertices=vs, base_ring=_sa().RDF)

    def permutahedron(self, n, project=False, backend=None):
        """The permutahedron: the convex hull of the permutations of (1, ..., n).

        EXAMPLES::

            sage: polytopes.permutahedron(3)
            A 2-dimensional polyhedron in ZZ^3 defined as the convex hull of 6 vertices
        """
        n = int(n)
        return Polyhedron(vertices=[list(p) for p in itertools.permutations(range(1, n + 1))])

    def snub_cube(self, exact=False, base_ring=None, backend=None, verbose=False):
        """The snub cube (inexact).

        EXAMPLES::

            sage: polytopes.snub_cube(exact=False)  # sagebrush only
            A 3-dimensional polyhedron in RDF^3 defined as the convex hull of 24 vertices
        """
        if exact:
            raise NotImplementedError("the exact snub cube needs number fields")
        import math
        t = 1.839286755214161   # the tribonacci constant
        base = (1.0, 1.0 / t, t)
        vs = []
        for perm, parity in [((0, 1, 2), 0), ((1, 2, 0), 0), ((2, 0, 1), 0), ((1, 0, 2), 1), ((0, 2, 1), 1), ((2, 1, 0), 1)]:
            for signs in itertools.product((1, -1), repeat=3):
                if sum(1 for x in signs if x > 0) % 2 == parity:
                    vs.append([signs[k] * base[perm[k]] for k in range(3)])
        return Polyhedron(vertices=vs, base_ring=_sa().RDF)


def _cube_vertices(n):
    """The vertices of [-1, 1]^n in Sage's order."""
    table = {1: [[1], [-1]], 2: [[1, -1], [1, 1], [-1, 1], [-1, -1]],
             3: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1], [-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]],
             4: [[1, -1, 1, 1], [1, 1, -1, -1], [1, 1, 1, -1], [1, 1, 1, 1], [1, 1, -1, 1], [1, -1, -1, 1], [1, -1, -1, -1], [1, -1, 1, -1],
                 [-1, -1, 1, -1], [-1, -1, 1, 1], [-1, 1, -1, -1], [-1, 1, 1, -1], [-1, 1, 1, 1], [-1, 1, -1, 1], [-1, -1, -1, 1], [-1, -1, -1, -1]]}
    if n in table:
        return table[n]
    return [list(p) for p in itertools.product([1, -1], repeat=n)]


def _cube_ieqs(n):
    """The inequalities of [-1, 1]^n in Sage's order."""
    first = [[1] + [-int(i == j) for j in range(n)] for i in range(n)]
    second = [[1, 1] + [0] * (n - 1)] + [[1] + [int(j == i) for j in range(n)] for i in range(n - 1, 0, -1)]
    return first + second


polytopes = _Polytopes()
