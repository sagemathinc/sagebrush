"""The p-adic numbers of Sage mode: Zp(p, prec) and Qp(p, prec) with capped
relative precision, O(p^n), and their elements, printed as Sage prints them
(print modes 'series', 'val-unit', 'terse', 'digits' and 'bars';
print_pos and print_max_terms).  The arithmetic and its precision are
lib/_padic.py's, which Magma mode shares; this layer adds the parents,
coercion and printing, matched to Sage's (used as a black-box oracle)."""

from fractions import Fraction as _F

from _padic import Padic as _Padic, PrecisionError, NotASquare


def _sa():
    import sage_all
    return sage_all


def _is_prime(p):
    return _sa().is_prime(p)


_RINGS = {}

_MODES = ("series", "val-unit", "terse", "digits", "bars")


def _check(p, prec, type, print_mode):
    try:
        p = int(p)
    except (TypeError, ValueError):
        raise ValueError("p must be prime")
    if p < 2 or not _is_prime(p):
        raise ValueError("p must be prime")
    prec = int(prec)
    if prec < 0:
        raise ValueError("prec_cap must be nonnegative")
    if type not in ("capped-rel", None):
        raise NotImplementedError("p-adic rings of type %r are not available in sagebrush yet (only 'capped-rel')" % (type,))
    mode = "series" if print_mode is None else print_mode
    if mode not in _MODES:
        raise ValueError("print_mode must be one of %s" % ", ".join(repr(m) for m in _MODES))
    return p, prec, mode


def _parent(p, prec, field, mode, pos, max_terms):
    key = (p, prec, field, mode, pos, max_terms)
    if key not in _RINGS:
        _RINGS[key] = (pAdicFieldCappedRelative if field else pAdicRingCappedRelative)(p, prec, mode, pos, max_terms)
    return _RINGS[key]


def Zp(p, prec=20, type="capped-rel", print_mode=None, names=None, print_pos=None, print_sep=None,
       print_alphabet=None, print_max_terms=None, show_prec=None, check=True, label=None):
    """The ring of p-adic integers, with capped relative precision prec (the
    one type available so far).

    EXAMPLES::

        sage: R = Zp(5); R
        5-adic Ring with capped relative precision 20
        sage: R(7), R(-1/3)
        (2 + 5 + O(5^20), 3 + 5 + 3*5^2 + 5^3 + 3*5^4 + 5^5 + 3*5^6 + 5^7 + 3*5^8 + 5^9 + 3*5^10 + 5^11 + 3*5^12 + 5^13 + 3*5^14 + 5^15 + 3*5^16 + 5^17 + 3*5^18 + 5^19 + O(5^20))
        sage: Zp(7, 4)(2).sqrt()
        3 + 7 + 2*7^2 + 6*7^3 + O(7^4)
        sage: Zp(5, 6, print_mode='terse')(-1)
        15624 + O(5^6)
    """
    p, prec, mode = _check(p, prec, type, print_mode)
    return _parent(p, prec, False, mode, print_pos is not False, print_max_terms)


def Qp(p, prec=20, type="capped-rel", print_mode=None, names=None, print_pos=None, print_sep=None,
       print_alphabet=None, print_max_terms=None, show_prec=None, check=True, label=None):
    """The field of p-adic numbers, with capped relative precision prec.

    EXAMPLES::

        sage: K = Qp(5, 6); K
        5-adic Field with capped relative precision 6
        sage: K(3/10)
        4*5^-1 + 2 + 2*5 + 2*5^2 + 2*5^3 + 2*5^4 + O(5^5)
        sage: K(2/25).valuation(), K(2/25).unit_part()
        (-2, 2 + O(5^6))
    """
    p, prec, mode = _check(p, prec, type, print_mode)
    return _parent(p, prec, True, mode, print_pos is not False, print_max_terms)


def ZpCR(p, prec=20, *args, **kwds):
    """Zp(p, prec, type='capped-rel').

    EXAMPLES::

        sage: ZpCR(5, 3)
        5-adic Ring with capped relative precision 3
    """
    kwds.pop("type", None)
    return Zp(p, prec, "capped-rel", *args, **kwds)


def QpCR(p, prec=20, *args, **kwds):
    """Qp(p, prec, type='capped-rel').

    EXAMPLES::

        sage: QpCR(5, 3)
        5-adic Field with capped relative precision 3
    """
    kwds.pop("type", None)
    return Qp(p, prec, "capped-rel", *args, **kwds)


