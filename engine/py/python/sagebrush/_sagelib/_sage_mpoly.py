"""Multivariate polynomial rings over QQ, ZZ and finite fields, as in Sage:
R.<x,y> = QQ[], PolynomialRing(QQ, 3, 'x', order='lex'), GF(5)['x,y'];
arithmetic, evaluation and substitution, gcd and factorization, ideals and
reduced Groebner bases (Buchberger's algorithm with the Gebauer-Moeller
criteria), membership, elimination, dimension and varieties of
zero-dimensional ideals; printed as Sage prints them.

A polynomial is a dict {exponent tuple: coefficient}; coefficients are
Fractions over QQ and ZZ, integers mod p over GF(p), field elements over
GF(q).  Over QQ and ZZ the arithmetic (+, -, *, ^, ==) is done by the Rust
engine (engine/mpoly): such a polynomial may hold only the engine's bytes,
and its dict is made when something asks for it."""

from fractions import Fraction as _F
import math

try:  # the CPython package
    from sagebrush._native import mpoly_call as _mp_raw
except ImportError:
    try:  # pyjs: the engine is linked into the runtime
        import _sbengine
        _mp_raw = _sbengine.mp
    except (ImportError, AttributeError):
        _mp_raw = None


def _mp(op, *args):
    """One engine/mpoly call: the results, as bytes."""
    parts = [len(op).to_bytes(4, "little"), op.encode(), len(args).to_bytes(4, "little")]
    for a in args:
        if isinstance(a, str):
            a = a.encode()
        parts.append(len(a).to_bytes(4, "little"))
        parts.append(a)
    r = _mp_raw(b"".join(parts))
    if r[:2] != b"ok":
        raise ValueError(bytes(r[2:]).decode())
    k = int.from_bytes(r[2:6], "little")
    out, i = [], 6
    for _ in range(k):
        m = int.from_bytes(r[i:i + 4], "little")
        out.append(r[i + 4:i + 4 + m])
        i += 4 + m
    return out


def _sa():
    import sage_all
    return sage_all


# ------------------------------------------------------------------ term orders

_ORDER_NAMES = {
    "degrevlex": "degrevlex", "dp": "degrevlex", "grevlex": "degrevlex",
    "lex": "lex", "lp": "lex",
    "deglex": "deglex", "Dp": "deglex",
    "invlex": "invlex", "rp": "invlex",
    "neglex": "neglex", "ls": "neglex",
    "negdegrevlex": "negdegrevlex", "ds": "negdegrevlex",
    "negdeglex": "negdeglex", "Ds": "negdeglex",
    "wdegrevlex": "degrevlex",
}

_ORDER_REPR = {
    "degrevlex": "Degree reverse lexicographic term order",
    "lex": "Lexicographic term order",
    "deglex": "Degree lexicographic term order",
    "invlex": "Inverse lexicographic term order",
    "neglex": "Negative lexicographic term order",
    "negdegrevlex": "Negative degree reverse lexicographic term order",
    "negdeglex": "Negative degree lexicographic term order",
}


def _flat_key(name):
    """A key that is a flat tuple of integers (so it can be negated for a
    min-heap), with key(a) > key(b) when the monomial a is bigger."""
    if name == "lex":
        return lambda e: e
    if name == "degrevlex":
        return lambda e: (sum(e),) + tuple(-x for x in reversed(e))
    if name == "deglex":
        return lambda e: (sum(e),) + e
    if name == "invlex":
        return lambda e: tuple(reversed(e))
    if name == "neglex":
        return lambda e: tuple(-x for x in e)
    if name == "negdegrevlex":
        return lambda e: (-sum(e),) + tuple(-x for x in reversed(e))
    if name == "negdeglex":
        return lambda e: (-sum(e),) + e
    raise ValueError("unknown term order %r" % name)


def _order_key(name):
    """A key with key(a) > key(b) when the monomial a is bigger."""
    if name == "lex":
        return lambda e: e
    if name == "degrevlex":
        return lambda e: (sum(e), tuple(-x for x in reversed(e)))
    if name == "deglex":
        return lambda e: (sum(e), e)
    if name == "invlex":
        return lambda e: tuple(reversed(e))
    if name == "neglex":
        return lambda e: tuple(-x for x in e)
    if name == "negdegrevlex":
        return lambda e: (-sum(e), tuple(-x for x in reversed(e)))
    if name == "negdeglex":
        return lambda e: (-sum(e), e)
    raise ValueError("unknown term order %r" % name)


class TermOrder:
    """A monomial order (Sage's TermOrder).

    EXAMPLES::

        sage: TermOrder('lex')
        Lexicographic term order
        sage: PolynomialRing(QQ, 'x,y').term_order()
        Degree reverse lexicographic term order
    """

    def __init__(self, name="degrevlex", n=0):
        if isinstance(name, TermOrder):
            name = name._name
        name = str(name)
        if name not in _ORDER_NAMES:
            raise ValueError("unknown term order %r" % name)
        self._given = name
        self._name = _ORDER_NAMES[name]
        self.key = _order_key(self._name)
        self.flat = _flat_key(self._name)

    def __repr__(self):
        return _ORDER_REPR[self._name]

    def name(self):
        """The name of the order.

        EXAMPLES::

            sage: TermOrder('lp').name(), TermOrder('lex').name()
            ('lp', 'lex')
        """
        return self._given

    def __eq__(self, o):
        return isinstance(o, TermOrder) and o._name == self._name

    def __hash__(self):
        return hash(self._name)

    def is_global(self):
        """Whether 1 is smaller than every variable.

        EXAMPLES::

            sage: TermOrder('lex').is_global(), TermOrder('ds').is_global()
            (True, False)
        """
        return not self._name.startswith("neg")


# ------------------------------------------------------------------ coefficient domains

def _is_number_field(K):
    try:
        import _sage_nf
    except ImportError:
        return False
    return isinstance(K, _sage_nf.NumberField_absolute)


def _nf_repr(c):
    """A number field element as Sage prints it in a multivariate
    polynomial: rationals bare, the generator bare, else in parentheses
    ((a^2), (-a), (1/3*a), (a - 1))."""
    v = c._c
    if not any(v[1:]):
        x = v[0] if v else _F(0)
        return str(x.numerator) if x.denominator == 1 else "%d/%d" % (x.numerator, x.denominator)
    s = repr(c)
    if s == c.parent()._name:
        return s
    return "(" + s + ")"


