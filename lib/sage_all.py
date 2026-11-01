"""A small, pure-Python taste of Sage, imported into Sage mode.

Sage mode (``sagebrush --sage``, ``.sage`` files, the Sage toggle on
sagebrush.space) changes the syntax: ``^`` is exponentiation, ``^^`` is
xor and ``/`` on two integers gives an exact :class:`Rational`.  This
module supplies Rational and a handful of Sage's number theory functions.
"""

import math as _math
import operator as _operator
import sys as _sys_limit

# (as Sage: not CPython's 4300-digit limit on an int's decimal conversions;
# Magma mode, through this module, the same.  The only other bound is the
# session's memory, admitted before any copy: src/runtime/format.ts)
_sys_limit.set_int_max_str_digits(0)
from fractions import Fraction as _Fraction

__all__ = [
    # permutation groups (Sagebrush's engine)
    "PermutationGroup", "PermutationGroupElement", "SymmetricGroup", "AlternatingGroup",
    "CyclicPermutationGroup", "DihedralGroup", "MathieuGroup", "PSL", "PGL", "KleinFourGroup", "TransitiveGroup", "TransitiveGroups",
    # modular forms and elliptic curves (Sagebrush's engines)
    "ModularSymbols", "ModularForms", "CuspForms", "Gamma0", "DirichletGroup", "EllipticCurve",
    "Newforms", "newform_orbits",
    # Hilbert modular forms over Q(sqrt(5)) (engine/hmf; PSAGE's names)
    "HilbertModularForms",
    # number fields, integer matrices (engine/classgroup)
    "NumberField", "QuadraticField", "CyclotomicField",
    # finite fields and Z/nZ
    "QQbar", "AA", "RealField", "ComplexField", "RealIntervalField", "RIF", "RDF", "CDF", "PowerSeriesRing", "LaurentSeriesRing", "O", "Zp", "Qp", "ZpCR", "QpCR", "Graph", "DiGraph", "graphs", "digraphs", "true", "false",
    "Sandpile", "SandpileConfig", "SandpileDivisor", "sandpiles", "firing_graph", "parallel_firing_graph", "numerical_approx", "CartanType", "RootSystem", "DynkinDiagram", "WeylGroup", "WeylCharacterRing", "WeightRing", "branching_rule", "branching_rule_from_plethysm", "BranchingRule", "crystals", "Tableau", "Word", "CartanMatrix", "Polyhedron", "polytopes", "EuclideanSpace", "FiniteRankFreeModule", "rank", "dim", "MixedIntegerLinearProgram", "codes", "channels", "LinearCode", "lfsr_sequence", "lfsr_autocorrelation", "lfsr_connection_polynomial", "IndexedSequence", "AlphabeticStrings", "SubstitutionCryptosystem", "TranspositionCryptosystem", "random_vector", "ideal", "Ideal", "TermOrder", "GF", "FiniteField", "IntegerModRing", "Integers", "Zmod", "Mod", "mod", "primitive_root",
    "conway_polynomial", "Hom", "VectorSpace", "random_matrix",
    "RationalField", "IntegerRing", "randint", "random", "bernoulli", "zeta", "symbolic_sum", "sum", "assume", "forget", "assumptions", "assuming", "hue", "norm", "timeit", "set_random_seed", "initial_seed",
    "matrix", "Matrix", "MatrixSpace", "identity_matrix", "zero_matrix", "diagonal_matrix", "CC", "vector",
    "block_matrix", "block_diagonal_matrix", "column_matrix", "kernel",
    "Rational", "Integer", "ZZ", "QQ", "RR", "factor", "Factorization",
    "PolynomialRing", "polygen", "parent",
    "is_prime", "is_prime_power", "is_square", "is_squarefree", "next_prime", "previous_prime", "nth_prime",
    "prime_range", "primes", "primes_first_n", "prime_pi", "divisors", "number_of_divisors",
    "sigma", "euler_phi", "moebius", "gcd", "lcm", "xgcd", "inverse_mod", "power_mod", "crt",
    "kronecker_symbol", "kronecker", "legendre_symbol", "jacobi_symbol",
    "binomial", "factorial", "fibonacci", "catalan_number",
    # enumerative combinatorics (lib/_sage_combinat.py)
    "Partition", "Partitions", "Compositions", "Set", "Subsets", "Combinations", "Permutation", "Permutations",
    "number_of_partitions", "stirling_number1", "stirling_number2", "bell_number", "tmp_filename", "tmp_dir", "isqrt", "sqrt", "srange", "prod", "continued_fraction",
    "numerator", "denominator", "valuation", "digits", "n", "N", "pi", "e",
    # the language: [a..b], 1.5, f(x) = ...
    "ellipsis_range", "ellipsis_iter", "RealNumber", "symbolic_expression",
    # symbolic expressions (the Rust engine, engine/sym)
    "var", "x", "SR", "I", "oo", "infinity", "Infinity", "euler_gamma", "function",
    "sin", "cos", "tan", "cot", "sec", "csc", "asin", "acos", "atan", "arcsin", "arccos", "arctan",
    "arccot", "arcsec", "arccsc", "atan2", "arctan2", "sinh", "cosh", "tanh", "coth", "sech", "csch",
    "arcsinh", "arccosh", "arctanh", "asinh", "acosh", "atanh", "exp", "log", "ln", "floor", "ceil",
    "ceiling", "gamma", "erf", "sgn", "sign", "heaviside", "real", "imag", "real_part", "imag_part", "conjugate",
    "psi", "log_gamma", "zetaderiv", "hurwitz_zeta", "beta", "erfc", "erfi", "erfinv", "exp_integral_e1", "Ei",
    "exp_integral_ei", "dilog", "polylog", "lambert_w", "elliptic_kc", "elliptic_ec", "legendre_P", "gen_legendre_P",
    "diff", "derivative", "integrate", "integral", "integrate_steps", "numerical_integral",
    "desolve", "desolve_rk4",
    "taylor", "limit", "lim", "solve", "expand",
    "simplify", "find_root", "find_local_minimum", "find_local_maximum", "latex",
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
                        psi, log_gamma, zeta, zetaderiv, hurwitz_zeta, beta, erfc, erfi, erfinv, exp_integral_e1,
                        Ei, exp_integral_ei, dilog, polylog, lambert_w, elliptic_kc, elliptic_ec, legendre_P,
                        gen_legendre_P,
                        derivative, integrate, integral, integrate_steps, numerical_integral, desolve,
                        desolve_rk4, taylor, limit,
                        lim, solve, expand, simplify,
                        find_root, find_local_minimum, find_local_maximum, latex, _py_number)
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


def show(obj, *more, **options):
    """Show a picture (2D or 3D), or typeset anything else with LaTeX (in
    the notebook and Jupyter; its text form elsewhere): one display, of
    every argument (separated by spaces, as Sage's show(a, b) prints them).

    EXAMPLES::

        sage: show(x^2 + 1)  # random
        sage: show(EllipticCurve([1, -1, 0, -79, 289]))
        Elliptic Curve defined by y^2 + x*y = x^3 - x^2 - 79*x + 289 over Rational Field
        sage: show(1, 2/3)
        1 2/3
    """
    if not more:
        if isinstance(obj, Graphics3d):
            return obj.show(**options)
        if isinstance(obj, (_Graphics2d, _GraphicsArray, _Animation)):
            return _show2d(obj, **options)
        # (a picture-like object without a LaTeX form, a graph or a
        # polyhedron: its own rich display)
        if not hasattr(obj, "_latex_") and any(hasattr(obj, m) for m in _RICH_DISPLAY):
            return _show2d(obj, **options)
    from _sage_expr import show_typeset
    return show_typeset(obj, *more)


_RICH_DISPLAY = ("_repr_svg_", "_repr_png_", "_repr_html_", "_repr_mimebundle_", "_ipython_display_")
from _sage_modular import (ModularSymbols, ModularForms, CuspForms, Gamma0, DirichletGroup,
                           EllipticCurve, Newforms, newform_orbits)
from _sage_hmf import HilbertModularForms
from _sage_poly import ZZ, QQ, PolynomialRing, polygen, Polynomial as _Polynomial
from _sage_nf import NumberField, QuadraticField, CyclotomicField
from _sage_ff import (GF, FiniteField, IntegerModRing, Integers, Zmod, Mod, mod, primitive_root,
                      conway_polynomial, Hom)
from _sage_qqbar import QQbar, AA
from _sage_mpoly import ideal, Ideal, TermOrder
from _sage_real import RealField, ComplexField, RealIntervalField, RIF
from _sage_rdf import RDF, CDF
from _sage_series import PowerSeriesRing, LaurentSeriesRing, O
from _sage_padic import Zp, Qp, ZpCR, QpCR
from _sage_graph import Graph, DiGraph, graphs, digraphs
true, false = True, False
from _sage_sandpile import Sandpile, SandpileConfig, SandpileDivisor, sandpiles, firing_graph, parallel_firing_graph
from _sage_lie import (CartanType, RootSystem, DynkinDiagram, WeylGroup, WeylCharacterRing, WeightRing,
                       branching_rule, branching_rule_from_plethysm, BranchingRule, CartanMatrix)
