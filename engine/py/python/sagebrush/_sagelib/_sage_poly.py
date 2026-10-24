"""Univariate polynomials over ZZ and QQ, as in Sage: PolynomialRing(ZZ, 'x'),
ZZ['x'], R.<x> = QQ[]; arithmetic, evaluation, gcd, resultants, roots and
factorization (sagebrush.poly: the Rust engine's Zassenhaus factoring),
printed as Sage prints them.  Dense, coefficients constant term first."""

from fractions import Fraction as _F
import re as _re


def _sa():
    import sage_all
    return sage_all


def _norm(c):
    """A coefficient as an int when integral, else a Sage Rational."""
    if isinstance(c, int):
        return int(c)
    f = _F(c)
    if f.denominator == 1:
        return _sa().Integer(f.numerator)
    return _sa().Rational._from_coprime_ints(f.numerator, f.denominator)


def _qq_coeff(a):
    """a as an element of QQ when it is an integer: an integral coefficient
    of a QQ polynomial is stored as an int (_norm), but Sage hands it out
    with parent QQ."""
    # (Rational's own constructor: QQ(a) parses its argument, 15 times slower)
    return _sa().Rational._from_coprime_ints(a, 1) if isinstance(a, int) and not isinstance(a, bool) else a


def _poly_repr(coeffs, name):
    # Sage's Polynomial._repr for atomic coefficients (_sage_modular has the general one)
    from _sage_modular import _poly_repr as r
    return r(coeffs, name)


# Greek letters with a LaTeX command (Sage leaves Alpha, omicron, varpi, ...
# alone), and two symbols
_LATEX_LETTERS = frozenset(
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon "
    "phi chi psi omega varphi Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega ast star".split())


def _latex_variable_name(x, is_fname=False):
    """A variable name in LaTeX, by Sage's documented rules
    (sage.misc.latex.latex_variable_name; its output served as the oracle):
    a single letter stays; a Greek letter gets its command; any other
    longer name is \\mathit{...} ({\\rm ...} for a function name); an
    underscore starts a subscript, recursively, and otherwise trailing
    digits are the subscript.

    EXAMPLES::

        sage: from _sage_poly import _latex_variable_name as L  # sagebrush only
        sage: [L(n) for n in ['a12', 'alpha', 'theta_1', 'x_y_z', 'abc', 'Omega84', 'Alpha']]  # sagebrush only
        ['a_{12}', '\\alpha', '\\theta_{1}', 'x_{y_{z}}', '\\mathit{abc}', '\\Omega_{84}', '\\mathit{Alpha}']
    """
    def atom(t):
        if t in _LATEX_LETTERS:
            return "\\" + t
        if len(t) <= 1:
            return t
        return ("{\\rm %s}" if is_fname else "\\mathit{%s}") % t

    x = str(x)
    if "_" in x:
        head, tail = x.split("_", 1)
        h = atom(head)
        return h if not tail else "%s_{%s}" % (h, _latex_variable_name(tail, is_fname))
    i = len(x)
    while i > 0 and x[i - 1].isdigit():
        i -= 1
    if i == 0 or i == len(x):
        return x if i == 0 else atom(x)
    return "%s_{%s}" % (atom(x[:i]), x[i:])


class _Ring:
    """ZZ and QQ, which also make polynomial rings: ZZ['x']."""

    def __init__(self, name, field):
        self._name = name
        self._field = field

    def __repr__(self):
        return self._name

    def __call__(self, x=0, d=None):
        """Convert x into the ring.

        EXAMPLES::

            sage: ZZ(7), QQ(3/6), QQ('2/3'), ZZ(4/2)
            (7, 1/2, 2/3, 2)
        """
        if isinstance(x, Polynomial):
            if x.degree() > 0:
                raise TypeError("not a constant polynomial")
            x = x[0]
        if self._field:
            return _sa()._QQ(x, d)
        if d is not None:
            raise TypeError("ZZ takes one argument")
        if _sa()._real_kind(x) is not None:
            # (integral, or TypeError: int() truncated ZZ(3.5) to 3)
            return _sa().Integer(_sa()._integral_real(x))
        if hasattr(x, "_integer_") and not isinstance(x, (int, _F)):
            return x._integer_()
        if isinstance(x, _F) and x.denominator != 1:
            raise TypeError("no conversion of this rational to integer")
        return _sa().Integer(x)

    def __getitem__(self, names):
        """QQ['x'] (a polynomial ring), QQ[['x']] (power series), and QQ[a]
        for an algebraic number a: the number field it generates, as in Sage.

        EXAMPLES::

            sage: QQ[sqrt(2)]
            Number Field in sqrt2 with defining polynomial x^2 - 2 with sqrt2 = 1.414213562373095?
            sage: L.<a> = QQ[sqrt(2 - sqrt(3))]; L, a^4 - 4*a^2 + 1
            (Number Field in a with defining polynomial x^4 - 4*x^2 + 1 with a = 0.5176380902050415?, 0)
            sage: QQ[pi]
            Univariate Polynomial Ring in pi over Rational Field
        """
        if isinstance(names, list):
            # QQ[['x']]: power series
            import _sage_series
            return _sage_series.PowerSeriesRing(self, names[0] if names else "x")
        K = _algebraic_extension(self, names)
        if K is not None:
            return K
        return PolynomialRing(self, names)

    def _latex_(self):
        return "\\Bold{Q}" if self._field else "\\Bold{Z}"

    def __iter__(self):
        """The elements, in Sage's order: ZZ as 0, 1, -1, 2, -2, ...; QQ by
        height max(|p|, q), and within height h, a/h then h/a for each a < h
        prime to h, each followed by its negative.  (Without this, Python
        iterated ZZ through __getitem__: ZZ[0], ZZ[1], ... polynomial rings.)

        EXAMPLES::

            sage: W = iter(ZZ); [next(W) for _ in range(5)]
            [0, 1, -1, 2, -2]
            sage: Q = iter(QQ); [next(Q) for _ in range(11)]
            [0, 1, -1, 1/2, -1/2, 2, -2, 1/3, -1/3, 3, -3]
        """
        import math
        yield _sa().Integer(0) if not self._field else _sa().Rational(0)
        h = 1
        while True:
            if not self._field:
                yield _sa().Integer(h)
                yield _sa().Integer(-h)
            else:
                for a in range(1, h + 1):
                    if math.gcd(a, h) != 1 or (a == h and h > 1):
                        continue
                    for r in ((_F(a, h), _F(h, a)) if a < h else (_F(1),)):
                        yield _sa().Rational(r)
                        yield _sa().Rational(-r)
            h += 1

    def __contains__(self, x):
        try:
            return self._field and _F(x) is not None or (not self._field and _F(x).denominator == 1)
        except Exception:
            return False

    def is_field(self):
        """Whether the ring is a field.

        EXAMPLES::

            sage: ZZ.is_field(), QQ.is_field()
            (False, True)
        """
        return self._field

    def fraction_field(self):
        """The fraction field.

        EXAMPLES::

            sage: ZZ.fraction_field()
            Rational Field
        """
        return QQ

    def characteristic(self):
        """The characteristic.

        EXAMPLES::

            sage: ZZ.characteristic(), QQ.characteristic()
            (0, 0)
        """
        return 0

    def __pow__(self, n):
        """QQ^n: the vector space of dimension n.

        EXAMPLES::

            sage: QQ^3
            Vector space of dimension 3 over Rational Field
        """
        return _sa().VectorSpace(self, n)

    def random_element(self, x=None, y=None, distribution=None):
        """A random element: ZZ.random_element(n) is uniform in [0, n),
        ZZ.random_element(a, b) uniform in [a, b); QQ.random_element(): a
        quotient of small random integers.

        EXAMPLES::

            sage: 0 <= ZZ.random_element(10) < 10
            True
            sage: -5 <= ZZ.random_element(-5, 5) < 5
            True
        """
        import random as _r
        if self._field:
            n = x if x is not None else 2
            num = _r.randint(-int(n), int(n))
            den = _r.randint(1, int(n))
            return _sa()._QQ(num, den)
        if x is None:
            # Sage's default: most often small, |n| with probability ~ 1/|n|
            k = _r.choice([-2, -1, 0, 1, 2]) if _r.random() < 0.5 else int(_r.expovariate(0.1)) * _r.choice([-1, 1])
            return _sa().Integer(k)
        if y is None:
            x, y = 0, x
        return _sa().Integer(_r.randrange(int(x), int(y)))


