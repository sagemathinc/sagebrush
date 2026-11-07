"""Univariate polynomial rings over inexact fields: RR, RDF, CC, CDF, RealField(p)
and ComplexField(p) (1b stage 1).

A polynomial is a dense list of the field's own elements, so the rounding is the
field's.  The rules (parents, printing, the order of the arithmetic) are Sage's,
probed as a black box: /scratch/sage2-notes/rpoly/RULES.md.
"""

import sys as _sys
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


_FIELD_TYPES = ("_RealField", "RealField_", "RealDoubleField_", "ComplexField_", "ComplexDoubleField_")


def is_inexact_field(B):
    """Whether B is RR, RDF, CC, CDF, RealField(p) or ComplexField(p).

    EXAMPLES::

        sage: import _sage_rpoly
        sage: _sage_rpoly.is_inexact_field(RR), _sage_rpoly.is_inexact_field(CDF), _sage_rpoly.is_inexact_field(QQ)
        (True, True, False)
    """
    return type(B).__name__ in _FIELD_TYPES and hasattr(B, "prec")


def _info(B):
    """(double, complex, precision) of an inexact field."""
    n = type(B).__name__
    return (n in ("RealDoubleField_", "ComplexDoubleField_"), n.startswith("Complex"), int(B.prec()))


def _field(double, cplx, prec):
    sa = _sa()
    if double:
        return sa.CDF if cplx else sa.RDF
    import _sage_real
    return _sage_real.ComplexField(prec) if cplx else _sage_real.RealField(prec)


def _scalar(c):
    """What kind of scalar c is: "exact" (an integer or a rational), "I" (the
    imaginary unit), (double, complex, precision) for an inexact number, else None."""
    if isinstance(c, bool):
        return None
    if isinstance(c, (int, _F)) or type(c).__name__ in ("Integer", "Rational"):
        return "exact"
    if type(c) is float:
        # (a Python float meets as RDF, a Python complex as CDF)
        return (True, False, 53)
    if type(c) is complex:
        return (True, True, 53)
    if type(c).__name__ == "Expression":
        try:
            if c.is_numeric() and c == _sa().I:
                return "I"
        except Exception:
            pass
        return None
    try:
        P = c.parent()
    except Exception:
        return None
    return _info(P) if is_inexact_field(P) else None


def _meet_scalar(B, s):
    """The base field of B[t] times (plus, ...) a scalar of kind s, as Sage."""
    if s == "exact":
        return B
    d, c, p = _info(B)
    if s == "I":
        return _field(d, True, p)
    sd, sc, sp = s
    cplx = c or sc
    if sp < p:
        return _field(False, cplx, sp)
    if d and not c and sc and not sd:
        # (RDF[t] with an element of CC is over CC)
        return _field(False, True, p)
    return _field(d, cplx, p)


_SAGE_CLASSES = ("sage.rings.polynomial.polynomial_real_mpfr_dense.PolynomialRealDense", "PolynomialRing_field_with_category.element_class",
                 "sage.rings.polynomial.polynomial_integer_dense_flint.Polynomial_integer_dense_flint",
                 "sage.rings.polynomial.polynomial_rational_flint.Polynomial_rational_flint")


def _sage_class(p):
    """The class Sage names for p when it refuses p / q: a polynomial over an inexact
    field, ZZ or QQ, or a Python complex; None for anything else."""
    if type(p) is complex:
        return "complex"
    if isinstance(p, PolynomialInexact):
        d, c, _ = _info(p._ring._base)
        # (RR and RealField(p) polynomials are Sage's MPFR class; RDF, CC, CDF and ComplexField(p) the generic one)
        return _SAGE_CLASSES[0] if not d and not c else _SAGE_CLASSES[1]
    if type(p).__name__ == "Polynomial":
        S = _sa()
        B = p.base_ring()
        if B is S.ZZ:
            return _SAGE_CLASSES[2]
        if B is S.QQ:
            return _SAGE_CLASSES[3]
    return None


def _refuse_types(a, b):
    """Raise Sage's TypeError for a / b when both classes are known."""
    ca, cb = _sage_class(a), _sage_class(b)
    if ca is not None and cb is not None:
        raise TypeError("unsupported operand type(s) for /: '%s' and '%s'" % (ca, cb))


# Sage's polynomial classes over Zmod(n) and the finite fields, which it names when it
# refuses p / q (probed: GF(2) and Zmod(2); prime fields and Zmod(n) below 2^64; prime
# fields and Zmod(p) from 2^64; composite Zmod(n) from 2^64; GF(p^k) for k >= 2)
_FF_CLASSES = ("sage.rings.polynomial.polynomial_gf2x.Polynomial_GF2X", "sage.rings.polynomial.polynomial_zmod_flint.Polynomial_zmod_flint",
               "sage.rings.polynomial.polynomial_modn_dense_ntl.Polynomial_dense_mod_p",
               "sage.rings.polynomial.polynomial_modn_dense_ntl.Polynomial_dense_modn_ntl_ZZ",
               "sage.rings.polynomial.polynomial_zz_pex.Polynomial_ZZ_pEX")


