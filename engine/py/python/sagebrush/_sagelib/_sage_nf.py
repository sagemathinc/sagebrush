"""Number fields as in Sage: NumberField, QuadraticField, their elements,
prime ideals, class groups, unit groups, regulators and integral bases,
computed by the Rust engine (sagebrush.nf: engine/classgroup, clean-room,
MIT/Apache).  Printed as Sage prints them.  Class groups and regulators
assume GRH (as Sage's default proof=False results and PARI's do)."""

from fractions import Fraction as _F
import functools as _ft


def _sa():
    import sage_all
    return sage_all


def _nf():
    from sagebrush import nf
    return nf


def _q(c):
    """A coefficient for printing: int or a Sage Rational."""
    f = _F(c)
    if f.denominator == 1:
        return int(f.numerator)
    return _sa().Rational._from_coprime_ints(f.numerator, f.denominator)


def _repr_poly(coeffs, name):
    from _sage_modular import _poly_repr
    c = [_q(x) for x in coeffs]
    while c and c[-1] == 0:
        c.pop()
    return _poly_repr(c, name) if c else "0"


def _int_coeffs(f):
    """The integer coefficients (constant first) of a polynomial given as a
    Sage-style Polynomial, a list, or a symbolic expression in x."""
    from _sage_poly import Polynomial
    if isinstance(f, Polynomial):
        c = [_F(a) for a in f.list()]
        name = f.variable_name()
    elif isinstance(f, (list, tuple)):
        c = [_F(a) for a in f]
        name = "x"
    else:
        # a symbolic expression: as a polynomial in its variable
        try:
            p = f.polynomial(_sa().QQ) if hasattr(f, "polynomial") else _sa().QQ["x"](f)
            c = [_F(a) for a in p.list()]
            name = p.variable_name()
        except Exception:
            raise TypeError("cannot make a number field from %r" % (f,))
    if any(a.denominator != 1 for a in c):
        raise NotImplementedError("defining polynomials must have integer coefficients")
    c = [int(a) for a in c]
    if not c or c[-1] != 1:
        raise NotImplementedError("defining polynomials must be monic (for now)")
    return c, name