def _ext_repr(c):
    """An element of GF(p^k) as Sage prints it in a multivariate polynomial:
    balanced coefficients, in parentheses unless it is an integer or a bare
    power of the generator ((2*a), (-a), (a + 1), a, a^2, -3)."""
    F = c.parent()
    p, name = F._p, F._name
    v = [x - p if x > p // 2 else x for x in c._c]
    terms = []
    for j in range(len(v) - 1, -1, -1):
        x = v[j]
        if not x:
            continue
        mono = "" if j == 0 else name if j == 1 else "%s^%d" % (name, j)
        if not mono:
            t = str(abs(x))
        elif abs(x) == 1:
            t = mono
        else:
            t = "%d*%s" % (abs(x), mono)
        terms.append((x < 0, t))
    if not terms:
        return "0"
    s = ("-" if terms[0][0] else "") + terms[0][1]
    for neg, t in terms[1:]:
        s += (" - " if neg else " + ") + t
    if not any(v[1:]):
        return s
    if len(terms) == 1 and not terms[0][0] and not terms[0][1][0].isdigit():
        return s
    return "(" + s + ")"


def _is_prime_field(base):
    import _sage_ff
    return isinstance(base, _sage_ff.IntegerModRing_) and base.is_field()


class _Dom:
    """Arithmetic on the raw coefficients of a base ring."""

    def __init__(self, base):
        sa = _sa()
        self.base = base
        self.p = None
        self.generic = False
        if base is sa.QQ or base is sa.ZZ:
            self.zero, self.one = _F(0), _F(1)
        elif _is_prime_field(base):
            self.p = int(base.characteristic())
            self.zero, self.one = 0, 1
        else:
            self.generic = True
            self.zero, self.one = base(0), base(1)

    def _conv(self, x):
        """A raw coefficient from a base ring element (or int/rational)."""
        if self.p is not None:
            if isinstance(x, _F) or type(x).__name__ == "Rational":
                x = _F(x)
                return (x.numerator * pow(x.denominator, -1, self.p)) % self.p
            return int(x) % self.p
        if self.generic:
            return self.base(x)
        if isinstance(x, _F):
            return x
        try:
            return _F(x)
        except (TypeError, ValueError):
            raise TypeError("unable to convert %r to an element of %r" % (x, self.base))

    def _out(self, c):
        """A raw coefficient as a base ring element."""
        if self.p is not None:
            return self.base(c)
        if self.generic:
            return c
        if c.denominator == 1:
            return _sa().Integer(c.numerator)
        return _sa().Rational._from_coprime_ints(c.numerator, c.denominator)

    def _add(self, a, b):
        return (a + b) % self.p if self.p is not None else a + b

    def _sub(self, a, b):
        return (a - b) % self.p if self.p is not None else a - b

    def _mul(self, a, b):
        return (a * b) % self.p if self.p is not None else a * b

    def _neg(self, a):
        return (-a) % self.p if self.p is not None else -a

    def _inv(self, a):
        if self.p is not None:
            return pow(a, -1, self.p)
        return 1 / a if self.generic else _F(1) / a

    def _div(self, a, b):
        return self._mul(a, self._inv(b))

    def _repr(self, c):
        # Sage's multivariate polynomials over finite fields (Singular)
        # print coefficients as balanced residues: 6 -> -1 over GF(7)
        if self.p is not None:
            return str(c - self.p if c > self.p // 2 else c)
        if self.generic:
            if self._ext():
                return _ext_repr(c)
            if _is_number_field(self.base):
                return _nf_repr(c)
            return repr(c)
        return str(c.numerator) if c.denominator == 1 else "%d/%d" % (c.numerator, c.denominator)

    def _is_negative(self, c):
        if self.p is not None:
            return c > self.p // 2
        if self.generic and self._ext():
            # an element of the prime field prints as an integer
            v = c._c
            return not any(v[1:]) and v[0] > self.base._p // 2
        if self.generic and _is_number_field(self.base):
            v = c._c
            return not any(v[1:]) and v[0] < 0
        return not self.generic and c < 0

    def _ext(self):
        import _sage_ff
        return isinstance(self.base, _sage_ff.FiniteField_ext)


# ------------------------------------------------------------------ rings

_RINGS = {}


def _normalize_names(n, names):
    if isinstance(names, (list, tuple)):
        names = [str(x) for x in names]
        if n is not None and len(names) == 1 and n > 1:
            return [names[0] + str(i) for i in range(n)]
        return names
    s = str(names)
    if "," in s:
        return [t.strip() for t in s.split(",") if t.strip()]
    if n is None or n == 1:
        return [s]
    if len(s) == n and n > 1:
        return list(s)
    return [s + str(i) for i in range(n)]


def MPolynomialRing(base, n=None, names=None, order="degrevlex"):
    """The multivariate polynomial ring (cached by base, names and order).

    EXAMPLES::

        sage: from _sage_mpoly import MPolynomialRing  # sagebrush only
        sage: MPolynomialRing(QQ, 2, 'ab')  # sagebrush only
        Multivariate Polynomial Ring in a, b over Rational Field
    """
    names = tuple(_normalize_names(n, names))
    if n is not None and len(names) != n:
        raise IndexError("the number of names must equal the number of generators")
    o = TermOrder(order)
    key = (id(base), names, o._name)
    if key not in _RINGS:
        _RINGS[key] = MPolynomialRing_(base, names, o)
    return _RINGS[key]


class MPolynomialRing_:
    """A multivariate polynomial ring.

    EXAMPLES::

        sage: R.<x,y> = QQ[]; R
        Multivariate Polynomial Ring in x, y over Rational Field
        sage: (x + y)^2
        x^2 + 2*x*y + y^2
        sage: PolynomialRing(GF(5), 3, 'z')
        Multivariate Polynomial Ring in z0, z1, z2 over Finite Field of size 5
    """

    def __init__(self, base, names, order):
        self._base = base
        self._names = tuple(names)
        self._n = len(names)
        self._order = order
        self._key = order.key
        self._flat = order.flat
        self._dom = _Dom(base)
        sa = _sa()
        # the engine's coefficients: "q" (QQ, ZZ), "p" (GF(p)), "ext"
        # (GF(p^k) as GF(p)[a]/(m), a one more variable), or none
        self._engine = None
        if _mp_raw is not None and self._n >= 1:
            import _sage_ff
            if base is sa.QQ or base is sa.ZZ:
                self._engine = "q"
            elif self._dom.p is not None and self._dom.p < 1 << 62:
                self._engine = "p"
            elif isinstance(base, _sage_ff.FiniteField_ext) and base._p < 1 << 62:
                self._engine = "ext"
                self._mstr = ",".join(str(int(c) % base._p) for c in base._f)
            elif _is_number_field(base):
                self._engine = "nf"
                self._mstr = ",".join(str(int(c)) for c in base._f)

    def __repr__(self):
        return "Multivariate Polynomial Ring in %s over %r" % (", ".join(self._names), self._base)

    def _latex_(self):
        return "%s[%s]" % (getattr(self._base, "_latex_", lambda: repr(self._base))(), ", ".join(self._names))

    def __eq__(self, o):
        return isinstance(o, MPolynomialRing_) and o._base == self._base and o._names == self._names and o._order == self._order

    def __hash__(self):
        return hash((repr(self._base), self._names, self._order._name))

    # ---- structure
    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: QQ['x,y'].base_ring()
            Rational Field
        """
        return self._base

    base = base_ring

    def ngens(self):
        """The number of variables.

        EXAMPLES::

            sage: QQ['x,y,z'].ngens()
            3
        """
        return _sa().Integer(self._n)

    def gen(self, i=0):
        """The i-th variable.

        EXAMPLES::

            sage: QQ['x,y'].gen(1)
            y
        """
        i = int(i)
        if not 0 <= i < self._n:
            raise ValueError("generator not defined")
        e = [0] * self._n
        e[i] = 1
        return MPolynomial(self, {tuple(e): self._dom.one})

    def gens(self):
        """The variables.

        EXAMPLES::

            sage: QQ['x,y'].gens()
            (x, y)
        """
        return tuple(self.gen(i) for i in range(self._n))

    def _first_ngens(self, k):
        return self.gens()[:k]

    def objgens(self):
        """(self, the variables).

        EXAMPLES::

            sage: R, (x, y) = PolynomialRing(QQ, 2, 'xy').objgens(); R, x + y
            (Multivariate Polynomial Ring in x, y over Rational Field, x + y)
        """
        return self, self.gens()

    def gens_dict(self):
        """{name: variable}.

        EXAMPLES::

            sage: QQ['x,y'].gens_dict()
            {'x': x, 'y': y}
        """
        return {n: g for n, g in zip(self._names, self.gens())}

    def variable_names(self):
        """The names of the variables.

        EXAMPLES::

            sage: QQ['x,y'].variable_names()
            ('x', 'y')
        """
        return self._names

    def variable_name(self):
        """The name of the first variable.

        EXAMPLES::

            sage: QQ['x,y'].variable_name()
            'x'
        """
        return self._names[0]

    def term_order(self):
        """The monomial order.

        EXAMPLES::

            sage: PolynomialRing(QQ, 'x,y', order='lex').term_order()
            Lexicographic term order
        """
        return self._order

    def characteristic(self):
        """The characteristic of the base ring.

        EXAMPLES::

            sage: GF(7)['x,y'].characteristic()
            7
        """
        return _sa().Integer(self._dom.p or 0) if not self._dom.generic else self._base.characteristic()

    def is_field(self, proof=True):
        """False.

        EXAMPLES::

            sage: QQ['x,y'].is_field()
            False
        """
        return False

    def is_integral_domain(self, proof=True):
        """True.

        EXAMPLES::

            sage: QQ['x,y'].is_integral_domain()
            True
        """
        return True

    def is_commutative(self):
        """True.

        EXAMPLES::

            sage: QQ['x,y'].is_commutative(), QQ['x,y'].is_noetherian()
            (True, True)
        """
        return True

    def is_noetherian(self):
        """True (Hilbert's basis theorem).

        EXAMPLES::

            sage: GF(2)['x,y'].is_noetherian()
            True
        """
        return True

    def krull_dimension(self):
        """The Krull dimension: the number of variables (over a field).

        EXAMPLES::

            sage: QQ['x,y,z'].krull_dimension()
            3
        """
        return _sa().Integer(self._n + (0 if self._base is not _sa().ZZ else 1))

    def zero(self):
        """0.

        EXAMPLES::

            sage: QQ['x,y'].zero()
            0
        """
        return MPolynomial(self, {})

    def one(self):
        """1.

        EXAMPLES::

            sage: QQ['x,y'].one()
            1
        """
        return MPolynomial(self, {(0,) * self._n: self._dom.one})

    def monomial(self, *exponents):
        """The monomial with the given exponents.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.monomial(2, 1)
            x^2*y
        """
        return MPolynomial(self, {tuple(int(e) for e in exponents): self._dom.one})

    def change_ring(self, base_ring=None, names=None, order=None):
        """The ring with another base ring, names or order.

        EXAMPLES::

            sage: QQ['x,y'].change_ring(GF(3))
            Multivariate Polynomial Ring in x, y over Finite Field of size 3
        """
        return MPolynomialRing(base_ring if base_ring is not None else self._base, None,
                               names if names is not None else self._names,
                               order if order is not None else self._order)

    def random_element(self, degree=2, terms=5, choose_degree=False, *args, **kwds):
        """A random polynomial of at most the given degree.

        EXAMPLES::

            sage: QQ['x,y'].random_element().parent()
            Multivariate Polynomial Ring in x, y over Rational Field
        """
        import random as _r
        d = {}
        for _ in range(int(terms)):
            e = [0] * self._n
            for _ in range(_r.randint(0, int(degree))):
                e[_r.randrange(self._n)] += 1
            c = self._dom._conv(_r.randint(-2, 2)) if not self._dom.generic else self._base.random_element()
            d[tuple(e)] = c
        return MPolynomial(self, d)

    def ideal(self, *gens, **kwds):
        """The ideal generated by gens.

        EXAMPLES::

            sage: R.<x,y> = QQ[]
            sage: R.ideal(x^2, y)
            Ideal (x^2, y) of Multivariate Polynomial Ring in x, y over Rational Field
        """
        if len(gens) == 1 and isinstance(gens[0], (list, tuple)):
            gens = gens[0]
        return MPolynomialIdeal(self, [self(g) for g in gens])

    def __rmul__(self, gens):
        # (f, g)*R: the ideal
        if isinstance(gens, (list, tuple)):
            return self.ideal(list(gens))
        return NotImplemented

    __mul__ = __rmul__

    def __contains__(self, x):
        if isinstance(x, MPolynomial):
            return x._ring == self
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False

    def fraction_field(self):
        """The field of fractions.

        EXAMPLES::

            sage: QQ['x,y'].fraction_field()
            Fraction Field of Multivariate Polynomial Ring in x, y over Rational Field
        """
        return _FractionField(self)

    # ---- conversion
    def __call__(self, x=0, *args):
        """Convert a number, polynomial, string or dict {exponents: coeff}.

        EXAMPLES::

            sage: R.<x,y> = QQ[]
            sage: R(3), R('x^2 + y'), R({(1, 2): 5})
            (3, x^2 + y, 5*x*y^2)
        """
        dom = self._dom
        if isinstance(x, MPolynomial):
            if x._ring is self:
                return x
            return _map_vars(x, self)
        if isinstance(x, dict):
            return MPolynomial(self, {tuple(int(t) for t in e): dom._conv(c) for e, c in x.items()})
        if isinstance(x, str):
            return _eval_string(self, x)
        import _sage_poly
        if isinstance(x, _sage_poly.Polynomial):
            name = x._ring._name
            if name in self._names:
                i = self._names.index(name)
                d = {}
                for k, c in enumerate(x._c):
                    if c:
                        e = [0] * self._n
                        e[i] = k
                        d[tuple(e)] = dom._conv(c)
                return MPolynomial(self, d)
            if x.degree() <= 0:
                return self(x[0] if x._c else 0)
            raise TypeError("cannot convert %r into %r" % (x, self))
        if hasattr(x, "_s") and hasattr(x, "_op"):
            # a symbolic expression in the variables
            return _eval_string(self, repr(x))
        if isinstance(x, MFraction):
            if x._den.is_constant():
                return x._num * self(1 / x._den.constant_coefficient())
            raise TypeError("fraction must have unit denominator")
        c = dom._conv(x)
        if (dom.p is not None and c == 0) or (dom.p is None and not dom.generic and c == 0) or (dom.generic and not c):
            return MPolynomial(self, {})
        if self._base is _sa().ZZ and _F(c).denominator != 1:
            raise TypeError("no conversion of this rational to integer")
        return MPolynomial(self, {(0,) * self._n: c})


def _map_vars(f, R):
    """f in the ring R, matching variables by name."""
    S = f._ring
    idx = []
    for name in S._names:
        if name not in R._names:
            if any(e[S._names.index(name)] for e in f._d):
                raise TypeError("cannot convert %r into %r: no variable %s" % (f, R, name))
            idx.append(None)
        else:
            idx.append(R._names.index(name))
    d = {}
    for e, c in f._d.items():
        t = [0] * R._n
        for k, v in enumerate(e):
            if v:
                t[idx[k]] += v
        d[tuple(t)] = R._dom._add(d.get(tuple(t), R._dom.zero), R._dom._conv(S._dom._out(c)))
    return MPolynomial(R, d)


def _eval_string(R, s):
    import re
    s = s.replace("^", "**")
    s = re.sub(r"(\d+)/(\d+)", r"_Q(\1, \2)", s)
    ns = dict(zip(R._names, R.gens()))
    ns["_Q"] = lambda a, b: R(_F(a, b))
    ns["I"] = None
    try:
        v = eval(s, {"__builtins__": {}}, ns)
    except Exception as e:
        raise TypeError("unable to convert %r into %r" % (s, R))
    return R(v) if not isinstance(v, MPolynomial) else v


# ------------------------------------------------------------------ elements

class MPolynomial:
    """A polynomial in several variables.

    EXAMPLES::

        sage: R.<x,y> = QQ[]
        sage: f = 3*x^2*y - y + 1/2; f
        3*x^2*y - y + 1/2
        sage: f(2, 1), f.degree(), f.lm(), f.lc()
        (23/2, 3, x^2*y, 3)
    """

    __slots__ = ("_ring", "_dd", "_lt", "_b")

    def __init__(self, ring, d):
        dom = ring._dom
        if dom.generic:
            self._dd = {e: c for e, c in d.items() if c}
        else:
            self._dd = {e: c for e, c in d.items() if c != 0}
        self._ring = ring
        self._lt = None
        self._b = None

    # ---- the engine (QQ and ZZ): bytes, and the dict made on demand
    @property
    def _d(self):
        if self._dd is None:
            self._dd = _dict_of(self._ring, self._b)
        return self._dd

    def _bytes(self):
        if self._b is None:
            R = self._ring
            if R._engine == "q":
                self._b = _mp("new", str(R._n), ";".join(
                    "%s:%s" % (",".join(map(str, e)), c) for e, c in self._dd.items()))[0]
            elif R._engine == "p":
                self._b = _mp("newp", str(R._n), str(R._dom.p), ";".join(
                    "%s:%d" % (",".join(map(str, e)), c) for e, c in self._dd.items()))[0]
            elif R._engine == "nf":
                es = ",".join
                self._b = _mp("new", str(R._n + 1), ";".join(
                    "%s,%d:%s" % (es(map(str, e)), j, cj) for e, c in self._dd.items() for j, cj in enumerate(c._c) if cj))[0]
            else:
                es = ",".join
                self._b = _mp("newp", str(R._n + 1), str(R._base._p), ";".join(
                    "%s,%d:%d" % (es(map(str, e)), j, cj) for e, c in self._dd.items() for j, cj in enumerate(c._c) if cj))[0]
        return self._b

    def _fast(self, o, big=0):
        """Whether to compute self op o in the engine: over QQ or ZZ, when
        either already lives there or the work is at least big."""
        R = self._ring
        if not R._engine:
            return False
        if self._b is not None or o._b is not None:
            return True
        return len(self._dd) * len(o._dd) >= big if big else False

    # ---- data
    def parent(self):
        """The polynomial ring.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x*y).parent()
            Multivariate Polynomial Ring in x, y over Rational Field
        """
        return self._ring

    def base_ring(self):
        """The coefficient ring.

        EXAMPLES::

            sage: R.<x,y> = GF(3)[]; (x + y).base_ring()
            Finite Field of size 3
        """
        return self._ring._base

    def _terms(self):
        """[(exponent, raw coefficient)], largest monomial first."""
        k = self._ring._key
        return sorted(self._d.items(), key=lambda t: k(t[0]), reverse=True)

    def _leading(self):
        if self._lt is None:
            if not self._d:
                raise ArithmeticError("the zero polynomial has no leading term")
            k = self._ring._key
            e = max(self._d, key=k)
            self._lt = (e, self._d[e])
        return self._lt

    def _new(self, d):
        return MPolynomial(self._ring, d)

    def _mono(self, e):
        return MPolynomial(self._ring, {e: self._ring._dom.one})

    def dict(self):
        """{exponents: coefficient}.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x*y + 1).dict()
            {(0, 0): 1, (1, 1): 2}
        """
        out = self._ring._dom._out
        return {e: out(c) for e, c in self._terms()}

    def exponents(self, as_ETuples=True):
        """The exponent tuples, largest monomial first.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2 + x*y^3).exponents()
            [(1, 3), (2, 0)]
        """
        return [e for e, _ in self._terms()]

    def monomials(self):
        """The monomials, largest first.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x^2 + 3*x*y + 1).monomials()
            [x^2, x*y, 1]
        """
        return [self._mono(e) for e, _ in self._terms()]

    def coefficients(self):
        """The coefficients, in the order of monomials().

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x^2 + 3*x*y + 1).coefficients()
            [2, 3, 1]
        """
        out = self._ring._dom._out
        return [out(c) for _, c in self._terms()]

    def number_of_terms(self):
        """The number of nonzero terms.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x + y + 1).number_of_terms()
            3
        """
        return _sa().Integer(len(self))

    hamming_weight = number_of_terms

    def __iter__(self):
        out = self._ring._dom._out
        return iter([(out(c), self._mono(e)) for e, c in self._terms()])

    def __len__(self):
        if self._dd is None and self._ring._engine not in ("ext", "nf"):
            return int(bytes(_mp("len", self._b)[0]))
        return len(self._d)

    def degree(self, x=None, std_grading=False):
        """The total degree, or the degree in the variable x.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; f = x^3*y + y^2
            sage: f.degree(), f.degree(y), R(0).degree()
            (4, 2, -1)
        """
        if not self._d:
            return _sa().Integer(-1)
        if x is None:
            return _sa().Integer(max(sum(e) for e in self._d))
        i = self._ring._var_index(x)
        return _sa().Integer(max(e[i] for e in self._d))

    def total_degree(self):
        """The total degree.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^3*y + y^2).total_degree()
            4
        """
        return self.degree()

    def degrees(self):
        """The degree in each variable.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^3*y + y^2).degrees()
            (3, 2)
        """
        if not self._d:
            return (0,) * self._ring._n
        return tuple(_sa().Integer(max(e[i] for e in self._d)) for i in range(self._ring._n))

    def lm(self):
        """The leading monomial (for the ring's term order).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x*y^2 + 3*x^2).lm()
            x*y^2
        """
        return self._mono(self._leading()[0])

    leading_monomial = lm

    def lc(self):
        """The leading coefficient.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x*y^2 + 3*x^2).lc()
            2
        """
        return self._ring._dom._out(self._leading()[1])

    leading_coefficient = lc

    def lt(self):
        """The leading term.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x*y^2 + 3*x^2).lt()
            2*x*y^2
        """
        e, c = self._leading()
        return self._new({e: c})

    leading_term = lt

    def constant_coefficient(self):
        """The constant term.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x + y + 7).constant_coefficient()
            7
        """
        dom = self._ring._dom
        return dom._out(self._d.get((0,) * self._ring._n, dom.zero))

    def is_constant(self):
        """Whether the polynomial is a constant.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R(3).is_constant(), x.is_constant()
            (True, False)
        """
        return all(not any(e) for e in self._d)

    def is_zero(self):
        """Whether the polynomial is 0.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R(0).is_zero()
            True
        """
        return len(self) == 0

    def is_one(self):
        """Whether the polynomial is 1.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R(1).is_one(), x.is_one()  # sagebrush only (the local Sage lacks Singular)
            (True, False)
        """
        return self == 1

    def is_monomial(self):
        """Whether the polynomial is a single monomial with coefficient 1.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x*y).is_monomial(), (2*x).is_monomial()
            (True, False)
        """
        return len(self._d) == 1 and self._leading()[1] == self._ring._dom.one

    def is_term(self):
        """Whether the polynomial has exactly one term.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (3*x*y).is_term(), (x + y).is_term()
            (True, False)
        """
        return len(self._d) == 1

    def is_homogeneous(self):
        """Whether all terms have the same degree.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2 + x*y).is_homogeneous(), (x^2 + y).is_homogeneous()
            (True, False)
        """
        return len({sum(e) for e in self._d}) <= 1

    def is_univariate(self):
        """Whether at most one variable occurs.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2 + 1).is_univariate()
            True
        """
        return sum(1 for i in range(self._ring._n) if any(e[i] for e in self._d)) <= 1

    def variables(self):
        """The variables that occur, largest first.

        EXAMPLES::

            sage: R.<x,y,z> = QQ[]; (x*z + 1).variables()
            (x, z)
        """
        R = self._ring
        return tuple(R.gen(i) for i in range(R._n) if any(e[i] for e in self._d))

    def nvariables(self):
        """The number of variables that occur.

        EXAMPLES::

            sage: R.<x,y,z> = QQ[]; (x*z + 1).nvariables()
            2
        """
        return _sa().Integer(len(self.variables()))

    def coefficient(self, degrees):
        """The coefficient of a monomial, as a polynomial in the other
        variables: degrees a monomial, or a dict {variable: exponent}.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; f = 2*x^2*y + 3*x^2 + x*y
            sage: f.coefficient(x^2), f.coefficient({x: 1, y: 1}), f.coefficient({x: 2})
            (2*y + 3, 1, 2*y + 3)
        """
        R = self._ring
        if isinstance(degrees, MPolynomial):
            e = degrees._leading()[0]
            fixed = {i: e[i] for i in range(R._n) if e[i]}
        elif isinstance(degrees, dict):
            fixed = {R._var_index(k): int(v) for k, v in degrees.items()}
        else:
            fixed = {i: int(v) for i, v in enumerate(degrees) if v is not None}
        d = {}
        for e, c in self._d.items():
            if all(e[i] == v for i, v in fixed.items()):
                t = list(e)
                for i in fixed:
                    t[i] = 0
                d[tuple(t)] = c
        return self._new(d)

    def monomial_coefficient(self, mon):
        """The coefficient (in the base ring) of the monomial mon.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x^2*y + 3*x^2).monomial_coefficient(x^2)
            3
        """
        dom = self._ring._dom
        return dom._out(self._d.get(mon._leading()[0], dom.zero))

    # ---- printing
    def __repr__(self):
        if not self._d:
            return "0"
        R = self._ring
        dom = R._dom
        names = R._names
        out = []
        for e, c in self._terms():
            mono = "*".join(names[i] + ("^%d" % k if k > 1 else "") for i, k in enumerate(e) if k)
            neg = dom._is_negative(c)
            a = dom._neg(c) if neg else c
            cs = dom._repr(a)
            if dom.generic and not dom._ext() and not _is_number_field(dom.base) and (" + " in cs or " - " in cs[1:]):
                cs = "(" + cs + ")"
            if not mono:
                t = cs
            elif a == dom.one:
                t = mono
            else:
                t = cs + "*" + mono
            out.append((neg, t))
        s = ("-" if out[0][0] else "") + out[0][1]
        for neg, t in out[1:]:
            s += (" - " if neg else " + ") + t
        return s

    __str__ = __repr__

    def _latex_(self):
        import re
        s = repr(self).replace("*", " ")
        return re.sub(r"\^(\d+)", r"^{\1}", s)

    # ---- arithmetic
    def _coerce(self, o):
        R = self._ring
        if isinstance(o, MPolynomial):
            if o._ring is R:
                return o
            if o._ring == R:
                return MPolynomial(R, o._d)
            try:
                return _map_vars(o, R)
            except TypeError:
                return None
        try:
            return R(o)
        except (TypeError, ValueError, ZeroDivisionError, ArithmeticError):
            return None

    def __add__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        if self._fast(o):
            r = _engine_op(self._ring, "add", self, o)
            if r is not None:
                return r
        dom = self._ring._dom
        d = dict(self._d)
        for e, c in o._d.items():
            d[e] = dom._add(d[e], c) if e in d else c
        return self._new(d)

    __radd__ = __add__

    def __neg__(self):
        if self._b is not None and self._ring._engine:
            r = _engine_op(self._ring, "neg", self)
            if r is not None:
                return r
        dom = self._ring._dom
        return self._new({e: dom._neg(c) for e, c in self._d.items()})

    def __pos__(self):
        return self

    def __sub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        if self._fast(o):
            r = _engine_op(self._ring, "sub", self, o)
            if r is not None:
                return r
        return self + (-o)

    def __rsub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return o + (-self)

    def __mul__(self, o):
        if isinstance(o, MPolynomialIdeal):
            return NotImplemented
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        if self._fast(o, 64):
            if self._ring._engine in ("ext", "nf"):
                r = _engine_op(self._ring, "mulred", self, o, self._ring._mstr)
            else:
                r = _engine_op(self._ring, "mul", self, o)
            if r is not None:
                return r
        return self._new(_mul(self._d, o._d, self._ring._dom))

    __rmul__ = __mul__

    def __pow__(self, n, mod=None):
        n = int(n)
        if n < 0:
            return self._ring.fraction_field()(self) ** n
        if self._ring._engine and n > 1 and (self._b is not None or len(self._dd) > 1):
            if self._ring._engine in ("ext", "nf"):
                r = _engine_op(self._ring, "powred", self, str(n), self._ring._mstr)
            else:
                r = _engine_op(self._ring, "pow", self, str(n))
            if r is not None:
                return r
        r = self._ring.one()
        b = self
        while n:
            if n & 1:
                r = r * b
            n >>= 1
            if n:
                b = b * b
        return r

    def __truediv__(self, o):
        R = self._ring
        if isinstance(o, MPolynomial) and not o.is_constant():
            return R.fraction_field()(self, o)
        if isinstance(o, MFraction):
            return R.fraction_field()(self) / o
        o2 = self._coerce(o)
        if o2 is None:
            return NotImplemented
        if not o2._d:
            raise ZeroDivisionError("rational division by zero")
        dom = R._dom
        c = o2._d[(0,) * R._n]
        if R._base is _sa().ZZ:
            # over ZZ, division by a constant gives a polynomial over QQ
            S = R.change_ring(_sa().QQ)
            return MPolynomial(S, {e: v / c for e, v in self._d.items()})
        ic = dom._inv(c)
        return self._new({e: dom._mul(v, ic) for e, v in self._d.items()})

    def __rtruediv__(self, o):
        return self._ring.fraction_field()(self._ring(o), self)

    def __floordiv__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        q, r = self.quo_rem(o)
        return q

    def __mod__(self, o):
        if isinstance(o, MPolynomialIdeal):
            return o.reduce(self)
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return self.quo_rem(o)[1]

    def quo_rem(self, g):
        """(q, r) with self = q g + r, by the division algorithm for the
        ring's term order (no term of r divisible by the leading monomial
        of g).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2*y + x + 1).quo_rem(x*y)
            (x, x + 1)
        """
        g = self._coerce(g)
        if not g._d:
            raise ZeroDivisionError("division by zero")
        qs, r = _divide(self, [g])
        return qs[0], r

    def divides(self, other):
        """Whether self divides other.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x + y).divides(x^2 - y^2)
            True
        """
        other = self._coerce(other)
        return _exact_div(other, self) is not None

    def __eq__(self, o):
        if isinstance(o, MFraction):
            return o == self
        o2 = self._coerce(o)
        if o2 is None:
            return NotImplemented if not isinstance(o, (int, _F)) else False
        if self._fast(o2):
            r = _engine_op(self._ring, "eq", self, o2)
            if r is not None:
                return r
        return self._d == o2._d

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    def __hash__(self):
        if self.is_constant():
            return hash(self._ring._dom._out(self._d.get((0,) * self._ring._n, self._ring._dom.zero)))
        return hash(tuple(sorted(self._d.items(), key=lambda t: t[0])))

    def __bool__(self):
        return len(self) > 0

    def _cmp_key(self):
        k = self._ring._key
        dom = self._ring._dom
        return [(k(e), dom._out(c)) for e, c in self._terms()]

    def __lt__(self, o):
        o = self._coerce(o)
        return self._cmp_key() < o._cmp_key()

    def __le__(self, o):
        o = self._coerce(o)
        return self._cmp_key() <= o._cmp_key()

    def __gt__(self, o):
        o = self._coerce(o)
        return self._cmp_key() > o._cmp_key()

    def __ge__(self, o):
        o = self._coerce(o)
        return self._cmp_key() >= o._cmp_key()

    # ---- evaluation
    def __call__(self, *args, **kwds):
        """Evaluate at a point, or substitute (keywords, a dict).

        EXAMPLES::

            sage: R.<x0,x1,x2> = QQ[]; f = x0 + x1 - 2*x1*x2
            sage: f(1, 2, 0), f(1, 2, 5), f(x1=1)
            (3, -17, x0 - 2*x2 + 1)
        """
        R = self._ring
        if len(args) == 1 and isinstance(args[0], (list, tuple)):
            args = tuple(args[0])
        if len(args) == 1 and isinstance(args[0], dict):
            return self.subs(args[0])
        if kwds and not args:
            return self.subs(**kwds)
        if len(args) != R._n:
            raise TypeError("number of arguments does not match number of variables in parent")
        return _evaluate(self, list(args))

    def subs(self, fixed=None, **kwds):
        """Substitute values (numbers or polynomials) for some variables.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; f = x^2 + x*y
            sage: f.subs(x=1), f.subs({y: x}), f.subs(x=y + 1)
            (y + 1, 2*x^2, 2*y^2 + 3*y + 1)
        """
        R = self._ring
        vals = list(R.gens())
        if fixed:
            for k, v in fixed.items():
                vals[R._var_index(k)] = v
        for k, v in kwds.items():
            vals[R._var_index(k)] = v
        return _evaluate(self, vals)

    substitute = subs

    # ---- calculus
    def derivative(self, *args):
        """The partial derivative in a variable (repeated: diff(x, y, ...)).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^3*y + y^2).derivative(x), (x^3*y + y^2).diff(y, 2)  # sagebrush only (the local Sage fails here)
            (3*x^2*y, 2)
        """
        f = self
        R = self._ring
        seq = []
        for a in args:
            if isinstance(a, int) and seq:
                seq += [seq[-1]] * (int(a) - 1)
            else:
                seq.append(a)
        if not seq:
            if R._n == 1:
                seq = [R.gen()]
            else:
                raise ValueError("must specify which variable to differentiate with respect to")
        dom = R._dom
        for v in seq:
            i = R._var_index(v)
            d = {}
            for e, c in f._d.items():
                if e[i]:
                    t = list(e)
                    t[i] -= 1
                    d[tuple(t)] = dom._mul(dom._conv(e[i]), c)
            f = MPolynomial(R, d)
        return f

    diff = differentiate = derivative

    def gradient(self):
        """The list of partial derivatives.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2*y).gradient()
            [2*x*y, x^2]
        """
        return [self.derivative(g) for g in self._ring.gens()]

    def homogenize(self, var="h"):
        """The homogenization (with a new variable, or one of the ring's).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2 + y).homogenize()
            x^2 + y*h
            sage: (x^2 + y).homogenize(y)
            x^2 + y^2
        """
        R = self._ring
        if not self._d:
            return self
        D = self.degree()
        if isinstance(var, MPolynomial) or (isinstance(var, str) and var in R._names):
            i = R._var_index(var)
            d = {}
            for e, c in self._d.items():
                t = list(e)
                t[i] += D - sum(e)
                d[tuple(t)] = c
            return self._new(d)
        S = MPolynomialRing(R._base, None, R._names + (str(var),), R._order)
        return MPolynomial(S, {e + (D - sum(e),): c for e, c in self._d.items()})

    # ---- gcd and factoring
    def gcd(self, other):
        """The greatest common divisor (monic over a field, positive leading
        coefficient over ZZ).

        EXAMPLES::

            sage: R.<x,y> = QQ[]
            sage: f = (x^3 + 2*y^2*x)^2; f.gcd(x^2*y^2)
            x^2
            sage: (3*x^2*(x + y)).gcd(9*x*(y^2 - x^2))
            x^2 + x*y
        """
        other = self._coerce(other)
        return _gcd(self, other)

    def lcm(self, other):
        """The least common multiple.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x*y).lcm(x^2)
            x^2*y
        """
        other = self._coerce(other)
        if not self._d or not other._d:
            return self._ring.zero()
        g = _gcd(self, other)
        l = _exact_div(self * other, g)
        return _normalize_unit(l)

    def factor(self, proof=None):
        """The factorization into irreducibles.

        EXAMPLES::

            sage: R.<x,y> = QQ[]
            sage: (x^2 - y^2).factor()
            (x - y) * (x + y)
            sage: f = 9*y^6 - 9*x^2*y^5 - 18*x^3*y^4 - 9*x^5*y^4 + 9*x^6*y^2 + 9*x^7*y^3 + 18*x^8*y^2 - 9*x^11
            sage: f.factor()
            (9) * (-x^5 + y^2) * (x^6 - 2*x^3*y^2 - x^2*y^3 + y^4)
        """
        return _factor(self)

    def is_irreducible(self):
        """Whether the polynomial is irreducible.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2 + y).is_irreducible(), (x^2 - y^2).is_irreducible()  # sagebrush only (the local Sage fails here)
            (True, False)
        """
        F = self.factor()
        return len(F) == 1 and F[0][1] == 1

    def is_squarefree(self):
        """Whether no factor occurs twice.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; ((x + y)^2).is_squarefree()
            False
        """
        return all(e == 1 for _, e in self.factor())

    def content(self):
        """The gcd of the coefficients (over ZZ and QQ).

        EXAMPLES::

            sage: R.<x,y> = ZZ[]; (6*x + 4*y).content()
            2
        """
        g = _F(0)
        for c in self._d.values():
            g = _F(math.gcd(g.numerator * c.denominator, c.numerator * g.denominator), g.denominator * c.denominator)
        return self._ring._dom._out(g)

    def reduce(self, I):
        """The normal form modulo an ideal (or a list of polynomials, used as
        a Groebner basis).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; I = R.ideal(x^2 - y, y^2 - 1)
            sage: (x^4 + x).reduce(I)  # sagebrush only (the local Sage lacks Singular)
            x + 1
        """
        if isinstance(I, MPolynomialIdeal):
            return I.reduce(self)
        G = [self._coerce(g) for g in I]
        return _divide(self, [g for g in G if g._d])[1]

    def change_ring(self, R):
        """The polynomial in another ring (a base ring, or a polynomial ring).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x + 6*y).change_ring(GF(5))
            x + y
        """
        if isinstance(R, MPolynomialRing_):
            return R(self)
        S = self._ring.change_ring(R)
        out = self._ring._dom._out
        return S({e: out(c) for e, c in self._d.items()})

    def map_coefficients(self, f):
        """Apply f to every coefficient.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x + 3*y).map_coefficients(lambda c: c^2)
            4*x + 9*y
        """
        R = self._ring
        return R({e: f(R._dom._out(c)) for e, c in self._d.items()})

    def numerator(self):
        """The polynomial itself.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x + y).numerator()
            x + y
        """
        return self

    def denominator(self):
        """1.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x + y).denominator()
            1
        """
        return self._ring.one()

    def univariate_polynomial(self, R=None):
        """The polynomial in its only variable, as a univariate polynomial.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (y^2 + 1).univariate_polynomial()
            y^2 + 1
        """
        vs = self.variables()
        if len(vs) > 1:
            raise TypeError("polynomial must involve at most one variable")
        S = self._ring
        i = S._var_index(vs[0]) if vs else 0
        n = max([e[i] for e in self._d] or [0])
        cs = [S._dom.zero] * (n + 1)
        for e, c in self._d.items():
            cs[e[i]] = c
        if R is None:
            from _sage_poly import PolynomialRing
            R = PolynomialRing(S._base, S._names[i])
        return R([S._dom._out(c) for c in cs])

    def resultant(self, other, variable=None):
        """The resultant with respect to a variable (default: the last one).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x^2 + y).resultant(x - y, x)
            y^2 + y
        """
        other = self._coerce(other)
        R = self._ring
        i = R._var_index(variable) if variable is not None else R._n - 1
        return _resultant(self, other, i)

    def inverse_of_unit(self):
        """The inverse of a nonzero constant.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R(4).inverse_of_unit()
            1/4
        """
        if not self.is_constant() or not self._d:
            raise ArithmeticError("element is not a unit")
        return self._ring(1) / self

    def __invert__(self):
        return 1 / self


def _dict_of(R, b):
    """The dict of a polynomial from the engine's bytes."""
    out = {}
    t = bytes(_mp("text", b)[0]).decode()
    if not t:
        return out
    if R._engine == "p":
        for term in t.split(";"):
            e, c = term.split(":")
            out[tuple(int(x) for x in e.split(","))] = int(c)
        return out
    if R._engine == "nf":
        K = R._base
        k = len(K._f) - 1
        parts = {}
        for term in t.split(";"):
            e, c = term.split(":")
            ex = [int(x) for x in e.split(",")]
            if "/" in c:
                u, v = c.split("/")
                c = _F(int(u), int(v))
            else:
                c = _F(int(c))
            parts.setdefault(tuple(ex[:-1]), [_F(0)] * k)[ex[-1]] = c
        return {e: K._element_class(K, c) for e, c in parts.items()}
    if R._engine == "ext":
        F, k = R._base, R._base._n
        parts = {}
        for term in t.split(";"):
            e, c = term.split(":")
            ex = [int(x) for x in e.split(",")]
            parts.setdefault(tuple(ex[:-1]), [0] * k)[ex[-1]] = int(c)
        return {e: F._make(c) for e, c in parts.items()}
    for term in t.split(";"):
        e, c = term.split(":")
        if "/" in c:
            p, q = c.split("/")
            c = _F(int(p), int(q))
        else:
            c = _F(int(c))
        out[tuple(int(x) for x in e.split(","))] = c
    return out