def _bigoh(x):
    """O(p^n) for x = p^n (n an integer of any sign, x an Integer or
    Rational): an inexact zero of Zp(p) (Qp(p) for n < 0)."""
    x = _F(x)
    if x <= 0:
        raise ArithmeticError("x must be prime power")
    if x.denominator == 1:
        n = x.numerator
        neg = False
    elif x.numerator == 1:
        n = x.denominator
        neg = True
    else:
        raise ArithmeticError("x must be prime power")
    f = _sa().factor(n) if n > 1 else []
    f = list(f)
    if len(f) != 1:
        raise ArithmeticError("x must be prime power" if not neg else "x must be a prime power >= 2")
    p, e = int(f[0][0]), int(f[0][1])
    if neg:
        return Qp(p)._element(_Padic.inexact_zero(p, -e))
    return Zp(p)._element(_Padic.inexact_zero(p, e))


class pAdicGeneric_:
    """A ring Zp(p, prec) or field Qp(p, prec) of p-adic numbers with capped
    relative precision.

    EXAMPLES::

        sage: R = Zp(5, 6); R.prime(), R.precision_cap(), R.is_field()
        (5, 6, False)
    """

    _field = False

    def __init__(self, p, prec, mode, pos, max_terms):
        self._p, self._prec, self._mode, self._pos, self._max_terms = p, prec, mode, pos, max_terms

    def __repr__(self):
        return "%d-adic %s with capped relative precision %d" % (self._p, "Field" if self._field else "Ring", self._prec)

    def _latex_(self):
        return "\\Bold{%s}_{%d}" % ("Q" if self._field else "Z", self._p)

    def __hash__(self):
        return hash((self._p, self._prec, self._field, self._mode, self._pos, self._max_terms))

    def __eq__(self, o):
        return self is o

    def __ne__(self, o):
        return self is not o

    def _element(self, x):
        return pAdicCappedRelativeElement(self, x)

    # ------------------------------------------------------------ queries
    def prime(self):
        """p.

        EXAMPLES::

            sage: Zp(7).prime()
            7
        """
        return self._p

    residue_characteristic = prime

    def precision_cap(self):
        """The relative precision cap.

        EXAMPLES::

            sage: Qp(5, 6).precision_cap()
            6
        """
        return self._prec

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: Zp(5).characteristic()
            0
        """
        return 0

    def is_field(self, proof=True):
        """Whether this is Qp.

        EXAMPLES::

            sage: Zp(5).is_field(), Qp(5).is_field()
            (False, True)
        """
        return self._field

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: Zp(5).is_exact()
            False
        """
        return False

    def is_finite(self):
        """False.

        EXAMPLES::

            sage: Zp(5).is_finite()
            False
        """
        return False

    def absolute_degree(self):
        """1.

        EXAMPLES::

            sage: Zp(5).absolute_degree()
            1
        """
        return 1

    degree = absolute_degree

    def ngens(self):
        """1.

        EXAMPLES::

            sage: Zp(5).ngens()
            1
        """
        return 1

    def residue_field(self):
        """GF(p).

        EXAMPLES::

            sage: Zp(5).residue_field()
            Finite Field of size 5
        """
        return _sa().GF(self._p)

    residue_class_field = residue_field

    def fraction_field(self):
        """Qp with the same precision cap and printing.

        EXAMPLES::

            sage: Zp(5, 6).fraction_field()
            5-adic Field with capped relative precision 6
        """
        return _parent(self._p, self._prec, True, self._mode, self._pos, self._max_terms)

    def integer_ring(self):
        """Zp with the same precision cap and printing.

        EXAMPLES::

            sage: Qp(5, 6).integer_ring()
            5-adic Ring with capped relative precision 6
        """
        return _parent(self._p, self._prec, False, self._mode, self._pos, self._max_terms)

    def zero(self):
        """The exact zero.

        EXAMPLES::

            sage: Zp(5).zero()
            0
        """
        return self._element(_Padic.exact_zero(self._p))

    def one(self):
        """1 to the precision cap.

        EXAMPLES::

            sage: Zp(5, 6).one()
            1 + O(5^6)
        """
        return self(1)

    def gen(self, n=0):
        """p.

        EXAMPLES::

            sage: Zp(5, 6).gen()
            5 + O(5^7)
        """
        return self(self._p)

    uniformizer = gen

    def gens(self):
        """(p,).

        EXAMPLES::

            sage: Zp(5, 6).gens()
            (5 + O(5^7),)
        """
        return (self.gen(),)

    def teichmuller(self, x, prec=None):
        """The (p-1)-st root of unity congruent to x mod p, to absolute
        precision prec (default the cap).

        EXAMPLES::

            sage: Zp(5, 6).teichmuller(2)
            2 + 5 + 2*5^2 + 5^3 + 3*5^4 + 4*5^5 + O(5^6)
            sage: Zp(5, 6).teichmuller(3, 3)
            3 + 3*5 + 2*5^2 + O(5^3)
        """
        a = self._residue_of(x)
        n = self._prec if prec is None else min(int(prec), self._prec)
        w = _Padic.teichmuller(self._p, a, n)
        if w == 0:
            return self.zero()
        return self._element(_Padic.from_abs(self._p, w, 0, n, self._prec))

    def teichmuller_system(self):
        """The Teichmuller lifts of 1, ..., p - 1.

        EXAMPLES::

            sage: Zp(3, 4).teichmuller_system()
            [1 + O(3^4), 2 + 2*3 + 2*3^2 + 2*3^3 + O(3^4)]
        """
        return [self.teichmuller(a) for a in range(1, self._p)]

    def _residue_of(self, x):
        if isinstance(x, pAdicCappedRelativeElement):
            return x._x.residue(1)
        return int(_F(x).numerator * pow(_F(x).denominator, -1, self._p) % self._p)

    def random_element(self):
        """A random element to the precision cap.

        EXAMPLES::

            sage: Zp(5, 6).random_element().parent()
            5-adic Ring with capped relative precision 6
        """
        import random
        return self(random.randrange(self._p ** self._prec))

    def cardinality(self):
        """+Infinity.

        EXAMPLES::

            sage: Zp(5).cardinality()
            +Infinity
        """
        return _sa().infinity

    # -------------------------------------------------------- conversion
    def __call__(self, x=0, absprec=None, relprec=None):
        """Convert x (an integer, rational, p-adic number, element of
        Integers(p^k)) to precision absprec (absolute) and relprec
        (relative), each at most what x and the cap allow.

        EXAMPLES::

            sage: R = Zp(5, 6); R(7, 3), R(25), R(Mod(3, 25)), R(0, 4)
            (2 + 5 + O(5^3), 5^2 + O(5^8), 3 + O(5^2), O(5^4))
        """
        p, cap = self._p, self._prec
        absprec = None if absprec is None else int(absprec)
        relprec = None if relprec is None else int(relprec)
        if isinstance(x, pAdicCappedRelativeElement):
            if x._parent._p != p:
                raise TypeError("no conversion between %r and %r" % (x._parent, self))
            y = x._x
            if not self._field and y.v is not None and y.v < 0 and not y.is_zero():
                raise ValueError("negative valuation")
            y = y.recap(cap)
            if absprec is not None:
                y = y.add_bigoh(absprec)
            if relprec is not None and y.r:
                y = y.recap(relprec)
            return self._element(y)
        if type(x).__name__ in ("IntegerMod", "IntegerMod_int", "IntegerMod_int64", "IntegerMod_gmp"):
            n = int(x.modulus())
            k, rest = 0, n
            while rest % p == 0:
                rest //= p
                k += 1
            if rest != 1:
                raise TypeError("no conversion from %r to %r" % (x.parent(), self))
            a = k if absprec is None else min(k, absprec)
            return self._element(_Padic.from_rational(p, int(x.lift()), cap, absprec=a, relprec=relprec))
        if isinstance(x, str):
            x = _F(x)
        if hasattr(x, "_rational_") and not isinstance(x, (int, _F)):
            x = x._rational_()
        try:
            q = _F(x)
        except (TypeError, ValueError):
            raise TypeError("unable to convert %r to %r" % (x, self))
        if not self._field and q != 0 and q.denominator % p == 0:
            raise ValueError("p divides the denominator")
        return self._element(_Padic.from_rational(p, q, cap, absprec=absprec, relprec=relprec))

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False