class NumberField_absolute:
    """K = Q[x]/(f), f monic with integer coefficients, irreducible.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K = NumberField(x^2 - 2, 'a'); K
        Number Field in a with defining polynomial x^2 - 2
        sage: type(K).__name__  # sagebrush only
        'NumberField_absolute'
    """

    _element_class = None  # NumberFieldElement (set below; subclasses override)

    def __init__(self, f, name, embedding_repr=None):
        self._f, self._var = _int_coeffs(f)
        if len(self._f) < 2:
            raise ValueError("the defining polynomial must have degree at least 1")
        if not _nf_irreducible(tuple(self._f)):
            raise ValueError("defining polynomial (%s) must be irreducible" % _repr_poly(self._f, self._var))
        self._name = name
        self._n = len(self._f) - 1
        self._emb = embedding_repr
        self._data = None
        self._bnf = None

    # ---- naming and printing
    def __repr__(self):
        n = getattr(self, "_cyclotomic_order", None)
        if n is not None:
            return "Cyclotomic Field of order %d and degree %d" % (n, len(self._f) - 1)
        s = "Number Field in %s with defining polynomial %s" % (self._name, _repr_poly(self._f, self._var))
        return s + (" with %s = %s" % (self._name, self._emb) if self._emb else "")

    def _first_ngens(self, k):
        return (self.gen(),)[:k]

    def gen(self, i=0):
        """The generator (the class of x).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').gen()
            a
        """
        if i != 0:
            raise IndexError("only one generator")
        return self([0, 1])

    def gens(self):
        """The generators (a 1-tuple).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').gens()
            (a,)
        """
        return (self.gen(),)

    def variable_name(self):
        """The name of the generator.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').variable_name()
            'a'
        """
        return self._name

    def __call__(self, x):
        """Convert a number, a list of coefficients or a polynomial into the field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 2)
            sage: K(3), K([1, 2]), K(x^2 + x)
            (3, 2*a + 1, a + 2)
        """
        if isinstance(x, NumberFieldElement):
            if x._K is not self:
                raise TypeError("no coercion between different number fields")
            return x
        if isinstance(x, (list, tuple)):
            c = [_F(a) for a in x]
            c += [_F(0)] * (self._n - len(c))
            return self._element_class(self, _reduce(c, self._f))
        from _sage_poly import Polynomial
        if isinstance(x, Polynomial):
            return self(x.list())
        return self._element_class(self, [_F(x)] + [_F(0)] * (self._n - 1))

    def __eq__(self, other):
        return isinstance(other, NumberField_absolute) and other._f == self._f and other._name == self._name

    def __hash__(self):
        return hash((tuple(self._f), self._name))

    def __contains__(self, x):
        return isinstance(x, NumberFieldElement) and x._K is self

    # ---- invariants
    def degree(self):
        """The degree over QQ.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^5 - x - 1, 'a').degree()
            5
        """
        return self._n

    absolute_degree = degree

    def polynomial(self):
        """The defining polynomial.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').polynomial()
            x^3 - 2
        """
        return _sa().QQ[self._var](self._f)

    defining_polynomial = polynomial
    absolute_polynomial = polynomial

    def _nfdata(self):
        if self._data is None:
            self._data = _nf().nf_data(self._f)
        return self._data

    def discriminant(self):
        """The discriminant of the field (of its maximal order).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 5, 'a').discriminant(), NumberField(x^3 - 2, 'a').discriminant()
            (5, -108)
        """
        return self._nfdata()["disc"]

    disc = discriminant
    absolute_discriminant = discriminant

    def signature(self):
        """(r1, r2): the numbers of real and of pairs of complex embeddings.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').signature(), NumberField(x^4 - 2, 'a').signature()
            ((1, 1), (2, 1))
        """
        d = self._nfdata()
        return (d["r1"], d["r2"])

    def is_totally_real(self):
        """Whether every embedding is real.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 2, 'a').is_totally_real(), NumberField(x^3 - 2, 'a').is_totally_real()
            (True, False)
        """
        return self.signature()[1] == 0

    def is_totally_imaginary(self):
        """Whether no embedding is real.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 1, 'a').is_totally_imaginary(), NumberField(x^3 - 2, 'a').is_totally_imaginary()
            (True, False)
        """
        return self.signature()[0] == 0

    def galois_group(self, type=None, algorithm=None, names=None, proof=None):
        """The Galois group of the Galois closure (degree <= 13, or 17, 19, 23), computed by
        Sagebrush's engine/galois, as the transitive group nTk.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').galois_group()  # sagebrush only (the local Sage crashes here)
            Galois group 3T2 (S3) with order 6 of x^3 - 2
        """
        if getattr(self, "_galois", None) is None or (proof and not self._galois.proven):
            from sage_permgroup import galois_group
            G = galois_group(self._f, proof=proof)
            G._text = "Galois group %s (%s) with order %s of %s" % (G.transitive_label(), G.name(), G._order_str, _repr_poly(self._f, self._var))
            self._galois = G
        return self._galois

    def is_galois(self):
        """Whether the field is Galois over QQ.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').is_galois(), NumberField(x^3 - 3*x - 1, 'a').is_galois()  # sagebrush only (the local Sage crashes here)
            (False, True)
        """
        return int(self.galois_group()._order_str) == self._n

    def integral_basis(self):
        """A basis of the ring of integers (Sage's HNF basis).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 5, 'a').integral_basis()
            [1/2*a + 1/2, a]
            sage: NumberField(x^3 - 19, 'a').integral_basis()
            [1/3*a^2 + 1/3*a + 1/3, a, a^2]
        """
        d = self._nfdata()
        return [self([_F(c, d["den"]) for c in row]) for row in d["basis"]]

    def maximal_order(self):
        """The ring of integers.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: O = NumberField(x^2 - 5, 'a').maximal_order(); O
            Maximal Order generated by 1/2*a + 1/2 in Number Field in a with defining polynomial x^2 - 5
            sage: O.basis()
            [1/2*a + 1/2, a]
        """
        return Order(self)

    ring_of_integers = maximal_order

    def number_of_roots_of_unity(self):
        """The number of roots of unity in the field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 3, 'a').number_of_roots_of_unity(), NumberField(x^2 + 1, 'a').number_of_roots_of_unity()
            (6, 4)
        """
        return self._nfdata()["w"]

    def unit_group(self, proof=None):
        """The unit group (its rank and torsion; GRH for the regulator bound).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: U = NumberField(x^3 - 2, 'a').unit_group(); U
            Unit group with structure C2 x Z of Number Field in a with defining polynomial x^3 - 2
            sage: U.rank()
            1
        """
        return UnitGroup(self)

    def _bnfdata(self):
        if self._bnf is None:
            self._bnf = None
            if self._n == 2 and abs(self.discriminant()) >= 1000:
                # the quadratic algorithms are much faster
                h, cyc, reg = _nf().quadratic_class_group(self.discriminant())
                self._bnf = {"h": h, "cyc": cyc, "regulator": reg if reg is not None else "1"}
            else:
                self._bnf = _nf().bnf(self._f)
        return self._bnf

    def class_group(self, proof=None, names="c"):
        """The class group (assuming GRH, as Sage's default proof=False... see the engine).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 23, 'a').class_group()
            Class group of order 3 with structure C3 of Number Field in a with defining polynomial x^2 + 23
            sage: NumberField(x^3 - 11, 'a').class_group().invariants()
            (2,)
        """
        return ClassGroup(self)

    def class_number(self, proof=None):
        """The class number.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').class_number(), NumberField(x^2 + 163, 'a').class_number()
            (2, 1)
        """
        return self._bnfdata()["h"]

    def regulator(self, proof=None):
        """The regulator.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 2, 'a').regulator()  # abs tol 1e-12
            0.881373587019543
            sage: NumberField(x^3 - 11, 'a').regulator()  # abs tol 1e-10
            5.58720662606091
        """
        return _sa().RR(self._bnfdata()["regulator"])

    def unit_rank(self):
        """The rank of the unit group: r1 + r2 - 1.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^4 - 2, 'a').unit_rank()  # sagebrush only
            2
        """
        r1, r2 = self.signature()
        return r1 + r2 - 1

    # ---- ideals
    def ideal(self, *gens):
        """The ideal generated by the given elements.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: I = K.ideal(6); I
            Fractional ideal (6)
            sage: I.norm()
            36
        """
        if len(gens) == 1 and isinstance(gens[0], (list, tuple)):
            gens = tuple(gens[0])
        if len(gens) == 1 and not isinstance(gens[0], NumberFieldElement):
            n = _F(gens[0])
            if n.denominator == 1:
                return NumberFieldIdeal(self, int(n))
        raise NotImplementedError("only ideals generated by an integer are supported so far (and the prime ideals from primes_above)")

    fractional_ideal = ideal

    def primes_above(self, p, degree=None):
        """The prime ideals above p.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: K.primes_above(2), K.primes_above(3)
            ([Fractional ideal (2, a + 1)], [Fractional ideal (3, a + 1), Fractional ideal (3, a + 2)])
        """
        p = int(p)
        def pi(q):
            # the second generator with coefficients in [0, p) when it is in
            # Z[a] (as Sage shows quadratic fields' primes: (3, a + 2))
            cs = [_F(c, q["pi_den"]) for c in q["pi"]]
            if all(c.denominator == 1 for c in cs):
                cs = [c % q["p"] for c in cs]
            return self(cs)
        out = [PrimeIdeal(self, q["p"], q["e"], q["f"], pi(q)) for q in _primes_above(tuple(self._f), p)]
        out = _sort_primes(out)
        if degree is not None:
            out = [P for P in out if P.residue_class_degree() == degree]
        return out

    def prime_above(self, p, degree=None):
        """A prime ideal above p.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(7)
            Fractional ideal (7, a + 3)
        """
        return self.primes_above(p, degree)[0]

    def factor(self, n):
        """The factorization of the ideal (n).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').factor(6)
            (Fractional ideal (2, a + 1))^2 * (Fractional ideal (3, a + 1)) * (Fractional ideal (3, a + 2))
        """
        return self.ideal(n).factor()

    def prime_factors(self, n):
        """The prime ideals dividing (n).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_factors(6)
            [Fractional ideal (2, a + 1), Fractional ideal (3, a + 1), Fractional ideal (3, a + 2)]
        """
        return [P for P, _ in self.factor(n)]


