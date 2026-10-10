"""A small, pure-Python taste of Sage, imported into Sage mode.

Sage mode (``sagebrush --sage``, ``.sage`` files, the Sage toggle on
sagebrush.space) changes the syntax: ``^`` is exponentiation, ``^^`` is
xor and ``/`` on two integers gives an exact :class:`Rational`.  This
module supplies Rational and a handful of Sage's number theory functions.
"""

import math as _math
from fractions import Fraction as _Fraction

__all__ = [
    # permutation groups (Sagebrush's engine)
    "PermutationGroup", "PermutationGroupElement", "SymmetricGroup", "AlternatingGroup",
    "CyclicPermutationGroup", "DihedralGroup", "MathieuGroup", "PSL", "PGL", "KleinFourGroup", "TransitiveGroup", "TransitiveGroups",
    # modular forms and elliptic curves (Sagebrush's engines)
    "ModularSymbols", "ModularForms", "CuspForms", "Gamma0", "DirichletGroup", "EllipticCurve",
    "Newforms", "newform_orbits",
    # number fields, integer matrices (engine/classgroup)
    "NumberField", "QuadraticField", "CyclotomicField",
    # finite fields and Z/nZ
    "QQbar", "AA", "RealField", "ComplexField", "RealIntervalField", "RIF", "RDF", "CDF", "PowerSeriesRing", "LaurentSeriesRing", "O", "Graph", "DiGraph", "graphs", "digraphs", "true", "false",
    "Sandpile", "SandpileConfig", "SandpileDivisor", "sandpiles", "firing_graph", "parallel_firing_graph", "numerical_approx", "CartanType", "RootSystem", "DynkinDiagram", "WeylGroup", "WeylCharacterRing", "WeightRing", "branching_rule", "branching_rule_from_plethysm", "BranchingRule", "crystals", "Tableau", "Word", "CartanMatrix", "Polyhedron", "polytopes", "EuclideanSpace", "FiniteRankFreeModule", "rank", "dim", "MixedIntegerLinearProgram", "codes", "channels", "LinearCode", "lfsr_sequence", "lfsr_autocorrelation", "lfsr_connection_polynomial", "IndexedSequence", "AlphabeticStrings", "SubstitutionCryptosystem", "TranspositionCryptosystem", "random_vector", "ideal", "Ideal", "TermOrder", "GF", "FiniteField", "IntegerModRing", "Integers", "Zmod", "Mod", "mod", "primitive_root",
    "conway_polynomial", "VectorSpace", "random_matrix",
    "RationalField", "IntegerRing", "randint", "random", "bernoulli", "zeta", "symbolic_sum", "sum", "assume", "forget", "assumptions", "assuming", "hue", "norm", "timeit", "set_random_seed", "initial_seed",
    "matrix", "Matrix", "MatrixSpace", "identity_matrix", "zero_matrix", "diagonal_matrix", "CC", "vector",
    "block_matrix", "block_diagonal_matrix", "column_matrix", "kernel",
    "Rational", "Integer", "ZZ", "QQ", "RR", "factor", "Factorization",
    "PolynomialRing", "polygen", "parent",
    "is_prime", "is_prime_power", "is_square", "is_squarefree", "next_prime", "previous_prime", "nth_prime",
    "prime_range", "primes", "primes_first_n", "prime_pi", "divisors", "number_of_divisors",
    "sigma", "euler_phi", "moebius", "gcd", "lcm", "xgcd", "inverse_mod", "power_mod", "crt",
    "binomial", "factorial", "fibonacci", "catalan_number", "tmp_filename", "tmp_dir", "isqrt", "sqrt", "srange", "prod", "continued_fraction",
    "numerator", "denominator", "valuation", "digits", "n", "N", "pi", "e",
    # the language: [a..b], 1.5, f(x) = ...
    "ellipsis_range", "ellipsis_iter", "RealNumber", "symbolic_expression",
    # symbolic expressions (the Rust engine, engine/sym)
    "var", "x", "SR", "I", "oo", "infinity", "Infinity", "euler_gamma", "function",
    "sin", "cos", "tan", "cot", "sec", "csc", "asin", "acos", "atan", "arcsin", "arccos", "arctan",
    "arccot", "arcsec", "arccsc", "atan2", "arctan2", "sinh", "cosh", "tanh", "coth", "sech", "csch",
    "arcsinh", "arccosh", "arctanh", "asinh", "acosh", "atanh", "exp", "log", "ln", "floor", "ceil",
    "ceiling", "gamma", "erf", "sgn", "sign", "heaviside",
    "diff", "derivative", "integrate", "integral", "integrate_steps", "numerical_integral",
    "desolve", "desolve_rk4",
    "taylor", "limit", "lim", "solve", "expand",
    "simplify", "find_root", "latex",
    # graphics
    "Graphics", "plot", "parametric_plot", "polar_plot", "list_plot", "line", "line2d", "point",
    "points", "point2d", "text", "polygon", "polygon2d", "circle", "disk", "arrow", "arrow2d",
    "bar_chart", "show", "graphics_array", "animate", "Animation",
    "Graphics3d", "plot3d", "parametric_plot3d", "implicit_plot3d", "spherical_plot3d",
    "cylindrical_plot3d", "revolution_plot3d", "sphere", "point3d", "line3d", "text3d", "arrow3d",
    "polygon3d", "plot_vector_field3d", "tetrahedron", "cube", "octahedron",
    "dodecahedron", "icosahedron", "contour_plot", "density_plot", "implicit_plot",
    "region_plot", "plot_vector_field", "plot_slope_field",
    # interact
    "search_doc", "interact", "slider", "range_slider", "selector", "checkbox", "input_box", "color_selector",
    "text_control",
]

from _sage_expr import (Expression as _Expr, _expr, var, x, pi, e, I, oo, infinity, Infinity, symbolic_sum, assume, forget, assumptions, assuming,
                        euler_gamma, SR, function, sin, cos, tan, cot, sec, csc, asin, acos, atan,
                        arcsin, arccos, arctan, arccot, arcsec, arccsc, atan2, arctan2, sinh, cosh,
                        tanh, coth, sech, csch, arcsinh, arccosh, arctanh, asinh, acosh, atanh, exp,
                        log, ln, floor, ceil, ceiling, gamma, erf, sgn, sign, heaviside, diff,
                        derivative, integrate, integral, integrate_steps, numerical_integral, desolve,
                        desolve_rk4, taylor, limit,
                        lim, solve, expand, simplify,
                        find_root, latex, _py_number)
