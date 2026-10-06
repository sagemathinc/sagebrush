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
        # a symbolic expression: through a polynomial ring in its variable
        try:
            p = _sa().QQ["x"](f)
            c = [_F(a) for a in p.list()]
            name = "x"
        except Exception:
            raise TypeError("cannot make a number field from %r" % (f,))
    if any(a.denominator != 1 for a in c):
        raise NotImplementedError("defining polynomials must have integer coefficients")
    c = [int(a) for a in c]
    if not c or c[-1] != 1:
        raise NotImplementedError("defining polynomials must be monic (for now)")
    return c, name


class NumberField_absolute:
    """K = Q[x]/(f), f monic with integer coefficients, irreducible."""

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
        s = "Number Field in %s with defining polynomial %s" % (self._name, _repr_poly(self._f, self._var))
        return s + (" with %s = %s" % (self._name, self._emb) if self._emb else "")

    def _first_ngens(self, k):
        return (self.gen(),)[:k]

    def gen(self, i=0):
        if i != 0:
            raise IndexError("only one generator")
        return self([0, 1])

    def gens(self):
        return (self.gen(),)

    def variable_name(self):
        return self._name

    def __call__(self, x):
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
        return self._n

    absolute_degree = degree

    def polynomial(self):
        return _sa().QQ[self._var](self._f)

    defining_polynomial = polynomial
    absolute_polynomial = polynomial

    def _nfdata(self):
        if self._data is None:
            self._data = _nf().nf_data(self._f)
        return self._data

    def discriminant(self):
        return self._nfdata()["disc"]

    disc = discriminant
    absolute_discriminant = discriminant

    def signature(self):
        d = self._nfdata()
        return (d["r1"], d["r2"])

    def is_totally_real(self):
        return self.signature()[1] == 0

    def is_totally_imaginary(self):
        return self.signature()[0] == 0

    def is_galois(self):
        raise NotImplementedError("is_galois is not implemented yet")

    def integral_basis(self):
        d = self._nfdata()
        return [self([_F(c, d["den"]) for c in row]) for row in d["basis"]]

    def maximal_order(self):
        return Order(self)

    ring_of_integers = maximal_order

    def number_of_roots_of_unity(self):
        return self._nfdata()["w"]

    def unit_group(self, proof=None):
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
        return ClassGroup(self)

    def class_number(self, proof=None):
        return self._bnfdata()["h"]

    def regulator(self, proof=None):
        return _sa().RR(self._bnfdata()["regulator"])

    def unit_rank(self):
        r1, r2 = self.signature()
        return r1 + r2 - 1

    # ---- ideals
    def ideal(self, *gens):
        if len(gens) == 1 and isinstance(gens[0], (list, tuple)):
            gens = tuple(gens[0])
        if len(gens) == 1 and not isinstance(gens[0], NumberFieldElement):
            n = _F(gens[0])
            if n.denominator == 1:
                return NumberFieldIdeal(self, int(n))
        raise NotImplementedError("only ideals generated by an integer are supported so far (and the prime ideals from primes_above)")

    fractional_ideal = ideal

    def primes_above(self, p, degree=None):
        p = int(p)
        out = [PrimeIdeal(self, q["p"], q["e"], q["f"], self([_F(c, q["pi_den"]) for c in q["pi"]])) for q in _primes_above(tuple(self._f), p)]
        out = _sort_primes(out)
        if degree is not None:
            out = [P for P in out if P.residue_class_degree() == degree]
        return out

    def prime_above(self, p, degree=None):
        return self.primes_above(p, degree)[0]

    def factor(self, n):
        return self.ideal(n).factor()

    def prime_factors(self, n):
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
    __slots__ = ("_K", "_c")

    def __init__(self, K, c):
        self._K = K
        self._c = [_F(x) for x in c]

    def parent(self):
        return self._K

    def list(self):
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
        return not any(self._c)

    def matrix(self):
        """The matrix of multiplication by self on the power basis (rows: self*a^i)."""
        K = self._K
        rows = []
        x = self
        g = K.gen()
        for _ in range(K._n):
            rows.append(list(x._c))
            x = x * g
        return rows

    def charpoly(self, var="x"):
        m = self.matrix()
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
        f = self.charpoly(var)
        for g, e in f.factor():
            if hasattr(g, "degree") and g.degree() > 0:
                if all(t == 0 for t in _eval_at(g, self)._c):
                    return g / g.leading_coefficient() if g.leading_coefficient() != 1 else g
        return f

    def norm(self):
        m = self.matrix()
        return _q(_det(m))

    def trace(self):
        m = self.matrix()
        return _q(sum(m[i][i] for i in range(len(m))))

    def is_integral(self):
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
        return "Maximal Order generated by [%s] in %r" % (", ".join(repr(x) for x in b[1:]), K)

    def basis(self):
        return self._K.integral_basis()

    def discriminant(self):
        return self._K.discriminant()

    def number_field(self):
        return self._K

    def degree(self):
        return self._K.degree()

    def class_number(self, proof=None):
        return self._K.class_number()