class IntegerRing_class(_Ring):
    """The ring of integers, ZZ: exact integers of any size.

    ZZ(x) makes an integer from an int, a string, or an integral rational
    or real number (ZZ(2.5) is a TypeError); ZZ['t'] (or R.<t> = ZZ[]) is
    the polynomial ring over the integers.  Dividing two integers gives a
    rational number, in QQ.

    EXAMPLES::

        sage: ZZ
        Integer Ring
        sage: ZZ(7) + ZZ('5'), ZZ(4/2), ZZ(10) / ZZ(4)
        (12, 2, 5/2)
        sage: 5 in ZZ, 1/2 in ZZ, ZZ.is_field(), ZZ.characteristic()
        (True, False, False, 0)
        sage: R.<t> = ZZ[]; (t + 1)^2
        t^2 + 2*t + 1
        sage: ZZ(2)^100
        1267650600228229401496703205376
        sage: ZZ(4.0)
        4
    """

    def __reduce__(self):
        # (one ZZ: a pickle or a copy of it is ZZ itself, as in Sage)
        return "ZZ"


ZZ = IntegerRing_class("Integer Ring", False)
# The largest degree QQ[a] builds: the number field and every qqbar step on
# the way (daybreak2's HARD-EC1-1; degree 16 takes 0.2 s, 32 took 8 s).
_QQ_ALGEBRAIC_MAX_DEGREE = 16


def _degree_bound(e):
    """An upper bound for the degree of a constant symbolic expression over
    QQ, from its tree (a product of the operands' bounds; a power with
    exponent p/q multiplies by q; I is 2), or None when a node is not of
    those kinds (QQbar decides then, under its own cap)."""
    from fractions import Fraction
    import _sage_expr
    stack, total = [e], 1
    while stack:
        x = stack.pop()
        try:
            r = Fraction(QQ(x))
            continue
        except (TypeError, ValueError, ArithmeticError, NotImplementedError):
            pass
        s = str(x)
        if s == "I":
            total *= 2
            continue
        op = x.operator()
        if op is None:
            return None
        import operator as o
        args = x.operands()
        if op is o.pow and len(args) == 2:
            try:
                q = Fraction(QQ(args[1]))
            except (TypeError, ValueError, ArithmeticError, NotImplementedError):
                return None
            total *= q.denominator
            stack.append(args[0])
        elif op in (o.add, o.mul):
            stack.extend(args)
        else:
            return None
        if total > 1 << 20:
            break
    return total


def _algebraic_extension(R, gens):
    """R[a] for a constant symbolic algebraic number a: for R = QQ the
    number field of a's minimal polynomial, embedded at a (the generator is
    named after a, as Sage does: sqrt(2) gives sqrt2, I gives I, anything else
    a). None when gens are names or symbols (a polynomial ring); a
    transcendental constant (pi) is also a polynomial ring, as in Sage. (A
    polynomial ring "in sqrt(2)" made sqrt(2)^2 a polynomial: the sagebook,
    p. 211.)"""
    import _sage_expr
    import _sage_qqbar
    if isinstance(gens, int) and not isinstance(gens, bool):
        # QQ[2] and QQ[sqrt(4)] (an Integer): a number is not a name, as Sage
        raise ValueError("variable name %r does not start with a letter" % str(gens))
    gs = gens if isinstance(gens, tuple) else (gens,)
    cs = [g for g in gs if (isinstance(g, _sage_expr.Expression) and not g.variables())
          or isinstance(g, (_F, _sage_qqbar.AlgebraicNumber))]
    if not cs:
        return None
    bound = _degree_bound(cs[0]) if isinstance(cs[0], _sage_expr.Expression) else None
    if bound is not None and bound > _QQ_ALGEBRAIC_MAX_DEGREE:
        raise NotImplementedError("QQ[%s]: a number field of degree up to %d (more than %d) is not available in sagebrush yet" % (cs[0], bound, _QQ_ALGEBRAIC_MAX_DEGREE))
    old_cap = _sage_qqbar._degree_cap
    _sage_qqbar._degree_cap = _QQ_ALGEBRAIC_MAX_DEGREE
    try:
        a = _sage_qqbar.QQbar(cs[0])
    except NotImplementedError as e:
        if "more than %d" % _QQ_ALGEBRAIC_MAX_DEGREE in str(e):
            raise NotImplementedError("QQ[%s]: %s" % (cs[0], e)) from None
        a = None
    except (TypeError, ValueError, ArithmeticError):
        a = None
    finally:
        _sage_qqbar._degree_cap = old_cap
    if a is None:
        if str(cs[0]).isidentifier():
            return None  # QQ[pi]: a polynomial ring in the name, as Sage
        # Sage makes QQ[sin(pi/7)] a number field (it is algebraic) and
        # refuses QQ[log(2)] (not a name); sagebrush tells neither apart
        # here, so it refuses both (a polynomial ring "in sin(1/7*pi)" was
        # a wrong answer: astra's report on ec120478)
        raise NotImplementedError("QQ[%s]: %s is not recognised as an algebraic number in sagebrush, and is not a variable name" % (cs[0], cs[0])) from None
    if len(gs) > 1:
        raise NotImplementedError("%s[%s]: relative number fields are not available in sagebrush yet" % ("QQ" if R._field else "ZZ", ", ".join(map(str, gs))))
    if not R._field:
        raise NotImplementedError("ZZ[%s]: orders of number fields are not available in sagebrush yet" % (cs[0],))
    f = a.minpoly()
    if f.degree() > _QQ_ALGEBRAIC_MAX_DEGREE:
        # (a QQbar element given directly: its field is not built)
        raise NotImplementedError("QQ[%s]: a number field of degree %d (more than %d) is not available in sagebrush yet" % (cs[0], f.degree(), _QQ_ALGEBRAIC_MAX_DEGREE))
    if f.degree() == 1:
        # Sage: the number field x - r (QQ[2/3], QQ[SR(2)], QQ[QQbar(2)])
        raise NotImplementedError("QQ[%s]: number fields of degree 1 are not available in sagebrush yet" % (cs[0],))
    name = str(cs[0]).replace("(", "").replace(")", "")
    if not isinstance(cs[0], _sage_expr.Expression) or not name.isidentifier():
        name = "a"
    import _sage_nf
    try:
        emb = repr(_sage_qqbar.AA(a)) if a._is_real() else repr(a)
        if emb in ("I", "-I"):
            emb = emb[:-1] + "1*I"  # (as Sage prints the embeddings of QQ[I], QQ[-I])
        return _sage_nf._unique(_sage_nf.NumberField_absolute(f, name, emb))
    except (TypeError, ValueError, NotImplementedError) as e:
        # (e.g. a minimal polynomial with non-integral coefficients, as for
        # cos(2*pi/5): Sage's field is defined by x^2 + 1/2*x - 1/4)
        raise NotImplementedError("QQ[%s]: the number field of %s is not available in sagebrush yet (%s)" % (cs[0], f, e)) from None