from sage_plot import Graphics as _Graphics2d, GraphicsArray as _GraphicsArray, Animation as _Animation
from sage_plot import (Graphics, plot, parametric_plot, polar_plot, list_plot, line, line2d, point,
                       points, point2d, text, polygon, polygon2d, circle, disk, arrow, arrow2d,
                       bar_chart, show as _show2d, graphics_array, animate, Animation)
from sage_permgroup import (PermutationGroup, PermutationGroupElement, SymmetricGroup, AlternatingGroup,
                             CyclicPermutationGroup, DihedralGroup, MathieuGroup, PSL, PGL, KleinFourGroup, TransitiveGroup, TransitiveGroups)
from sage_plot3d import (Graphics3d, plot3d, parametric_plot3d, implicit_plot3d, spherical_plot3d,
                         cylindrical_plot3d, revolution_plot3d, sphere, tetrahedron, cube, octahedron,
                         dodecahedron, icosahedron, point3d, line3d, text3d,
                         arrow3d, polygon3d, plot_vector_field3d)
from sage_plot_fields import (contour_plot, density_plot, implicit_plot, region_plot,
                              plot_vector_field, plot_slope_field)


def show(obj, **options):
    """Show a picture (2D or 3D); typeset an expression or anything with a
    LaTeX form (in the notebook and Jupyter), else print it.

    EXAMPLES::

        sage: show(x^2 + 1)  # random
    """
    if isinstance(obj, Graphics3d):
        return obj.show(**options)
    if not isinstance(obj, (_Graphics2d, _GraphicsArray, _Animation)) and (
            hasattr(obj, "_latex_") or isinstance(obj, (int, _Fraction, list, tuple))):
        from _sage_expr import show_typeset
        return show_typeset(obj)
    return _show2d(obj, **options)
from _sage_modular import (ModularSymbols, ModularForms, CuspForms, Gamma0, DirichletGroup,
                           EllipticCurve, Newforms, newform_orbits)
from _sage_poly import ZZ, QQ, PolynomialRing, polygen, Polynomial as _Polynomial
from _sage_nf import NumberField, QuadraticField, CyclotomicField
from _sage_ff import (GF, FiniteField, IntegerModRing, Integers, Zmod, Mod, mod, primitive_root,
                      conway_polynomial)
from _sage_qqbar import QQbar, AA
from _sage_mpoly import ideal, Ideal, TermOrder
from _sage_real import RealField, ComplexField, RealIntervalField, RIF
from _sage_rdf import RDF, CDF
from _sage_series import PowerSeriesRing, LaurentSeriesRing, O
from _sage_graph import Graph, DiGraph, graphs, digraphs
true, false = True, False
from _sage_sandpile import Sandpile, SandpileConfig, SandpileDivisor, sandpiles, firing_graph, parallel_firing_graph
from _sage_lie import (CartanType, RootSystem, DynkinDiagram, WeylGroup, WeylCharacterRing, WeightRing,
                       branching_rule, branching_rule_from_plethysm, BranchingRule, CartanMatrix)
from _sage_crystals import crystals, Tableau, Word
from _sage_polyhedra import Polyhedron, polytopes
from _sage_manifolds import EuclideanSpace, FiniteRankFreeModule, rank, dim
from _sage_milp import MixedIntegerLinearProgram
from _sage_coding import (codes, channels, LinearCode, lfsr_sequence, lfsr_autocorrelation, lfsr_connection_polynomial,
                          IndexedSequence, AlphabeticStrings, SubstitutionCryptosystem, TranspositionCryptosystem)


def RationalField():
    """The field of rationals, QQ.

    EXAMPLES::

        sage: RationalField(), RationalField() is QQ
        (Rational Field, True)
    """
    return QQ


def IntegerRing():
    """The ring of integers, ZZ.

    EXAMPLES::

        sage: IntegerRing()
        Integer Ring
    """
    return ZZ


_SEED = [None]


def set_random_seed(seed=None):
    """Seed the random number generators (Python's random); None: from the
    system.  The streams differ from Sage's.

    EXAMPLES::

        sage: set_random_seed(5); a = randint(1, 10**9); set_random_seed(5); a == randint(1, 10**9)
        True
    """
    import random as _r
    if seed is None:
        import os as _os
        seed = int.from_bytes(_os.urandom(8), "little")
    _SEED[0] = int(seed)
    _r.seed(int(seed))


def random():
    """A random float in [0, 1) (Python's random.random, seeded by
    set_random_seed).

    EXAMPLES::

        sage: 0 <= random() < 1
        True
    """
    import random as _r
    return _r.random()


def initial_seed():
    """The last seed given to set_random_seed.

    EXAMPLES::

        sage: set_random_seed(17); initial_seed()
        17
    """
    return _SEED[0]


def randint(a, b):
    """A random integer in [a, b] (Python's random.randint, as in Sage).

    EXAMPLES::

        sage: 1 <= randint(1, 10) <= 10
        True
    """
    import random as _r
    return _r.randint(int(a), int(b))


def hue(h, s=1, v=1):
    """The RGB color (floats in [0, 1]) of hue h (taken modulo 1),
    saturation s and value v.

    EXAMPLES::

        sage: hue(0.3), hue(0), hue(0.5, 0.5, 0.8)
        ((0.20000000000000018, 1.0, 0.0), (1.0, 0.0, 0.0), (0.4, 0.8, 0.8))
    """
    import colorsys
    h = float(h)
    h -= _math.floor(h)
    return tuple(float(c) for c in colorsys.hsv_to_rgb(h, float(s), float(v)))


def norm(x):
    """x.norm(): the Euclidean norm of a vector, the algebraic norm of a
    number (|z|^2 for a complex number).

    EXAMPLES::

        sage: norm(vector([3, 4])), norm(3 + 4*I)
        (5, 25)
    """
    if hasattr(x, "norm"):
        return x.norm()
    if isinstance(x, complex):
        return x.real ** 2 + x.imag ** 2
    try:
        from _sage_expr import Expression as _E
        if isinstance(x, _E):
            return (x * x.conjugate()).expand().simplify()
    except ImportError:
        pass
    return x * x


def timeit(stmt, number=0, repeat=3, globals=None, **kwds):
    """Time a statement and print Sage's summary line (the timings vary).

    EXAMPLES::

        sage: timeit("2 + 2")  # random
        625 loops, best of 3: 41.3 ns per loop
    """
    import time as _t
    import sys as _s
    g = globals if globals is not None else _s.modules["__main__"].__dict__
    code = compile(str(stmt), "<timeit>", "exec")
    n = int(number) or 1
    if not number:
        while True:
            t0 = _t.perf_counter()
            for _ in range(n):
                exec(code, g)
            if _t.perf_counter() - t0 > 0.2 or n >= 10 ** 6:
                break
            n *= 5
    best = None
    for _ in range(int(repeat)):
        t0 = _t.perf_counter()
        for _ in range(n):
            exec(code, g)
        d = (_t.perf_counter() - t0) / n
        best = d if best is None or d < best else best
    for unit, scale in (("s", 1), ("ms", 1e-3), ("\u03bcs", 1e-6), ("ns", 1e-9)):
        if best >= scale or unit == "ns":
            print("%d loops, best of %d: %.3g %s per loop" % (n, int(repeat), best / scale, unit))
            break