from _sage_crystals import crystals, Tableau, Word
from _sage_combinat import (Partition, Partitions, Compositions, Set, Subsets, Combinations, Permutation, Permutations,
                           number_of_partitions, stirling_number1, stirling_number2, bell_number)
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

    The statement is Sage code, as in Sage::

        sage: L = []
        sage: timeit("L.append(2^3); L.append(1/2)", number=1, repeat=1, globals=globals())  # random
        1 loop, best of 1: 26.9 μs per loop
        sage: L
        [8, 1/2]
    """
    import time as _t
    import sys as _s
    g = globals if globals is not None else _s.modules["__main__"].__dict__
    stmt = str(stmt)
    import builtins as _b
    if not kwds.get("preparse", True):
        code = compile(stmt, "<timeit>", "exec")
    elif hasattr(_b, "__pyjs_compile_sage__"):
        # as Sage: the statement is Sage code, so 2^3 is 8 and 1/2 exact
        code = _b.__pyjs_compile_sage__(stmt, "<timeit>", "exec")
    else:
        from sagebrush.preparse import preparse as _preparse
        code = compile(_preparse(stmt), "<timeit>", "exec")
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
            print("%d loop%s, best of %d: %.3g %s per loop"
                  % (n, "" if n == 1 else "s", int(repeat), best / scale, unit))
            break


def sage_eval(source, locals=None, cmds="", preparse=True):
    """The value of the Sage expression source (a string), with the names
    in locals; cmds (statements) run first, and their assignments update
    locals.  A tuple source is (cmds, expression) or (cmds, expression,
    locals).

    EXAMPLES::

        sage: sage_eval('2^10'), sage_eval('1/3 + 1/6'), sage_eval('[1..5]')
        (1024, 1/2, [1, 2, 3, 4, 5])
        sage: sage_eval('x^2 + 1', locals={'x': 3}), sage_eval('t^2', locals={'t': x + 1})
        (10, (x + 1)^2)
        sage: sage_eval(('y = 3', 'y^2')), sage_eval(('a = 2', 'a + b', {'b': 3}), locals={'b': 7})
        (9, 5)
        sage: d = {'x': 2}; sage_eval('x', locals=d, cmds='x = 3'), d['x']
        (3, 3)
    """
    import builtins as _b
    if isinstance(source, (tuple, list)):
        if len(source) == 3:
            # (a copy of the tuple's locals, as Sage)
            cmds, source, locals = source[0], source[1], dict(source[2])
        elif len(source) == 2:
            cmds, source = source
        else:
            raise ValueError("a tuple source is (cmds, expression) or (cmds, expression, locals)")
    source, cmds = str(source), str(cmds)

    def comp(code, mode):
        if not preparse:
            return compile(code, "<sage_eval>", mode)
        if hasattr(_b, "__pyjs_compile_sage__"):
            return _b.__pyjs_compile_sage__(code, "<sage_eval>", mode)
        from sagebrush.preparse import preparse as _preparse
        return compile(_preparse(code).strip(), "<sage_eval>", mode)

    # as Sage: the commands and the assignment of the expression's value
    # run as one block (so a global statement in cmds governs the
    # expression too), with the globals and the caller's locals as separate
    # namespaces: assignments, del and := act on locals itself (also when
    # a command raises), and the value is locals['_sage_eval_returnval_']
    # (without cmds, the expression alone, leaving locals as it is)
    g = dict(globals())
    if locals is None:
        locals = {}
    if not cmds.strip():
        return eval(comp(source, "eval"), g, locals)
    exec(comp(cmds + "\n_sage_eval_returnval_ = " + source, "exec"), g, locals)
    return locals["_sage_eval_returnval_"]


__all__.append("sage_eval")


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
        return _sage_matrix.VectorSpace_QQ(n)
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
    # A Fraction result as a Rational, also when it is integral: as in Sage,
    # QQ(1/3)*3 is 1 in QQ (an int there made (q*3)/3 a float in ordinary
    # Python under pyjs: the systematic review's API-F7).
    if type(x) is _Fraction:
        return Rational._from_coprime_ints(x._numerator, x._denominator)
    return x


def _lift(name):
    # Do the arithmetic on a plain Fraction: with a Rational operand, Python
    # would try Rational's reflected method first and recurse.
    op = getattr(_Fraction, name)

    def f(a, b):
        if _real_kind(b) in ("rr", "rdf"):
            # (RR and RDF convert the rational: Fraction would use a float)
            return NotImplemented
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

    def __new__(cls, numerator=0, denominator=None):
        # (a real number as QQ converts it: the simplest rational that
        # rounds to it, Rational(0.1) is 1/10, not the double's exact value)
        if denominator is None and not isinstance(numerator, (int, _Fraction, str)) and _real_kind(numerator) is not None:
            return _simplest_rational(numerator, "Rational of a real number", literal=True)
        return _Fraction.__new__(cls, numerator, denominator)

    def __repr__(self):
        if self._denominator == 1:
            return str(self._numerator)
        return f"{self._numerator}/{self._denominator}"

    __str__ = __repr__

    def _repr_latex_(self):
        if self._denominator == 1:
            return f"${self._numerator}$"
        return f"$\\frac{{{self._numerator}}}{{{self._denominator}}}$"

    __add__ = _lift("__add__")
    __radd__ = _lift("__radd__")
    __sub__ = _lift("__sub__")
    __rsub__ = _lift("__rsub__")
    __mul__ = _lift("__mul__")
    __rmul__ = _lift("__rmul__")
    __truediv__ = _lift("__truediv__")
    __rtruediv__ = _lift("__rtruediv__")
    _pow = _lift("__pow__")
    _rpow = _lift("__rpow__")

    def __pow__(self, e, mod=None):
        if mod is not None:
            # (the modulus was ignored: pow(2/1, 3, 7) was 8), as Sage
            raise TypeError("the 3-argument version of pow() is not supported")
        if isinstance(e, _Fraction) and e.denominator != 1:
            return _rational_power(self, e)
        if _real_kind(e) in ("rr", "rdf"):
            return NotImplemented
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

    def valuation(self, p):
        """The exponent of the prime p in self (+Infinity for 0).

        EXAMPLES::

            sage: QQ(9/4).valuation(3), QQ(9/4).valuation(2), QQ(-50/7).valuation(5), QQ(0).valuation(3)
            (2, -2, 2, +Infinity)
            sage: QQ(32/3).valuation(4), QQ(12/5).valuation(2.0)
            (2, 2)
            sage: QQ(1/2).valuation(1)
            Traceback (most recent call last):
            ...
            ValueError: You can only compute the valuation with respect to a integer larger than 1.
        """
        p = _valuation_base(p)
        if self._numerator == 0:
            return oo
        return Integer(valuation(self, p))

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
        # (RR: past the doubles, 1/3^700, as Sage)
        return RR(self)

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

    # Sage's Rational methods (an integral rational, 4/2, is a Rational:
    # these are what Integer offers that a Rational has too, with QQ's
    # meaning: a field has no primes, every nonzero element is a unit)

    def parent(self):
        """The Rational Field.

        EXAMPLES::

            sage: (4/2).parent(), (2/3).parent()
            (Rational Field, Rational Field)
        """
        return QQ

    def abs(self):
        """The absolute value.

        EXAMPLES::

            sage: (-3/4).abs()
            3/4
        """
        return abs(self)

    def str(self):
        """The string form.

        EXAMPLES::

            sage: (3/4).str(), (4/2).str()
            ('3/4', '2')
        """
        return repr(self)

    def is_integral(self):
        """Whether the denominator is 1.

        EXAMPLES::

            sage: (4/2).is_integral(), (3/4).is_integral()
            (True, False)
        """
        return self._denominator == 1

    def __index__(self):
        """An integral rational as an index or a count, as in Sage (range(6/3)
        and L[4/2] failed once 4/2 was a Rational); TypeError otherwise.

        EXAMPLES::

            sage: list(range(6/3)), [10, 20, 30][4/2], bin(6/3), factorial(6/3)
            ([0, 1], 30, '0b10', 2)
            sage: range(5/2)
            Traceback (most recent call last):
            ...
            TypeError: unable to convert rational 5/2 to an integer
        """
        if self._denominator != 1:
            raise TypeError("unable to convert rational %s to an integer" % self)
        return int(self._numerator)

    @staticmethod
    def _shift_count(n):
        """A shift count as Sage takes it: an integer, or an integral
        rational (ValueError otherwise); None for anything else (a residue
        or an object with only __index__ is not one: TypeError)."""
        if isinstance(n, Rational):
            if n._denominator != 1:
                raise ValueError("denominator must be 1")
            return int(n._numerator)
        if isinstance(n, int):
            return int(n)
        return None

    def __lshift__(self, n):
        """self * 2^n, a Rational, as in Sage (and >>, self / 2^n); an
        integer (Integer) or bool on the left of a rational count.

        EXAMPLES::

            sage: (6/3) << 1, (5/2) << 1, (8/2) >> 1, (5/2) >> 1, 1 << (4/2), 16 >> (4/2), True >> (2/1)
            (4, 5, 2, 5/4, 4, 4, 1/4)
            sage: (3/2) << GF(5)(2)
            Traceback (most recent call last):
            ...
            TypeError: unsupported operand type(s) for <<: 'Rational' and 'IntegerMod'
        """
        n = Rational._shift_count(n)
        if n is None:
            return NotImplemented
        return self * Integer(2) ** n if n >= 0 else self / Integer(2) ** -n

    def __rshift__(self, n):
        n = Rational._shift_count(n)
        if n is None:
            return NotImplemented
        return self / Integer(2) ** n if n >= 0 else self * Integer(2) ** -n

    def __rlshift__(self, a):
        if isinstance(a, bool):
            # (a bool is not an Integer: True >> (2/1) is 1/4 in Sage)
            return Rational._from_coprime_ints(int(a), 1) << self
        if isinstance(a, int):
            # (a negative count shifts the other way, as Sage's Integer)
            n = self.__index__()
            return Integer(a << n if n >= 0 else a >> -n)
        return NotImplemented

    def __rrshift__(self, a):
        if isinstance(a, bool):
            return Rational._from_coprime_ints(int(a), 1) >> self
        if isinstance(a, int):
            n = self.__index__()
            return Integer(a >> n if n >= 0 else a << -n)
        return NotImplemented

    def is_zero(self):
        """Whether it is 0.

        EXAMPLES::

            sage: (0/2).is_zero(), (1/2).is_zero()
            (True, False)
        """
        return self._numerator == 0

    def is_one(self):
        """Whether it is 1.

        EXAMPLES::

            sage: (2/2).is_one(), (1/2).is_one()
            (True, False)
        """
        return self._numerator == 1 and self._denominator == 1

    def __mod__(self, n):
        """self % n for an integral n: the residue of numerator *
        denominator^-1 modulo n, an integer with the sign of n (as Python's %
        on integers), as in Sage; a ZeroDivisionError when the denominator
        is not invertible modulo n.

        EXAMPLES::

            sage: (1/5) % 7, (-1/5) % 7, (1/5) % -7, (4/6) % 5, (7/2) % 1
            (3, 4, -4, 4, 0)
            sage: (3/5) % 10
            Traceback (most recent call last):
            ...
            ZeroDivisionError: inverse of Mod(5, 10) does not exist
            sage: (1/2) % (1/3)
            Traceback (most recent call last):
            ...
            TypeError: no conversion of this rational to integer
        """
        m = _integral_modulus(n)
        if m is NotImplemented:
            return NotImplemented
        if m == 0:
            raise ZeroDivisionError("Rational modulo by zero")
        a, d = self._numerator, self._denominator
        if d == 1:
            return a % m
        am = abs(m)
        if _math.gcd(d, am) != 1:
            raise ZeroDivisionError("inverse of Mod(%d, %d) does not exist" % (d % am, am))
        return (a * pow(d, -1, am)) % am % m

    def __rmod__(self, a):
        """a % self: a is converted to QQ first, then self must be an
        integer, as in Sage.

        EXAMPLES::

            sage: True % (2/1), float(-3) % (2/1), 5 % (4/2)
            (1, 1, 1)
            sage: float(2) % (7/2)
            Traceback (most recent call last):
            ...
            TypeError: no conversion of this rational to integer
            sage: RR(2) % (7/2), RR(7) % (2/1)
            (-1.50000000000000, -1.00000000000000)
        """
        kind = _real_kind(a)
        if kind == "rr":
            return _rr_remainder(a, self)
        if kind == "rdf":
            P = str(a.parent())
            raise TypeError("unsupported operand parent(s) for %%: '%s' and '%s'" % (P, P))
        if isinstance(a, (int, _Fraction)) or kind == "float":
            # (a float as Sage takes it: the simplest rational rounding to
            # it, so float(0.1) % 3 is (1/10) % 3)
            A = _simplest_rational(a) if kind == "float" else QQ(a)
            if self._denominator != 1:
                raise TypeError("no conversion of this rational to integer")
            if self._numerator == 0:
                raise ZeroDivisionError("Rational modulo by zero")
            return A % self._numerator
        return NotImplemented

    def __floordiv__(self, other):
        """self // other: in QQ, a field, the exact quotient, as in Sage;
        with a Python float, the float floor quotient; with RDF, RDF's
        quotient; RR has no floor division.

        EXAMPLES::

            sage: (7/2) // 1, (6/3) // 4, (7/2) // -2, 7 // (2/3), (7/2) // True
            (7/2, 1/2, -7/4, 21/2, 7/2)
            sage: (7/2) // float(2), float(2) // (7/2), (7/2) // RDF(2)
            (1.0, 0.0, 1.75)
            sage: divmod(7/2, 1), divmod(7, 1/2), divmod(7/2, 1/3), divmod(7/2, 1.5)
            ((7/2, 0), (14, 0), (21/2, 0), (7/3, 0))
            sage: (7/2) // RR(2)
            Traceback (most recent call last):
            ...
            TypeError: unsupported operand parent(s) for //: 'Real Field with 53 bits of precision' and 'Real Field with 53 bits of precision'
        """
        if isinstance(other, (int, _Fraction)):
            return self / (int(other) if isinstance(other, bool) else other)
        kind = _real_kind(other)
        if kind == "float":
            return float(self) // other
        if kind == "rdf":
            return other.parent()(self) / other
        if kind == "rr":
            P = str(other.parent())
            raise TypeError("unsupported operand parent(s) for //: '%s' and '%s'" % (P, P))
        return NotImplemented

    def __rfloordiv__(self, other):
        if isinstance(other, int):
            return Rational._from_coprime_ints(int(other), 1) / self
        if isinstance(other, _Fraction):
            raise TypeError("unsupported operand type(s) for //: 'Fraction' and 'Rational'")
        kind = _real_kind(other)
        if kind == "float":
            return other // float(self)
        if kind == "rdf":
            return other / other.parent()(self)
        if kind == "rr":
            P = str(other.parent())
            raise TypeError("unsupported operand parent(s) for //: '%s' and '%s'" % (P, P))
        return NotImplemented

    def __divmod__(self, other):
        # (self / other, 0) with other converted exactly to QQ, as Sage (the
        # remainder is a Python int there)
        x = _to_qq(other)
        if x is NotImplemented:
            return NotImplemented
        return self / x, 0

    def __rdivmod__(self, other):
        kind = _real_kind(other)
        if kind == "rdf":
            return other / other.parent()(self), 0
        if kind == "rr":
            P = other.parent()
            if self._numerator == 0:
                raise ZeroDivisionError()
            return other / P(self), P(0)
        if isinstance(other, _Fraction) and not isinstance(other, Rational):
            raise TypeError("unsupported operand type(s) for //: 'Fraction' and 'Rational'")
        if isinstance(other, int) and not isinstance(other, bool):
            # an Integer is coerced into QQ: (other / self, 0), as Sage
            return Rational._from_coprime_ints(int(other), 1) / self, 0
        if isinstance(other, bool) or kind == "float":
            # (other // self, other % self), in that order, as Sage
            return self.__rfloordiv__(other), self.__rmod__(other)
        return NotImplemented

    def ord(self, p):
        """The valuation at p (as valuation).

        EXAMPLES::

            sage: (12/1).ord(2), (3/8).ord(2)
            (2, -3)
        """
        return self.valuation(p)

    def is_perfect_power(self):
        """Whether self is r^k for a rational r and an integer k >= 2 (0, 1
        and -1 are).

        EXAMPLES::

            sage: [q.is_perfect_power() for q in [4/9, -8/27, 1/4, 1/1, -1/1, 0/1]]
            [True, True, True, True, True, True]
            sage: [q.is_perfect_power() for q in [2/1, 8/3, -4/9]]
            [False, False, False]
        """
        a, b = abs(self._numerator), self._denominator
        if a == 0 or (a == 1 and b == 1):
            return True
        bits = max(a, b).bit_length()
        if bits > 4096:
            raise NotImplementedError("is_perfect_power of a rational of more than 4096 bits is not available in sagebrush yet")
        # r^k for a composite k is also a power with each prime factor of k
        for k in range(2, bits + 1):
            if any(k % q == 0 for q in range(2, int(k ** 0.5) + 1)):
                continue
            if self._numerator < 0 and k == 2:
                continue
            ra = _iroot(a, k)
            if ra ** k == a:
                rb = _iroot(b, k)
                if rb ** k == b:
                    return True
        return False

    def is_unit(self):
        """Whether it is a unit of QQ: nonzero.

        EXAMPLES::

            sage: (1/2).is_unit(), (0/1).is_unit()
            (True, False)
        """
        return self._numerator != 0

    def is_prime(self):
        """False: QQ is a field, with no primes (also for 10/2).

        EXAMPLES::

            sage: (10/2).is_prime()
            False
        """
        return False

    def is_square(self):
        """Whether it is the square of a rational.

        EXAMPLES::

            sage: (9/4).is_square(), (3/4).is_square(), (-4/1).is_square()
            (True, False, False)
        """
        n, d = self._numerator, self._denominator
        return n >= 0 and _math.isqrt(n) ** 2 == n and _math.isqrt(d) ** 2 == d

    def nth_root(self, n):
        """The rational n-th root; ValueError when there is none.

        EXAMPLES::

            sage: (9/4).nth_root(2), (-8/27).nth_root(3)
            (3/2, -2/3)
        """
        a = Integer(self._numerator).nth_root(n)
        b = Integer(self._denominator).nth_root(n)
        return Rational._from_coprime_ints(int(a), int(b))

    def sqrt(self, prec=None, extend=True, all=False):
        """The square root: a Rational for a square (also 4/1 and 0: it
        escaped to ZZ), else symbolic, or numerical with prec bits; all, the
        list of roots; extend=False, a ValueError when no root is rational.

        EXAMPLES::

            sage: (9/4).sqrt(), (4/1).sqrt(), (3/4).sqrt(), (-4/1).sqrt()
            (3/2, 2, 1/2*sqrt(3), 2*I)
            sage: parent((4/1).sqrt()), (4/1).sqrt().quo_rem(3)
            (Rational Field, (2/3, 0))
            sage: (2/1).sqrt(prec=30), (4/1).sqrt(all=True), (2/1).sqrt(all=True, extend=False)
            (1.4142136, [2, -2], [])
            sage: (2^-1200).sqrt(prec=53), (-4/1).sqrt(prec=53), (-4/1).sqrt(prec=53).parent()
            (2.40991986510288e-181, 2.00000000000000*I, Complex Field with 53 bits of precision)
        """
        n, d = self._numerator, self._denominator
        if prec is not None:
            return self._sqrt_prec(prec, all)
        if n >= 0 and _math.isqrt(n) ** 2 == n and _math.isqrt(d) ** 2 == d:
            r = Rational._from_coprime_ints(_math.isqrt(n), _math.isqrt(d))
        elif not extend:
            if all:
                return []
            raise ValueError("square root of negative number not rational" if n < 0 else "square root of %s not a rational number" % self)
        else:
            r = _expr(self) ** _Fraction(1, 2)
        return ([r, -r] if n else [r]) if all else r

    def _sqrt_prec(self, prec, all=False):
        """The square root with prec bits, correctly rounded from the exact
        rational (converting first lost 2^-1200 to 0 in the double-backed
        RR), in ComplexField(prec) for a negative rational (it was a Python
        complex); refused where the 53-bit field cannot hold the root."""
        R = RealField(prec)
        prec = int(R.prec())  # (the field's: prec=float(53) broke the shifts)
        if prec > _SQRT_MAX_PREC:
            # admitted before the integer square root (prec=10^8 ran for
            # minutes in 480 MB: the review's HARD-862-1)
            raise NotImplementedError("the square root of a rational at %d bits is past sagebrush's limit of %d bits" % (prec, _SQRT_MAX_PREC))
        n, d = self._numerator, self._denominator
        if n == 0:
            r = R(0)
            return [r] if all else r
        a = abs(n)
        # sqrt(a/d) = s / 2^k to prec + 20 bits, with a sticky bit
        k = max(0, prec + 21 - (a.bit_length() - d.bit_length()) // 2)
        N, rem = divmod(a << (2 * k), d)
        s = _math.isqrt(N)
        m = 2 * s + (0 if s * s == N and rem == 0 else 1)
        e = m.bit_length() - (k + 1)
        if type(R).__name__ == "_RealField" and not -1021 <= e <= 1023:
            raise NotImplementedError("the square root of %s is outside the range of %s in sagebrush yet" % (self, R))
        r = R(_intdiv(m, 1 << (k + 1)))
        if n < 0:
            r = ComplexField(prec)(0, r)
        return [r, -r] if all else r

    def squarefree_part(self):
        """The squarefree part of numerator times denominator (the same
        square class).

        EXAMPLES::

            sage: (3/4).squarefree_part(), (9/4).squarefree_part(), (-8/2).squarefree_part()
            (3, 1, -1)
        """
        return Integer(self._numerator * self._denominator).squarefree_part()

    def factor(self):
        """The factorization, with negative exponents for the denominator.

        EXAMPLES::

            sage: (3/4).factor(), (-8/2).factor(), (10/2).factor()
            (2^-2 * 3, -1 * 2^2, 5)
        """
        if self._numerator == 0:
            raise ArithmeticError("factorization of 0 is not defined")
        pairs = [(p, e) for p, e in factor(abs(self._numerator))] + [(p, -e) for p, e in factor(self._denominator)]
        return Factorization(sorted(pairs), -1 if self._numerator < 0 else 1)

    def gcd(self, other):
        """gcd(a, c)/lcm(b, d) for a/b and c/d, as in Sage.

        EXAMPLES::

            sage: (3/4).gcd(6), (9/4).gcd(6), (-8/2).gcd(6)
            (3/4, 3/4, 2)
        """
        o = QQ(other)
        return _intdiv(_math.gcd(self._numerator, o._numerator), _math.lcm(self._denominator, o._denominator))

    def lcm(self, other):
        """lcm(a, c)/gcd(b, d) for a/b and c/d, as in Sage.

        EXAMPLES::

            sage: (3/4).lcm(6), (9/4).lcm(6), (-8/2).lcm(6)
            (6, 18, 12)
        """
        o = QQ(other)
        return _intdiv(_math.lcm(self._numerator, o._numerator), _math.gcd(self._denominator, o._denominator))

    def xgcd(self, other):
        """(g, s, t) with g = self.gcd(other) = s self + t other: from the
        integers' xgcd of the numerators, scaled by b/L and d/L (L = lcm(b, d)).

        EXAMPLES::

            sage: (9/4).xgcd(6), (3/4).xgcd(6), (-8/2).xgcd(6)
            ((3/4, 1, -1/4), (3/4, 1, 0), (2, 1, 1))
        """
        o = QQ(other)
        a, b, c, d = self._numerator, self._denominator, o._numerator, o._denominator
        L = _math.lcm(b, d)
        g, s, t = Integer(a).xgcd(c)
        return (_intdiv(int(g), L), _intdiv(int(s) * b, L), _intdiv(int(t) * d, L))

    def quo_rem(self, other):
        """(self/other, 0): QQ is a field (the remainder a Python 0, as in
        Sage).

        EXAMPLES::

            sage: (10/2).quo_rem(3)
            (5/3, 0)
        """
        return (self / QQ(other), 0)

    def mod(self, n):
        """self modulo the ideal (n): self for n = 0, else 0 (n generates the
        whole field; a Python 0, as in Sage).

        EXAMPLES::

            sage: (3/4).mod(7), (3/4).mod(0)
            (0, 3/4)
            sage: (3/4).mod('a')
            Traceback (most recent call last):
            ...
            TypeError: unable to convert 'a' to a rational
        """
        try:
            n = QQ(n)
        except (TypeError, ValueError):
            raise TypeError("unable to convert %r to a rational" % (n,))
        return self if n == 0 else 0

    def round(self, mode="even"):
        """The nearest integer; a half goes by mode: 'even' (the default),
        'odd', 'toward' or 'away' from zero, 'up' or 'down'.

        EXAMPLES::

            sage: [q.round() for q in [1/2, 5/2, -1/2, -5/2, 9/4]]
            [0, 2, 0, -2, 2]
            sage: [(5/2).round(m) for m in ['toward', 'away', 'up', 'down', 'even', 'odd']]
            [2, 3, 3, 2, 2, 3]
        """
        if mode not in ("toward", "away", "up", "down", "even", "odd"):
            raise ValueError("rounding mode must be one of 'toward', 'away', 'up', 'down', 'even', or 'odd'")
        n, d = self._numerator, self._denominator
        f, r = divmod(n, d)
        if 2 * r != d:
            return Integer(f + 1 if 2 * r > d else f)
        up = {"up": True, "down": False, "toward": n < 0, "away": n > 0,
              "even": f % 2 == 1, "odd": f % 2 == 0}[mode]
        return Integer(f + 1 if up else f)

    def inverse_mod(self, m):
        """Refused, as in Sage (a TypeError).

        EXAMPLES::

            sage: (3/4).inverse_mod(7)  # sagebrush only
            Traceback (most recent call last):
            ...
            TypeError: inverse_mod of a rational is not defined: use Mod(numerator, m)/denominator
        """
        raise TypeError("inverse_mod of a rational is not defined: use Mod(numerator, m)/denominator")


# The highest precision of Rational.sqrt(prec=...) (2^16 bits takes about a
# second; 2^18 bits, 17 s).
_SQRT_MAX_PREC = 1 << 16


def _iroot(n, k):
    """The integer k-th root of n >= 0, rounded down (Newton's method)."""
    if n < 2:
        return n
    x = 1 << -(-n.bit_length() // k)
    while True:
        y = ((k - 1) * x + n // x ** (k - 1)) // k
        if y >= x:
            return x
        x = y


def _real_kind(x):
    """'rr' for an element of RR or RealField(p), 'rdf' for RDF, 'float' for
    a Python float, None otherwise (the classes are float subclasses, so
    the order of the tests matters)."""
    name = type(x).__name__
    if name in ("RealNumber", "_RealLiteral", "RealNumberMP", "_RealLiteralMP"):
        return "rr"
    if name == "RealDoubleElement":
        return "rdf"
    if isinstance(x, float):
        return "float"
    return None


def _real_qq(x):
    """The exact rational value of a real number x (its binary value, as
    x.exact_rational(); QQ(x) is the simplest rational rounding to x)."""
    import math
    mp = getattr(x, "_mp", None)
    if mp is not None:
        # (an RR element past the doubles: its exact value, not its float)
        return QQ(mp.exact_rational())
    if _real_kind(x) in ("float", "rdf"):
        # (the double itself, whatever a subclass's __float__ or
        # as_integer_ratio say: astra's CORR-28E-1)
        f = float.__float__(x)
        if not math.isfinite(f):
            raise ValueError("cannot convert NaN or infinity to rational number")
        return _QQ_exact(f)
    if isinstance(x, float) and not math.isfinite(x):
        raise ValueError("cannot convert NaN or infinity to rational number")
    try:
        return _QQ_exact(x)
    except (OverflowError, ValueError):
        raise ValueError("cannot convert NaN or infinity to rational number") from None


def _integral_modulus(n):
    """n as an integer modulus for Rational % n, as Sage converts it: an
    integer, or an integral rational or real number; TypeError for a
    non-integral one; NotImplemented for other types."""
    if isinstance(n, bool):
        return int(n)
    if isinstance(n, int):
        return n
    if isinstance(n, _Fraction):
        if not isinstance(n, Rational):
            raise TypeError("unable to coerce <class 'fractions.Fraction'> to an integer")
        if n.denominator != 1:
            raise TypeError("no conversion of this rational to integer")
        return int(n.numerator)
    kind = _real_kind(n)
    if kind is None:
        names = [c.__name__ for c in type(n).__mro__]
        if "IntegerMod" in names:
            # an integer mod m by its lift, as Sage: (7/2) % GF(5)(2) is mod 2
            return int(n.lift())
        if "Expression" in names:
            try:
                r = QQ(n)
            except (TypeError, ValueError):
                return NotImplemented
            if r.denominator == 1:
                return int(r.numerator)
        return NotImplemented
    if kind == "rr":
        r = _real_qq(n)
        if r.denominator != 1:
            raise TypeError("Attempt to coerce non-integral RealNumber to Integer")
        return int(r.numerator)
    f = float(n)
    # (int() of an infinity or a NaN raises Python's own error, as in Sage)
    if f != int(f):
        raise TypeError("cannot convert non-integral float to integer")
    return int(f)


def _simplest_in(lo, hi, lo_closed, hi_closed):
    """The simplest rational (smallest denominator, then numerator) in the
    interval from lo to hi, 0 < lo <= hi (hi None for infinity), each end
    included or not: by continued fractions, iteratively (at most about
    1.5 terms per bit of the ends)."""
    terms = []
    while True:
        f = lo.numerator // lo.denominator
        if f == lo and lo_closed:
            terms.append(f)
            break
        if hi is None or f + 1 < hi or (f + 1 == hi and hi_closed):
            terms.append(f + 1)
            break
        # lo and hi lie in [f, f + 1]: x = f + 1/y with y between
        # 1/(hi - f) and 1/(lo - f) (infinity when lo = f), ends exchanged
        terms.append(f)
        lo, hi, lo_closed, hi_closed = 1 / (hi - f), (None if lo == f else 1 / (lo - f)), hi_closed, lo_closed
    r = QQ(terms[-1])
    for t in reversed(terms[:-1]):
        r = t + 1 / r
    return r


_SIMPLEST_MAX_PREC = 1 << 14


def _literal_digits(lit):
    """The significant digits of a decimal literal as Sage counts them for
    its precision: the digits before any exponent, without the point and
    the leading zeros (trailing zeros count): 1.000000000000000 has 16."""
    s = lit.strip().lstrip("+-").replace("_", "")
    for c in "eE":
        s = s.split(c)[0]
    return len(s.replace(".", "").lstrip("0"))


def _round_to_bits(q, bits):
    """q > 0 rounded to `bits` significant bits, to nearest, ties to even
    (an exact rational)."""
    e = q.numerator.bit_length() - q.denominator.bit_length() - bits
    while True:
        m = q / QQ(2) ** e
        if m < 2 ** (bits - 1):
            e -= 1
        elif m >= 2 ** bits:
            e += 1
        else:
            break
    n, r = divmod(m.numerator, m.denominator)
    if 2 * r > m.denominator or (2 * r == m.denominator and n % 2):
        n += 1
    return QQ(n) * QQ(2) ** e


def _simplest_rational(x, what="divmod with a real number", literal=False):
    """The simplest rational that rounds to x in x's field (RR,
    RealField(p) in any rounding mode, RDF, or a float's 53 bits), as Sage
    converts such a number to QQ (QQ(x), and in divmod and x % q): QQ(RR(0.1))
    is 1/10. The interval is the field's own: to nearest, half an ulp each side
    (a quarter below a power of 2), the ends included when the significand
    is even; toward zero in magnitude (RNDZ, RNDD above 0, RNDU below), from
    |x| up to the next value, |x| included; away from zero (RNDA, RNDU above
    0, RNDD below), from the previous value up to |x|, |x| included. An
    integral value is itself. The precision is checked first, before x is
    converted or any value returned (daybreak2's HARD-F2B-1).

    EXAMPLES::

        sage: divmod(1/1, RR(0.1)), divmod(1/1, RealField(3, rnd='RNDU')(5/12))
        ((10, 0), (5/2, 0))
    """
    if _real_kind(x) == "rr":
        P = x.parent()
        p, rnd = int(P.prec()), str(getattr(P, "_rnd", "RNDN"))
    else:
        p, rnd = 53, "RNDN"
    if p > _SIMPLEST_MAX_PREC:
        raise NotImplementedError("%s of more than %d bits of precision is not implemented" % (what, _SIMPLEST_MAX_PREC))
    lit = None
    if literal and rnd == "RNDN":
        # (checked first: an integral value must not slip past them,
        # astra's CORR-28E-3a)
        if getattr(x, "_lit_ambiguous", None) is not None:
            raise NotImplementedError("QQ of x + 0 or x * 1 for a decimal literal x is not implemented: Sage keeps x a literal "
                                      "when 0 or 1 is a Python int and not when it is an Integer, which are one type here; "
                                      "use QQ(x) itself, QQ(float(x)), or QQ('decimal string')")
        lit = getattr(x, "_lit", None)
        if lit is not None and _literal_digits(lit) > 15 and p != (10 ** _literal_digits(lit)).bit_length():
            raise NotImplementedError("QQ of a decimal literal of %d significant digits held at %d bits is not implemented "
                                      "(Sage gives it %d): use QQ('%s') for its exact value, or QQ(float(x)) for its double"
                                      % (_literal_digits(lit), p, (10 ** _literal_digits(lit)).bit_length(), lit.lstrip("+")))
    X = _real_qq(x)
    if X.denominator == 1:
        # an integral value is itself, as in Sage (1e300 is that integer)
        return X
    neg = X < 0
    A = -X if neg else X
    # A = m * 2^e with 2^(p-1) <= m < 2^p
    e = A.numerator.bit_length() - A.denominator.bit_length() - p
    while True:
        m = A / QQ(2) ** e
        if m < 2 ** (p - 1):
            e -= 1
        elif m >= 2 ** p:
            e += 1
        else:
            break
    m = int(m)
    ulp = QQ(2) ** e
    below = ulp / 2 if m == 2 ** (p - 1) else ulp  # the gap under A
    if lit is not None:
        # A decimal literal not yet used in arithmetic (QQ(1e-20)), as Sage
        # converts one (found by experiment, not from its source): the
        # interval is centred on the literal's decimal value rounded to
        # p + 1 bits, rather than on its p-bit value: QQ(1e-20) is
        # 1/99999999999999990439 (QQ(float(1e-20)), 1/99999999999999997962).
        # (p is the literal's own precision: more than 53 bits for one of
        # more than 15 digits, as in Sage; a literal held at another
        # precision was refused above)
        try:
            D = abs(_Fraction(lit.replace("_", "")))
        except (ValueError, ZeroDivisionError):
            D = None
        if D:
            A = _round_to_bits(D, p + 1)
    if rnd == "RNDN":
        closed = m % 2 == 0
        r = _simplest_in(A - below / 2, A + ulp / 2, closed, closed)
    elif rnd == "RNDZ" or (rnd == "RNDD" and not neg) or (rnd == "RNDU" and neg):
        # toward zero in magnitude: [A, A + ulp)
        r = _simplest_in(A, A + ulp, True, False)
    else:
        # away from zero in magnitude: (A - below, A]
        r = _simplest_in(A - below, A, False, True)
    return -r if neg else r


def _to_qq(x):
    """x as a rational for divmod(q, x), as Sage converts it: an integer or
    a rational exactly, a real number as the simplest rational rounding to
    it, an integer mod n by its lift, or a symbolic constant;
    NotImplemented for other types."""
    if isinstance(x, (bool, int)):
        return Rational._from_coprime_ints(int(x), 1)
    if isinstance(x, _Fraction):
        return QQ(x)
    if _real_kind(x) is not None:
        return _simplest_rational(x)
    names = [c.__name__ for c in type(x).__mro__]
    if "IntegerMod" in names:
        return Rational._from_coprime_ints(int(x.lift()), 1)
    if "Expression" in names:
        return QQ(x)
    if "ComplexNumber" in names:
        raise TypeError("unable to convert %s to a rational" % x)
    return NotImplemented


def _rr_remainder(x, q):
    """x % q for x in RR or RealField(p) and a rational q, as Sage: q is
    rounded to x's field, then x - n*q exactly for the nearest integer n
    (ties to even), rounded to the field; NaN when q is 0 or x is not
    finite."""
    P = x.parent()
    Q = _real_qq(P(q))
    try:
        X = _real_qq(x)
    except (OverflowError, ValueError):
        X = None
    if X is None or Q == 0:
        return P(float("nan"))
    t = X / Q
    n, r = divmod(t.numerator, t.denominator)
    if 2 * r > t.denominator or (2 * r == t.denominator and n % 2):
        n += 1
    return P(X - n * Q)


def _intdiv(a, b):
    # The runtime's `/` on two ints in Sage mode: a Rational, also when it
    # is integral (parent(4/2) is the Rational Field, as in Sage).
    if b == 0:
        raise ZeroDivisionError("rational division by zero")
    a, b = int(a), int(b)
    if b < 0:
        a, b = -a, -b
    g = _math.gcd(a, b)
    if g != 1:
        a //= g
        b //= g
    return Rational._from_coprime_ints(a, b)


def Integer(x):
    """The integer x.  A real number must be integral: Integer(3.0) is 3,
    and Integer(3.5) is a TypeError (int() would truncate it).

    EXAMPLES::

        sage: Integer(7), Integer('123456789012345678901234567890'), Integer(2.0^70)
        (7, 123456789012345678901234567890, 1180591620717411303424)
        sage: Integer(3.5)
        Traceback (most recent call last):
        ...
        TypeError: Attempt to coerce non-integral RealNumber to Integer
    """
    if not isinstance(x, int) and _real_kind(x) is not None:
        return _integral_real(x)
    return int(x)


def _integral_real(x):
    """A real number (a float, RDF or RR element) as an int, as Sage
    converts it to ZZ: exactly when it is integral, else TypeError (for an
    infinity or a NaN too in RR; a float's are Python's OverflowError and
    ValueError, as in Sage)."""
    if _real_kind(x) == "rr":
        try:
            r = _real_qq(x)
        except ValueError:
            r = None
        if r is None or r.denominator != 1:
            raise TypeError("Attempt to coerce non-integral RealNumber to Integer")
        return int(r.numerator)
    # (the double itself: a subclass's __float__ is not consulted, astra's
    # CORR-28E-1)
    f = float.__float__(x)
    # __int__ is called once, as Sage does, and its answer must be the
    # double's own integral value (astra's CORR-28E-1)
    n = int(x)
    if not (_math.isfinite(f) and f.is_integer()) or n != int(f):
        raise TypeError("cannot convert non-integral float to integer")
    return n


def _QQ(x, d=None):
    """QQ(2, 3) or QQ("2/3") or QQ(0.75).  A real number (a float, RDF or RR
    element) becomes the simplest rational that rounds to it, an integral
    one itself, as in Sage: QQ(0.1) is 1/10, not the double's exact value
    3602879701896397/36028797018963968 (that is x.exact_rational())."""
    if d is None and _real_kind(x) is not None:
        return _simplest_rational(x, "QQ of a real number", literal=True)
    return _QQ_exact(x, d)


def _QQ_exact(x, d=None):
    """The exact rational x (or x/d); a real number's exact binary value."""
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


from _sage_lang import _RealField, _RealBig
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
        # (the precision as given goes to N, which names it in a refusal:
        # 54.2 bits, not 54)
        q = _sage_real.digits_to_prec(digits) if digits is not None else prec
        # (converted once: an __int__ is called once, as in Sage)
        p = _sage_real._prec_int(q)
        q = _sage_real._Bits(p, q)
        if p != 53 or getattr(x, "_s", None) is None:
            if hasattr(x, "n") and not isinstance(x, (int, float, _Fraction)) and getattr(x, "_s", None) is None and not isinstance(x, (_sage_real.RealNumberMP, _sage_real.ComplexNumberMP)):
                try:
                    return x.n(prec=p)
                except TypeError:
                    pass
            return _sage_real.N(x, q)
    if hasattr(x, "n") and not isinstance(x, (int, float)):
        return x.n()
    return RR(x)


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
        sage: factor(QQ(2^127 - 1)/2, proof=True)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: a primality proof above 3.3e24 is not implemented: n passes BPSW, which is not a proof (call is_prime with proof=False)
        sage: ZZ(2^127 - 1).is_prime(proof=True)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: a primality proof above 3.3e24 is not implemented: n passes BPSW, which is not a proof (call is_prime with proof=False)
    """
    if isinstance(n, _Fraction):
        # a rational (6/3 too) is never prime in QQ, a field; Sage says so
        # (int() truncated: is_prime(7/2) tested 3)
        import warnings
        warnings.warn("Testing primality in Rational Field, which is a field, hence the result will always be False. To test whether n is a prime integer, use is_prime(ZZ(n)) or ZZ(n).is_prime(). Using n.is_prime() instead will silence this warning.", UserWarning)
        return False
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


def next_prime(n, proof=None):
    """The smallest prime > n (proven with proof=True: see is_prime).

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
    # (the numbers skipped are proven composite; the answer is proven too
    # when asked, or NotImplementedError: the systematic review's ASR-F1)
    if proof:
        is_prime(n, proof=True)
    return n


def previous_prime(n, proof=None):
    """The largest prime < n (proven with proof=True: see is_prime).

    EXAMPLES::

        sage: previous_prime(10), previous_prime(2^64)
        (7, 18446744073709551557)
    """
    n = int(n) - 1
    if n < 2:
        raise ValueError("no prime less than 2")
    while not is_prime(n):
        n -= 1
    if proof:
        is_prime(n, proof=True)
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
    _admit_prime_sieve(start, stop, "prime_range")
    # (segmented: the primes up to the square root of stop, then the window
    # [start, stop) alone, so that a narrow window near 10^12 is cheap)
    root = _math.isqrt(stop - 1)
    small = bytearray([1]) * (root + 1)
    small[0:2] = b"\x00\x00"
    for p in range(2, _math.isqrt(root) + 1):
        if small[p]:
            small[p * p::p] = bytes(len(range(p * p, root + 1, p)))
    keep = bytearray([1]) * (stop - start)
    for p in range(2, root + 1):
        if small[p]:
            first = max(p * p, -(-start // p) * p) - start
            if first < stop - start:
                keep[first::p] = bytes(len(range(first, stop - start, p)))
    return [start + i for i, v in enumerate(keep) if v]


# A prime sieve takes at most this share of the heap: its cells (the window
# and the primes up to the square root of its end, a byte each) and its
# result together are admitted before anything is made (HARD-3BE-1)
_PRIME_HEAP_SHARE = 16


def _prime_cells():
    # (pyjs: its heap limit; CPython: the machine's total; _capacity, D0)
    import _capacity
    return _capacity.heap_figure() // _PRIME_HEAP_SHARE


def _prime_sieve_admits(start, stop):
    """Whether a sieve of the integers in [start, stop) is admitted."""
    return (stop - start) + _math.isqrt(max(stop - 1, 0)) <= _prime_cells()


def _admit_prime_sieve(start, stop, name):
    if not _prime_sieve_admits(start, stop):
        import _capacity
        cap = _prime_cells()
        e = MemoryError("%s over [%d, %d) is not supported in Sagebrush: at most %d integers, with the square root "
                        "of the end, fit its heap" % (name, start, stop, cap))
        # (the enforced cap, a byte a cell, and the need; the memory
        # observed free, which decided nothing: D0)
        e.need_bytes, e.limit_bytes, e.capacity = (stop - start) + _math.isqrt(max(stop - 1, 0)), cap, _capacity.capacity()
        raise e


def _nth_prime_bound(k):
    """An upper bound for the k-th prime (Rosser: k (log k + log log k)
    for k >= 6)."""
    if k < 6:
        return 13
    return int(k * (_math.log(k) + _math.log(_math.log(k)))) + 1


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
    k = int(k)
    if k < 1:
        return []
    bound = _nth_prime_bound(k)
    _admit_prime_sieve(2, bound + 1, "primes_first_n")
    return prime_range(bound + 1)[:k]


def nth_prime(k):
    """The k-th prime.

    EXAMPLES::

        sage: nth_prime(1), nth_prime(100), nth_prime(10000)
        (2, 541, 104729)
    """
    if k < 1:
        raise ValueError("n must be positive")
    bound = _nth_prime_bound(int(k))
    _admit_prime_sieve(2, bound + 1, "nth_prime")
    return prime_range(bound + 1)[int(k) - 1]


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

    def _latex_(self):
        """LaTeX, as Sage writes it.

        EXAMPLES::

            sage: latex(factor(2^10*3^15*7)), latex(factor(-12)), latex(factor(-1))
            (2^{10} \\cdot 3^{15} \\cdot 7, -1 \\cdot 2^{2} \\cdot 3, -1)
        """
        from _sage_poly import _latex_factorization
        if not self:
            return str(latex(self.unit))
        return _latex_factorization([(str(latex(p)), e) for p, e in self],
                                    "-1" if self.unit == -1 else None, bare_unit=True)

    def value(self):
        """The product of the factorization.

        EXAMPLES::

            sage: factor(-360).value()
            -360
        """
        # exact (rationally for negative exponents): never a float
        v = self.unit
        for p, e in self:
            v *= (QQ(p) ** e) if e < 0 else p ** e
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

    The agent API's call options (deadline=, work=, checkpoints) are refused
    before anything runs until this build has them
    (sagebrush.capabilities())::

        sage: factor(2^64 + 1, deadline=60)
        Traceback (most recent call last):
        ...
        TypeError: factor(): deadline= is not available in this build
    """
    if kwds:
        from sagebrush import records as _records
        _records.refuse_later_options("factor", kwds)
    if isinstance(n, (_Polynomial, _Expr)) or (not isinstance(n, (int, _Fraction)) and hasattr(n, "factor")):
        F = n.factor()
        if proof:
            # the integer factors (a polynomial's content, ...) proven prime
            for p, _ in F:
                if isinstance(p, int) and not is_prime(p, proof=True):
                    raise RuntimeError("factor: %d was reported prime but is composite" % p)
        return F
    if isinstance(n, _Fraction) and n.denominator != 1:
        num, den = factor(n.numerator, proof=proof), factor(n.denominator, proof=proof)
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
    # every factor prime (BPSW; proven with proof=True, else
    # NotImplementedError): a composite is never reported as a prime
    # factor, whatever produced it (a factor proven composite here would be
    # an engine bug: Arnault's strong pseudoprime to fixed bases)
    for p in out:
        if not is_prime(p, proof=proof):
            raise RuntimeError("factor: %d was reported prime but is composite" % p)
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


def _valuation_base(p):
    """p as an int, an integer > 1 (composite allowed, as Sage): integral
    rationals and reals accepted; TypeError for a fractional value, ValueError
    for p < 2 (it is checked before any loop: base 1 never terminated)."""
    if isinstance(p, bool):
        p = int(p)
    if not isinstance(p, int):
        if isinstance(p, _Fraction):
            if p.denominator != 1:
                raise TypeError("no conversion of this rational to integer")
            p = p.numerator
        else:
            try:
                from _sage_padic import _exact_number
                q = _exact_number(p)
            except (TypeError, ValueError, OverflowError):
                raise TypeError("unable to convert %r to an integer" % (p,))
            if q.denominator != 1:
                raise TypeError("Attempt to coerce non-integral RealNumber to Integer")
            p = q.numerator
    p = int(p)
    if p < 2:
        raise ValueError("You can only compute the valuation with respect to a integer larger than 1.")
    return p


def valuation(n, p):
    """The exponent of the prime p in n.

    EXAMPLES::

        sage: valuation(48, 2), valuation(3/8, 2), valuation(50, 5)
        (4, -3, 2)
    """
    p = _valuation_base(p)
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

def _poly_like(a):
    # polynomials over ZZ/QQ, finite fields and number fields, and multivariate ones
    return isinstance(a, _Polynomial) or type(a).__name__ in ("MPolynomial", "Polynomial_ff", "Polynomial_nf")


def gcd(*args):
    """The greatest common divisor.

    EXAMPLES::

        sage: gcd(12, 18), gcd([12, 18, 27]), gcd(2/3, 4/9)
        (6, 3, 2/9)
    """
    if len(args) == 1:
        args = tuple(args[0])
    if any(_poly_like(a) for a in args):
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

        sage: lcm(4, 6), lcm([2, 3, 4, 5]), lcm(2/3, 4/9)
        (12, 60, 4/3)
    """
    if len(args) == 1:
        args = tuple(args[0])
    if any(_poly_like(a) for a in args):
        r = args[0]
        for a in args[1:]:
            r = r.lcm(a) if hasattr(r, "lcm") and not isinstance(r, int) else a.lcm(r)
        return r
    if any(isinstance(a, _Fraction) for a in args):
        r = QQ(args[0])
        for a in args[1:]:
            r = QQ(r).lcm(a)
        return r
    return _math.lcm(*args)


def _sgn(n):
    return (n > 0) - (n < 0)


def _xgcd_int(a, b):
    """(g, s, t) for integers, with the cofactors Sage's integers give: GMP's
    documented normalization (|s| < |b|/(2g) and |t| < |a|/(2g), except
    s = 0, t = sgn(b) when |a| = |b|; s = sgn(a) when b = 0 or |b| = 2g;
    t = sgn(b) when a = 0 or |a| = 2g)."""
    if a == 0 and b == 0:
        return (0, 0, 0)
    x0, x1, y0, y1 = 1, 0, 0, 1
    u, v = a, b
    while v:
        q = u // v
        u, v = v, u - q * v
        x0, x1 = x1, x0 - q * x1
        y0, y1 = y1, y0 - q * y1
    g, s = abs(u), (x0 if u > 0 else -x0)
    if abs(a) == abs(b) or a == 0:
        return (g, 0, _sgn(b))
    if b == 0 or abs(b) == 2 * g:
        s = _sgn(a)
    elif abs(a) == 2 * g:
        t = _sgn(b)
        return (g, (g - t * b) // a, t)
    else:
        m = abs(b) // g
        s %= m
        if 2 * s > m:
            s -= m
    return (g, s, (g - s * a) // b if b else 0)


def xgcd(a, b):
    """(g, s, t) with g = gcd(a, b) = s*a + t*b.

    EXAMPLES::

        sage: xgcd(240, 46), xgcd(1/3, 2)
        ((2, -9, 47), (1/3, 1, 0))
    """
    if _poly_like(a) or _poly_like(b):
        return a.xgcd(b) if _poly_like(a) else b.parent()(a).xgcd(b)
    if isinstance(a, _Fraction) or isinstance(b, _Fraction):
        # QQ is not Euclidean under // and %: Rational.xgcd scales the
        # numerators' xgcd (xgcd(1/3, 2) is (1/3, 1, 0))
        return QQ(a).xgcd(b)
    if isinstance(a, int) and isinstance(b, int):
        return _xgcd_int(int(a), int(b))
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

    For integers, as Sage: in 0, ..., |m| - 1 for a negative modulus too,
    0 modulo +-1, ZeroDivisionError when there is none::

        sage: inverse_mod(3, -7), inverse_mod(5, -1)
        (5, 0)
    """
    if isinstance(a, int) and isinstance(m, int):
        if abs(m) == 1:
            return 0
        try:
            return pow(a, -1, abs(m))
        except ValueError:
            raise ZeroDivisionError("inverse of Mod(%s, %s) does not exist" % (a, m)) from None
    return pow(a, -1, m)


def power_mod(a, k, m):
    """a^k modulo m.

    EXAMPLES::

        sage: power_mod(2, 100, 101), power_mod(3, -1, 7)
        (1, 5)
    """
    return pow(a, k, m)


def _kronecker_int(x):
    import operator
    try:
        return operator.index(x)
    except TypeError:
        raise TypeError("unable to convert %s to an integer" % (x,)) from None


def kronecker_symbol(a, n):
    """The Kronecker symbol (a/n) of integers a and n: the Jacobi symbol for
    odd positive n, extended by (a/2) (0 for even a, 1 for a = +-1 mod 8, -1
    for a = +-3 mod 8), (a/-1) = sign of a and (a/0) = [a = +-1].

    EXAMPLES::

        sage: kronecker_symbol(2, 7), kronecker_symbol(3, -8), kronecker_symbol(-1, -1)
        (1, -1, -1)
        sage: [kronecker_symbol(a, 0) for a in (-1, 0, 1, 5)]
        [1, 0, 1, 0]
        sage: kronecker(5, 2), ZZ(6).kronecker(4)
        (-1, 0)
        sage: kronecker_symbol(1/2, 7)
        Traceback (most recent call last):
        ...
        TypeError: unable to convert 1/2 to an integer
    """
    a, n = _kronecker_int(a), _kronecker_int(n)
    if n == 0:
        return Integer(1 if abs(a) == 1 else 0)
    t = 1
    if n < 0:
        n = -n
        if a < 0:
            t = -t
    v = (n & -n).bit_length() - 1
    if v:
        if a % 2 == 0:
            return Integer(0)
        n >>= v
        if v % 2 and a % 8 in (3, 5):
            t = -t
    # the Jacobi symbol (a/n), n odd and positive, by reciprocity
    a %= n
    while a:
        while a % 2 == 0:
            a //= 2
            if n % 8 in (3, 5):
                t = -t
        a, n = n, a
        if a % 4 == 3 and n % 4 == 3:
            t = -t
        a %= n
    return Integer(t if n == 1 else 0)


kronecker = kronecker_symbol


def legendre_symbol(a, p):
    """The Legendre symbol (a/p) for an odd prime p: 0 when p divides a, 1
    when a is a nonzero square mod p, -1 otherwise.

    EXAMPLES::

        sage: legendre_symbol(2, 7), legendre_symbol(3, 7), legendre_symbol(14, 7)
        (1, -1, 0)
        sage: legendre_symbol(2, 9)
        Traceback (most recent call last):
        ...
        ValueError: p must be a prime
        sage: legendre_symbol(3, 2)
        Traceback (most recent call last):
        ...
        ValueError: p must be odd
    """
    a, p = _kronecker_int(a), _kronecker_int(p)
    if not is_prime(p):
        raise ValueError("p must be a prime")
    if p == 2:
        raise ValueError("p must be odd")
    return kronecker_symbol(a, p)


def jacobi_symbol(a, b):
    """The Jacobi symbol (a/b) for odd b: the product of the Legendre
    symbols (a/p) over the primes p dividing b, with multiplicity.

    EXAMPLES::

        sage: jacobi_symbol(5, 21), jacobi_symbol(2, 15), jacobi_symbol(0, 1)
        (1, 1, 1)
        sage: jacobi_symbol(5, 20)
        Traceback (most recent call last):
        ...
        ValueError: second input must be odd, 20 is not odd
    """
    a, b = _kronecker_int(a), _kronecker_int(b)
    if b % 2 == 0:
        raise ValueError("second input must be odd, %s is not odd" % b)
    return kronecker_symbol(a, b)


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
        if len(rs) != len(ms):
            raise ValueError("arguments to CRT must be lists of the same length")
    else:
        rs, ms = [a, b], [m, n]
    if not all(isinstance(v, int) for v in rs + ms):
        x, M = 0, 1
        for r, mi in zip(rs, ms):
            g, s, _ = xgcd(M, mi)
            if (r - x) % g:
                raise ValueError("no solution to crt problem since gcd(%s,%s) does not divide %s-%s" % (M, mi, x, r))
            x += M * ((r - x) // g * s % (mi // g))
            M = M * mi // g
            x %= M
        return x
    # (integers, as Sage: from the first congruence as given, each next one
    # combined with the moduli by their absolute values, the solution in
    # 0, ..., lcm - 1 (crt(1, 2, -3, 5) is 7); two zero moduli are a
    # division by zero, an incompatible pair "no solution" (naming the
    # moduli and residues so far), then a zero modulus a modulo by zero,
    # CORR-BCC-1)
    if not rs:
        return 0
    x, M = rs[0], ms[0]
    for r, mi in zip(rs[1:], ms[1:]):
        A, B = abs(M), abs(mi)
        g = _math.gcd(A, B)
        if g == 0:
            raise ZeroDivisionError("Integer division by zero")
        if (r - x) % g:
            raise ValueError("no solution to crt problem since gcd(%s,%s) does not divide %s-%s" % (M, mi, x, r))
        if A == 0 or B == 0:
            raise ZeroDivisionError("Integer modulo by zero")
        _, s, _ = xgcd(A, B)
        x += A * ((r - x) // g * s % (B // g))
        M = A * B // g
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
        sage: var('k n'); sum(k, k, 1, n)
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


def factorial(n):
    """n!

    EXAMPLES::

        sage: factorial(10), factorial(0)
        (3628800, 1)
        sage: var('n'); factorial(n)
        n
        factorial(n)
        sage: factorial(SR(20)), factorial(SR(100)) / factorial(SR(98))
        (2432902008176640000, 9900)
    """
    from _sage_expr import Expression
    if _symbolic(n) or isinstance(n, Expression):
        # (a constant expression too: factorial(SR(20)) is the symbolic 20!)
        return _symbolic_fun("factorial", n)
    return _math.factorial(n)


def _part(z, name):
    from _sage_matrix import ComplexNumber
    if isinstance(z, ComplexNumber):
        # (an element of CC: its parts are RR's)
        from _sage_lang import RealNumber
        return RealNumber(getattr(complex(z), name))
    from _sage_lang import RealNumber
    if isinstance(z, RealNumber):
        # an element of RR: itself, and the exact 0
        return z if name == "real" else Integer(0)
    if _plain_float_subclass(z):
        # as Sage: the parts of float(z) (__float__ honoured), not the
        # subclass's own real/imag
        f = _float_of(z)
        return f if name == "real" else 0.0
    p = getattr(z, name)
    return p() if callable(p) else p


def _float_of(z):
    """float(z), as Sage takes a float subclass's parts: CPython's float()
    (its __float__ bound as on an instance, the result checked to be a
    float and made exact), but without float()'s DeprecationWarning for a
    strict float subclass result, which Sage does not give (only that
    warning: the hook's own warnings go to the caller's filters)."""
    import warnings
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=r".*The ability to return an instance of a strict subclass of float is deprecated", category=DeprecationWarning)
        return float(z)


def _plain_float_subclass(z):
    """A float subclass other than RR's and RDF's elements."""
    from _sage_rdf import RealDoubleElement
    return isinstance(z, float) and type(z) is not float and not isinstance(z, RealDoubleElement)


def real_part(z):
    """The real part of z (also called real).

    EXAMPLES::

        sage: real(3 + 4*I), real_part(SR(-2)), real(2.5), real(7)
        (3, -2, 2.50000000000000, 7)
        sage: real(RealField(100)(1/3)), real(CC(1, 2))
        (0.33333333333333333333333333333, 1.00000000000000)
    """
    return _part(z, "real")


def imag_part(z):
    """The imaginary part of z (also called imag).

    EXAMPLES::

        sage: imag(3 + 4*I), imag_part(SR(-2)), imag(7), imag(2.5), imag(CC(1, 2)), imag(CC(1, 0))
        (4, 0, 0, 0, 2.00000000000000, 0.000000000000000)
    """
    return _part(z, "imag")


real = real_part
imag = imag_part


def conjugate(z):
    """The complex conjugate of z.

    EXAMPLES::

        sage: conjugate(3 + 4*I), conjugate(7)
        (-4*I + 3, 7)
        sage: conjugate(RR(2)), conjugate(RR(2)).parent(), conjugate(RR(2)).sqrt()
        (2.00000000000000, Real Field with 53 bits of precision, 1.41421356237310)
    """
    from _sage_lang import RealNumber
    if isinstance(z, RealNumber):
        # an element of RR: itself, not float's conjugate (a plain float)
        return z
    if _plain_float_subclass(z):
        # other float subclasses: float(z), as Sage (not their conjugate)
        return _float_of(z)
    return z.conjugate()


def fibonacci(n):
    """The n-th Fibonacci number (fast doubling).

    EXAMPLES::

        sage: [fibonacci(n) for n in range(10)], fibonacci(100)
        ([0, 1, 1, 2, 3, 5, 8, 13, 21, 34], 354224848179261915075)
        sage: fibonacci(-79), fibonacci(-80), parent(fibonacci(-79))
        (14472334024676221, -23416728348467685, Integer Ring)
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
        # F(-m) = (-1)^(m+1) F(m), by parity (a power of -1 with a negative
        # exponent is a float)
        f = fibonacci(-n)
        return f if n % 2 else -f
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
        if isinstance(x, _RealBig):
            # an element of RR past the doubles: its root in the MP field
            # (CC holds doubles only)
            r = (-x).sqrt() if x < 0 else x.sqrt()
            if x > 0:
                return r
            if isinstance(r, _RealBig):
                raise NotImplementedError("sqrt(%s): a complex number past the double range is not available in sagebrush yet" % x)
            return CC(0, float(r))
        if x < 0:
            return CC(0, _math.sqrt(-x))
        return RealNumber(_math.sqrt(x))
    if isinstance(x, complex):
        return CC(x ** 0.5)
    if isinstance(x, int) and x >= 0:
        r = _math.isqrt(x)
        if r * r == x:
            return r
    if isinstance(x, Rational):
        return x.sqrt()
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


def prod(x, z=None, recursion_cutoff=5):
    """The product of the elements of x, times z on the left if given.

    The factors are multiplied in order (only grouped, so products that
    don't commute, such as matrices', come out right), as a balanced tree,
    so that big integers are multiplied in like sizes: a sized x (a list,
    tuple, range...) halved until a part has at most recursion_cutoff
    factors, multiplied one after another; any other iterable read once,
    its factors merged in blocks of like sizes as they come (z, if given,
    first among them); sized means len(x) succeeds, asked before x is
    iterated. An x with its own prod() or mul() method gives that instead
    (an array's prod(), say), z unused. As Sage's.

    EXAMPLES::

        sage: prod([1, 2, 3, 4]), prod(range(1, 11)), prod([])
        (24, 3628800, 1)
        sage: prod([2, 3], 5), prod((k for k in [2, 3]), 5), prod([], 7)
        (30, 30, 7)
        sage: A = matrix([[1, 1], [0, 1]]); B = matrix([[1, 0], [1, 1]])
        sage: prod([A, B, A]) == A * B * A, prod([A, B, A]) == B * A * A
        (True, False)
        sage: prod(range(1, 20001)) == factorial(20000)
        True
    """
    cutoff = _operator.index(recursion_cutoff)
    # (a Py_ssize_t, as Sage's, before x is looked at: astra's CORR-663-2)
    if not -9223372036854775808 <= cutoff <= 9223372036854775807:
        raise OverflowError("Python int too large to convert to C ssize_t")
    # (an x with its own prod(), else its own mul(), gives the product
    # itself, z unused, as Sage's; an AttributeError, also one raised in
    # the call, goes on to the next way, any other error is raised)
    try:
        return x.prod()
    except AttributeError:
        pass
    try:
        return x.mul()
    except AttributeError:
        pass
    # (sized as Sage tells it: len(x), through the type's length protocol,
    # before x is iterated; a TypeError from it streams, any other error
    # is raised; astra's CORR-663-1)
    try:
        len(x)
    except TypeError:
        return _prod_stream(x, z)
    x = list(x)
    if not x:
        return 1 if z is None else z
    if cutoff < 1:
        # (only halving uses the cutoff: Sage's recursion has no end then)
        raise ValueError("recursion_cutoff must be positive")
    r = _prod_halves(x, 0, len(x), cutoff)
    return r if z is None else z * r


def _prod_halves(x, a, b, cutoff):
    # (x[a:b]'s product: at most cutoff factors one after another, else
    # the product of its halves, the first one the larger; the depth is
    # that of halving, about log2 of the length)
    if b - a <= cutoff:
        r = x[a]
        for i in range(a + 1, b):
            r = r * x[i]
        return r
    m = a + (b - a + 1) // 2
    return _prod_halves(x, a, m, cutoff) * _prod_halves(x, m, b, cutoff)


def _prod_stream(it, z):
    # (an iterable's product as its factors come, z first if given: a
    # stack of products of 1, 2, 4, ... factors, two of a size merged, as
    # a binary counter; at the end multiplied from the right)
    values = []
    sizes = []

    def push(v):
        size = 1
        while sizes and sizes[-1] == size:
            v = values.pop() * v
            sizes.pop()
            size *= 2
        values.append(v)
        sizes.append(size)

    if z is not None:
        push(z)
    for v in it:
        push(v)
    if not values:
        return 1
    r = values.pop()
    while values:
        r = values.pop() * r
    return r


def continued_fraction(x, nterms=20):
    """The continued fraction of x: finite for a rational, and for an exact
    real number the lazy sequence of its partial quotients, each one
    certified (a float never decides a quotient: SAGE-541-1).  A quadratic
    irrational is computed exactly by its periodic (P, Q) recurrence; another
    algebraic number, pi or e, from certified enclosures refined as needed.
    Where no enclosure is precise enough, NotImplementedError.

    EXAMPLES::

        sage: continued_fraction(415/93), continued_fraction(-7/3), continued_fraction([2, 4, 1])
        ([4; 2, 6, 7], [-3; 1, 2], [2; 5])
        sage: continued_fraction(sqrt(17))
        [4; 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, ...]
        sage: c = continued_fraction(sqrt(2)/3); list(c[:6]), c.convergent(3)
        ([0, 2, 8, 4, 8, 4], 33/70)
        sage: continued_fraction(pi)[4], continued_fraction(2^(1/3))[9]
        (292, 8)

    Further quotients, certified (also checked against mpmath at 2000
    digits); a slice is the finite continued fraction of a convergent, in
    canonical form (a last quotient 1 merges into the one before), as
    Sage's::

        sage: c = continued_fraction(e); [c[k] for k in range(20, 30)]
        [14, 1, 1, 16, 1, 1, 18, 1, 1, 20]
        sage: c = continued_fraction(pi); [c[k] for k in range(20, 30)]
        [1, 84, 2, 1, 1, 15, 3, 13, 1, 4]
        sage: c = continued_fraction(2^(1/3)); [c[k] for k in range(30, 40)]
        [1, 15, 3, 1, 4, 534, 1, 1, 5, 1]
        sage: c = continued_fraction(sqrt(2) + sqrt(3)); [c[k] for k in range(35, 45)]
        [31, 2, 1, 1, 3, 1, 44, 1, 89, 1]
        sage: continued_fraction(e)[:24], continued_fraction((1 + sqrt(5))/2)[:4]
        ([2; 1, 2, 1, 1, 4, 1, 1, 6, 1, 1, 8, 1, 1, 10, 1, 1, 12, 1, 1, 14, 1, 1, 16], [1; 1, 2])
    """
    if isinstance(x, (list, tuple)):
        qs = [_cf_int(a, "an integer quotient") for a in x]
        if not qs:
            raise ValueError("continued fraction can not represent infinity")
        if any(a <= 0 for a in qs[1:]):
            raise ValueError("all quotient except the first must be positive")
        if len(qs) > 1 and qs[-1] == 1:
            # the canonical form, as Sage's: [..., a, 1] is [..., a + 1]
            qs[-2] += 1
            qs.pop()
        return _ContinuedFraction(qs)
    if isinstance(x, _Expr):
        c = _ContinuedFractionReal(x)
        q = c._rational()
        if q is None:
            return c
        x = q
    if isinstance(x, (int, _Fraction)):
        f = _Fraction(x)
        out = []
        while True:
            a = _math.floor(f)
            out.append(a)
            f -= a
            if f == 0:
                return _ContinuedFraction(out, x)
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


# limits of an infinite continued fraction (daybreak2's HARD-1D1-1..3):
# indices of convergents and slices, quadratic period length, and digits of
# a certified enclosure
_CF_MAX_INDEX = 100000
_CF_MAX_PERIOD = 100000
_CF_MAX_DIGITS = 100000
# sizes, not just counts (daybreak2's HARD-58E-1): a convergent's numerator
# or denominator, all the convergents of a slice together, and a quadratic
# irrational's discriminant (its period states and quotients grow with it)
_CF_MAX_BITS = 10**6
_CF_MAX_TOTAL_BITS = 10**7
_CF_MAX_DISC_BITS = 20000
# total work: the bits of every numerator and denominator computed along
# the way (sqrt(2).convergent(n) does about 0.64 n^2 bit operations)
_CF_MAX_WORK = 10**9
# an exact expression whose engine form (its integers in decimal, already
# written when it was made) is longer than this, about 2300 bits of
# integers, is not given to AA, whose own work grows steeply with it:
# sqrt(2^2000 + 1) takes 0.9 s there, sqrt(2^6000 + 1) more than 90 s.
# The engine form is measured, never str(x): printing a huge integer is
# itself the expensive step (HARD-DB5-1)
_CF_MAX_EXPR_CHARS = 800


def _cf_bits(h, k, what):
    if max(abs(h).bit_length(), abs(k).bit_length()) > _CF_MAX_BITS:
        raise NotImplementedError("%s of more than %d bits" % (what, _CF_MAX_BITS))


def _cf_admit(n, what):
    if n > _CF_MAX_INDEX:
        raise NotImplementedError("%s %d of an infinite continued fraction: the limit is %d" % (what, n, _CF_MAX_INDEX))


def _cf_int(n, what="an integer"):
    """n as an int, refusing a non-integer instead of truncating it
    (astra's CORR-1D1-1: a quotient 3/2 or an index 2.9 was truncated)."""
    if isinstance(n, bool):
        raise TypeError("unable to convert %r to %s" % (n, what))
    if isinstance(n, int):
        return int(n)
    if isinstance(n, _Fraction):
        if n.denominator == 1:
            return int(n.numerator)
        raise TypeError("unable to convert rational %s to %s" % (n, what))
    if isinstance(n, _Expr):
        q = _py_number_expr(n)
        if isinstance(q, int):
            return q
        if isinstance(q, _Fraction) and q.denominator == 1:
            return int(q.numerator)
    raise TypeError("unable to convert %s to %s" % (n, what))


def _py_number_expr(n):
    try:
        from _sage_expr import _py_number
        return _py_number(n._s)
    except Exception:
        return None


def _cf_negative_convergent(n, part):
    # Sage's initial pairs: p_{-2}/q_{-2} = 0/1, p_{-1}/q_{-1} = 1/0
    # (CORR-1D1-2: a negative index gave an unrelated prefix)
    if n < -2:
        raise ValueError("n must be at least -2")
    num, den = (0, 1) if n == -2 else (1, 0)
    if part == "numerator":
        return num
    if part == "denominator":
        return den
    if den == 0:
        raise ZeroDivisionError("rational division by zero")
    return _q(_Fraction(num, den))


def _cf_convergent(qs, n):
    """The n-th convergent of the partial quotients qs[0..n]."""
    h0, h1, k0, k1 = 1, qs[0], 0, 1
    for a in qs[1:n + 1]:
        h0, h1, k0, k1 = h1, a * h1 + h0, k1, a * k1 + k0
    return _q(_Fraction(h1, k1))


class _ContinuedFraction(tuple):
    """Partial quotients, printed as Sage prints a continued fraction.
    Immutable, as Sage's (CORR-1D1-4: a list that could be changed
    disagreed with its cached value)."""
    _latex_container = True  # (latex() writes it as a tuple, as before; not yet as Sage writes it)

    def __new__(cls, qs=(), value=None):
        obj = tuple.__new__(cls, qs)
        obj._value = value
        return obj

    def __repr__(self):
        return "[%s]" % (str(self[0]) + ("; " + ", ".join(str(a) for a in self[1:]) if len(self) > 1 else ""))

    def __getitem__(self, i):
        if isinstance(i, slice):
            return _ContinuedFraction(tuple.__getitem__(self, i))
        i = _cf_int(i)
        if i < 0:
            raise ValueError("n (=%d) should be positive" % i)
        return tuple.__getitem__(self, i)

    def quotient(self, n):
        return self[n]

    def convergent(self, n):
        n = _cf_int(n)
        if n < 0:
            return _cf_negative_convergent(n, "convergent")
        return _cf_convergent(self, min(n, len(self) - 1))

    def convergents(self):
        return [_cf_convergent(self, n) for n in range(len(self))]

    def numerator(self, n):
        n = _cf_int(n)
        if n < 0:
            return _cf_negative_convergent(n, "numerator")
        return self.convergent(n).numerator()

    def denominator(self, n):
        n = _cf_int(n)
        if n < 0:
            return _cf_negative_convergent(n, "denominator")
        return self.convergent(n).denominator()

    def value(self):
        return self._value if self._value is not None else self.convergent(len(self) - 1)


class _ContinuedFractionReal:
    """The continued fraction of an exact irrational real number: its
    partial quotients, computed on demand and each certified.

    EXAMPLES::

        sage: c = continued_fraction(sqrt(17)); c[3], c.quotient(5), c.convergent(3), c.value()
        (8, 8, 2177/528, sqrt(17))
        sage: c[10^12], continued_fraction(-sqrt(3))[10^12 + 1]  # sagebrush only (periodic: no list to 10^12)
        (8, 2)
        sage: c.convergent(10^9)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: convergent 1000000000 of an infinite continued fraction: the limit is 100000
        sage: c[:5], len(continued_fraction(-sqrt(3))[:4])
        ([4; 8, 8, 8, 8], 4)
    """

    def __init__(self, x):
        self._x = x
        self._qs = []
        self._periodic = None
        self._err = None
        self._gen = self._quotients()

    def value(self):
        return self._x

    def __len__(self):
        raise ValueError("the length is infinite!")

    def __iter__(self):
        i = 0
        while True:
            yield self.quotient(i)
            i += 1

    def quotient(self, n):
        n = _cf_int(n)
        if n < 0:
            raise IndexError("negative index")
        if self._err is not None:
            # the computation failed before: the same refusal again, never a
            # stale or empty result (CORR-1D1-3: retrying returned None)
            raise self._err[0](*self._err[1])
        if self._periodic is None and not self._qs:
            # the first step: a quadratic irrational sets _periodic (and
            # yields nothing); anything else yields its first quotient
            first = self._next()
            if self._periodic is None:
                self._qs.append(first)
        if self._periodic is not None:
            pre, per = self._periodic
            return pre[n] if n < len(pre) else per[(n - len(pre)) % len(per)]
        while len(self._qs) <= n:
            self._qs.append(self._next())
        return self._qs[n]

    def _next(self):
        # one quotient from the generator; a failure is remembered and
        # raised again on every later request
        try:
            return next(self._gen)
        except StopIteration:
            if self._periodic is not None:
                return None  # the quadratic setup step yields nothing
            self._err = (RuntimeError, ("the continued fraction ended unexpectedly",))
            raise RuntimeError("the continued fraction ended unexpectedly")
        except Exception as err:
            self._err = (type(err), err.args)
            raise

    def __getitem__(self, i):
        if isinstance(i, slice):
            if i.stop is None or i.stop < 0 or (i.start or 0) < 0:
                raise NotImplementedError("only finite slices of an infinite continued fraction")
            stop = _cf_int(i.stop)
            _cf_admit(stop, "a slice to index")
            return continued_fraction([self.quotient(k) for k in range(*i.indices(stop))])
        i = _cf_int(i)
        if i < 0:
            raise ValueError("n (=%d) should be positive" % i)
        return self.quotient(i)

    def convergent(self, n):
        n = _cf_int(n)
        if n < 0:
            return _cf_negative_convergent(n, "convergent")
        _cf_admit(n, "convergent")
        h0, h1, k0, k1 = 1, self.quotient(0), 0, 1
        work = 0
        for i in range(1, n + 1):
            a = self.quotient(i)
            h0, h1, k0, k1 = h1, a * h1 + h0, k1, a * k1 + k0
            _cf_bits(h1, k1, "a convergent")
            work += h1.bit_length() + k1.bit_length() + a.bit_length()
            if work > _CF_MAX_WORK:
                raise NotImplementedError("convergent %d: more than %d bit operations" % (n, _CF_MAX_WORK))
        return _q(_Fraction(h1, k1))

    def convergents(self):
        """The convergents, lazily.

        EXAMPLES::

            sage: continued_fraction(sqrt(17)).convergents()
            lazy list [4, 33/8, 268/65, ...]
        """
        return _LazyConvergents(self)

    def numerator(self, n):
        n = _cf_int(n)
        if n < 0:
            return _cf_negative_convergent(n, "numerator")
        return self.convergent(n).numerator()

    def denominator(self, n):
        n = _cf_int(n)
        if n < 0:
            return _cf_negative_convergent(n, "denominator")
        return self.convergent(n).denominator()

    def __repr__(self):
        return "[%d; %s, ...]" % (self.quotient(0), ", ".join(str(self.quotient(k)) for k in range(1, 20)))


    def _algebraic(self):
        # (the number in AA, its minimal polynomial's coefficients), or None
        if not hasattr(self, "_aa"):
            if len(self._x._s) > _CF_MAX_EXPR_CHARS:
                raise NotImplementedError("the continued fraction of an expression of more than %d characters" % _CF_MAX_EXPR_CHARS)
            try:
                a = AA(self._x)
                self._aa = (a, [_Fraction(c) for c in a.minpoly().list()])
            except Exception:
                self._aa = None
        return self._aa

    def _rational(self):
        t = self._algebraic()
        return -t[1][0] / t[1][1] if t is not None and len(t[1]) == 2 else None

    def _quotients(self):
        t = self._algebraic()
        if t is not None and len(t[1]) == 3:
            # periodic: quotient(n) indexes it, with no list up to n
            self._periodic = _cf_quadratic(*t)
            return
            yield
        yield from _cf_enclosed(self._x, t[0] if t is not None else None)


class _LazyConvergents:
    """The convergents of an infinite continued fraction, as a lazy list."""

    def __init__(self, cf):
        self._cf = cf

    def __iter__(self):
        h0, h1, k0, k1 = 1, self._cf.quotient(0), 0, 1
        yield _q(_Fraction(h1, k1))
        n = 1
        while True:
            a = self._cf.quotient(n)
            h0, h1, k0, k1 = h1, a * h1 + h0, k1, a * k1 + k0
            _cf_bits(h1, k1, "a convergent")
            yield _q(_Fraction(h1, k1))
            n += 1

    def __getitem__(self, i):
        if isinstance(i, slice):
            if i.stop is None or i.stop < 0 or (i.start or 0) < 0:
                raise NotImplementedError("only finite slices of an infinite list")
            _cf_admit(_cf_int(i.stop), "a slice to index")
            want = set(range(*i.indices(_cf_int(i.stop))))
            out, total, work = [], 0, 0
            for k, v in enumerate(self):  # one pass, not each from the start
                if k >= _cf_int(i.stop):
                    break
                b = v.numerator().bit_length() + v.denominator().bit_length()
                work += b
                if work > _CF_MAX_WORK:
                    raise NotImplementedError("a slice of convergents: more than %d bit operations" % _CF_MAX_WORK)
                if k in want:
                    total += b
                    if total > _CF_MAX_TOTAL_BITS:
                        raise NotImplementedError("a slice of convergents of more than %d bits in all" % _CF_MAX_TOTAL_BITS)
                    out.append(v)
            return out if (i.step or 1) > 0 else out[::-1]
        return self._cf.convergent(_cf_int(i))

    def __len__(self):
        raise ValueError("the length is infinite!")

    def __repr__(self):
        return "lazy list [%s, ...]" % ", ".join(str(self._cf.convergent(k)) for k in range(3))


def _cf_quadratic(a, m):
    """(preperiod, period) of the partial quotients of the quadratic
    irrational a, a root of
    m[2] t^2 + m[1] t + m[0]: with D = B^2 - 4AC, a = (P + sqrt(D))/Q, and
    a_k = floor((P + sqrt(D))/Q), P' = a_k Q - P, Q' = (D - P'^2)/Q, all in
    integers (Q divides D - P^2 throughout); periodic from the first
    repeated (P, Q)."""
    den = 1
    for c in m:
        den = den * c.denominator // _math.gcd(den, c.denominator)
    C, B, A = (int(c * den) for c in m)
    D = B * B - 4 * A * C
    if D.bit_length() > _CF_MAX_DISC_BITS:
        raise NotImplementedError("a quadratic irrational whose discriminant has more than %d bits" % _CF_MAX_DISC_BITS)
    # which root: a is above the midpoint -B/(2A) exactly when it is the
    # (-B + sqrt(D))/(2A) root with A > 0, or the other one with A < 0
    above = a > AA(_q(_Fraction(-B, 2 * A)))
    P, Q = (-B, 2 * A) if above == (A > 0) else (B, -2 * A)
    r = _math.isqrt(D)
    seen, qs = {}, []
    held = 0
    while (P, Q) not in seen:
        if len(qs) >= _CF_MAX_PERIOD:
            raise NotImplementedError("a quadratic irrational whose period is longer than %d" % _CF_MAX_PERIOD)
        held += P.bit_length() + Q.bit_length() + 2
        if held > _CF_MAX_TOTAL_BITS:
            raise NotImplementedError("a quadratic irrational whose period states exceed %d bits" % _CF_MAX_TOTAL_BITS)
        seen[(P, Q)] = len(qs)
        k = (P + r) // Q if Q > 0 else -((P + r) // -Q + 1)
        qs.append(k)
        P = k * Q - P
        Q = (D - P * P) // Q
    start = seen[(P, Q)]
    return qs[:start], qs[start:]


def _cf_enclosed(x, a):
    """Partial quotients of x read from certified enclosures [lo, hi]: a
    quotient is emitted only when every number in the interval has it.  The
    enclosure is refined (an algebraic number's certified ball, or RIF at a
    higher precision); when it no longer narrows, NotImplementedError."""
    def enclose(digits):
        if a is not None:
            re, _, err = a._ball(digits)
            return re - err, re + err
        I = RealIntervalField(int(digits * 3.33) + 10)(x)
        return _Fraction(I._lo), _Fraction(I._hi)
    emitted, digits, width = 0, 30, None
    while True:
        if digits > _CF_MAX_DIGITS:
            raise NotImplementedError("the continued fraction of %s: precision limit (%d digits) reached at partial quotient %d" % (x, _CF_MAX_DIGITS, emitted))
        lo, hi = enclose(digits)
        w = hi - lo
        if width is not None and w * 2 > width:
            raise NotImplementedError("the continued fraction of %s: no certified enclosure precise enough for partial quotient %d" % (x, emitted))
        width = w
        k = 0
        while True:
            fa, fb = _math.floor(lo), _math.floor(hi)
            if fa != fb or lo == fa:
                break
            if k >= emitted:
                yield fa
                emitted += 1
            k += 1
            lo, hi = 1 / (hi - fa), 1 / (lo - fa)
        # double, clamped to the limit; past it the loop refuses before
        # asking for an enclosure (61440 digits doubled asked for 122880)
        digits = _CF_MAX_DIGITS + 1 if digits >= _CF_MAX_DIGITS else min(digits * 2, _CF_MAX_DIGITS)


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


def _sorted_dict_repr(d, seen=()):
    """A dict shown with its keys sorted, as Sage's (IPython's) display does
    (one inside itself as {...}, as repr's)."""
    try:
        keys = sorted(d)
    except TypeError:
        return None
    seen = seen + (id(d),)

    def value(x):
        if type(x) is not dict:
            return repr(x)
        if id(x) in seen:
            return "{...}"
        s = _sorted_dict_repr(x, seen)
        return repr(x) if s is None else s
    return "{" + ", ".join("%r: %s" % (k, value(d[k])) for k in keys) + "}"


class _UnavailableInterface:
    """An interface to another program (gp, maxima, singular, ...), as Sage
    has: Sagebrush runs in the browser, with no other programs to start, so
    using one is an explicit refusal (NotImplementedError), not a NameError.

    EXAMPLES::

        sage: gp  # sagebrush only
        PARI/GP interpreter (not available in Sagebrush)
        sage: maxima('2 + 2')  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: the Maxima interface is not available in Sagebrush (it runs no other programs); use Sagebrush's own functions
    """

    def __init__(self, name, system):
        self._name, self._system = name, system

    def __repr__(self):
        return "%s (not available in Sagebrush)" % self._system

    def _refuse(self, *args, **kwds):
        raise NotImplementedError("the %s interface is not available in Sagebrush (it runs no other programs); use Sagebrush's own functions" % self._name)

    __call__ = _refuse

    def __getattr__(self, name):
        # (a method, gp.eval: a callable that refuses; the attributes tools
        # probe for, fget or keys, are absent)
        if name.startswith("_") or name in _PROBED:
            raise AttributeError(name)
        return self._refuse


_PROBED = frozenset(("fget", "fset", "fdel", "keys", "items", "values", "shape", "dtype", "tolist",
                     "read", "write", "close", "next", "send", "throw", "parent"))

_INTERFACES = {
    "gp": ("PARI/GP", "PARI/GP interpreter"), "pari": ("PARI", "Interface to the PARI C library"),
    "maxima": ("Maxima", "Maxima"), "maxima_calculus": ("Maxima", "Maxima_lib"),
    "singular": ("Singular", "Singular"), "gap": ("GAP", "Gap"), "libgap": ("GAP", "C library interface to GAP"),
    "macaulay2": ("Macaulay2", "Macaulay2"), "mathematica": ("Mathematica", "Mathematica"),
    "maple": ("Maple", "Maple"), "kash": ("KASH", "Kash"), "magma": ("Magma", "Magma"),
    "octave": ("Octave", "Octave"), "matlab": ("MATLAB", "Matlab"), "mupad": ("MuPAD", "MuPAD"),
    "axiom": ("Axiom", "Axiom"), "fricas": ("FriCAS", "FriCAS"), "giac": ("Giac", "Giac"),
    "lie": ("LiE", "LiE Interpreter"), "r": ("R", "R Interpreter"), "polymake": ("polymake", "Polymake"),
    "scilab": ("Scilab", "Scilab"), "mwrank": ("mwrank", "Mwrank"), "qepcad": ("QEPCAD", "QEPCAD"),
}
for _n, (_label, _sys) in _INTERFACES.items():
    globals()[_n] = _UnavailableInterface(_label, _sys)
    __all__.append(_n)
del _n, _label, _sys


def load(filename, *args, **kwds):
    """Load a file into the session, as Sage's load(): a missing file is
    Sage's error; reading a file is not available in Sagebrush yet.

    EXAMPLES::

        sage: load("no-such-file.sage")  # sagebrush only
        Traceback (most recent call last):
        ...
        OSError: did not find file 'no-such-file.sage' to load or attach
        sage: load("setup")  # sagebrush only
        Traceback (most recent call last):
        ...
        FileNotFoundError: [Errno 2] No such file or directory: 'setup.sobj'
    """
    import os
    name = str(filename)
    root, ext = os.path.splitext(name)
    if ext in ("", ".sobj"):
        path = name if ext else name + ".sobj"
        if not os.path.exists(path):
            raise FileNotFoundError(2, "No such file or directory", path)
        raise NotImplementedError("loading a saved object (.sobj) is not available in Sagebrush yet")
    if not os.path.exists(name):
        raise OSError("did not find file %r to load or attach" % name)
    raise NotImplementedError("load() of a file is not available in Sagebrush yet: paste or import its code")


def attach(*filenames):
    """Attach files to the session, as Sage's attach(): a missing file is
    Sage's error; attaching is not available in Sagebrush yet.

    EXAMPLES::

        sage: attach("no-such-file.sage")  # sagebrush only
        Traceback (most recent call last):
        ...
        OSError: did not find file 'no-such-file.sage' to load or attach
    """
    import os
    for f in filenames:
        if not os.path.exists(str(f)):
            raise OSError("did not find file %r to load or attach" % str(f))
    raise NotImplementedError("attach() is not available in Sagebrush yet")


def save(obj, filename=None, *args, **kwds):
    """Save an object to a file (Sage's .sobj): not available in Sagebrush
    yet.

    EXAMPLES::

        sage: save(1, "one")  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: save() (Sage's .sobj files) is not available in Sagebrush yet
    """
    raise NotImplementedError("save() (Sage's .sobj files) is not available in Sagebrush yet")


__all__ += ["load", "attach", "save"]


def _install_displayhook():
    import builtins
    import sys
    # pyjs: Sage code calls builtins.__pyjs_sage_displayhook__, Python code
    # __pyjs_displayhook__ (src/compile.ts), so this is Sage's display only,
    # whatever the session; CPython's REPL: sys.displayhook
    pyjs = hasattr(builtins, "__pyjs_sage_displayhook__")
    if pyjs:
        if getattr(builtins.__pyjs_sage_displayhook__, "_sagebrush", False):
            return

        def plain(v):
            # (the hook the host has now, for all code)
            return builtins.__pyjs_displayhook__(v)
    else:
        plain = sys.displayhook
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
        builtins.__pyjs_sage_displayhook__ = hook
    else:
        sys.displayhook = hook


_install_displayhook()