class pAdicRingCappedRelative(pAdicGeneric_):
    """Zp(p, prec).

    EXAMPLES::

        sage: Zp(3, 5)(-1)
        2 + 2*3 + 2*3^2 + 2*3^3 + 2*3^4 + O(3^5)
    """
    _field = False


class pAdicFieldCappedRelative(pAdicGeneric_):
    """Qp(p, prec).

    EXAMPLES::

        sage: Qp(5, 6)(-2/125)
        3*5^-3 + 4*5^-2 + 4*5^-1 + 4 + 4*5 + 4*5^2 + O(5^3)
    """
    _field = True


def _pushout(A, B):
    """The parent of a binary operation on elements of A and B (same p):
    a field if either is; between two rings or two fields the larger cap;
    for parents differing only in printing, B's (as Sage)."""
    if A is B:
        return A
    if A._field != B._field:
        return A if A._field else B
    if A._prec != B._prec:
        return A if A._prec > B._prec else B
    return B


class pAdicCappedRelativeElement:
    """An element of Zp(p, prec) or Qp(p, prec): p^v u + O(p^(v + r)).

    EXAMPLES::

        sage: a = Zp(5, 6)(23); a, a.valuation(), a.precision_absolute()
        (3 + 4*5 + O(5^6), 0, 6)
        sage: (2 + O(5^3))^5
        2 + 5 + 5^2 + O(5^4)
    """

    __slots__ = ("_parent", "_x")

    def __init__(self, parent, x):
        self._parent, self._x = parent, x

    def parent(self):
        """Zp(p, prec) or Qp(p, prec).

        EXAMPLES::

            sage: Zp(5)(1).parent()
            5-adic Ring with capped relative precision 20
        """
        return self._parent

    # ---------------------------------------------------------- printing
    def __repr__(self):
        return self._repr_()

    def _repr_(self, mode=None, latex=False):
        P = self._parent
        mode = P._mode if mode is None else mode
        x, p = self._x, P._p
        if x.is_exact_zero():
            return "0"
        big = _bigoh_str(p, x.absprec(), latex)
        if x.is_zero():
            if mode in ("digits", "bars"):
                return _digits_str(x, mode)
            return big
        if mode == "series":
            ds = x.digits() if P._pos else x.balanced_digits()
            terms = [(e, d) for e, d in ds if d != 0]
            mt = P._max_terms
            shown = terms if mt is None or len(terms) <= mt else terms[:mt]
            s = ""
            for i, (e, d) in enumerate(shown):
                t = _term_str(abs(d), p, e, latex)
                if i == 0:
                    s = ("-" + t) if d < 0 else t
                else:
                    s += (" - " if d < 0 else " + ") + t
            if len(shown) < len(terms):
                s += " + ..."
            return s + " + " + big
        if mode == "val-unit":
            u = x.u if P._pos else _centered(x.u, p ** x.r)
            us = str(u) if u >= 0 or x.v == 0 else "(%d)" % u
            if x.v == 0:
                return "%s + %s" % (us, big)
            pv = str(p) if x.v == 1 else ("%d^{%d}" % (p, x.v) if latex else "%d^%d" % (p, x.v))
            return "%s %s %s + %s" % (pv, "\\cdot" if latex else "*", us, big)
        if mode == "terse":
            u = x.u if P._pos else _centered(x.u, p ** x.r)
            if x.v >= 0:
                return "%d + %s" % (u * p ** x.v, big)
            den = str(p) if x.v == -1 else ("%d^{%d}" % (p, -x.v) if latex else "%d^%d" % (p, -x.v))
            return "%d/%s + %s" % (u, den, big)
        return _digits_str(x, mode)

    def _latex_(self):
        return self._repr_(latex=True)

    def str(self):
        """The printed form.

        EXAMPLES::

            sage: Zp(5, 6)(23).str()
            '3 + 4*5 + O(5^6)'
        """
        return self._repr_()

    # ---------------------------------------------------------- queries
    def valuation(self, p=None):
        """The p-adic valuation (+Infinity for the exact zero; n for
        O(p^n)).

        EXAMPLES::

            sage: Zp(5)(75).valuation(), Qp(5)(2/25).valuation(), Zp(5)(0).valuation()
            (2, -2, +Infinity)
        """
        if self._x.is_exact_zero():
            return _sa().infinity
        return self._x.v

    def ordp(self, p=None):
        """The valuation (as a rational, as Sage).

        EXAMPLES::

            sage: Zp(5)(75).ordp()
            2
        """
        return _sa().QQ(self.valuation())

    def unit_part(self):
        """u, with self = p^v u.

        EXAMPLES::

            sage: Zp(5)(75).unit_part(), Zp(5, 6)(0, 3).unit_part()
            (3 + O(5^20), O(5^0))
        """
        x = self._x
        if x.is_exact_zero():
            raise ValueError("unit part of 0 not defined")
        if x.is_zero():
            return self._parent._element(_Padic.inexact_zero(x.p, 0))
        return self._parent._element(_Padic(x.p, 0, x.u, x.r))

    def precision_absolute(self):
        """The absolute precision (+Infinity for the exact zero).

        EXAMPLES::

            sage: Zp(5, 6)(75).precision_absolute(), Zp(5)(0).precision_absolute()
            (8, +Infinity)
        """
        a = self._x.absprec()
        return _sa().infinity if a is None else a

    def precision_relative(self):
        """The relative precision.

        EXAMPLES::

            sage: Zp(5, 6)(75).precision_relative(), Zp(5, 6)(0, 3).precision_relative()
            (6, 0)
        """
        return self._x.r or 0

    def lift(self):
        """The integer (rational, for negative valuation) p^v u.

        EXAMPLES::

            sage: Zp(5, 6)(-1).lift(), Qp(5, 6)(2/5).lift()
            (15624, 2/5)
        """
        x = self._x
        if x.is_zero() and x.v is not None and x.v < 0:
            return self
        lf = x.lift()
        return _sa().QQ(lf) if isinstance(lf, _F) else _sa().Integer(lf)

    def _integer_(self, Z=None):
        x = self._x
        if not x.is_zero() and x.v < 0:
            raise ValueError("negative valuation")
        return _sa().Integer(x.lift())

    def _rational_(self):
        return _sa().QQ(_F(self._x.lift()))

    def rational_reconstruction(self):
        """A rational with small numerator and denominator congruent to self
        modulo p^(absolute precision).

        EXAMPLES::

            sage: Zp(5, 6)(1/3).rational_reconstruction(), Qp(5, 6)(2/5).rational_reconstruction()
            (1/3, 2/5)
        """
        x = self._x
        if x.is_zero():
            return _sa().QQ(0)
        m = x.p ** x.r
        a = _ratrec(x.u, m)
        if a is None:
            raise ArithmeticError("rational reconstruction of %s (mod %s) does not exist" % (x.u, m))
        return _sa().QQ(a * _F(x.p) ** x.v)

    def residue(self, absprec=1):
        """self modulo p^absprec, in GF(p) or Integers(p^absprec).

        EXAMPLES::

            sage: Zp(5, 6)(-1).residue(), Zp(5, 6)(-1).residue(2)
            (4, 24)
        """
        k = int(absprec)
        r = self._x.residue(k)
        if k == 1:
            return _sa().GF(self._parent._p)(r)
        return _sa().Integers(self._parent._p ** k)(r)

    def expansion(self, n=None):
        """The p-adic digits, from p^v on (an iterable), or the coefficient
        of p^n.

        EXAMPLES::

            sage: list(Zp(5, 6)(23).expansion()), Zp(5, 6)(23).expansion(1)
            ([3, 4, 0, 0, 0, 0], 4)
        """
        ds = self._x.digits()
        if n is not None:
            n = int(n)
            for e, d in ds:
                if e == n:
                    return _sa().Integer(d)
            a = self._x.absprec()
            if a is not None and n >= a:
                raise PrecisionError("the element is not known to that precision")
            return _sa().Integer(0)
        return [_sa().Integer(d) for _, d in ds]

    def is_zero(self, absprec=None):
        """Whether self is zero (to its precision, or modulo p^absprec).

        EXAMPLES::

            sage: O(5^2).is_zero(), Zp(5)(5).is_zero(), Zp(5)(5).is_zero(1)
            (True, False, True)
        """
        x = self._x
        if absprec is None:
            return x.is_zero()
        return x.is_zero() or x.v >= int(absprec)

    def __bool__(self):
        return not self._x.is_zero()

    def is_unit(self):
        """Whether self is a unit of its parent (valuation 0 in Zp).

        EXAMPLES::

            sage: Zp(5)(2).is_unit(), Zp(5)(5).is_unit(), Qp(5)(5).is_unit()
            (True, False, True)
        """
        x = self._x
        if x.is_zero():
            return False
        return self._parent._field or x.v == 0

    def is_equal_to(self, right, absprec=None):
        """Whether self and right agree modulo p^absprec (default: to the
        smaller precision).

        EXAMPLES::

            sage: Zp(5, 6)(23).is_equal_to(23 + 5^3, 3), Zp(5, 6)(23).is_equal_to(24, 1)
            (True, False)
        """
        d = (self - right)._x
        if absprec is None:
            return d.is_zero()
        return d.is_exact_zero() or d.v >= int(absprec)

    def add_bigoh(self, absprec):
        """self + O(p^absprec).

        EXAMPLES::

            sage: Zp(5, 6)(23).add_bigoh(2)
            3 + 4*5 + O(5^2)
        """
        n = int(absprec)
        P = self._parent
        if n < 0 and not P._field:
            P = P.fraction_field()
        return P._element(self._x.add_bigoh(n))

    def lift_to_precision(self, absprec=None):
        """self, lifted (with digits 0) to absolute precision absprec
        (default: the cap's).

        EXAMPLES::

            sage: Zp(5, 6)(2, 3).lift_to_precision(5), Zp(5, 6)(2, 3).lift_to_precision()
            (2 + O(5^5), 2 + O(5^6))
        """
        x, P = self._x, self._parent
        if x.is_exact_zero():
            return self
        v = x.v
        if absprec is None:
            n = (v + P._prec) if not x.is_zero() else P._prec
        else:
            n = int(absprec)
            if not x.is_zero() and n - v > P._prec:
                raise PrecisionError("precision higher than allowed by the precision cap")
        if n <= x.absprec():
            return self
        if x.is_zero():
            return P._element(_Padic.inexact_zero(x.p, n))
        return P._element(_Padic(x.p, v, x.u, n - v))

    def multiplicative_order(self):
        """The order of self in the unit group (+Infinity unless a root of
        unity to its precision).

        EXAMPLES::

            sage: Zp(5, 6)(2).multiplicative_order(), Zp(5, 6).teichmuller(2).multiplicative_order()
            (+Infinity, 4)
        """
        x = self._x
        if x.is_zero() or x.v != 0:
            return _sa().infinity
        p, m = x.p, x.p ** x.r
        cands = [1, 2] if p == 2 else [d for d in range(1, p) if (p - 1) % d == 0]
        for d in cands:
            if pow(x.u, d, m) == 1 % m:
                return _sa().Integer(d)
        return _sa().infinity

    def norm(self):
        """self (Q_p over itself).

        EXAMPLES::

            sage: Zp(5, 6)(23).norm()
            3 + 4*5 + O(5^6)
        """
        return self

    trace = norm

    def abs(self, prec=None):
        """The p-adic absolute value p^-v (a rational; a real of prec bits
        if prec is given).

        EXAMPLES::

            sage: Zp(5, 6)(75).abs(), Qp(5, 6)(2/5).abs()
            (1/25, 5)
        """
        x = self._x
        if x.is_zero():
            return _sa().QQ(0)
        a = _sa().QQ(_F(x.p) ** -x.v)
        if prec is None:
            return a
        return _sa().RealField(int(prec))(a)

    def inverse_of_unit(self):
        """1/self, in the same ring (for a unit).

        EXAMPLES::

            sage: Zp(5, 6)(2).inverse_of_unit()
            3 + 2*5 + 2*5^2 + 2*5^3 + 2*5^4 + 2*5^5 + O(5^6)
        """
        x = self._x
        if x.is_zero() or (x.v != 0 and not self._parent._field):
            raise ValueError("element must be a unit")
        return self._parent._element(x.inverse(self._parent._prec))

    # ---------------------------------------------------------- arithmetic
    def _coerce(self, b):
        """(parent, self's value, b's value) or None."""
        P = self._parent
        if isinstance(b, pAdicCappedRelativeElement):
            if b._parent._p != P._p:
                raise TypeError("unsupported operand parent(s): '%r' and '%r'" % (P, b._parent))
            return _pushout(P, b._parent), self._x, b._x
        if isinstance(b, bool) or isinstance(b, int):
            if b == 0:
                return P, self._x, _Padic.exact_zero(P._p)
            return P, self._x, _Padic.from_rational(P._p, b, P._prec)
        if isinstance(b, _F):
            Q = P if (P._field or b.denominator % P._p != 0) else P.fraction_field()
            if b == 0:
                return Q, self._x, _Padic.exact_zero(P._p)
            return Q, self._x, _Padic.from_rational(P._p, b, Q._prec)
        if type(b).__name__.startswith("IntegerMod"):
            return P, self._x, P(b)._x
        return None

    def _ring_for(self, P, x):
        """P, or its fraction field when x has negative valuation."""
        if not P._field and not x.is_zero() and x.v < 0:
            return P.fraction_field()
        return P

    def _make(self, P, x):
        return self._ring_for(P, x)._element(x)

    def __add__(self, b):
        t = self._coerce(b)
        if t is None:
            return NotImplemented
        P, x, y = t
        return self._make(P, x.add(y, P._prec))

    __radd__ = __add__

    def __sub__(self, b):
        t = self._coerce(b)
        if t is None:
            return NotImplemented
        P, x, y = t
        return self._make(P, x.sub(y, P._prec))

    def __rsub__(self, b):
        t = self._coerce(b)
        if t is None:
            return NotImplemented
        P, x, y = t
        return self._make(P, y.sub(x, P._prec))

    def __mul__(self, b):
        t = self._coerce(b)
        if t is None:
            return NotImplemented
        P, x, y = t
        return self._make(P, x.mul(y, P._prec))

    __rmul__ = __mul__

    def __truediv__(self, b):
        t = self._coerce(b)
        if t is None:
            return NotImplemented
        P, x, y = t
        return P.fraction_field()._element(x.div(y, P._prec))

    def __rtruediv__(self, b):
        t = self._coerce(b)
        if t is None:
            return NotImplemented
        P, x, y = t
        return P.fraction_field()._element(y.div(x, P._prec))

    def __neg__(self):
        return self._parent._element(self._x.neg())

    def __pos__(self):
        return self

    def __pow__(self, n, mod=None):
        if isinstance(n, _F):
            if n.denominator != 1:
                raise NotImplementedError("fractional powers of p-adic numbers are not available in sagebrush yet")
            n = n.numerator
        if isinstance(n, pAdicCappedRelativeElement):
            raise NotImplementedError("p-adic exponents are not available in sagebrush yet")
        n = int(n)
        P = self._parent
        y = self._x.pow(n, P._prec)
        return (P.fraction_field() if n < 0 else P)._element(y)

    def __mod__(self, m):
        # (Sage: the residue modulo p^v(m), as an element)
        return self._parent(self._x.residue(self._modulus_valuation(m)))

    def __floordiv__(self, m):
        return self._parent((self - (self % m)) / self._parent(m))

    def _modulus_valuation(self, m):
        y = self._parent(m)._x
        if y.is_zero():
            raise ZeroDivisionError("cannot divide by zero")
        return y.v

    def __eq__(self, b):
        try:
            t = self._coerce(b)
        except TypeError:
            return False
        if t is None:
            return NotImplemented
        return t[1].eq(t[2])

    def __ne__(self, b):
        r = self.__eq__(b)
        return r if r is NotImplemented else not r

    def _cmp_pair(self, b):
        t = self._coerce(b)
        if t is None:
            return None
        return t[1].cmp_key(), t[2].cmp_key()

    def __lt__(self, b):
        k = self._cmp_pair(b)
        return NotImplemented if k is None else (not self == b and k[0] < k[1])

    def __le__(self, b):
        k = self._cmp_pair(b)
        return NotImplemented if k is None else (self == b or k[0] < k[1])

    def __gt__(self, b):
        k = self._cmp_pair(b)
        return NotImplemented if k is None else (not self == b and k[0] > k[1])

    def __ge__(self, b):
        k = self._cmp_pair(b)
        return NotImplemented if k is None else (self == b or k[0] > k[1])

    def __hash__(self):
        return hash(self._x.lift())

    # ------------------------------------------------------- functions
    def log(self, p_branch=None, branch=None, aw=False, change_frac=False):
        """The p-adic logarithm (Iwasawa's for p_branch = 0): known to the
        relative precision of the unit part, as an absolute precision.

        EXAMPLES::

            sage: Zp(5, 6)(2).log()
            2*5 + 3*5^2 + 2*5^3 + 4*5^4 + O(5^6)
            sage: Zp(5, 6)(10).log(p_branch=5)
            3*5 + 3*5^2 + 2*5^3 + 4*5^4 + O(5^6)
            sage: Zp(2, 10)(3).log()
            2^2 + 2^4 + 2^5 + 2^6 + 2^7 + O(2^10)
        """
        if branch is not None and p_branch is None:
            p_branch = branch
        P = self._parent
        pb = None if p_branch is None else P.fraction_field()(p_branch)._x
        y = self._x.log(P._prec, pb)
        return self._make(P, y)

    def exp(self, aw=False, algorithm=None):
        """The p-adic exponential (for valuation >= 1, >= 2 if p = 2), to
        the absolute precision of self.

        EXAMPLES::

            sage: Zp(5, 6)(5).exp()
            1 + 5 + 3*5^2 + 3*5^3 + 4*5^4 + 5^5 + O(5^6)
            sage: Zp(5, 6)(2).log().exp()
            1 + 2*5 + 2*5^3 + 3*5^4 + O(5^6)
        """
        P = self._parent
        return self._make(P, self._x.exp(P._prec))

    def square_root(self, extend=True, all=False, algorithm=None):
        """The square root whose reduction is below p/2 (for p = 2,
        congruent to 1 mod 4), as Sage chooses; all=True gives both.

        EXAMPLES::

            sage: Zp(5, 6)(-1).sqrt()
            2 + 5 + 2*5^2 + 5^3 + 3*5^4 + 4*5^5 + O(5^6)
            sage: Zp(5, 6)(4).sqrt(all=True)
            [2 + O(5^6), 3 + 4*5 + 4*5^2 + 4*5^3 + 4*5^4 + 4*5^5 + O(5^6)]
            sage: Zp(5, 6)(3).sqrt(extend=False)
            Traceback (most recent call last):
            ...
            ValueError: element is not a square
        """
        P = self._parent
        try:
            y = self._x.sqrt(P._prec)
        except NotASquare:
            if extend:
                raise NotImplementedError("extending using the sqrt function not yet implemented")
            if all:
                return []
            raise ValueError("element is not a square")
        r = P._element(y)
        if all:
            return [r, -r] if not y.is_zero() else [r]
        return r

    sqrt = square_root

    def is_square(self):
        """Whether self is a square (PrecisionError when the precision
        cannot decide).

        EXAMPLES::

            sage: Zp(5, 6)(25).is_square(), Zp(5, 6)(5).is_square(), Zp(2, 10)(17).is_square()
            (True, False, True)
        """
        return self._x.is_square()