@_ft.lru_cache(maxsize=256)
def _primes_above(f, p):
    return _nf().primes_above(list(f), p)


@_ft.lru_cache(maxsize=256)
def _nf_irreducible(f):
    from sagebrush import poly
    _, fs = poly.factor(list(f))
    return len(fs) == 1 and fs[0][1] == 1


def _sort_primes(ps):
    # Sage (PARI's idealprimedec) lists the primes above p by residue degree
    return sorted(ps, key=lambda P: (P._f, P._e))


def _reduce(c, f):
    """c (Fractions, constant first) modulo the monic f."""
    c = list(c)
    n = len(f) - 1
    for k in range(len(c) - 1, n - 1, -1):
        t = c[k]
        if t:
            for i in range(n):
                c[k - n + i] -= t * f[i]
        c[k] = _F(0)
    c = c[:n] + [_F(0)] * (n - len(c))
    return c


def _polmul(a, b):
    out = [_F(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                if y:
                    out[i + j] += x * y
    return out


def _poly_divmod(a, b):
    a = list(a)
    while a and a[-1] == 0:
        a.pop()
    b = list(b)
    while b and b[-1] == 0:
        b.pop()
    q = [_F(0)] * max(len(a) - len(b) + 1, 1)
    while len(a) >= len(b) and a:
        t = a[-1] / b[-1]
        k = len(a) - len(b)
        q[k] = t
        for i, y in enumerate(b):
            a[k + i] -= t * y
        while a and a[-1] == 0:
            a.pop()
    return q, a


class NumberFieldElement:
    """An element of a number field.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^3 - 2)
        sage: b = 1 + a + a^2/2; b
        1/2*a^2 + a + 1
        sage: b.norm(), b.trace(), b.minpoly()
        (1/2, 3, x^3 - 3*x^2 - 1/2)
    """
    __slots__ = ("_K", "_c")

    def __init__(self, K, c):
        self._K = K
        self._c = [_F(x) for x in c]

    def parent(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^3 - 2)
            sage: (a + 1).parent()
            Number Field in a with defining polynomial x^3 - 2
        """
        return self._K

    def list(self):
        """The coordinates on the power basis 1, a, a^2, ...

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^3 - 2)
            sage: (1 + 3*a^2).list()
            [1, 0, 3]
        """
        return [_q(x) for x in self._c]

    def __repr__(self):
        return _repr_poly(self._c, self._K._name)

    def _latex_(self):
        return repr(self).replace("*", "")

    def __hash__(self):
        if all(x == 0 for x in self._c[1:]):
            return hash(self._c[0])
        return hash(tuple(self._c))

    def __eq__(self, other):
        try:
            o = self._coerce(other)
        except TypeError:
            return False
        return o._c == self._c

    def _coerce(self, other):
        if isinstance(other, NumberFieldElement):
            if other._K is not self._K:
                raise TypeError("no coercion between different number fields")
            return other
        try:
            return self._K(other)
        except Exception:
            raise TypeError("cannot coerce %r into %r" % (other, self._K))

    def __add__(self, other):
        try:
            o = self._coerce(other)
        except TypeError:
            return NotImplemented
        return type(self)(self._K, [a + b for a, b in zip(self._c, o._c)])

    __radd__ = __add__

    def __neg__(self):
        return type(self)(self._K, [-a for a in self._c])

    def __sub__(self, other):
        try:
            o = self._coerce(other)
        except TypeError:
            return NotImplemented
        return type(self)(self._K, [a - b for a, b in zip(self._c, o._c)])

    def __rsub__(self, other):
        return (-self) + other

    def __mul__(self, other):
        try:
            o = self._coerce(other)
        except TypeError:
            return NotImplemented
        return type(self)(self._K, _reduce(_polmul(self._c, o._c), self._K._f))

    __rmul__ = __mul__

    def __invert__(self):
        # extended Euclid in Q[x]: s self + t f = 1
        """The inverse (also inverse()).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^3 - 2)
            sage: (1 + a).inverse(), ~(1 + a) * (1 + a)
            (1/3*a^2 - 1/3*a + 1/3, 1)
        """
        f = [_F(a) for a in self._K._f]
        r0, r1 = f, list(self._c)
        s0, s1 = [_F(0)], [_F(1)]
        while any(r1):
            q, r = _poly_divmod(r0, r1)
            r0, r1 = r1, r
            s0, s1 = s1, [a - b for a, b in _zip_pad(s0, _polmul(q, s1))]
        while r0 and r0[-1] == 0:
            r0.pop()
        if len(r0) != 1:
            raise ZeroDivisionError("division by zero in %r" % self._K)
        return type(self)(self._K, _reduce([c / r0[0] for c in s0], self._K._f))

    inverse = __invert__

    def __truediv__(self, other):
        try:
            o = self._coerce(other)
        except TypeError:
            return NotImplemented
        return self * ~o

    def __rtruediv__(self, other):
        return self._K(other) * ~self

    def __xor__(self, other):
        # plain Python (sagebrush.sage under CPython): ^ is xor, with the
        # wrong precedence; the Sage preparser (and pyjs) make it a power
        raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")

    def __pow__(self, e):
        e = int(e)
        if e < 0:
            return (~self) ** (-e)
        r = self._K(1)
        b = self
        while e:
            if e & 1:
                r = r * b
            b = b * b
            e >>= 1
        return r

    def __bool__(self):
        return any(self._c)

    def is_zero(self):
        """Whether the element is 0.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^3 - 2)
            sage: (a - a).is_zero(), a.is_zero()
            (True, False)
        """
        return not any(self._c)

    def matrix(self, public=True):
        """The matrix of multiplication by self on the power basis (rows: self*a^i).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 2)
            sage: (1 + a).matrix()
            [1 1]
            [2 1]
        """
        K = self._K
        rows = []
        x = self
        g = K.gen()
        for _ in range(K._n):
            rows.append(list(x._c))
            x = x * g
        from _sage_matrix import matrix as _matrix
        from sage_all import QQ
        return _matrix(QQ, rows) if public else rows

    def _matrix_rows(self):
        return self.matrix(public=False)

    def charpoly(self, var="x"):
        """The characteristic polynomial.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 2)
            sage: (1 + a).charpoly()
            x^2 - 2*x - 1
        """
        m = self._matrix_rows()
        n = len(m)
        # Faddeev-LeVerrier over Q
        import itertools
        c = [_F(0)] * (n + 1)
        c[n] = _F(1)
        M = [[_F(0)] * n for _ in range(n)]
        for k in range(1, n + 1):
            # M = A (M + c_{n-k+1} I)
            Mi = [[M[i][j] + (c[n - k + 1] if i == j else 0) for j in range(n)] for i in range(n)]
            M = [[sum(m[j][i] * Mi[j][l] for j in range(n)) for l in range(n)] for i in range(n)]
            c[n - k] = -sum(M[i][i] for i in range(n)) / k
        return _sa().QQ[var](c)

    def minpoly(self, var="x"):
        """The minimal polynomial.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^4 - 2)
            sage: (a^2).minpoly(), K(3).minpoly()
            (x^2 - 2, x - 3)
        """
        f = self.charpoly(var)
        for g, e in f.factor():
            if hasattr(g, "degree") and g.degree() > 0:
                if all(t == 0 for t in _eval_at(g, self)._c):
                    return g / g.leading_coefficient() if g.leading_coefficient() != 1 else g
        return f

    def norm(self):
        """The norm to QQ.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: (1 + a).norm()
            6
        """
        m = self._matrix_rows()
        return _q(_det(m))

    def trace(self):
        """The trace to QQ.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: (1 + a).trace()
            2
        """
        m = self._matrix_rows()
        return _q(sum(m[i][i] for i in range(len(m))))

    def is_integral(self):
        """Whether the element is an algebraic integer.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: ((1 + a)/2).is_integral(), (a/2).is_integral()
            (True, False)
        """
        return all(_F(a).denominator == 1 for a in self.charpoly().list())


NumberField_absolute._element_class = NumberFieldElement


def _eval_at(g, x):
    r = x._K(0)
    for c in reversed(g.list()):
        r = r * x + c
    return r


def _zip_pad(a, b):
    n = max(len(a), len(b))
    return zip(list(a) + [_F(0)] * (n - len(a)), list(b) + [_F(0)] * (n - len(b)))


def _det(m):
    m = [[_F(x) for x in row] for row in m]
    n = len(m)
    d = _F(1)
    for c in range(n):
        p = next((i for i in range(c, n) if m[i][c] != 0), None)
        if p is None:
            return _F(0)
        if p != c:
            m[c], m[p] = m[p], m[c]
            d = -d
        d *= m[c][c]
        for i in range(c + 1, n):
            f = m[i][c] / m[c][c]
            if f:
                for j in range(c, n):
                    m[i][j] -= f * m[c][j]
    return d


class Order:
    """An order of a number field (Sagebrush: the maximal order).

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: NumberField(x^2 - 5, 'a').ring_of_integers()
        Maximal Order generated by 1/2*a + 1/2 in Number Field in a with defining polynomial x^2 - 5
    """
    def __init__(self, K):
        self._K = K

    def __repr__(self):
        K = self._K
        f = K._f
        if f == [1, 0, 1]:
            return "Gaussian Integers generated by %s in %r" % (K._name, K)
        b = K.integral_basis()
        if f == [1, 1, 1] or (f == [3, 0, 1]):
            return "Eisenstein Integers generated by %s in %r" % (b[0] if f == [3, 0, 1] else K._name, K)
        if K._nfdata()["index"] == 1:
            return "Maximal Order generated by %s in %r" % (K._name, K)
        gens = _ring_generators(K, b)
        return "Maximal Order generated by %s in %r" % (repr(gens[0]) if len(gens) == 1 else "[%s]" % ", ".join(repr(x) for x in gens), K)

    def basis(self):
        """A Z-basis.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 5, 'a').maximal_order().basis()
            [1/2*a + 1/2, a]
        """
        return self._K.integral_basis()

    def discriminant(self):
        """The discriminant.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 5, 'a').maximal_order().discriminant()
            5
        """
        return self._K.discriminant()

    def number_field(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 5, 'a').maximal_order().number_field()
            Number Field in a with defining polynomial x^2 - 5
        """
        return self._K

    def degree(self):
        """The rank over ZZ.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^3 - 2, 'a').maximal_order().degree()
            3
        """
        return self._K.degree()

    def class_number(self, proof=None):
        """The class number of the maximal order.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').maximal_order().class_number()
            2
        """
        return self._K.class_number()