def _engine_op(R, op, *args):
    """op on polynomials (and text) in the engine, or None if it cannot
    (exponents too large to pack in a word): the caller uses dicts."""
    try:
        r = _mp(op, *[a if isinstance(a, str) else a._bytes() for a in args])[0]
    except ValueError as e:
        if "too large to pack" in str(e):
            for a in args:
                if not isinstance(a, str):
                    a._d  # the dict, for the fallback
            return None
        raise
    if op == "eq":
        return bytes(r) == b"1"
    return _from_bytes(R, r)


def _from_bytes(R, b):
    p = MPolynomial.__new__(MPolynomial)
    p._ring, p._dd, p._lt, p._b = R, None, None, b
    return p


def _var_index(R, v):
    if isinstance(v, MPolynomial):
        if len(v._d) == 1:
            e = next(iter(v._d))
            if sum(e) == 1:
                return e.index(1)
        raise ValueError("%r is not a variable" % (v,))
    if isinstance(v, str):
        return R._names.index(v)
    s = repr(v)
    if s in R._names:
        return R._names.index(s)
    if isinstance(v, int):
        return int(v)
    raise ValueError("%r is not a variable of %r" % (v, R))


MPolynomialRing_._var_index = _var_index


def _mul(a, b, dom):
    d = {}
    if dom.p is not None:
        p = dom.p
        for e1, c1 in a.items():
            for e2, c2 in b.items():
                e = tuple(x + y for x, y in zip(e1, e2))
                d[e] = (d.get(e, 0) + c1 * c2) % p
        return d
    for e1, c1 in a.items():
        for e2, c2 in b.items():
            e = tuple(x + y for x, y in zip(e1, e2))
            if e in d:
                d[e] = d[e] + c1 * c2
            else:
                d[e] = c1 * c2
    return d