def _foreign(x):
    """(is_polynomial, base) for a polynomial over, or an element of, Zmod(n), a finite
    field or a number field; None for anything else."""
    ff, nfp, nf = _sys.modules.get("_sage_ff"), _sys.modules.get("_sage_nfpoly"), _sys.modules.get("_sage_nf")
    if ff is not None:
        if isinstance(x, ff.Polynomial_ff):
            return True, x.base_ring()
        if isinstance(x, (ff.IntegerMod, ff.FiniteFieldElement)):
            return False, x.parent()
    if nfp is not None and isinstance(x, nfp.Polynomial_nf):
        return True, x.base_ring()
    if nf is not None and isinstance(x, nf.NumberFieldElement):
        return False, x.parent()
    return None


def _number_field(B):
    nf = _sys.modules.get("_sage_nf")
    return nf is not None and isinstance(B, nf.NumberField_absolute)


def _embedded(B):
    """Whether B is a number field with an embedding (QuadraticField(2), a cyclotomic
    field): Sage computes with those and RR, CC, ..."""
    return _number_field(B) and (getattr(B, "_emb", None) is not None or getattr(B, "_cyclotomic_order", None) is not None)


def _foreign_class(B):
    """The class Sage names for a polynomial over B (Zmod(n), a finite field or a
    number field without an embedding) in a refusal of p / q; None if not probed."""
    if _number_field(B):
        return _SAGE_CLASSES[1]
    n, p = int(B.order()), int(B.characteristic())
    if n != p:
        return _FF_CLASSES[4]
    if n == 1:
        return None
    if n == 2:
        return _FF_CLASSES[0]
    if n < 2 ** 64:
        return _FF_CLASSES[1]
    return _FF_CLASSES[2] if B.is_field() else _FF_CLASSES[3]


def _parent_repr(x, foreign):
    """repr(x.parent()) as Sage prints it: its polynomial rings over Zmod(n) and GF(p)
    from n = 2^64 say "(using NTL)"."""
    r = repr(x.parent())
    is_poly, B = foreign
    if is_poly and not _number_field(B) and int(B.order()) == int(B.characteristic()) >= 2 ** 64 and not r.endswith(" (using NTL)"):
        r += " (using NTL)"
    return r


def _refuse_mixed(a, b):
    raise NotImplementedError("arithmetic with %s and %s together is not available in sagebrush yet" % (a, b))


def _refuse_foreign(P, other, rev, sym):
    """Raise as Sage for P (a polynomial over an inexact field) OP other, other from
    Zmod(n), a finite field or a number field; return if other is not one of those."""
    f = _foreign(other)
    if f is None:
        return
    is_poly, B = f
    mine, theirs = repr(P._ring), _parent_repr(other, f)
    a, b = (theirs, mine) if rev else (mine, theirs)
    if _embedded(B) and (not is_poly or other.variable_name() == P._ring._name):
        # (Sage answers: RR[t] + w*t for QQ(sqrt(2)), RR[t] == ... in the common ring)
        _refuse_mixed(a, b)
    if sym == "/" and is_poly:
        c = _foreign_class(B)
        if c is None:
            raise TypeError("sagebrush does not divide polynomials over %r and over %r" % ((B, P._ring._base) if rev else (P._ring._base, B)))
        ca, cb = (c, _sage_class(P)) if rev else (_sage_class(P), c)
        raise TypeError("unsupported operand type(s) for /: '%s' and '%s'" % (ca, cb))
    raise TypeError("unsupported operand parent(s) for %s: '%s' and '%s'" % (sym, a, b))


def _refuse_foreign_value(K, x, f):
    """Raise as Sage for p(x), p over K and x from (a polynomial over) Zmod(n), a finite
    field or a number field, or x over an inexact field and p over K, one of those."""
    if _embedded(f[1] if f is not None else K):
        _refuse_mixed(repr(K), repr(x.parent()))
    theirs = _parent_repr(x, f) if f is not None else repr(x.parent())
    raise TypeError("no common canonical parent for objects with parents: '%r' and '%s'" % (K, theirs))


def refuse_value(g, x):
    """For Polynomial_ff and Polynomial_nf: g(x), x a polynomial over an inexact field."""
    _refuse_foreign_value(g.base_ring(), x, None)


def is_inexact_polynomial(x):
    return isinstance(x, PolynomialInexact)


def _refused_exponent(n):
    """True if Sage refuses n as the exponent of a polynomial ("non-integral exponents
    not supported"), False if it takes n (an integer value of another type)."""
    if isinstance(n, _F):
        return n.denominator != 1
    if type(n) is complex:
        return True
    s = _scalar(n)
    if isinstance(s, tuple):
        if s[1]:
            # (an element of CC or CDF, even CC(2))
            return True
        if n != n:
            raise ValueError("cannot convert float NaN to integer")
        return not n.is_integer()
    if type(n).__name__ in ("Expression", "Rational"):
        return not n.is_integer()
    return False