class NumberFieldIdeal:
    """The ideal generated by an integer.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^2 + 5)
        sage: K.ideal(6)
        Fractional ideal (6)
    """

    def __init__(self, K, n):
        self._K = K
        self._n = abs(int(n))

    def __repr__(self):
        return "Fractional ideal (%d)" % self._n

    def number_field(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: K.ideal(3).number_field()
            Number Field in a with defining polynomial x^2 + 5
        """
        return self._K

    def norm(self):
        """The absolute norm.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: K.ideal(3).norm(), K.ideal(7).norm()
            (9, 49)
        """
        return self._n ** self._K.degree()

    def gens(self):
        """Generators of the ideal.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: K.ideal(3).gens()
            (3,)
        """
        return (self._K(self._n),)

    def is_prime(self):
        """Whether the ideal is prime.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: K.ideal(2).is_prime(), K.ideal(3).is_prime(), K.ideal(7).is_prime()
            (False, False, False)
        """
        ps = self._K.primes_above(self._n) if self._n > 1 and _sa().is_prime(self._n) else []
        return len(ps) == 1 and ps[0]._e == 1

    def factor(self):
        """The factorization into prime ideals.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 + 5)
            sage: K.ideal(6).factor()
            (Fractional ideal (2, a + 1))^2 * (Fractional ideal (3, a + 1)) * (Fractional ideal (3, a + 2))
        """
        K = self._K
        if self._n == 0:
            raise ArithmeticError("factorization of 0 is not defined")
        out = []
        for p, e in _sa().factor(self._n):
            # Sage's factorizations list the primes above p by residue
            # degree, the larger first
            for P in sorted(K.primes_above(p), key=lambda P: (-P._f, -P._e)):
                out.append((P, P._e * e))
        return IdealFactorization(out)

    def __eq__(self, other):
        if isinstance(other, PrimeIdeal):
            return other == self
        return isinstance(other, NumberFieldIdeal) and other._K is self._K and other._n == self._n

    def __hash__(self):
        return hash(("ideal", self._n))


class PrimeIdeal:
    """A prime ideal P = (p, pi) of the maximal order.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: P = NumberField(x^2 + 5, 'a').prime_above(3); P
        Fractional ideal (3, a + 1)
        sage: P.norm(), P.ramification_index(), P.residue_class_degree()
        (3, 1, 1)
    """

    def __init__(self, K, p, e, f, pi):
        self._K, self._p, self._e, self._f, self._pi = K, p, e, f, pi

    def __repr__(self):
        if self._f == self._K.degree():
            return "Fractional ideal (%d)" % self._p
        return "Fractional ideal (%d, %r)" % (self._p, self._pi)

    def number_field(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(3).number_field()
            Number Field in a with defining polynomial x^2 + 5
        """
        return self._K

    def norm(self):
        """The absolute norm p^f.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(7).norm()
            7
        """
        return self._p ** self._f

    absolute_norm = norm

    def smallest_integer(self):
        """The prime p below the ideal.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(7).smallest_integer()
            7
        """
        return self._p

    def ramification_index(self):
        """The ramification index e.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K = NumberField(x^2 + 5, 'a')
            sage: K.prime_above(2).ramification_index(), K.prime_above(3).ramification_index()
            (2, 1)
        """
        return self._e

    def residue_class_degree(self):
        """The residue class degree f.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K = NumberField(x^2 + 5, 'a')
            sage: K.prime_above(3).residue_class_degree(), K.prime_above(13).residue_class_degree()
            (1, 2)
        """
        return self._f

    def is_prime(self):
        """True.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(3).is_prime()
            True
        """
        return True

    def is_principal(self, proof=None):
        """Whether the prime ideal is principal.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K = NumberField(x^2 + 1, 'a')
            sage: K.prime_above(5).is_principal()
            True
        """
        if self._K.class_number() == 1:
            return True
        raise NotImplementedError("principal ideal testing is not implemented yet")

    def gens_two(self):
        """Two generators (p, pi).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(3).gens_two()
            (3, a + 1)
        """
        if self._f == self._K.degree():
            return (self._K(self._p), self._K(0))
        return (self._K(self._p), self._pi)

    def gens(self):
        """Generators of the ideal.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 5, 'a').prime_above(3).gens()
            (3, a + 1)
        """
        return self.gens_two() if self._f != self._K.degree() else (self._K(self._p),)

    def __eq__(self, other):
        if isinstance(other, NumberFieldIdeal):
            return self._f == self._K.degree() and self._e == 1 and other._n == self._p
        return isinstance(other, PrimeIdeal) and other._K is self._K and (other._p, other._e, other._f, other._pi) == (self._p, self._e, self._f, self._pi)

    def __hash__(self):
        return hash((self._p, self._e, self._f, tuple(self._pi._c)))

    def __pow__(self, e):
        return IdealFactorization([(self, int(e))])