def _centered(u, m):
    return u - m if u > m // 2 else u


def _bigoh_str(p, n, latex=False):
    if latex:
        return "O(%d^{%d})" % (p, n)
    return "O(%d)" % p if n == 1 else "O(%d^%d)" % (p, n)


def _term_str(d, p, e, latex=False):
    """d p^e for a digit d >= 1."""
    if e == 0:
        return str(d)
    if latex:
        pe = str(p) if e == 1 else "%d^{%d}" % (p, e)
        return pe if d == 1 else "%d \\cdot %s" % (d, pe)
    pe = str(p) if e == 1 else "%d^%d" % (p, e)
    return pe if d == 1 else "%d*%s" % (d, pe)


def _digits_str(x, mode):
    """Sage's 'digits' and 'bars' modes: '...' then the digits of p^k from
    k = max(A - 1, 0) down to min(v, 0) (A the absolute precision), '?'
    where k >= A, a point before p^-1."""
    p = x.p
    if mode == "digits" and p > 10:
        raise NotImplementedError("print_mode='digits' for p > 10 is not available in sagebrush yet")
    A = x.absprec()
    v = A if x.is_zero() else x.v
    dig = dict(x.digits())
    out = []
    for k in range(max(A - 1, 0), min(v, 0) - 1, -1):
        if k == -1:
            out.append(".")
        out.append("?" if k >= A else str(dig.get(k, 0)))
    if mode == "digits":
        return "..." + "".join(out)
    return "..." + "|".join(out)


def _ratrec(a, m):
    """n/d = a mod m with |n|, d <= sqrt(m/2), or None."""
    import math
    bound = math.isqrt(m // 2)
    r0, r1, s0, s1 = m, a % m, 0, 1
    while r1 > bound:
        q = r0 // r1
        r0, r1 = r1, r0 - q * r1
        s0, s1 = s1, s0 - q * s1
    if s1 == 0 or abs(s1) > bound:
        return None
    return _F(r1, s1)