def _evaluate(f, vals):
    """f(vals): by powers, in the ring the values live in."""
    R = f._ring
    dom = R._dom
    pw = [dict() for _ in vals]

    def power(i, k):
        if k not in pw[i]:
            pw[i][k] = vals[i] ** k if k else 1
        return pw[i][k]
    total = None
    for e, c in f._terms():
        t = dom._out(c)
        for i, k in enumerate(e):
            if k:
                t = t * power(i, k)
        total = t if total is None else total + t
    if total is None:
        return R.zero() if all(isinstance(v, MPolynomial) for v in vals) else dom._out(dom.zero)
    return total


def _divide(f, G, quotients=True):
    """(quotients, remainder): the division of f by the list G (the
    largest remaining term from a heap)."""
    import heapq
    R = f._ring
    dom = R._dom
    flat = R._flat
    neg = lambda e: tuple(-x for x in flat(e))
    lead = [g._leading() for g in G]
    inv = [dom._inv(c) for _, c in lead]
    gterms = [list(g._d.items()) for g in G]
    qs = [dict() for _ in G] if quotients else None
    p = dict(f._d)
    heap = [(neg(e), e) for e in p]
    heapq.heapify(heap)
    r = {}
    generic = dom.generic
    zero = dom.zero
    while heap:
        _, e = heapq.heappop(heap)
        c = p.get(e)
        if c is None:
            continue
        for j, (le, lc) in enumerate(lead):
            if all(x >= y for x, y in zip(e, le)):
                m = tuple(x - y for x, y in zip(e, le))
                q = dom._mul(c, inv[j])
                if quotients:
                    qs[j][m] = dom._add(qs[j].get(m, zero), q)
                for ge, gc in gterms[j]:
                    t = tuple(x + y for x, y in zip(ge, m))
                    old = p.get(t)
                    v = dom._sub(old if old is not None else zero, dom._mul(q, gc))
                    if (v if generic else v != 0):
                        if old is None:
                            heapq.heappush(heap, (neg(t), t))
                        p[t] = v
                    elif old is not None:
                        del p[t]
                break
        else:
            r[e] = c
            del p[e]
    return ([MPolynomial(R, q) for q in qs] if quotients else None), MPolynomial(R, r)


