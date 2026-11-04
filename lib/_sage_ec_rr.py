"""Elliptic curves over RR (Real Field with 53 bits of precision): what
E.base_extend(RR) of a curve over QQ gives.  Loaded on first use (by
base_extend(RR) or a real lift_x), so the start doesn't carry it.

The arithmetic is Sage 10.9's, in IEEE double precision, which rounds
+ - * / and sqrt as MPFR's 53-bit RNDN does: lift_x (D = b^2 + 4f, its
square roots, the y's sorted) and the group law (EllipticCurvePoint_field._add_),
the same operations in the same order.
"""


def _RR():
    from _sage_lang import _RealField
    return _RealField()


def _is_RR(R):
    return type(R).__name__ == "_RealField"


class EllipticCurve_real_field:
    """An elliptic curve over RR (Real Field with 53 bits of precision), as
    E.base_extend(RR) gives: its points, the group law, lift_x and plot,
    by Sage's formulas in floating point.

    EXAMPLES::

        sage: E = EllipticCurve([-1, 0]).base_extend(RR); E
        Elliptic Curve defined by y^2 = x^3 - 1.00000000000000*x over Real Field with 53 bits of precision
        sage: E.lift_x(RR(-0.5), all=True)
        [(-0.500000000000000 : -0.612372435695794 : 1.00000000000000), (-0.500000000000000 : 0.612372435695794 : 1.00000000000000)]
        sage: P = E.lift_x(RR(-0.5)); -P, P.xy()
        ((-0.500000000000000 : 0.612372435695794 : 1.00000000000000), (-0.500000000000000, -0.612372435695794))
    """

    def __init__(self, ainvs):
        R = _RR()
        self._a = tuple(R(a) for a in ainvs)

    def _equation(self):
        R = _RR()
        a1, a2, a3, a4, a6 = self._a

        def terms(head, cs):
            s = head
            for c, mon in cs:
                if c == 0:
                    continue
                m = repr(R(abs(float(c))))
                s += (" - " if c < 0 else " + ") + (m + "*" + mon if mon else m)
            return s
        return terms("y^2", [(a1, "x*y"), (a3, "y")]) + " = " + terms("x^3", [(a2, "x^2"), (a4, "x"), (a6, "")])

    def __repr__(self):
        return "Elliptic Curve defined by %s over Real Field with 53 bits of precision" % self._equation()

    def __eq__(self, other):
        return isinstance(other, EllipticCurve_real_field) and other._a == self._a

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash(("EllipticCurve_RR", self._a))

    def base_ring(self):
        return _RR()

    def a_invariants(self):
        return self._a

    ainvs = a_invariants

    def b_invariants(self):
        a1, a2, a3, a4, a6 = self._a
        return (a1 * a1 + 4 * a2, 2 * a4 + a1 * a3, a3 * a3 + 4 * a6,
                a1 * a1 * a6 + 4 * a2 * a6 - a1 * a3 * a4 + a2 * a3 * a3 - a4 * a4)

    def discriminant(self):
        """
        EXAMPLES::

            sage: E = EllipticCurve([-1, 0]).base_extend(RR); E.discriminant(), E.j_invariant()
            (64.0000000000000, 1728.00000000000)
        """
        b2, b4, b6, b8 = self.b_invariants()
        return -b2 * b2 * b8 - 8 * b4 * b4 * b4 - 27 * b6 * b6 + 9 * b2 * b4 * b6

    def j_invariant(self):
        b2, b4, b6, b8 = self.b_invariants()
        c4 = b2 * b2 - 24 * b4
        return c4 * c4 * c4 / self.discriminant()

    def base_extend(self, R):
        if _is_RR(R):
            return EllipticCurve_real_field(self._a)
        raise NotImplementedError("elliptic curves over %s are not available in Sagebrush yet" % (R,))

    change_ring = base_extend

    def __call__(self, *args):
        """E(0), E(x, y), E((x, y)), E((x, y, z)) or a point of E; coordinates
        not on the curve are a TypeError, checked exactly, as in Sage: even a
        computed point's rounded coordinates, given as numbers, may be refused
        (the point itself is accepted).

        EXAMPLES::

            sage: E = EllipticCurve([-1, 0]).base_extend(RR); E(0), E(1, 0)
            ((0.000000000000000 : 1.00000000000000 : 0.000000000000000), (1.00000000000000 : 0.000000000000000 : 1.00000000000000))
        """
        R = _RR()
        if len(args) == 1 and isinstance(args[0], EllipticCurvePoint_real_field) and args[0]._E == self:
            return args[0]
        if len(args) == 1 and not isinstance(args[0], (list, tuple)) and args[0] == 0:
            return EllipticCurvePoint_real_field(self, (R(0), R(1), R(0)))
        if len(args) == 1:
            args = tuple(args[0])
        c = [R(t) for t in args]
        if len(c) == 2:
            c.append(R(1))
        if len(c) != 3:
            raise TypeError("a point is (x, y) or (x, y, z)")
        x, y, z = c
        if z == 0:
            if x != 0 or y == 0:
                raise TypeError("Coordinates %s do not define a point on %r" % (c, self))
            return EllipticCurvePoint_real_field(self, (R(0), R(1), R(0)))
        if z != 1:
            x, y, z = x / z, y / z, R(1)
        a1, a2, a3, a4, a6 = self._a
        if y * y + a1 * x * y + a3 * y - (x * x * x + a2 * x * x + a4 * x + a6) != 0:
            raise TypeError("Coordinates %s do not define a point on %r" % (c, self))
        return EllipticCurvePoint_real_field(self, (x, y, z))

    point = __call__

    def lift_x(self, x, all=False):
        """The points with x-coordinate x (Sage's: the y's from
        D = b^2 + 4f, sorted; one point when D = 0, none when D < 0).

        EXAMPLES::

            sage: E = EllipticCurve([-1, 0]).base_extend(RR)
            sage: E.lift_x(RR(0.5), all=True), E.lift_x(1)
            ([], (1.00000000000000 : 0.000000000000000 : 1.00000000000000))
            sage: E.lift_x(RR(0.5))
            Traceback (most recent call last):
            ...
            ValueError: No point with x-coordinate 0.500000000000000 on Elliptic Curve defined by y^2 = x^3 - 1.00000000000000*x over Real Field with 53 bits of precision
        """
        import math
        R = _RR()
        x = R(x)
        a1, a2, a3, a4, a6 = self._a
        b = a1 * x + a3
        f = ((x + a2) * x + a4) * x + a6
        D = b * b + 4 * f
        ys = []
        if D >= 0:
            d = R(math.sqrt(float(D)))
            ds = [d] if d == 0 else [d, -d]
            ys = sorted((-b + t) / 2 for t in ds)
        one = R(1)
        if ys:
            if all:
                return [EllipticCurvePoint_real_field(self, (x, y, one)) for y in ys]
            return EllipticCurvePoint_real_field(self, (x, ys[0], one))
        if all:
            return []
        raise ValueError("No point with x-coordinate %s on %s" % (x, self))

    def plot(self, *args, **kwds):
        """The real points, drawn as for a curve over QQ (Sage's ranges)."""
        from _sage_modular import EllipticCurve_rational_field
        return EllipticCurve_rational_field.plot(self, *args, **kwds)