def _meet_rings(A, B):
    """The base field of A[t] + B[t] (A the left operand's), as Sage."""
    if A is B:
        return A
    if not is_inexact_field(A):
        return B
    if not is_inexact_field(B):
        return A
    (ad, ac, ap), (bd, bc, bp) = _info(A), _info(B)
    if ap != bp:
        d, c, p = (ad, ac, ap) if ap < bp else (bd, bc, bp)
        if d and not c and (ac or bc):
            # (RDF[t] with ComplexField(p)[t] is over CC, as RDF[t] with CC)
            return _field(False, True, p)
        return _field(d, ac or bc, p)
    if ac != bc:
        return A if ac else B
    return A


def _conv(F, x):
    """x in the field F: an element of another field by its value (ComplexField(30)
    takes an element of CDF by its parts)."""
    try:
        return F(x)
    except TypeError:
        z = complex(x)
        return F(z.real, z.imag) if _info(F)[1] else F(z.real)


def _admit(n, what):
    """Refuse, before any coefficient list is built, a dense polynomial of more than the
    exact polynomials' _MAX_DENSE_COEFFS coefficients (the memory guard's error, at 8 bytes a
    coefficient, a lower bound), as _sage_poly refuses converting one (examples: the
    ring's __call__).
    """
    import _sage_poly
    cap = _sage_poly._MAX_DENSE_COEFFS
    if n > cap:
        import _memguard
        raise _memguard.memory_guard(what, n * 8, cap * 8, "one polynomial", fixed=True)


def _one(B):
    return B(1)


def _nonzero(c):
    try:
        return bool(c)
    except Exception:
        return c != 0


_RINGS = {}


def PolynomialRing_inexact(base, name):
    """The polynomial ring over an inexact field in one variable, cached as Sage's.

    EXAMPLES::

        sage: R.<t> = PolynomialRing(RR); R
        Univariate Polynomial Ring in t over Real Field with 53 bits of precision
        sage: RDF['t'] is PolynomialRing(RDF, 't')
        True
    """
    key = (id(base), name)
    R = _RINGS.get(key)
    if R is None:
        R = _RINGS[key] = PolynomialRingInexact(base, name)
    return R


class PolynomialRingInexact:
    """Univariate Polynomial Ring in t over an inexact field.

    EXAMPLES::

        sage: CDF['z'], latex(RR['t']), latex(CC['y_2'])
        (Univariate Polynomial Ring in z over Complex Double Field, \\Bold{R}[t], \\Bold{C}[y_{2}])
    """

    def __init__(self, base, name):
        self._base = base
        self._name = name
        self._complex = _info(base)[1]

    def __repr__(self):
        return "Univariate Polynomial Ring in %s over %r" % (self._name, self._base)

    def _latex_(self):
        from _sage_poly import _latex_variable_name
        return "%s[%s]" % (_sa().latex(self._base), _latex_variable_name(self._name))

    def __eq__(self, other):
        return other is self

    def __hash__(self):
        return hash((self._name, repr(self._base)))

    def base_ring(self):
        """The field of coefficients.

        EXAMPLES::

            sage: RDF['t'].base_ring()
            Real Double Field
        """
        return self._base

    base = base_ring

    def change_ring(self, R):
        """The polynomial ring over R in the same variable.

        EXAMPLES::

            sage: RR['t'].change_ring(CDF)
            Univariate Polynomial Ring in t over Complex Double Field
        """
        return _sa().PolynomialRing(R, self._name)

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: RR['t'].variable_name()
            't'
        """
        return self._name

    def variable_names(self):
        """The names of the variables (a 1-tuple).

        EXAMPLES::

            sage: RDF['t'].variable_names()
            ('t',)
        """
        return (self._name,)

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: RR['t'].gen()
            t
        """
        if i != 0:
            raise IndexError("generator n not defined")
        return PolynomialInexact(self, [self._base(0), self._base(1)])

    def gens(self):
        """The variables (a 1-tuple).

        EXAMPLES::

            sage: CC['t'].gens()
            (t,)
        """
        return (self.gen(),)

    def ngens(self):
        """The number of variables: 1.

        EXAMPLES::

            sage: CDF['t'].ngens()
            1
        """
        return 1

    def _first_ngens(self, n):
        return self.gens()[:n]

    def is_field(self):
        """False: a polynomial ring is not a field.

        EXAMPLES::

            sage: RR['t'].is_field()
            False
        """
        return False

    def is_exact(self):
        """False: the coefficients are inexact.

        EXAMPLES::

            sage: RDF['t'].is_exact()
            False
        """
        return False

    def characteristic(self):
        """The characteristic: 0.

        EXAMPLES::

            sage: RR['t'].characteristic()
            0
        """
        return 0

    def __call__(self, x=0):
        """Convert a list of coefficients (constant first), a number, a polynomial
        (by its coefficients) or a polynomial expression into the ring.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: R([1, 1/3, 2]), R(QQ['t']([1, 1/3])), R(SR.var('t')^2 + 1/3), R('t^2 + 1')
            (2.00000000000000*t^2 + 0.333333333333333*t + 1.00000000000000, 0.333333333333333*t + 1.00000000000000, t^2 + 0.333333333333333, t^2 + 1.00000000000000)

        A polynomial is admitted before its coefficients are built, as _sage_poly's
        conversion (a fixed limit of 2^20 coefficients)::

            sage: R.<t> = RR[]
            sage: try:  # sagebrush only
            ....:     R(SR.var('t')^1048577)
            ....: except MemoryError as e:
            ....:     print(str(e).splitlines()[1])
            Converting an expression of degree 1048577 to a dense polynomial needs about 8.4 MB, but Sagebrush has a fixed limit of about 8.3 MB for one polynomial.
            sage: R(SR.var('t')^2 + 1)
            t^2 + 1.00000000000000

        Growing operations are admitted before their coefficients are built: a shift and a power
        past the bound, and (with the bound lowered to 11 for the example) a product and a square::

            sage: def refused(f):  # sagebrush only
            ....:     try:
            ....:         f()
            ....:     except MemoryError as e:
            ....:         return str(e).splitlines()[1].split(" needs")[0]
            sage: refused(lambda: t.shift(2^20)), refused(lambda: (t + 1)^(2^20))  # sagebrush only
            ('Shifting a polynomial of degree 1 by 1048576', 'A power of degree 1048576 of a polynomial')
            sage: import _sage_poly; cap = _sage_poly._MAX_DENSE_COEFFS; _sage_poly._MAX_DENSE_COEFFS = 11  # sagebrush only
            sage: f, g = t^5 + 1, t^6 + 1  # sagebrush only
            sage: refused(lambda: f*g), refused(lambda: g*g), f*f  # sagebrush only
            ('A product of polynomials of degrees 5 and 6', 'A square of a polynomial of degree 6', t^10 + 2.00000000000000*t^5 + 1.00000000000000)
            sage: _sage_poly._MAX_DENSE_COEFFS = cap  # sagebrush only
        """
        B = self._base
        if isinstance(x, PolynomialInexact):
            return PolynomialInexact(self, [B(c) for c in x._c])
        if hasattr(x, "_c") and hasattr(x, "_ring") and hasattr(x, "variable_name"):
            return PolynomialInexact(self, [B(c) for c in x._c])
        if isinstance(x, (list, tuple)):
            return PolynomialInexact(self, [B(c) for c in x])
        if isinstance(x, str):
            return self(eval(x.replace("^", "**"), {self._name: self.gen(), "__builtins__": {}}))
        if type(x).__name__ == "Expression" and not x.is_numeric():
            v = _sa().SR.var(self._name)
            others = [str(u) for u in x.variables() if str(u) != self._name]
            if others:
                # (Sage names the first other variable: RR['t'](x + y) is "x is
                # not a variable of Univariate Polynomial Ring in t over ...")
                raise TypeError("%s is not a variable of %r" % (others[0], self))
            d = int(x.degree(v))
            _admit(d + 1, "Converting an expression of degree %d to a dense polynomial" % d)
            return PolynomialInexact(self, [B(_num(x.coefficient(v, i))) for i in range(d + 1)])
        if type(x).__name__ == "Expression":
            x = _num(x)
        return PolynomialInexact(self, [B(x)])