def VectorSpace(base, n):
    """The vector space base^n (over a finite field, so far).

    EXAMPLES::

        sage: VectorSpace(GF(2), 8)
        Vector space of dimension 8 over Finite Field of size 2
    """
    import _sage_ffmat
    if _sage_ffmat._is_ff(base):
        return _sage_ffmat.VectorSpace(base, n)
    if base is QQ:
        import _sage_matrix
        return _sage_matrix.VectorSpace_QQ(int(n))
    raise NotImplementedError("VectorSpace over %r is not available in sagebrush yet" % (base,))


def random_matrix(base, nrows, ncols=None, **kwds):
    """A random matrix (over a finite field, ZZ or QQ).

    EXAMPLES::

        sage: random_matrix(GF(2), 3, 4).parent()
        Full MatrixSpace of 3 by 4 dense matrices over Finite Field of size 2
        sage: random_matrix(ZZ, 2).parent()
        Full MatrixSpace of 2 by 2 dense matrices over Integer Ring
    """
    import _sage_ffmat
    if _sage_ffmat._is_ff(base):
        return _sage_ffmat.random_matrix(base, nrows, ncols)
    import _sage_matrix
    return _sage_matrix.random_matrix(base, nrows, ncols, **kwds)
from _sage_matrix import (matrix, MatrixSpace, identity_matrix, zero_matrix, diagonal_matrix, CC, vector,
                          block_matrix, block_diagonal_matrix, column_matrix, kernel)
Matrix = matrix


def parent(x):
    """The parent structure of x: ZZ, QQ, a polynomial ring, ...

    EXAMPLES::

        sage: parent(2), parent(2/3), parent(1.5)
        (Integer Ring, Rational Field, Real Field with 53 bits of precision)
    """
    if hasattr(x, "parent"):
        return x.parent()
    if isinstance(x, bool) or isinstance(x, int):
        return ZZ
    if isinstance(x, _Fraction):
        return QQ
    if isinstance(x, float):
        from _sage_lang import _RealField
        return _RealField()
    raise NotImplementedError("parent of %r" % (x,))


from _pyjs_docsearch import search_doc

# `from sage.x.y import name` for code written for Sage (pyjs only: under
# CPython a real Sage may be installed)
import sys as _sys0
if _sys0.implementation.name == "pyjs":
    import _sage_shim
    _sage_shim.install()
# the name sage, as in a Sage session (sage.rings.ideal.Katsura(R), ...),
# when the shim serves it
if "_sage_shim" in _sys0.modules and _sys0.modules["_sage_shim"]._INSTALLED:
    import sage
    __all__.append("sage")

from _interact import (interact, slider, range_slider, selector, checkbox, input_box,
                       color_selector, text_control)


# ------------------------------------------------------------------ Rational

def _q(x):
    # A Fraction result as Sage would show it: an int when it is integral.
    if type(x) is _Fraction:
        if x._denominator == 1:
            return Integer(x._numerator)
        return Rational._from_coprime_ints(x._numerator, x._denominator)
    return x


def _lift(name):
    # Do the arithmetic on a plain Fraction: with a Rational operand, Python
    # would try Rational's reflected method first and recurse.
    op = getattr(_Fraction, name)

    def f(a, b):
        try:
            return _q(op(_Fraction._from_coprime_ints(a._numerator, a._denominator), b))
        except ZeroDivisionError:
            raise ZeroDivisionError("rational division by zero") from None
    f.__name__ = name
    return f


def _rational_power(b, e):
    """b^e for rationals b and e = p/q: exact when b is a q-th power (as
    (4/9)^(1/2) = 2/3), else symbolic (2^(1/3))."""
    p, q = e.numerator, e.denominator
    b = _Fraction(b)
    if b >= 0:  # (Sage: (-8)^(1/3) = 2*(-1)^(1/3))
        def root(n):
            neg = n < 0
            n = abs(n)
            r = round(n ** (1.0 / q)) if n < 2 ** 1000 else int(_math.isqrt(n)) if q == 2 else None
            if r is None:
                return None
            for c in (r - 1, r, r + 1):
                if c >= 0 and c ** q == n:
                    return -c if neg else c
            return None
        a, d = root(b.numerator), root(b.denominator)
        if a is not None and d is not None:
            r = _Fraction(a, d) ** p
            return Integer(r.numerator) if r.denominator == 1 else Rational._from_coprime_ints(r.numerator, r.denominator)
    return SR(Integer(b.numerator) if b.denominator == 1 else Rational._from_coprime_ints(b.numerator, b.denominator)) ** SR(Rational._from_coprime_ints(p, q))


class Rational(_Fraction):
    """An exact rational number, such as ``2/3`` in Sage mode.

    EXAMPLES::

        sage: a = 2/3; a
        2/3
        sage: type(a).__name__  # sagebrush only
        'Rational'
        sage: a + 1/3, a * 3/4, a^2, a.numerator(), a.denominator()
        (1, 1/2, 4/9, 2, 3)
    """

    __slots__ = ()

    def __repr__(self):
        return f"{self._numerator}/{self._denominator}"

    __str__ = __repr__

    def _repr_latex_(self):
        return f"$\\frac{{{self._numerator}}}{{{self._denominator}}}$"

    __add__ = _lift("__add__")
    __radd__ = _lift("__radd__")
    __sub__ = _lift("__sub__")
    __rsub__ = _lift("__rsub__")
    __mul__ = _lift("__mul__")
    __rmul__ = _lift("__rmul__")
    __truediv__ = _lift("__truediv__")
    __rtruediv__ = _lift("__rtruediv__")
    __mod__ = _lift("__mod__")
    __rmod__ = _lift("__rmod__")
    _pow = _lift("__pow__")
    _rpow = _lift("__rpow__")

    def __pow__(self, e, mod=None):
        if isinstance(e, _Fraction) and e.denominator != 1:
            return _rational_power(self, e)
        return Rational._pow(self, e)

    def __rpow__(self, b):
        if isinstance(b, (int, _Fraction)) and not isinstance(b, bool) and self._denominator != 1:
            return _rational_power(_Fraction(b), self)
        return Rational._rpow(self, b)

    def __neg__(self):
        return Rational._from_coprime_ints(-self._numerator, self._denominator)

    def __pos__(self):
        return self

    def __abs__(self):
        return Rational._from_coprime_ints(abs(self._numerator), self._denominator)

    @property
    def numerator(self):
        """The numerator.

        EXAMPLES::

            sage: (6/4).numerator()
            3
        """
        return _CallableInt(self._numerator)

    @property
    def denominator(self):
        """The denominator.

        EXAMPLES::

            sage: (6/4).denominator()
            2
        """
        return _CallableInt(self._denominator)

    def n(self, prec=None, digits=None):
        """A floating-point approximation (prec bits or digits decimal
        digits).

        EXAMPLES::

            sage: (1/3).n()
            0.333333333333333
            sage: (1/3).n(digits=30), (1/3).n(20)
            (0.333333333333333333333333333333, 0.33333)
        """
        if digits is not None or prec is not None:
            import _sage_real
            return _sage_real.N(self, prec, digits)
        return RealNumber(float(self))

    numerical_approx = N = n

    def floor(self):
        """The floor.

        EXAMPLES::

            sage: (7/2).floor(), (-7/2).floor()
            (3, -4)
        """
        return _math.floor(self)

    def ceil(self):
        """The ceiling.

        EXAMPLES::

            sage: (7/2).ceil(), (-7/2).ceil()
            (4, -3)
        """
        return _math.ceil(self)

    def is_integer(self):
        """Whether the rational number is an integer.

        EXAMPLES::

            sage: (4/2).is_integer(), (3/2).is_integer()
            (True, False)
        """
        return self._denominator == 1