class NumberFieldIdeal:
    """The ideal generated by an integer."""

    def __init__(self, K, n):
        self._K = K
        self._n = abs(int(n))

    def __repr__(self):
        return "Fractional ideal (%d)" % self._n

    def number_field(self):
        return self._K

    def norm(self):
        return self._n ** self._K.degree()

    def gens(self):
        return (self._K(self._n),)

    def is_prime(self):
        ps = self._K.primes_above(self._n) if self._n > 1 and _sa().is_prime(self._n) else []
        return len(ps) == 1 and ps[0]._e == 1

    def factor(self):
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
    """A prime ideal P = (p, pi) of the maximal order."""

    def __init__(self, K, p, e, f, pi):
        self._K, self._p, self._e, self._f, self._pi = K, p, e, f, pi

    def __repr__(self):
        if self._f == self._K.degree():
            return "Fractional ideal (%d)" % self._p
        return "Fractional ideal (%d, %r)" % (self._p, self._pi)

    def number_field(self):
        return self._K

    def norm(self):
        return self._p ** self._f

    absolute_norm = norm

    def smallest_integer(self):
        return self._p

    def ramification_index(self):
        return self._e

    def residue_class_degree(self):
        return self._f

    def is_prime(self):
        return True

    def is_principal(self, proof=None):
        if self._K.class_number() == 1:
            return True
        raise NotImplementedError("principal ideal testing is not implemented yet")

    def gens_two(self):
        if self._f == self._K.degree():
            return (self._K(self._p), self._K(0))
        return (self._K(self._p), self._pi)

    def gens(self):
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
    def __repr__(self):
        if not self:
            return "1"
        if len(self) == 1 and self[0][1] == 1:
            return repr(self[0][0])
        return " * ".join("(%r)" % P + ("^%d" % e if e != 1 else "") for P, e in self)


def _cyc_repr(cyc):
    return " x ".join("C%d" % c for c in cyc)


class ClassGroup:
    def __init__(self, K):
        self._K = K
        self._cyc = tuple(K._bnfdata()["cyc"])

    def __repr__(self):
        h = self.order()
        if h == 1:
            return "Class group of order 1 of %r" % self._K
        return "Class group of order %d with structure %s of %r" % (h, _cyc_repr(self._cyc), self._K)

    def order(self):
        return self._K._bnfdata()["h"]

    cardinality = order

    def invariants(self):
        return self._cyc

    elementary_divisors = invariants

    def ngens(self):
        return len(self._cyc)

    def is_trivial(self):
        return self.order() == 1

    def is_cyclic(self):
        return len(self._cyc) <= 1

    def number_field(self):
        return self._K

    def __len__(self):
        return self.order()


class UnitGroup:
    def __init__(self, K):
        self._K = K

    def __repr__(self):
        w = self._K.number_of_roots_of_unity()
        r = self._K.unit_rank()
        return "Unit group with structure %s of %r" % (" x ".join(["C%d" % w] + ["Z"] * r), self._K)

    def rank(self):
        return self._K.unit_rank()

    def torsion_generator_order(self):
        return self._K.number_of_roots_of_unity()

    def ngens(self):
        return 1 + self.rank()

    def number_field(self):
        return self._K


def NumberField(polynomial, name=None, names=None, **kwds):
    """K.<a> = NumberField(x^3 - 2): the number field defined by a monic
    integer polynomial (class groups and units by Buchmann's algorithm in the
    Rust engine, assuming GRH)."""
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    if name is None:
        raise TypeError("you must specify the name of the generator")
    return NumberField_absolute(polynomial, str(name))


def QuadraticField(D, name="a", names=None, **kwds):
    """K.<a> = QuadraticField(D): Q(sqrt(D)), printed with Sage's embedding."""
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    D = int(D)
    if D == 1 or _sa().is_square(D):
        raise ValueError("D must not be a square")
    import math
    v = math.sqrt(abs(D))
    # Sage prints the double nearest sqrt|D| to 16 significant digits
    root = _interval_repr_sqrt(abs(D))
    emb = ("%s?" % root) if D > 0 else ("%s?*I" % root)
    return NumberField_absolute([-D, 0, 1], str(name), emb)


def _interval_repr_sqrt(n):
    """sqrt(n) as Sage prints the embedding of QuadraticField (an interval
    between the two doubles around it, "question style"): the lower end
    rounded down and the upper end rounded up to 16 significant digits, the
    printed digits their average rounded half to even."""
    import math
    scale = 10 ** 40
    v = math.isqrt(n * scale * scale)  # floor(sqrt(n) 10^40)
    exact = _F(v, scale)
    f = float(exact)
    ulp = 2.0 ** (math.frexp(f)[1] - 53)  # f > 0: its neighbours are f -+ ulp
    lo, hi = (f, f + ulp) if _F(f) <= exact else (f - ulp, f)
    nint = len(str(int(lo)))
    k = 10 ** (16 - nint)
    L = (_F(lo) * k).__floor__()
    U = -((-_F(hi) * k).__floor__())
    digits = str(round(_F(L + U, 2)))
    return digits[:nint] + "." + digits[nint:]


def CyclotomicField(n, name="zeta", names=None):
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    return NumberField_absolute(_cyclotomic(int(n)), str(name) + ("%d" % n if name == "zeta" else ""))


def _cyclotomic(n):
    """Phi_n, integer coefficients constant first: (x^n - 1) / prod_{d | n, d < n} Phi_d."""
    f = [_F(-1)] + [_F(0)] * (n - 1) + [_F(1)]
    for d in range(1, n):
        if n % d == 0:
            f, _ = _poly_divmod(f, [_F(c) for c in _cyclotomic(d)])
    return [int(c) for c in f]
