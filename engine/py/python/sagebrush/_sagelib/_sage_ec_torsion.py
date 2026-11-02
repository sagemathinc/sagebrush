"""The torsion subgroup of an elliptic curve over QQ (E.torsion_subgroup()),
as Sage 10.9 gives it: its structure, and the generators PARI's elltors
chooses, which Sage shows.  Loaded on first use.

The generators follow the rules PARI states for its choice: on the integral
model, a point's x is "smaller" with a smaller |denominator|, then a smaller
|numerator|; a cyclic factor's generator is its multiple i*P, i prime to the
order, with the smallest x, negated if 2y + a1 x + a3 < 0; for Z/2 x Z/2n,
the first 2-torsion points by increasing x and a fixed swap.  The points are
listed in Sage's order.  Both were checked against Sage 10.9 for every
curve of conductor < 1000 in Cremona's tables with nontrivial torsion
(3438 curves).
"""

from math import gcd


def _ec():
    import _sage_ec
    return _sage_ec


def _smaller_x(x, y):
    """x before y: a smaller |denominator|, then a smaller |numerator|."""
    dx, dy = abs(x.denominator), abs(y.denominator)
    return dx < dy or (dx == dy and abs(x.numerator) < abs(y.numerator))


def _cycle_gen(a, p, k):
    """The generator of <p> (order k) with the smallest x among its multiples
    i*p, 1 <= i < k/2, i prime to k (the first of equal ones); negated if
    2y + a1 x + a3 < 0."""
    ec = _ec()
    p0 = q = p
    i = 2
    while i + i < k:
        q = ec.add(a, q, p0)
        if gcd(i, k) == 1 and _smaller_x(q[0], p[0]):
            p = q
        i += 1
    if 2 * p[1] + a[0] * p[0] + a[2] < 0:
        p = ec.neg(a, p)
    return p


def _gens(a, k, p, q):
    """The generators for E_tors = <p> (order k) x <q> (order 2, or None)."""
    ec = _ec()
    if q is None:
        return [_cycle_gen(a, p, k)]
    n = k >> 1
    best = q
    np_ = ec.mul(a, n, p)
    if n % 2 and _smaller_x(np_[0], best[0]):
        best = np_
    p1 = ec.add(a, q, np_)
    if _smaller_x(p1[0], best[0]):
        q = p1
    elif best == np_:
        p = ec.add(a, p, q)
        q = np_
    return [_cycle_gen(a, p, k), q]


def _order(a, P):
    return _ec().point_order(a, P)


def _first(a, pts, m):
    """A point of order m with the smallest x (the first rational root of the
    division polynomial), or None."""
    c = [P for P in pts if _order(a, P) == m]
    return min(c) if c else None


def generators(E, pts, invariants):
    """The generators (as (x, y) pairs) of the torsion subgroup with these
    points (affine) and invariants, as PARI's elltors chooses them."""
    ec = _ec()
    a = tuple(E._a)
    if not invariants:
        return []
    B = invariants[-1]
    T2 = sorted(P for P in pts if _order(a, P) == 2)
    if len(invariants) == 2:
        if B == 2:
            return _gens(a, 2, T2[0], T2[1])
        if B == 6:
            P = ec.add(a, _first(a, pts, 3), T2[0])
            Q = T2[1]
        else:
            P = _first(a, pts, B)
            Q = T2[1]
            if Q == ec.mul(a, B >> 1, P):
                Q = T2[0]
        return _gens(a, B, P, Q)
    v2 = 0
    while B % (1 << (v2 + 1)) == 0:
        v2 += 1
    if v2 and B >> v2 != 1:
        P = ec.add(a, _first(a, pts, B >> v2), _first(a, pts, 1 << v2))
    else:
        P = _first(a, pts, B)
    return _gens(a, B, P, None)