def _intdiv(a, b):
    # The runtime's `/` on two ints in Sage mode.
    if b == 0:
        raise ZeroDivisionError("rational division by zero")
    a, b = int(a), int(b)
    if b < 0:
        a, b = -a, -b
    g = _math.gcd(a, b)
    if g != 1:
        a //= g
        b //= g
    if b == 1:
        return Integer(a)
    return Rational._from_coprime_ints(a, b)


def Integer(x):
    """The integer x.

    EXAMPLES::

        sage: Integer(7), Integer('123456789012345678901234567890')
        (7, 123456789012345678901234567890)
    """
    return int(x)


def _QQ(x, d=None):
    """QQ(2, 3) or QQ("2/3") or QQ(0.75): the exact rational."""
    if d is not None and d == 0:
        raise ZeroDivisionError("rational division by zero")
    if d is None and hasattr(x, "_rational_"):
        x = x._rational_()
    f = _Fraction(x) if d is None else _Fraction(x, d)
    if type(f) is not _Fraction:
        f = _Fraction(f._numerator, f._denominator)
    return _q(f)


from _sage_lang import (RealNumber, ellipsis_range, ellipsis_iter, symbolic_expression,
                        SymbolicFunction, _install_int_methods, _CallableInt)


from _sage_lang import _RealField
RR = _RealField()

from _sage_lang import proof
__all__.append("proof")


def numerator(x):
    """The numerator of x.

    EXAMPLES::

        sage: numerator(6/4), numerator(5)
        (3, 5)
    """
    return x.numerator


def denominator(x):
    """The denominator of x.

    EXAMPLES::

        sage: denominator(6/4), denominator(5)
        (2, 1)
    """
    return x.denominator


def n(x, prec=None, digits=None, algorithm=None):
    """The numerical approximation of x: an element of RR, or of
    RealField(prec) / ComplexField(prec) for prec bits or digits decimal
    digits.

    EXAMPLES::

        sage: n(pi)
        3.14159265358979
        sage: n(1/7, digits=20), n(10^30/7, digits=20), n(2/3, digits=3)
        (0.14285714285714285714, 1.4285714285714285714e29, 0.667)
        sage: n(pi, digits=5), N(pi, prec=100)
        (3.1416, 3.1415926535897932384626433833)
        sage: N(pi, digits=50)
        3.1415926535897932384626433832795028841971693993751
        sage: N(exp(I), 100)
        0.54030230586813971740093660744 + 0.84147098480789650665250232163*I
    """
    if prec is not None or digits is not None:
        import _sage_real
        p = _sage_real.digits_to_prec(digits) if digits is not None else int(prec)
        if p != 53 or getattr(x, "_s", None) is None:
            if hasattr(x, "n") and not isinstance(x, (int, float, _Fraction)) and getattr(x, "_s", None) is None and not isinstance(x, (_sage_real.RealNumberMP, _sage_real.ComplexNumberMP)):
                try:
                    return x.n(prec=p)
                except TypeError:
                    pass
            return _sage_real.N(x, p)
    if hasattr(x, "n") and not isinstance(x, (int, float)):
        return x.n()
    return RealNumber(float(x))


numerical_approx = n
N = n


# ------------------------------------------------------------------ primes

_SMALL = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97)


def _sprp(n, a):
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    x = pow(a, d, n)
    if x == 1 or x == n - 1:
        return True
    for _ in range(s - 1):
        x = x * x % n
        if x == n - 1:
            return True
    return False


def _lucas_prp(n):
    # Strong Lucas probable prime test with Selfridge's parameters.
    d = 5
    while True:
        j = _jacobi(d, n)
        if j == -1:
            break
        if j == 0 and abs(d) != n:
            return False
        d = -d - 2 if d > 0 else -d + 2
        if d == 13 and is_square(n):
            return False
    p, q = 1, (1 - d) // 4
    k, s = n + 1, 0
    while k % 2 == 0:
        k //= 2
        s += 1
    u, v, qk = 1, p, q
    for bit in bin(k)[3:]:
        u, v = u * v % n, (v * v - 2 * qk) % n
        qk = qk * qk % n
        if bit == "1":
            u, v = p * u + v, d * u + p * v
            if u % 2:
                u += n
            if v % 2:
                v += n
            u, v = (u // 2) % n, (v // 2) % n
            qk = qk * q % n
    if u == 0 or v == 0:
        return True
    for _ in range(s - 1):
        v = (v * v - 2 * qk) % n
        if v == 0:
            return True
        qk = qk * qk % n
    return False


def _jacobi(a, n):
    a %= n
    result = 1
    while a:
        while a % 2 == 0:
            a //= 2
            if n % 8 in (3, 5):
                result = -result
        a, n = n, a
        if a % 4 == 3 and n % 4 == 3:
            result = -result
        a %= n
    return result if n == 1 else 0


def is_prime(n, proof=None):
    """Whether n is prime: proven below 3.3e24 (Miller-Rabin to the first 13
    prime bases is deterministic there), by BPSW above (no counterexample is
    known, but it is not a proof).  "Composite" is always proven.  With
    proof=True, a prime above 3.3e24 is NotImplementedError: no primality
    proof (ECPP, APR-CL) is implemented yet.

    EXAMPLES::

        sage: is_prime(2), is_prime(91), is_prime(2^127 - 1)
        (True, False, True)
        sage: [p for p in range(30) if is_prime(p)]
        [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
        sage: ZZ(2^61 - 1).is_prime(proof=True), ZZ(2^127 - 3).is_prime(proof=True)
        (True, False)
        sage: ZZ(2^127 - 1).is_prime(proof=True)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: a primality proof above 3.3e24 is not implemented: n passes BPSW, which is not a proof (call is_prime with proof=False)
    """
    n = int(n)
    if n < 2:
        return False
    for p in _SMALL:
        if n % p == 0:
            return n == p
    if n < 10201:
        return True
    if n < 3317044064679887385961981:
        return all(_sprp(n, a) for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41) if a < n)
    if not (_sprp(n, 2) and _lucas_prp(n)):
        return False
    if proof:
        raise NotImplementedError("a primality proof above 3.3e24 is not implemented: n passes BPSW, which is not a proof (call is_prime with proof=False)")
    return True