def _exact_div(f, g):
    """f / g when g divides f, else None."""
    if not g._d:
        return None
    if not f._d:
        return f._ring.zero()
    (q,), r = _divide(f, [g])
    return q if not r._d else None


# ------------------------------------------------------------------ gcd

def _content_split(f, i):
    """f as a polynomial in variable i: {degree: coefficient polynomial}."""
    R = f._ring
    out = {}
    for e, c in f._d.items():
        t = list(e)
        k = t[i]
        t[i] = 0
        out.setdefault(k, {})[tuple(t)] = c
    return {k: MPolynomial(R, d) for k, d in out.items()}


def _gcd(f, g):
    R = f._ring
    if not f._d:
        return _normalize_unit(g)
    if not g._d:
        return _normalize_unit(f)
    dom = R._dom
    if R._base is _sa().ZZ:
        S = R.change_ring(_sa().QQ)
        h = _gcd(MPolynomial(S, f._d), MPolynomial(S, g._d))
        # the integer content gcd times the primitive part
        cf, cg = _int_content(f), _int_content(g)
        c = math.gcd(cf, cg)
        ph = _primitive_int(h)
        return MPolynomial(R, {e: v * c for e, v in ph._d.items()})
    r = _gcd_kronecker(f, g)
    if r is None:
        r = _gcd_field(f, g)
    return _normalize_unit(r)


def _kron_data(fs):
    R = fs[0]._ring
    vs = [i for i in range(R._n) if any(e[i] for f in fs for e in f._d)]
    D = max([_deg(f, i) for f in fs for i in vs] or [0]) + 1
    return vs, D


def _to_univariate(f, vs, D):
    """The Kronecker image f(t, t^D, t^(D^2), ...) as a univariate
    polynomial over the base ring."""
    R = f._ring
    dom = R._dom
    deg = 0
    terms = {}
    for e, c in f._d.items():
        k = 0
        for j, i in enumerate(vs):
            k += e[i] * D ** j
        terms[k] = c
        deg = max(deg, k)
    cs = [dom.zero] * (deg + 1)
    for k, c in terms.items():
        cs[k] = c
    from _sage_poly import PolynomialRing
    U = PolynomialRing(R._base, "_t")
    return U([dom._out(c) for c in cs])


def _from_univariate(u, vs, D, R):
    dom = R._dom
    d = {}
    for k, c in enumerate(u.list()):
        if c:
            e = [0] * R._n
            s = k
            for i in vs:
                e[i] = s % D
                s //= D
            if s:
                return None
            d[tuple(e)] = dom._conv(c)
    return MPolynomial(R, d)


def _gcd_kronecker(f, g):
    """gcd by Kronecker substitution: the image of the gcd divides the gcd
    of the images; a candidate dividing f and g is the gcd."""
    R = f._ring
    vs, D = _kron_data([f, g])
    if not vs:
        return R.one()
    if D ** len(vs) > 200000:
        return None
    try:
        h = _to_univariate(f, vs, D).gcd(_to_univariate(g, vs, D))
    except (NotImplementedError, TypeError, AttributeError):
        return None
    c = _from_univariate(h, vs, D, R)
    if c is None or not c._d:
        return None
    if _exact_div(f, c) is not None and _exact_div(g, c) is not None:
        return c
    return None


def _int_content(f):
    g = 0
    for c in f._d.values():
        g = math.gcd(g, int(c))
    return g