class EllipticCurveTorsionSubgroup_with_category:
    """The torsion subgroup of an elliptic curve over QQ (Sage's class name).

    EXAMPLES::

        sage: T = EllipticCurve('14a1').torsion_subgroup(); T
        Torsion Subgroup isomorphic to Z/6 associated to the Elliptic Curve defined by y^2 + x*y + y = x^3 + 4*x - 6 over Rational Field
        sage: T.order(), T.invariants(), T.gens()
        (6, (6,), ((9 : 23 : 1),))
        sage: EllipticCurve([0, -1, 0, -4, 4]).torsion_subgroup().gens()
        ((0 : 2 : 1), (1 : 0 : 1))
    """

    def __init__(self, E):
        from sage_all import Integer
        self._E = E
        pts = [P._P for P in E.torsion_points() if P._P is not None]
        n = len(pts) + 1
        a = tuple(E._a)
        n2 = sum(1 for P in pts if _order(a, P) == 2)
        # (two cyclic factors exactly when the 2-torsion is Z/2 x Z/2)
        self._inv = (2, n // 2) if n2 == 3 else ((n,) if n > 1 else ())
        self._gens = [_pt(E, P) for P in generators(E, pts, self._inv)]
        self._order = Integer(n)

    def __repr__(self):
        g = " + ".join("Z/%d" % k for k in reversed(self._inv)) if self._inv else "Trivial group"
        return "Torsion Subgroup isomorphic to %s associated to the %r" % (g, self._E)

    def curve(self):
        """The curve.

        EXAMPLES::

            sage: EllipticCurve('11a1').torsion_subgroup().curve()
            Elliptic Curve defined by y^2 + y = x^3 - x^2 - 10*x - 20 over Rational Field
        """
        return self._E

    def order(self):
        """The number of torsion points.

        EXAMPLES::

            sage: EllipticCurve('37a1').torsion_subgroup().order()
            1
        """
        return self._order

    cardinality = order

    def invariants(self):
        """The orders of the cyclic factors, increasing.

        EXAMPLES::

            sage: EllipticCurve([0, -1, 0, -4, 4]).torsion_subgroup().invariants()
            (2, 4)
        """
        from sage_all import Integer
        return tuple(Integer(k) for k in self._inv)

    def gens(self):
        """The generators PARI chooses (elltors), as Sage shows them.

        EXAMPLES::

            sage: EllipticCurve('15a1').torsion_subgroup().gens()
            ((-2 : 3 : 1), (-1 : 0 : 1))
        """
        return tuple(self._gens)

    def ngens(self):
        return len(self._gens)

    def gen(self, i=0):
        """The i-th generator.

        EXAMPLES::

            sage: EllipticCurve('14a1').torsion_subgroup().gen(0).order()
            6
        """
        return self._gens[i]

    def exponent(self):
        from sage_all import Integer
        return Integer(self._inv[-1] if self._inv else 1)

    def is_cyclic(self):
        """Whether the group is cyclic.

        EXAMPLES::

            sage: EllipticCurve('14a1').torsion_subgroup().is_cyclic(), EllipticCurve('15a1').torsion_subgroup().is_cyclic()
            (True, False)
        """
        return len(self._inv) <= 1

    def points(self):
        """The points, in Sage's order: the multiples of the generator; for
        Z/2 x Z/n, Sage's own basis (h2 = -g1, h1 = g2 + (n/2) g1).

        EXAMPLES::

            sage: EllipticCurve('14a1').torsion_subgroup().points()
            [(0 : 1 : 0), (9 : 23 : 1), (2 : 2 : 1), (1 : -1 : 1), (2 : -5 : 1), (9 : -33 : 1)]
        """
        E = self._E
        O = E(0)
        if not self._gens:
            return [O]
        n1 = self._inv[-1]
        g1 = self._gens[0]
        if len(self._gens) == 1:
            return [i * g1 for i in range(n1)]
        g2 = self._gens[1]
        if n1 == 2:
            return [i * g1 + j * g2 for i in range(2) for j in range(2)]
        h2 = -g1
        h1 = g2 + (n1 // 2) * g1
        return [i * h1 + j * h2 for i in range(2) for j in range(n1)]

    def __iter__(self):
        return iter(self.points())

    def __call__(self, P):
        """P as an element (a point of the curve in the group).

        EXAMPLES::

            sage: E = EllipticCurve('14a1'); E.torsion_subgroup()(E(1, -1))
            (1 : -1 : 1)
        """
        Q = self._E(P)
        if not Q.has_finite_order():
            raise TypeError("%s is not a torsion point" % (Q,))
        return Q

    def __eq__(self, other):
        return isinstance(other, EllipticCurveTorsionSubgroup_with_category) and other._E == self._E

    def __hash__(self):
        return hash(("torsion", tuple(self._E._a)))


def _pt(E, P):
    from _sage_modular import EllipticCurvePoint
    return EllipticCurvePoint(E, P)


def torsion_subgroup(E):
    """E's torsion subgroup, kept on E (Sage returns the same object)."""
    T = getattr(E, "_torsion_subgroup", None)
    if T is None:
        T = EllipticCurveTorsionSubgroup_with_category(E)
        E._torsion_subgroup = T
    return T