class RationalField(_Ring):
    """The field of rational numbers, QQ: exact fractions, always in lowest terms.

    QQ(x) makes a rational from an integer, a fraction, a string such as
    '2/3' or a real number: the simplest rational that rounds to it (the
    smallest denominator), as Sage converts it, so QQ(0.1) is 1/10; an
    integral real number is that integer.  x.exact_rational() is a real
    number's exact binary value.  QQ['t'] is the polynomial ring over the
    rationals.

    EXAMPLES::

        sage: QQ
        Rational Field
        sage: QQ(3/6), QQ('2/3') + 1, QQ(0.75)
        (1/2, 5/3, 3/4)
        sage: 1/2 in QQ, QQ.is_field(), QQ.characteristic()
        (True, True, 0)
        sage: R.<t> = QQ[]; (t^2 - 1/4).factor()
        (t - 1/2) * (t + 1/2)
        sage: QQ(0.1), QQ(float(1/3)), QQ(float(1e-20)), RR(0.1).exact_rational()
        (1/10, 1/3, 1/99999999999999997962, 3602879701896397/36028797018963968)

    A decimal literal not yet used in arithmetic converts as in Sage: from
    the interval around its decimal value rounded to one more bit, so
    QQ(1e-20) differs from QQ(1e-20 + 0.0).  A literal of more than 15
    significant digits has more bits, as in Sage (1.2345678901234567: 57),
    and converts from its own precision; QQ('1.2345678901234567') is its
    exact value.

        sage: QQ(1e-20), QQ(1e-20 + 0.0)
        (1/99999999999999990439, 1/99999999999999997962)
    """

    def __reduce__(self):
        # (one QQ: a pickle or a copy of it is QQ itself, as in Sage)
        return "QQ"


QQ = RationalField("Rational Field", True)


def _derivative_count(args, gen, name):
    """How many derivatives f.derivative(*args) asks for, in the generator
    gen named name: x, 2 is two, x, 0 none, 2 alone two (the second review's
    R2-POL-F2: the variable and the orders were discarded)."""
    if not args:
        return 1
    k = 0
    seen = False
    for idx, a in enumerate(args):
        if isinstance(a, int) and not isinstance(a, bool):
            if a < 0:
                raise ValueError("derivative counts must be nonnegative")
            if seen:
                k += a - 1
            elif idx == 0:
                k += a  # derivative(2): the generator twice
            elif a:
                # a count with no variable just before it (x, 2, 3), as Sage
                raise ValueError("a derivative count must follow a variable")
            seen = False
        elif a is None or (isinstance(a, str) and a == name) or (not isinstance(a, str) and (a == gen or repr(a) == name)):
            k += 1
            seen = True
        else:
            raise ValueError("cannot differentiate with respect to %r" % (a,))
    return k