def _primitive_int(h):
    """h (over QQ) scaled to integer coefficients with content 1 and a
    positive leading coefficient."""
    d = 1
    for c in h._d.values():
        d = d * c.denominator // math.gcd(d, c.denominator)
    cs = {e: int(c * d) for e, c in h._d.items()}
    g = 0
    for c in cs.values():
        g = math.gcd(g, c)
    lc = cs[h._leading()[0]]
    s = -1 if lc < 0 else 1
    return MPolynomial(h._ring, {e: _F(s * c // g) for e, c in cs.items()})


def _gcd_field(f, g):
    """gcd over a field, recursively: as polynomials in one variable with
    coefficients in the others, by contents and primitive remainder
    sequences (pseudo-division)."""
    R = f._ring
    vs = [i for i in range(R._n) if any(e[i] for e in f._d) or any(e[i] for e in g._d)]
    if not vs:
        return R.one()
    if f.is_constant() or g.is_constant():
        return R.one()
    # a variable occurring in both
    both = [i for i in vs if any(e[i] for e in f._d) and any(e[i] for e in g._d)]
    if not both:
        # the gcd involves only variables common... none in common: gcd of contents
        i = vs[0]
        if any(e[i] for e in f._d):
            return _gcd_field(_content(f, i), g)
        return _gcd_field(f, _content(g, i))
    i = both[-1]
    cf, cg = _content(f, i), _content(g, i)
    c = _gcd_field(cf, cg)
    pf, pg = _exact_div(f, cf), _exact_div(g, cg)
    # primitive PRS in variable i
    a, b = pf, pg
    if _deg(a, i) < _deg(b, i):
        a, b = b, a
    while b._d and _deg(b, i) > 0:
        r = _prem(a, b, i)
        if not r._d:
            a = b
            b = r
            break
        a, b = b, _primitive_part(r, i)
    if b._d and _deg(b, i) == 0:
        h = R.one()
    else:
        h = _primitive_part(a, i)
    return _normalize_unit(c * h)


def _deg(f, i):
    return max((e[i] for e in f._d), default=-1)


def _content(f, i):
    """The gcd of the coefficients of f as a polynomial in variable i."""
    parts = list(_content_split(f, i).values())
    c = parts[0]
    for p in parts[1:]:
        if c.is_constant():
            break
        c = _gcd_field(c, p)
    if c.is_constant():
        return f._ring.one()
    return _normalize_unit(c)


def _primitive_part(f, i):
    c = _content(f, i)
    return _exact_div(f, c) if not c.is_constant() else f


def _prem(a, b, i):
    """The pseudo-remainder of a by b in variable i."""
    R = a._ring
    db = _deg(b, i)
    lb = _content_split(b, i)[db]
    xi = [0] * R._n
    r = a
    while r._d and _deg(r, i) >= db:
        dr = _deg(r, i)
        lr = _content_split(r, i)[dr]
        t = list(xi)
        t[i] = dr - db
        m = MPolynomial(R, {tuple(t): R._dom.one})
        r = r * lb - lr * m * b
    return r


def _normalize_unit(f):
    """f monic (over a field), with a positive leading coefficient (ZZ)."""
    if not f._d:
        return f
    R = f._ring
    dom = R._dom
    e, c = f._leading()
    if R._base is _sa().ZZ:
        return -f if c < 0 else f
    ic = dom._inv(c)
    return MPolynomial(R, {k: dom._mul(v, ic) for k, v in f._d.items()})


def _resultant(f, g, i):
    """The resultant in variable i: the determinant of the Sylvester matrix,
    by fraction-free elimination over the ring of the other variables."""
    R = f._ring
    m, n = _deg(f, i), _deg(g, i)
    if m < 0 or n < 0:
        return R.zero()
    cf, cg = _content_split(f, i), _content_split(g, i)
    a = [cf.get(k, R.zero()) for k in range(m, -1, -1)]
    b = [cg.get(k, R.zero()) for k in range(n, -1, -1)]
    N = m + n
    if N == 0:
        return R.one()
    M = []
    for r in range(n):
        M.append([R.zero()] * r + a + [R.zero()] * (N - r - len(a)))
    for r in range(m):
        M.append([R.zero()] * r + b + [R.zero()] * (N - r - len(b)))
    return _bareiss_det(M, R)


def _bareiss_det(M, R):
    n = len(M)
    M = [list(r) for r in M]
    sign = 1
    prev = R.one()
    for k in range(n - 1):
        if not M[k][k]._d:
            p = next((i for i in range(k + 1, n) if M[i][k]._d), None)
            if p is None:
                return R.zero()
            M[k], M[p] = M[p], M[k]
            sign = -sign
        for i in range(k + 1, n):
            for j in range(k + 1, n):
                M[i][j] = _exact_div(M[i][j] * M[k][k] - M[i][k] * M[k][j], prev)
        prev = M[k][k]
    d = M[n - 1][n - 1]
    return d if sign > 0 else -d


# ------------------------------------------------------------------ factoring

class MPolyFactorization(list):
    """[(factor, exponent)] with a unit, printed as Sage prints the
    factorization of a multivariate polynomial.

    EXAMPLES::

        sage: R.<x,y> = QQ[]; F = (-2*x^2*y + 2*y^3).factor(); F
        (-2) * y * (x - y) * (x + y)
        sage: list(F), F.unit()
        ([(y, 1), (x - y, 1), (x + y, 1)], -2)
    """

    def __init__(self, items, unit, ring):
        super().__init__(items)
        self._unit = unit
        self._ring = ring

    def unit(self):
        """The unit.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x*y).factor().unit()
            2
        """
        return self._unit

    def value(self):
        """The product.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (2*x*y - 2*x).factor().value()
            2*x*y - 2*x
        """
        v = self._ring(self._unit)
        for f, e in self:
            v = v * f ** e
        return v

    expand = value

    def __repr__(self):
        parts = []
        u = self._unit
        if u != 1 or not list.__len__(self):
            parts.append("(%r)" % (u,) if list.__len__(self) else repr(u))
        alone = len(parts) == 0 and list.__len__(self) == 1 and self[0][1] == 1
        for f, e in self:
            s = repr(f)
            if not alone and (len(f._d) > 1 or (f._d and next(iter(f._d.values())) != f._ring._dom.one)):
                s = "(" + s + ")"
            parts.append(s + ("^%d" % e if e > 1 else ""))
        return " * ".join(parts)

    def _latex_(self):
        return repr(self)


def _factor(f):
    R = f._ring
    sa = _sa()
    dom = R._dom
    if not f._d:
        raise ArithmeticError("factorization of 0 is not defined")
    if dom.p is not None or dom.generic:
        return _factor_ff(f)
    S = R if R._base is sa.QQ else R.change_ring(sa.QQ)
    g = MPolynomial(S, f._d)
    # integral primitive part
    den = 1
    for c in g._d.values():
        den = den * c.denominator // math.gcd(den, c.denominator)
    ints = {e: int(c * den) for e, c in g._d.items()}
    cont = 0
    for c in ints.values():
        cont = math.gcd(cont, c)
    prim = MPolynomial(S, {e: _F(c // cont) for e, c in ints.items()})
    unit = _F(cont, den)
    items = []
    for h, e in _factor_primitive(prim):
        items.append((h, e))
    # Sage's normalization (Singular's, fitted on 213 factors): the
    # coefficient of the leading monomial for the inverse lexicographic
    # order (last variable most significant) is positive; the unit takes
    # the rest.  Factors by increasing degree.
    out = []
    inv = lambda e: tuple(reversed(e))
    # (homogeneous polynomials without monomial factors: the lexicographic
    # leading coefficient positive, as x^2 - y^2 = (x - y) * (x + y))
    # (fitted on 140 factorizations in two variables: homogeneous
    # polynomials whose monomial part has the first variable to a power at
    # most that of the last use the lexicographic order instead)
    pw = [0] * R._n
    for h, m in items:
        if h.is_monomial():
            e = h._leading()[0]
            pw = [a + m * b for a, b in zip(pw, e)]
    homog = g.is_homogeneous() and pw[0] <= pw[-1]
    for h, e in items:
        lead = max(h._d) if homog else max(h._d, key=inv)
        if h._d[lead] < 0:
            h = -h
        out.append((MPolynomial(R, h._d) if R is not S else h, e))
    prod = S(1)
    for h, e in out:
        prod = prod * MPolynomial(S, h._d) ** e
    lcf = g._leading()[1]
    unit = lcf / prod._leading()[1]
    # by degree, exponent, then Sage's comparison: f < g when the leading
    # coefficient of f - g is negative
    import functools

    def cmp(a, b):
        ka, kb = (a[0].degree(), a[1]), (b[0].degree(), b[1])
        if ka != kb:
            return -1 if ka < kb else 1
        d = a[0] - b[0]
        if not d._d:
            return 0
        return -1 if d._leading()[1] < 0 else 1
    out.sort(key=functools.cmp_to_key(cmp))
    if R._base is sa.ZZ:
        u = int(unit)
        out2 = []
        if abs(u) > 1:
            for p, k in sa.factor(abs(u)):
                out2.append((R(p), int(k)))
        return MPolyFactorization(out2 + out, sa.Integer(1 if u > 0 else -1), R)
    return MPolyFactorization(out, dom._out(unit), R)


def _cmp_key_rev(self):
    k = self._ring._key
    return [(k(e), self._ring._dom._out(c)) for e, c in sorted(self._d.items(), key=lambda t: k(t[0]))]


MPolynomial._cmp_key_rev = _cmp_key_rev


def _factor_primitive(f):
    """The irreducible factors (with multiplicity) of a primitive integral
    polynomial over QQ: squarefree decomposition by gcds with derivatives,
    then each squarefree part by Kronecker substitution."""
    R = f._ring
    out = []
    # split off monomial factors x_i^k
    mins = [min(e[i] for e in f._d) for i in range(R._n)]
    if any(mins):
        f = MPolynomial(R, {tuple(x - m for x, m in zip(e, mins)): c for e, c in f._d.items()})
        for i, m in enumerate(mins):
            if m:
                out.append((R.gen(i), m))
    if f.is_constant():
        return out
    # Kronecker substitution on the whole polynomial (repeated factors
    # are found repeatedly), then group equal factors
    found = []
    for g in _factor_sqfree(f):
        g = _primitive_int(g)
        for k, (h, m) in enumerate(found):
            if h == g:
                found[k] = (h, m + 1)
                break
        else:
            found.append((g, 1))
    return out + found


def _squarefree(f):
    """[(g, e)]: f = prod g^e, g squarefree and coprime (Yun, over QQ, in
    each variable in turn)."""
    R = f._ring
    vs = [i for i in range(R._n) if any(e[i] for e in f._d)]
    parts = [(f, 1)]
    for i in vs:
        new = []
        for h, m in parts:
            if _deg(h, i) <= 0:
                new.append((h, m))
                continue
            d = h.derivative(R.gen(i))
            a = _gcd(h, d)
            if a.is_constant():
                new.append((h, m))
                continue
            b = _exact_div(h, a)
            c = _exact_div(d, a)
            k = 1
            while True:
                bd = b.derivative(R.gen(i))
                dd = c - bd
                if not dd._d:
                    if not b.is_constant():
                        new.append((b, m * k))
                    break
                a2 = _gcd(b, dd)
                if not a2.is_constant():
                    new.append((a2, m * k))
                b = _exact_div(b, a2)
                c = _exact_div(dd, a2)
                k += 1
                if b.is_constant():
                    break
        parts = new
    # merge equal parts
    return [(h, m) for h, m in parts if not h.is_constant()]


def _factor_sqfree(f):
    """The irreducible factors of a squarefree primitive polynomial over QQ."""
    R = f._ring
    vs = [i for i in range(R._n) if any(e[i] for e in f._d)]
    if len(vs) <= 1:
        return _factor_univariate(f, vs[0] if vs else 0)
    # Kronecker substitution x_i -> t^(D^k)
    D = max(_deg(f, i) for i in vs) + 1
    def kron(e):
        s = 0
        for k, i in enumerate(vs):
            s += e[i] * D ** k
        return s
    den = 1
    for c in f._d.values():
        den = den * c.denominator // math.gcd(den, c.denominator)
    deg = max(kron(e) for e in f._d)
    if deg > 4000:
        raise NotImplementedError("multivariate factorization of this size is not available in sagebrush yet")
    coeffs = [0] * (deg + 1)
    for e, c in f._d.items():
        coeffs[kron(e)] += int(c * den)
    from sagebrush import poly
    _, fs = poly.factor(coeffs)
    ufs = []
    for g, m in fs:
        ufs += [g] * m
    remaining = f
    found = []
    idx = list(range(len(ufs)))
    size = 1
    from itertools import combinations
    while idx and size <= len(idx) // 2 + 1 and not remaining.is_constant():
        hit = False
        for S in combinations(idx, size):
            prod = [1]
            for j in S:
                prod = _upmul(prod, ufs[j])
            for cand in (prod, [-c for c in prod]):
                g = _unkron(cand, vs, D, R)
                if g is None or g.is_constant():
                    continue
                q = _exact_div(remaining, g)
                if q is not None:
                    found.append(g)
                    remaining = q
                    idx = [j for j in idx if j not in S]
                    hit = True
                    break
            if hit:
                break
        if not hit:
            size += 1
    if not remaining.is_constant():
        found.append(remaining)
    return found


def _upmul(a, b):
    r = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                r[i + j] += x * y
    return r


def _unkron(c, vs, D, R):
    d = {}
    for k, v in enumerate(c):
        if v:
            e = [0] * R._n
            s = k
            for i in vs:
                e[i] = s % D
                s //= D
            d[tuple(e)] = _F(v)
    if not d:
        return None
    return MPolynomial(R, d)


def _factor_univariate(f, i):
    R = f._ring
    n = _deg(f, i)
    den = 1
    for c in f._d.values():
        den = den * c.denominator // math.gcd(den, c.denominator)
    cs = [0] * (n + 1)
    for e, c in f._d.items():
        cs[e[i]] = int(c * den)
    from sagebrush import poly
    _, fs = poly.factor(cs)
    out = []
    for g, m in fs:
        h = {}
        for k, v in enumerate(g):
            if v:
                e = [0] * R._n
                e[i] = k
                h[tuple(e)] = _F(v)
        out += [MPolynomial(R, h)] * m
    return out


def _factor_ff(f):
    """Factoring over a finite field: only univariate (or monomial times
    univariate) polynomials so far."""
    R = f._ring
    vs = [i for i in range(R._n) if any(e[i] for e in f._d)]
    dom = R._dom
    if len(vs) > 1:
        raise NotImplementedError("multivariate factorization over finite fields is not available in sagebrush yet")
    if not vs:
        return MPolyFactorization([], dom._out(next(iter(f._d.values()))), R)
    i = vs[0]
    U = f.univariate_polynomial()
    F = U.factor()
    items = [(R(g), int(e)) for g, e in F]
    return MPolyFactorization(items, F.unit(), R)


# ------------------------------------------------------------------ fractions

class _FractionField:
    """The fraction field of a multivariate polynomial ring."""

    def __init__(self, R):
        self._R = R

    def __repr__(self):
        return "Fraction Field of %r" % (self._R,)

    def __eq__(self, o):
        return isinstance(o, _FractionField) and o._R == self._R

    def __hash__(self):
        return hash(("Frac", self._R))

    def __call__(self, num, den=None):
        """The fraction num/den.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.fraction_field()(x, x*y)
            1/y
        """
        R = self._R
        if isinstance(num, MFraction) and den is None:
            return num
        num = R(num) if not isinstance(num, MPolynomial) else num
        den = R.one() if den is None else (R(den) if not isinstance(den, MPolynomial) else den)
        return MFraction(num, den)

    def ring(self):
        """The polynomial ring.

        EXAMPLES::

            sage: QQ['x,y'].fraction_field().ring()
            Multivariate Polynomial Ring in x, y over Rational Field
        """
        return self._R

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: QQ['x,y'].fraction_field().base_ring()
            Rational Field
        """
        return self._R._base

    def gens(self):
        """The variables.

        EXAMPLES::

            sage: QQ['x,y'].fraction_field().gens()
            (x, y)
        """
        return tuple(self(g) for g in self._R.gens())


def _quotient(a, b):
    """a / b for numbers (exactly) or polynomials."""
    if isinstance(a, (MPolynomial, MFraction)) or isinstance(b, (MPolynomial, MFraction)):
        if isinstance(b, MPolynomial) and b.is_constant() and isinstance(a, MPolynomial):
            return a / b.constant_coefficient()
        if not isinstance(a, (MPolynomial, MFraction)):
            return b._ring(a) / b if isinstance(b, MPolynomial) else b._coerce(a) / b
        return a / b
    try:
        q = _F(a) / _F(b)
    except (TypeError, ValueError):
        return a / b
    from _sage_poly import _norm
    return _norm(q)


class MFraction:
    """A quotient of multivariate polynomials, in lowest terms.

    EXAMPLES::

        sage: R.<x0,x1,x2> = QQ[]
        sage: h = (x0 + x1 - 2*x1*x2) / (x1 + x2); h
        (-2*x1*x2 + x0 + x1)/(x1 + x2)
        sage: h(1, 2, 3)
        -9/5
    """

    __slots__ = ("_num", "_den")

    def __init__(self, num, den, reduce=True):
        if not den._d:
            raise ZeroDivisionError("fraction field element division by zero")
        if reduce:
            g = _gcd(num, den)
            if not g.is_constant():
                num, den = _exact_div(num, g), _exact_div(den, g)
            # the denominator monic (over a field)
            R = num._ring
            dom = R._dom
            if not dom.generic or True:
                lc = den._leading()[1]
                if R._base is not _sa().ZZ and lc != dom.one:
                    il = dom._inv(lc)
                    num = MPolynomial(R, {e: dom._mul(c, il) for e, c in num._d.items()})
                    den = MPolynomial(R, {e: dom._mul(c, il) for e, c in den._d.items()})
        self._num, self._den = num, den

    def numerator(self):
        """The numerator.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x/y).numerator()
            x
        """
        return self._num

    def denominator(self):
        """The denominator.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x/y).denominator()
            y
        """
        return self._den

    def parent(self):
        """The fraction field.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x/y).parent()
            Fraction Field of Multivariate Polynomial Ring in x, y over Rational Field
        """
        return _FractionField(self._num._ring)

    def __repr__(self):
        if self._den == 1:
            return repr(self._num)
        # as Sage: parentheses unless atomic (a numerator without + or -,
        # a denominator without + - * /)
        n, d = repr(self._num), repr(self._den)
        if "+" in n or "-" in n:
            n = "(" + n + ")"
        if any(c in d for c in "+-*/"):
            d = "(" + d + ")"
        return n + "/" + d

    def _coerce(self, o):
        if isinstance(o, MFraction):
            return o
        R = self._num._ring
        if isinstance(o, MPolynomial):
            return MFraction(o, R.one(), False)
        try:
            return MFraction(R(o), R.one(), False)
        except (TypeError, ValueError):
            return None

    def __add__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return MFraction(self._num * o._den + o._num * self._den, self._den * o._den)

    __radd__ = __add__

    def __neg__(self):
        return MFraction(-self._num, self._den, False)

    def __sub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return self + (-o)

    def __rsub__(self, o):
        return (-self) + o

    def __mul__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return MFraction(self._num * o._num, self._den * o._den)

    __rmul__ = __mul__

    def __truediv__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return MFraction(self._num * o._den, self._den * o._num)

    def __rtruediv__(self, o):
        o = self._coerce(o)
        return o / self

    def __pow__(self, n):
        n = int(n)
        if n < 0:
            return MFraction(self._den ** (-n), self._num ** (-n))
        return MFraction(self._num ** n, self._den ** n, False)

    def __eq__(self, o):
        o = self._coerce(o)
        if o is None:
            return False
        return self._num * o._den == o._num * self._den

    def __hash__(self):
        return hash((self._num, self._den))

    def __call__(self, *args, **kwds):
        """Evaluate (or substitute).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; ((x + 1)/y)(1, 4), ((x + 1)/y)(y=2)
            (1/2, 1/2*x + 1/2)
        """
        a, b = self._num(*args, **kwds), self._den(*args, **kwds)
        return _quotient(a, b)

    def subs(self, *args, **kwds):
        """Substitute values for some variables.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (x/y).subs(x=y^2)
            y
        """
        return _quotient(self._num.subs(*args, **kwds), self._den.subs(*args, **kwds))

    def derivative(self, v):
        """The derivative in a variable.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; (1/x).derivative(x)
            (-1)/x^2
        """
        n, d = self._num, self._den
        return MFraction(n.derivative(v) * d - n * d.derivative(v), d * d)

    diff = derivative


# ------------------------------------------------------------------ Groebner bases

def _monic(f):
    return _normalize_unit(f) if f._ring._base is not _sa().ZZ else f


def _spoly(f, g):
    R = f._ring
    dom = R._dom
    (ef, cf), (eg, cg) = f._leading(), g._leading()
    l = tuple(max(a, b) for a, b in zip(ef, eg))
    mf = tuple(a - b for a, b in zip(l, ef))
    mg = tuple(a - b for a, b in zip(l, eg))
    d = {}
    icf, icg = dom._inv(cf), dom._inv(cg)
    for e, c in f._d.items():
        t = tuple(a + b for a, b in zip(e, mf))
        d[t] = dom._mul(c, icf)
    for e, c in g._d.items():
        t = tuple(a + b for a, b in zip(e, mg))
        v = dom._sub(d.get(t, dom.zero), dom._mul(c, icg))
        d[t] = v
    return MPolynomial(R, d)


def _lcm_e(a, b):
    return tuple(max(x, y) for x, y in zip(a, b))


def _divides_e(a, b):
    return all(x <= y for x, y in zip(a, b))


def _int_primitive(d):
    """A dict of integer coefficients divided by its content, with a
    positive leading coefficient left to the caller."""
    g = 0
    for c in d.values():
        g = math.gcd(g, c)
        if g == 1:
            return d
    if g > 1:
        return {e: c // g for e, c in d.items()}
    return d


def _int_reduce(f, G, lead, flat):
    """The fraction-free normal form of the integer dict f by the integer
    dicts G (leading terms lead): primitive, up to a rational factor."""
    import heapq
    neg = lambda e: tuple(-x for x in flat(e))
    p = dict(f)
    heap = [(neg(e), e) for e in p]
    heapq.heapify(heap)
    r = {}
    steps = 0
    while heap:
        _, e = heapq.heappop(heap)
        c = p.get(e)
        if c is None:
            continue
        for j, (le, lc) in enumerate(lead):
            if all(x >= y for x, y in zip(e, le)):
                m = tuple(x - y for x, y in zip(e, le))
                gg = math.gcd(lc, c)
                a, b = lc // gg, c // gg
                if a != 1:
                    if a == -1:
                        p = {t: -v for t, v in p.items()}
                        r = {t: -v for t, v in r.items()}
                    else:
                        p = {t: a * v for t, v in p.items()}
                        r = {t: a * v for t, v in r.items()}
                for ge, gc in G[j].items():
                    t = tuple(x + y for x, y in zip(ge, m))
                    old = p.get(t)
                    v = (old or 0) - b * gc
                    if v:
                        if old is None:
                            heapq.heappush(heap, (neg(t), t))
                        p[t] = v
                    elif old is not None:
                        del p[t]
                steps += 1
                if steps % 16 == 0:
                    # keep the coefficients small
                    g = 0
                    for v in p.values():
                        g = math.gcd(g, v)
                    for v in r.values():
                        g = math.gcd(g, v)
                    if g > 1:
                        p = {t: v // g for t, v in p.items()}
                        r = {t: v // g for t, v in r.items()}
                break
        else:
            r[e] = c
            del p[e]
    return _int_primitive(r)


def _groebner_int(F, R):
    """Buchberger over QQ with integer (fraction-free) polynomials."""
    key = R._key
    flat = R._flat
    G, lead, sugar = [], [], []
    P = []

    def lt(d):
        e = max(d, key=key)
        return e, d[e]

    def update(h, sh):
        nonlocal P
        eh, ch = lt(h)
        if ch < 0:
            h = {t: -v for t, v in h.items()}
            ch = -ch
        lms = [l[0] for l in lead]
        C = list(range(len(G)))
        D = []
        while C:
            i = C.pop(0)
            li = _lcm_e(lms[i], eh)
            if _is_coprime(lms[i], eh) or not any(_divides_e(_lcm_e(lms[j], eh), li) for j in C + D):
                D.append(i)
        k = len(G)
        newp = []
        for i in D:
            if _is_coprime(lms[i], eh):
                continue
            l = _lcm_e(lms[i], eh)
            newp.append((max(sugar[i] + sum(l) - sum(lms[i]), sh + sum(l) - sum(eh)), l, i, k))
        P = [t for t in P if not (_divides_e(eh, t[1]) and _lcm_e(lms[t[2]], eh) != t[1] and _lcm_e(lms[t[3]], eh) != t[1])] + newp
        G.append(h)
        lead.append((eh, ch))
        sugar.append(sh)

    for f in F:
        if not f._d:
            continue
        den = 1
        for c in f._d.values():
            den = den * c.denominator // math.gcd(den, c.denominator)
        d = _int_primitive({e: int(c * den) for e, c in f._d.items()})
        r = _int_reduce(d, G, lead, flat) if G else d
        if r:
            update(r, max(sum(e) for e in r))
    while P:
        best = min(range(len(P)), key=lambda t: (P[t][0], flat(P[t][1])))
        s_, l, i, j = P.pop(best)
        (ei, ci), (ej, cj) = lead[i], lead[j]
        g = math.gcd(ci, cj)
        a, b = cj // g, ci // g
        mi = tuple(x - y for x, y in zip(l, ei))
        mj = tuple(x - y for x, y in zip(l, ej))
        sp = {}
        for e, c in G[i].items():
            sp[tuple(x + y for x, y in zip(e, mi))] = a * c
        for e, c in G[j].items():
            t = tuple(x + y for x, y in zip(e, mj))
            v = sp.get(t, 0) - b * c
            if v:
                sp[t] = v
            elif t in sp:
                del sp[t]
        if not sp:
            continue
        r = _int_reduce(sp, G, lead, flat)
        if r:
            update(r, max(s_, max(sum(e) for e in r)))
    return _reduce_basis([MPolynomial(R, {e: _F(c) for e, c in g.items()}) for g in G], R)


def groebner_basis(F, R):
    """A reduced Groebner basis of the ideal generated by F (over a field):
    Buchberger's algorithm, normal selection strategy, the Gebauer-Moeller
    criteria to discard useless pairs.

    EXAMPLES::

        sage: from _sage_mpoly import groebner_basis  # sagebrush only
        sage: R.<x,y> = QQ[]; groebner_basis([x^2 - y, x*y - 1], R)  # sagebrush only
        [x^2 - y, x*y - 1, y^2 - x]
    """
    if R._dom.p is None and not R._dom.generic:
        return _groebner_int([R(f) if not isinstance(f, MPolynomial) else f for f in F], R)
    key = R._key
    G = []
    P = []  # pairs (sugar, lcm, i, j)

    sugar = []

    def update(h, sh):
        # Gebauer-Moeller: of the new pairs (g_i, h) keep one per minimal
        # lcm, then drop those with coprime leading monomials (Buchberger's
        # product criterion); drop old pairs (g_i, g_j) whose lcm is a
        # multiple of lm(h) with lcm(g_i, h), lcm(g_j, h) both different
        nonlocal P
        eh = h._leading()[0]
        lms = [g._leading()[0] for g in G]
        C = list(range(len(G)))
        D = []
        while C:
            i = C.pop(0)
            li = _lcm_e(lms[i], eh)
            if _is_coprime(lms[i], eh) or not any(_divides_e(_lcm_e(lms[j], eh), li) for j in C + D):
                D.append(i)
        k = len(G)
        newp = []
        for i in D:
            if _is_coprime(lms[i], eh):
                continue
            l = _lcm_e(lms[i], eh)
            # the sugar of the S-polynomial
            s_ = max(sugar[i] + sum(l) - sum(lms[i]), sh + sum(l) - sum(eh))
            newp.append((s_, l, i, k))
        kept = []
        for t in P:
            s_, l, i, j = t
            if _divides_e(eh, l) and _lcm_e(lms[i], eh) != l and _lcm_e(lms[j], eh) != l:
                continue
            kept.append(t)
        P = kept + newp
        G.append(h)
        sugar.append(sh)

    for f in F:
        f = R(f) if not isinstance(f, MPolynomial) else f
        if not f._d:
            continue
        r = _divide(f, G, False)[1] if G else f
        if r._d:
            update(_monic(r), max(sum(e) for e in r._d))
    import heapq
    flat = R._flat
    while P:
        # the normal strategy refined by the sugar degree
        best = min(range(len(P)), key=lambda t: (P[t][0], flat(P[t][1])))
        s_, l, i, j = P.pop(best)
        sp = _spoly(G[i], G[j])
        if not sp._d:
            continue
        r = _divide(sp, G, False)[1]
        if r._d:
            update(_monic(r), max(s_, max(sum(e) for e in r._d)))
    return _reduce_basis(G, R)


def _is_coprime(a, b):
    return all(x == 0 or y == 0 for x, y in zip(a, b))


def _reduce_basis(G, R):
    """The reduced Groebner basis from a Groebner basis."""
    key = R._key
    G = sorted(G, key=lambda g: key(g._leading()[0]))
    minimal = []
    for g in G:
        e = g._leading()[0]
        if not any(_divides_e(h._leading()[0], e) for h in minimal):
            minimal = [h for h in minimal if not _divides_e(e, h._leading()[0])]
            minimal.append(g)
    out = []
    for k, g in enumerate(minimal):
        others = minimal[:k] + minimal[k + 1:]
        lt = g._leading()
        rest = MPolynomial(R, {e: c for e, c in g._d.items() if e != lt[0]})
        r = _divide(rest, others, False)[1] if others else rest
        d = dict(r._d)
        d[lt[0]] = lt[1]
        out.append(_monic(MPolynomial(R, d)))
    # Sage lists the basis by decreasing leading monomial
    out.sort(key=lambda g: key(g._leading()[0]), reverse=True)
    return out


class PolynomialSequence(list):
    """An immutable sequence of polynomials (Sage's PolynomialSequence),
    e.g. a Groebner basis.

    EXAMPLES::

        sage: R.<x,y> = QQ[]; B = R.ideal(x^2 - y, x*y).groebner_basis(); B  # sagebrush only (the local Sage lacks Singular)
        [x^2 - y, x*y, y^2]
        sage: B.universe()  # sagebrush only (the local Sage lacks Singular)
        Multivariate Polynomial Ring in x, y over Rational Field
    """

    def __init__(self, ring, items):
        super().__init__(items)
        self._ring = ring

    def universe(self):
        """The ring of the polynomials.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x).groebner_basis().universe()  # sagebrush only (the local Sage lacks Singular)
            Multivariate Polynomial Ring in x, y over Rational Field
        """
        return self._ring

    ring = universe

    def __setitem__(self, i, v):
        raise ValueError("object is immutable; please change a copy instead.")

    def ideal(self):
        """The ideal they generate.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x, y).groebner_basis().ideal()  # sagebrush only (the local Sage lacks Singular)
            Ideal (x, y) of Multivariate Polynomial Ring in x, y over Rational Field
        """
        return MPolynomialIdeal(self._ring, list(self))

    def is_groebner(self):
        """True: a Groebner basis.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x^2, x*y).groebner_basis().is_groebner()  # sagebrush only (the local Sage lacks Singular)
            True
        """
        return True


# ------------------------------------------------------------------ ideals

class MPolynomialIdeal:
    """An ideal of a multivariate polynomial ring.

    EXAMPLES::

        sage: R.<x,y> = QQ[]
        sage: f = (x^3 + 2*y^2*x)^2; g = x^2*y^2
        sage: I = (f, g)*R; I
        Ideal (x^6 + 4*x^4*y^2 + 4*x^2*y^4, x^2*y^2) of Multivariate Polynomial Ring in x, y over Rational Field
        sage: I.groebner_basis(), x^2 in I  # sagebrush only (the local Sage lacks Singular)
        ([x^6, x^2*y^2], False)
    """

    def __init__(self, ring, gens):
        self._ring = ring
        self._gens = [g for g in gens]
        self._gb = None

    def __repr__(self):
        return "Ideal (%s) of %r" % (", ".join(repr(g) for g in self._gens), self._ring)

    def _latex_(self):
        return "\\left(%s\\right)" % ", ".join(g._latex_() for g in self._gens)

    def ring(self):
        """The ambient ring.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x).ring()
            Multivariate Polynomial Ring in x, y over Rational Field
        """
        return self._ring

    def gens(self):
        """The generators.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x, y^2).gens()
            [x, y^2]
        """
        return PolynomialSequence(self._ring, self._gens)

    def gen(self, i):
        """The i-th generator.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x, y^2).gen(1)
            y^2
        """
        return self._gens[i]

    def ngens(self):
        """The number of generators.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x, y^2).ngens()
            2
        """
        return _sa().Integer(len(self._gens))

    def _field_ring(self):
        R = self._ring
        if R._base is _sa().ZZ:
            return R.change_ring(_sa().QQ)
        return R

    def groebner_basis(self, algorithm=None, deg_bound=None, mult_bound=None, prot=False, *args, **kwds):
        """The reduced Groebner basis (over a field; for ZZ, over QQ), by
        decreasing leading monomial as Sage lists it.

        EXAMPLES::

            sage: R = PolynomialRing(QQ, 2, 'ab', order='lp'); a, b = R.gens()
            sage: I = (a^2 - b^2 - 3, a - 2*b)*R
            sage: I.groebner_basis()  # sagebrush only (the local Sage lacks Singular)
            [a - 2*b, b^2 - 1]
        """
        if self._gb is None:
            S = self._field_ring()
            G = groebner_basis([MPolynomial(S, g._d) for g in self._gens], S)
            if S is not self._ring:
                G = [MPolynomial(self._ring, _primitive_int(g)._d) for g in G]
            self._gb = PolynomialSequence(self._ring, G)
        return self._gb

    def basis_is_groebner(self):
        """Whether the generators are a Groebner basis.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x, y).basis_is_groebner()  # sagebrush only (the local Sage lacks Singular)
            True
        """
        G = self.groebner_basis()
        lms = [g._leading()[0] for g in G]
        mine = [g._leading()[0] for g in self._gens if g._d]
        return all(any(_divides_e(m, e) for m in mine) for e in lms)

    def reduce(self, f):
        """The normal form of f modulo the ideal (by the reduced Groebner
        basis).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; I = R.ideal(x^2 - y)
            sage: I.reduce(x^3 + x)  # sagebrush only (the local Sage lacks Singular)
            x*y + x
        """
        R = self._ring
        f = R(f)
        G = self.groebner_basis()
        if R._base is _sa().ZZ:
            S = self._field_ring()
            return MPolynomial(R, _divide(MPolynomial(S, f._d), [MPolynomial(S, g._d) for g in G])[1]._d)
        return _divide(f, list(G))[1]

    normal_form = reduce

    def __contains__(self, f):
        try:
            f = self._ring(f)
        except (TypeError, ValueError):
            return False
        return not self.reduce(f)._d

    def __eq__(self, o):
        if not isinstance(o, MPolynomialIdeal):
            return False
        return o._ring == self._ring and list(self.groebner_basis()) == list(o.groebner_basis())

    def __hash__(self):
        return hash(tuple(self.groebner_basis()))

    def __le__(self, o):
        return all(g in o for g in self._gens)

    def __add__(self, o):
        if isinstance(o, MPolynomialIdeal):
            return MPolynomialIdeal(self._ring, self._gens + o._gens)
        return NotImplemented

    def __mul__(self, o):
        if isinstance(o, MPolynomialIdeal):
            return MPolynomialIdeal(self._ring, [a * b for a in self._gens for b in o._gens])
        return NotImplemented

    def __pow__(self, n):
        r = MPolynomialIdeal(self._ring, [self._ring.one()])
        for _ in range(int(n)):
            r = r * self
        return r

    def is_zero(self):
        """Whether this is the zero ideal.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(R(0)).is_zero(), R.ideal(x).is_zero()
            (True, False)
        """
        return all(not g._d for g in self._gens)

    def is_one(self):
        """Whether this is the unit ideal.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x, x + 1).is_one()  # sagebrush only (the local Sage lacks Singular)
            True
        """
        return 1 in self

    def dimension(self, singular=None):
        """The Krull dimension of R/I: the largest set of variables with no
        leading monomial of the Groebner basis in them alone.

        EXAMPLES::

            sage: R.<x,y,z> = QQ[]
            sage: R.ideal(x*y, z).dimension(), R.ideal(x - 1, y - 2, z).dimension()  # sagebrush only (the local Sage lacks Singular)
            (1, 0)
        """
        G = self.groebner_basis()
        R = self._ring
        if any(g.is_constant() and g._d for g in G):
            return _sa().Integer(-1)
        lms = [g._leading()[0] for g in G]
        n = R._n
        from itertools import combinations
        for k in range(n, -1, -1):
            for S in combinations(range(n), k):
                Sset = set(S)
                # S is independent if no leading monomial uses only variables in S
                if not any(all(i in Sset for i in range(n) if e[i]) for e in lms):
                    return _sa().Integer(k)
        return _sa().Integer(0)

    krull_dimension = dimension

    def vector_space_dimension(self):
        """The dimension of R/I over the base field (zero-dimensional I).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x^2 - 1, y^3 - x).vector_space_dimension()  # sagebrush only (the local Sage lacks Singular)
            6
        """
        return _sa().Integer(len(self.normal_basis()))

    def normal_basis(self):
        """The standard monomials (those not divisible by a leading monomial
        of the Groebner basis), for a zero-dimensional ideal.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x^2, y^2).normal_basis()  # sagebrush only (the local Sage lacks Singular)
            [x*y, x, y, 1]
        """
        G = self.groebner_basis()
        R = self._ring
        if self.dimension() != 0:
            raise ValueError("the ideal is not zero-dimensional")
        lms = [g._leading()[0] for g in G]
        n = R._n
        bounds = []
        for i in range(n):
            b = min(e[i] for e in lms if sum(1 for t in e if t) == 1 and e[i])
            bounds.append(b)
        out = []

        def rec(i, e):
            if i == n:
                t = tuple(e)
                if not any(_divides_e(m, t) for m in lms):
                    out.append(t)
                return
            for k in range(bounds[i]):
                rec(i + 1, e + [k])
        rec(0, [])
        out.sort(key=R._key, reverse=True)
        return [MPolynomial(R, {e: R._dom.one}) for e in out]

    def elimination_ideal(self, variables):
        """The ideal intersected with the polynomials in the other variables
        (by a Groebner basis for an elimination order).

        EXAMPLES::

            sage: R.<x,y,z> = QQ[]; I = R.ideal(x - y^2, y - z)
            sage: I.elimination_ideal([y])  # sagebrush only (the local Sage lacks Singular)
            Ideal (z^2 - x) of Multivariate Polynomial Ring in x, y, z over Rational Field
        """
        R = self._ring
        if not isinstance(variables, (list, tuple)):
            variables = [variables]
        el = [R._var_index(v) for v in variables]
        rest = [i for i in range(R._n) if i not in el]
        perm = el + rest
        S = MPolynomialRing(self._field_ring()._base, None, tuple(R._names[i] for i in perm), "lex")
        def to_S(f):
            return MPolynomial(S, {tuple(e[i] for i in perm): c for e, c in f._d.items()})
        def from_S(f):
            d = {}
            for e, c in f._d.items():
                t = [0] * R._n
                for k, i in enumerate(perm):
                    t[i] = e[k]
                d[tuple(t)] = c
            return MPolynomial(R, d)
        G = groebner_basis([to_S(g) for g in self._gens], S)
        keep = [from_S(g) for g in G if all(e[k] == 0 for e in g._d for k in range(len(el)))]
        keep = groebner_basis(keep, R) if keep else []
        return MPolynomialIdeal(R, keep)

    def intersection(self, *others):
        """The intersection with other ideals.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x).intersection(R.ideal(y))  # sagebrush only (the local Sage lacks Singular)
            Ideal (x*y) of Multivariate Polynomial Ring in x, y over Rational Field
        """
        R = self._ring
        cur = self
        for J in others:
            T = MPolynomialRing(self._field_ring()._base, None, ("_t",) + R._names, R._order)
            t = T.gen(0)
            lift = lambda f: MPolynomial(T, {(0,) + e: c for e, c in f._d.items()})
            gens = [t * lift(f) for f in cur._gens] + [(1 - t) * lift(g) for g in J._gens]
            E = MPolynomialIdeal(T, gens).elimination_ideal([t])
            cur = MPolynomialIdeal(R, [MPolynomial(R, {e[1:]: c for e, c in g._d.items()}) for g in E._gens])
        return cur

    def quotient(self, J):
        """The colon ideal (self : J).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x*y, x^2).quotient(R.ideal(x))  # sagebrush only (the local Sage lacks Singular)
            Ideal (x, y) of Multivariate Polynomial Ring in x, y over Rational Field
        """
        R = self._ring
        res = None
        for g in J._gens:
            if not g._d:
                continue
            K = self.intersection(MPolynomialIdeal(R, [g]))
            Q = MPolynomialIdeal(R, [_exact_div(h, g) for h in K._gens])
            res = Q if res is None else res.intersection(Q)
        if res is None:
            return MPolynomialIdeal(R, [R.one()])
        return MPolynomialIdeal(R, list(res.groebner_basis()))

    def radical(self):
        """The radical, for a zero-dimensional ideal (adding the squarefree
        parts of the univariate eliminants).

        EXAMPLES::

            sage: R.<x,y> = QQ[]; R.ideal(x^2, y^2).radical()  # sagebrush only (the local Sage lacks Singular)
            Ideal (x, y) of Multivariate Polynomial Ring in x, y over Rational Field
        """
        R = self._ring
        if self.dimension() != 0:
            raise NotImplementedError("radical of a positive-dimensional ideal is not available in sagebrush yet")
        gens = list(self._gens)
        for i in range(R._n):
            others = [R.gen(j) for j in range(R._n) if j != i]
            E = self.elimination_ideal(others)
            for g in E._gens:
                if g._d and not g.is_constant():
                    sq = _exact_div(g, _gcd(g, g.derivative(R.gen(i))))
                    gens.append(sq)
        return MPolynomialIdeal(R, list(MPolynomialIdeal(R, gens).groebner_basis()))

    def variety(self, ring=None):
        """The points of a zero-dimensional ideal over the base field (or
        ring), as a list of dicts {variable: value}.

        EXAMPLES::

            sage: R.<x,y> = QQ[]; I = R.ideal(x^2 - 1, y - x)
            sage: I.variety()  # sagebrush only (the local Sage lacks Singular)
            [{y: -1, x: -1}, {y: 1, x: 1}]
        """
        R = self._ring
        if self.dimension() != 0:
            raise ValueError("The dimension of the ideal is %d, but it should be 0" % self.dimension())
        L = MPolynomialRing(self._field_ring()._base, None, R._names, "lex")
        G = groebner_basis([MPolynomial(L, g._d) for g in self._gens], L)
        n = R._n
        sols = [dict()]
        for i in range(n - 1, -1, -1):
            new = []
            for s in sols:
                # polynomials in variables i..n-1 only, with variable i
                vals = list(L.gens())
                for j, v in s.items():
                    vals[j] = v
                cands = None
                for g in G:
                    if any(any(e[k] for k in range(i)) for e in g._d):
                        continue
                    h = _evaluate(g, vals) if s else g
                    if not isinstance(h, MPolynomial):
                        if h != 0:
                            cands = []
                            break
                        continue
                    if not h._d:
                        continue
                    if h.is_constant():
                        cands = []
                        break
                    rts = set(_roots_in(h, i, ring if ring is not None else R._base))
                    cands = rts if cands is None else cands & rts
                for r in sorted(cands or [], key=_sortkey):
                    t = dict(s)
                    t[i] = r
                    new.append(t)
            sols = new
        gens = R.gens()
        out = []
        for s in sols:
            out.append({gens[i]: s[i] for i in range(n - 1, -1, -1)})
        out.sort(key=lambda d: [_sortkey(d[g]) for g in reversed(gens)])
        return out



def _sortkey(v):
    try:
        return (0, float(v), 0)
    except (TypeError, ValueError):
        try:
            z = complex(v)
            return (1, z.real, z.imag)
        except (TypeError, ValueError):
            return (2, repr(v), 0)


def _roots_in(h, i, ring):
    """The roots in ring of the univariate polynomial h in variable i."""
    U = h.univariate_polynomial()
    return [r for r, _ in U.roots(ring)] if ring is not None else [r for r, _ in U.roots()]


def ideal(*gens):
    """The ideal generated by the given polynomials.

    EXAMPLES::

        sage: R.<a,b,c> = QQ[]
        sage: ideal(a, b^2, b^3 + c^3)
        Ideal (a, b^2, b^3 + c^3) of Multivariate Polynomial Ring in a, b, c over Rational Field
    """
    if len(gens) == 1 and isinstance(gens[0], (list, tuple)):
        gens = gens[0]
    gens = list(gens)
    for g in gens:
        if isinstance(g, MPolynomial):
            return g._ring.ideal(gens)
        if hasattr(g, "parent") and hasattr(g.parent(), "ideal"):
            return g.parent().ideal(*gens)
    raise TypeError("cannot make an ideal of %r" % (gens,))


Ideal = ideal