class _PointSet_RR:
    def __init__(self, E):
        self._E = E

    def __repr__(self):
        return "Abelian group of points on %r" % (self._E,)

    def __eq__(self, other):
        return isinstance(other, _PointSet_RR) and other._E == self._E

    def __hash__(self):
        return hash(("pointset_RR", self._E))


class EllipticCurvePoint_real_field:
    """A point of an elliptic curve over RR, (x : y : z) with z = 1 or the
    identity (0 : 1 : 0); the group law is Sage's (_add_ of
    EllipticCurvePoint_field), in floating point.

    EXAMPLES::

        sage: E = EllipticCurve([-1, 0]).base_extend(RR)
        sage: P = E.lift_x(RR(-0.5)); Q = E.lift_x(RR(1.1))
        sage: P + Q, 2 * P, P - P
        ((-0.593219728949398 : 0.620048372025317 : 1.00000000000000), (1.04166666666667 : 0.297681045129900 : 1.00000000000000), (0.000000000000000 : 1.00000000000000 : 0.000000000000000))
        sage: E(0).xy()
        (NaN, +infinity)
    """

    def __init__(self, E, coords):
        self._E = E
        self._c = tuple(coords)

    def curve(self):
        return self._E

    def parent(self):
        return _PointSet_RR(self._E)

    def __getitem__(self, i):
        return self._c[i]

    def __iter__(self):
        return iter(self._c)

    def __len__(self):
        return 3

    def __repr__(self):
        return "(%r : %r : %r)" % self._c

    def is_zero(self):
        return self._c[2] == 0

    def __bool__(self):
        return not self.is_zero()

    def xy(self):
        x, y, z = self._c
        if z == 1:
            return x, y
        R = _RR()
        if z == 0:
            # (Sage: 0/0 and 1/0 in RR)
            return R(float("nan")), R(float("inf"))
        return x / z, y / z

    def __eq__(self, other):
        if not isinstance(other, EllipticCurvePoint_real_field):
            return other == 0 and self.is_zero() if isinstance(other, int) else False
        return other._E == self._E and other._c == self._c

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash(("ECpoint_RR", self._c))

    def __neg__(self):
        if self.is_zero():
            return self
        a1, a2, a3, a4, a6 = self._E._a
        x, y, z = self._c
        return EllipticCurvePoint_real_field(self._E, (x, -y - a1 * x - a3, z))

    def __add__(self, other):
        if not isinstance(other, EllipticCurvePoint_real_field) or other._E != self._E:
            return NotImplemented
        if self.is_zero():
            return other
        if other.is_zero():
            return self
        E = self._E
        a1, a2, a3, a4, a6 = E._a
        x1, y1 = self.xy()
        x2, y2 = other.xy()
        if x1 == x2 and y1 == -y2 - a1 * x2 - a3:
            return E(0)
        if x1 == x2 and y1 == y2:
            m = (3 * x1 * x1 + 2 * a2 * x1 + a4 - a1 * y1) / (2 * y1 + a1 * x1 + a3)
        else:
            m = (y1 - y2) / (x1 - x2)
        x3 = -x1 - x2 - a2 + m * (m + a1)
        y3 = -y1 - a3 - a1 * x3 + m * (x1 - x3)
        return EllipticCurvePoint_real_field(E, (x3, y3, _RR()(1)))

    def __sub__(self, other):
        return self + -other

    def __mul__(self, n):
        if isinstance(n, EllipticCurvePoint_real_field) or isinstance(n, float):
            return NotImplemented
        n = int(n)
        if n < 0:
            return (-self) * (-n)
        r = self._E(0)
        for bit in bin(n)[2:]:
            r = r + r
            if bit == "1":
                r = r + self
        return r

    __rmul__ = __mul__