class PolynomialRing_:
    """Univariate Polynomial Ring in x over ZZ or QQ.

    EXAMPLES::

        sage: R = PolynomialRing(ZZ, 'x'); R
        Univariate Polynomial Ring in x over Integer Ring
    """

    def __init__(self, base, name):
        self._base = base
        self._name = name

    def __repr__(self):
        if self._name == "$.1":
            return "Univariate Polynomial Ring over %r" % (self._base,)
        return "Univariate Polynomial Ring in %s over %r" % (self._name, self._base)

    def _latex_(self):
        """LaTeX, as Sage writes it.

        EXAMPLES::

            sage: latex(QQ['alpha']), latex(ZZ['y_2'])
            (\\Bold{Q}[\\alpha], \\Bold{Z}[y_{2}])
        """
        return "\\Bold{%s}[%s]" % ("Q" if self._base is QQ else "Z", _latex_variable_name(self._name))

    def __eq__(self, other):
        return isinstance(other, PolynomialRing_) and other._base is self._base and other._name == self._name

    def __hash__(self):
        return hash((self._name, self._base._name))

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: PolynomialRing(ZZ, 'x').base_ring()
            Integer Ring
        """
        return self._base

    def change_ring(self, R):
        """The polynomial ring over R in the same variable.

        EXAMPLES::

            sage: PolynomialRing(ZZ, 'x').change_ring(GF(5))
            Univariate Polynomial Ring in x over Finite Field of size 5
        """
        return _sa().PolynomialRing(R, self._name)

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').variable_name()
            't'
        """
        return self._name

    def variable_names(self):
        """The names of the variables (a 1-tuple).

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').variable_names()
            ('t',)
        """
        return (self._name,)

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').gen()
            t
        """
        if i != 0:
            raise IndexError("generator not defined")
        return Polynomial(self, [0, 1])

    def gens(self):
        """The variables (a 1-tuple).

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').gens()
            (t,)
        """
        return (self.gen(),)

    def ngens(self):
        """The number of variables: 1.

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').ngens()
            1
        """
        return 1

    def _first_ngens(self, n):
        return self.gens()[:n]

    def __call__(self, x=0):
        """Convert a list of coefficients (constant first), a number or a polynomial into the ring.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: R([1, 2, 3]), R(5), R(x^2 + 1)
            (3*x^2 + 2*x + 1, 5, x^2 + 1)
            sage: ZZ['x'](PolynomialRing(ZZ, 2, 'x,y')({(2000000, 0): 1}))  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: a polynomial of degree 2000000 exceeds sagebrush's limit of 1048576 coefficients for this conversion
        """
        if isinstance(x, Polynomial):
            # (Sage converts between univariate rings by coefficients, so
            # QQ['y'](f) for f in ZZ['x'] maps x to y)
            return Polynomial(self, x._c)
        if type(x).__name__ == "MPolynomial" and hasattr(x, "_ring") and hasattr(x._ring, "_names"):
            # ZZ['x'](x) for x in ZZ['x', 'y']: in the variable of this
            # ring's name, else a constant, as Sage converts
            names = list(x._ring._names)
            k = names.index(self._name) if self._name in names else None
            cs = {}
            for e, c in x._d.items():
                if any(v for i, v in enumerate(e) if i != k):
                    raise TypeError("cannot convert nonconstant polynomial")
                cs[e[k] if k is not None else 0] = x._ring._dom._out(c)
            # the coefficient list is dense: refused past the limit before
            # it is made (one term of degree 2000000 made 2000001
            # coefficients, the review's HARD-0FE-1)
            if cs and max(cs) >= _MAX_DENSE_COEFFS:
                raise NotImplementedError("a polynomial of degree %d exceeds sagebrush's limit of %d coefficients for this conversion" % (max(cs), _MAX_DENSE_COEFFS))
            return Polynomial(self, [cs.get(i, 0) for i in range(max(cs) + 1)] if cs else [])
        if isinstance(x, (list, tuple)):
            return Polynomial(self, list(x))
        if isinstance(x, str):
            import sage_all
            return eval(x.replace("^", "**"), {self._name: self.gen(), "__builtins__": {}})
        return Polynomial(self, [x])

    def is_field(self):
        """False: a polynomial ring is not a field.

        EXAMPLES::

            sage: PolynomialRing(QQ, 'x').is_field()
            False
        """
        return False

    def characteristic(self):
        """The characteristic of the base ring.

        EXAMPLES::

            sage: PolynomialRing(QQ, 'x').characteristic()
            0
        """
        return 0


_RINGS = {}

# The most coefficients a conversion from a sparse polynomial writes densely.
_MAX_DENSE_COEFFS = 1 << 20


def PolynomialRing(base, *args, **kwds):
    """PolynomialRing(ZZ, 'x'), PolynomialRing(QQ, names=('y',)); several
    variables: PolynomialRing(QQ, 'x,y'), PolynomialRing(QQ, 3, 'x'),
    PolynomialRing(QQ, 2, 'xy', order='lex') (see _sage_mpoly).

    EXAMPLES::

        sage: R.<x> = PolynomialRing(QQ); R
        Univariate Polynomial Ring in x over Rational Field
        sage: PolynomialRing(ZZ, 't')
        Univariate Polynomial Ring in t over Integer Ring
        sage: S.<y> = ZZ[]; S
        Univariate Polynomial Ring in y over Integer Ring
        sage: PolynomialRing(QQ, 3, 'x'), PolynomialRing(QQ, 'a,b')
        (Multivariate Polynomial Ring in x0, x1, x2 over Rational Field, Multivariate Polynomial Ring in a, b over Rational Field)
    """
    import _sage_ff
    n = None
    names = kwds.get("names", kwds.get("name"))
    for a in args:
        if isinstance(a, int) and not isinstance(a, bool):
            n = int(a)
        elif type(a).__name__ == "Rational":
            # (PolynomialRing(QQ, 4/2, 'x') was a ring in a variable named 2)
            n = a.__index__()
        elif a is not None and names is None:
            names = a
    order = kwds.get("order")
    if names is None:
        names = "x"
    multi = n is not None or (isinstance(names, (list, tuple)) and len(names) != 1) or (isinstance(names, str) and "," in names)
    if multi:
        import _sage_mpoly
        return _sage_mpoly.MPolynomialRing(base, n, names, order or "degrevlex")
    if isinstance(names, (tuple, list)):
        names = names[0]
    names = str(names).strip()
    if _sage_ff._is_ff_base(base):
        return _sage_ff._poly_ring_from_names(base, names)
    import _sage_nfpoly
    if _sage_nfpoly.is_number_field(base):
        return _sage_nfpoly.PolynomialRing_nf(base, names)
    if type(base).__name__ in ("pAdicRingCappedRelative", "pAdicFieldCappedRelative"):
        import _sage_padic_ext
        return _sage_padic_ext.PolynomialRing_padic(base, names)
    if base is not ZZ and base is not QQ:
        raise NotImplementedError("polynomial rings over %r are not available in sagebrush yet" % (base,))
    key = (base._name, names)
    if key not in _RINGS:
        _RINGS[key] = PolynomialRing_(base, names)
    return _RINGS[key]


def polygen(base=None, name="x"):
    """The variable of the polynomial ring over base (default QQ) in the given name.

    EXAMPLES::

        sage: x = polygen(QQ); x
        x
        sage: y = polygen(ZZ, 'y'); (y + 1)^3
        y^3 + 3*y^2 + 3*y + 1
    """
    return PolynomialRing(base or ZZ, name).gen()


def poly_hash(terms):
    """The hash of the polynomial sum c * prod(v^e) over terms {monomial: c},
    a monomial a sorted tuple of (variable name, exponent > 0): a constant
    hashes as itself; else the set of (monomial, c) pairs.  Shared by
    univariate, multivariate and symbolic polynomials, which compare equal
    across these representations."""
    t = {m: c for m, c in terms.items() if c != 0}
    if not t:
        return hash(0)
    if list(t) == [()]:
        return hash(t[()])
    return hash(frozenset((m, hash(c)) for m, c in t.items()))


class Polynomial:
    """An element of ZZ[x] or QQ[x].

    EXAMPLES::

        sage: R.<x> = QQ[]
        sage: f = x^3 - 2*x + 1/2; f
        x^3 - 2*x + 1/2
        sage: f.degree(), f(2), f.parent()
        (3, 9/2, Univariate Polynomial Ring in x over Rational Field)
    """

    __slots__ = ("_ring", "_c")

    def __init__(self, ring, coeffs):
        c = [_norm(a) for a in coeffs]
        while c and c[-1] == 0:
            c.pop()
        if ring._base is ZZ and any(not isinstance(a, int) for a in c):
            ring = PolynomialRing(QQ, ring._name)
        self._ring = ring
        self._c = c

    # ---- basic data
    def parent(self):
        """The polynomial ring.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x + 1).parent()
            Univariate Polynomial Ring in x over Integer Ring
        """
        return self._ring

    def base_ring(self):
        """The ring of coefficients.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x + 1).base_ring()
            Integer Ring
        """
        return self._ring._base

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: R.<t> = QQ[]
            sage: (t^2).variable_name()
            't'
        """
        return self._ring._name

    def degree(self):
        """The degree (-1 for the zero polynomial).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^5 + 1).degree(), R(3).degree(), R(0).degree()
            (5, 0, -1)
        """
        return len(self._c) - 1

    def list(self):
        """The coefficients, constant term first.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 - 2*x + 1).list()
            [1, -2, 0, 1]

        Over QQ the coefficients are elements of QQ, as in Sage::

            sage: (x + 1).list()[0].parent()
            Rational Field
        """
        if self._ring._base is QQ:
            return [_qq_coeff(a) for a in self._c] if self._c else [QQ(0)]
        return list(self._c) if self._c else [0]

    def _out(self, a):
        """A coefficient as handed out: over QQ an element of QQ (an
        integral one is stored as an int)."""
        return _qq_coeff(a) if self._ring._base is QQ else a

    def dict(self):
        """The nonzero coefficients, by exponent.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^3 - x + 2).dict()
            {0: 2, 1: -1, 3: 3}
        """
        return {i: self._out(a) for i, a in enumerate(self._c) if a != 0}

    def coefficients(self, sparse=True):
        """The nonzero coefficients (sparse=False: all of them), constant term first.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: f = x^4 - 2*x + 1
            sage: f.coefficients(), f.coefficients(sparse=False)
            ([1, -2, 1], [1, -2, 0, 0, 1])
        """
        return [self._out(a) for a in self._c if a != 0] if sparse else self.list()

    def exponents(self):
        """The exponents of the nonzero terms.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^4 - 2*x + 1).exponents()
            [0, 1, 4]
        """
        return [i for i, a in enumerate(self._c) if a != 0]

    def leading_coefficient(self):
        """The leading coefficient.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^2 + 1).leading_coefficient(), (3*x^2 + 1).lc()
            (3, 3)
        """
        return self._out(self._c[-1] if self._c else 0)

    lc = leading_coefficient

    def constant_coefficient(self):
        """The constant term.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^2 + 7).constant_coefficient()
            7
        """
        return self._out(self._c[0] if self._c else 0)

    def __getitem__(self, i):
        return self._out(self._c[i] if 0 <= i < len(self._c) else 0)

    def __len__(self):
        return len(self._c)

    def __iter__(self):
        return iter(self.list())

    def is_zero(self):
        """Whether the polynomial is 0.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: R(0).is_zero(), x.is_zero()
            (True, False)
        """
        return not self._c

    def __bool__(self):
        return bool(self._c)

    def is_monic(self):
        """Whether the leading coefficient is 1.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 + 3).is_monic(), (2*x^2).is_monic()
            (True, False)
        """
        return bool(self._c) and self._c[-1] == 1

    def is_constant(self):
        """Whether the degree is at most 0.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: R(5).is_constant(), x.is_constant()
            (True, False)
        """
        return len(self._c) <= 1

    def __hash__(self):
        # the canonical polynomial hash shared with multivariate and symbolic
        # polynomials, which compare equal (t == SR(t) with different hashes:
        # the second review's R2-API-F1)
        n = self._ring._name
        return poly_hash({((n, i),) if i else (): c for i, c in enumerate(self._c)})

    def __repr__(self):
        return _poly_repr(self._c, self._ring._name) if self._c else "0"

    def _latex_(self):
        # Sage's form: x^{20} - \frac{1}{2} x + 3
        if not self._c:
            return "0"
        v = _latex_variable_name(self._ring._name)
        out = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if c == 0:
                continue
            q = _F(c)
            neg = q < 0
            q = -q if neg else q
            num = str(q.numerator) if q.denominator == 1 else "\\frac{%d}{%d}" % (q.numerator, q.denominator)
            mono = "" if i == 0 else v if i == 1 else "%s^{%d}" % (v, i)
            if not mono:
                t = num
            elif q == 1:
                t = mono
            else:
                # (Sage: 2x over ZZ, but 2 t over QQ)
                t = num + (" " if q.denominator != 1 or self._ring._base is QQ else "") + mono
            out.append(("-" if neg else "+", t))
        s = ("-" if out[0][0] == "-" else "") + out[0][1]
        for sign, t in out[1:]:
            s += " %s %s" % (sign, t)
        return s

    # ---- arithmetic
    def _coerce(self, other):
        if isinstance(other, Polynomial):
            if other._ring._name != self._ring._name:
                raise TypeError("unsupported operation on polynomials in %s and %s" % (self._ring._name, other._ring._name))
            return other
        if isinstance(other, (int, _F)) or type(other).__name__ in ("Rational",):
            return Polynomial(self._ring, [other])
        return None

    def _make(self, coeffs, other=None):
        ring = self._ring
        if other is not None and other._ring._base is QQ:
            ring = other._ring
        return Polynomial(ring, coeffs)

    def __add__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        n = max(len(self._c), len(o._c))
        return self._make([self[i] + o[i] for i in range(n)], o)

    __radd__ = __add__

    def __neg__(self):
        return Polynomial(self._ring, [-a for a in self._c])

    def __pos__(self):
        return self

    def __sub__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        return self + (-o)

    def __rsub__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        return o + (-self)

    def __mul__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        if not self._c or not o._c:
            return self._make([], o)
        if len(self._c) * len(o._c) > 2500:
            # long products in the engine (NTT / Kronecker substitution)
            from sagebrush import poly
            da, ca = self._integral()
            db, cb = o._integral()
            c = poly.mul(ca, cb)
            d = da * db
            return self._make(c if d == 1 else [_F(x, d) for x in c], o)
        r = [0] * (len(self._c) + len(o._c) - 1)
        for i, a in enumerate(self._c):
            if a:
                for j, b in enumerate(o._c):
                    r[i + j] += a * b
        return self._make(r, o)

    __rmul__ = __mul__

    def __xor__(self, other):
        # plain Python (sagebrush.sage under CPython): ^ is xor, with the
        # wrong precedence; the Sage preparser (and pyjs) make it a power
        raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")

    def __pow__(self, n):
        n = int(n)
        if n < 0:
            raise ValueError("negative exponent")
        r, b = Polynomial(self._ring, [1]), self
        while n:
            if n & 1:
                r = r * b
            b = b * b
            n >>= 1
        return r

    def __eq__(self, other):
        try:
            o = self._coerce(other)
        except TypeError:
            # polynomials in different variables are different
            return False
        if o is None:
            return NotImplemented
        return self._c == o._c

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def quo_rem(self, other):
        """(q, r) with self = q other + r, deg r < deg other (over QQ; over ZZ
        the result must be integral).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 + 2*x + 1).quo_rem(x^2 + 1)
            (x, x + 1)
        """
        o = self._coerce(other)
        if o is None or not o._c:
            raise ZeroDivisionError("division by zero polynomial")
        r = [_F(a) for a in self._c]
        d = [_F(a) for a in o._c]
        q = [_F(0)] * max(len(r) - len(d) + 1, 0)
        for i in range(len(q) - 1, -1, -1):
            c = r[i + len(d) - 1] / d[-1]
            q[i] = c
            if c:
                for j, b in enumerate(d):
                    r[i + j] -= c * b
        qq, rr = Polynomial(PolynomialRing(QQ, self._ring._name), q), Polynomial(PolynomialRing(QQ, self._ring._name), r[: len(d) - 1])
        if self._ring._base is ZZ and o._ring._base is ZZ:
            if all(isinstance(a, int) for a in qq._c + rr._c):
                qq, rr = Polynomial(self._ring, qq._c), Polynomial(self._ring, rr._c)
            elif o.leading_coefficient() not in (1, -1):
                raise ArithmeticError("division not exact in Integer Ring (use QQ[x])")
        return qq, rr

    def __floordiv__(self, other):
        if isinstance(other, int) and self._ring._base is ZZ:
            return Polynomial(self._ring, [a // other for a in self._c])
        return self.quo_rem(other)[0]

    def __mod__(self, other):
        if isinstance(other, int) and self._ring._base is ZZ:
            return Polynomial(self._ring, [a % other for a in self._c])
        return self.quo_rem(other)[1]

    def __divmod__(self, other):
        return self.quo_rem(other)

    def __truediv__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        if o.degree() <= 0:
            if not o._c:
                raise ZeroDivisionError("division by zero")
            c = _F(o._c[0])
            return Polynomial(PolynomialRing(QQ, self._ring._name), [_F(a) / c for a in self._c]) if self._ring._base is QQ or c.denominator != 1 or any(_F(a) / c != int(_F(a) / c) for a in self._c) else Polynomial(self._ring, [int(_F(a) / c) for a in self._c])
        q, r = self.quo_rem(o)
        if not r:
            # (Sage returns an element of the fraction field equal to q)
            return q
        import _sage_frac
        a = self if self._ring._base is QQ else Polynomial(PolynomialRing(QQ, self._ring._name), self._c)
        b = o if o._ring._base is QQ else Polynomial(PolynomialRing(QQ, self._ring._name), o._c)
        return _sage_frac.FractionFieldElement(a, b)

    def __rtruediv__(self, other):
        if self.degree() == 0:
            return _F(other) / _F(self._c[0])
        import _sage_frac
        R = self._ring if self._ring._base is QQ else PolynomialRing(QQ, self._ring._name)
        return _sage_frac.FractionFieldElement(R(other), Polynomial(R, self._c))

    # ---- evaluation and calculus
    def __call__(self, *args, **kwds):
        """The value at a point (a number, or another polynomial).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: f = x^2 + 1
            sage: f(3), f(1/2), f(x + 1)
            (10, 5/4, x^2 + 2*x + 2)
        """
        if kwds:
            if set(kwds) != {self._ring._name}:
                raise TypeError("unknown variable")
            v = kwds[self._ring._name]
        else:
            (v,) = args
        r = 0
        for a in reversed(self._c):
            r = r * v + a
        return self._out(_norm(r)) if isinstance(r, (int, _F)) else r

    subs = __call__

    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 + 2*x).derivative(), (x^3).diff()
            (3*x^2 + 2, 3*x^2)
            sage: (x^3).derivative(2), (x^3).derivative(x, 0), (x^3).derivative(x, 2, x)
            (6*x, x^3, 6)
        """
        k = _derivative_count(args, self._ring.gen(), self._ring._name)
        c = list(self._c)
        for _ in range(k):
            if not c:
                break
            c = [i * a for i, a in enumerate(c)][1:]
        return Polynomial(self._ring, c)

    diff = differentiate = derivative

    def integral(self):
        """The antiderivative with constant term 0.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^2 + 1).integral()
            x^3 + x
        """
        return Polynomial(PolynomialRing(QQ, self._ring._name), [0] + [_F(a) / (i + 1) for i, a in enumerate(self._c)])

    def change_ring(self, R):
        """The polynomial with its coefficients converted to the ring R.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^2 + 3*x + 5).change_ring(QQ)
            x^2 + 3*x + 5
        """
        import _sage_ffsub as S
        refuse = lambda: NotImplementedError("change_ring of a polynomial of degree %d to %r is not supported yet (work)" % (self.degree(), R))
        if R is QQ or R is ZZ:
            # (a word each, charged before any coefficient is visited, by the
            # shared core's budget; daybreak2 LIMIT-F3-2)
            S.charge([S.WORK], len(self._c), refuse)
            if R is QQ:
                return PolynomialRing(R, self._ring._name)(self._c)
            if any(int(a.denominator) != 1 for a in self._c):
                raise TypeError("no conversion of this rational to integer")
            return PolynomialRing(R, self._ring._name)([int(a) for a in self._c])
        if isinstance(R, PolynomialRing_):
            return R(self._c)
        import _sage_ff
        if isinstance(R, (_sage_ff.IntegerModRing_, _sage_ff.FiniteField_ext)):
            # (each coefficient reduced, by the shared core: its work, from
            # the coefficients' number and sizes, admitted before any is
            # reduced or copied)
            m = int(R.characteristic())
            fail = lambda c: ZeroDivisionError("inverse of Mod(%d, %d) does not exist" % (int(c.denominator) % m, m))
            cs = S.from_rationals(self._c, R, [S.WORK], refuse, fail)
            return _sage_ff.PolynomialRing_ff(R, self._ring._name)(cs)
        import _sage_nfpoly
        if _sage_nfpoly.is_number_field(R):
            return _sage_nfpoly.PolynomialRing_nf(R, self._ring._name)(self._c)
        if isinstance(R, _sage_nfpoly.PolynomialRing_nf_):
            return R(self._c)
        raise NotImplementedError("change_ring to %r" % (R,))

    def map_coefficients(self, f, new_base_ring=None):
        """The polynomial with f applied to each nonzero coefficient (as
        Sage's: a zero stays zero), over new_base_ring (this base ring when
        None).

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (3*x^2 + 1).map_coefficients(lambda c: c + 1)
            4*x^2 + 2
        """
        # (each coefficient as an element of this ring, as Sage passes it: an
        # integral one of a polynomial over QQ is QQ's, not an int; astra
        # CORR-F3-1)
        B = self._ring._base
        T = B if new_base_ring is None else new_base_ring
        return _sa().PolynomialRing(T, self._ring._name)([T(f(B(c))) if c else T(0) for c in self._c])

    def monic(self):
        """The polynomial divided by its leading coefficient.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (2*x^2 + 3).monic()
            x^2 + 3/2
        """
        lc = _F(self.leading_coefficient())
        return Polynomial(PolynomialRing(QQ, self._ring._name) if lc not in (1,) else self._ring, [_F(a) / lc for a in self._c])

    def content(self):
        """The gcd of the coefficients (over ZZ), as Sage's content().

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (6*x^2 + 4*x + 2).content()
            2
        """
        from math import gcd
        g = 0
        for a in self._c:
            if self._ring._base is ZZ:
                g = gcd(g, a)
        return g if self._ring._base is ZZ else _F(1)

    def _integral(self):
        """(d, the integer coefficients of d * self)."""
        if all(isinstance(a, int) for a in self._c):
            return 1, list(self._c)
        from math import lcm
        d = 1
        for a in self._c:
            d = lcm(d, _F(a).denominator)
        return d, [int(_F(a) * d) for a in self._c]

    def gcd(self, other):
        """The gcd: monic over QQ; over ZZ with positive leading coefficient
        and the gcd of the contents (as Sage).  Modular, in the engine
        (sagebrush.poly.gcd).  Exception, as in Sage: over ZZ, gcd(0, f) and
        gcd(f, 0) are f itself, whatever the sign of its leading coefficient.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 - 1).gcd(x^2 + 2*x + 1)
            x + 1
        """
        o = other if isinstance(other, Polynomial) else Polynomial(PolynomialRing(QQ, self._ring._name), [other])
        over_zz = self._ring._base is ZZ and o._ring._base is ZZ
        if not self._c or not o._c:
            # Sage returns the other one unchanged (monic over QQ)
            a = o if not self._c else self
            if over_zz or not a._c:
                return Polynomial(self._ring if over_zz else a._ring, a._c)
            return a.change_ring(QQ).monic()
        from sagebrush import poly
        da, ca = self._integral()
        db, cb = o._integral()
        g = poly.gcd(ca, cb)
        if over_zz:
            return Polynomial(self._ring, g)
        return Polynomial(PolynomialRing(QQ, self._ring._name), g).monic()

    def lcm(self, other):
        """The least common multiple.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 - 1).lcm(x^2 + 2*x + 1)
            x^3 + x^2 - x - 1
        """
        return (self * other).quo_rem(self.gcd(other))[0]

    def resultant(self, other):
        """The resultant, by the Euclidean algorithm over QQ.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^2 - 2).resultant(x^2 - 3)
            1
        """
        a, b = self.change_ring(QQ), other.change_ring(QQ)
        if not a or not b:
            return 0
        res = _F(1)
        while b.degree() > 0:
            r = a.quo_rem(b)[1]
            if not r:
                return 0
            m, n, k = a.degree(), b.degree(), r.degree()
            res *= (-1) ** (m * n) * _F(b.leading_coefficient()) ** (m - k)
            a, b = b, r
        res *= _F(b.leading_coefficient()) ** a.degree() if b else 0
        return _norm(res)

    def discriminant(self):
        """The discriminant.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^2 + x + 1).discriminant(), (x^3 - 2).discriminant()
            (-3, -108)
        """
        n = self.degree()
        if n < 1:
            raise ValueError("discriminant of a constant")
        r = _F(self.resultant(self.derivative())) / _F(self.leading_coefficient())
        return _norm((-1) ** (n * (n - 1) // 2) * r)

    # ---- factoring
    def factor(self):
        """The factorization into irreducibles, as Sage: over ZZ the content's
        primes and primitive factors with positive leading coefficients; over
        QQ a rational unit and monic factors.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^4 - 1).factor()
            (x - 1) * (x + 1) * (x^2 + 1)
            sage: (2*x^2 - 2).factor()
            2 * (x - 1) * (x + 1)
            sage: (x^6 - 1).factor()
            (x - 1) * (x + 1) * (x^2 - x + 1) * (x^2 + x + 1)
        """
        if not self._c:
            raise ArithmeticError("factorization of 0 is not defined")
        from sagebrush import poly
        sa = _sa()
        if self._ring._base is ZZ:
            content, fs = poly.factor(self._c) if self.degree() > 0 else (self._c[0], [])
            items = [(Polynomial(self._ring, g), e) for g, e in fs]
            unit = 1 if content > 0 else -1
            if self.degree() == 0:
                # the prime factors of a constant are part of the factorization
                # (list(F) and the product of F agree with what it prints)
                # (printed as Sage prints the integer factorization: 2^2 * 3)
                cf = sa.factor(abs(content)) if abs(content) > 1 else None
                return PolyFactorization([(p, e) for p, e in (cf or [])], unit, constant=cf, constant_value=1)
            for p, e in (sa.factor(abs(content)) if abs(content) > 1 else []):
                items.append((p, e))
            return PolyFactorization(items, unit)
        d, c = self._integral()
        content, fs = poly.factor(c) if self.degree() > 0 else (c[0], [])
        items = []
        unit = _F(content) / d
        for g, e in fs:
            lc = g[-1]
            unit *= _F(lc) ** e
            items.append((Polynomial(self._ring, [_F(a) / lc for a in g]), e))
        return PolyFactorization(items, _norm(unit), field=True)

    def is_irreducible(self):
        """Whether the polynomial is irreducible.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 + 1).is_irreducible(), (x^2 - 1).is_irreducible()
            (True, False)
        """
        f = self.factor()
        if self._ring._base is QQ:
            return len(f) == 1 and f[0][1] == 1
        return len(f) == 1 and f[0][1] == 1 and f.unit() in (1, -1)

    def galois_group(self, pari_group=False, algorithm=None, proof=None):
        """The Galois group of this irreducible polynomial over QQ (degree at
        most 13, or 17, 19, 23), as Sage's TransitiveGroup(n, k), computed by Sagebrush's
        engine/galois (Frobenius cycle types, then Stauduhar's descent with
        p-adic roots).  G.proven says whether every step was proven; by
        default the cheap steps are, with proof=True all of them.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 - 2).galois_group()
            Transitive group number 2 of degree 3
            sage: (x^5 - x - 1).galois_group()
            Transitive group number 5 of degree 5
            sage: (x^4 + 1).galois_group().order()
            4
        """
        d, c = self._integral()
        from sage_permgroup import galois_group
        return galois_group(c, proof=proof)

    def is_squarefree(self):
        """Whether the polynomial has no repeated factor.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 - 1).is_squarefree(), ((x - 1)^2).is_squarefree()
            (True, False)
            sage: S.<y> = ZZ[]
            sage: (4*y).is_squarefree(), S(4).is_squarefree(), (6*y).is_squarefree(), (4*x).is_squarefree()
            (False, False, True, True)
        """
        if self == 0:
            # (as Sage: over a field the zero polynomial is squarefree, over
            # ZZ it is not)
            base = self._ring._base
            return base is not ZZ and bool(getattr(base, "is_field", lambda: False)())
        if self._ring._base is ZZ:
            # over ZZ the content counts: 4x = 2^2 x is not squarefree (the
            # second review's R2-POL-F3); over a field it is a unit
            return all(e == 1 for _, e in self.factor())
        return all(e == 1 for _, e in self.factor() if isinstance(_, Polynomial))

    def roots(self, ring=None, multiplicities=True):
        """The roots in the base ring (or `ring`, ZZ or QQ): [(root, m)].

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: ((x - 1)^2 * (x + 1/2)).roots()
            [(-1/2, 1), (1, 2)]
            sage: (x^2 - 2).roots(), (x^2 - 2).roots(multiplicities=False)
            ([], [])
            sage: sorted((x^2 - 2).roots(QuadraticField(2, 'a')), key=str)
            [(-a, 1), (a, 1)]
        """
        R = ring if ring is not None else self._ring._base
        sa = _sa()
        if type(R).__name__ == "NumberField_absolute" and self._ring._base in (ZZ, QQ):
            # in a number field K: those of the polynomial over K (they were
            # always [], the rational roots' path)
            return R[self._ring._name](self).roots(multiplicities=multiplicities)
        import _sage_qqbar
        if (R is _sage_qqbar.QQbar or R is _sage_qqbar.AA) and self._ring._base in (ZZ, QQ):
            # QQbar / AA: exact roots, real ones first (increasing), then the
            # others by real and imaginary part, as Sage lists them
            import _sage_qqbar
            T = _sage_qqbar.AlgebraicReal if R is _sage_qqbar.AA else _sage_qqbar.AlgebraicNumber
            out = []
            for g, e in self.factor():
                if isinstance(g, Polynomial):
                    for r in _sage_qqbar._roots_of(_sage_qqbar._primitive(g.list()), _sage_qqbar.AlgebraicNumber):
                        if r._is_real_gen():
                            out.append((T(r._gen, r._c, r._civ), e))
                        elif T is _sage_qqbar.AlgebraicNumber:
                            out.append((r, e))
            out.sort(key=lambda t: (0, float(t[0]._approx(20)[0]), 0) if t[0]._is_real_gen() else (1, float(t[0]._approx(20)[0]), float(t[0]._approx(20)[1])))
            return out if multiplicities else [r for r, _ in out]
        if R is sa.RR or R is getattr(sa, "CC", None):
            from _sage_matrix import numeric_roots
            out = numeric_roots(self.list(), R)
            return out if multiplicities else [r for r, _ in out]
        if R not in (ZZ, QQ):
            # (any other ring got the rational roots: [] for a number field)
            raise NotImplementedError("roots in %s are not available in sagebrush yet" % (R,))
        out = []
        for g, e in self.factor():
            if isinstance(g, Polynomial) and g.degree() == 1:
                r = _F(-g[0]) / _F(g[1])
                if R is ZZ and r.denominator != 1:
                    continue
                out.append((_norm(r), e))
        return out if multiplicities else [r for r, _ in out]


class PolyFactorization(list):
    """[(factor, exponent)] with a unit, printed as Sage prints the
    factorization of a polynomial.

    EXAMPLES::

        sage: R.<x> = ZZ[]
        sage: F = (2*x^2 - 2).factor(); F
        2 * (x - 1) * (x + 1)
        sage: list(F), F.unit()
        ([(2, 1), (x - 1, 1), (x + 1, 1)], 1)
    """

    def __init__(self, items, unit=1, field=False, constant=None, constant_value=None):
        # Sage's order: degree, then exponent, then the factor
        def key(it):
            f, e = it
            if isinstance(f, Polynomial):
                return (f.degree(), e, [_F(a) for a in reversed(f._c)])
            return (0, e, [_F(f)])
        super().__init__(sorted(items, key=key))
        self._unit = unit
        self._field = field
        self._constant = constant
        self._cv = constant_value

    def unit(self):
        """The unit (constant) factor.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (-3*x^2 + 3).factor().unit()
            -1
        """
        return self._unit

    def value(self):
        """The product of the factorization.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (-3*x^2 + 3).factor().value()
            -3*x^2 + 3
        """
        v = self._unit if self._cv is None else self._unit * self._cv
        for f, e in self:
            v = f ** e * v
        return v

    expand = value

    def __repr__(self):
        if self._constant is not None or (self._cv is not None and not self):
            s = repr(self._constant) if self._constant is not None else ""
            if self._unit == -1:
                return "-" + s if s else "-1"
            return s or "1"

        # Sage's Factorization._repr_: parenthesize compound factors unless
        # the factorization is a lone factor to the first power with unit 1.
        paren = len(self) > 1 or self._unit != 1

        def term(f, e):
            s = repr(f)
            if (e != 1 or paren) and any(c in s for c in "*+- "):
                s = "(%s)" % s
            return s if e == 1 else "%s^%d" % (s, e)

        parts = [term(f, e) for f, e in self]
        if self._field:
            if self._unit != 1:
                parts.insert(0, "(%r)" % (self._unit,))
        elif self._unit == -1:
            parts.insert(0, "(-1)")
        return " * ".join(parts) if parts else repr(self._unit)

    __str__ = __repr__

    def _latex_(self):
        from _sage_expr import latex
        if self._constant is not None or (self._cv is not None and not self):
            return str(latex(self._constant)) if self._constant is not None else ("-1" if self._unit == -1 else "1")
        paren = len(self) > 1 or self._unit != 1

        def term(f, e):
            s = str(latex(f))
            if (e != 1 or paren) and any(c in repr(f) for c in "*+- "):
                s = "\\left(%s\\right)" % s
            return s if e == 1 else "%s^{%d}" % (s, e)

        parts = [term(f, e) for f, e in self]
        if self._unit == -1 and not self._field:
            parts.insert(0, "-1")
        elif self._field and self._unit != 1:
            parts.insert(0, "\\left(%s\\right)" % latex(self._unit))
        return " \\cdot ".join(parts) if parts else str(latex(self._unit))


import _sage_frac as _frac
_frac._install_ring_extras(PolynomialRing_)
