"""The refusal of an inexact number (RR, RDF, CC, CDF, RealField(p), ComplexField(p), a
Python float or complex) with Zmod(n), a finite field or a number field, their elements
and polynomials, in Sage 10.10's words (L34): loaded only when one is met, from
_sage_ff.refuse_inexact."""

from _sage_ff import IntegerMod, FiniteFieldElement, Polynomial_ff, _number_field


def _no_small_square(D):
    """Whether no p^2 with p < 10^4 divides D: the test that decides Sage's class of
    a quadratic field's element (probed in Sage 10.10: x^2 - 2*9973^2 gives
    NumberFieldElement_quadratic, x^2 - 2*10007^2 NumberFieldElement_quadratic_sqrt).
    Bounded work, below 10^4 divisions, and no factorization."""
    D = abs(D)
    d = 2
    while d < 10000 and d * d <= D:
        if D % (d * d) == 0:
            return False
        d += 1
    return True


# the classes Sage names when it refuses a Python float or complex: polynomials over
# GF(2) and Zmod(2); GF(p) and Zmod(n) below 2^64; GF(p) and Zmod(p) from 2^64;
# composite Zmod(n) from 2^64; GF(p^k), k >= 2; a number field
SAGE_POLYNOMIAL_CLASSES = ("sage.rings.polynomial.polynomial_gf2x.Polynomial_GF2X", "sage.rings.polynomial.polynomial_zmod_flint.Polynomial_zmod_flint",
                           "sage.rings.polynomial.polynomial_modn_dense_ntl.Polynomial_dense_mod_p",
                           "sage.rings.polynomial.polynomial_modn_dense_ntl.Polynomial_dense_modn_ntl_ZZ",
                           "sage.rings.polynomial.polynomial_zz_pex.Polynomial_ZZ_pEX", "PolynomialRing_field_with_category.element_class")


def embedded(B):
    """Whether B is a number field with an embedding (QuadraticField(2), a cyclotomic
    field): Sage computes with those and RR, CC, ..."""
    return _number_field(B) and (getattr(B, "_emb", None) is not None or getattr(B, "_cyclotomic_order", None) is not None)


def sage_polynomial_class(B):
    """The class of Sage's polynomials over B (Zmod(n), a finite field or a number field
    without an embedding); None outside the families probed."""
    if _number_field(B):
        return SAGE_POLYNOMIAL_CLASSES[5]
    n, p = int(B.order()), int(B.characteristic())
    if n != p:
        return SAGE_POLYNOMIAL_CLASSES[4]
    if n == 1:
        return None
    if n == 2:
        return SAGE_POLYNOMIAL_CLASSES[0]
    if n < 2 ** 64:
        return SAGE_POLYNOMIAL_CLASSES[1]
    return SAGE_POLYNOMIAL_CLASSES[2] if B.is_field() else SAGE_POLYNOMIAL_CLASSES[3]


def _sage_element_class(x):
    """The class of Sage's element x of Zmod(n), a finite field or a number field
    without an embedding; None outside the families probed."""
    if isinstance(x, IntegerMod):
        n = x._parent._n
        if n == 1:
            return None
        # (IntegerMod_int to 46341, IntegerMod_int64 to 2^31 - 1)
        k = "int" if n <= 46341 else "int64" if n < 2 ** 31 else "gmp"
        return "sage.rings.finite_rings.integer_mod.IntegerMod_" + k
    if isinstance(x, FiniteFieldElement):
        K = x._parent
        # (givaro below 2^16 elements, then NTL's GF(2^k) or PARI's)
        if K._q < 2 ** 16:
            return "sage.rings.finite_rings.element_givaro.FiniteField_givaroElement"
        if K._p == 2:
            return "sage.rings.finite_rings.element_ntl_gf2e.FiniteField_ntl_gf2eElement"
        return "sage.rings.finite_rings.element_pari_ffelt.FiniteFieldElement_pari_ffelt"
    f = x._K._f
    if len(f) == 3:
        # x^2 + 1, x^2 - D with no small square factor, any other quadratic
        if f[1] == 0 and f[0] == 1:
            return "sage.rings.number_field.number_field_element_quadratic.NumberFieldElement_gaussian"
        if f[1] == 0 and f[0] != 0 and _no_small_square(int(f[0])):
            return "sage.rings.number_field.number_field_element_quadratic.NumberFieldElement_quadratic_sqrt"
        return "sage.rings.number_field.number_field_element_quadratic.NumberFieldElement_quadratic"
    if len(f) > 3:
        return "sage.rings.number_field.number_field_element.NumberFieldElement_absolute"
    return None


def _ring_repr(a):
    """repr(a.parent()) as Sage prints it: its polynomial rings over Zmod(n) and GF(p)
    from n = 2^64 say "(using NTL)" (L36)."""
    P = a.parent()
    r = repr(P)
    if isinstance(a, Polynomial_ff):
        B = P.base_ring()
        if int(B.order()) == int(B.characteristic()) >= 2 ** 64 and not r.endswith(" (using NTL)"):
            r += " (using NTL)"
    return r


def refuse(a, b, k, B, is_poly, op, rev=False):
    """_sage_ff.refuse_inexact's refusal: a OP b (b OP a when rev; op "call" for a(b)),
    a a polynomial over or an element of B (Zmod(n), a finite field or a number field)
    and b an inexact number of kind k ("py" a Python float or complex, "sage" an
    element of RR, RDF, CC, CDF, RealField(p) or ComplexField(p)): Sage's error, or
    False for ==.

    EXAMPLES::

        sage: GF(7)['t'].gen() + RR(2)
        Traceback (most recent call last):
        ...
        TypeError: unsupported operand parent(s) for +: 'Univariate Polynomial Ring in t over Finite Field of size 7' and 'Real Field with 53 bits of precision'
        sage: 2.0r * GF(7)(3)
        Traceback (most recent call last):
        ...
        TypeError: unsupported operand type(s) for *: 'float' and 'sage.rings.finite_rings.integer_mod.IntegerMod_int'
        sage: GF(7)(3) == RR(3)
        False
    """
    if embedded(B) and not (is_poly and op == "/" and k == "py"):
        # (Sage computes: QQ(sqrt(2))[t] + RR(2) is t + 3.00000000000000; it refuses
        # only a polynomial's division with a Python float or complex)
        x, y = (repr(b.parent()) if k == "sage" else "<class '%s'>" % type(b).__name__), repr(B if op == "call" else a.parent())
        raise NotImplementedError("arithmetic with %s and %s together is not available in sagebrush yet" % ((x, y) if rev else (y, x)))
    if op == "==":
        return False
    if op == "call":
        theirs = repr(b.parent()) if k == "sage" else "<class '%s'>" % type(b).__name__
        raise TypeError("no common canonical parent for objects with parents: '%r' and '%s'" % (B, theirs))
    if k == "sage" and op == "/" and rev and is_poly and not B.is_field():
        # (RR(2) / f over Zmod(6): Sage's fraction field of the polynomials)
        raise TypeError("self must be an integral domain")
    if k == "sage":
        x, y = repr(b.parent()), _ring_repr(a)
        raise TypeError("unsupported operand parent(s) for %s: '%s' and '%s'" % ((op, x, y) if rev else (op, y, x)))
    c = sage_polynomial_class(B) if is_poly else _sage_element_class(a)
    if c is None:
        raise TypeError("sagebrush does not compute %s with %r and a Python %s" % (op, a.parent(), type(b).__name__))
    x = type(b).__name__
    raise TypeError("unsupported operand type(s) for %s: '%s' and '%s'" % ((op, x, c) if rev else (op, c, x)))