class IdealFactorization(list):
    """A factorization of an ideal into prime ideals.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: F = NumberField(x^2 + 5, 'a').ideal(6).factor(); F
        (Fractional ideal (2, a + 1))^2 * (Fractional ideal (3, a + 1)) * (Fractional ideal (3, a + 2))
        sage: len(F)
        3
    """
    def __repr__(self):
        if not self:
            return "1"
        if len(self) == 1 and self[0][1] == 1:
            return repr(self[0][0])
        return " * ".join("(%r)" % P + ("^%d" % e if e != 1 else "") for P, e in self)


def _cyc_repr(cyc):
    return " x ".join("C%d" % c for c in cyc)


class ClassGroup:
    """The class group of a number field.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: C = NumberField(x^2 + 23, 'a').class_group(); C
        Class group of order 3 with structure C3 of Number Field in a with defining polynomial x^2 + 23
        sage: C.order(), C.is_cyclic()
        (3, True)
    """
    def __init__(self, K):
        self._K = K
        self._cyc = tuple(K._bnfdata()["cyc"])

    def __repr__(self):
        h = self.order()
        if h == 1:
            return "Class group of order 1 of %r" % self._K
        return "Class group of order %d with structure %s of %r" % (h, _cyc_repr(self._cyc), self._K)

    def order(self):
        """The class number.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 23, 'a').class_group().order()
            3
        """
        return self._K._bnfdata()["h"]

    cardinality = order

    def invariants(self):
        """The orders of the cyclic factors.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 84, 'a').class_group().invariants()
            (2, 2)
        """
        return self._cyc

    elementary_divisors = invariants

    def ngens(self):
        """The number of cyclic factors.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 84, 'a').class_group().ngens()
            2
        """
        return len(self._cyc)

    def is_trivial(self):
        """Whether the class number is 1.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 163, 'a').class_group().is_trivial()
            True
        """
        return self.order() == 1

    def is_cyclic(self):
        """Whether the class group is cyclic.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 84, 'a').class_group().is_cyclic()
            False
        """
        return len(self._cyc) <= 1

    def number_field(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 23, 'a').class_group().number_field()
            Number Field in a with defining polynomial x^2 + 23
        """
        return self._K

    def __len__(self):
        return self.order()


class UnitGroup:
    """The unit group of a number field.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: NumberField(x^2 - 2, 'a').unit_group()
        Unit group with structure C2 x Z of Number Field in a with defining polynomial x^2 - 2
    """
    def __init__(self, K):
        self._K = K

    def __repr__(self):
        w = self._K.number_of_roots_of_unity()
        r = self._K.unit_rank()
        return "Unit group with structure %s of %r" % (" x ".join(["C%d" % w] + ["Z"] * r), self._K)

    def rank(self):
        """The rank (number of fundamental units).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^4 - 2, 'a').unit_group().rank()
            2
        """
        return self._K.unit_rank()

    def torsion_generator_order(self):
        """The number of roots of unity.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 + 3, 'a').unit_group().torsion_generator_order()  # sagebrush only
            6
        """
        return self._K.number_of_roots_of_unity()

    def ngens(self):
        """The number of generators: the rank plus 1 (torsion).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^4 - 2, 'a').unit_group().ngens()
            3
        """
        return 1 + self.rank()

    def number_field(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: NumberField(x^2 - 2, 'a').unit_group().number_field()
            Number Field in a with defining polynomial x^2 - 2
        """
        return self._K


