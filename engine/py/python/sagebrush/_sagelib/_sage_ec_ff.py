"""Elliptic curves over a prime field: GF(p) or Zmod(p), p prime.

y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6, its points in affine
coordinates (the point at infinity is None), the group law of the general
Weierstrass form, and the number of points:

- p < 4096: counted, x by x (a Legendre symbol per x);
- j = 0 or j = 1728 (on the short model): the complex-multiplication
  candidates (Cornacchia), told apart by points; any p, so secp256k1's;
- otherwise, p < 2^64: Mestre's baby-step giant-step on the curve and its
  quadratic twist, in the Hasse interval.  Beyond 2^64 Sage uses PARI's SEA;
  Sagebrush refuses.

EllipticCurve() (in _sage_modular) comes here when the base ring is a prime
field or Zmod(p), or a coefficient is an element of one.
"""

import math as _m
import random as _random


def _sa():
    import sage_all
    return sage_all


def _ff():
    import _sage_ff
    return _sage_ff


def _is_modp_ring(R):
    return isinstance(R, _ff().IntegerModRing_)


def _same_ring(R, S):
    return R._n == S._n and bool(R._is_gf) == bool(S._is_gf)


def _v(c):
    """The int in [0, p) of an element of the base ring."""
    return c._v


def _legendre(a, p):
    a %= p
    if a == 0:
        return 0
    return 1 if pow(a, (p - 1) // 2, p) == 1 else -1


def _cornacchia(d, p):
    """(a, b) with a^2 + d*b^2 = p (p prime), or None."""
    r = _ff()._sqrt_mod_prime(-d % p, p)
    if not r:
        return None
    r0 = r[-1]
    a, b = p, r0
    lim = _m.isqrt(p)
    while b > lim:
        a, b = b, a % b
    rest = p - b * b
    if rest % d:
        return None
    c2 = rest // d
    c = _m.isqrt(c2)
    return (b, c) if c * c == c2 else None


class _Curve:
    """The arithmetic of y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6 over
    Z/pZ on ints: a point is (x, y) or None (the point at infinity)."""

    def __init__(self, a, p):
        self.a = tuple(int(c) % p for c in a)
        self.p = p

    def on_curve(self, x, y):
        a1, a2, a3, a4, a6 = self.a
        return (y * y + a1 * x * y + a3 * y - (x * x * x + a2 * x * x + a4 * x + a6)) % self.p == 0

    def neg(self, P):
        if P is None:
            return None
        a1, _, a3, _, _ = self.a
        x, y = P
        return (x, (-y - a1 * x - a3) % self.p)

    def add(self, P, Q):
        if P is None:
            return Q
        if Q is None:
            return P
        p = self.p
        a1, a2, a3, a4, a6 = self.a
        x1, y1 = P
        x2, y2 = Q
        if x1 == x2:
            if (y1 + y2 + a1 * x2 + a3) % p == 0:
                return None
            d = (2 * y1 + a1 * x1 + a3) % p
            inv = pow(d, -1, p)
            lam = (3 * x1 * x1 + 2 * a2 * x1 + a4 - a1 * y1) * inv % p
            nu = (-x1 * x1 * x1 + a4 * x1 + 2 * a6 - a3 * y1) * inv % p
        else:
            inv = pow(x2 - x1, -1, p)
            lam = (y2 - y1) * inv % p
            nu = (y1 * x2 - y2 * x1) * inv % p
        x3 = (lam * lam + a1 * lam - a2 - x1 - x2) % p
        y3 = (-(lam + a1) * x3 - nu - a3) % p
        return (x3, y3)

    def mul(self, n, P):
        n = int(n)
        if n < 0:
            n, P = -n, self.neg(P)
        R = None
        while n:
            if n & 1:
                R = self.add(R, P)
            n >>= 1
            if n:
                P = self.add(P, P)
        return R

    def ys(self, x):
        """The y with (x, y) on the curve, ascending."""
        p = self.p
        a1, a2, a3, a4, a6 = self.a
        x %= p
        if p == 2:
            return [y for y in (0, 1) if self.on_curve(x, y)]
        h = (a1 * x + a3) % p
        f = (x * x * x + a2 * x * x + a4 * x + a6) % p
        disc = (h * h + 4 * f) % p
        inv2 = (p + 1) // 2
        return sorted({(s - h) * inv2 % p for s in _ff()._sqrt_mod_prime(disc, p)})

    def short(self):
        """(A, B) of the short model y^2 = x^3 + A x + B (p > 3), isomorphic."""
        p = self.p
        c4, c6 = self.c4c6()
        return (-27 * c4 % p, -54 * c6 % p)

    def b_invariants(self):
        a1, a2, a3, a4, a6 = self.a
        b2 = a1 * a1 + 4 * a2
        b4 = 2 * a4 + a1 * a3
        b6 = a3 * a3 + 4 * a6
        b8 = a1 * a1 * a6 + 4 * a2 * a6 - a1 * a3 * a4 + a2 * a3 * a3 - a4 * a4
        return b2, b4, b6, b8

    def c4c6(self):
        b2, b4, b6, _ = self.b_invariants()
        p = self.p
        return ((b2 * b2 - 24 * b4) % p, (-b2 ** 3 + 36 * b2 * b4 - 216 * b6) % p)

    def discriminant(self):
        b2, b4, b6, b8 = self.b_invariants()
        return (-b2 * b2 * b8 - 8 * b4 ** 3 - 27 * b6 * b6 + 9 * b2 * b4 * b6) % self.p

    def points_from(self, start=0):
        """Points (x, y) for x = start, start + 1, ... (each x's first y)."""
        x = start
        while x < self.p:
            ys = self.ys(x)
            if ys:
                yield (x, ys[-1])
            x += 1


def _naive_count(C):
    p = C.p
    if p == 2:
        return 1 + sum(len(C.ys(x)) for x in range(2))
    a1, a2, a3, a4, a6 = C.a
    n = 1 + p
    for x in range(p):
        h = (a1 * x + a3) % p
        f = (x * x * x + a2 * x * x + a4 * x + a6) % p
        n += _legendre(h * h + 4 * f, p)
    return n


def _hasse(p):
    w = _m.isqrt(4 * p)
    return p + 1 - w, p + 1 + w


def _point_order_multiple(C, P, lo, hi):
    """An m in [lo, hi] with m*P = O (baby-step giant-step), or None."""
    width = hi - lo
    s = _m.isqrt(width) + 1
    table = {}
    R = None
    for j in range(s):
        table.setdefault(R, j)
        R = C.add(R, P)
    G = C.mul(s, P)
    Q = C.mul(lo, P)
    for i in range(s + 1):
        j = table.get(C.neg(Q))
        if j is not None:
            m = lo + i * s + j
            if m <= hi:
                return m
        Q = C.add(Q, G)
    return None


def _order_from_multiple(C, P, m):
    """The order of P, given m with m*P = O."""
    o = m
    for q, _ in _sa().factor(m) if m > 1 else []:
        q = int(q)
        while o % q == 0 and C.mul(o // q, P) is None:
            o //= q
    return o


def _crt_count(M, Mt, p, lo, hi):
    """The N in [lo, hi] with M | N and Mt | 2p + 2 - N: (first, unique?)."""
    g = _m.gcd(M, Mt)
    t = (2 * p + 2) % Mt
    if t % g:
        return None, False
    L = M // g * Mt
    # N = M*k, M*k = t (mod Mt): k = (t/g) * (M/g)^-1 (mod Mt/g)
    mt = Mt // g
    k = (t // g) * pow(M // g, -1, mt) % mt if mt > 1 else 0
    N0 = M * k % L
    first = lo + (N0 - lo) % L
    if first > hi:
        return None, False
    return first, first + L > hi


def _mestre(C):
    p = C.p
    A, B = C.short()
    S = _Curve((0, 0, 0, A, B), p)
    d = 2
    while _legendre(d, p) != -1:
        d += 1
    T = _Curve((0, 0, 0, A * d * d, B * d * d * d), p)
    lo, hi = _hasse(p)
    M, Mt = 1, 1
    gs, gt = S.points_from(0), T.points_from(0)
    for _ in range(400):
        for curve, gen, twist in ((S, gs, False), (T, gt, True)):
            P = next(gen, None)
            if P is None:
                continue
            m = _point_order_multiple(curve, P, lo, hi)
            if m is None:
                continue
            o = _order_from_multiple(curve, P, m)
            if twist:
                Mt = Mt * o // _m.gcd(Mt, o)
            else:
                M = M * o // _m.gcd(M, o)
            first, unique = _crt_count(M, Mt, p, lo, hi)
            if unique:
                return first
    raise RuntimeError("point counting did not converge (p = %d)" % p)


def _cm_count(C):
    """The number of points when the short model has A = 0 or B = 0, or None."""
    p = C.p
    A, B = C.short()
    if A == 0:
        if p % 3 == 2:
            return p + 1
        a, b = _cornacchia(3, p)
        traces = {2 * a, -2 * a, a + 3 * b, -(a + 3 * b), a - 3 * b, -(a - 3 * b)}
    elif B == 0:
        if p % 4 == 3:
            return p + 1
        a, b = _cornacchia(1, p)
        traces = {2 * a, -2 * a, 2 * b, -2 * b}
    else:
        return None
    S = _Curve((0, 0, 0, A, B), p)
    cands = sorted(p + 1 - t for t in traces)
    for P in S.points_from(0):
        cands = [N for N in cands if S.mul(N, P) is None]
        if len(cands) <= 1:
            break
    if len(cands) != 1:
        raise RuntimeError("point counting did not converge (p = %d)" % p)
    return cands[0]


def _count(C):
    p = C.p
    if p < 4096:
        return _naive_count(C)
    N = _cm_count(C)
    if N is not None:
        return N
    if p >= 2 ** 64:
        raise NotImplementedError("the number of points of an elliptic curve over GF(p) with p >= 2^64 "
                                  "(Sage counts them with PARI's SEA) is not available in Sagebrush yet, "
                                  "except for j-invariant 0 or 1728")
    return _mestre(C)


class EllipticCurvePointSet:
    """The group of points of an elliptic curve over GF(p).

    EXAMPLES::

        sage: E = EllipticCurve([Mod(7, 11), Mod(2, 11)]); E(0).parent()
        Abelian group of points on Elliptic Curve defined by y^2 = x^3 + 7*x + 2 over Ring of integers modulo 11
    """

    def __init__(self, E):
        self._E = E

    def __repr__(self):
        return "Abelian group of points on %s" % (self._E,)

    def __eq__(self, other):
        return isinstance(other, EllipticCurvePointSet) and other._E == self._E

    def __hash__(self):
        return hash(("pointset", self._E))

    def __call__(self, *args):
        return self._E(*args)

    def zero(self):
        return self._E(0)

    def curve(self):
        return self._E

    def order(self):
        return self._E.order()

    cardinality = order


class EllipticCurvePoint_finite_field:
    """A point of an elliptic curve over GF(p), printed in projective
    coordinates as Sage does.

    EXAMPLES::

        sage: E = EllipticCurve([Mod(7, 11), Mod(2, 11)])
        sage: P = E((Mod(8, 11), Mod(3, 11))); Q = E(Mod(10, 11), Mod(4, 11)); P, Q
        ((8 : 3 : 1), (10 : 4 : 1))
        sage: (P + Q).xy(), (-Q).xy(), (3 * P - 4 * Q).xy()
        ((7, 3), (10, 7), (10, 4))
        sage: E(0), P.order(), P[0], P[2]
        ((0 : 1 : 0), 7, 8, 1)
    """

    __slots__ = ("_E", "_P")

    def __init__(self, E, P):
        self._E = E
        self._P = P

    def __repr__(self):
        if self._P is None:
            return "(0 : 1 : 0)"
        return "(%d : %d : 1)" % self._P

    def _latex_(self):
        if self._P is None:
            return "\\left(0 : 1 : 0\\right)"
        return "\\left(%d : %d : 1\\right)" % self._P

    def parent(self):
        return EllipticCurvePointSet(self._E)

    def curve(self):
        return self._E

    def scheme(self):
        return self._E

    def __iter__(self):
        return iter(self._coords())

    def __len__(self):
        return 3

    def _coords(self):
        R = self._E._R
        if self._P is None:
            return (R(0), R(1), R(0))
        return (R(self._P[0]), R(self._P[1]), R(1))

    def __getitem__(self, i):
        return self._coords()[i]

    def xy(self):
        """The affine coordinates (x, y); a ZeroDivisionError at infinity, as Sage's.

        EXAMPLES::

            sage: E = EllipticCurve([Mod(7, 11), Mod(2, 11)]); E((8, 3)).xy()
            (8, 3)
            sage: E(0).xy()
            Traceback (most recent call last):
            ...
            ZeroDivisionError: inverse of Mod(0, 11) does not exist
        """
        if self._P is None:
            raise ZeroDivisionError("inverse of Mod(0, %d) does not exist" % self._E._p)
        R = self._E._R
        return (R(self._P[0]), R(self._P[1]))

    def is_zero(self):
        return self._P is None

    def __bool__(self):
        return self._P is not None

    def _other(self, Q):
        if not isinstance(Q, EllipticCurvePoint_finite_field) or not (Q._E == self._E):
            raise TypeError("unsupported operand parent(s) for +: '%s' and '%s'" % (self.parent(), _sa().parent(Q)))
        return Q._P

    def __add__(self, Q):
        if isinstance(Q, int) and Q == 0:
            return self
        return EllipticCurvePoint_finite_field(self._E, self._E._C.add(self._P, self._other(Q)))

    def __radd__(self, Q):
        if isinstance(Q, int) and Q == 0:
            return self
        return NotImplemented

    def __sub__(self, Q):
        C = self._E._C
        return EllipticCurvePoint_finite_field(self._E, C.add(self._P, C.neg(self._other(Q))))

    def __neg__(self):
        return EllipticCurvePoint_finite_field(self._E, self._E._C.neg(self._P))

    def __pos__(self):
        return self

    def __mul__(self, n):
        if isinstance(n, float) or isinstance(n, EllipticCurvePoint_finite_field):
            return NotImplemented
        if isinstance(n, _ff().IntegerMod):
            n = n._v
        try:
            k = int(n)
        except (TypeError, ValueError):
            return NotImplemented
        if k != n and not isinstance(n, int):
            return NotImplemented
        return EllipticCurvePoint_finite_field(self._E, self._E._C.mul(k, self._P))

    __rmul__ = __mul__

    def __eq__(self, Q):
        if isinstance(Q, EllipticCurvePoint_finite_field):
            return Q._E == self._E and Q._P == self._P
        if isinstance(Q, int) and Q == 0:
            return self._P is None
        if isinstance(Q, (tuple, list)):
            try:
                return self._E(Q) == self
            except (TypeError, ValueError):
                return False
        return False

    def __ne__(self, Q):
        return not self.__eq__(Q)

    def __hash__(self):
        return hash(("ecpt", self._P))

    def order(self):
        """The order of the point in the group of points.

        EXAMPLES::

            sage: E = EllipticCurve(GF(42997061), [32122457, 12623843]); E((22035006, 41971927)).order()
            42994062
        """
        if self._P is None:
            return _sa().Integer(1)
        C = self._E._C
        N = int(self._E.order())
        return _sa().Integer(_order_from_multiple(C, self._P, N))

    additive_order = order

    def __reduce__(self):
        return (_rebuild_point, (self._E, self._P))


def _rebuild_point(E, P):
    return EllipticCurvePoint_finite_field(E, P)


class EllipticCurve_finite_field:
    """An elliptic curve over a prime field GF(p) or Zmod(p).

    EXAMPLES::

        sage: E = EllipticCurve([Mod(7, 11), Mod(2, 11)]); E
        Elliptic Curve defined by y^2 = x^3 + 7*x + 2 over Ring of integers modulo 11
        sage: E.points()
        [(0 : 1 : 0), (7 : 3 : 1), (7 : 8 : 1), (8 : 3 : 1), (8 : 8 : 1), (10 : 4 : 1), (10 : 7 : 1)]
        sage: E.order(), E.discriminant(), E.j_invariant()
        (7, 3, 5)
        sage: EllipticCurve(GF(1009), [1, 2, 3, 4, 5])
        Elliptic Curve defined by y^2 + x*y + 3*y = x^3 + 2*x^2 + 4*x + 5 over Finite Field of size 1009
    """

    def __init__(self, R, ainvs):
        self._R = R
        self._p = R._n
        self._a = tuple(R(c) for c in ainvs)
        self._C = _Curve([_v(c) for c in self._a], self._p)
        self._order = None
        if self._C.discriminant() == 0:
            raise ArithmeticError("%s defines a singular curve" % self._equation())

    def _equation(self):
        from _sage_modular import _poly_repr
        a1, a2, a3, a4, a6 = self._C.a

        def term(c, mono):
            if c == 0:
                return ""
            return " + " + ("" if c == 1 else "%d*" % c) + mono

        lhs = "y^2" + term(a1, "x*y") + term(a3, "y")
        return "%s = %s" % (lhs, _poly_repr([a6, a4, a2, 1], "x"))

    def __repr__(self):
        return "Elliptic Curve defined by %s over %s" % (self._equation(), self._R)

    def __eq__(self, other):
        return (isinstance(other, EllipticCurve_finite_field) and _same_ring(self._R, other._R)
                and self._C.a == other._C.a)

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash(("ecff", self._p, bool(self._R._is_gf), self._C.a))

    def __reduce__(self):
        return (EllipticCurve_finite_field, (self._R, [_v(c) for c in self._a]))

    # ---- invariants
    def a_invariants(self):
        return self._a

    ainvs = a_invariants

    def a1(self):
        return self._a[0]

    def a2(self):
        return self._a[1]

    def a3(self):
        return self._a[2]

    def a4(self):
        return self._a[3]

    def a6(self):
        return self._a[4]

    def b_invariants(self):
        return tuple(self._R(b) for b in self._C.b_invariants())

    def c_invariants(self):
        return tuple(self._R(c) for c in self._C.c4c6())

    def discriminant(self):
        return self._R(self._C.discriminant())

    def j_invariant(self):
        c4 = self._C.c4c6()[0]
        p = self._p
        return self._R(c4 ** 3 * pow(self._C.discriminant(), -1, p) % p)

    def base_ring(self):
        return self._R

    base_field = base_ring

    def change_ring(self, R):
        if _is_modp_ring(R) and R._n == self._p:
            return EllipticCurve_finite_field(R, [_v(c) for c in self._a])
        raise NotImplementedError("change_ring of an elliptic curve over %s to %s is not available in Sagebrush yet"
                                  % (self._R, R))

    base_extend = change_ring

    # ---- points
    def zero(self):
        return EllipticCurvePoint_finite_field(self, None)

    point_at_infinity = zero

    def __call__(self, *args):
        if len(args) == 1:
            t = args[0]
            if isinstance(t, EllipticCurvePoint_finite_field) and t._E == self:
                return t
            if isinstance(t, int) and not isinstance(t, bool) and t == 0:
                return self.zero()
            if isinstance(t, (tuple, list)):
                args = tuple(t)
            elif isinstance(t, EllipticCurvePoint_finite_field):
                args = tuple(t._coords())
        if len(args) not in (2, 3):
            raise TypeError("cannot construct a point of %s from %r" % (self, args))
        R = self._R
        x, y = R(args[0]), R(args[1])
        z = R(args[2]) if len(args) == 3 else R(1)
        p = self._p
        if _v(z) == 0:
            if _v(x) == 0 and _v(y) != 0:
                return self.zero()
            raise TypeError("Coordinates %s do not define a point on %s" % ([x, y, z], self))
        if _v(z) != 1:
            iz = pow(_v(z), -1, p)
            x, y, z = R(_v(x) * iz), R(_v(y) * iz), R(1)
        if not self._C.on_curve(_v(x), _v(y)):
            raise TypeError("Coordinates %s do not define a point on %s" % ([x, y, z], self))
        return EllipticCurvePoint_finite_field(self, (_v(x), _v(y)))

    def point(self, *args):
        return self(*args)

    def __contains__(self, t):
        if isinstance(t, EllipticCurvePoint_finite_field):
            return t._E == self
        try:
            self(t)
            return True
        except (TypeError, ValueError, ZeroDivisionError):
            return False

    def is_on_curve(self, x, y):
        R = self._R
        return self._C.on_curve(_v(R(x)), _v(R(y)))

    def is_x_coord(self, x):
        return bool(self._C.ys(_v(self._R(x))))

    def lift_x(self, x, all=False, extend=False):
        """A point with x-coordinate x (the one with the smaller y), or all of them.

        EXAMPLES::

            sage: E = EllipticCurve([Mod(7, 11), Mod(2, 11)]); E.lift_x(Mod(8, 11)), E.lift_x(8, all=True)
            ((8 : 3 : 1), [(8 : 3 : 1), (8 : 8 : 1)])
            sage: E.lift_x(Mod(1, 11))
            Traceback (most recent call last):
            ...
            ValueError: No point with x-coordinate 1 on Elliptic Curve defined by y^2 = x^3 + 7*x + 2 over Ring of integers modulo 11
        """
        if extend:
            raise NotImplementedError("lift_x(extend=True) over a finite field is not available in Sagebrush yet")
        xv = _v(self._R(x))
        pts = [EllipticCurvePoint_finite_field(self, (xv, y)) for y in self._C.ys(xv)]
        if all:
            return pts
        if not pts:
            raise ValueError("No point with x-coordinate %s on %s" % (self._R(x), self))
        return pts[0]

    def points(self):
        """All the points: the point at infinity, then by x and y.

        EXAMPLES::

            sage: EllipticCurve(GF(13), [0, 1]).points()
            [(0 : 1 : 0), (0 : 1 : 1), (0 : 12 : 1), (2 : 3 : 1), (2 : 10 : 1), (4 : 0 : 1), (5 : 3 : 1), (5 : 10 : 1), (6 : 3 : 1), (6 : 10 : 1), (10 : 0 : 1), (12 : 0 : 1)]
        """
        out = [self.zero()]
        for x in range(self._p):
            for y in self._C.ys(x):
                out.append(EllipticCurvePoint_finite_field(self, (x, y)))
        return out

    rational_points = points

    def random_point(self):
        """A random point (the point at infinity included).

        EXAMPLES::

            sage: E = EllipticCurve(GF(11), [7, 2]); E.random_point() in E
            True
        """
        p = self._p
        while True:
            if _random.randrange(2 * p + 1) == 0:
                return self.zero()
            x = _random.randrange(p)
            ys = self._C.ys(x)
            if ys:
                return EllipticCurvePoint_finite_field(self, (x, _random.choice(ys)))

    random_element = random_point

    def order(self):
        """The number of points.

        EXAMPLES::

            sage: EllipticCurve(GF(42997061), [32122457, 12623843]).order()
            42994062
            sage: p = 2^256 - 2^32 - 977; EllipticCurve([Mod(0, p), Mod(7, p)]).order()
            115792089237316195423570985008687907852837564279074904382605163141518161494337
        """
        if self._order is None:
            self._order = _count(self._C)
        return _sa().Integer(self._order)

    cardinality = order

    def trace_of_frobenius(self):
        return _sa().Integer(self._p + 1 - int(self.order()))

    def __iter__(self):
        return iter(self.points())


def elliptic_curve(R, ainvs):
    """The curve over the prime field (or Zmod(p)) R; any other ring is
    refused as not available yet."""
    if not _is_modp_ring(R):
        raise NotImplementedError("elliptic curves over %s are not available in Sagebrush yet" % (R,))
    if not _sa().is_prime(R._n):
        raise NotImplementedError("elliptic curves over %s (not a field) are not available in Sagebrush yet" % (R,))
    a = list(ainvs)
    if len(a) == 2:
        a = [0, 0, 0, a[0], a[1]]
    if len(a) != 5:
        raise ValueError("an elliptic curve is [a1, a2, a3, a4, a6] or [a4, a6]")
    for c in a:
        if isinstance(c, _ff().IntegerMod):
            if not _same_ring(c._parent, R) and c._parent._n != R._n:
                raise TypeError("unsupported operand parent(s) for -: '%s' and '%s'" % (c._parent, R))
        elif not isinstance(c, int):
            raise TypeError("unsupported operand parent(s) for -: '%s' and '%s'" % (_sa().parent(c), R))
    return EllipticCurve_finite_field(R, a)