def _num(e):
    """A numeric symbolic expression as a Python or Sage number (exact if it is)."""
    try:
        return e.pyobject()
    except Exception:
        try:
            return float(e)
        except TypeError:
            return complex(e)


class PolynomialInexact:
    """An element of RR[t], RDF[t], CC[t], CDF[t], RealField(p)[t] or ComplexField(p)[t].

    EXAMPLES::

        sage: R.<t> = RR[]
        sage: f = 1.5*t^2 - 2*t + 1; f
        1.50000000000000*t^2 - 2.00000000000000*t + 1.00000000000000
        sage: f(2), f.derivative(), (t - 1.0)*(t + 1.0)
        (3.00000000000000, 3.00000000000000*t - 2.00000000000000, t^2 - 1.00000000000000)
        sage: S.<z> = CDF[]
        sage: (z + CDF(1, 2))^2
        z^2 + (2.0 + 4.0*I)*z - 3.0 + 4.0*I
    """

    __slots__ = ("_ring", "_c")

    def __init__(self, ring, coeffs):
        c = list(coeffs)
        # (a zero coefficient keeps its signs, as Sage: CDF['u']([1, CDF(-0.0,
        # -0.0), 2]).list()[1] is -0.0 - 0.0*I; only the top zeros are dropped)
        while c and not _nonzero(c[-1]):
            c.pop()
        self._ring = ring
        self._c = c

    # ---- data
    def parent(self):
        """The polynomial ring.

        EXAMPLES::

            sage: R.<t> = RDF[]
            sage: (t + 1).parent()
            Univariate Polynomial Ring in t over Real Double Field
        """
        return self._ring

    def base_ring(self):
        return self._ring._base

    def variable_name(self):
        return self._ring._name

    def variables(self):
        """The variable, if the polynomial is not constant.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^2).variables()
            (t,)
        """
        return (self._ring.gen(),) if len(self._c) > 1 else ()

    def degree(self):
        """The degree (-1 for the zero polynomial).

        EXAMPLES::

            sage: R.<t> = RDF[]
            sage: (t^3 + 1).degree(), R([1, 2, 0.0]).degree(), R(0.0).degree()
            (3, 1, -1)
        """
        return len(self._c) - 1

    def list(self):
        """The coefficients, constant term first; inner zeros are kept.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: ((t - 1)*(t + 1)).list()
            [-1.00000000000000, 0.000000000000000, 1.00000000000000]
        """
        return list(self._c)

    def coefficients(self, sparse=True):
        """The nonzero coefficients (sparse=False: all of them), constant term first.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (1.5*t^3 + 1).coefficients()
            [1.00000000000000, 1.50000000000000]
        """
        return [c for c in self._c if _nonzero(c)] if sparse else self.list()

    def dict(self):
        """The nonzero coefficients by exponent.

        EXAMPLES::

            sage: R.<t> = RDF[]
            sage: (1.5*t^3 + 1).dict()
            {0: 1.0, 3: 1.5}
        """
        return {i: c for i, c in enumerate(self._c) if _nonzero(c)}

    def exponents(self):
        """The exponents of the nonzero terms.

        EXAMPLES::

            sage: R.<t> = RDF[]
            sage: (1.5*t^3 + 1).exponents()
            [0, 3]
        """
        return [i for i, c in enumerate(self._c) if _nonzero(c)]

    def leading_coefficient(self):
        """The leading coefficient.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (1.5*t^3 + 1).leading_coefficient()
            1.50000000000000
        """
        return self._c[-1] if self._c else self._ring._base(0)

    lc = leading_coefficient

    def constant_coefficient(self):
        """The constant term.

        EXAMPLES::

            sage: R.<t> = RDF[]
            sage: (t^2 + 1).constant_coefficient()
            1.0
        """
        return self._c[0] if self._c else self._ring._base(0)

    def __getitem__(self, i):
        return self._c[i] if 0 <= i < len(self._c) else self._ring._base(0)

    def __iter__(self):
        return iter(self.list())

    def is_zero(self):
        """Whether the polynomial is 0.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: R(0.0).is_zero(), (t - t).is_zero(), t.is_zero()
            (True, True, False)
        """
        return not self._c

    def __bool__(self):
        return bool(self._c)

    def is_monic(self):
        """Whether the leading coefficient is 1.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^2).is_monic()
            True
        """
        return bool(self._c) and self._c[-1] == 1

    def is_constant(self):
        """Whether the degree is at most 0.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: R(3).is_constant(), t.is_constant()
            (True, False)
        """
        return len(self._c) <= 1

    def __hash__(self):
        from _sage_poly import poly_hash
        n = self._ring._name
        return poly_hash({((n, i),) if i else (): _chash(c) for i, c in enumerate(self._c) if _nonzero(c)})

    # ---- printing
    def __repr__(self):
        if not self._c:
            return "0"
        n, cplx = self._ring._name, self._ring._complex
        out = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if not _nonzero(c):
                continue
            x = str(c)
            if cplx and i > 0:
                y = x[1:] if x.startswith("-") else x
                if "+" in y or "-" in y:
                    x = "(%s)" % x
            out.append(x if i == 0 else "%s*%s" % (x, n) if i == 1 else "%s*%s^%d" % (x, n, i))
        s = " + ".join(out).replace(" + -", " - ")
        # (the coefficient 1 is dropped from 1*t, and from 1*I inside a coefficient)
        one = str(_one(self._ring._base)) + "*"
        if s.startswith(one):
            s = s[len(one):]
        elif s.startswith("-" + one):
            s = "-" + s[len(one) + 1:]
        for p in (" ", "(", "-"):
            s = s.replace(p + one, p)
        return s

    __str__ = __repr__

    def _latex_(self):
        if not self._c:
            return "0"
        from _sage_poly import _latex_variable_name
        latex = _sa().latex
        v = _latex_variable_name(self._ring._name)
        one = str(latex(_one(self._ring._base)))
        out = []
        for i in range(len(self._c) - 1, -1, -1):
            # (every coefficient, zeros too, as Sage's latex)
            x = str(latex(self._c[i]))
            if self._ring._complex and i > 0:
                y = x[1:] if x.startswith("-") else x
                if "+" in y or "-" in y:
                    x = "\\left(%s\\right)" % x
            mono = "" if i == 0 else v if i == 1 else "%s^{%d}" % (v, i)
            if mono and x == one:
                out.append(mono)
            elif mono and x == "-" + one:
                out.append("-" + mono)
            else:
                out.append(x + (" " + mono if mono else ""))
        return " + ".join(out).replace(" + -", " - ")

    # ---- arithmetic
    def _ring_over(self, B):
        R = self._ring
        return R if B is R._base else PolynomialRing_inexact(B, R._name)

    def _in(self, R):
        return self if R is self._ring else PolynomialInexact(R, [_conv(R._base, c) for c in self._c])

    def _refuse_parents(self, other, rev, sym):
        a, b = (other.parent(), self._ring) if rev else (self._ring, other.parent())
        raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (sym, a, b))

    def _operands(self, other, rev, sym="=="):
        """(a, b) in a common ring, a the left operand; None if other is not one of ours."""
        R = self._ring
        if isinstance(other, PolynomialInexact):
            if other._ring._name != R._name:
                self._refuse_parents(other, rev, sym)
            S = self._ring_over(_meet_rings(other._ring._base, R._base) if rev else _meet_rings(R._base, other._ring._base))
            a, b = self._in(S), other._in(S)
            return (b, a) if rev else (a, b)
        if hasattr(other, "_c") and hasattr(other, "_ring") and hasattr(other, "variable_name") and type(other).__name__ == "Polynomial":
            if other.variable_name() != R._name:
                self._refuse_parents(other, rev, sym)
            o = R(other)
            return (o, self) if rev else (self, o)
        _refuse_foreign(self, other, rev, sym)
        s = _scalar(other)
        if s is None:
            return None
        S = self._ring_over(_meet_scalar(R._base, s))
        o = PolynomialInexact(S, [_conv(S._base, other)] if s != "I" else [S._base(0, 1)])
        a = self._in(S)
        return (o, a) if rev else (a, o)

    def _symbolic(self, other, op, rev):
        if type(other).__name__ != "Expression":
            return NotImplemented
        if _scalar(other) == "I":
            return None
        me = _sa().SR(self)
        return op(other, me) if rev else op(me, other)

    def _bin(self, other, rev, f, op, sym):
        r = self._symbolic(other, op, rev)
        if r is not None and r is not NotImplemented:
            return r
        p = self._operands(other, rev, sym)
        if p is None:
            return NotImplemented
        return f(*p)

    def __add__(self, other):
        return self._bin(other, False, _add, lambda a, b: a + b, "+")

    def __radd__(self, other):
        return self._bin(other, True, _add, lambda a, b: a + b, "+")

    def __sub__(self, other):
        return self._bin(other, False, _sub, lambda a, b: a - b, "-")

    def __rsub__(self, other):
        return self._bin(other, True, _sub, lambda a, b: a - b, "-")

    def __mul__(self, other):
        if other is self:
            return _square(self)
        return self._bin(other, False, _mul, lambda a, b: a * b, "*")

    def __rmul__(self, other):
        return self._bin(other, True, _mul, lambda a, b: a * b, "*")

    def __neg__(self):
        return PolynomialInexact(self._ring, [-c for c in self._c])

    def __pos__(self):
        return self

    def __truediv__(self, other):
        """Division by a number: by its inverse, as Sage.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t + 1)/3, (t + 1)/CC(1, 2)
            (0.333333333333333*t + 0.333333333333333, (0.200000000000000 - 0.400000000000000*I)*t + 0.200000000000000 - 0.400000000000000*I)
        """
        r = self._symbolic(other, lambda a, b: a / b, False)
        if r is not None and r is not NotImplemented:
            return r
        if isinstance(other, PolynomialInexact) or type(other).__name__ == "Polynomial":
            if other.variable_name() != self._ring._name:
                _refuse_types(self, other)
            raise NotImplementedError("the fraction field of %r is not available in sagebrush yet" % (self._ring,))
        _refuse_foreign(self, other, False, "/")
        s = _scalar(other)
        if s is None:
            return NotImplemented
        if type(other) is complex and not self._complex_divides():
            _refuse_types(self, other)
        S = self._ring_over(_meet_scalar(self._ring._base, s))
        F = S._base
        c = F(0, 1) if s == "I" else _conv(F, other)
        return self._in(S)._divide(c)

    def _complex_divides(self):
        # (as Sage: RR[t], RDF[t] and ComplexField(100)[t] refuse t/complex(1, 2) and complex(1, 2)/t)
        return self._ring._complex and _info(self._ring._base)[2] <= 53

    def __rtruediv__(self, other):
        if type(other) is complex and not self._complex_divides():
            _refuse_types(other, self)
        if type(other).__name__ == "Polynomial" and other.variable_name() != self._ring._name:
            _refuse_types(other, self)
        _refuse_foreign(self, other, True, "/")
        raise NotImplementedError("the fraction field of %r is not available in sagebrush yet" % (self._ring,))

    def _scale(self, c):
        return PolynomialInexact(self._ring, [x * c for x in self._c])

    def _divide(self, c):
        """Each coefficient times the inverse of c, as Sage."""
        return self._scale(_inverse(self._ring._base, c))

    def __pow__(self, n):
        """A power by a nonnegative integer (Sage's binary powering; a constant by its
        coefficient's power).

        EXAMPLES::

            sage: R.<t> = RDF[]
            sage: (1.1*t + 1)^3
            1.3310000000000004*t^3 + 3.630000000000001*t^2 + 3.3000000000000003*t + 1.0
        """
        if type(n).__name__ == "Expression" or not (isinstance(n, int) or type(n).__name__ == "Integer" or (isinstance(n, _F) and n.denominator == 1)):
            if _refused_exponent(n):
                raise TypeError("non-integral exponents not supported")
            # (Sage takes an integer value of another type: RR(2), SR(2), Mod(2, 5))
            raise NotImplementedError("a power of a polynomial over %r by %r is not available in sagebrush yet" % (self._ring._base, n))
        n = int(n)
        if n < 0:
            raise NotImplementedError("the fraction field of %r is not available in sagebrush yet" % (self._ring,))
        R = self._ring
        if n == 0:
            return PolynomialInexact(R, [R._base(1)])
        if n == 1:
            return self
        if len(self._c) <= 1:
            return PolynomialInexact(R, [self._c[0] ** n] if self._c else [])
        _admit((len(self._c) - 1) * n + 1, "A power of degree %d of a polynomial" % ((len(self._c) - 1) * n))
        r, b = None, self
        while n:
            if n & 1:
                r = b if r is None else _mul(b, r)
            n >>= 1
            if n:
                b = _square(b)
        return r

    def __xor__(self, other):
        raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")

    def __eq__(self, other):
        try:
            p = self._operands(other, False)
        except TypeError:
            return False
        if p is None:
            return NotImplemented
        a, b = p
        return len(a._c) == len(b._c) and all(x == y for x, y in zip(a._c, b._c))

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def monic(self):
        """self divided by its leading coefficient (times its inverse, as Sage).

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (2*t + 1).monic()
            t + 0.500000000000000
        """
        if not self._c:
            # (the zero polynomial is its own monic, as Sage)
            return self
        return self._divide(self._c[-1])

    # ---- evaluation and calculus
    def __call__(self, *args, **kwds):
        """The value at a point, by Horner's rule (in the field of the point's and the
        coefficients' parents), or at a polynomial, a matrix or a symbolic expression.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: f = 1.5*t^2 - 2*t + 1
            sage: f(1/3), f(CC(0, 1)), f(SR.var('x')), f(t + 1)
            (0.500000000000000, -0.500000000000000 - 2.00000000000000*I, 1.50000000000000*x^2 - 2.00000000000000*x + 1.00000000000000, 1.50000000000000*t^2 + t + 0.500000000000000)
        """
        # (as Sage: a value given by position wins, other keywords are ignored, and with
        # no value f() is f)
        if len(args) > 1:
            raise TypeError("Wrong number of arguments")
        if not args:
            if self._ring._name not in kwds:
                return self
            args = (kwds[self._ring._name],)
        x = args[0]
        f = _foreign(x)
        if f is not None:
            _refuse_foreign_value(self._ring._base, x, f)
        if type(x).__name__ == "Expression" and not x.is_numeric():
            r = 0
            for i, c in enumerate(self._c):
                if _nonzero(c):
                    r = r + c * x ** i
            # (the zero polynomial at x is the field's zero in SR, as Sage)
            return r if self._c else _sa().SR(self._ring._base(0))
        s = _scalar(x)
        if s is not None and s != "I":
            # (the field of a value is as for two polynomials, the coefficients' on the
            # left: RealField(100)[t] at RDF(2) is in RDF, RR[t] at RDF(2) in RR)
            F = self._ring._base if s == "exact" else _meet_rings(self._ring._base, _field(*s))
            x = _conv(F, x)
            cs = [_conv(F, c) for c in self._c]
        else:
            cs = self._c
        if not cs:
            if s is None:
                # (a matrix or a polynomial: the zero of its codomain, times x^0 as Sage's,
                # the zero matrix, or 0 in CDF['u'], not a number; the daybreak3 EVAL-1)
                return self._ring._base(0) * x ** 0
            return (F if s != "I" else self._ring._base)(0)
        if s is None and hasattr(x, "nrows"):
            # (a matrix: the coefficients times its identity, as Sage)
            one = x ** 0
            r = cs[-1] * one
            for c in reversed(cs[:-1]):
                r = r * x + c * one
            return r
        r = cs[-1]
        for c in reversed(cs[:-1]):
            r = r * x + c
        return r

    def subs(self, *args, **kwds):
        """The value at a point: f.subs(t=3) is f(3).

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^2 + 1).subs(t=3)
            10.0000000000000
        """
        return self(*args, **kwds)

    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: R.<t> = CC[]
            sage: (1.5*t^3 - 2*t + 1).derivative()
            4.50000000000000*t^2 - 2.00000000000000
        """
        from _sage_poly import _derivative_count
        k = _derivative_count(args, self._ring.gen(), self._ring._name)
        f = self
        for _ in range(k):
            f = PolynomialInexact(f._ring, [c * i for i, c in enumerate(f._c)][1:])
        return f

    diff = differentiate = derivative

    def integral(self, var=None):
        """The antiderivative with constant term 0.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^2 + 1).integral()
            0.333333333333333*t^3 + t
        """
        F = self._ring._base
        d, cplx, _ = _info(F)
        if cplx:
            # (CDF, CC, ComplexField(p): by the inverse, as Sage)
            cs = [c * _inverse(F, F(i + 1)) for i, c in enumerate(self._c)]
        else:
            cs = [c / (i + 1) for i, c in enumerate(self._c)]
        return PolynomialInexact(self._ring, [F(0)] + cs if cs else [])

    def change_ring(self, R):
        """The polynomial over R, coefficient by coefficient.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (1.5*t^2 + 1).change_ring(QQ), (1.5*t^2 + 1/3).change_ring(RDF)
            (3/2*t^2 + 1, 1.5*t^2 + 0.3333333333333333)
        """
        P = _sa().PolynomialRing(R, self._ring._name)
        return P([R(c) for c in self._c])

    def truncate(self, n):
        """The terms of degree below n.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^3 + 2*t + 1).truncate(2)
            2.00000000000000*t + 1.00000000000000
        """
        return PolynomialInexact(self._ring, self._c[:max(int(n), 0)])

    def shift(self, n):
        """self times t^n (n < 0: the terms of degree n and up, divided by t^n).

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^3 + 2*t + 1).shift(1)
            t^4 + 2.00000000000000*t^2 + t
        """
        n = int(n)
        if n >= 0:
            if self._c:
                _admit(len(self._c) + n, "Shifting a polynomial of degree %d by %d" % (len(self._c) - 1, n))
            return PolynomialInexact(self._ring, [self._ring._base(0)] * n + self._c if self._c else [])
        return PolynomialInexact(self._ring, self._c[-n:])

    def reverse(self):
        """The coefficients in reverse order.

        EXAMPLES::

            sage: R.<t> = RR[]
            sage: (t^3 + 2*t).reverse()
            2.00000000000000*t^2 + 1.00000000000000
        """
        return PolynomialInexact(self._ring, self._c[::-1])

    def _symbolic_(self, R=None):
        return _sa().SR(self)


def _chash(c):
    """A coefficient's hash, as Sage hashes an element of RR, CC, RealField(p) or
    ComplexField(p): through its double (Sage 10.10: hash(RealField(100)(1/3)) is
    hash(float(...)), so RealField(100)['t']([2^60 + 1]) and ZZ['t']([2^60 + 1])
    are equal with different hashes, and ComplexField(100)['t']([1/3]) hashes as
    RealField(100)['t']([1/3]); a complex number with imaginary part 0 hashes as its
    real part, as Python's)."""
    try:
        if hasattr(c, "imag") and callable(getattr(c, "imag", None)):
            return hash(complex(c))
        if isinstance(c, complex):
            return hash(c.real) if c.imag == 0 else hash(c)
    except Exception:
        pass
    return hash(c)


def _inverse(F, c):
    """1/c in F, as Sage's polynomials take it: CDF's own inverse (GSL's); over CC and
    ComplexField(p) the conjugate over the norm x^2 + y^2, each step rounded (so 1/0.1
    is 9.999999999999998 in CC); over a real field 1/c."""
    d, cplx, _ = _info(F)
    if d and cplx:
        return ~c
    if cplx:
        x, y = c.real(), c.imag()
        n = x * x + y * y
        return F(x / n, -y / n)
    return F(1) / c


def _add(a, b):
    n, m = len(a._c), len(b._c)
    c = [a._c[i] + b._c[i] for i in range(min(n, m))]
    c += a._c[m:] if n > m else b._c[n:]
    return PolynomialInexact(a._ring, c)


def _sub(a, b):
    n, m = len(a._c), len(b._c)
    c = [a._c[i] - b._c[i] for i in range(min(n, m))]
    c += a._c[m:] if n > m else [-x for x in b._c[n:]]
    return PolynomialInexact(a._ring, c)


def _mul(a, b):
    """The product, as Sage's: coefficient k is the sum over i ascending of a_i b_(k-i),
    from its first term."""
    x, y = a._c, b._c
    if not x or not y:
        return PolynomialInexact(a._ring, [])
    n, m = len(x), len(y)
    _admit(n + m - 1, "A product of polynomials of degrees %d and %d" % (n - 1, m - 1))
    r = []
    for k in range(n + m - 1):
        s = None
        for i in range(max(0, k - m + 1), min(k, n - 1) + 1):
            p = x[i] * y[k - i]
            s = p if s is None else s + p
        r.append(s)
    return PolynomialInexact(a._ring, r)


def _square(a):
    """a*a, as Sage's: over RR and RealField(p) the product; over RDF, CDF, CC and
    ComplexField(p), for i descending, a_i^2 into coefficient 2i, then 2 a_i a_j (j > i)
    added to coefficient i + j, which starts at 0."""
    x = a._c
    d, cplx, _ = _info(a._ring._base)
    if not x:
        return a
    n = len(x)
    _admit(2 * n - 1, "A square of a polynomial of degree %d" % (n - 1))
    if not d and not cplx:
        return _mul(a, a)
    z = a._ring._base(0)
    r = [z] * (2 * n - 1)
    for i in range(n - 1, -1, -1):
        r[2 * i] = x[i] * x[i]
        for j in range(i + 1, n):
            # (doubled part by part, p + p: the signs of zero parts are Sage's)
            p = x[i] * x[j]
            r[i + j] = r[i + j] + (p + p)
    return PolynomialInexact(a._ring, r)


def lift(p, other):
    """An exact polynomial p (ZZ[t], QQ[t]) as one over the field of an inexact scalar
    other, as Sage's coercion (QQ[t] times RR(1.5) is over RR), else None."""
    s = _scalar(other)
    if s is None or s == "exact" or s == "I":
        return None
    d, c, prec = s
    B = _field(d, c, prec)
    return PolynomialRing_inexact(B, p.variable_name())(p)