def NumberField(polynomial, name=None, names=None, **kwds):
    """K.<a> = NumberField(x^3 - 2): the number field defined by a monic
    integer polynomial (class groups and units by Buchmann's algorithm in the
    Rust engine, assuming GRH).

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^3 - 2); K
        Number Field in a with defining polynomial x^3 - 2
        sage: a^3, (a + 1)^2
        (2, a^2 + 2*a + 1)
        sage: NumberField(x^2 + 5, 'b')
        Number Field in b with defining polynomial x^2 + 5
    """
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    if name is None:
        raise TypeError("you must specify the name of the generator")
    return NumberField_absolute(polynomial, str(name))


def QuadraticField(D, name="a", names=None, **kwds):
    """K.<a> = QuadraticField(D): Q(sqrt(D)), printed with Sage's embedding.

    EXAMPLES::

        sage: K.<a> = QuadraticField(-5); K
        Number Field in a with defining polynomial x^2 + 5 with a = 2.236067977499790?*I
        sage: a^2, K.class_number()
        (-5, 2)
    """
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    D = int(D)
    if D == 1 or _sa().is_square(D):
        raise ValueError("D must not be a square")
    import math
    v = math.sqrt(abs(D))
    # Sage prints the double nearest sqrt|D| to 16 significant digits
    root = _interval_repr_sqrt(abs(D))
    emb = root if D > 0 else root + "*I"
    return NumberField_absolute([-D, 0, 1], str(name), emb)