def next_prime(n):
    """The smallest prime > n.

    EXAMPLES::

        sage: next_prime(10), next_prime(2^64)
        (11, 18446744073709551629)
    """
    n = int(n) + 1
    if n <= 2:
        return 2
    if n % 2 == 0:
        n += 1
    while not is_prime(n):
        n += 2
    return n


def previous_prime(n):
    """The largest prime < n.

    EXAMPLES::

        sage: previous_prime(10), previous_prime(2^64)
        (7, 18446744073709551557)
    """
    n = int(n) - 1
    if n < 2:
        raise ValueError("no prime less than 2")
    while not is_prime(n):
        n -= 1
    return n


def prime_range(start, stop=None):
    """The primes p with start <= p < stop (or 2 <= p < start).

    EXAMPLES::

        sage: prime_range(20)
        [2, 3, 5, 7, 11, 13, 17, 19]
        sage: prime_range(100, 130)
        [101, 103, 107, 109, 113, 127]
    """
    if stop is None:
        start, stop = 2, start
    start, stop = max(int(start), 2), int(stop)
    if stop <= start:
        return []
    sieve = bytearray([1]) * stop
    sieve[0:2] = b"\x00\x00"
    for p in range(2, isqrt(stop - 1) + 1):
        if sieve[p]:
            sieve[p * p::p] = bytes(len(range(p * p, stop, p)))
    return [i for i in range(start, stop) if sieve[i]]


def primes(start, stop=None):
    """Iterate over the primes in [start, stop) (or [2, start)).

    EXAMPLES::

        sage: list(primes(10, 40))
        [11, 13, 17, 19, 23, 29, 31, 37]
    """
    if stop is None:
        start, stop = 2, start
    p = next_prime(int(start) - 1)
    while p < stop:
        yield p
        p = next_prime(p)


def primes_first_n(k):
    """The first k primes.

    EXAMPLES::

        sage: primes_first_n(10)
        [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
    """
    out, p = [], 1
    while len(out) < k:
        p = next_prime(p)
        out.append(p)
    return out


def nth_prime(k):
    """The k-th prime.

    EXAMPLES::

        sage: nth_prime(1), nth_prime(100), nth_prime(10000)
        (2, 541, 104729)
    """
    if k < 1:
        raise ValueError("n must be positive")
    return primes_first_n(k)[-1]


def prime_pi(x):
    """The number of primes <= x.

    EXAMPLES::

        sage: prime_pi(100), prime_pi(10^6)
        (25, 78498)
    """
    return len(prime_range(int(x) + 1))


# ------------------------------------------------------------------ factoring

def _rho(n):
    # Pollard rho, Brent's variant: a nontrivial factor of composite odd n.
    c = 1
    while True:
        y, r, q, g = 2, 1, 1, 1
        f = lambda x: (x * x + c) % n
        while g == 1:
            x = y
            for _ in range(r):
                y = f(y)
            k = 0
            while k < r and g == 1:
                ys = y
                for _ in range(min(128, r - k)):
                    y = f(y)
                    q = q * abs(x - y) % n
                g = _math.gcd(q, n)
                k += 128
            r *= 2
        if g == n:
            g = 1
            while g == 1:
                ys = f(ys)
                g = _math.gcd(abs(x - ys), n)
        if g != n:
            return g
        c += 1