def _interval_repr_sqrt(n):
    """sqrt(n) as Sage prints the embedding of QuadraticField ("question
    style"): [lo, hi] the doubles around sqrt(n), printed with the most
    significant digits k such that, in units of the last digit, ceil(hi) -
    floor(lo) <= 2 (the upper candidate on a tie); scientific from 10^6.
    Checked against Sage for n up to 2^129 (beyond, Sage's real embedding
    interval is sometimes a digit wider)."""
    import math

    def ulp(f):
        return 2.0 ** (math.frexp(f)[1] - 53)

    def down(q):  # the largest double <= q > 0
        f = float(q)
        if _F(f) > q:
            f -= ulp(f) / 2 if math.frexp(f)[0] == 0.5 else ulp(f)
        return f

    def up(q):
        f = float(q)
        if _F(f) < q:
            f += ulp(f)
        return f

    s = 256
    v = math.isqrt(n * 4 ** s)  # floor(sqrt(n) 2^s)
    lo, hi = down(_F(v, 2 ** s)), up(_F(v + 1, 2 ** s))
    if _F(lo) ** 2 == n:
        hi = lo
    elif _F(hi) ** 2 == n:
        lo = hi
    lo, hi = _F(lo), _F(hi)
    nint = len(str(math.floor(lo)))
    m, t = 0, 0
    for k in range(20, 0, -1):
        t = k - nint
        u = _F(10) ** t
        L, U = math.floor(lo * u), math.ceil(hi * u)
        if U - L <= 2:
            m = L + 1 if U - L == 2 else U
            break
    d = str(m)
    nint = len(d) - t
    if nint >= 7:
        return d[0] + "." + d[1:] + "?e%d" % (nint - 1)
    return d[:nint] + "." + d[nint:] + "?"


def CyclotomicField(n, name="zeta", names=None):
    """The cyclotomic field Q(zeta_n).

    EXAMPLES::

        sage: K.<z> = CyclotomicField(5); K
        Cyclotomic Field of order 5 and degree 4
        sage: z^5, K.degree(), K.discriminant()
        (1, 4, 125)
    """
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    K = NumberField_absolute(_cyclotomic(int(n)), str(name) + ("%d" % n if name == "zeta" else ""))
    K._cyclotomic_order = int(n)
    return K


def _cyclotomic(n):
    """Phi_n, integer coefficients constant first: (x^n - 1) / prod_{d | n, d < n} Phi_d."""
    f = [_F(-1)] + [_F(0)] * (n - 1) + [_F(1)]
    for d in range(1, n):
        if n % d == 0:
            f, _ = _poly_divmod(f, [_F(c) for c in _cyclotomic(d)])
    return [int(c) for c in f]


def _hnf_rows(rows):
    """The nonzero rows of the Hermite normal form of an integer matrix."""
    rows = [list(r) for r in rows if any(r)]
    out, col, n = [], 0, len(rows[0]) if rows else 0
    while rows and col < n:
        piv = [r for r in rows if r[col]]
        if not piv:
            col += 1
            continue
        while len([r for r in rows if r[col]]) > 1:
            piv = sorted([r for r in rows if r[col]], key=lambda r: abs(r[col]))
            m = piv[0]
            for r in piv[1:]:
                q = r[col] // m[col]
                for j in range(n):
                    r[j] -= q * m[j]
            rows = [r for r in rows if any(r)]
        m = [r for r in rows if r[col]][0]
        if m[col] < 0:
            m[:] = [-v for v in m]
        rows = [r for r in rows if r is not m]
        out.append(m)
        col += 1
    return out


def _ring_generators(K, basis):
    """Ring generators of the maximal order as Sage lists them: the integral
    basis, without 1 and without the elements already in the ring the
    earlier ones generate."""
    n = K.degree()
    den = 1
    for b in basis:
        for c in b._c:
            den = den * _F(c).denominator // _gcd_int(den, _F(c).denominator)

    def vec(x):
        return [int(_F(c) * den) for c in (list(x._c) + [0] * n)[:n]]

    def span(gens):
        # the Z-module Z[gens]: products until stable
        mods = _hnf_rows([vec(K(1))])
        while True:
            elts = [K([_F(c, den) for c in r]) for r in mods]
            new = _hnf_rows(mods + [vec(e * g) for e in elts for g in gens])
            if new == mods:
                return mods
            mods = new

    def contains(mods, x):
        return _hnf_rows(mods + [vec(x)]) == mods

    gens = []
    for b in basis:
        if b == K(1):
            continue
        if not gens or not contains(span(gens), b):
            gens.append(b)
    return gens


def _gcd_int(a, b):
    while b:
        a, b = b, a % b
    return abs(a)