def _factor_into(n, out):
    if n == 1:
        return
    if is_prime(n):
        out[n] = out.get(n, 0) + 1
        return
    d = _rho(n)
    _factor_into(d, out)
    _factor_into(n // d, out)


class Factorization(list):
    """A factorization: a list of (prime, exponent) pairs that prints like Sage.

    EXAMPLES::

        sage: F = factor(360); F
        2^3 * 3^2 * 5
        sage: list(F)
        [(2, 3), (3, 2), (5, 1)]
        sage: F.value()
        360
    """

    def __init__(self, pairs, unit=1):
        super().__init__(pairs)
        self.unit = unit

    def __repr__(self):
        if not self:
            return str(self.unit)
        s = " * ".join(f"{p}^{e}" if e != 1 else str(p) for p, e in self)
        return ("-1 * " if self.unit == -1 else "") + s

    __str__ = __repr__

    def value(self):
        """The product of the factorization.

        EXAMPLES::

            sage: factor(-360).value()
            -360
        """
        v = self.unit
        for p, e in self:
            v *= p ** e
        return v

    def expand(self):
        """The product of the factorization (as Sage's expand()).

        EXAMPLES::

            sage: factor(1001).expand()
            1001
        """
        return self.value()


def factor(n, proof=None, **kwds):
    """The prime factorization of a nonzero integer (or Rational), or of a
    polynomial.  Prime factors above 3.3e24 are primes by BPSW, not proven;
    with proof=True each must be proven (see is_prime), else
    NotImplementedError.

    EXAMPLES::

        sage: factor(2^64 + 1)
        274177 * 67280421310721
        sage: factor(-360)
        -1 * 2^3 * 3^2 * 5
        sage: factor(2/15)
        2 * 3^-1 * 5^-1
        sage: R.<x> = ZZ[]
        sage: factor(x^4 - 1)
        (x - 1) * (x + 1) * (x^2 + 1)
    """
    if isinstance(n, (_Polynomial, _Expr)):
        return n.factor()
    if not isinstance(n, (int, _Fraction)) and hasattr(n, "factor"):
        return n.factor()
    if isinstance(n, _Fraction) and n.denominator != 1:
        num, den = factor(n.numerator), factor(n.denominator)
        pairs = sorted(list(num) + [(p, -e) for p, e in den])
        return Factorization(pairs, num.unit)
    n = int(n)
    if n == 0:
        raise ArithmeticError("factorization of 0 is not defined")
    unit = -1 if n < 0 else 1
    n = abs(n)
    out = {}
    for p in _SMALL:
        while n % p == 0:
            out[p] = out.get(p, 0) + 1
            n //= p
    if n > 1 << 40:
        # the Rust engine (sagebrush.nf.factor_integer)
        from sagebrush import nf as _nfmod
        for p, e in _nfmod.factor_integer(n):
            out[p] = out.get(p, 0) + e
    else:
        _factor_into(n, out)
    if proof:
        for p in out:
            is_prime(p, proof=True)
    return Factorization(sorted(out.items()), unit)


def divisors(n):
    """The sorted list of positive divisors of n.

    EXAMPLES::

        sage: divisors(28)
        [1, 2, 4, 7, 14, 28]
    """
    ds = [1]
    for p, e in factor(abs(int(n))):
        ds = [d * p ** k for d in ds for k in range(e + 1)]
    return sorted(ds)


def number_of_divisors(n):
    """The number of positive divisors of n.

    EXAMPLES::

        sage: number_of_divisors(28), number_of_divisors(2^10 * 3^5)
        (6, 66)
    """
    return prod(e + 1 for _, e in factor(n))


def sigma(n, k=1):
    """The sum of the k-th powers of the divisors of n.

    EXAMPLES::

        sage: sigma(28), sigma(10, 2), sigma(10, 0)
        (56, 130, 4)
    """
    return sum(d ** k for d in divisors(n))


def euler_phi(n):
    """Euler's totient function.

    EXAMPLES::

        sage: euler_phi(36), [euler_phi(n) for n in range(1, 13)]
        (12, [1, 1, 2, 2, 4, 2, 6, 4, 6, 4, 10, 4])
    """
    n = int(n)
    if n < 1:
        return 0
    r = n
    for p, _ in factor(n):
        r = r // p * (p - 1)
    return r


def moebius(n):
    """The Moebius function.

    EXAMPLES::

        sage: [moebius(n) for n in range(1, 13)]
        [1, -1, -1, 0, -1, 1, -1, 0, 0, 1, -1, 0]
    """
    f = factor(n)
    if any(e > 1 for _, e in f):
        return 0
    return -1 if len(f) % 2 else 1


def is_prime_power(n):
    """Whether n is a prime power p^k with k >= 1.

    EXAMPLES::

        sage: is_prime_power(8), is_prime_power(12), is_prime_power(1)
        (True, False, False)
    """
    return int(n) > 1 and len(factor(n)) == 1


def is_squarefree(n):
    """True if no square of a prime divides n (n != 0).

    EXAMPLES::

        sage: is_squarefree(30), is_squarefree(12)
        (True, False)
    """
    n = abs(int(n))
    if n == 0:
        return False
    return all(e == 1 for _, e in factor(n))


def is_square(n):
    """Whether n is a perfect square.

    EXAMPLES::

        sage: is_square(144), is_square(145), is_square(9/4)
        (True, False, True)
    """
    if isinstance(n, _Fraction) and n.denominator != 1:
        return is_square(n.numerator) and is_square(n.denominator)
    n = int(n)
    return n >= 0 and isqrt(n) ** 2 == n


def valuation(n, p):
    """The exponent of the prime p in n.

    EXAMPLES::

        sage: valuation(48, 2), valuation(3/8, 2), valuation(50, 5)
        (4, -3, 2)
    """
    if isinstance(n, _Fraction) and n.denominator != 1:
        return valuation(n.numerator, p) - valuation(n.denominator, p)
    n, v = int(n), 0
    if n == 0:
        raise ValueError("valuation of 0 is infinite")
    while n % p == 0:
        n //= p
        v += 1
    return v


def digits(n, base=10):
    """The digits of n in base, least significant first (as in Sage).

    EXAMPLES::

        sage: digits(1234), digits(255, 16), digits(10, 2)  # sagebrush only
        ([4, 3, 2, 1], [15, 15], [0, 1, 0, 1])
    """
    n, out = abs(int(n)), []
    while n:
        n, d = divmod(n, base)
        out.append(d)
    return out


# ------------------------------------------------------------------ arithmetic

def gcd(*args):
    """The greatest common divisor.

    EXAMPLES::

        sage: gcd(12, 18), gcd([12, 18, 27]), gcd(2/3, 4/9)
        (6, 3, 2/9)
    """
    if len(args) == 1:
        args = tuple(args[0])
    if any(isinstance(a, _Polynomial) or type(a).__name__ == "MPolynomial" for a in args):
        r = args[0]
        for a in args[1:]:
            r = r.gcd(a) if hasattr(r, "gcd") and not isinstance(r, int) else a.gcd(r)
        return r
    if any(isinstance(a, _Fraction) for a in args):
        r = _Fraction(0)
        for a in args:
            a = _Fraction(a)
            r = _Fraction(_math.gcd(r.numerator, a.numerator), _math.lcm(r.denominator, a.denominator))
        return _q(r)
    return _math.gcd(*args)


def lcm(*args):
    """The least common multiple.

    EXAMPLES::

        sage: lcm(4, 6), lcm([2, 3, 4, 5])
        (12, 60)
    """
    if len(args) == 1:
        args = tuple(args[0])
    if any(isinstance(a, _Polynomial) or type(a).__name__ == "MPolynomial" for a in args):
        r = args[0]
        for a in args[1:]:
            r = r.lcm(a) if hasattr(r, "lcm") and not isinstance(r, int) else a.lcm(r)
        return r
    return _math.lcm(*args)


def xgcd(a, b):
    """(g, s, t) with g = gcd(a, b) = s*a + t*b.

    EXAMPLES::

        sage: xgcd(240, 46)
        (2, -9, 47)
    """
    x0, x1, y0, y1 = 1, 0, 0, 1
    while b:
        q, a, b = a // b, b, a % b
        x0, x1 = x1, x0 - q * x1
        y0, y1 = y1, y0 - q * y1
    if a < 0:
        a, x0, y0 = -a, -x0, -y0
    return (a, x0, y0)


def inverse_mod(a, m):
    """The inverse of a modulo m.

    EXAMPLES::

        sage: inverse_mod(3, 7), inverse_mod(17, 3120)
        (5, 2753)
    """
    return pow(a, -1, m)


def power_mod(a, k, m):
    """a^k modulo m.

    EXAMPLES::

        sage: power_mod(2, 100, 101), power_mod(3, -1, 7)
        (1, 5)
    """
    return pow(a, k, m)


def crt(a, b, m=None, n=None):
    """crt(a, b, m, n): x with x = a mod m and x = b mod n; or crt([a...], [m...]).

    EXAMPLES::

        sage: crt(2, 3, 5, 7)
        17
        sage: crt([2, 3, 1], [5, 7, 9])
        262
    """
    if m is None:
        rs, ms = list(a), list(b)
    else:
        rs, ms = [a, b], [m, n]
    x, M = 0, 1
    for r, mi in zip(rs, ms):
        g, s, _ = xgcd(M, mi)
        if (r - x) % g:
            raise ValueError("no solution to crt problem since gcd(%s,%s) does not divide %s-%s" % (M, mi, x, r))
        x += M * ((r - x) // g * s % (mi // g))
        M = M * mi // g
        x %= M
    return x


def binomial(n, k):
    """The binomial coefficient n choose k (n need not be an integer).

    EXAMPLES::

        sage: binomial(10, 3), binomial(-3, 2), binomial(1/2, 2)
        (120, 6, -1/8)
    """
    if _symbolic(n) or _symbolic(k):
        return _symbolic_fun("binomial", n, k)
    if isinstance(n, int) and n >= 0 and k >= 0:
        return _math.comb(n, k)
    return _binom_general(n, k)


def _symbolic(a):
    """Whether a is a symbolic expression with variables."""
    from _sage_expr import Expression
    return isinstance(a, Expression) and bool(a._names())


def _symbolic_fun(name, *args):
    from _sage_expr import Expression, _expr, _call
    return Expression(_call("fun", name, *[_expr(a)._s for a in args])[0])


def _binom_general(n, k):
    k = int(k)
    if k < 0:
        return 0
    r = 1
    for i in range(k):
        r = r * (n - i)
    if isinstance(r, (int, _Fraction)):
        return _q(_Fraction(r) / _math.factorial(k))
    return r / _math.factorial(k)


def random_vector(ring, degree=None, *args, **kwds):
    """A random vector of the given length over a ring.

    EXAMPLES::

        sage: v = random_vector(GF(13), 5); v.parent()
        Vector space of dimension 5 over Finite Field of size 13
    """
    if degree is None:
        ring, degree = ZZ, ring
    if repr(ring) == "Integer Ring":
        import random as _r
        return vector(ZZ, [_r.randint(-2, 2) for _ in range(int(degree))])
    return VectorSpace(ring, int(degree)).random_element()


def tmp_filename(name="tmp_", ext=""):
    """A fresh temporary file name.

    EXAMPLES::

        sage: tmp_filename(ext=".tex").endswith(".tex")
        True
    """
    import random
    try:
        import tempfile
        import os
        fd, path = tempfile.mkstemp(prefix=name, suffix=ext)
        os.close(fd)
        return path
    except Exception:
        return "/tmp/%s%08x%s" % (name, random.getrandbits(32), ext)


def tmp_dir(name="dir_", ext=""):
    """A fresh temporary directory.

    EXAMPLES::

        sage: tmp_dir().endswith("/")
        True
    """
    import random
    try:
        import tempfile
        return tempfile.mkdtemp(prefix=name, suffix=ext) + "/"
    except Exception:
        return "/tmp/%s%08x%s/" % (name, random.getrandbits(32), ext)


def catalan_number(n):
    """The n-th Catalan number binomial(2n, n)/(n + 1).

    EXAMPLES::

        sage: [catalan_number(k) for k in [1..10]]
        [1, 2, 5, 14, 42, 132, 429, 1430, 4862, 16796]
    """
    n = int(n)
    if n < 0:
        return 0
    return _math.comb(2 * n, n) // (n + 1)


def sum(*args, **kw):
    """Python's sum of an iterable, or Sage's symbolic sum: sum(f, k, a, b).

    EXAMPLES::

        sage: sum([1, 2, 3]), sum(i^2 for i in range(4))
        (6, 14)
        sage: var('k n'); sum(k, k, 1, n)  # needs maxima
        (k, n)
        1/2*n^2 + 1/2*n
    """
    import builtins
    if len(args) >= 4:
        return symbolic_sum(*args, **kw)
    return builtins.sum(*args, **kw)


def bernoulli(n):
    """The Bernoulli number B_n (B_1 = -1/2).

    EXAMPLES::

        sage: [bernoulli(n) for n in range(7)]
        [1, -1/2, 1/6, 0, -1/30, 0, 1/42]
    """
    n = int(n)
    if n < 0:
        raise ValueError("n must be nonnegative")
    if n == 1:
        return _q(_Fraction(-1, 2))
    if n % 2:
        return Integer(0)
    # Akiyama-Tanigawa (gives B_1 = +1/2; only even n reach here)
    a = [_Fraction(1, m + 1) for m in range(n + 1)]
    for m in range(n + 1):
        for j in range(m, 0, -1):
            a[j - 1] = j * (a[j - 1] - a[j])
        if m == n:
            break
        a = a[:]
    return _q(a[0])


def zeta(s):
    """The Riemann zeta function: exact at even and nonpositive integers,
    numerical for real numbers, symbolic otherwise.

    EXAMPLES::

        sage: zeta(2), zeta(4), zeta(0), zeta(-1)
        (1/6*pi^2, 1/90*pi^4, -1/2, -1/12)
        sage: zeta(3.0)
        1.20205690315959
        sage: zeta(3)
        zeta(3)
    """
    from _sage_expr import Expression, _expr
    if isinstance(s, float):
        from _sage_lang import RealNumber
        return RealNumber(_zeta_float(float(s)))
    try:
        k = int(s) if (isinstance(s, int) or (isinstance(s, Expression) and s.is_integer())) else None
    except Exception:
        k = None
    if k is not None:
        if k == 1:
            raise ValueError("zeta has a pole at 1")
        if k == 0:
            return _q(_Fraction(-1, 2))
        if k < 0:
            return -bernoulli(1 - k) / (1 - k)
        if k % 2 == 0:
            c = (-1) ** (k // 2 + 1) * _Fraction(bernoulli(k)) * 2 ** k / (2 * _math.factorial(k))
            return _q(c) * pi ** k
    from _sage_expr import function as _fn
    return _fn("zeta")(_expr(s))


def _zeta_float(s, n=40):
    """zeta(s) for real s != 1 (Borwein's alternating series; the
    functional equation for s < 1/2)."""
    if s < 0.5:
        return 2 ** s * _math.pi ** (s - 1) * _math.sin(_math.pi * s / 2) * _math.gamma(1 - s) * _zeta_float(1 - s, n)
    d = [0.0] * (n + 1)
    tot = 0.0
    for i in range(n + 1):
        tot += _math.factorial(n + i - 1) * 4 ** i / (_math.factorial(n - i) * _math.factorial(2 * i)) if i else 1.0 / n
        d[i] = n * tot
    acc = 0.0
    for k in range(n):
        acc += (-1) ** k * (d[k] - d[n]) / (k + 1) ** s
    return -acc / (d[n] * (1 - 2 ** (1 - s)))


def factorial(n):
    """n!

    EXAMPLES::

        sage: factorial(10), factorial(0)
        (3628800, 1)
        sage: var('n'); factorial(n)
        n
        factorial(n)
    """
    if _symbolic(n):
        return _symbolic_fun("factorial", n)
    return _math.factorial(n)


def fibonacci(n):
    """The n-th Fibonacci number (fast doubling).

    EXAMPLES::

        sage: [fibonacci(n) for n in range(10)], fibonacci(100)
        ([0, 1, 1, 2, 3, 5, 8, 13, 21, 34], 354224848179261915075)
    """
    def fib(k):
        if k == 0:
            return (0, 1)
        a, b = fib(k >> 1)
        c = a * (2 * b - a)
        d = a * a + b * b
        return (d, c + d) if k & 1 else (c, d)
    n = int(n)
    if n < 0:
        return (-1) ** (n + 1) * fibonacci(-n)
    return fib(n)[0]


def isqrt(n):
    """The integer square root (floor of sqrt(n)).

    EXAMPLES::

        sage: isqrt(10), isqrt(10^20 + 1)
        (3, 10000000000)
    """
    return _math.isqrt(int(n))


def sqrt(x):
    """Exact for perfect squares, symbolic (sqrt(2), 2*sqrt(3)) for other
    exact numbers and expressions, numerical for reals.

    EXAMPLES::

        sage: sqrt(16), sqrt(9/4), sqrt(2), sqrt(2.0)
        (4, 3/2, sqrt(2), 1.41421356237310)
    """
    if isinstance(x, float):
        if x < 0:
            return CC(0, _math.sqrt(-x))
        return RealNumber(_math.sqrt(x))
    if isinstance(x, complex):
        return CC(x ** 0.5)
    if isinstance(x, int) and x >= 0:
        r = _math.isqrt(x)
        if r * r == x:
            return r
    if hasattr(x, "sqrt") and not isinstance(x, (int, _Fraction, _Expr)):
        return x.sqrt()
    r = _expr(x) ** _Fraction(1, 2)
    if not isinstance(x, _Expr):
        v = _py_number(r._s)
        if v is not None:
            return v
    return r


def srange(start, stop=None, step=1):
    """range() that also accepts Rationals.

    EXAMPLES::

        sage: srange(5), srange(1, 10, 3), srange(0, 1, 1/4)
        ([0, 1, 2, 3, 4], [1, 4, 7], [0, 1/4, 1/2, 3/4])
    """
    if stop is None:
        start, stop = 0, start
    out = []
    x = start
    while (x < stop) if step > 0 else (x > stop):
        out.append(x)
        x = x + step
    return out


def prod(xs, start=1):
    """The product of the elements.

    EXAMPLES::

        sage: prod([1, 2, 3, 4]), prod(range(1, 11)), prod([])
        (24, 3628800, 1)
    """
    r = start
    for x in xs:
        r = r * x
    return r


def continued_fraction(x, nterms=20):
    """The continued fraction of x (partial quotients).

    EXAMPLES::

        sage: continued_fraction(415/93)
        [4; 2, 6, 7]
        sage: continued_fraction(sqrt(2), 10)  # random
    """
    if isinstance(x, _Expr):
        x = float(x)
    """The (simple) continued fraction partial quotients of x."""
    if isinstance(x, (int, _Fraction)):
        f = _Fraction(x)
        out = []
        while True:
            a = _math.floor(f)
            out.append(a)
            f -= a
            if f == 0:
                return _ContinuedFraction(out)
            f = 1 / f
    out = []
    for _ in range(nterms):
        a = _math.floor(x)
        out.append(a)
        x -= a
        if x < 1e-12:
            break
        x = 1 / x
    return _ContinuedFraction(out)


class _ContinuedFraction(list):
    """Partial quotients, printed as Sage prints a continued fraction."""

    def __repr__(self):
        return "[%s]" % (str(self[0]) + ("; " + ", ".join(str(a) for a in self[1:]) if len(self) > 1 else ""))


# Sage's Integer methods on Python ints: (12).factor(), 13.is_prime(); under
# CPython instead an Integer type (sagebrush.sage)
import sys as _sys
_Integer = _install_int_methods(_sys.modules[__name__])
if _Integer is not None:
    Integer = _Integer


# Sage shows a tuple or list of objects printed on several lines (matrices)
# side by side, each bottom-aligned, the brackets on lines of their own:
#   (
#   [1 0 0]
#   [0 1 0]  [1 0]
#   [0 0 1], [0 1]
#   )
def _side_by_side(v):
    if type(v) not in (tuple, list) or not v:
        return None
    reprs = [repr(x) for x in v]
    if not any("\n" in r for r in reprs):
        return None
    blocks = [r.split("\n") for r in reprs]
    h = max(len(b) for b in blocks)
    widths = [max(len(l) for l in b) for b in blocks]
    rows = []
    for i in range(h):
        line = ""
        for k, b in enumerate(blocks):
            off = h - len(b)
            line += (b[i - off] if i >= off else "").ljust(widths[k])
            if k < len(blocks) - 1:
                line += ", " if i == h - 1 else "  "
        rows.append(line)
    width = max(len(r) for r in rows)
    o, c = ("(", ")") if type(v) is tuple else ("[", "]")
    return o + "\n" + "\n".join(r.ljust(width) for r in rows) + "\n" + c


def _sorted_dict_repr(d):
    """A dict shown with its keys sorted, as Sage's (IPython's) display does."""
    try:
        keys = sorted(d)
    except TypeError:
        return None
    return "{" + ", ".join("%r: %s" % (k, _sorted_dict_repr(d[k]) if type(d[k]) is dict else repr(d[k])) for k in keys) + "}"


def _install_displayhook():
    import builtins
    import sys
    # pyjs calls builtins.__pyjs_displayhook__; CPython's REPL sys.displayhook
    pyjs = hasattr(builtins, "__pyjs_displayhook__")
    plain = builtins.__pyjs_displayhook__ if pyjs else sys.displayhook
    if getattr(plain, "_sagebrush", False):
        return

    def hook(v):
        s = _side_by_side(v)
        if s is None and type(v) is dict:
            s = _sorted_dict_repr(v)
        if s is None:
            return plain(v)
        builtins._ = v
        print(s)
    hook._sagebrush = True
    if pyjs:
        builtins.__pyjs_displayhook__ = hook
    else:
        sys.displayhook = hook


_install_displayhook()
