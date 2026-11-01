"""Sage's symbolic ring: x = var('x'); diff(sin(x^2)/x, x).

An Expression is a handle on an expression of the Rust symbolic engine
(engine/sym): it holds the engine's canonical serialization, so equal
expressions have equal strings, and every operation is one stateless call
into the engine (simplification, printing, calculus, solving all happen
there).  This module only translates between Python values and the engine
and gives the results Sage's methods and printing.
"""

import math as _m
import re as _re
from fractions import Fraction as _Fraction
import sys as _sys
import _display_budget
from _display_budget import _charge

try:  # the CPython package
    from sagebrush._native import sym_call as _raw
except ImportError:  # pyjs: the engine is linked into the runtime
    import _sbengine
    _raw = _sbengine.sym

_SEP = "\x1f"
_ERRORS = {"ZeroDivisionError": ZeroDivisionError, "ValueError": ValueError,
           "NotImplementedError": NotImplementedError}



def _is_symbolic_function(v):
    """Whether v is a callable expression f(x) = ... (_sage_lang's
    SymbolicFunction, whose type shows as Sage's Expression)."""
    import _sage_lang
    return isinstance(v, _sage_lang.SymbolicFunction)

def _call(op, *args):
    r = _raw(_SEP.join((op,) + args)).split(_SEP)
    if r[0] == "ok":
        return r[1:]
    raise _ERRORS.get(r[1], RuntimeError)(r[2] if len(r) > 2 else "symbolic engine error")


def _one(op, *args):
    return Expression(_call(op, *args)[0])


# ------------------------------------------------------------------ conversion

def _is_poly(v):
    return hasattr(v, "_c") and hasattr(v, "variable_name") and hasattr(v, "_ring")


def _sym_s(name):
    return "s%d:%s" % (len(name.encode()), name)


def _float_s(v):
    return _call("float", repr(float(v)))[0]


# The largest integer an expression may hold (the engine's MAX_INT_BITS):
# expressions cross into the engine as decimal text, so a larger one is
# refused before it is formatted, as CPython refuses int-to-str past its
# digit limit.
_MAX_INT_BITS = 1 << 21


def _rat_s(p, q=1):
    """The engine serialization of the rational p/q (q > 0, exact ints)."""
    bits = max(p.bit_length(), q.bit_length())
    if bits > _MAX_INT_BITS:
        raise NotImplementedError(
            "an integer of %d bits in a symbolic expression: sagebrush's "
            "symbolic ring holds integers of at most %d bits" % (bits, _MAX_INT_BITS))
    return "n%d/%d;" % (p, q)


def _to_s(v):
    """The engine serialization of a Python value, or None."""
    if isinstance(v, Expression):
        return v._s
    if isinstance(v, int):
        return _rat_s(int(v))
    if isinstance(v, _Fraction):
        # exact ints first: formatting an int subclass must not round it
        return _rat_s(int(v.numerator), int(v.denominator))
    if isinstance(v, float):
        if _rr_args((v,)) == 2:
            # (the engine's real numbers are doubles)
            raise NotImplementedError("%s, an element of RR past the double range, has no symbolic form in sagebrush yet" % (v,))
        return _float_s(v)
    if isinstance(v, complex):
        if v.imag == 0:
            return _float_s(v.real)
        return _call("complex", repr(v.real), repr(v.imag))[0]
    if _is_poly(v):
        t, r = Expression(_sym_s(v.variable_name())), Expression("n0/1;")
        for i, c in enumerate(v._c):
            if c != 0:
                r = r + _expr(c) * t ** i
        return r._s
    sr = getattr(v, "_symbolic_", None)
    if sr is not None:
        return _to_s(sr())
    if hasattr(v, "numerator") and hasattr(v, "denominator"):
        try:
            p, q = v.numerator, v.denominator
            p, q = (p() if callable(p) else p), (q() if callable(q) else q)
            return _rat_s(int(p), int(q)) if int(q) > 0 else None
        except (TypeError, ValueError):
            return None
    return None


def _expr(v):
    """v as an Expression (SR(v)); TypeError if it has no symbolic form."""
    if isinstance(v, Expression):
        return v
    if isinstance(v, str):
        return Expression(_call("parse", v)[0])
    if _is_symbolic_function(v) and not v._vec:
        return v._expr
    s = _to_s(v)
    if s is None:
        raise TypeError("cannot convert %r to a symbolic expression" % (v,))
    return Expression(s)


SR = _expr


def _py_number(s):
    """The Python value of an exact rational or a float expression, or None."""
    r = _call("number", s)
    if r[0] == "q":
        p, q = r[1].split("/")
        import sage_all as sa
        return sa._intdiv(int(p), int(q)) if q != "1" else sa.Integer(int(p))
    if r[0] == "f" and float(r[2]) == 0:
        from _sage_lang import RealNumber
        return RealNumber(float(r[1]))
    return None


_INFINITIES = {"+Infinity": 1, "-Infinity": -1, "Infinity": 0}


def _infinite_relation(kind, a, b):
    """bool(a <kind> b) when a or b is an infinity (a - b is then an
    infinity or NaN, which decides nothing); None otherwise.  A signed
    infinity is ordered against a constant only when the constant has a
    certified real sign; anything else undecided is False, as in Sage."""
    ra, rb = repr(a), repr(b)
    ia, ib = _INFINITIES.get(ra), _INFINITIES.get(rb)
    if ia is None and ib is None:
        return None
    if ia is not None and ib is not None:
        if kind in ("==", "!="):
            return (ra == rb) == (kind == "==")
        if ia == 0 or ib == 0:
            return False
        return {"<": ia < ib, "<=": ia <= ib, ">": ia > ib, ">=": ia >= ib}[kind]
    c = b if ia is not None else a
    if c.variables() or repr(c) == "NaN":
        return None if kind in ("==", "!=") else False
    if kind in ("==", "!="):
        return kind == "!="
    s = ia if ia is not None else ib
    if s == 0 or _call("const_sign", c._s)[0] == "":
        return False
    # a finite real constant lies strictly between -oo and +oo
    sa, sb = (s, 0) if ia is not None else (0, s)
    return {"<": sa < sb, "<=": sa < sb, ">": sa > sb, ">=": sa > sb}[kind]


def _numerically_equal(a, b):
    """Heuristic equality of two constants that the engine could neither
    simplify to equal nor separate: their difference, evaluated at 400 bits,
    is below 2^-300 relative to them.  (A double, which underflows or
    cancels, is never used.)"""
    import _sage_real
    try:
        d = abs(_sage_real.N(a - b, 400))
        m = max(abs(_sage_real.N(a, 400)), abs(_sage_real.N(b, 400)), 1)
        return bool(d <= m * _sage_real.N(Expression("2") ** -300, 400))
    except Exception:
        return False


def _relop(sym):
    return {"Eq": "==", "Ne": "!=", "Lt": "<", "Le": "<=", "Gt": ">", "Ge": ">="}[sym]


# ------------------------------------------------------------------ Expression

class Expression:
    """An element of Sage's symbolic ring.

    EXAMPLES::

        sage: f = x^2 + 2*x + 1; f
        x^2 + 2*x + 1
        sage: f.factor(), f.diff(x), f.integrate(x), f(x=3)
        ((x + 1)^2, 2*x + 2, 1/3*x^3 + x^2 + x, 16)
    """

    __slots__ = ("_s", "_repr", "_fast", "_h", "__weakref__")

    def __init__(self, s):
        if _SPECIAL_RE.search(s) and _FLOAT_RE.search(s):
            s = _complete_special(s)
        self._s, self._repr, self._fast, self._h = s, None, None, None

    def __reduce__(self):
        return (Expression, (self._s,))

    def parent(self):
        """The symbolic ring SR.

        EXAMPLES::

            sage: x.parent()
            Symbolic Ring
        """
        return SR_parent

    # --- arithmetic
    def _bin(self, op, other, rev=False):
        o = _to_s(other)
        if o is None:
            return NotImplemented
        r = _one(op, o, self._s) if rev else _one(op, self._s, o)
        if r._s == "c?" and op in _SIGN_ERRORS and ("c+" in (o, self._s) or "c-" in (o, self._s)):
            # oo*0, oo - oo: Sage's infinity raises (SignError), where the
            # engine's arithmetic gives NaN
            raise SignError(_SIGN_ERRORS[op])
        return r

    def __add__(self, o): return self._bin("add", o)
    def __radd__(self, o): return self._bin("add", o, True)
    def __sub__(self, o): return self._bin("sub", o)
    def __rsub__(self, o): return self._bin("sub", o, True)
    def __mul__(self, o): return self._bin("mul", o)
    def __rmul__(self, o): return self._bin("mul", o, True)
    def __truediv__(self, o): return self._bin("div", o)
    def __rtruediv__(self, o): return self._bin("div", o, True)
    def __pow__(self, o, mod=None):
        if mod is not None:
            # (the modulus was ignored: pow(SR(2), 3/2, 5) was 2*sqrt(2)), as Sage
            raise TypeError("the 3-argument version of pow() is not supported")
        return self._bin("pow", o)
    def __rpow__(self, o): return self._bin("pow", o, True)
    def __xor__(self, o): raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")
    __rxor__ = __xor__
    def __neg__(self): return _one("neg", self._s)
    def __pos__(self): return self
    def __abs__(self):
        r = _one("fun", "abs", self._s)
        if _ASSUMPTIONS and r._op()[0] == "fun:abs":
            sg = _sign_of(self)
            if sg is not None:
                return self if sg >= 0 else -self
        return r

    # --- relations: x == 2 is an equation; bool() decides it
    def _rel(self, op, other):
        o = _to_s(other)
        if o is None:
            return NotImplemented
        return _one("rel", op, self._s, o)

    def __eq__(self, o): return self._rel("==", o)
    def __ne__(self, o): return self._rel("!=", o)
    def __lt__(self, o): return self._rel("<", o)
    def __le__(self, o): return self._rel("<=", o)
    def __gt__(self, o): return self._rel(">", o)
    def __ge__(self, o): return self._rel(">=", o)

    def __hash__(self):
        # an exact number hashes as that number (SR(1) == 1 with different
        # hashes broke dictionaries and sets: the systematic review's API-F2),
        # and a polynomial with rational coefficients as the polynomial does
        # (t == SR(t): R2-API-F1); cached
        h = self._h
        if h is not None:
            return h
        s = self._s
        h = None
        if s.startswith("n") and s.endswith(";") and "/" in s:
            try:
                num, den = s[1:-1].split("/")
                h = hash(_Fraction(int(num), int(den)))
            except ValueError:
                pass
        if h is None and not self.is_relational():
            terms = _sr_poly_terms(self, sorted(self._names()))
            if terms is not None:
                from _sage_poly import poly_hash
                h = poly_hash(terms)
        if h is None:
            h = hash(s)
        self._h = h
        return h

    def __bool__(self):
        op = self._op()
        if op[0].startswith("rel:"):
            kind = _relop(op[0][4:])
            a, b = Expression(op[1]), Expression(op[2])
            inf = _infinite_relation(kind, a, b)
            if inf is not None:
                return inf
            if kind in ("==", "!="):
                z = _call("is_zero", (a - b)._s)[0] == "1"
                if not z and kind == "==" and not (a - b).variables() and _call("const_sign", (a - b)._s)[0] == "":
                    # constants of undecided sign: equal if they agree to
                    # far more than double precision (never from an
                    # underflowed or cancelled double)
                    z = _numerically_equal(a, b)
                if not z and _ASSUMPTIONS and (a - b).variables():
                    # the rewritten difference tested directly: bool() of
                    # (rewrite == 0) came back here and rewrote again,
                    # without end when the rewrite changed nothing (any
                    # comparison under assume(x > 0): the review's SOLVE2-F6)
                    z = _call("is_zero", _assume_rewrite(a - b).expand()._s)[0] == "1"
                return z if kind == "==" else not z
            if (a - b).variables():
                if _ASSUMPTIONS:
                    for r in _ASSUMPTIONS:
                        if isinstance(r, Expression) and str(r) == str(self):
                            return True
                return False
            # constants: only a certified sign of a - b decides (exact for
            # rationals); undecided is False, as in Sage
            sg = _call("const_sign", (a - b)._s)[0]
            if sg == "":
                return False
            sg = int(sg)
            return {"<": sg < 0, "<=": sg <= 0, ">": sg > 0, ">=": sg >= 0}[kind]
        return _call("is_zero", self._s)[0] != "1"

    def lhs(self):
        """The left-hand side of an equation (also left()).

        EXAMPLES::

            sage: (x^2 == 4).lhs(), (x < 1).left_hand_side()
            (x^2, x)
        """
        op = self._op()
        if not op[0].startswith("rel:"):
            raise AttributeError("lhs: not a relation")
        return Expression(op[1])

    def rhs(self):
        """The right-hand side of an equation (also right()).

        EXAMPLES::

            sage: (x^2 == 4).rhs(), (x < 1).right()
            (4, 1)
        """
        op = self._op()
        if not op[0].startswith("rel:"):
            raise AttributeError("rhs: not a relation")
        return Expression(op[2])

    left = left_hand_side = lhs
    right = right_hand_side = rhs

    # --- printing
    def __repr__(self):
        if self._repr is None:
            self._repr = _call("str", self._s)[0]
        return self._repr

    __str__ = __repr__

    def _latex_(self):
        t = _call("latex", self._s)[0]
        for n, l in _LATEX_NAMES.items():
            # (the symbol alone, as written or as rendered: _y is _{y})
            if n not in _LATEX_SYM:
                _LATEX_SYM[n] = _call("latex", _sym_s(n))[0]
            if t == n or t == _LATEX_SYM[n]:
                return l
            t = t.replace("\\mathit{%s}" % n, l)
        return t

    def __format__(self, spec):
        return format(str(self), spec)

    # --- structure
    def _op(self):
        return _call("operator", self._s)

    def variables(self):
        """The variables, sorted.

        EXAMPLES::

            sage: var('y z')
            (y, z)
            sage: (x + z*y).variables()
            (x, y, z)
        """
        return tuple(Expression(_sym_s(n)) for n in _call("variables", self._s) if n)

    arguments = args = variables

    def _names(self):
        return [n for n in _call("variables", self._s) if n]

    def operator(self):
        """The top-level operation.

        EXAMPLES::

            sage: (x^2).operator(), (x + 1).operator()  # sagebrush only
            (<function pow at 0x...>, <function add at 0x...>)
        """
        import operator as o
        tag = self._op()[0]
        if tag == "add":
            return o.add
        if tag == "mul":
            return o.mul
        if tag == "pow":
            return o.pow
        if tag.startswith("rel:"):
            return {"Eq": o.eq, "Ne": o.ne, "Lt": o.lt, "Le": o.le, "Gt": o.gt, "Ge": o.ge}[tag[4:]]
        if tag.startswith("fun:"):
            return _functions.get(tag[4:]) or function(tag[4:])
        return None

    def operands(self):
        """The operands of the top-level operation.

        EXAMPLES::

            sage: (x^2 + 3*x).operands()
            [x^2, 3*x]
        """
        return [Expression(s) for s in self._op()[1:]]

    def number_of_operands(self):
        """The number of operands (also nops()).

        EXAMPLES::

            sage: (x + 1).number_of_operands(), (x^2).nops()
            (2, 2)
        """
        return len(self._op()) - 1

    nops = number_of_operands

    def is_symbol(self):
        """Whether the expression is a single variable.

        EXAMPLES::

            sage: x.is_symbol(), (x + 1).is_symbol()
            (True, False)
        """
        return self._s.startswith("s")

    def is_numeric(self):
        """Whether the expression is a number.

        EXAMPLES::

            sage: SR(2/3).is_numeric(), pi.is_numeric()
            (True, False)
        """
        return self._s[0] in "nzfg"

    def is_constant(self):
        """Whether the expression has no variables.

        EXAMPLES::

            sage: pi.is_constant(), x.is_constant()
            (True, False)
        """
        return not self._names()

    def is_relational(self):
        """Whether the expression is an equation or inequality.

        EXAMPLES::

            sage: (x == 1).is_relational(), (x + 1).is_relational()
            (True, False)
        """
        return self._s.startswith("R")

    def is_zero(self):
        """Whether the expression is zero (after simplification).

        EXAMPLES::

            sage: (x - x).is_zero(), (sin(x)^2 + cos(x)^2 - 1).is_zero()
            (True, True)
        """
        return _call("is_zero", self._s)[0] == "1"

    def is_trivial_zero(self):
        """Whether the expression is literally 0.

        EXAMPLES::

            sage: SR(0).is_trivial_zero(), (x - x).is_trivial_zero()
            (True, True)
        """
        return self._s == "n0/1;"

    def is_integer(self):
        """Whether the expression is an integer.

        EXAMPLES::

            sage: SR(3).is_integer(), (x + 1).is_integer()
            (True, False)
        """
        v = _py_number(self._s)
        return isinstance(v, int) and not isinstance(v, float)

    def is_rational_expression(self):
        """Whether the expression is a rational function: a quotient of
        polynomials in its variables.

        EXAMPLES::

            sage: (1/(x + 1)).is_rational_expression(), sin(x).is_rational_expression()
            (True, False)
        """
        n, d = self.numerator_denominator()
        vs = self.variables()
        if not vs:
            return self.is_numeric()
        return all(n.is_polynomial(v) and d.is_polynomial(v) for v in vs)

    def is_polynomial(self, var):
        """Whether the expression is a polynomial in x.

        EXAMPLES::

            sage: (x^2 + 1).is_polynomial(x), (1/x).is_polynomial(x)
            (True, False)
        """
        try:
            self.coefficients(var)
            return True
        except ValueError:
            return False

    # --- substitution and evaluation
    def subs(self, *args, **kw):
        """subs(x=2), subs({x: 2}), subs(x == 2), subs([x == 1, y == 2]).

        EXAMPLES::

            sage: f = x^2 + 1
            sage: f.subs(x=2), f.subs({x: x + 1}), f.subs(x == 3)
            (5, (x + 1)^2 + 1, 10)
        """
        pairs = []

        def add(a):
            if isinstance(a, dict):
                for k, v in a.items():
                    pairs.extend((_expr(k)._s, _expr(v)._s))
            elif isinstance(a, (list, tuple)):
                for r in a:
                    add(r)
            elif isinstance(a, Expression) and a.is_relational():
                pairs.extend((a.lhs()._s, a.rhs()._s))
            else:
                raise TypeError("subs: expected a relation or a dictionary, got %r" % (a,))
        for a in args:
            add(a)
        for k, v in kw.items():
            pairs.extend((_sym_s(k), _expr(v)._s))
        if not pairs:
            return self
        return _one("subs", self._s, *pairs)

    substitute = subs

    def __call__(self, *args, **kw):
        """f(2), f(x=2): substitute (positionally, in the order of variables()).

        EXAMPLES::

            sage: var('y')
            y
            sage: f = x^2 + y
            sage: f(2, 3), f(x=1), f(y=x)  # sagebrush only
            (7, y + 1, x^2 + x)
        """
        names = self._names()
        if len(args) > len(names):
            raise ValueError("the number of arguments must be less than or equal to %d" % len(names))
        d = {Expression(_sym_s(n)): a for n, a in zip(names, args)}
        return self.subs(d, **kw)

    def function(self, *args):
        """The callable expression args |--> self (what f(x) = ... makes).

        EXAMPLES::

            sage: (x^2 + 1).function(x)
            x |--> x^2 + 1
            sage: (x^2 + 1).function(x)(3)
            10
        """
        from _sage_lang import SymbolicFunction
        return SymbolicFunction(self, args)

    def n(self, prec=None, digits=None):
        """The numerical value: an element of RR, or of CC if it is complex
        (or of RealField(prec), ComplexField(prec)).

        EXAMPLES::

            sage: pi.n(), sqrt(2).n(), (1 + I).n(), exp(1).N()  # sagebrush only
            (3.14159265358979, 1.41421356237310, 1.00000000000000 + 1.00000000000000*I, 2.71828182845905)
        """
        if self.is_relational():
            return _one("rel", _relop(self._op()[0][4:]), _expr(self.lhs().n())._s, _expr(self.rhs().n())._s)
        if self._names():
            return self._n_partial()
        if digits is not None or (prec is not None and int(prec) != 53):
            # any precision: _sage_real evaluates the expression tree
            import _sage_real
            return _sage_real.N(self, prec, digits)
        re, im = _call("n", _lower_special(self._s))
        re, im = float(re), float(im)
        if im == 0:
            from _sage_lang import RealNumber
            if re == re and not _NORMAL_MIN < abs(re) < _INF:
                # an infinity, a zero or a subnormal double: RR's value may
                # be past the doubles (n(exp(1000))), so the expression is
                # evaluated in the 53-bit MP field, operation by operation as
                # Sage evaluates it in RR (n(pi^-700) is RR(pi)^-700); where
                # that is not available, an error rather than a wrong value
                import _sage_real
                import _sage_lang
                from sage_all import RR
                try:
                    # (in RR's own MP field, whose arithmetic stays MP)
                    v = _sage_real.evaluate(self, 53, _sage_lang._rr_mp())
                except NotImplementedError as err:
                    if _re.search(r"(?:^|\{)z", self._s):
                        # (with a complex number in it, the expression is
                        # CC's, whose numbers are doubles: as before)
                        return RealNumber(re)
                    raise NotImplementedError("the value of %s in RR (the doubles give %r): %s" % (self, re, err))
                if not isinstance(v, _sage_real.RealNumberMP):
                    raise NotImplementedError("the value of %s in RR: the doubles give %r, the MP evaluation %s" % (self, re, v))
                return RR(v)
            return RealNumber(re)
        from _sage_matrix import ComplexNumber
        return ComplexNumber(re, im)

    def _n_partial(self):
        # numerical approximation of the constants of an expression with variables
        ops = self._op()
        tag = ops[0]
        if tag in ("symbol",):
            return self
        if tag in ("rational", "complex", "float", "constant"):
            return _expr(self.n())
        kids = [Expression(s)._n_partial() if Expression(s)._names() else _expr(Expression(s).n()) for s in ops[1:]]
        if tag == "add":
            r = kids[0]
            for k in kids[1:]:
                r = r + k
            return r
        if tag == "mul":
            r = kids[0]
            for k in kids[1:]:
                r = r * k
            return r
        if tag == "pow":
            return kids[0] ** kids[1]
        if tag.startswith("fun:"):
            return _one("fun", tag[4:], *[k._s for k in kids])
        return self

    numerical_approx = N = n

    def __float__(self):
        if self._names():
            raise TypeError("unable to simplify to float approximation")
        re, im = _call("n", _lower_special(self._s))
        if float(im) != 0:
            raise TypeError("unable to simplify to float approximation")
        return float(re)

    def __complex__(self):
        if self._names():
            raise TypeError("unable to simplify to complex approximation")
        re, im = _call("n", _lower_special(self._s))
        return complex(float(re), float(im))

    def __int__(self):
        v = _py_number(self._s)
        if v is None:
            return int(float(self))
        return int(v)

    def _integer_(self, ZZ=None):
        v = _py_number(self._s)
        if isinstance(v, int):
            return v
        raise TypeError("unable to convert %s to an integer" % self)

    def _rational_(self):
        v = _py_number(self._s)
        if v is None or isinstance(v, float):
            raise TypeError("unable to convert %s to a rational" % self)
        return v

    def pyobject(self):
        """The Python number the (numeric) expression is.

        EXAMPLES::

            sage: SR(5).pyobject(), SR(2/3).pyobject()
            (5, 2/3)
        """
        v = _py_number(self._s)
        if v is None:
            raise TypeError("self must be a numeric expression")
        return v

    def _fast_callable(self, names=None):
        """A Python function of the variables (in sorted order) computing this
        expression in floating point (for plots)."""
        names = list(names) if names is not None else (self._names() or ["x"])  # a constant: f(x) = c
        if self._fast is None or self._fast[0] != names:
            src = "lambda %s: %s" % (", ".join("_v_" + n for n in names), _call("pysrc", self._s)[0])
            self._fast = (names, eval(src, _FAST_GLOBALS))
        return self._fast[1]

    # --- calculus
    def diff(self, *args):
        """diff(x), diff(x, 2), diff(x, y), diff(x, 2, y, 3); with no
        argument, in the only variable.

        EXAMPLES::

            sage: (x^3).diff(x), sin(x^2).diff(x), (x^4).diff(x, 2), (x^2*x).derivative(x)
            (3*x^2, 2*x*cos(x^2), 12*x^2, 3*x^2)
            sage: y = var('y'); (x^2*y).diff([x, y]), (x^2).diff([])
            (2*x, x^2)
        """
        # a list alone is the list of variables, and an empty one means no
        # differentiation, as in Sage (diff(x^2, []) was 2*x); a tuple, or a
        # list among other arguments, is Sage's TypeError
        if len(args) == 1 and isinstance(args[0], list):
            if not args[0]:
                return self
            args = tuple(args[0])
        for a in args:
            if isinstance(a, (list, tuple)):
                raise TypeError("no canonical coercion from %s to Symbolic Ring" % type(a))
        if not args:
            names = self._names()
            if len(names) != 1:
                raise ValueError("No differentiation variable specified.")
            args = (Expression(_sym_s(names[0])),)
        r, last = self, None
        for a in args:
            if isinstance(a, int) and not isinstance(a, bool):
                if last is None:
                    raise ValueError("No differentiation variable specified.")
                if a > 1:
                    r = _one("diff", r._s, last, str(a - 1))
                last = None
                continue
            last = _var_name(a)
            r = _one("diff", r._s, last, "1")
        return r

    derivative = differentiate = diff

    def sum(self, *args, **kw):
        """The symbolic sum over a variable: f.sum(k, a, b).

        EXAMPLES::

            sage: var('k n'); (k^2).sum(k, 1, n)
            (k, n)
            1/3*n^3 + 1/2*n^2 + 1/6*n
        """
        return symbolic_sum(self, *args, **kw)

    def gradient(self, vars=None):
        """The gradient (in the variables, or the given ones).

        EXAMPLES::

            sage: var('y')
            y
            sage: (x^2*y).gradient()
            (2*x*y, x^2)
        """
        from _sage_matrix import vector
        vs = vars or self.variables()
        return vector([self.diff(v) for v in vs])

    def hessian(self):
        """The Hessian matrix.

        EXAMPLES::

            sage: var('y')
            y
            sage: (x^2*y).hessian()
            [2*y 2*x]
            [2*x   0]
        """
        from _sage_matrix import matrix
        vs = self.variables()
        return matrix([[self.diff(u).diff(v) for v in vs] for u in vs])

    def taylor(self, *args):
        """taylor(x, a, n) or taylor((x, a), (y, b), n) (one variable here).

        EXAMPLES::

            sage: exp(x).taylor(x, 0, 4), sin(x).taylor(x, pi, 3)
            (1/24*x^4 + 1/6*x^3 + 1/2*x^2 + x + 1, 1/6*(x - pi)^3 - x + pi)
        """
        if len(args) == 3:
            v, a, n = args
        elif len(args) == 2 and isinstance(args[0], (tuple, list)):
            (v, a), n = args
        else:
            raise ValueError("taylor(x, a, n): expected a variable, a point and an order")
        return _one("taylor", self._s, _var_name(v), _expr(a)._s, str(int(n)))

    def series(self, v, n):
        """The series to order n (in x - a for v = (x == a)), with an O-term.

        EXAMPLES::

            sage: sin(x).series(x, 6), (1/(1 - x)).series(x, 4)
            (1*x + (-1/6)*x^3 + 1/120*x^5 + Order(x^6), 1 + 1*x + 1*x^2 + 1*x^3 + Order(x^4))
        """
        if isinstance(v, Expression) and v.is_relational():
            var, a = v.lhs(), v.rhs()
        else:
            var, a = v, 0
        t = self.taylor(var, a, int(n) - 1)
        return _SeriesExpr(t, _expr(var), _expr(a), int(n))

    def limit(self, *args, dir=None, **kw):
        """limit(x=a), limit(x=a, dir='+'), limit(x == a).

        EXAMPLES::

            sage: (sin(x)/x).limit(x=0), (1/x).limit(x=0, dir='+'), ((1 + 1/x)^x).limit(x=oo)
            (1, +Infinity, e)
        """
        if kw:
            if len(kw) != 1:
                raise ValueError("call the limit function like this, e.g. limit(expr, x=2).")
            (v, a), = kw.items()
        elif len(args) == 1 and isinstance(args[0], Expression) and args[0].is_relational():
            v, a = _var_name(args[0].lhs()), args[0].rhs()
        elif len(args) == 2:
            v, a = _var_name(args[0]), args[1]
        else:
            raise ValueError("call the limit function like this, e.g. limit(expr, x=2).")
        d = {None: "", "+": "+", "plus": "+", "right": "+", "above": "+",
             "-": "-", "minus": "-", "left": "-", "below": "-"}.get(dir)
        if d is None:
            raise ValueError("dir must be one of None, 'plus', '+', 'above', 'right', 'minus', '-', 'below', 'left'")
        return _one("limit", self._s, v, _expr(a)._s, d)

    limit_ = limit

    def solve(self, v, **kw):
        """The solutions of the equation (or of expression == 0).

        EXAMPLES::

            sage: (x^2 - 4).solve(x), (x^2 == 2).solve(x)
            ([x == -2, x == 2], [x == -sqrt(2), x == sqrt(2)])
        """
        return solve(self, v, **kw)

    def roots(self, x=None, ring=None, multiplicities=True):
        """The roots of a polynomial equation with multiplicities, [(root, m), ...].

        EXAMPLES::

            sage: (x^2 - 1).roots(), ((x - 1)^2*(x + 2)).roots()
            ([(-1, 1), (1, 1)], [(-2, 1), (1, 2)])
        """
        x = x if x is not None else self.variables()[0]
        f = self.lhs() - self.rhs() if self.is_relational() else self
        if _call("is_zero", f._s)[0] == "1":
            # (the multiplicity loop differentiated 0 forever: CSOL-F12)
            raise ValueError("every value is a root of 0")
        out = []
        sols = solve(f == 0, x)
        # roots are values: a family or a solution valid only under
        # conditions is not one (sin(x).roots() gave []: CSOL-F11); for a
        # polynomial in x, the roots over the field of its parameters (the
        # coefficient-nonzero ones; its a == 0 branches are other polynomials)
        poly = f.is_polynomial(x)
        if any(isinstance(s, Solution) and (s._params or (s._conds and not poly)) for s in sols):
            raise NotImplementedError("roots: the solutions of %s == 0 are families or conditional (see solve())" % f)
        for s in sols:
            # an unresolved 0 == f is no root (x^5 + x + 3 gave (x^5 + x + 3,
            # 1): the systematic review's R2-SYMALG-F3)
            if str(s.lhs()) != str(x):
                raise RuntimeError("no explicit roots found")
            # the roots of the polynomial over the field of its parameters,
            # where a nonzero coefficient is nonzero: those valid while the
            # leading coefficient is nonzero, not the special cases a == 0
            conds = s.conditions() if isinstance(s, Solution) else []
            if any(c._op()[0] != "rel:Ne" for c in conds) or (isinstance(s, Solution) and s._params):
                continue
            r, m = s.rhs(), 0
            g = f
            while True:
                g2 = g.diff(x) if m else g
                if not bool(g2.subs({x: r}) == 0):
                    break
                g, m = g2, m + 1
            out.append((r, max(m, 1)))
        if not multiplicities:
            return [r for r, _ in out]
        return out

    def find_root(self, a, b, var=None):
        """A numerical root in [a, b] (Brent's method).

        EXAMPLES::

            sage: (x^2 - 2).find_root(0, 2)
            1.4142135623731364
        """
        return find_root(self, a, b, var)

    def integrate(self, *args, **kw):
        """The integral: integrate(x), or the definite integral integrate(x, a, b).

        EXAMPLES::

            sage: (x^2).integrate(x), (x^2).integrate(x, 0, 1), exp(-x^2).integral(x, -oo, oo)
            (1/3*x^3, 1/3, sqrt(pi))
        """
        return integrate(self, *args, **kw)

    integral = integrate

    def plot(self, *args, **kw):
        """A plot of the expression (as plot(f, ...)).

        EXAMPLES::

            sage: sin(x).plot((x, 0, 2*pi))  # random
        """
        from sage_plot import plot
        return plot(self, *args, **kw)

    # --- algebra
    def expand(self):
        """The expansion of products and powers.

        EXAMPLES::

            sage: ((x + 1)^3).expand()
            x^3 + 3*x^2 + 3*x + 1
        """
        if self.is_relational():
            return self._map_rel("expand")
        return _one("expand", self._s)

    def _map_rel(self, op):
        tag = _relop(self._op()[0][4:])
        return _one("rel", tag, _call(op, self.lhs()._s)[0], _call(op, self.rhs()._s)[0])

    def factor(self):
        """The factorization (over QQ).

        EXAMPLES::

            sage: (x^4 - 1).factor(), (x^2 - 2).factor()
            ((x^2 + 1)*(x + 1)*(x - 1), x^2 - 2)
        """
        return _one("factor", self._s)

    def simplify(self):
        """Simplify.

        EXAMPLES::

            sage: (x + x).simplify(), (x^2/x).simplify()
            (2*x, x)
            sage: assume(x > 0); sqrt(x^2).simplify(), sqrt(x^3).simplify(); forget()
            (x, x^(3/2))
        """
        # (Sage's simplify() only applies Maxima's simplification, which uses
        # the assumptions: sqrt(x^2) is x under assume(x > 0))
        return _assume_simplify(self) if _ASSUMPTIONS else self

    def simplify_full(self):
        """Full simplification (also full_simplify).

        EXAMPLES::

            sage: (sin(x)^2 + cos(x)^2).simplify_full()
            1
        """
        # (a relation too: its sides through the assumption pass, which
        # (sqrt(x^2) == y).simplify_full() skipped: astra3's REVISE 349ff797)
        if self.is_relational():
            r = self._map_rel("simplify_full")
        else:
            r = _one("simplify_full", self._s)
        return _assume_simplify(r) if _ASSUMPTIONS else r

    full_simplify = simplify_full

    def simplify_rational(self):
        """Simplify as a rational function (also rational_simplify).

        EXAMPLES::

            sage: ((x^2 - 1)/(x + 1)).simplify_rational()
            x - 1
        """
        return _one("simplify_rational", self._s)

    rational_simplify = simplify_rational

    def simplify_trig(self):
        """Simplify trigonometric expressions (also trig_simplify).

        EXAMPLES::

            sage: (sin(x)^2 + cos(x)^2).simplify_trig(), (2*sin(x)*cos(x)).trig_simplify()
            (1, 2*cos(x)*sin(x))
        """
        return _one("simplify_trig", self._s)

    trig_simplify = simplify_trig

    def expand_trig(self, full=False, half_angles=False, plus=True, times=True):
        """sin, cos, tan (and sinh, cosh, tanh) of sums and of integer
        multiples by the addition and multiple-angle formulas (also
        trig_expand).  One level, as Sage; full=True repeats it.

        EXAMPLES::

            sage: var('y')
            y
            sage: sin(2*x).expand_trig(), cos(x + y).expand_trig()
            (2*cos(x)*sin(x), cos(x)*cos(y) - sin(x)*sin(y))
            sage: sin(2*x + y).expand_trig()
            cos(y)*sin(2*x) + cos(2*x)*sin(y)
            sage: sin(2*x + y).expand_trig(full=True)
            2*cos(x)*cos(y)*sin(x) + (cos(x)^2 - sin(x)^2)*sin(y)
        """
        if half_angles or not plus or not times:
            raise NotImplementedError("expand_trig with half_angles, plus=False or times=False is not implemented in sagebrush yet")
        r = _one("expand_trig", self._s)
        if full:
            for _ in range(50):
                s = _one("expand_trig", r._s)
                if s._s == r._s:
                    break
                r = s
        return r

    trig_expand = expand_trig

    def reduce_trig(self, var=None):
        """Products and powers of sin and cos (and sinh, cosh) as sums of
        sines and cosines of combined arguments (also trig_reduce).

        EXAMPLES::

            sage: (sin(x)^2).reduce_trig(), (cos(x)^2).reduce_trig()
            (-1/2*cos(2*x) + 1/2, 1/2*cos(2*x) + 1/2)
            sage: (sin(x)^2 + cos(x)^2).reduce_trig(), (sin(x)*cos(x)).trig_reduce()
            (1, 1/2*sin(2*x))
        """
        if var is not None:
            raise NotImplementedError("reduce_trig(var) is not implemented in sagebrush yet")
        return _one("reduce_trig", self._s)

    trig_reduce = reduce_trig

    def expand_log(self, algorithm="products"):
        """log of a product as a sum of logs and log(b^p) as p*log(b)
        (algorithm='powers': only the latter; also log_expand).

        EXAMPLES::

            sage: var('y')
            y
            sage: log(x*y).expand_log(), log(x^10).expand_log(), log(x/y).log_expand()
            (log(x) + log(y), 10*log(x), log(x) - log(y))
            sage: log(x^2*y).expand_log(algorithm='powers')
            log(x^2*y)
        """
        if algorithm == "nothing":
            return self
        if algorithm not in ("products", "powers", "all"):
            raise ValueError("algorithm must be 'nothing', 'powers', 'products' or 'all'")
        return _one("expand_log", self._s, "powers" if algorithm == "powers" else "products")

    log_expand = expand_log

    def simplify_log(self, algorithm=None):
        """Sums of logs with integer coefficients as one log (also
        log_simplify).

        EXAMPLES::

            sage: var('y')
            y
            sage: (log(x) + log(y)).simplify_log(), (log(x) - 2*log(y)).log_simplify()
            (log(x*y), log(x/y^2))
            sage: (3*log(2)).simplify_log(), (2*log(x)).simplify_log()
            (3*log(2), log(x^2))
        """
        if algorithm not in (None, "one"):
            raise NotImplementedError("simplify_log(algorithm=%r) is not implemented in sagebrush yet" % (algorithm,))
        return _one("simplify_log", self._s)

    log_simplify = simplify_log

    def canonicalize_radical(self):
        """Radicals and logs in one canonical form, choosing branches as
        Sage does (sqrt(x^2) is x: not right for every x).

        EXAMPLES::

            sage: var('y')
            y
            sage: sqrt(x^2*y^2).canonicalize_radical(), sqrt(8*x^3).canonicalize_radical()
            (x*y, 2*sqrt(2)*x^(3/2))
            sage: sqrt(x^2 + 2*x + 1).canonicalize_radical(), log(x*y).canonicalize_radical()
            (x + 1, log(x) + log(y))
        """
        return _one("canonicalize_radical", self._s)

    def simplify_factorial(self):
        """Factorials and gammas whose arguments differ by integers combined
        (also factorial_simplify).

        EXAMPLES::

            sage: var('n')
            n
            sage: (factorial(n + 1)/factorial(n)).simplify_factorial()
            n + 1
            sage: (gamma(n + 1)/gamma(n)).factorial_simplify()
            n
        """
        return _one("simplify_factorial", self._s)

    factorial_simplify = simplify_factorial

    def partial_fraction(self, var=None):
        """The partial fraction decomposition in var, a rational function
        with rational coefficients.

        EXAMPLES::

            sage: (1/(x^2 - 1)).partial_fraction()
            -1/2/(x + 1) + 1/2/(x - 1)
            sage: (1/(x^2 + 1)).partial_fraction(x)
            1/(x^2 + 1)
        """
        name = self._default_var() if var is None else _expr(var)._names()[0] if not isinstance(var, str) else var
        return _one("partial_fraction", self._s, name)

    def collect(self, s):
        """The expanded expression with its terms grouped by the power of s.

        EXAMPLES::

            sage: var('a b')
            (a, b)
            sage: (x^2 + a*x^2 + b*x + x + 1).collect(x)
            (a + 1)*x^2 + (b + 1)*x + 1
            sage: (a*sin(x) + b*sin(x)).collect(sin(x))
            (a + b)*sin(x)
        """
        s = _expr(s)
        if not s.is_symbol():
            # a subexpression: through a fresh symbol
            names = set(self._names()) | set(s._names())
            k = 0
            while "_collect%d" % k in names:
                k += 1
            t = Expression(_sym_s("_collect%d" % k))
            return self.subs({s: t}).collect(t).subs({t: s})
        e = self.expand()
        terms = e.operands() if e._op()[0] == "add" else [e]
        groups, order = {}, []
        for t in terms:
            # the term's factor s^k (k an integer, else 0); the rest is its
            # coefficient, whatever else it contains (x*sin(x): sin(x))
            fs = t.operands() if t._op()[0] == "mul" else [t]
            k, cs = 0, []
            for f in fs:
                if f._s == s._s:
                    k += 1
                    continue
                if f._op()[0] == "pow":
                    b, p = f.operands()
                    if b._s == s._s and p.is_integer():
                        k += int(p)
                        continue
                cs.append(f)
            c = Expression("n1/1;")
            for f in cs:
                c = c * f
            if k not in groups:
                groups[k] = []
                order.append(k)
            groups[k].append(c)
        r = Expression("n0/1;")
        for k in order:
            c = Expression("n0/1;")
            for u in groups[k]:
                c = c + u
            r = r + c * s ** k
        return r

    def combine(self):
        """Combine the terms of a sum that have the same denominator (Sage's
        combine(); together() puts everything over one denominator).

        EXAMPLES::

            sage: (1/x + 1/(x + 1)).combine()
            1/(x + 1) + 1/x
        """
        if self._op()[0] != "add":
            return self
        groups = {}
        order = []
        for t in self.operands():
            n, d = t.numerator_denominator()
            k = repr(d)
            if k not in groups:
                groups[k] = [d, []]
                order.append(k)
            groups[k][1].append(n)
        out = 0
        for k in order:
            d, ns = groups[k]
            num = ns[0]
            for n in ns[1:]:
                num = num + n
            out = out + (num if repr(d) == "1" else num / d)
        return out

    def numerator(self):
        """The numerator.

        EXAMPLES::

            sage: ((x + 1)/(x - 1)).numerator()
            x + 1
        """
        return _one("numerator", self._s)

    def denominator(self):
        """The denominator.

        EXAMPLES::

            sage: ((x + 1)/(x - 1)).denominator()
            x - 1
        """
        return _one("denominator", self._s)

    def numerator_denominator(self):
        """(numerator, denominator).

        EXAMPLES::

            sage: ((x + 1)/(x - 1)).numerator_denominator()
            (x + 1, x - 1)
        """
        return self.numerator(), self.denominator()

    def degree(self, x):
        """The degree in x.

        EXAMPLES::

            sage: (x^5 + x).degree(x)
            5
        """
        return int(_call("degree", self._s, _var_name(x))[0])

    def coefficient(self, x, n=1):
        """The coefficient of x^n.

        EXAMPLES::

            sage: f = 3*x^2 + 2*x + 1
            sage: f.coefficient(x, 2), f.coefficient(x), f.coeff(x, 0)  # sagebrush only
            (3, 2, 1)
        """
        return _one("coefficient", self._s, _var_name(x), str(int(n)))

    coeff = coefficient

    def list(self, x=None):
        """The coefficients of a polynomial in x, constant term first.

        EXAMPLES::

            sage: (3*x^2 + 1).list(x)
            [1, 0, 3]
        """
        x = _var_name(x if x is not None else self._default_var())
        return [Expression(s) for s in _call("coefficients", self._s, x)]

    def coefficients(self, x=None, sparse=True):
        """[[c, n], ...] for the nonzero terms c*x^n (sparse=False: list()).

        EXAMPLES::

            sage: (3*x^2 + 1).coefficients()
            [[1, 0], [3, 2]]
        """
        cs = self.list(x)
        if not sparse:
            return cs
        return [[c, i] for i, c in enumerate(cs) if not c.is_trivial_zero()]

    def _default_var(self):
        names = self._names()
        if not names:
            return "x"
        return names[0]

    def polynomial(self, base_ring=None, ring=None):
        """This expression as a polynomial (Sage's f.polynomial(QQ)).

        EXAMPLES::

            sage: (x^2 + 3*x + 1).polynomial(QQ), (x^2 + 3*x + 1).polynomial(QQ).parent()
            (x^2 + 3*x + 1, Univariate Polynomial Ring in x over Rational Field)
        """
        import sage_all as sa
        names = self._names()
        if len(names) > 1:
            raise NotImplementedError("polynomials in several variables")
        if ring is None:
            ring = sa.PolynomialRing(base_ring if base_ring is not None else sa.QQ, names[0] if names else "x")
        cs = []
        for c in self.list(names[0] if names else "x"):
            v = _py_number(c._s)
            if v is None or isinstance(v, float):
                raise TypeError("%s is not a polynomial with exact coefficients" % self)
            cs.append(v)
        t, r = ring.gen(), ring(0)
        for i, c in enumerate(cs):
            if c:
                r = r + ring(c) * t ** i
        return r

    def power_series(self, base_ring=None):
        """The expression as a power series (its Taylor series).

        EXAMPLES::

            sage: exp(x).series(x, 5)
            1 + 1*x + 1/2*x^2 + 1/6*x^3 + 1/24*x^4 + Order(x^5)
        """
        raise NotImplementedError("power_series")

    def real(self):
        """The real part.

        EXAMPLES::

            sage: (3 + 4*I).real(), (3 + 4*I).real_part()
            (3, 3)
        """
        return _real_imag(self, 0)

    def imag(self):
        """The imaginary part.

        EXAMPLES::

            sage: (3 + 4*I).imag(), (3 + 4*I).imag_part()
            (4, 4)
        """
        return _real_imag(self, 1)

    real_part, imag_part = real, imag

    def conjugate(self):
        """The complex conjugate.

        EXAMPLES::

            sage: (1 + I).conjugate(), (2 - 3*I).conjugate()
            (-I + 1, 3*I + 2)
        """
        return self.real() - Expression(_call("const", "I")[0]) * self.imag()

    def abs(self):
        """The absolute value.

        EXAMPLES::

            sage: abs(-x), (-3*x).abs()
            (abs(x), 3*abs(x))
        """
        return abs(self)

    def sqrt(self):
        """The square root.

        EXAMPLES::

            sage: (x^2).sqrt(), SR(4).sqrt()
            (sqrt(x^2), 2)
        """
        return self ** _Fraction(1, 2)

    def exp(self):
        """e to the expression.

        EXAMPLES::

            sage: x.exp(), (0*x).exp()
            (e^x, 1)
        """
        return _one("fun", "exp", self._s)

    def log(self, b=None):
        """The natural logarithm.

        EXAMPLES::

            sage: x.log(), e.log()
            (log(x), 1)
        """
        r = _one("fun", "log", self._s)
        return r if b is None else r / _one("fun", "log", _expr(b)._s)

    def show(self):
        """Show the expression typeset (LaTeX in a notebook).

        EXAMPLES::

            sage: (x^2/2).show()  # random
        """
        show_typeset(self)



Expression.__module__ = "sage.symbolic.expression"
Expression._defined_in = "_sage_expr"

def _real_imag(e, k):
    # exact for numbers; otherwise numerical when the expression is constant
    if e._names():
        raise NotImplementedError("real and imaginary parts of expressions with variables")
    r = _call("number", e._s)
    if r[0] == "q":
        return e if k == 0 else Expression("n0/1;")
    if r[0] == "z":
        return Expression("n%s;" % r[1 + k])
    c = complex(e)
    return _expr(c.imag if k else c.real)


class Typeset:
    """What show(...) displays: typeset math where the page or Jupyter
    can render LaTeX, the text form elsewhere (several objects separated
    by spaces).  (Values print as text, as in Sage.)

    EXAMPLES::

        sage: from _sage_expr import show_typeset  # sagebrush only
        sage: show_typeset(x^2)  # random  # sagebrush only
        x^2
        sage: from _sage_expr import Typeset  # sagebrush only
        sage: Typeset(1, 2/3)._repr_mimebundle_()["text/latex"]  # sagebrush only
        '$$1 \\\\ \\\\frac{2}{3}$$'
    """

    def __init__(self, *objs):
        self._objs = objs

    def __repr__(self):
        return self._plain()

    def _repr_latex_(self):
        with _display_budget.display():
            parts = [latex(o) for o in self._objs]
            _charge(1, 4 + 3 * len(parts), "a _latex_")
            return "$$" + " \\ ".join(parts) + "$$"

    def _plain(self):
        # (each piece charged before it is joined: _repr_charged)
        with _display_budget.display():
            parts = []
            for o in self._objs:
                parts.append(_repr_charged(o, ()))
            _charge(1, len(parts))
            return " ".join(parts)

    def _repr_mimebundle_(self, include=None, exclude=None):
        # the marker: the notebook typesets what show() asked for, and
        # leaves other values with a LaTeX form (2/3) as text, as Sage.
        # One display: both forms built within one budget (LIMIT-SHOW87-2)
        with _display_budget.display():
            return {"text/latex": self._repr_latex_(), "text/plain": self._plain(),
                    "application/vnd.sagebrush.typeset": "1"}


def show_typeset(*objs):
    """Show objs typeset with LaTeX: one display (its text form where the
    host cannot typeset).

    EXAMPLES::

        sage: from _sage_expr import show_typeset  # sagebrush only
        sage: show_typeset(sqrt(x)/2)  # random  # sagebrush only
        1/2*sqrt(x)
    """
    import builtins
    t = Typeset(*objs)
    d = getattr(builtins, "__pyjs_display__", None)
    if d is not None:
        d(t)  # (it prints the text form itself without a notebook)
        return
    from _graphics import host_display
    if not host_display(t):
        print(repr(t))


def _min_order(a, b):
    """The smaller of two series orders, None meaning exact."""
    return b if a is None else a if b is None else min(a, b)


class _SeriesExpr(Expression):
    """A truncated series: prints the polynomial part plus O(x^n)."""

    __slots__ = ("_var", "_at", "_order")

    def __init__(self, t, var, at, order):
        Expression.__init__(self, t._s)
        self._var, self._at, self._order = var, at, order

    def _laurent(self):
        """(N, [c_0, c_1, ...]): the body is sum c_i (x - a)^(i - N)."""
        v, a = self._var, self._at
        body = Expression(self._s).subs({v: v + a}).expand()
        for N in range(0, 2000):
            try:
                return N, (body * v ** N).expand().list(v) if N else body.list(v)
            except ValueError:
                continue
        raise ValueError("not a Laurent polynomial")

    def _valuation(self):
        N, cs = self._laurent()
        for i, c in enumerate(cs):
            if not c.is_trivial_zero():
                return i - N
        return self._order if self._order is not None else 10**9

    def _same(self, o):
        if isinstance(o, _SeriesExpr):
            if str(o._var) != str(self._var) or str(o._at) != str(self._at):
                raise ValueError("series in different variables or at different points")
            return o
        o = _expr(o)
        if str(self._var) not in o._names():
            return None  # a constant: exact
        a = self._at
        try:
            # a polynomial in (x - a): exact, with no O-term of its own
            o.subs({self._var: self._var + a}).expand().list(self._var)
            return _SeriesExpr(o, self._var, a, None)
        except ValueError:
            return o.series(self._var == a if not a.is_trivial_zero() else self._var, self._order)

    def _make(self, body, order):
        v, a = self._var, self._at
        # keep only the terms below the order
        t = _SeriesExpr(_expr(body), v, a, order)
        N, cs = t._laurent()
        if order is None:
            return _expr(body)
        keep = sum((c * (v - a) ** (i - N) for i, c in enumerate(cs) if i - N < order and not c.is_trivial_zero()), _expr(0))
        return _SeriesExpr(keep, v, a, order)

    # arithmetic keeps the O-term (a truncated series determines its
    # products only to the lower precision)
    def __add__(self, o):
        t = self._same(o)
        if t is None:
            return self._make(Expression(self._s) + _expr(o), self._order)
        return self._make(Expression(self._s) + Expression(t._s), _min_order(self._order, t._order))

    __radd__ = __add__

    def __neg__(self):
        return _SeriesExpr(-Expression(self._s), self._var, self._at, self._order)

    def __sub__(self, o):
        return self + (-(self._same(o) if self._same(o) is not None else _expr(o)))

    def __rsub__(self, o):
        return (-self) + o

    def __mul__(self, o):
        t = self._same(o)
        if t is None:
            c = _expr(o)
            if c.is_trivial_zero():
                return c
            return self._make(Expression(self._s) * c, self._order)
        order = _min_order(None if self._order is None else self._order + t._valuation(),
                           None if t._order is None else t._order + self._valuation())
        return self._make((Expression(self._s) * Expression(t._s)).expand(), order)

    __rmul__ = __mul__

    def expand(self):
        """The series itself (expanded, with its O-term)."""
        return self

    # (the systematic review's R2-SYMALG-F8: s^(3/2) was s, 1/s, diff(s),
    # s.subs(...), s.simplify_full() dropped the O-term, and dividing by
    # 1 + O(x) kept O(x^5))
    def __pow__(self, k):
        from fractions import Fraction
        kq = _py_number(_expr(k)._s)
        if kq is None or isinstance(kq, (float, complex)):
            raise NotImplementedError("series: only rational powers")
        kq = Fraction(kq)
        if kq.denominator == 1 and kq >= 1:
            r = self
            for _ in range(int(kq) - 1):
                r = r * self
            return r
        if kq == 0:
            return _expr(1)
        if self._order is None:
            return _expr(Expression(self._s) ** _expr(k))
        # (t^v u)^k with u known to t^(n - v): t^(v k) u^k, known to as many
        # terms; v k must be an integer, and u's constant term not 0
        v = self._valuation()
        if v >= self._order:
            raise ZeroDivisionError("series: a power of a series that is O(x^%d)" % self._order) if kq < 0 else NotImplementedError("series: a power of O(x^n)")
        vk = v * kq
        if vk.denominator != 1:
            raise NotImplementedError("series: the power is not a Laurent series (Puiseux)")
        order = int(vk) + (self._order - v)
        body = Expression(self._s) ** _expr(k)
        at = self._at
        s2 = body.series(self._var == at if not at.is_trivial_zero() else self._var, order)
        return _SeriesExpr(s2, self._var, at, order) if not isinstance(s2, _SeriesExpr) else _SeriesExpr(Expression(s2._s), self._var, at, order)

    def __truediv__(self, o):
        if isinstance(o, _SeriesExpr):
            return self * (self._same(o) ** -1)
        o = _expr(o)
        if str(self._var) in o._names():
            t = self._same(o)
            return self * (t ** -1) if isinstance(t, _SeriesExpr) else self._make(Expression(self._s) / o, self._order)
        return self._make(Expression(self._s) / o, self._order)

    def __rtruediv__(self, o):
        return _expr(o) * (self ** -1) if not isinstance(o, _SeriesExpr) else o * (self ** -1)

    def diff(self, *args):
        """The derivative: one order less for each differentiation in the
        series variable (SERIES-0AF-1: diff([x]) kept O(x^5)).

        EXAMPLES::

            sage: s = exp(x).series(x, 5); s.diff(), s.diff([x]), s.diff(x, 2), s.diff(x, x)
            (1 + 1*x + 1/2*x^2 + 1/6*x^3 + Order(x^4), 1 + 1*x + 1/2*x^2 + 1/6*x^3 + Order(x^4), 1 + 1*x + 1/2*x^2 + Order(x^3), 1 + 1*x + 1/2*x^2 + Order(x^3))
        """
        if len(args) == 1 and isinstance(args[0], (list, tuple)):
            if not args[0]:
                return self  # (no variables: no differentiation, as Sage)
            args = tuple(args[0])
        if not args:
            args = (self._var,)
        # (variable, count) pairs: a count after a variable repeats it
        steps = []
        for a in args:
            if isinstance(a, int) or (isinstance(a, Expression) and a.is_numeric() and not a._names()):
                q = _py_number(_expr(a)._s) if isinstance(a, Expression) else a
                if not isinstance(q, int) or isinstance(q, bool):
                    # a fractional count is not a count (it was truncated:
                    # CORR-EC3-2); Sage's error
                    raise TypeError("argument symb must be a symbol")
                if not steps:
                    raise ValueError("a derivative count needs a variable before it")
                steps[-1] = (steps[-1][0], steps[-1][1] + q - 1)
            else:
                steps.append((a, 1))
        body, order = Expression(self._s), self._order
        for v, n in steps:
            if n < 0:
                raise ValueError("the number of derivatives must be nonnegative")
            if not n:
                continue
            if str(v) == str(self._var):
                # one call with the count (the engine's own), not n calls
                body = body.diff(v, n) if n > 1 else body.diff(v)
                if order is not None:
                    order -= n
            else:
                # another variable: each coefficient is differentiated, the
                # coordinate (x - a) held fixed, as Sage does, and the order
                # kept (the chain rule on x - a gave O((x - a)^3) for a
                # series known to O((x - a)^2): CORR-EC3-3)
                body = self._coeff_diff(body, v, n)
        return self._make(body, order)

    def _coeff_diff(self, body, v, n):
        var, a = self._var, self._at
        N, cs = _SeriesExpr(_expr(body), var, a, self._order)._laurent()
        t = var - a
        return sum((c.diff(v, n) * t ** (i - N) for i, c in enumerate(cs) if not c.is_trivial_zero()), _expr(0))

    derivative = diff

    def subs(self, *args, **kw):
        """Substitution in the coefficients; the series variable only by
        another symbol (else the O-term has no meaning: truncate() first)."""
        d = dict(args[0]) if args and isinstance(args[0], dict) else {}
        for a in args:
            if not isinstance(a, dict) and isinstance(a, Expression) and a.is_relational():
                d[a.lhs()] = a.rhs()
        for k, val in kw.items():
            d[_expr(SR.var(k))] = val
        newvar = self._var
        for k, val in list(d.items()):
            if str(k) == str(self._var):
                val = _expr(val)
                if val._op()[0] != "symbol":
                    raise NotImplementedError("subs: substituting %s for the series variable loses the O-term; use truncate() first" % val)
                newvar = val
        body = Expression(self._s).subs(d)
        return _SeriesExpr(body, newvar, _expr(self._at).subs(d), self._order)

    substitute = subs

    def simplify(self):
        return _SeriesExpr(Expression(self._s).simplify(), self._var, self._at, self._order)

    def simplify_full(self):
        return _SeriesExpr(Expression(self._s).simplify_full(), self._var, self._at, self._order)

    def simplify_rational(self):
        return _SeriesExpr(Expression(self._s).simplify_rational(), self._var, self._at, self._order)

    def _terms(self, latex):
        # Sage's form: ascending powers of (x - a), numeric coefficients
        # written out (1*x) and parenthesized unless positive: (-1/6)*x^3
        v, a = self._var, self._at
        base = v - a
        N, coeffs = self._laurent()
        out = []
        for i, c in enumerate(coeffs):
            i -= N
            if c.is_trivial_zero():
                continue
            cs = c._latex_() if latex else str(c)
            if not (c.is_numeric() and bool(c > 0)):
                cs = ("\\left(%s\\right)" if latex else "(%s)") % cs
            if i == 0:
                out.append(cs)
                continue
            p = base if i == 1 else base ** i
            ps = p._latex_() if latex else str(p)
            if i < 0:
                b = base._latex_() if latex else str(base)
                if not base.is_symbol():
                    b = "(%s)" % b
                ps = ("%s^{%d}" if latex else "%s^(%d)") % (b, i)
            if i == 1 and not base.is_symbol():
                ps = ("\\left(%s\\right)" if latex else "(%s)") % ps
            out.append(cs + (" " if latex else "*") + ps)
        h = base ** self._order
        hs = h._latex_() if latex else str(h)
        out.append(("\\mathcal{O}\\left(%s\\right)" if latex else "Order(%s)") % hs)
        return " + ".join(out)

    def __repr__(self):
        return self._terms(False)

    __str__ = __repr__

    def _latex_(self):
        return self._terms(True)

    def truncate(self):
        """The series without its O(x^n) term.

        EXAMPLES::

            sage: sin(x).series(x, 6).truncate()
            1/120*x^5 - 1/6*x^3 + x
        """
        return Expression(self._s)


class _SymbolicRing:
    """The symbolic ring, SR: expressions in variables and constants (pi, e,
    sqrt(2), sin(x), ...), kept exact and simplified on request.

    SR(v) makes a symbolic expression from a number or a string; SR.var('t')
    makes a variable without binding a name.  x is predefined; var('y')
    declares more.

    EXAMPLES::

        sage: SR
        Symbolic Ring
        sage: SR(1)/3 + x, sin(x).parent()
        (x + 1/3, Symbolic Ring)
        sage: SR(pi).n(digits=10), sqrt(SR(8))
        (3.141592654, 2*sqrt(2))
        sage: t = SR.var('t'); (t^2 - 1).factor()
        (t + 1)*(t - 1)
    """

    def __repr__(self):
        return "Symbolic Ring"

    def __reduce__(self):
        # (one SR: a pickle or a copy of it is SR itself, as in Sage)
        return "SR_parent"

    def __call__(self, v):
        """Convert v into a symbolic expression.

        EXAMPLES::

            sage: SR(3/4), SR(pi)
            (3/4, pi)
        """
        return _expr(v)

    def var(self, *names, **kw):
        """Symbolic variables: SR.var('t') (not injected into the globals).

        EXAMPLES::

            sage: t = SR.var('t'); t^2
            t^2
            sage: u = SR.var('u', domain='real'); assumptions()
            [u is real]
            sage: forget()
        """
        if len(names) == 1 and isinstance(names[0], (list, tuple)):
            names = tuple(names[0])
        if len(names) == 1 and isinstance(names[0], str):
            names = names[0].replace(",", " ").split()
        vs = tuple(Expression(_sym_s(n)) for n in names)
        if kw.get("latex_name") is not None:
            for n in names:
                _LATEX_NAMES[n] = str(kw["latex_name"])
        if kw.get("domain") in ("positive", "integer", "real", "complex"):
            for v in vs:
                assume(v, kw["domain"])
        return vs[0] if len(vs) == 1 else vs

    def _latex_(self):
        return "\\text{SR}"


SR_parent = _SymbolicRing()
SR = SR_parent


def _var_name(v):
    if isinstance(v, str):
        return v
    if isinstance(v, Expression) and v.is_symbol():
        return _call("str", v._s)[0]
    if _is_poly(v):
        return v.variable_name()
    raise TypeError("%s is not a valid variable." % (v,))


# ------------------------------------------------------------------ special functions
#
# The numerical values of the special functions (gamma, erf, psi, zeta,
# ...) come from lib/_special.py, the numerical core that MATLAB mode and
# scipy.special share; the engine knows their exact values, canonical
# forms and derivatives (engine/sym special.rs) and leaves a call with
# float arguments as a call, which _complete_special evaluates here.

import re as _re
import cmath as _cmath


class _LazySpecial:
    """lib/_special.py, imported when first used: it needs numpy, which the
    CPython package (sagebrush.sage) does not require for the rest of the
    Sage layer."""
    _mod = None

    def __getattr__(self, name):
        m = _LazySpecial._mod
        if m is None:
            try:
                import _special as m
            except ImportError as e:
                raise NotImplementedError("numerical values of special functions need numpy (%s)" % e)
            _LazySpecial._mod = m
        return getattr(m, name)


_sf = _LazySpecial()

_SPECIAL_NAMES = ("gamma", "erf", "psi", "log_gamma", "zeta", "zetaderiv", "hurwitz_zeta", "beta", "erfc", "erfi",
                  "erfinv", "exp_integral_e1", "Ei", "dilog", "polylog", "lambert_w", "elliptic_kc", "elliptic_ec")
_SPECIAL_RE = _re.compile(r"F\d+:(?:%s)\d+\{" % "|".join(_SPECIAL_NAMES))
_FLOAT_RE = _re.compile(r"\{[fg][0-9a-f]")


class _Keep(Exception):
    """Sage leaves this call unevaluated (no value, or one Sagebrush does not
    compute yet)."""


def _int_param(v, what):
    if isinstance(v, complex):
        if v.imag != 0:
            raise _Keep
        v = v.real
    if v != int(v):
        raise _sf.NotCovered("a non-integer %s is not available in sagebrush yet" % what)
    return int(v)


def _below_cut(z):
    """A real z > 1 as z - 0i: on the cut (1, oo) of polylog, Sage gives the
    limit from below (dilog(2.0) = 2.467... - 2.177...*I)."""
    return complex(z, -0.0) if isinstance(z, float) and z > 1 else z


def _bernoulli_even(J):
    """B_2, B_4, ..., B_2J as Fractions."""
    from fractions import Fraction
    from math import comb
    b = [Fraction(1)]
    for m in range(1, 2 * J + 1):
        b.append(-sum(comb(m + 1, k) * b[k] for k in range(m)) / (m + 1))
    return [b[2 * j] for j in range(1, J + 1)]


_EM_B = None


def _expm1(z):
    """e^z - 1 without cancellation for small z, real or complex."""
    if not isinstance(z, complex):
        return _m.expm1(z)
    if abs(z) < 1e-3:
        return z * (1 + z / 2 * (1 + z / 3 * (1 + z / 4 * (1 + z / 5))))
    return _cmath.exp(z) - 1


def _zeta_near0(s):
    """zeta(s) for |s| < 1e-3 (real or complex), by Euler-Maclaurin summation
    (DLMF 25.2.9) with N = 10 and 12 Bernoulli corrections, at s itself:
    _special's reflection through zeta(1 - s) loses s when |s| is tiny
    (1 - s rounds to 1; its error is about eps/|s|, harmless above 1e-3,
    as compared with mpmath).  With k^(-s) = 1 + expm1(-s log k), the integer
    parts of the sum, of N^(1-s)/(s - 1) and of N^(-s)/2 add up to exactly
    -1/2, and every other term is O(s): no cancellation.  The first
    neglected correction, about 2 |s| 24! / ((2 pi)^26 N^25), is below
    1e-22."""
    global _EM_B
    if _EM_B is None:
        _EM_B = [float(x) for x in _bernoulli_even(12)]
    N = 10
    e = [0.0] + [_expm1(-s * _m.log(k)) for k in range(1, N + 1)]
    # sum_(k<N) k^-s + N^(1-s)/(s-1) + N^-s/2 + 1/2
    t = sum(e[1:N]) - N * s / (1 - s) - N * e[N] / (1 - s) + e[N] / 2
    # B_2j/(2j)! s (s + 1) ... (s + 2j - 2) N^(-s-2j+1)
    poch, fact = s, 2.0
    for j, b in enumerate(_EM_B, 1):
        t += b / fact * poch * (1 + e[N]) / N ** (2 * j - 1)
        poch *= (s + 2 * j - 1) * (s + 2 * j)
        fact *= (2 * j + 1) * (2 * j + 2)
    return t - 0.5


def _is_npi(z):
    """Whether z (float or complex) is a nonpositive integer."""
    if isinstance(z, complex):
        if z.imag != 0:
            return False
        z = z.real
    return z <= 0 and z == int(z)


def _beta_complex(a, b):
    """B(a, b) = Gamma(a) (Gamma(b)/Gamma(a + b)) for complex a, b (DLMF
    5.12.1): 0 where only Gamma(a + b) has a pole (it is not divided by),
    and the quotient first, so B(1e-200(1 + i), 1e-200(1 - i)) = 1e200
    does not overflow on the way.  Where a gamma value itself overflows
    (B(90 + i, 90 - i)), NotImplementedError: exp of a sum of log Gammas
    would lose digits in proportion to their size (2e-13 there)."""
    if _is_npi(a) or _is_npi(b):
        raise _sf.PoleError("beta has a pole there")
    if _is_npi(a + b):
        return 0.0
    def g(z):
        # Gamma(z) = Gamma(1 + z)/z near 0, where exp(log Gamma(z)) would
        # turn log Gamma's absolute error (log Gamma is about -log z) into a
        # relative one (3.5e-14 at z = 1e-200(1 + i))
        return _sf.gamma(z + 1) / z if abs(z) < 0.5 else _sf.gamma(z)
    try:
        ga, gb, gs = g(a), g(b), g(a + b)
        r = ga * (gb / gs)
    except (OverflowError, _sf.NotCovered):
        # (_special's complex gamma refuses with NotCovered where |Gamma| leaves the doubles)
        ga = r = float("inf")
        gb = gs = 1.0
    if not all(_cmath.isfinite(v) and v != 0 for v in (ga, gb, gs, r)):
        raise _sf.NotCovered("beta%r: its gamma values leave the double range; not available in sagebrush yet" % ((a, b),))
    return r


def _special_raw(name, a):
    """name(*a) for Python floats or complexes, from _special."""
    if name == "gamma":
        return _sf.gamma(a[0])
    if name == "erf":
        return _sf.erf(a[0])
    if name == "psi":
        return _sf.psi(a[0]) if len(a) == 1 else _sf.polygamma(_int_param(a[0], "n"), a[1])
    if name == "log_gamma":
        return _sf.loggamma(a[0])
    if name == "zeta":
        if abs(a[0]) < 1e-3:
            return _zeta_near0(a[0])
        return _sf.zeta(a[0])
    if name == "hurwitz_zeta":
        if isinstance(a[1], complex):
            raise _sf.NotCovered("hurwitz_zeta at a complex a is not available in sagebrush yet")
        return _sf.hurwitz_zeta(a[0], a[1])
    if name == "beta":
        if any(isinstance(t, complex) for t in a):
            return _beta_complex(a[0], a[1])
        return _sf.beta(a[0], a[1])
    if name in ("erfc", "erfi", "exp_integral_e1"):
        return getattr(_sf, name)(a[0])
    if name == "dilog":
        return _sf.dilog(_below_cut(a[0]))
    if name == "erfinv":
        if isinstance(a[0], complex):
            raise _sf.NotCovered("erfinv at a complex argument is not available in sagebrush yet")
        v = _sf.erfinv(a[0])
        if v != v:
            raise _Keep     # no real value: Sage keeps erfinv(1.5)
        return v
    if name == "Ei":
        if isinstance(a[0], complex):
            raise _sf.NotCovered("Ei at a complex argument is not available in sagebrush yet")
        return _sf.exp_integral_ei(a[0])
    if name == "polylog":
        return _sf.polylog(_int_param(a[0], "s"), _below_cut(a[1]))
    if name == "lambert_w":
        return _sf.lambert_w(a[0]) if len(a) == 1 else _sf.lambert_w(a[1], _int_param(a[0], "k"))
    if name in ("elliptic_kc", "elliptic_ec"):
        m = a[0]
        if isinstance(m, complex) or m > 1:
            raise _sf.NotCovered("%s(m) for m > 1 or complex m is not available in sagebrush yet" % name)
        return (_sf.ellipk if name == "elliptic_kc" else _sf.ellipe)(m)
    raise _sf.NotCovered("%s is not evaluated numerically in sagebrush yet" % name)


class _UnsignedInfinity:
    """Sage's unsigned infinity (gamma at a pole given as a complex number)."""


class _AmbiguousPole(NotImplementedError):
    """A pole whose value in Sage depends on whether the argument is a real or
    a complex number, reached through a symbolic expression, where the
    engine keeps -1.0 + 0.0*I as the real -1.0: refused rather than guessed
    (Sage: gamma(-1.0 + 0.0*I) is Infinity, gamma(SR(-1.0)) NaN)."""


# the functions whose value at a pole, reached through a symbolic
# expression, Sage gives differently for real and complex arguments
# (gamma(SR(-1.0)) NaN, gamma(-1.0 + 0.0*I) Infinity; beta NaN or NaN + NaN*I);
# zeta's (Infinity), log_gamma's (NaN + NaN*I) and hurwitz_zeta's (+infinity)
# are the same both ways there
_KIND_POLES = ("gamma", "beta")


def _is_pole(name, a):
    """Whether the arguments a are a pole of name: _special's PoleError there
    is the function's own, not one met inside a transformation (zeta's
    reflection through zeta(1 - s) at a tiny s, say)."""
    x = a[-1]
    if name in ("gamma", "log_gamma") or name == "psi" and len(a) == 1:
        return _is_npi(x)
    if name == "beta":
        return _is_npi(a[0]) or _is_npi(a[1])
    if name in ("zeta", "hurwitz_zeta"):
        return a[0] == 1
    if name in ("exp_integral_e1", "Ei"):
        return x == 0
    if name in ("polylog", "elliptic_kc"):
        return x == 1
    return False


def _pole_value(name, a, cx):
    """What Sage gives at a pole of name (arguments a, cx: whether each was
    given as a complex number, None when that is unknown: through the
    engine), or _Keep."""
    if not _is_pole(name, a):
        raise _sf.NotCovered("%s%r: _special met a pole of an intermediate step; this point is not available in sagebrush yet" % (name, tuple(a)))
    x = a[-1]
    inf, nan = float("inf"), float("nan")
    if cx is None:
        if name in _KIND_POLES:
            raise _AmbiguousPole("%s(%s) is a pole where Sage's value depends on whether the argument is real or complex, which this expression no longer tells; evaluate %s at a RealNumber or ComplexNumber" % (name, ", ".join(map(repr, a)), name))
        # through an expression Sage gives these as for complex arguments
        cx = [name in ("zeta", "log_gamma")] * len(a)
    if name == "gamma":
        if cx[-1]:
            return _UnsignedInfinity
        return _m.copysign(inf, x) if x == 0 else nan
    if name == "zeta" and cx[0]:
        return _UnsignedInfinity
    if name == "beta":
        return complex(nan, nan) if any(cx) else nan
    if name == "psi" and len(a) == 1:
        return nan
    if name == "log_gamma":
        return inf if x == 0 and not cx[-1] else complex(nan, nan)
    if name in ("zeta", "hurwitz_zeta", "exp_integral_e1", "elliptic_kc"):
        return inf
    if name == "Ei":
        return -inf
    if name == "polylog":
        return complex(nan, nan)
    raise _Keep


def _special_value(name, a, kinds=True):
    """name(*a) at Python floats or complexes as Sage evaluates it: a float
    or complex (Sage's NaN or infinity at a pole); _Keep where Sage keeps
    the call; NotImplementedError (_special.NotCovered) where Sage has a
    value that Sagebrush does not compute.  kinds=False: the arguments come
    from the engine, which does not tell -1.0 + 0.0*I from -1.0, so a pole
    whose value depends on that raises _AmbiguousPole."""
    cx = [isinstance(t, complex) for t in a] if kinds else None
    a = [t.real if isinstance(t, complex) and t.imag == 0 else t for t in a]
    try:
        return _special_raw(name, a)
    except _sf.PoleError:
        return _pole_value(name, a, cx)
    except _sf.NotCovered:
        raise
    except (ValueError, TypeError, OverflowError):
        raise _Keep


def _sp(name, *args):
    """name(*args) for compiled expressions (fast_callable, plots): a float
    or complex, NaN where there is no value."""
    try:
        v = _special_value(name, [complex(t) if isinstance(t, complex) else float(t) for t in args])
    except (_Keep, NotImplementedError):
        return float("nan")
    return float("inf") if v is _UnsignedInfinity else v


def _gamma(x):
    return _sp("gamma", x)


def _num_pair(s):
    """(re, im) of a numeric serialized expression, from the engine."""
    re, im = _call("n", s)
    return float(re), float(im)


def _py_val(re, im):
    return complex(re, im) if im != 0 else re


def _encode_value(v):
    if v is _UnsignedInfinity:
        return "cu"
    if isinstance(v, complex):
        return _call("complex", repr(v.real), repr(v.imag))[0]
    return _call("float", repr(float(v)))[0]


def _complete_special(s):
    """s with each call of a special function at float arguments that Sage
    evaluates at once (gamma(2.5), zeta(2.5 + 1.0*I)) replaced by its value,
    repeatedly, so a call whose argument became a float that way is
    evaluated too (psi(gamma(2.5)))."""
    for _ in range(64):
        rules = []
        for c in _call("special_calls", s, "float"):
            op = _call("operator", c)
            name, args = op[0][4:], op[1:]
            try:
                v = _special_value(name, [_py_val(*_num_pair(t)) for t in args], kinds=False)
            except _AmbiguousPole:
                raise
            except (_Keep, NotImplementedError):
                continue
            rules += [c, _encode_value(v)]
        if not rules:
            break
        s = _call("subs", s, *rules)[0]
    return s


def _lower_special(s):
    """s with every special-function call without symbols replaced by its
    numerical value (for n(): the engine's own numerics stop at them)."""
    if not _SPECIAL_RE.search(s):
        return s
    rules = []
    for c in _call("special_calls", s, "const"):
        op = _call("operator", c)
        name, args = op[0][4:], op[1:]
        vals = [_py_val(*_num_pair(_lower_special(t))) for t in args]
        try:
            v = _special_value(name, vals, kinds=False)
        except _Keep:
            raise ValueError("cannot evaluate %s numerically" % _call("str", c)[0])
        rules += [c, _encode_value(v)]
    return _call("subs", s, *rules)[0] if rules else s


class _Math:
    pass


_M = _Math()
for _k in dir(_m):
    if not _k.startswith("_"):
        setattr(_M, _k, getattr(_m, _k))


def _sgn(v):
    return (v > 0) - (v < 0)


def _undefined(name):
    raise ValueError("cannot evaluate %s numerically" % name)


_FAST_GLOBALS = {"_m": _M, "_gamma": _gamma, "_sp": _sp, "_sgn": _sgn, "_undefined": _undefined,
                 "__builtins__": {"abs": abs, "complex": complex, "float": float}}


# ------------------------------------------------------------------ constructors

_LATEX_NAMES = {}   # symbol name -> LaTeX (var('th', latex_name=r'\theta'))
_LATEX_SYM = {}     # symbol name -> its LaTeX without a latex_name


# ---------------------------------------------------------------- assumptions

_ASSUMPTIONS = []   # relations (x > 0) and _Feature(n, 'integer')


class _Feature:
    """An assumption 'n is integer' made by assume(n, 'integer')."""

    def __init__(self, v, kind):
        self._v, self._kind = v, kind

    def __repr__(self):
        return "%s is %s" % (self._v, self._kind)

    def __eq__(self, o):
        return isinstance(o, _Feature) and str(o._v) == str(self._v) and o._kind == self._kind

    def __hash__(self):
        return hash((str(self._v), self._kind))


def assume(*args):
    """Assume relations (x > 0) or properties (assume(n, 'integer');
    'integer', 'real', 'positive', 'even', 'odd', ...); used by abs,
    sqrt simplification, bool of relations, sin(n*pi) and solve.

    EXAMPLES::

        sage: assume(x > 0); bool(sqrt(x^2) == x), abs(x)
        (True, x)
        sage: assumptions()
        [x > 0]
        sage: forget()
    """
    args = list(args)
    i = 0
    while i < len(args):
        a = args[i]
        if isinstance(a, (list, tuple)):
            assume(*a)
        elif i + 1 < len(args) and isinstance(args[i + 1], str):
            f = _Feature(a, args[i + 1])
            if f not in _ASSUMPTIONS:
                _ASSUMPTIONS.append(f)
            i += 1
        elif isinstance(a, Expression) and a.is_relational():
            if not any(isinstance(r, Expression) and str(r) == str(a) for r in _ASSUMPTIONS):
                _ASSUMPTIONS.append(a)
        elif a is True or a is False:
            pass
        else:
            raise TypeError("assume(relation) or assume(variable, property)")
        i += 1


def forget(*args):
    """Forget the given assumptions, or all of them.

    EXAMPLES::

        sage: assume(x > 0); forget(x > 0); assumptions()
        []
    """
    if not args:
        del _ASSUMPTIONS[:]
        return
    args = list(args)
    i = 0
    while i < len(args):
        a = args[i]
        if i + 1 < len(args) and isinstance(args[i + 1], str):
            f = _Feature(a, args[i + 1])
            if f in _ASSUMPTIONS:
                _ASSUMPTIONS.remove(f)
            i += 1
        else:
            for r in list(_ASSUMPTIONS):
                if isinstance(r, Expression) and str(r) == str(a):
                    _ASSUMPTIONS.remove(r)
        i += 1


def assumptions(*args):
    """The current assumptions (about the given variables).

    EXAMPLES::

        sage: assume(x > 0, x < 1); assumptions()
        [x > 0, x < 1]
        sage: forget()
    """
    if not args:
        return list(_ASSUMPTIONS)
    names = {str(a) for a in args}
    out = []
    for r in _ASSUMPTIONS:
        vs = {str(r._v)} if isinstance(r, _Feature) else set(r._names())
        if vs & names:
            out.append(r)
    return out


class assuming:
    """A context in which some assumptions hold: with assuming(x > 0): ...

    EXAMPLES::

        sage: with assuming(x > 0):
        ....:     abs(x)
        x
        sage: assumptions()
        []
    """

    def __init__(self, *args, **kw):
        self._args = args
        self._replace = kw.get("replace", False)

    def __enter__(self):
        self._saved = list(_ASSUMPTIONS)
        if self._replace:
            del _ASSUMPTIONS[:]
        assume(*self._args)

    def __exit__(self, *exc):
        _ASSUMPTIONS[:] = self._saved
        return False


def _assume_on(sol, names):
    """A family (or a solution with conditions) under the assumptions on
    the solved variable: each becomes a condition on the solution's value
    (assume(x > 0); sin(x) == 0: x == pi*n1 if pi*n1 > 0); 'integer' and
    the like on such a solution are refused (the review of solve's
    CSOL-F9: the whole family came back).  None if a condition fails."""
    if len(sol) != 1 or not isinstance(sol[0], Solution):
        return sol
    s = sol[0]
    try:
        if s.lhs()._op()[0] != "symbol":
            return sol
    except Exception:
        return sol
    x, v = str(s.lhs()), s.rhs()
    # a numerical value is checked by _satisfies; a symbolic one (x == a,
    # x == r1, a family) gets the assumptions as conditions (CSOL-F9)
    if not v.variables():
        return sol
    extra = []
    for r in _ASSUMPTIONS:
        if isinstance(r, _Feature):
            if str(r._v) != x:
                continue
            if r._kind == "real":
                extra.append(_one("fun", "imag_part", v._s) == 0)
            elif r._kind == "positive":
                extra.append(v > 0)
            elif r._kind == "negative":
                extra.append(v < 0)
            else:
                raise NotImplementedError("solve: the assumption that %s is %s on the symbolic solution %s" % (x, r._kind, s))
        elif isinstance(r, Expression) and x in r._names():
            extra.append(r.subs({s.lhs(): v}))
    if not extra:
        return sol
    keep = list(s._conds)
    for c in extra:
        if not c.variables():
            verdict = _decide(c)
            if verdict is True:
                continue
            if verdict is False:
                return None
        keep.append(c)
    return [Solution(s._s, keep, s._params)]


def _satisfies(sol):
    """Whether a solution [x == a, ...] is compatible with the assumptions
    (the relations that become numerical after substituting it)."""
    sub = {}
    for eq in sol:
        try:
            if eq.lhs()._op()[0] != "symbol":
                continue  # 0 == f: a factor whose roots were not found
            sub[eq.lhs()] = eq.rhs()
        except Exception:
            return True
    for r in _ASSUMPTIONS:
        if isinstance(r, _Feature):
            v = next((w for k, w in sub.items() if str(k) == str(r._v)), None)
            if v is None or v.variables():
                continue
            if r._kind in ("real", "integer", "rational", "even", "odd", "positive", "negative"):
                im = v.imag()
                if _call("is_zero", im._s)[0] != "1" and _const_sign(im) not in (None, 0):
                    return False  # certainly not real
            if r._kind in ("integer", "even", "odd"):
                fl = floor(v)
                if fl.is_numeric() and _const_sign(v - fl) == 1:
                    return False  # certainly not an integer
                q = _py_number(v._s)
                if r._kind in ("even", "odd") and isinstance(q, int):
                    if (q % 2 == 0) != (r._kind == "even"):
                        return False  # the wrong parity (the systematic review's R2-SYMALG-F2)
            if r._kind in ("positive", "negative"):
                sg = _const_sign(v)
                if sg is not None and sg != (1 if r._kind == "positive" else -1):
                    return False
            if r._kind in ("rational", "integer", "even", "odd") and not _is_rational_number(v):
                if _certainly_irrational(v):
                    return False
            continue
        if not isinstance(r, Expression):
            continue
        rr = r.subs(sub)
        if rr.variables():
            continue
        # decided by the engine (bool() of a relation is no proof, and it
        # raised in pyjs, so assume(x > 0) kept x == -1 there)
        if _decide(rr) is False:
            return False
    return True


def _system_assume(sols, names):
    """The solutions [x == ..., y == ..., conditions...] of a system under
    the assumptions, with the whole assignment substituted into each (x > y
    is decided by x and y together, which neither one-variable step can do:
    assume(x > y); [x^2 == 1, y == -x] kept x == -1, y == 1, the review's
    SOLVE2-F6): dropped where one is false, undecided ones kept as
    conditions; a feature (x positive) of a symbolic value becomes a
    condition as for one equation."""
    out = []
    for sol in sols:
        n = len(names)
        assign, extra = list(sol[:n]), list(sol[n:])
        sub = {}
        for s in assign:
            if s._op()[0] == "rel:Eq" and s.lhs()._op()[0] == "symbol":
                sub[str(s.lhs())] = s.rhs()
        if not _satisfies(assign):
            continue
        conds = []
        for r in _ASSUMPTIONS:
            if isinstance(r, _Feature):
                v = sub.get(str(r._v))
                if v is None or not v.variables():
                    continue  # numerical values: _satisfies
                if r._kind == "real":
                    conds.append(_one("fun", "imag_part", v._s) == 0)
                elif r._kind == "positive":
                    conds.append(v > 0)
                elif r._kind == "negative":
                    conds.append(v < 0)
                else:
                    raise NotImplementedError("solve: the assumption that %s is %s on the symbolic solution %s == %s" % (r._v, r._kind, r._v, v))
            elif isinstance(r, Expression) and set(r._names()) & set(sub):
                conds.append(r.subs({Expression(_sym_s(k)): w for k, w in sub.items()}))
        keep, ok = [], True
        for c in conds:
            if not c.variables():
                verdict = _decide(c)
                if verdict is True:
                    continue
                if verdict is False:
                    ok = False
                    break
            if not any(str(c) == str(e) for e in keep + extra):
                keep.append(c)
        if ok:
            out.append(assign + extra + keep)
    return out


def _is_rational_number(v):
    q = _py_number(v._s)
    return q is not None and not isinstance(q, float) and not isinstance(q, complex)


def _certainly_irrational(v):
    """Whether the constant v is an algebraic number of degree > 1 (sqrt(2)):
    exactly, through QQbar; False when that is not established."""
    try:
        import _sage_qqbar
        a = _sage_qqbar._from_expr(v)
        return a is not None and a._gen is not None and a.degree() > 1
    except Exception:
        return False


def _integer_multiple_of_pi(arg):
    """k when arg = k*pi with k an integer combination of products of
    integer-assumed symbols, else None."""
    q = (arg / pi).expand()
    names = q._names()
    ints = {n for n in names if _features(n) & {"integer", "even", "odd"}}
    if not names or set(names) != ints:
        return None
    for t in (q.operands() if q._op()[0] == "add" else [q]):
        for f in (t.operands() if t._op()[0] == "mul" else [t]):
            tag = f._op()[0]
            if tag == "symbol":
                continue
            if tag == "pow" and f.operands()[0]._op()[0] == "symbol":
                try:
                    if int(f.operands()[1]) > 0:
                        continue
                except (TypeError, ValueError):
                    pass
                return None
            v = _py_number(f._s)
            if v is None or isinstance(v, float) or getattr(v, "denominator", 1) != 1:
                return None
    return q


def _features(v):
    return {r._kind for r in _ASSUMPTIONS if isinstance(r, _Feature) and str(r._v) == str(v)}


def _sign_of(e):
    """+1 (or 0 allowed) / -1 when the assumptions make e positive /
    negative (e a symbol, or a product/power of such), else None."""
    if not _ASSUMPTIONS:
        return None
    t = e._op()[0]
    if t == "symbol":
        name = str(e)
        if "positive" in _features(name):
            return 1
        for r in _ASSUMPTIONS:
            if not isinstance(r, Expression):
                continue
            k = r._op()[0][4:]
            a, b = r.lhs(), r.rhs()
            sym_a, sym_b = str(a) == name, str(b) == name
            # the bound's certified sign (float(-10^-400) is -0.0, which is
            # >= 0: x > -10^-400 made x positive, the systematic review's
            # R2-SYMALG-F2)
            try:
                if sym_a and b.is_numeric():
                    c = _const_sign(b)
                    if k in ("Gt", "Ge") and c in (0, 1):
                        return 1
                    if k in ("Lt", "Le") and c in (0, -1):
                        return -1
                if sym_b and a.is_numeric():
                    c = _const_sign(a)
                    if k in ("Lt", "Le") and c in (0, 1):
                        return 1
                    if k in ("Gt", "Ge") and c in (0, -1):
                        return -1
            except (TypeError, ValueError):
                pass
        return None
    if t == "mul":
        sg = 1
        for f in e.operands():
            if f.is_numeric():
                c = _const_sign(f)
                if c is None or c == 0:
                    return None
                sg *= c
                continue
            s1 = _sign_of(f)
            if s1 is None:
                return None
            sg *= s1
        return sg
    if t == "pow":
        b, x = e.operands()
        sb = _sign_of(b)
        if sb is None:
            return None
        if sb > 0:
            # b^x > 0 needs a real exponent (x^I has modulus 1, not x^I)
            return 1 if _is_real(x) else None
        # a negative base: only an integer exponent has a sign (int(1/2) is
        # 0: sqrt(x) for x < 0 counted as positive, abs(sqrt(-1)) was I)
        k = _py_number(x._s)
        if isinstance(k, int) or (getattr(k, "denominator", None) == 1 and not isinstance(k, float)):
            return 1 if int(k) % 2 == 0 else -1
        return None
    if e.is_numeric():
        c = _const_sign(e)
        if c is not None:
            return 1 if c >= 0 else -1
    return None



def _abs_assumed(u):
    """|u| as the assumptions give it: u or -u when u's sign is known, abs(u)
    when u is a symbol assumed real, else None (|u| is not decided)."""
    sg = _sign_of(u)
    if sg is not None:
        return u if sg >= 0 else -u
    if u.is_symbol() and _assumed_real(str(u)):
        return _one("fun", "abs", u._s)
    return None


def _assume_simplify(e):
    """The assumptions' simplifications, applied through e (Maxima's simplify
    under assume(), as Sage's simplify() and simplify_full() do):
    sqrt(u^n) for even n is |u|^(n/2), with |u| = u or -u when u's sign is
    known and abs(u) when u is only known to be real; sqrt(u^n) for odd n
    with u > 0 is u^(n/2); abs(u) is u or -u when u's sign is known.
    sqrt(x^2).simplify() was sqrt(x^2) under assume(x > 0): a wrong answer
    beside Sage's x (the kernel lane's first item, Nov 1)."""
    op = e._op()
    tag = op[0]
    if tag in ("symbol",) or len(op) == 1 or e.is_numeric():
        return e
    kids = [_assume_simplify(Expression(t)) for t in op[1:]]
    if tag == "pow" and str(kids[1]) == "1/2" and kids[0]._op()[0] == "pow":
        u, n = kids[0].operands()
        if str(n).isdigit():
            n = int(str(n))
            if n % 2 == 0:
                a = _abs_assumed(u)
                if a is not None:
                    return a ** (n // 2)
            elif _sign_of(u) == 1:
                return u ** (kids[1] * n)
    if tag == "add":
        out = kids[0]
        for k in kids[1:]:
            out = out + k
        return out
    if tag == "mul":
        out = kids[0]
        for k in kids[1:]:
            out = out * k
        return out
    if tag == "pow":
        return kids[0] ** kids[1]
    if tag == "fun:abs":
        return abs(kids[0])
    if tag.startswith("rel:"):
        return e.operator()(kids[0], kids[1])
    if tag.startswith("fun:"):
        return e.operator()(*kids)
    return e

def _const_sign(e):
    """The certified sign of a real constant (1, 0, -1), or None."""
    r = _call("const_sign", e._s)[0]
    return int(r) if r else None


def _is_real(e):
    """Whether e is certainly real: a real constant, or a symbol assumed
    real (or integer, positive, ..., or bounded by a relation)."""
    if e.is_numeric():
        try:
            return _call("is_zero", e.imag()._s)[0] == "1"
        except Exception:
            return False
    if e._op()[0] == "symbol":
        name = str(e)
        if _features(name) & {"real", "integer", "rational", "even", "odd", "positive", "negative"}:
            return True
        # a relation makes real its two sides, not each symbol in them (a + b
        # > 0 says nothing of a alone)
        def real_side(r):
            if not (isinstance(r, Expression) and r._op()[0][4:] in ("Lt", "Le", "Gt", "Ge")):
                return False
            lhs, rhs = r.lhs(), r.rhs()
            return (str(lhs) == name and not rhs.variables() and _is_real(rhs)) or (str(rhs) == name and not lhs.variables() and _is_real(lhs))
        return any(real_side(r) for r in _ASSUMPTIONS)
    return False


def _assume_rewrite(e):
    """e simplified with the assumptions: sqrt(x^2) = x and abs(x) = x for
    x > 0 (products and powers of such too)."""
    t = e._op()[0]
    if t in ("symbol", "rational", "integer", "constant") or not e.operands():
        return e
    ops = [_assume_rewrite(a) for a in e.operands()]
    if t == "add":
        return sum(ops, Expression(_call("parse", "0")[0]))
    if t == "mul":
        r = _expr(1)
        for a in ops:
            r = r * a
        return r
    if t == "pow":
        b, x = ops
        try:
            k = _py_number(x._s)
        except Exception:
            k = None
        if k is not None and not isinstance(k, float) and getattr(k, "denominator", 1) == 2:
            # (b)^(m/2): b = c^2 with c of known sign
            bt = b._op()[0]
            if bt == "pow":
                c, y = b.operands()
                try:
                    yk = int(y)
                except (TypeError, ValueError):
                    yk = None
                if yk is not None and yk % 2 == 0 and _sign_of(c) == 1:
                    return c ** (yk // 2 * 2 * k)
        return b ** x
    if t == "fun:abs":
        sg = _sign_of(ops[0])
        if sg is not None:
            return ops[0] if sg >= 0 else -ops[0]
    return e


def var(*names, **kw):
    """var('x y') or var('x', 'y'): symbolic variables, also defined in __main__.

    EXAMPLES::

        sage: var('a b c')
        (a, b, c)
        sage: a + b + c
        a + b + c
    """
    if len(names) == 1 and isinstance(names[0], (list, tuple)):
        names = tuple(names[0])
    if len(names) == 1 and isinstance(names[0], str):
        names = names[0].replace(",", " ").split()
    for n in names:
        if not n.isidentifier():
            raise ValueError("The name \"%s\" is not a valid Python identifier." % n)
    vs = tuple(Expression(_sym_s(n)) for n in names)
    if kw.get("latex_name") is not None:
        for n in names:
            _LATEX_NAMES[n] = str(kw["latex_name"])
    if kw.get("domain") in ("positive", "integer", "real", "complex"):
        for v in vs:
            assume(v, kw["domain"])
    import sys
    main = sys.modules.get("__main__")
    if main is not None:
        for n, v in zip(names, vs):
            setattr(main, n, v)
    return vs[0] if len(vs) == 1 else vs


def _numeric_arg(a):
    return isinstance(a, float) or (isinstance(a, complex) and not isinstance(a, bool))


_RealNumber = _RealBig = None


def _rr_args(args):
    """0 when no argument is an element of RR (a RealNumber) or one is
    complex, 2 when one is past the doubles (an _RealBig), else 1 (a loop,
    with isinstance tests only: the normal path of every function call goes
    through here)."""
    global _RealNumber, _RealBig
    if _RealNumber is None:
        from _sage_lang import RealNumber as _RealNumber, _RealBig
    k = 0
    for a in args:
        if isinstance(a, _RealNumber):
            if isinstance(a, _RealBig):
                k = 2
            elif k == 0:
                k = 1
        elif isinstance(a, complex):
            return 0
    return k


def _rr_exact(r, fl):
    """Whether the double r = f(*fl) is RR's value: r is a normal double or
    NaN, or an argument is a zero, an infinity or NaN (where the functions
    are exact).  Otherwise (an overflow, an underflow, a subnormal value)
    RR's value is past the doubles."""
    return r != r or _NORMAL_MIN < abs(r) < _INF or any(t == 0 or t != t or t in (_INF, -_INF) for t in fl)


_NORMAL_MIN, _INF = 2.2250738585072014e-308, float("inf")
_RR_WIDE = None


def _rr_wide(v):
    """v in a 117-bit real field: an identity (arccot(x) = arctan(1/x)) is
    evaluated there and rounded once to 53 bits."""
    global _RR_WIDE
    if _RR_WIDE is None:
        import _sage_real
        _RR_WIDE = _sage_real.RealField_(117, "RNDN")
    return _RR_WIDE(v)


# RR's functions past the doubles, in the 53-bit MP field (lib/_sage_real.py:
# correctly rounded), or by an identity at 117 bits rounded once
_RR_MP_FUNCTIONS = {n: (lambda v, n=n: getattr(v, n)()) for n in (
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
    "arcsinh", "arccosh", "arctanh", "exp", "log")}
_RR_MP_FUNCTIONS.update({
    "arccot": lambda v: (1 / _rr_wide(v)).arctan(),
    "arcsec": lambda v: (1 / _rr_wide(v)).arccos(),
    "arccsc": lambda v: (1 / _rr_wide(v)).arcsin(),
    "coth": lambda v: 1 / _rr_wide(v).tanh(),
    "sech": lambda v: 1 / _rr_wide(v).cosh(),
    "csch": lambda v: 1 / _rr_wide(v).sinh()})


def _rr_function(name, args, numeric):
    """name(*args) in RR where the double result is not RR's value (an
    argument or the value is past the doubles): computed in the MP field,
    or NotImplementedError, never a double's infinity or zero."""
    import _sage_lang
    if len(args) == 1:
        x = args[0]
        if name in ("sgn", "heaviside"):
            return numeric(x)  # (comparisons only, exact)
        if name in ("floor", "ceil"):
            return getattr(x, name)()
        if name == "log" and x < 0:
            # log|x| + pi I: log|x| is a double for every element of RR
            from _sage_matrix import ComplexNumber
            return ComplexNumber(float(_sage_lang._rr_from_mp(_sage_lang._rr_operand(-x).log())), _m.pi)
        g = _RR_MP_FUNCTIONS.get(name)
        if g is not None and x == x:
            v = g(_sage_lang._rr_operand(x))
            # (outside the real domain the value is complex, as in Sage)
            if v._special != "nan":
                return _sage_lang._rr_from_mp(v)
    raise NotImplementedError("%s(%s): the value in RR, past the double range, is not available in sagebrush yet"
                              % (name, ", ".join(map(str, args))))


def _function(name, numeric=None, cnumeric=None):
    """A Sage function: numerical on floats, exact or symbolic otherwise
    (sin(0) = 0, sin(pi/6) = 1/2, sin(1) stays sin(1))."""
    def f(*args, **kw):
        if args and all(_numeric_arg(a) or isinstance(a, int) for a in args) and any(_numeric_arg(a) for a in args):
            if numeric is not None and not any(isinstance(a, complex) for a in args):
                # RR's elements past the doubles (an _RealBig), and values
                # past them, are computed in the MP field
                rr = _rr_args(args)
                if rr == 2:
                    return _rr_function(name, args, numeric)
                fl = [float(a) for a in args]
                try:
                    r = numeric(*fl)
                except OverflowError:
                    if rr:
                        return _rr_function(name, args, numeric)
                except ValueError:
                    pass
                else:
                    if not isinstance(r, float):
                        return r
                    if rr and not _rr_exact(r, fl) and name not in ("sgn", "heaviside"):
                        return _rr_function(name, args, numeric)
                    return _RealNumber(r)
            r = _one("fun", name, *[_to_s(a) for a in args]).n()
            return r
        try:
            ss = [_expr(a)._s for a in args]
        except TypeError:
            h = getattr(args[0], name, None) if args else None
            if h is not None:
                return h()
            raise
        r = Expression(_call("fun", name, *ss)[0])
        if _ASSUMPTIONS and name in ("sin", "cos", "tan") and len(args) == 1 and r._op()[0] == "fun:" + name:
            k = _integer_multiple_of_pi(_expr(args[0]))
            if k is not None:
                return _expr(0) if name != "cos" else (-1) ** k
        if all(not isinstance(a, Expression) and not _is_poly(a) for a in args):
            v = _py_number(r._s)
            if v is not None:
                return v
        return r
    f.__name__ = name
    return f



def _rr_special_exact(name, v, fl):
    """Whether the double v = name(*fl) is RR's value: v is a normal double
    or NaN, an argument is a zero, an infinity or NaN, v is the infinity of
    a pole, or a trivial zero of zeta.  Otherwise (an overflow, an
    underflow, a subnormal value) RR's value is past the doubles."""
    if _rr_exact(v, fl):
        return True
    if v in (_INF, -_INF):
        return _is_pole(name, fl) or (name == "erfinv" and abs(fl[0]) == 1)
    return v == 0 and name in ("zeta", "hurwitz_zeta") and fl[0] < 0 and fl[0] % 2 == 0 \
        and (name == "zeta" or fl[1] == 1)


def _rr_special(name, args):
    """name(*args) in RR past the doubles: gamma and log_gamma in the MP
    field; the other special functions raise NotImplementedError (never a
    double's overflowed infinity or underflowed zero)."""
    import _sage_lang
    if name in ("gamma", "log_gamma") and len(args) == 1 and not (name == "log_gamma" and args[0] < 0):
        return _sage_lang._rr_from_mp(getattr(_sage_lang._rr_operand(args[0]), name)())
    raise NotImplementedError("%s(%s): the value in RR, past the double range, is not available in sagebrush yet"
                              % (name, ", ".join(map(str, args))))


def _special_function(name, nargs=(1,)):
    """A Sage special function (engine/sym special.rs for exact values and
    derivatives, lib/_special.py for numerical ones): a number at Python
    floats and complexes where Sage evaluates there, else an expression
    (whose float calls the engine leaves to _complete_special)."""
    def f(*args):
        if len(args) not in nargs:
            raise TypeError("%s() takes %s arguments (%d given)" % (name, " or ".join(map(str, nargs)), len(args)))
        if all(_numeric_arg(a) or isinstance(a, int) for a in args) and any(_numeric_arg(a) for a in args) \
                and not (name == "psi" and len(args) == 2) and name != "zetaderiv":
            rr = _rr_args(args)
            if rr == 2:
                return _rr_special(name, args)
            fl = [complex(a) if isinstance(a, complex) else float(a) for a in args]
            try:
                v = _special_value(name, fl)
            except _Keep:
                v = None
            if rr and type(v) is float and not _NORMAL_MIN < abs(v) < _INF and not _rr_special_exact(name, v, fl):
                return _rr_special(name, args)
            if v is _UnsignedInfinity:
                return Expression("cu")
            if v is not None:
                if isinstance(v, complex):
                    from _sage_matrix import ComplexNumber
                    return ComplexNumber(v.real, v.imag)
                from _sage_lang import RealNumber
                return RealNumber(v)
        r = Expression(_call("fun", name, *[_expr(a)._s for a in args])[0])
        if all(not isinstance(a, Expression) and not _is_poly(a) for a in args):
            v = _py_number(r._s)
            if v is not None:
                return v
        return r
    f.__name__ = name
    return f

# The docstrings of the elementary functions (made by one factory, so they
# have no def to hold them); their examples are doctests like any others.
_FUNCTION_DOCS = {
    'sin': """The sine.

    EXAMPLES::

        sage: sin(pi/6)
        1/2
        sage: sin(x).diff(x)
        cos(x)
        sage: sin(1.0)
        0.841470984807897""",
    'cos': """The cosine.

    EXAMPLES::

        sage: cos(pi/3)
        1/2
        sage: cos(x).integrate(x)
        sin(x)
        sage: cos(0)
        1""",
    'tan': """The tangent.

    EXAMPLES::

        sage: tan(pi/4)
        1
        sage: tan(x).diff(x)
        tan(x)^2 + 1""",
    'cot': """The cotangent.

    EXAMPLES::

        sage: cot(pi/4)
        1
        sage: cot(x).diff(x)
        -cot(x)^2 - 1""",
    'sec': """The secant.

    EXAMPLES::

        sage: sec(pi/3)
        2
        sage: sec(x).diff(x)
        sec(x)*tan(x)""",
    'csc': """The cosecant.

    EXAMPLES::

        sage: csc(pi/6)
        2
        sage: csc(x).diff(x)
        -cot(x)*csc(x)""",
    'arcsin': """The inverse sine (also asin).

    EXAMPLES::

        sage: arcsin(1/2)
        1/6*pi
        sage: arcsin(x).diff(x)
        1/sqrt(-x^2 + 1)""",
    'arccos': """The inverse cosine (also acos).

    EXAMPLES::

        sage: arccos(1/2)
        1/3*pi
        sage: arccos(x).diff(x)
        -1/sqrt(-x^2 + 1)""",
    'arctan': """The inverse tangent (also atan).

    EXAMPLES::

        sage: arctan(1)
        1/4*pi
        sage: arctan(x).diff(x)
        1/(x^2 + 1)""",
    'arccot': """The inverse cotangent (also acot).

    EXAMPLES::

        sage: arccot(1)
        1/4*pi
        sage: arccot(x).diff(x)
        -1/(x^2 + 1)""",
    'arcsec': """The inverse secant (also asec).

    EXAMPLES::

        sage: arcsec(2)
        arcsec(2)
        sage: arcsec(x).diff(x)  # sagebrush only (Sage's 1/(sqrt(x^2 - 1)*x) has the wrong sign for x < -1)
        1/(sqrt(-1/x^2 + 1)*x^2)""",
    'arccsc': """The inverse cosecant (also acsc).

    EXAMPLES::

        sage: arccsc(2)
        arccsc(2)
        sage: arccsc(x).diff(x)  # sagebrush only (Sage's -1/(sqrt(x^2 - 1)*x) has the wrong sign for x < -1)
        -1/(sqrt(-1/x^2 + 1)*x^2)""",
    'arctan2': """arctan2(y, x): the angle of the point (x, y) (also atan2).

    EXAMPLES::

        sage: arctan2(1, 1)
        1/4*pi
        sage: arctan2(1.0, 2.0)
        0.463647609000806""",
    'sinh': """The hyperbolic sine.

    EXAMPLES::

        sage: sinh(0)
        0
        sage: sinh(x).diff(x)
        cosh(x)""",
    'cosh': """The hyperbolic cosine.

    EXAMPLES::

        sage: cosh(0)
        1
        sage: cosh(x).diff(x)
        sinh(x)""",
    'tanh': """The hyperbolic tangent.

    EXAMPLES::

        sage: tanh(0)
        0
        sage: tanh(x).diff(x)
        -tanh(x)^2 + 1""",
    'coth': """The hyperbolic cotangent.

    EXAMPLES::

        sage: coth(1.0)
        1.31303528549933
        sage: coth(x).diff(x)
        -1/sinh(x)^2""",
    'sech': """The hyperbolic secant.

    EXAMPLES::

        sage: sech(0)
        1
        sage: sech(x).diff(x)
        -sech(x)*tanh(x)""",
    'csch': """The hyperbolic cosecant.

    EXAMPLES::

        sage: csch(1.0)
        0.850918128239322
        sage: csch(x).diff(x)
        -coth(x)*csch(x)""",
    'arcsinh': """The inverse hyperbolic sine (also asinh).

    EXAMPLES::

        sage: arcsinh(0)
        0
        sage: arcsinh(x).diff(x)
        1/sqrt(x^2 + 1)""",
    'arccosh': """The inverse hyperbolic cosine (also acosh).

    EXAMPLES::

        sage: arccosh(1)
        0
        sage: arccosh(x).diff(x)
        1/(sqrt(x + 1)*sqrt(x - 1))""",
    'arctanh': """The inverse hyperbolic tangent (also atanh).

    EXAMPLES::

        sage: arctanh(0)
        0
        sage: arctanh(x).diff(x)
        -1/(x^2 - 1)""",
    'exp': """The exponential function.

    EXAMPLES::

        sage: exp(0)
        1
        sage: exp(1)
        e
        sage: exp(x).diff(x)
        e^x
        sage: exp(1.0)
        2.71828182845905""",
    'log': """The natural logarithm (also ln); log(x, b) = log(x)/log(b).

    EXAMPLES::

        sage: log(1)
        0
        sage: log(e)
        1
        sage: log(x).diff(x)
        1/x
        sage: log(8, 2)
        3
        sage: log(2.0)
        0.693147180559945""",
    'floor': """The floor (the largest integer at most x).

    EXAMPLES::

        sage: floor(7/2)
        3
        sage: floor(-2.5)
        -3
        sage: floor(pi)
        3""",
    'ceil': """The ceiling (the least integer at least x; also ceiling).

    EXAMPLES::

        sage: ceil(7/2)
        4
        sage: ceil(-2.5)
        -2
        sage: ceil(pi)
        4""",
    'gamma': """The gamma function: exact at integers and half-integers,
    numerical at floats (real or complex; lib/_special.py), NaN or an
    infinity at its poles as in Sage.

    EXAMPLES::

        sage: gamma(5), gamma(1/2), gamma(0)
        (24, sqrt(pi), Infinity)
        sage: gamma(2.5), gamma(-1.0)
        (1.32934038817914, NaN)
        sage: gamma(x).diff(x)
        gamma(x)*psi(x)
        sage: gamma(CC(-1)), gamma(RR(-1))
        (Infinity, NaN)
        sage: gamma(-1.0 + 0.0*I)  # the engine keeps -1.0 + 0.0*I as -1.0  # sagebrush only
        Traceback (most recent call last):
        ...
        _sage_expr._AmbiguousPole: gamma(-1.0) is a pole where Sage's value depends on whether the argument is real or complex, which this expression no longer tells; evaluate gamma at a RealNumber or ComplexNumber""",
    'erf': """The error function (numerical values from lib/_special.py, real
    or complex).

    EXAMPLES::

        sage: erf(0), erf(oo)
        (0, 1)
        sage: erf(1.0)
        0.842700792949715
        sage: erf(x).diff(x)
        2*e^(-x^2)/sqrt(pi)""",
    'psi': """psi(x), the digamma function Gamma'(x)/Gamma(x), and psi(n, x), its
    n-th derivative (the polygamma function): exact at integers and
    half-integers, numerical (lib/_special.py) at floats for psi(x) and
    by n() for psi(n, x), as in Sage.

    EXAMPLES::

        sage: psi(1), psi(5), psi(1/3)
        (-euler_gamma, -euler_gamma + 25/12, psi(1/3))
        sage: psi(1, 1), psi(2, 1), psi(3, 1/2)
        (1/6*pi^2, -2*zeta(3), pi^4)
        sage: psi(2.5), psi(1, 2.5).n()
        (0.703156640645243, 0.490357756100235)
        sage: psi(x).diff(x), psi(1, x).diff(x)
        (psi(1, x), psi(2, x))
        sage: psi((-2^64 + 1)/2)  # not computed beyond |x| = 600  # sagebrush only
        psi(-18446744073709551615/2)""",
    'log_gamma': """The principal branch of log Gamma(x) (as Sage's log_gamma: complex
    for negative x).

    EXAMPLES::

        sage: log_gamma(1), log_gamma(5), log_gamma(0)
        (0, log(24), +Infinity)
        sage: log_gamma(10.0)
        12.8018274800815
        sage: log_gamma(x).diff(x)
        psi(x)
        sage: log_gamma(-3/2).n(100)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: log_gamma of a negative real at more than 53 bits is not available in sagebrush yet""",
    'zeta': """The Riemann zeta function: exact at even positive and nonpositive
    integers, numerical (lib/_special.py) at floats, real or complex.

    EXAMPLES::

        sage: zeta(2), zeta(4), zeta(0), zeta(-1), zeta(3)
        (1/6*pi^2, 1/90*pi^4, -1/2, -1/12, zeta(3))
        sage: zeta(3).n()
        1.20205690315959
        sage: zeta(x).diff(x)
        zetaderiv(1, x)
        sage: zeta(-2^63)  # not computed beyond |s| = 600  # sagebrush only
        zeta(-9223372036854775808)""",
    'zetaderiv': """zetaderiv(n, s), the n-th derivative of the Riemann zeta function
    (symbolic only: its numerical values are not available in sagebrush yet).

    EXAMPLES::

        sage: zeta(2*x).diff(x)
        2*zetaderiv(1, 2*x)""",
    'hurwitz_zeta': """The Hurwitz zeta function zeta(s, a) = sum_(k >= 0) (k + a)^(-s): exact
    at integers s >= 2 for integer and half-integer a, and at integers
    s <= 0 (Bernoulli polynomials); numerical for real a > 0.

    EXAMPLES::

        sage: hurwitz_zeta(2, 1/2), hurwitz_zeta(3, 2), hurwitz_zeta(-1, 2)
        (1/2*pi^2, zeta(3) - 1, -13/12)
        sage: hurwitz_zeta(2.0, 0.5)
        4.93480220054468
        sage: hurwitz_zeta(-2^63, 1/3)  # sagebrush only
        hurwitz_zeta(-9223372036854775808, 1/3)""",
    'beta': """The beta function B(a, b) = Gamma(a) Gamma(b)/Gamma(a + b).

    EXAMPLES::

        sage: beta(2, 3), beta(1, x)
        (1/12, 1/x)
        sage: beta(2.5, 1.5)
        0.196349540849362
        sage: y = var('y'); beta(x, y).diff(x)
        -(psi(x + y) - psi(x))*beta(x, y)
        sage: beta(CC(90, 1), CC(90, -1))  # sagebrush only
        Traceback (most recent call last):
        ...
        _special.NotCovered: beta((90+1j), (90-1j)): its gamma values leave the double range; not available in sagebrush yet""",
    'erfc': """The complementary error function 1 - erf(x).

    EXAMPLES::

        sage: erfc(0), erfc(oo)
        (1, 0)
        sage: erfc(1.0)
        0.157299207050285
        sage: erfc(x).diff(x)
        -2*e^(-x^2)/sqrt(pi)""",
    'erfi': """The imaginary error function -i erf(i x).

    EXAMPLES::

        sage: erfi(0), erfi(1.0)
        (0, 1.65042575879754)
        sage: erfi(x).diff(x)
        2*e^(x^2)/sqrt(pi)""",
    'erfinv': """The inverse error function (real arguments in [-1, 1]).

    EXAMPLES::

        sage: erfinv(0), erfinv(0.5)
        (0, 0.476936276204470)
        sage: erfinv(x).diff(x)
        1/2*sqrt(pi)*e^(erfinv(x)^2)""",
    'exp_integral_e1': """The exponential integral E1(x) = int_x^oo e^(-t)/t dt (principal
    branch: complex for negative x).

    EXAMPLES::

        sage: exp_integral_e1(1.0)  # abs tol 1e-14
        0.219383934395520
        sage: exp_integral_e1(x).diff(x)
        -e^(-x)/x""",
    'Ei': """The exponential integral Ei(x) (also exp_integral_ei; real
    arguments).

    EXAMPLES::

        sage: Ei(1.0), Ei(-1.0)  # abs tol 1e-14
        (1.89511781635594, -0.219383934395520)
        sage: Ei(x).diff(x)
        e^x/x""",
    'dilog': """The dilogarithm Li_2(x) (polylog(2, x)); on its cut x > 1 Sage's
    value, the limit from below.

    EXAMPLES::

        sage: dilog(1), dilog(-1), dilog(0.5)
        (1/6*pi^2, -1/12*pi^2, 0.582240526465012)
        sage: dilog(x).diff(x)
        -log(-x + 1)/x""",
    'polylog': """The polylogarithm Li_s(x) = sum_(k >= 1) x^k/k^s (numerical values
    for integer orders s).

    EXAMPLES::

        sage: polylog(2, x), polylog(1, x), polylog(3, 1)
        (dilog(x), -log(-x + 1), zeta(3))
        sage: polylog(3, 0.5)
        0.537213193608040
        sage: polylog(3, x).diff(x)
        dilog(x)/x""",
    'lambert_w': """The Lambert W function: lambert_w(x), the principal branch, or
    lambert_w(k, x), the branch k.

    EXAMPLES::

        sage: lambert_w(0), lambert_w(e), lambert_w(1)
        (0, 1, lambert_w(1))
        sage: lambert_w(1.0), lambert_w(-1, -0.1)
        (0.567143290409784, -3.57715206395730)
        sage: lambert_w(x).diff(x)
        lambert_w(x)/(x*lambert_w(x) + x)""",
    'elliptic_kc': """The complete elliptic integral of the first kind K(m) (parameter m;
    numerical values for m < 1).

    EXAMPLES::

        sage: elliptic_kc(0), elliptic_kc(0.5)
        (1/2*pi, 1.85407467730137)""",
    'elliptic_ec': """The complete elliptic integral of the second kind E(m) (parameter
    m; numerical values for m <= 1).

    EXAMPLES::

        sage: elliptic_ec(0), elliptic_ec(1), elliptic_ec(0.5)
        (1/2*pi, 1, 1.35064388104768)
        sage: elliptic_ec(x).diff(x)
        1/2*(elliptic_ec(x) - elliptic_kc(x))/x""",
    'sgn': """The sign: -1, 0 or 1 (also sign).

    EXAMPLES::

        sage: sgn(-3)
        -1
        sage: sgn(0)
        0
        sage: sgn(2.5)
        1""",
    'heaviside': """The Heaviside step function: 1 for x > 0, 0 for x < 0.

    EXAMPLES::

        sage: heaviside(2)
        1
        sage: heaviside(-1)
        0""",
}


_functions = {}


def _register(names, numeric=None):
    f = _function(names[0], numeric)
    f.__doc__ = _FUNCTION_DOCS.get(names[0])
    for n in names:
        _functions[n] = f
    return f


sin = _register(["sin"], _m.sin)
cos = _register(["cos"], _m.cos)
tan = _register(["tan"], _m.tan)
cot = _register(["cot"], lambda t: 1 / _m.tan(t))
sec = _register(["sec"], lambda t: 1 / _m.cos(t))
csc = _register(["csc"], lambda t: 1 / _m.sin(t))
asin = arcsin = _register(["arcsin", "asin"], _m.asin)
acos = arccos = _register(["arccos", "acos"], _m.acos)
atan = arctan = _register(["arctan", "atan"], _m.atan)
acot = arccot = _register(["arccot", "acot"], lambda t: _m.atan(1 / t))
asec = arcsec = _register(["arcsec", "asec"], lambda t: _m.acos(1 / t))
acsc = arccsc = _register(["arccsc", "acsc"], lambda t: _m.asin(1 / t))
atan2 = arctan2 = _register(["arctan2", "atan2"], _m.atan2)
sinh = _register(["sinh"], _m.sinh)
cosh = _register(["cosh"], _m.cosh)
tanh = _register(["tanh"], _m.tanh)
coth = _register(["coth"], lambda t: 1 / _m.tanh(t))
sech = _register(["sech"], lambda t: 1 / _m.cosh(t))
csch = _register(["csch"], lambda t: 1 / _m.sinh(t))
asinh = arcsinh = _register(["arcsinh", "asinh"], _m.asinh)
acosh = arccosh = _register(["arccosh", "acosh"], _m.acosh)
atanh = arctanh = _register(["arctanh", "atanh"], _m.atanh)
exp = _register(["exp"], _m.exp)
_log1 = _register(["log", "ln"], _m.log)
floor = _register(["floor"], _m.floor)
ceil = ceiling = _register(["ceil", "ceiling"], _m.ceil)
def _register_special(names, nargs=(1,)):
    f = _special_function(names[0], nargs)
    f.__doc__ = _FUNCTION_DOCS.get(names[0])
    for n in names:
        _functions[n] = f
    return f


gamma = _register_special(["gamma"])
erf = _register_special(["erf"])
psi = _register_special(["psi"], (1, 2))
log_gamma = _register_special(["log_gamma"])
zeta = _register_special(["zeta"])
zetaderiv = _register_special(["zetaderiv"], (2,))
hurwitz_zeta = _register_special(["hurwitz_zeta"], (2,))
beta = _register_special(["beta"], (2,))
erfc = _register_special(["erfc"])
erfi = _register_special(["erfi"])
erfinv = _register_special(["erfinv"])
exp_integral_e1 = _register_special(["exp_integral_e1"])
Ei = exp_integral_ei = _register_special(["Ei", "exp_integral_ei"])
dilog = _register_special(["dilog"])
polylog = _register_special(["polylog"], (2,))
lambert_w = _register_special(["lambert_w"], (1, 2))
elliptic_kc = _register_special(["elliptic_kc"])
elliptic_ec = _register_special(["elliptic_ec"])
sgn = sign = _register(["sgn", "sign"], _sgn)
heaviside = _register(["heaviside"], lambda t: 1.0 if t > 0 else 0.0)


def _small_int(v):
    """v as a Python int if it is an exact integer (int, Integer or an
    integer expression), else None."""
    if isinstance(v, bool) or isinstance(v, (float, complex)):
        return None
    if isinstance(v, int):
        return int(v)
    try:
        e = _expr(v)
    except TypeError:
        return None
    w = _py_number(e._s)
    if w is not None and not isinstance(w, float) and w == int(w):
        return int(w)
    return None


def _legendre_poly(k, t):
    """P_k(t), by (j + 1) P_(j+1) = (2j + 1) t P_j - j P_(j-1)."""
    p0, p1 = _expr(1), t
    if k == 0:
        return p0
    for j in range(1, k):
        p0, p1 = p1, (((2 * j + 1) * t * p1 - j * p0) / (j + 1)).expand()
    return p1


def legendre_P(n, x):
    """The Legendre polynomial P_n(x) (DLMF 18.3): a polynomial for an
    integer n (P_(-n-1) = P_n), a number at a number x, the unevaluated
    legendre_P(n, x) for a symbolic n.  Floats from lib/_special.py.

    EXAMPLES::

        sage: legendre_P(4, x)
        35/8*x^4 - 15/4*x^2 + 3/8
        sage: legendre_P(5, 1/2), legendre_P(3, 2.0)
        (23/256, 17.0000000000000)
        sage: legendre_P(3, x).diff(x)
        15/2*x^2 - 3/2
    """
    k = _small_int(n)
    if k is None:
        if _numeric_arg(n) and _numeric_arg(x):
            raise NotImplementedError("legendre_P of a non-integer degree is not available in sagebrush yet")
        return _one("fun", "legendre_P", _expr(n)._s, _expr(x)._s)
    if k < 0:
        k = -k - 1
    if _numeric_arg(x):
        v = _sf.legendre_p(k, complex(x) if isinstance(x, complex) else float(x))
        if isinstance(v, complex):
            from _sage_matrix import ComplexNumber
            return ComplexNumber(v.real, v.imag)
        from _sage_lang import RealNumber
        return RealNumber(v)
    r = _legendre_poly(k, _expr(x))
    if not isinstance(x, Expression) and not _is_poly(x):
        v = _py_number(r._s)
        if v is not None:
            return v
    return r


def _legendre_neg_order(k, mu, x):
    """P_k^(-mu)(x) for an integer mu > k >= 0, where it is not 0: DLMF 14.3.1,
    ((1 - x)/(1 + x))^(mu/2) / mu! F(k + 1, -k; mu + 1; (1 - x)/2), whose
    hypergeometric series ends at the term (1 - x)^k (P_0^(-1)(x) =
    sqrt((1 - x)/(1 + x)))."""
    import math
    from fractions import Fraction
    if isinstance(x, (float, complex)):
        if isinstance(x, complex) or not -1 < x <= 1:
            raise NotImplementedError("gen_legendre_P(%d, %d, x) at a number x outside (-1, 1] is not available in sagebrush yet" % (k, -mu))
        if k > 2000:
            raise NotImplementedError("gen_legendre_P of degree above 2000 at a number is not available in sagebrush yet")
        # The series alternates and cancels (gen_legendre_P(30, -31, -0.99)
        # is 2.6e-16 from terms near 1), so it is summed exactly, at the
        # exact rational the float x is.  q = w^floor(mu/2) F / mu! is split
        # exactly as Q 2^e with 1/2 <= |Q| < 2; Q (and for an odd mu
        # Q sqrt(w)) is rounded in the normal range, and the scaling by 2^e
        # comes last, so a subnormal result is rounded once there instead
        # of losing digits in a subnormal q (gen_legendre_P(0, -883,
        # -0.9999) = 1.666e-321 was 1.398e-321): within a few units in the
        # last place.
        X = Fraction(x)
        t = (1 - X) / 2
        f, term = Fraction(0), Fraction(1)
        for i in range(k + 1):
            f += term
            term = term * (k + 1 + i) * (-k + i) / ((mu + 1 + i) * (i + 1)) * t
        w = (1 - X) / (1 + X)
        q = w ** (mu // 2) * f / math.factorial(mu)
        from _sage_lang import RealNumber
        if q == 0:
            return RealNumber(0.0)
        e = abs(q.numerator).bit_length() - q.denominator.bit_length()
        Q = q / 2 ** e if e >= 0 else q * 2 ** -e
        v = float(Q)
        if mu % 2:
            v *= math.sqrt(float(w))
        # v 2^e with one rounding, in steps of 2^-1000 that keep v normal
        # (and exact) until the last (the browser runtime's math.ldexp
        # rounds subnormal results to 0: ldexp(128.0, -1080) gave 0.0)
        while e < -1000 and v != 0:
            v, e = v * 2.0 ** -1000, e + 1000
        while e > 1000 and math.isfinite(v):
            v, e = v * 2.0 ** 1000, e - 1000
        try:
            v = v * 2.0 ** e
        except OverflowError:
            # 2.0 ** e itself overflows when a step above already made v
            # infinite and left e > 1023
            v = math.inf
        if v == 0 or not math.isfinite(v):
            raise NotImplementedError("gen_legendre_P(%d, %d, %r) is outside the double range" % (k, -mu, float(x)))
        return RealNumber(v)
    X = _expr(x)
    t = (1 - X) / 2
    f = _expr(0)
    for i in range(k + 1):
        c = Fraction(math.prod(range(k + 1, k + 1 + i)) * math.prod(range(-k, -k + i)), math.prod(range(mu + 1, mu + 1 + i)) * math.factorial(i))
        f = f + _expr(c) * t ** i
    r = ((1 - X) / (1 + X)) ** (_expr(mu) / 2) / math.factorial(mu) * f.expand()
    if not isinstance(x, Expression) and not _is_poly(x):
        v = _py_number(r._s)
        if v is not None:
            return v
    return r


def gen_legendre_P(n, m, x):
    """The associated Legendre function P_n^m(x) = (-1)^m (1 - x^2)^(m/2)
    d^m P_n(x)/dx^m (DLMF 14.7.8, with the Condon-Shortley phase (-1)^m,
    as Sage's gen_legendre_P) for integers n and m, and P_n^(-m) =
    (-1)^m (n - m)!/(n + m)! P_n^m; the unevaluated gen_legendre_P(n, m, x)
    for symbolic n or m.  Floats in [-1, 1] from lib/_special.py.

    EXAMPLES::

        sage: gen_legendre_P(2, 2, x)
        -3*x^2 + 3
        sage: gen_legendre_P(3, 3, x)
        -15*(-x^2 + 1)^(3/2)
        sage: gen_legendre_P(4, 2, 0.3)
        -2.52525000000000
        sage: gen_legendre_P(0, -101, RR(-0.9999999999999999))  # beyond the double range  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: gen_legendre_P(0, -101, -0.9999999999999999) is outside the double range
    """
    k, j = _small_int(n), _small_int(m)
    if k is None or j is None:
        if all(_numeric_arg(a) or isinstance(a, int) for a in (n, m, x)):
            raise NotImplementedError("gen_legendre_P of a non-integer degree or order is not available in sagebrush yet")
        return _one("fun", "gen_legendre_P", _expr(n)._s, _expr(m)._s, _expr(x)._s)
    if k < 0:
        k = -k - 1
    if j < -k:
        return _legendre_neg_order(k, -j, x)
    if j > k:
        if isinstance(x, float):
            from _sage_lang import RealNumber
            return RealNumber(0.0)
        return _expr(0)
    if isinstance(x, float) and -1 <= x <= 1:
        from _sage_lang import RealNumber
        return RealNumber(_sf.assoc_legendre_p(k, j, float(x)))
    t = Expression(_sym_s("_t_legendre"))
    a = abs(j)
    d = _legendre_poly(k, t)
    for _ in range(a):
        d = d.diff(t)
    d = d.factor()
    # written as Sage writes it: -(x^2 - 1) for (1 - x^2) at even orders
    if a % 2 == 0:
        r = (-1) ** (a // 2 + a) * (t ** 2 - 1) ** (a // 2) * d
    else:
        r = (-1) ** a * (1 - t ** 2) ** (_expr(a) / 2) * d
    if j < 0:
        import math
        r = (-1) ** a * _expr(math.factorial(k - a)) / math.factorial(k + a) * r
    r = r.subs({t: _expr(x)})
    if isinstance(x, (float, complex)):
        return r.n()
    return r


def log(v, b=None):
    """log(x), the natural logarithm; log(x, b) = log(x)/log(b).

    EXAMPLES::

        sage: log(1), log(e), log(8, 2), log(x).diff(x)
        (0, 1, 3, 1/x)
    """
    if b is None:
        return _log1(v)
    if isinstance(v, int) and isinstance(b, int) and v > 0 and b > 1:
        # exact when v is a power of b (Sage: log(8, 2) = 3)
        k, t = 0, 1
        while t < v:
            t, k = t * b, k + 1
        if t == v:
            return k
    return _log1(v) / _log1(b)


ln = log


def function(name, nargs=None, latex_name=None, **kwds):
    """function('f'): an undefined symbolic function f(x).

    EXAMPLES::

        sage: f = function('f'); f(x)
        f(x)
        sage: f(x).diff(x)
        diff(f(x), x)
    """
    if name in _functions:
        return _functions[name]

    def f(*args):
        return _one("fun", name, *[_expr(a)._s for a in args])
    f.__name__ = name
    return f


pi = Expression("cp")
e = Expression("ce")
I = Expression(_call("const", "I")[0])
oo = infinity = Infinity = Expression("c+")
euler_gamma = Expression("cg")
x = Expression(_sym_s("x"))


# ------------------------------------------------------------------ top-level calculus

def symbolic_sum(f, v, a, b, algorithm=None, hold=False):
    """The sum of f for v from a to b (b may be oo): closed forms for
    polynomials (Faulhaber), geometric terms, binomial coefficients,
    1/k^s (zeta), x^k/k! (exponential); a direct sum for small numeric
    ranges; otherwise the sum stays unevaluated.  sum(f, v, a, b) calls
    it.  (In Sage symbolic_sum is not a global name: import it from
    sage.calculus.calculus, or call sum(f, v, a, b).)

    EXAMPLES::

        sage: from sage.calculus.calculus import symbolic_sum
        sage: var('k n')
        (k, n)
        sage: symbolic_sum(k, k, 1, n), symbolic_sum(k^2, k, 1, n)
        (1/2*n^2 + 1/2*n, 1/3*n^3 + 1/2*n^2 + 1/6*n)
        sage: symbolic_sum((1/3)^k, k, 0, oo), symbolic_sum(binomial(n, k), k, 0, n)
        (3/2, 2^n)
        sage: y = var('y'); symbolic_sum(binomial(n, k)*x^k*y^(n-k), k, 0, n)
        (x + y)^n
        sage: symbolic_sum(1/k^2, k, 1, oo), symbolic_sum(x^k/factorial(k), k, 0, oo)
        (1/6*pi^2, e^x)
    """
    import sage_all as _sa
    f, v = _expr(f), _expr(v)
    a, b = _expr(a), _expr(b)
    vn = _var_name(v)
    inf = str(b) == "+Infinity"
    if vn not in f._names():
        if inf:
            if bool(f == 0):
                return _expr(0)
            raise ValueError("Sum is divergent.")
        return (f * (b - a + 1)).expand() if f._names() or not f.is_numeric() else f * (b - a + 1)
    # small numeric ranges: add the terms
    if a.is_numeric() and b.is_numeric() and not inf:
        lo, hi = int(a), int(b)
        if hi - lo <= 2000:
            r = _expr(0)
            for i in range(lo, hi + 1):
                r = r + f.subs({v: i})
            return r
    # binomial coefficients: sum binomial(n, k) x^k = (x + 1)^n
    r = _sum_binomial(f, v, a, b)
    if r is not None:
        return r
    # polynomials in v: Faulhaber
    if f.is_polynomial(v) and not inf:
        cs = f.list(v)
        tot = _expr(0)
        for j, c in enumerate(cs):
            if not c.is_trivial_zero():
                tot = tot + c * (_faulhaber(j, b) - _faulhaber(j, a - 1))
        return tot.expand()
    # geometric terms: f(v+1)/f(v) free of v
    q = _geom_ratio(f, v)
    if q is not None:
        fa = f.subs({v: a})
        if inf:
            try:
                ok = abs(complex(q.n())) < 1
            except Exception:
                ok = True   # symbolic ratio: as Sage under assume(abs(q) < 1)
            if not ok:
                raise ValueError("Sum is divergent.")
            return (fa / (1 - q)).simplify_rational() if q._names() else fa / (1 - q)
        return ((fa * (q ** (b - a + 1) - 1)) / (q - 1)).simplify_rational()
    if inf and str(a) in ("0", "1"):
        r = _sum_special(f, v, a)
        if r is not None:
            return r
    from _sage_expr import function as _fn
    return _fn("sum")(f, v, a, b)


def _geom_ratio(f, v, allow_factorial=False):
    """r when f = c*prod(b_i^(e_i)) with the b_i free of v and the e_i of
    degree 1 in v, so f(v+1) = r*f(v); with allow_factorial, a factor
    1/factorial(v) contributes 1/(v + 1).  None otherwise."""
    vn = _var_name(v)
    fs = f.operands() if f._op()[0] == "mul" else [f]
    r = _expr(1)
    for t in fs:
        if vn not in t._names():
            continue
        tag = t._op()[0]
        if tag == "pow":
            b, ex = t.operands()
            if allow_factorial and str(b) == "factorial(%s)" % vn and str(ex) == "-1":
                r = r / (v + 1)
                continue
            if vn in b._names() or not ex.is_polynomial(v) or ex.degree(v) != 1:
                return None
            r = r * b ** ex.coefficient(v, 1)
            continue
        return None
    return r


def _faulhaber(j, n):
    """sum_{k=1}^{n} k^j as a polynomial in n (Bernoulli numbers, B_1 = 1/2)."""
    import sage_all as _sa
    n = _expr(n)
    if j == 0:
        return n
    tot = _expr(0)
    for i in range(j + 1):
        B = _sa.bernoulli(i)
        if i == 1:
            B = -B
        tot = tot + _sa.binomial(j + 1, i) * B * n ** (j + 1 - i)
    return tot / (j + 1)


def _sum_binomial(f, v, a, b):
    """sum_{k=0}^{n} binomial(n, k) x^k (and its k-free multiples)."""
    t = f._op()
    s = str(f)
    if "binomial(" not in s or str(a) != "0":
        return None
    n = b
    from _sage_expr import _call
    import sage_all as _sa
    bk = _sa.binomial(n, v)
    q = (f / bk).simplify_rational()
    vn = _var_name(v)
    if vn not in q._names():
        return (q * 2 ** n)
    # q = c * A^k * B^(n-k), the ratio r = A/B: the sum is c*(A + B)^n.
    # Writing it as q(0)*(r + 1)^n would divide by B, which may vanish
    # where every term is defined (y = 0 in x^k*y^(n-k)).
    r = _geom_ratio(q, v)
    r = (q.subs({v: v + 1}) / q if r is None else r).simplify_rational()
    if vn not in r._names():
        A, B = r.numerator(), r.denominator()
        q0 = q.subs({v: 0})
        if not B._names():
            return q0 * (r + 1) ** n
        c = (q0 / B ** n).simplify_rational()
        if not (set(n._names()) & set(c._names())):
            return c * (A + B) ** n
        # B^n is not a factor of q0: keep (r + 1)^n only when the k = 1
        # term already divides by B (x^k/y^k), so no domain is lost
        q1 = q.subs({v: 1}).simplify_rational()
        t = (q1.denominator() / B).simplify_rational()
        if not t.denominator()._names():
            return q0 * ((A + B) / B) ** n
    return None


def _sum_special(f, v, a):
    """1/k^s (k >= 1) and x^k/k! (k >= 0)."""
    import sage_all as _sa
    vn = _var_name(v)
    # 1/k^s
    if str(a) == "1":
        lg = (f.subs({v: _sa.e}) if False else None)
        try:
            s_ = -(f.log().diff(v) * v).simplify_rational()
            if vn not in s_._names() and bool((f * v ** s_ - 1).simplify_rational() == 0):
                return _sa.zeta(s_)
        except Exception:
            pass
    # c*x^k/k!: the ratio is x/(k+1)
    if str(a) == "0" and "factorial(" in str(f):
        q = _geom_ratio(f, v, allow_factorial=True)
        if q is not None:
            xk = (q * (v + 1)).simplify_rational()
            if vn not in xk._names():
                return f.subs({v: 0}) * _sa.exp(xk)
    return None


def _poly_or(f):
    return _expr(f) if _is_poly(f) else f


def diff(f, *args):
    """diff(f, x), diff(f, x, 2), diff(f, x, y).

    EXAMPLES::

        sage: diff(x^3, x), diff(sin(x), x, 3), diff(x^2*x, x)
        (3*x^2, -cos(x), 3*x^2)
    """
    if _callable(f):
        return f.diff(*args)
    f = _poly_or(f)
    if not isinstance(f, Expression):
        if hasattr(f, "derivative"):
            return f.derivative(*args)
        return 0
    return f.diff(*args)


def _callable(f):
    """Whether f is a callable symbolic expression (f(x) = ...)."""
    return _is_symbolic_function(f)


derivative = diff


def expand(f):
    """The expansion of f.

    EXAMPLES::

        sage: expand((x + 2)^2)
        x^2 + 4*x + 4
    """
    f = _poly_or(f) if not hasattr(f, "expand") or isinstance(f, Expression) else f
    return f.expand() if hasattr(f, "expand") else f


def simplify(f):
    """Simplify f.

    EXAMPLES::

        sage: simplify(x + x - 1)
        2*x - 1
    """
    return f.simplify() if hasattr(f, "simplify") else f


def taylor(f, *args):
    """The Taylor polynomial: taylor(f, x, a, n).

    EXAMPLES::

        sage: taylor(1/(1 - x), x, 0, 4), taylor(cos(x), x, 0, 6)
        (x^4 + x^3 + x^2 + x + 1, -1/720*x^6 + 1/24*x^4 - 1/2*x^2 + 1)
    """
    if _callable(f):
        return f.taylor(*args)
    return _expr(f).taylor(*args)


def limit(f, *args, dir=None, **kw):
    """The limit: limit(f, x=a), dir='+' or '-' for one side (also lim).

    EXAMPLES::

        sage: limit(sin(x)/x, x=0), limit(1/x, x=0, dir='-'), lim((x^2 - 1)/(x - 1), x=1)
        (1, -Infinity, 2)
    """
    if _callable(f):
        return f.limit(*args, dir=dir, **kw)
    return _expr(f).limit(*args, dir=dir, **kw)


lim = limit


def _decide(c):
    """True or False when the engine proves the constant relation c, else None."""
    r = _call("decide", c._s)[0]
    return True if r == "1" else False if r == "0" else None


def _sr_poly_terms(e, names):
    """{monomial: rational coefficient} if e is a polynomial in names with
    exact rational coefficients, else None."""
    if not names:
        v = _py_number(e._s)
        if v is None or isinstance(v, (float, complex)):
            return None
        return {(): v}
    x = names[0]
    if x not in e._names():
        return _sr_poly_terms(e, names[1:])
    try:
        cs = e.list(x)
    except Exception:
        return None
    out = {}
    for i, c in enumerate(cs):
        sub = _sr_poly_terms(c, names[1:])
        if sub is None:
            return None
        for m, v in sub.items():
            out[tuple(sorted(m + (((x, i),) if i else ())))] = v
    return out


def _negate(c):
    """The negation of a relation (a < b: a >= b)."""
    op = c._op()[0]
    l, r = c.lhs(), c.rhs()
    return {"rel:Eq": lambda: l != r, "rel:Ne": lambda: l == r, "rel:Lt": lambda: l >= r,
            "rel:Le": lambda: l > r, "rel:Gt": lambda: l <= r, "rel:Ge": lambda: l < r}[op]()


class _SolutionDict(dict):
    """{x: value} with the conditions and integer parameters of its Solution."""
    _latex_container = True  # (latex() writes it as Sage's plain dict: it stands in for one)

    def __init__(self, d, conds=(), params=()):
        dict.__init__(self, d)
        self._conds, self._params = list(conds), list(params)

    def conditions(self):
        return list(self._conds)

    def parameters(self):
        return [Expression(_sym_s(n)) for n in self._params]

    def __repr__(self):
        t = dict.__repr__(self)
        if self._params:
            t += " for integer " + ", ".join(self._params)
        if self._conds:
            t += " if " + " and ".join(Solution._cond_text(self, str))
        return t


class Solution(Expression):
    """A solution x == value of one equation, with the conditions on the
    parameters under which it is one (conditions(), a list of relations
    that must all hold) and the integer parameters of a family of solutions
    (parameters()).  It is the relation itself: lhs(), rhs(), subs() work
    as on any relation.

    EXAMPLES::

        sage: a = var('a')
        sage: s = solve(sqrt(x) == a, x)[0]; s  # sagebrush only
        x == a^2 if -1/2*pi < arg(a) <= 1/2*pi
        sage: s.rhs(), s.conditions()  # sagebrush only
        (a^2, [arg(a) > -1/2*pi, arg(a) <= 1/2*pi])
    """

    __slots__ = ("_conds", "_params")

    # transformations keep the conditions (simplify_full() of the relation
    # is the same solution); subs() also substitutes in them and decides
    # them.  (Both returned plain relations, so the conditions were lost:
    # the review of solve's CSOL-F7.)
    _PLAIN = frozenset(("lhs", "rhs", "conditions", "parameters", "subs", "substitute", "is_relational", "variables", "operator"))

    def __init__(self, s, conds=(), params=()):
        Expression.__init__(self, s)
        # (conditions as Expressions also when rebuilt from __reduce__'s
        # strings: CSOL-F8)
        self._conds = [Expression(c) if isinstance(c, str) else c for c in conds]
        self._params = list(params)

    def __getattribute__(self, name):
        attr = object.__getattribute__(self, name)
        if name.startswith("_") or name in Solution._PLAIN or not callable(attr):
            return attr

        def keep(*args, **kw):
            r = attr(*args, **kw)
            if isinstance(r, Expression) and not isinstance(r, Solution) and r.is_relational():
                return Solution(r._s, object.__getattribute__(self, "_conds"), object.__getattribute__(self, "_params"))
            return r
        return keep

    def subs(self, *args, **kw):
        """The substitution in the solution and its conditions.  Conditions
        that become decided are dropped when true; one that becomes false
        raises ValueError (it is no solution there), and so does a value of
        an integer parameter that is not an integer.

        EXAMPLES::

            sage: a = var('a')
            sage: s = solve(sqrt(x) == a, x)[0]  # sagebrush only
            sage: s.subs(a=2)  # sagebrush only
            x == 4
            sage: s.subs(a=-1)  # sagebrush only
            Traceback (most recent call last):
            ...
            ValueError: not a solution there: -1/2*pi < pi <= 1/2*pi fails
        """
        names = {}
        for a in args:
            for k, v in (a.items() if isinstance(a, dict) else ([(a.lhs(), a.rhs())] if isinstance(a, Expression) else [(r.lhs(), r.rhs()) for r in a])):
                names[str(k)] = v
        for k, v in kw.items():
            names[k] = v
        params = list(self._params)
        for p in self._params:
            if p in names:
                v = _expr(names[p])
                if not (v.is_numeric() if hasattr(v, "is_numeric") else False) or _call("is_zero", (v - floor(v))._s)[0] != "1":
                    raise ValueError("%s is an integer parameter of the family, not %s" % (p, v))
                params.remove(p)
        # the conditions first: where one fails the value may be undefined
        # (1/a at a = 0 raised ZeroDivisionError, not "no solution")
        keep, shown = [], []
        failed = False
        for c in self._conds:
            try:
                c2 = Expression.subs(c, *args, **kw)
            except ZeroDivisionError:
                shown.append(c)
                continue
            shown.append(c2)
            if c2.variables():
                keep.append(c2)
                continue
            # decided by the engine (exactly or by enclosures), else kept:
            # bool() of a relation is no proof (asin's range at pi/2 - 10^-10
            # was rejected: CSOL-F7)
            verdict = _decide(c2)
            if verdict is True:
                continue
            if verdict is False:
                failed = True
                continue
            keep.append(c2)
        if failed:
            raise ValueError("not a solution there: %s fails" % " and ".join(Solution(self._s, shown)._cond_text(str)))
        try:
            rel = Expression.subs(self, *args, **kw)
        except ZeroDivisionError:
            raise ValueError("not a solution there: %s is undefined" % Expression.rhs(self))
        return Solution(rel._s, keep, params)

    substitute = subs

    def __reduce__(self):
        return (Solution, (self._s, [c._s for c in self._conds], list(self._params)))

    def conditions(self):
        """The relations on the parameters under which this is a solution
        (all must hold; [] if it always is)."""
        return list(self._conds)

    def parameters(self):
        """The integer parameters n1, n2, ... of a family of solutions (each
        integer value gives one)."""
        return [Expression(_sym_s(n)) for n in self._params]

    def _cond_text(self, show, latex=False):
        cs = self._conds
        out = []
        i = 0
        while i < len(cs):
            c = cs[i]
            # lo < X and X <= hi, shown as lo < X <= hi
            if i + 1 < len(cs):
                o1, o2 = c._op()[0], cs[i + 1]._op()[0]
                if o1 == "rel:Gt" and o2 == "rel:Le" and str(c.lhs()) == str(cs[i + 1].lhs()):
                    lt, le = ("<", "\\leq") if latex else ("<", "<=")
                    out.append("%s %s %s %s %s" % (show(c.rhs()), lt, show(c.lhs()), le, show(cs[i + 1].rhs())))
                    i += 2
                    continue
            out.append(show(c))
            i += 1
        return out

    def __repr__(self):
        t = Expression.__repr__(self)
        if self._params:
            t += " for integer " + ", ".join(self._params)
        if self._conds:
            t += " if " + " and ".join(self._cond_text(str))
        return t

    __str__ = __repr__

    def _latex_(self):
        t = Expression._latex_(self)
        if self._params:
            t += r" \quad (%s \in \mathbb{Z})" % ", ".join(self._params)
        if self._conds:
            t += r" \quad \text{if } " + r" \text{ and } ".join(self._cond_text(lambda e: e._latex_(), True))
        return t


def _keep_conditions(name):
    """Solution's version of an operator: the result, if still a relation,
    keeps the conditions (s + 0, -(-s), s*1 dropped them: CSOL-F7)."""
    base = getattr(Expression, name)

    def op(self, *args):
        # applied to both sides, as Sage does for a relation (the engine's
        # -(x == a) was not a relation at all); with another relation, both
        # operands' conditions and integer parameters (renamed apart when
        # the names collide): CSOL-F7
        l, r = Expression.lhs(self), Expression.rhs(self)
        conds = list(object.__getattribute__(self, "_conds"))
        params = list(object.__getattribute__(self, "_params"))
        if args and not isinstance(args[0], Expression):
            # (a polynomial or another coercible operand: its symbolic form,
            # so that its names are reserved too: CSOL-F7)
            try:
                args = (_expr(args[0]),) + tuple(args[1:])
            except Exception:
                pass
        if args and isinstance(args[0], Expression) and not args[0].is_relational() and params:
            # a scalar operand's free names are not the family's parameters
            # (s + n1 bound the free n1: CSOL-F7): rename the family's apart
            theirs = set(args[0]._names())
            if theirs & set(params):
                used = theirs | set(self._names()) | set(params)
                for c in conds:
                    used |= set(c._names())
                ren = {}
                for p in params:
                    if p in theirs:
                        i = 1
                        while "n%d" % i in used:
                            i += 1
                        used.add("n%d" % i)
                        ren[p] = "n%d" % i
                sub = {Expression(_sym_s(p)): Expression(_sym_s(q)) for p, q in ren.items()}
                rel = Expression.subs(self, sub)
                l, r = Expression.lhs(rel), Expression.rhs(rel)
                conds = [Expression.subs(c, sub) for c in conds]
                params = [ren.get(p, p) for p in params]
        if args and isinstance(args[0], Expression) and args[0].is_relational():
            o = args[0]
            if not isinstance(o, Solution):
                o = Solution(o._s)
            # rename bound integer parameters apart from every name on the
            # other side, free or bound, conditions included (u + s captured
            # u's free n1 in s's family: CSOL-F7)
            def names(sol):
                out = set(sol._names()) | set(sol._params)
                for c in sol._conds:
                    out |= set(c._names())
                return out
            me = Solution(self._s, conds, params)
            used = names(me) | names(o)

            def apart(sol, other_names):
                ren = {}
                for p in sol._params:
                    if p in other_names:
                        i = 1
                        while "n%d" % i in used:
                            i += 1
                        used.add("n%d" % i)
                        ren[p] = "n%d" % i
                if not ren:
                    return sol
                sub = {Expression(_sym_s(p)): Expression(_sym_s(q)) for p, q in ren.items()}
                return Solution(Expression.subs(sol, sub)._s, [Expression.subs(c, sub) for c in sol._conds], [ren.get(p, p) for p in sol._params])
            me = apart(me, names(o))
            o = apart(o, names(me))
            l, r = Expression.lhs(me), Expression.rhs(me)
            conds, params = list(me._conds), list(me._params)
            conds += [c for c in o._conds if str(c) not in {str(d) for d in conds}]
            params += [p for p in o._params if p not in params]
            nl, nr = base(l, o.lhs()), base(r, o.rhs())
        else:
            nl, nr = base(l, *args), base(r, *args)
        rel = nl == nr
        return Solution(rel._s, conds, params)
    op.__name__ = name
    return op


for _name in ("__add__", "__radd__", "__sub__", "__rsub__", "__mul__", "__rmul__", "__truediv__", "__rtruediv__",
              "__neg__", "__pos__", "__pow__", "__rpow__"):
    if hasattr(Expression, _name):
        setattr(Solution, _name, _keep_conditions(_name))


def _put_back(r, back):
    """r (a solution, a list of them, or a dict) with each symbol of back
    replaced by its function value."""
    if isinstance(r, (list, tuple)):
        return type(r)(_put_back(t, back) for t in r)
    if isinstance(r, dict):
        return type(r)((back.get(k, k), _put_back(v, back)) for k, v in r.items())
    if isinstance(r, Expression):
        return r.subs(back)
    return r


def solve(f, *args, **kw):
    """solve(x^2 == 4, x) -> [x == -2, x == 2]; solve([eqs], x, y) ->
    [[x == ..., y == ...], ...]; solution_dict=True for dictionaries.

    For one equation in one variable Sagebrush differs from Sage, which
    gives generic and principal solutions only: each solution is a
    Solution, with the conditions on the
    parameters under which it is one (sqrt(x) == a has x == a^2 only for
    -pi/2 < arg(a) <= pi/2, the principal square roots), the cases where a
    leading coefficient vanishes are solved too (a*x^2 + x - 1 == 0 also
    has x == 1 when a == 0), and periodic equations give whole families in
    new integer parameters n1, n2, ... (sin(x) == 0: x == pi*n1; a family
    comes from the functions' periods, and is checked at a few integers).
    The answer is meant to be read literally: [] means there is no
    solution, and 0 == f remains whenever not every solution was found or
    a candidate could not be decided (a factor of unknown roots, an
    irrational exponent's other branches).  Each solution comes from an
    exact inversion valid under its conditions, which are decided exactly
    (or by separating enclosures) or left attached; a constant that cannot
    be shown nonzero is never divided by unconditionally.  Assumptions on x become
    conditions on a family (assume(x > 0): x == pi*n1 if pi*n1 > 0);
    'integer' and the like on a family are refused.  Equations with square
    roots are solved by squaring them away, each candidate checked in the
    original equation (sqrt(x) == x - 2: x == 4 only).  Equations in sin,
    cos and tan of arguments linear in x are solved as such (f(u) == f(v),
    a*sin(u) + b*cos(u) == c, polynomials in sin and cos of one angle), and
    families that are one family are merged (sin(x)^2 == 1/4: x == +-pi/6 +
    pi*n); Sage gives these back unsolved or only principal solutions.
    Cubics are solved in radicals, and with three real roots in Viete's
    real trigonometric form (x^3 - 3*x + 1: 2*cos(2/9*pi), ...); roots of
    unity exactly; sums of logarithms by exponentiating, each candidate
    checked (log(x) + log(x - 1) == log(2): x == 2 only).  abs(u) is split
    into u and -u where x is assumed real; for complex x, abs(x) == 2 is a
    circle, which stays unresolved (Sage gives [x == -2, x == 2]).

    Systems: linear ones by elimination; polynomial ones over QQ with
    finitely many solutions through a lex Groebner basis; others by
    substitution (an equation solved for one variable, recursively), with
    variables left free as new symbols r1, r2, ...  (x*y == 0 in x, y has
    both x == 0 and y == 0).  Inequalities given with the equations are
    conditions on their solutions: false ones remove a solution, undecided
    ones are kept beside it.  Not yet complete: exponents that are not
    rational numbers (the principal branch only), and linear systems with
    parameters (their pivots are assumed nonzero).

    EXAMPLES::

        sage: solve(x^2 == 4, x)
        [x == -2, x == 2]
        sage: g = function('g')(x); solve(g^2 == 4, g), solve((x - 1)^2 == 8, x)
        ([g(x) == -2, g(x) == 2], [x == -2*sqrt(2) + 1, x == 2*sqrt(2) + 1])
        sage: var('y')
        y
        sage: solve([x + y == 3, x - y == 1], x, y)
        [[x == 2, y == 1]]
        sage: a = var('a')
        sage: solve(sin(x) == 0, x)  # sagebrush only
        [x == pi*n1 for integer n1]
        sage: solve(a*x^2 + x - 1 == 0, x)  # sagebrush only
        [x == -1/2*sqrt(4*a + 1)/a - 1/2/a if a != 0, x == 1/2*sqrt(4*a + 1)/a - 1/2/a if a != 0, x == 1 if a == 0]
        sage: solve(sqrt(x) == -1, x), solve(a*x == 1, x)  # sagebrush only
        ([], [x == 1/a if a != 0])
        sage: solve(sqrt(x) == x - 2, x)  # sagebrush only
        [x == 4]
        sage: solve([x^2 + y^2 == 1, y == x], x, y)  # sagebrush only
        [[x == -1/2*sqrt(2), y == -1/2*sqrt(2)], [x == 1/2*sqrt(2), y == 1/2*sqrt(2)]]
        sage: solve(x*y == 0, [x, y])  # sagebrush only
        [[x == 0, y == r2], [x == r1, y == 0]]
        sage: solve([x^2 == 4, x > 0], x)  # sagebrush only
        [[x == 2]]
        sage: solve(sin(x) == cos(x), x)  # sagebrush only
        [x == pi*n1 + 1/4*pi for integer n1]
        sage: solve(cos(2*x) == cos(x), x)  # sagebrush only
        [x == 2/3*pi*n1 for integer n1]
        sage: solve(x^3 - 3*x + 1 == 0, x)  # sagebrush only
        [x == 2*cos(8/9*pi), x == 2*cos(4/9*pi), x == 2*cos(2/9*pi)]
        sage: solve(log(x) + log(x - 1) == log(2), x)  # sagebrush only
        [x == 2]
    """
    # (_raw: without the assumptions, for the system solver's own steps,
    # which apply them to the whole assignment)
    raw = kw.pop("_raw", False)
    many = isinstance(f, (list, tuple))
    eqs = [_expr(g) for g in (f if many else [f])]
    vs = []
    for a in args:
        if isinstance(a, (list, tuple)):
            vs.extend(a)
        else:
            vs.append(a)
    if not vs:
        names = sorted(set(n for g in eqs for n in g._names()))
        vs = names
    # a function value as the unknown (solve(ed, y) with y = function('y')(x),
    # Sage's way with an ODE's solution: it was "y(x) is not a valid
    # variable"): solved for a new symbol in its place, then put back
    fns = [v for v in vs if isinstance(v, Expression) and not v.is_symbol() and v._op()[0].startswith("fun:")]
    if fns:
        # (not a name of the equations nor of a requested variable:
        # solve([f(x) == 2], f(x), _solve_fn0) took the user's _solve_fn0)
        taken = set(n for g in eqs for n in g._names())
        taken |= set(n for v in vs for n in (_expr(v)._names() if not isinstance(v, str) else [v]))
        # and not a name in the active assumptions (assume(_solve_fn0 > 0)
        # made solve(ff(x) == -2, ff(x)) return [], the review's CORR-9E5-1)
        for r in _ASSUMPTIONS:
            taken |= set(r._names()) if isinstance(r, Expression) else {str(r._v)}
        new = {}
        for k, v in enumerate(fns):
            name = "_solve_fn%d" % k
            while name in taken:
                name += "_"
            taken.add(name)
            new[str(v)] = Expression(_sym_s(name))
        put = {fv: new[str(fv)] for fv in fns}
        eqs2 = [g.subs(put) for g in eqs]
        vs2 = [new[str(v)] if str(v) in new else v for v in vs]
        r = solve(eqs2 if many else eqs2[0], *vs2, **kw)
        return _put_back(r, {new[str(fv)]: fv for fv in fns})
    names = [_var_name(v) for v in vs]
    eqs = [g if g.is_relational() else g == 0 for g in eqs]
    # inequalities are conditions on the solutions of the equations (Sage's
    # solve returned [x == 1, -2 > 0]: a false condition kept as a solution)
    ineqs = [g for g in eqs if g._op()[0] != "rel:Eq"]
    eqs = [g for g in eqs if g._op()[0] == "rel:Eq"]
    if not eqs:
        raise NotImplementedError("solve: inequalities without an equation")
    # names the new symbols (r1, n1) must not take: those of the
    # inequalities and the assumptions (assume(x > r1) had its r1 captured:
    # the review's SOLVE2-F4/F6)
    theirs = set(n for q in ineqs for n in q._names())
    if not raw:
        for r in _ASSUMPTIONS:
            theirs |= set(r._names()) if isinstance(r, Expression) else {str(r._v)}
    mine = set(n for g in eqs for n in g._names()) | set(names)
    one = len(eqs) == 1 and len(names) == 1
    if one and not raw and not ineqs and not kw.get("multiplicities") and _assumed_real(names[0]):
        u = _find_abs(eqs[0], names[0])
        if u is not None and _real_given(u, names[0]):
            out = _solve_abs(eqs[0], u, names[0])
            if kw.get("solution_dict"):
                return _solution_dicts([[t] for t in out], 1)
            # a list of equations gives one list per solution, as below
            # (solve([abs(x) == 1], x) was flat: ABS-F3)
            return [[t] for t in out] if many else out
    if not one:
        try:
            r = _call("solve", str(len(eqs)), *[g._s for g in eqs], *names)
        except ValueError as e:
            if "only linear systems" not in str(e) and "underdetermined" not in str(e):
                raise
            # (the inequalities' names are reserved too: a new r1 captured
            # a free r1 of y > r1, the review's SOLVE2-F4)
            sols = _solve_system([g.lhs() - g.rhs() for g in eqs], names, theirs)
            if sols is None:
                raise NotImplementedError("solve: this system (%s) is not solved; it is not polynomial over QQ, or no equation can be solved for one of its variables" % ", ".join(str(g) for g in eqs))
            sols = [_rename_new_apart(sol, theirs, mine) for sol in sols]
            if ineqs:
                sols = _with_inequalities(sols, ineqs, eqs, names)
            if _ASSUMPTIONS and not raw:
                sols = _system_assume(sols, names)
            return _system_out(sols, names, kw)
    else:
        r = _call("solve", str(len(eqs)), *[g._s for g in eqs], *names)
    k, i, sols = int(r[0]), 1, []
    for _ in range(k):
        m = int(r[i])
        part = r[i + 1:i + 1 + m]
        if one:
            # x == v, its conditions, "@int:n" for its integer parameters
            params = [t[5:] for t in part[1:] if t.startswith("@int:")]
            conds = [Expression(t) for t in part[1:] if not t.startswith("@int:")]
            sols.append([Solution(part[0], conds, params)])
        else:
            sols.append([Expression(t) for t in part])
        i += 1 + m
    sols = [_rename_new_apart(sol, theirs, mine) for sol in sols]
    if ineqs:
        sols = _with_inequalities(sols, ineqs, eqs, names)
    if _ASSUMPTIONS and not raw:
        if one:
            sols = [sol for sol in (_assume_on(sol, names) for sol in sols) if sol is not None and _satisfies(sol)]
        else:
            sols = _system_assume(sols, names)
    if kw.get("multiplicities"):
        if many or len(names) != 1 or kw.get("solution_dict"):
            raise NotImplementedError("solve: multiplicities=True for one equation in one variable")
        out = [s for sol in sols for s in sol]
        z = eqs[0].lhs() - eqs[0].rhs()
        v = Expression(_sym_s(names[0]))
        mults = []
        # an identity (x == x: every x, the solution x == r1) has multiplicity
        # 1, as in Sage, not the loop's cap 1001 (R2-SYMALG-F3)
        identity = _call("is_zero", z._s)[0] == "1" or bool(z.simplify_full() == 0)
        for s in out:
            if s.lhs()._op()[0] != "symbol" or identity:
                mults.append(1)
                continue
            m, d = 0, z
            while True:
                d = d.diff(v)
                m += 1
                if _call("is_zero", d.subs({v: s.rhs()})._s)[0] != "1":
                    break
                if m > 1000:
                    raise NotImplementedError("solve: the multiplicity of %s is not determined" % s)
            mults.append(m)
        return out, mults
    if kw.get("solution_dict"):
        return _solution_dicts(sols, 1 if one else len(names))
    if len(names) == 1 and not many:
        return [s for sol in sols for s in sol]
    return [list(sol) for sol in sols]


def _solution_dicts(sols, nvars):
    """Each solution [x == ..., y == ..., conditions...] as a _SolutionDict
    keeping its conditions and integer parameters (a system's dictionaries
    were plain, without them: the review's SOLVE2-F3)."""
    out = []
    for sol in sols:
        assign, extra = sol[:nvars], sol[nvars:]
        # an unresolved 0 == f is no solution to put in a dictionary ({0: f}
        # read as a root: R2-SYMALG-F3)
        bad = [s for s in assign if s._op()[0] != "rel:Eq" or s.lhs()._op()[0] != "symbol"]
        if bad:
            raise NotImplementedError("solve: no explicit solution for %s (solution_dict needs one)" % ", ".join(str(s) for s in bad))
        conds = [c for s in assign if isinstance(s, Solution) for c in s.conditions()] + list(extra)
        params = []
        for s in assign:
            if isinstance(s, Solution):
                params += [p for p in s._params if p not in params]
        out.append(_SolutionDict({s.lhs(): s.rhs() for s in assign}, conds, params))
    return out


def _assumed_real(x):
    """Whether the assumptions make x real: a feature such as 'real' or
    'positive', or an inequality with a side c*x + d, c != 0 and d real
    constants (an inequality relates real sides; one mentioning x, as
    x*x < 0 or I*x > 0, does not make x real: the review's ABS-F1)."""
    v = Expression(_sym_s(x))
    for r in _ASSUMPTIONS:
        if isinstance(r, _Feature):
            if str(r._v) == x and r._kind in ("real", "positive", "negative", "integer", "rational", "even", "odd"):
                return True
        elif isinstance(r, Expression) and r._op()[0] in ("rel:Lt", "rel:Le", "rel:Gt", "rel:Ge") and x in r._names():
            for side in (r.lhs(), r.rhs()):
                c = side.diff(v)
                d = side - c * v
                if x in d._names() or c.variables() or d.variables():
                    continue
                # (c proved nonzero, not merely not shown zero: log(2) +
                # log(3) - log(6) is 0, and c*x > -1 no restriction on x)
                if _decide(c != 0) is True and _call("is_zero", c.imag_part()._s)[0] == "1" and _call("is_zero", d.imag_part()._s)[0] == "1":
                    return True
    return False


def _find_abs(e, x):
    """The argument u of some abs(u) in e with u depending on x, or None."""
    op = e._op()
    if op[0] == "fun:abs" and len(op) == 2:
        u = Expression(op[1])
        if x in u._names():
            return u
    for c in op[1:]:
        r = _find_abs(Expression(c), x)
        if r is not None:
            return r
    return None


_REAL_FUNS = frozenset(("fun:" + f for f in ("abs", "sin", "cos", "tan", "sinh", "cosh", "tanh", "arctan", "exp")))


def _real_given(u, x):
    """Whether u is shown real for real x (and the other symbols assumed
    real): built from them and real constants by +, *, integer powers, powers
    of a positive constant, and functions real on the reals.  False when not
    shown (abs(x + I) and abs(sqrt(x)) were split as if real: ABS-F1)."""
    op = u._op()
    k = op[0]
    if not u.variables():
        return _call("is_zero", u.imag_part()._s)[0] == "1"
    if k == "symbol":
        n = u._names()
        return len(n) == 1 and (n[0] == x or _assumed_real(n[0]))
    if k in ("add", "mul"):
        return all(_real_given(Expression(c), x) for c in op[1:])
    if k == "pow":
        b, e = Expression(op[1]), Expression(op[2])
        if e.variables():
            # b^e with b a positive constant (2^x, e^x)
            return not b.variables() and _decide(b > 0) is True and _real_given(e, x)
        return _re.match(r"^n-?[0-9]+/1;$", op[2]) is not None and _real_given(b, x)
    if k == "fun:abs":
        return True
    if k in _REAL_FUNS and len(op) == 2:
        return _real_given(Expression(op[1]), x)
    return False


def _solve_abs(eq, u, x):
    """eq in a real x with abs(u), u real for real x: the solutions of eq
    with abs(u) = u where u >= 0 and with abs(u) = -u where u < 0 (Sage's
    solve(abs(x) == 2, x) is [x == -2, x == 2] for every x, though |x| = 2 is
    a circle in the complex plane; Sagebrush gives that answer where x is
    assumed real).  A branch's unresolved equation keeps the branch's
    condition (0 == -2*x - e^x + e + 2 came from abs(x) = -x and holds at
    x = 1, no solution: ABS-F2)."""
    v = Expression(_sym_s(x))
    # (built, not parsed from its printed form: names of any script)
    a = _one("fun", "abs", u._s)
    out = []
    for rep, cond in ((u, u >= 0), (-u, u < 0)):
        for t in solve(eq.subs({a: rep}), v):
            if not isinstance(t, Solution) or t.lhs()._op()[0] != "symbol":
                conds = list(t._conds) if isinstance(t, Solution) else []
                params = list(t._params) if isinstance(t, Solution) else []
                out.append(Solution(t._s, conds + [cond], params))
                continue
            c = cond.subs({v: t.rhs()})
            keep = list(t._conds)
            if not c.variables():
                verdict = _decide(c)
                if verdict is False:
                    continue
                if verdict is None:
                    keep.append(c)
            else:
                keep.append(c)
            s2 = Solution(t._s, keep, t._params)
            if not any(str(s2) == str(o) for o in out):
                out.append(s2)
    return out


def _with_inequalities(sols, ineqs, eqs=(), names=()):
    """Each solution with the inequalities substituted: dropped if one is
    false, the true ones omitted, the undecided ones kept (as conditions of a
    Solution, or as relations beside a system's solution).  The solution's
    new symbols (r1, n1: names not in the equations) are first renamed apart
    from the inequalities' names (SOLVE2-F4); the requested variables are
    never new (x in solve([y == 1, x > 0], x, y) became x1)."""
    theirs = set(n for q in ineqs for n in q._names())
    mine = set(n for g in eqs for n in g._names()) | set(names)
    out = []
    for sol in sols:
        sol = _rename_new_apart(sol, theirs, mine)
        sub = {}
        for s in sol:
            try:
                if s.lhs()._op()[0] == "symbol":
                    sub[s.lhs()] = s.rhs()
            except Exception:
                pass
        keep, ok = [], True
        for q in ineqs:
            c = q.subs(sub)
            if not c.variables():
                v = _decide(c)
                if v is True:
                    continue
                if v is False:
                    ok = False
                    break
            keep.append(c)
        if not ok:
            continue
        if len(sol) == 1 and isinstance(sol[0], Solution):
            s0 = sol[0]
            out.append([Solution(s0._s, s0._conds + keep, s0._params)])
        else:
            out.append(list(sol) + keep)
    return out


def _rename_new_apart(sol, theirs, mine):
    """sol with its new symbols (names in neither the equations nor theirs's
    owner) that collide with theirs renamed to unused ones."""
    def names(s):
        out = set(s._names())
        if isinstance(s, Solution):
            out |= set(s._params)
            for c in s._conds:
                out |= set(c._names())
        return out
    have = set()
    for s in sol:
        have |= names(s)
    clash = sorted((have - mine) & theirs)
    if not clash:
        return sol
    used = have | mine | theirs
    ren = {}
    for n in clash:
        stem = n.rstrip("0123456789") or "r"
        i = 1
        while "%s%d" % (stem, i) in used:
            i += 1
        used.add("%s%d" % (stem, i))
        ren[n] = "%s%d" % (stem, i)
    sub = {Expression(_sym_s(a)): Expression(_sym_s(b)) for a, b in ren.items()}
    out = []
    for s in sol:
        if isinstance(s, Solution):
            out.append(Solution(Expression.subs(s, sub)._s, [Expression.subs(c, sub) for c in s._conds], [ren.get(p, p) for p in s._params]))
        else:
            out.append(s.subs(sub))
    return out


def _system_out(sols, names, kw):
    if kw.get("multiplicities"):
        raise NotImplementedError("solve: multiplicities=True for one equation in one variable")
    if kw.get("solution_dict"):
        return _solution_dicts(sols, len(names))
    return [list(sol) for sol in sols]


def _solve_system(zs, names, reserved=()):
    """The solutions of the equations zs == 0 (several equations, or one in
    several variables) that are not linear, as lists [x == ..., y == ...,
    (undecided conditions)], or None.  Polynomial systems over QQ with
    finitely many solutions: a lex Groebner basis and back substitution.
    Otherwise substitution: an equation solved for one variable, substituted
    into the others, recursively; equality conditions of those solutions
    become equations, and variables left free become new symbols r1, r2, ...
    (recurring complaints about Sage's solve: [sqrt(x) == 1, x == y] gave
    [], x*y == 0 in x, y lost the solution y == 0, nonlinear systems)."""
    used = set(names) | set(reserved)
    for z in zs:
        used |= set(z._names())

    def fresh(prefix="r"):
        i = 0
        while True:
            i += 1
            n = "%s%d" % (prefix, i)
            if n not in used:
                used.add(n)
                return n

    res = _solve_poly_system(zs, names)
    if res is not None:
        res = [(d, conds, []) for d, conds in res]
    else:
        try:
            res = _solve_subst(zs, names, fresh)
        except _SearchBudget:
            res = None
    if res is None:
        return None
    out = []
    for d, conds, params in res:
        d = dict(d)
        for v in names:
            if v not in d:
                d[v] = Expression(_sym_s(fresh()))
        # values in terms of later-solved variables: substitute until fixed
        for _ in range(len(names)):
            subs = {Expression(_sym_s(k)): w for k, w in d.items()}
            d = {k: w.subs(subs) for k, w in d.items()}
        keep, ok = [], True
        subs = {Expression(_sym_s(k)): w for k, w in d.items()}
        for c in conds:
            c = c.subs(subs)
            if not c.variables():
                v = _decide(c)
                if v is True:
                    continue
                if v is False:
                    ok = False
                    break
            keep.append(c)
        if ok:
            # each value a Solution with the integer parameters in it, so
            # that they stay integers (pi*r1 for sin(x) == 0 allowed r1 =
            # 1/2: the review's SOLVE2-F2); one only in the conditions goes
            # with the first
            sol = []
            for v in names:
                ps = [p for p in params if p in d[v]._names()]
                sol.append(Solution((Expression(_sym_s(v)) == d[v])._s, [], ps))
            loose = [p for p in params if not any(p in s._params for s in sol)]
            if loose:
                sol[0] = Solution(sol[0]._s, [], sol[0]._params + loose)
            sol += keep
            if not any(_same_solution(sol, o) for o in out):
                out.append(sol)
    return out


def _same_solution(a, b):
    return len(a) == len(b) and all(str(s) == str(t) for s, t in zip(a, b))


def _is_zero_expr(z):
    return _call("is_zero", z._s)[0] == "1"


class _SearchBudget(Exception):
    pass


def _solve_subst(zs, names, fresh, depth=0, budget=None):
    """[(assignment dict name -> value, conditions, integer parameters)] or
    None (see _solve_system).  Each step removes a variable, so the depth is
    at most their number; the orderings tried are bounded by a budget of
    steps, past which the whole search stops (a depth cap made every
    ordering of a 13-variable chain fail at its last step and the search
    retry them all: the review's SOLVE2-F7)."""
    if budget is None:
        budget = [400]
    budget[0] -= 1
    if budget[0] < 0:
        raise _SearchBudget()
    rest, pconds = [], []
    for z in zs:
        if _is_zero_expr(z):
            continue
        if not set(z._names()) & set(names):
            c = (z == 0)
            if not z.variables():
                v = _decide(c)
                if v is False:
                    return []
                if v is True:
                    continue
            # an equation in the parameters alone: a condition on them
            # (ask.sagemath 10028: c + d == 0 beside a + b == 1, a == b)
            pconds.append(c)
            continue
        rest.append(z)
    if not rest:
        return [({}, pconds, [])]
    if pconds:
        r = _solve_subst(rest, names, fresh, depth, budget)
        return None if r is None else [(d, pconds + cs, ps) for d, cs, ps in r]
    order = sorted(rest, key=lambda z: (len(set(z._names()) & set(names)), len(str(z))))
    for z in order:
        for v in [n for n in names if n in z._names()]:
            try:
                sols = solve(z == 0, Expression(_sym_s(v)), _raw=True)
            except Exception:
                continue
            if not sols or any(not isinstance(t, Solution) or t.lhs()._op()[0] != "symbol" for t in sols):
                continue
            others = [n for n in names if n != v]
            out = []
            fail = False
            for t in sols:
                val = t.rhs()
                # the solve's own new symbols (r1, n1) renamed apart, its
                # integer parameters kept as such (SOLVE2-F2)
                ren, ints = {}, []
                for nm in set(val._names()) | {nm for c in t.conditions() for nm in c._names()} | set(t._params):
                    if nm not in set(z._names()) and nm not in names and (nm in t._params or nm[0] == "r"):
                        new = fresh("n") if nm in t._params else fresh()
                        ren[Expression(_sym_s(nm))] = Expression(_sym_s(new))
                        if nm in t._params:
                            ints.append(new)
                if ren:
                    val = val.subs(ren)
                conds = [c.subs(ren) for c in t.conditions()]
                eqc = [c for c in conds if c._op()[0] == "rel:Eq" and set(c._names()) & set(others)]
                # (by identity: `in` compares relations through bool(), which
                # recursed under assumptions: SOLVE2-F6)
                other = [c for c in conds if not any(c is e for e in eqc)]
                sub = {Expression(_sym_s(v)): val}
                nxt = [w.subs(sub) for w in rest if w is not z] + [c.lhs() - c.rhs() for c in eqc]
                r = _solve_subst(nxt, others, fresh, depth + 1, budget)
                if r is None:
                    fail = True
                    break
                for d, cs, ps in r:
                    d2 = dict(d)
                    d2[v] = val
                    out.append((d2, other + cs, ints + ps))
            if not fail:
                return out
    return None


def _solve_poly_system(zs, names):
    """For polynomials over QQ in names with finitely many common zeros: the
    zeros through a lex Groebner basis (triangular: the last variable's
    polynomial alone, then the others in turn); None otherwise."""
    try:
        import sage_all as _sa
        R = _sa.PolynomialRing(_sa.QQ, names, order="lex")
        polys = [R(z) for z in zs]
    except Exception:
        return None
    if any(set(z._names()) - set(names) for z in zs):
        return None
    try:
        I = R.ideal(polys)
        dim = I.dimension()
    except Exception:
        return None
    if dim == -1:
        return []
    if dim != 0:
        return None
    G = [Expression(_expr(str(g))._s) for g in I.groebner_basis()]
    partial = [({}, [])]
    for k in range(len(names) - 1, -1, -1):
        v = names[k]
        later = set(names[k:])
        ps = [g for g in G if v in g._names() and set(g._names()) <= later]
        nxt = []
        for d, conds in partial:
            sub = {Expression(_sym_s(n)): w for n, w in d.items()}
            es = [g.subs(sub) for g in ps]
            es = [e for e in es if not _is_zero_expr(e)]
            if not es:
                return None
            e0 = min(es, key=lambda e: (len(str(e))))
            try:
                sols = solve(e0 == 0, Expression(_sym_s(v)), _raw=True)
            except Exception:
                return None
            for t in sols:
                if not isinstance(t, Solution) or t.lhs()._op()[0] != "symbol" or t._conds or t._params:
                    return None  # not explicit: not this way
                w = t.rhs()
                # the other polynomials must vanish there too
                good = True
                for e in es:
                    if e is e0:
                        continue
                    c = e.subs({Expression(_sym_s(v)): w}) == 0
                    dv = _decide(c)
                    if dv is False:
                        good = False
                        break
                    if dv is None:
                        try:
                            if abs(complex(e.subs({Expression(_sym_s(v)): w}))) > 1e-9:
                                good = False
                                break
                        except Exception:
                            return None
                if good:
                    d2 = dict(d)
                    d2[v] = w
                    nxt.append((d2, conds))
        partial = nxt
    return partial


def _int_args(f, args):
    """(f, variable name, a, b) from Sage's ways to ask: integrate(f, x),
    integrate(f, x, a, b), integrate(f, (x, a, b)), integrate(f)."""
    f = _expr(f)
    a = b = None
    if args and isinstance(args[0], (tuple, list)):
        v, a, b = args[0]
    elif len(args) == 3:
        v, a, b = args
    elif len(args) == 1:
        v = args[0]
    elif not args:
        names = f._names()
        if len(names) != 1:
            raise ValueError("specify the variable of integration")
        v = names[0]
    else:
        raise TypeError("integrate(f, x) or integrate(f, x, a, b)")
    return f, _var_name(v), a, b


def integrate(f, *args, **kw):
    """The antiderivative integrate(sin(x)^2, x) = 1/2*x - 1/4*sin(2*x), or
    the definite integral integrate(f, x, a, b) (bounds may be oo).  Found
    by Sagebrush's own integrator (tables, substitution, parts, partial
    fractions, ...); every antiderivative is checked by differentiating
    it.  Without one, the integral stays unevaluated, as in Sage.

    EXAMPLES::

        sage: integrate(x^2, x), integrate(1/x, x), integrate(x*exp(x), x)
        (1/3*x^3, log(x), (x - 1)*e^x)
        sage: integrate(sin(x), x, 0, pi), integral(exp(-x), x, 0, oo)
        (2, 1)
    """
    if _callable(f):
        return f.integral(*args, **kw)
    from _sage_matrix import Vector
    if isinstance(f, Vector):
        return Vector(integrate(e, *args, **kw) for e in f)
    f, v, a, b = _int_args(f, args)
    if a is None:
        return _one("integrate", f._s, v)
    return _one("integrate", f._s, v, _expr(a)._s, _expr(b)._s)


integral = integrate


class IntegrationSteps:
    """How an antiderivative was found: integrate_steps(x*cos(x), x).

    EXAMPLES::

        sage: s = integrate_steps(x*cos(x^2), x)  # sagebrush only
        sage: s.result()  # sagebrush only
        1/2*sin(x^2)
    """

    def __init__(self, rows, f, v):
        self._rows, self._f, self._v = rows, f, v

    def result(self):
        """The antiderivative.

        EXAMPLES::

            sage: integrate_steps(x*exp(x), x).result()  # sagebrush only
            (x - 1)*e^x
        """
        return self._rows[0][4] if self._rows else integrate(self._f, self._v)

    def __repr__(self):
        if not self._rows:
            return "integrate(%s, %s): no elementary antiderivative found" % (self._f, self._v)
        out = []
        for depth, rule, var, f, r in self._rows:
            out.append("%sintegral of %s d%s = %s   [%s]" % ("  " * depth, f, var, r, rule))
        return "\n".join(out)

    __str__ = __repr__

    def _latex_(self):
        lines = []
        for depth, rule, var, f, r in self._rows:
            lines.append("%s\\int %s \\, d%s &= %s && %s" % ("\\quad " * depth, f._latex_(), var, r._latex_(), _rule_latex(rule)))
        return "\\begin{aligned}" + " \\\\ ".join(lines) + "\\end{aligned}"

    def show(self):
        """Show the steps typeset.

        EXAMPLES::

            sage: integrate_steps(x*cos(x^2), x).show()  # random  # sagebrush only
        """
        show_typeset(self)


def _rule_latex(rule):
    """A rule's name for LaTeX: "substitute u = x^2" with its math typeset."""
    def text(t):
        for a, b in (("\\", "\\textbackslash{}"), ("{", "\\{"), ("}", "\\}"), ("^", "\\textasciicircum{}"),
                     ("_", "\\_"), ("&", "\\&"), ("#", "\\#"), ("%", "\\%"), ("$", "\\$")):
            t = t.replace(a, b)
        return "\\text{%s}" % t
    if rule.startswith("substitute ") and " = " in rule:
        lhs, rhs = rule[len("substitute "):].split(" = ", 1)
        try:
            return text("substitute ") + lhs + " = " + _expr(rhs)._latex_()
        except Exception:
            pass
    return text(rule)


def integrate_steps(f, *args):
    """The steps of an antiderivative (rule by rule, with the integrals each
    rule needed), for teaching: integrate_steps(x*exp(x), x).

    EXAMPLES::

        sage: integrate_steps(x*cos(x^2), x).result()  # sagebrush only
        1/2*sin(x^2)
    """
    f, v, a, b = _int_args(f, args)
    rows = []
    rename = {}
    nice = ["u", "w", "t", "s", "r", "p", "q"]
    for line in _call("integrate_steps", f._s, v):
        if not line:
            continue
        depth, rule, var, fi, ri = line.split("\x1e")
        fe, re_ = Expression(fi), Expression(ri)
        # substitution variables (_u0, ...) get short names
        for n in set(fe._names()) | set(re_._names()) | ({var} if var.startswith("_u") else set()):
            if n.startswith("_u") and n not in rename:
                rename[n] = nice[len(rename) % len(nice)]
        sub_ = {Expression(_sym_s(k)): Expression(_sym_s(w)) for k, w in rename.items()}
        rows.append((int(depth), rule.replace("_u0", rename.get("_u0", "u")), rename.get(var, var),
                     fe.subs(sub_) if sub_ else fe, re_.subs(sub_) if sub_ else re_))
    return IntegrationSteps(rows, f, v)


def numerical_integral(f, a, b, max_points=None, params=None, eps_abs=1e-6, eps_rel=1e-6, rule=6, algorithm="qag"):
    """(value, error estimate) of the integral of f from a to b: adaptive
    Gauss-Kronrod (7-15 points, whatever `rule`); infinite bounds through
    x = t/(1 - t^2).  At most max_points subintervals (200 by default); params are passed to
    a Python function f(x, *params).  When the tolerance is not met (or the
    values are not finite) a warning says so: the estimate is then not
    reliable.

    EXAMPLES::

        sage: numerical_integral(x^2, 0, 1)  # abs tol 1e-12
        (0.3333333333333333, 0.0)
        sage: numerical_integral(exp(-x^2), 0, 1)[0]  # abs tol 1e-12
        0.746824132812427
    """
    if algorithm not in ("qag", "qng"):
        raise ValueError("algorithm must be 'qag' or 'qng'")
    if isinstance(f, Expression) or hasattr(f, "_fast_callable"):
        names = f._names() if isinstance(f, Expression) else None
        g = f._fast_callable(names[:1] if names else ([] if names is not None else None))
        if names is not None and not names:
            c = float(f)
            g = lambda t: c
    elif params:
        g = lambda t, _f=f, _p=tuple(params): _f(t, *_p)
    else:
        g = f
    a, b = float(a), float(b)
    if a == b:
        return (0.0, 0.0)
    sign = 1.0
    if a > b:
        a, b, sign = b, a, -1.0
    if _m.isinf(a) or _m.isinf(b):
        # x = t/(1 - t^2) on (-1, 1), or x = a + t/(1 - t) on [0, 1)
        if _m.isinf(a) and _m.isinf(b):
            h = lambda t: g(t / (1 - t * t)) * (1 + t * t) / (1 - t * t) ** 2
            lo, hi = -1.0, 1.0
        elif _m.isinf(b):
            h = lambda t: g(a + t / (1 - t)) / (1 - t) ** 2
            lo, hi = 0.0, 1.0
        else:
            h = lambda t: g(b - (1 - t) / t) / t ** 2
            lo, hi = 0.0, 1.0
    else:
        h, lo, hi = g, a, b
    limit = 1 if algorithm == "qng" else 200 if max_points is None else max(1, int(max_points))
    v, e = _gk_adaptive(h, lo, hi, max(eps_abs, 1e-14), eps_rel, limit)
    if not (_m.isfinite(v) and _m.isfinite(e)):
        import warnings
        warnings.warn("numerical_integral: the integrand is not finite on the interval")
    elif e > max(eps_abs, eps_rel * abs(v)):
        import warnings
        warnings.warn("numerical_integral: the requested tolerance was not met (error estimate %g after %d subintervals); the result is not reliable" % (e, limit))
    return (sign * v, e)


_GK_X = (0.991455371120812639, 0.949107912342758525, 0.864864423359769073, 0.741531185599394440,
         0.586087235467691130, 0.405845151377397167, 0.207784955007898468, 0.0)
_GK_WK = (0.022935322010529225, 0.063092092629978553, 0.104790010322250184, 0.140653259715525919,
          0.169004726639267903, 0.190350578064785410, 0.204432940075298892, 0.209482141084727828)
_GK_WG = (0.129484966168869693, 0.279705391489276668, 0.381830050505118945, 0.417959183673469388)


def _gk15(h, a, b):
    c, r = (a + b) / 2, (b - a) / 2
    fc = h(c)
    k, g = fc * _GK_WK[7], fc * _GK_WG[3]
    for i in range(7):
        x = r * _GK_X[i]
        s = h(c - x) + h(c + x)
        k += _GK_WK[i] * s
        if i % 2 == 1:
            g += _GK_WG[i // 2] * s
    return k * r, abs((k - g) * r)


def _gk_adaptive(h, a, b, eps_abs, eps_rel, limit=200):
    v, e = _gk15(h, a, b)
    parts = [(lo_hi_v_e) for lo_hi_v_e in [(a, b, v, e)]]
    total, err = v, e
    while err > max(eps_abs, eps_rel * abs(total)) and len(parts) < limit:
        # split the interval with the largest error
        k = max(range(len(parts)), key=lambda i: parts[i][3])
        lo, hi, v0, e0 = parts.pop(k)
        mid = (lo + hi) / 2
        v1, e1 = _gk15(h, lo, mid)
        v2, e2 = _gk15(h, mid, hi)
        total += v1 + v2 - v0
        err += e1 + e2 - e0
        parts.append((lo, mid, v1, e1))
        parts.append((mid, hi, v2, e2))
    return float(total), float(abs(err))  # Sage returns Python floats


integral_numerical = numerical_integral


def _dvar(dvar, ivar=None):
    """(function name, variable name) from y = function('y')(x)."""
    dvar = _expr(dvar)
    tag = dvar._op()
    if not tag[0].startswith("fun:"):
        raise TypeError("the dependent variable must be a function, e.g. y = function('y')(x)")
    args = dvar.operands()
    if ivar is None:
        if len(args) != 1:
            raise ValueError("specify the independent variable (ivar=...)")
        ivar = args[0]
    return tag[0][4:], _var_name(ivar)


def _lin_in(f, v):
    """(a, b) with f == a*v + b, or None."""
    f = _expr(f)
    if v not in f._names():
        return _expr(0), f
    if not f.is_polynomial(v) or f.degree(v) != 1:
        return None
    return f.coefficient(v, 1), f.coefficient(v, 0)


def _known_real(c):
    """Whether c is a number known to be real (never a guess)."""
    c = _expr(c)
    return c.is_numeric() and str(c.imag()) == "0"


def _known_nonneg(c):
    """Whether c is known to be real and >= 0: a real number, or positive
    under assume()."""
    c = _expr(c)
    if _known_real(c):
        return bool(c >= 0)
    return _sign_of(c) == 1


def _prod(fs):
    r = _expr(1)
    for f in fs:
        r = r * f
    return r


def _laplace(f, t, s):
    f = _expr(f)
    T = Expression(_sym_s(t)); S = Expression(_sym_s(s))
    if t not in f._names():
        return f / S
    op = f._op(); tag = op[0]
    if tag == "add":
        return sum((_laplace(k, t, s) for k in f.operands()), _expr(0))
    if tag == "symbol":
        return 1 / S**2
    if tag == "mul":
        ks = f.operands()
        g = [k for k in ks if t in k._names()]
        if len(g) < len(ks):
            return _prod(k for k in ks if t not in k._names()) * _laplace(_prod(g), t, s)
        for i, k in enumerate(g):
            rest = _prod(g[:i] + g[i + 1:])
            kop = k._op()
            if kop[0] == "pow" and str(k.operands()[0]) == "e":
                ab = _lin_in(k.operands()[1], t)
                if ab is not None:
                    return e**ab[1] * _laplace(rest, t, s).subs({S: S - ab[0]})
            if kop[0] == "fun:heaviside":
                ab = _lin_in(k.operands()[0], t)
                if ab is not None and str(ab[0]) == "1" and _known_nonneg(-ab[1]):
                    c = -ab[1]
                    return e**(-c * S) * _laplace(rest.subs({T: T + c}), t, s)
        for i, k in enumerate(g):
            rest = _prod(g[:i] + g[i + 1:])
            n = 1 if k.is_symbol() else None
            if k._op()[0] == "pow" and k.operands()[0].is_symbol() and str(k.operands()[1]).isdigit():
                n = int(str(k.operands()[1]))
            if n is not None:
                return (-1)**n * _laplace(rest, t, s).diff(S, n)
        raise NotImplementedError("laplace: no transform known for %s" % f)
    if tag == "pow":
        b, x = f.operands()
        if str(b) == "e":
            ab = _lin_in(x, t)
            if ab is not None:
                return e**ab[1] / (S - ab[0])
        if b.is_symbol() and t not in x._names() and x.is_numeric() and x > -1:
            if str(x).isdigit():
                return _m.factorial(int(str(x))) / S**(x + 1)
            return gamma(x + 1) / S**(x + 1)
        if str(x).isdigit():
            g = f.expand()
            if str(g) != str(f):
                return _laplace(g, t, s)
    if tag.startswith("fun:"):
        name = tag[4:]
        ab = _lin_in(f.operands()[0], t)
        if ab is not None:
            a, b = ab
            if name in ("sin", "cos", "sinh", "cosh") and str(b) != "0":
                # the addition formulas
                fa, fb = {"sin": (sin, cos), "cos": (cos, sin), "sinh": (sinh, cosh), "cosh": (cosh, sinh)}[name]
                sg = -1 if name == "cos" else 1
                return fa(b) * _laplace(fb(a * T) if name in ("sin", "sinh") else fa(a * T), t, s) + \
                    sg * fb(b) * _laplace(fa(a * T) if name in ("sin", "sinh") else fb(a * T), t, s)
            if name == "sin":
                return a / (S**2 + a**2)
            if name == "cos":
                return S / (S**2 + a**2)
            if name == "sinh":
                return a / (S**2 - a**2)
            if name == "cosh":
                return S / (S**2 - a**2)
            if name == "exp":
                return e**b / (S - a)
            if name == "heaviside" and str(a) == "1" and (_known_real(-b) or _known_nonneg(-b)):
                return e**(b * S) / S if _known_nonneg(-b) else 1 / S
    raise NotImplementedError("laplace: no transform known for %s" % f)


def laplace(f, t, s):
    """The Laplace transform of f(t), as a function of s, from a table:
    t^n, e^(a*t), sin, cos, sinh, cosh of a*t + b, heaviside(t - c), sums
    and constant multiples, the shifts e^(a*t)*g and heaviside(t - c)*g,
    and t^n*g; anything else stays unevaluated, laplace(f, t, s), as in Sage.

    EXAMPLES::

        sage: t, s = var('t s')
        sage: laplace(t^2, t, s), laplace(sin(2*t), t, s)
        (2/s^3, 2/(s^2 + 4))
        sage: laplace(t^3*exp(-t), t, s)
        6/(s + 1)^4
    """
    try:
        return _laplace(f, _var_name(t), _var_name(s))
    except NotImplementedError:
        return function("laplace")(_expr(f), _expr(t), _expr(s))


def _ilt_term(F, s, t):
    """The inverse transform of one partial-fraction term."""
    S = Expression(_sym_s(s)); T = Expression(_sym_s(t))
    ks = F.operands() if F._op()[0] == "mul" else [F]
    c, num, den, k = _expr(1), _expr(1), None, 1
    for f in ks:
        if s not in f._names():
            c = c * f
        elif f._op()[0] == "pow" and str(f.operands()[1]).startswith("-") and f.operands()[1].is_numeric():
            nu = -f.operands()[1]
            if f.operands()[0].is_symbol() and not str(nu).isdigit() and len(ks) == 1 + sum(1 for g in ks if s not in g._names()):
                # c/s^nu, nu > 0 not an integer
                return _prod(g for g in ks if s not in g._names()) * T**(nu - 1) / gamma(nu)
            if den is not None or not str(nu).isdigit():
                raise NotImplementedError("inverse_laplace: no inverse known for %s" % F)
            den, k = f.operands()[0], int(str(-f.operands()[1]))
        else:
            num = num * f
    if den is None or not num.is_polynomial(S) or not den.is_polynomial(S):
        raise NotImplementedError("inverse_laplace: no inverse known for %s" % F)
    d = den.degree(S)
    if d == 1 and s not in num._names():
        b1, b0 = den.coefficient(S, 1), den.coefficient(S, 0)
        a = -b0 / b1
        return c * num / b1**k * T**(k - 1) * e**(a * T) / _m.factorial(k - 1)
    if d == 2 and k == 1 and num.degree(S) <= 1:
        lc = den.coefficient(S, 2)
        beta, gam = den.coefficient(S, 1) / lc, den.coefficient(S, 0) / lc
        p, q = num.coefficient(S, 1) / lc, num.coefficient(S, 0) / lc
        h = beta / 2; w2 = gam - h**2; r = q - p * h
        if str(w2) == "0":
            # (p*s + q)/(s + h)^2
            return c * e**(-h * T) * (p + r * T)
        if w2.is_numeric() and w2 < 0:
            w = _expr(-w2).sqrt(); cs, sn = cosh, sinh
        else:
            w = _expr(w2).sqrt(); cs, sn = cos, sin
        return c * e**(-h * T) * (p * cs(w * T) + r / w * sn(w * T))
    raise NotImplementedError("inverse_laplace: no inverse known for %s" % F)


def inverse_laplace(F, s, t):
    """The inverse Laplace transform of F(s), as a function of t: rational
    functions of s through their partial fractions (c/(s - a)^k and
    (p*s + q)/(s^2 + b*s + c)), with e^(-c*s) giving the delay
    heaviside(t - c)*f(t - c); anything else stays unevaluated,
    ilt(F, s, t), as in Sage.

    EXAMPLES::

        sage: t, s = var('t s')
        sage: inverse_laplace(1/(s - 3), s, t), inverse_laplace(1/(s^2 + 1), s, t)
        (e^(3*t), sin(t))
        sage: inverse_laplace(2/s^3, s, t)
        t^2
    """
    try:
        return _inverse_laplace(_expr(F), _var_name(s), _var_name(t))
    except NotImplementedError:
        return function("ilt")(_expr(F), _expr(s), _expr(t))


def _inverse_laplace(F, s, t):
    S = Expression(_sym_s(s)); T = Expression(_sym_s(t))
    F = F.expand()
    groups = {}
    for G in (F.operands() if F._op()[0] == "add" else [F]):
        delay, rest = _expr(0), []
        for k in (G.operands() if G._op()[0] == "mul" else [G]):
            ab = _lin_in(k.operands()[1], s) if k._op()[0] == "pow" and str(k.operands()[0]) == "e" else None
            if ab is not None and str(ab[1]) == "0":
                delay = delay - ab[0]
            else:
                rest.append(k)
        d, H = groups.get(str(delay), (delay, _expr(0)))
        groups[str(delay)] = (d, H + _prod(rest))
    r = _expr(0)
    for delay, H in groups.values():
        try:
            P = H.partial_fraction(s)
            g = sum((_ilt_term(Q, s, t) for Q in (P.operands() if P._op()[0] == "add" else [P])), _expr(0))
        except (NotImplementedError, ValueError, TypeError):
            # symbolic coefficients: term by term
            H = H.expand()
            g = sum((_ilt_term(Q, s, t) for Q in (H.operands() if H._op()[0] == "add" else [H])), _expr(0))
        if str(delay) != "0":
            # the delay rule holds for a known real delay c >= 0 only
            if not _known_nonneg(delay):
                raise NotImplementedError("inverse_laplace: delay %s not known to be nonnegative" % delay)
            g = heaviside(T - delay) * g.subs({T: T - delay})
        r = r + g
    return r


def desolve(de, dvar, ics=None, ivar=None, show_method=False, contrib_ode=False, algorithm="maxima"):
    """Solve an ordinary differential equation for y = function('y')(x):
    desolve(diff(y, x) + y == x, y) = (_C + (x - 1)*e^x)*e^(-x).  First
    order: linear, separable, exact, homogeneous, Bernoulli; second order:
    linear with constant coefficients, or Cauchy-Euler.  ics=[x0, y0] or
    [x0, y0, dy0] for initial conditions.

    EXAMPLES::

        sage: y = function('y')(x)
        sage: desolve(diff(y, x) == y, y)
        _C*e^x
        sage: desolve(diff(y, x, 2) + y == 0, y)
        _K2*cos(x) + _K1*sin(x)
    """
    f, v = _dvar(dvar, ivar)
    ics = [] if ics is None else list(ics)
    r = _one("desolve", _expr(de)._s, f, v, *[_expr(c)._s for c in ics])
    if show_method:
        return [r, "sagebrush"]
    return r


def desolve_rk4(de, dvar, ics=None, ivar=None, end_points=None, step=0.1, output="list", **kw):
    """Numerical solution of y' = f(x, y) (de is f, or an equation in
    y' and y) by the classical Runge-Kutta method: [[x0, y0], [x1, y1], ...]
    from ics=[x0, y0] to end_points (a number, or [a, b]); output='plot' or
    'slope_field' draws it.

    EXAMPLES::

        sage: y = var('y')
        sage: desolve_rk4(x + y, y, ics=[0, 1], end_points=1, step=0.5)  # abs tol 1e-8
        [[0, 1], [0.5, 1.796875], [1.0, 3.4346923828125]]
    """
    ysym, dsym = Expression(_sym_s("_rk_y")), Expression(_sym_s("_rk_dy"))
    if _expr(dvar).is_symbol():
        # dvar a variable y: de is f(x, y) in y' = f(x, y), ivar the other variable
        y = _expr(dvar)
        if ivar is None:
            others = [w for w in _expr(de).variables() if repr(w) != repr(y)]
            ivar = others[0] if others else var("x")
        v = _var_name(ivar)
        rhs = _expr(de).subs({y: ysym})
    else:
        f, v = _dvar(dvar, ivar)
        yx = _expr(dvar)
        de = _expr(de)
        if de.is_relational():
            g = (de.lhs() - de.rhs()).subs({yx.diff(_var_name(v)): dsym})
            sols = solve(g == 0, dsym)
            if not sols:
                raise ValueError("cannot solve the equation for the derivative")
            rhs = sols[0].rhs()
        else:
            rhs = de
        rhs = rhs.subs({yx: ysym})
    F = rhs._fast_callable([v, "_rk_y"])
    ics = list(ics or [0, 0])
    x0, y0 = (float(t) for t in ics)
    if end_points is None:
        a, b = x0, x0 + 10
    elif isinstance(end_points, (list, tuple)):
        a, b = (float(t) for t in end_points)
    else:
        a, b = x0, float(end_points)
    h = float(step)

    def march(x, y, until, h):
        pts = []
        n = int(round(abs(until - x) / h))
        h = (until - x) / n if n else 0
        for _ in range(n):
            k1 = F(x, y)
            k2 = F(x + h / 2, y + h * k1 / 2)
            k3 = F(x + h / 2, y + h * k2 / 2)
            k4 = F(x + h, y + h * k3)
            y = y + h * (k1 + 2 * k2 + 2 * k3 + k4) / 6
            x = x + h
            pts.append([x, y])
        return pts
    back = march(x0, y0, a, h) if a < x0 else []
    # as Sage: Python floats, the initial point as given
    pts = [[t, u] for t, u in reversed(back)] + [ics[:2]] + march(x0, y0, b, h)
    if output == "plot":
        from sage_plot import line
        return line(pts, **kw)
    if output == "slope_field":
        from sage_plot import line
        from sage_plot_fields import plot_slope_field
        ys = [q for _, q in pts]
        g = plot_slope_field(rhs.subs({ysym: Expression(_sym_s("_rk_y"))}), (Expression(_sym_s(v)), a, b), (Expression(_sym_s("_rk_y")), min(ys), max(ys)), **kw)
        return g + line(pts, thickness=2, color="red")
    return pts


def find_root(f, a, b, var=None, xtol=1e-12, maxiter=100):
    """A root of f in [a, b] (Brent's method), a Python float as in Sage.
    If f has the same sign at both ends, as in Sage a local minimum (both
    positive) or maximum (both negative) in [a, b] is found first, and the
    root is sought between it and b.

    EXAMPLES::

        sage: find_root(x^2 - 2, 0, 2)  # abs tol 1e-12
        1.41421356237314
        sage: find_root(cos(x) - x, 0, 1)  # abs tol 1e-12
        0.739085133215156
        sage: find_root(x^2 - 16*sin(x), -5, 5)  # abs tol 1e-12
        2.677132750957597
    """
    return float(_find_root(f, a, b, var, xtol, maxiter))


def _fminbound(g, a, b, xtol=1.48e-8, maxfun=500):
    """(fmin, xmin): a local minimum of g on [a, b] by Brent's bounded method
    (golden section with parabolic steps, as scipy's fminbound)."""
    sqrt_eps = 1.4901161193847656e-08
    golden = 0.5 * (3.0 - 5.0 ** 0.5)
    fulc = a + golden * (b - a)
    nfc, xf = fulc, fulc
    rat = e = 0.0
    x = xf
    fx = g(x)
    fu = fx
    fnfc = ffulc = fx
    xm = 0.5 * (a + b)
    tol1 = sqrt_eps * abs(xf) + xtol / 3.0
    tol2 = 2.0 * tol1
    num = 1
    while abs(xf - xm) > (tol2 - 0.5 * (b - a)) and num < maxfun:
        golden_step = True
        if abs(e) > tol1:
            golden_step = False
            r = (xf - nfc) * (fx - ffulc)
            q = (xf - fulc) * (fx - fnfc)
            p = (xf - fulc) * q - (xf - nfc) * r
            q = 2.0 * (q - r)
            if q > 0.0:
                p = -p
            q = abs(q)
            r = e
            e = rat
            if abs(p) < abs(0.5 * q * r) and p > q * (a - xf) and p < q * (b - xf):
                rat = (p + 0.0) / q
                x = xf + rat
                if (x - a) < tol2 or (b - x) < tol2:
                    si = 1.0 if xm - xf >= 0 else -1.0
                    rat = tol1 * si
            else:
                golden_step = True
        if golden_step:
            e = (a - xf) if xf >= xm else (b - xf)
            rat = golden * e
        si = 1.0 if rat >= 0 else -1.0
        x = xf + si * max(abs(rat), tol1)
        fu = g(x)
        num += 1
        if fu <= fx:
            if x >= xf:
                a = xf
            else:
                b = xf
            fulc, ffulc = nfc, fnfc
            nfc, fnfc = xf, fx
            xf, fx = x, fu
        else:
            if x < xf:
                a = x
            else:
                b = x
            if fu <= fnfc or nfc == xf:
                fulc, ffulc = nfc, fnfc
                nfc, fnfc = x, fu
            elif fu <= ffulc or fulc == xf or fulc == nfc:
                fulc, ffulc = x, fu
        xm = 0.5 * (a + b)
        tol1 = sqrt_eps * abs(xf) + xtol / 3.0
        tol2 = 2.0 * tol1
    return fx, xf


def _callable_1(f, var=None):
    f = _expr(f)
    if f.is_relational():
        f = f.lhs() - f.rhs()
    names = [_var_name(var)] if var is not None else f._names()
    if len(names) != 1:
        raise ValueError("give exactly one variable")
    return f._fast_callable(names)


def find_local_minimum(f, a, b, tol=1.48e-08, maxfun=500):
    """(f(x), x) at a local minimum x of f on [a, b] (Brent's method, as
    Sage's, which uses scipy's fminbound).

    EXAMPLES::

        sage: find_local_minimum((x - 1)^2 + 3, -5, 5)  # abs tol 1e-8
        (3.0, 1.0)
    """
    g = _callable_1(f)
    a, b = float(a), float(b)
    if a > b:
        a, b = b, a
    v, s = _fminbound(g, a, b, tol, maxfun)
    return float(v), float(s)


def find_local_maximum(f, a, b, tol=1.48e-08, maxfun=500):
    """(f(x), x) at a local maximum x of f on [a, b].

    EXAMPLES::

        sage: find_local_maximum(-(x - 2)^2 + 1, 0, 5)  # abs tol 1e-8
        (1.0, 2.0)
    """
    g = _callable_1(f)
    a, b = float(a), float(b)
    if a > b:
        a, b = b, a
    v, s = _fminbound(lambda t: -g(t), a, b, tol, maxfun)
    return -float(v), float(s)


def _find_root(f, a, b, var=None, xtol=1e-12, maxiter=100):
    f = _expr(f)
    if f.is_relational():
        f = f.lhs() - f.rhs()
    names = [_var_name(var)] if var is not None else f._names()
    if len(names) != 1:
        raise ValueError("find_root: give exactly one variable")
    g = f._fast_callable(names)
    a, b = float(a), float(b)
    fa, fb = g(a), g(b)
    if fa == 0:
        return _real(a)
    if fb == 0:
        return _real(b)
    if fa * fb > 0:
        # as Sage: a point in [a, b] where f has the other sign, at a local
        # minimum (maximum), then the root between it and b (find_root on
        # [-5, 5] of x^2 - 16 sin(x) gave up although f < 0 near 1.3)
        lo, hi = (a, b) if a <= b else (b, a)
        if fa > 0:
            v, s = _fminbound(g, lo, hi)
            if v > 0:
                if v < 1e-15:
                    return _real(s)
                raise RuntimeError("f appears to have no zero on the interval")
        else:
            v, s = _fminbound(lambda t: -g(t), lo, hi)
            v = -v
            if v < 0:
                if abs(v) < 1e-15:
                    return _real(s)
                raise RuntimeError("f appears to have no zero on the interval")
        a, b = s, hi
        fa, fb = g(a), g(b)
        if fa == 0:
            return _real(a)
        if fb == 0:
            return _real(b)
        if fa * fb > 0:
            raise RuntimeError("f appears to have no zero on the interval")
    c, fc, d = a, fa, b - a
    e_ = d
    for _ in range(maxiter):
        if fb * fc > 0:
            c, fc, d = a, fa, b - a
            e_ = d
        if abs(fc) < abs(fb):
            a, b, c = b, c, b
            fa, fb, fc = fb, fc, fb
        tol = 2 * 2.2e-16 * abs(b) + xtol / 2
        m = (c - b) / 2
        if abs(m) <= tol or fb == 0:
            return _real(b)
        if abs(e_) >= tol and abs(fa) > abs(fb):
            s = fb / fa
            if a == c:
                p, q = 2 * m * s, 1 - s
            else:
                q, r = fa / fc, fb / fc
                p = s * (2 * m * q * (q - r) - (b - a) * (r - 1))
                q = (q - 1) * (r - 1) * (s - 1)
            if p > 0:
                q = -q
            p = abs(p)
            if 2 * p < min(3 * m * q - abs(tol * q), abs(e_ * q)):
                e_, d = d, p / q
            else:
                d = m
                e_ = d
        else:
            d = m
            e_ = d
        a, fa = b, fb
        b += d if abs(d) > tol else (tol if m > 0 else -tol)
        fb = g(b)
    return _real(b)


def _real(v):
    from _sage_lang import RealNumber
    return RealNumber(v)


# Sage's escapes in latex(a string): {\char`\X} for TeX's special characters
_TEXT_ESC = {c: "{\\char`\\%s}" % c for c in "^_$%{}\\~#&"}
_TEXT_ESC[" "] = "{ }"
_TEXT_ESC["-"] = "{-}"


def _latex_text(s, prepaid=0):
    """latex() of a string, as Sage writes it: \\text{\\texttt{...}}, one
    line per row of an array when it has several.  The whole result is
    charged to the display's budget at its exact length (escapes, wrappers,
    the array and its separators) by one scan of s, before any of it, or
    any line of s, is made (LIMIT-SHOW87-2/3); less `prepaid` characters
    when s was itself charged as it was made (a repr walked piece by
    piece)."""
    if not s:
        _charge(1, 0)
        return ""
    lines, chars, nonempty, cur = 1, 0, 0, 0
    for c in s:
        if c == "\n":
            lines += 1
            nonempty += cur > 0
            cur = 0
        else:
            n = len(_TEXT_ESC.get(c, c))
            chars += n
            cur += n
    nonempty += cur > 0
    # each nonempty line \text{\texttt{...}} (16 around it); several lines
    # an array: \begin{array}{l} and a newline (17), \\ and a newline
    # between lines (3), a newline and \end{array} (12)
    total = chars + 16 * nonempty + (0 if lines == 1 else 29 + 3 * (lines - 1))
    _charge(lines, max(0, total - prepaid))
    if lines == 1:
        return _texttt(s)
    return "\\begin{array}{l}\n" + "\\\\\n".join(_texttt(l) if l else "" for l in s.split("\n")) + "\n\\end{array}"


def _texttt(s):
    # (one line of text, already charged by _latex_text)
    return "\\text{\\texttt{%s}}" % "".join(_TEXT_ESC.get(c, c) for c in s)


def _plain_repr_base(v):
    """list, tuple or dict when v is one whose text is that type's own repr
    (the type itself, or a subclass overriding neither __repr__ nor
    __str__); else None."""
    t = type(v)
    for b in (list, tuple, dict):
        if isinstance(v, b):
            return b if t is b or (t.__repr__ is b.__repr__ and t.__str__ is b.__str__) else None
    return None


def _repr_charged(v, path):
    """repr(v), with a list, tuple or dict (those types, or a subclass that
    keeps their repr) walked here piece by piece, each piece charged to the
    display's budget before it is added (LIMIT-SHOW87-2); a container
    inside itself is [...], {...} or (...), as repr writes it."""
    t = _plain_repr_base(v)
    if t is None:
        return _charged(repr(v))
    if id(v) in path:
        return _charged("[...]" if t is list else "{...}" if t is dict else "(...)")
    if len(path) > _sys.getrecursionlimit() // 4:
        raise RecursionError("maximum recursion depth exceeded while getting the repr of an object")
    path = path + (id(v),)
    parts = []
    if t is dict:
        for k, x in dict.items(v):
            _charge(1, 4)
            parts.append(_repr_charged(k, path) + ": " + _repr_charged(x, path))
        return "{" + ", ".join(parts) + "}"
    # (by iteration, as repr: a __repr__ that adds to the list is followed,
    # each entry charged, so endless growth meets the budget; a subclass's
    # entries as its repr reads them, not through an __iter__ of its own)
    for x in (v if type(v) is t else t.__iter__(v)):
        _charge(1, 2)
        parts.append(_repr_charged(x, path))
    if t is tuple:
        return "(" + parts[0] + ",)" if len(parts) == 1 else "(" + ", ".join(parts) + ")"
    return "[" + ", ".join(parts) + "]"


def _charged(t, by="a __repr__"):
    """t, charged to the display's budget (one step, its characters)."""
    _charge(1, len(t), by)
    return t


def _delim(d, side):
    return "\\" + side + d


def _latex_matrix(rows, ncols):
    """A matrix's LaTeX, as Sage writes it (one row per line, the entries'
    LaTeX, the delimiters of latex.matrix_delimiters())."""
    if not rows or not ncols:
        return "()"
    l, r = latex._matrix_delims
    body = " \\\\\n".join(" & ".join(latex(x) for x in row) for row in rows)
    return "%s\\begin{array}{%s}\n%s\n\\end{array}%s" % (_delim(l, "left"), "r" * ncols, body, _delim(r, "right"))


def _latex_vector(entries):
    """A vector's LaTeX, as Sage writes it: \\left(1,\\,2\\right)."""
    l, r = latex._vector_delims
    return "%s%s%s" % (_delim(l, "left"), ",\\,".join(latex(x) for x in entries), _delim(r, "right"))


class _Latex:
    """latex(x): the LaTeX form of x (a LatexExpr string), and the settings
    of Sage's latex object (delimiters, macros, preamble, engine).  The
    settings change what latex() writes (delimiters) or are recorded for a
    LaTeX document (macros, preamble): sagebrush typesets with MathJax or
    KaTeX, not a TeX installation.

    EXAMPLES::

        sage: latex(x^2/2), latex(sqrt(x)), latex(1/2)
        (\\frac{1}{2} \\, x^{2}, \\sqrt{x}, \\frac{1}{2})
        sage: latex(QQ), latex('a string'), latex(latex(1/2))
        (\\Bold{Q}, \\text{\\texttt{a{ }string}}, \\frac{1}{2})
        sage: latex.matrix_delimiters(left='[', right=']'); latex(matrix(ZZ, 2, 2, range(4)))
        \\left[\\begin{array}{rr}
        0 & 1 \\\\
        2 & 3
        \\end{array}\\right]
        sage: latex.matrix_delimiters('(', ')'); latex.matrix_delimiters()
        ['(', ')']
    """

    def __init__(self):
        self._matrix_delims = ["(", ")"]
        self._vector_delims = ["(", ")"]
        self._bb = False
        self._macros = ""
        self._preamble = ""
        self._engine = "latex"

    def __call__(self, v):
        # (one display's budget, shared with the text of the value and with
        # nested displays: steps and characters charged as the LaTeX is
        # built, each piece before it is added (_display_budget,
        # LIMIT-SHOW87-1/2); a container inside itself or nested past the
        # recursion depth raises RecursionError, as Sage's latex())
        with _display_budget.display():
            return _LatexExpr(self._of(v, ()))

    def _of(self, v, path):
        # LaTeX already, and the _latex_ protocol (also of a str subclass),
        # before a string is escaped as text
        if isinstance(v, _LatexExpr):
            return _charged(str(v))
        if hasattr(v, "_latex_"):
            # (its result as text, as before: a _latex_ may return 7)
            return _charged(str(v._latex_()), "a _latex_")
        if isinstance(v, str):
            return _latex_text(v)
        if isinstance(v, _Fraction):
            return _charged(_expr(v)._latex_())
        # (a list, tuple or dict of exactly that type, as Sage dispatches,
        # or a sagebrush stand-in for one of Sage's (_latex_container); a
        # subclass of the user's is its text, below)
        if type(v) in (list, tuple, dict) or (isinstance(v, (list, tuple, dict)) and getattr(type(v), "_latex_container", False)):
            if id(v) in path or len(path) > _sys.getrecursionlimit() // 4:
                raise RecursionError("maximum recursion depth exceeded")
            path = path + (id(v),)
            parts = []
            if isinstance(v, dict):
                # (the dict's own iterator: a _latex_ that changes its keys
                # meets its RuntimeError)
                for k, t in v.items():
                    _charge(1, 3, "a _latex_")
                    parts.append("%s : %s" % (self._of(k, path), self._of(t, path)))
                o, c = "\\left\\{", "\\right\\}"
            else:
                # (by iteration, as before (a subclass's __iter__ is used): a
                # _latex_ that adds to the list is followed, each entry
                # charged, so endless growth meets the budget)
                for x in v:
                    _charge(1, 2, "a _latex_")
                    parts.append(self._of(x, path))
                o, c = ("\\left[", "\\right]") if isinstance(v, list) else ("\\left(", "\\right)")
            _charge(1, 14, "a _latex_")
            return o + ", ".join(parts) + c
        # Python's own values as Sage writes them: None and booleans upright,
        # numbers as they print, anything else as its text (\\texttt), never
        # its bare str as math
        if v is None or isinstance(v, bool):
            return _charged("\\mathrm{%s}" % v)
        if isinstance(v, (int, float)):
            return _charged(str(v))
        if _plain_repr_base(v) is not None:
            # (a subclass keeping list's, tuple's or dict's repr: that text,
            # walked and charged piece by piece first, then as text)
            s = _repr_charged(v, path)
            return _latex_text(s, len(s))
        return _latex_text(str(v))

    def __repr__(self):
        return "LaTeX definitions"

    def matrix_delimiters(self, left=None, right=None):
        """The delimiters of matrices: set them, or (no arguments) get them."""
        if left is None and right is None:
            return list(self._matrix_delims)
        if left is not None:
            self._matrix_delims[0] = left
        if right is not None:
            self._matrix_delims[1] = right

    def vector_delimiters(self, left=None, right=None):
        """The delimiters of vectors: set them, or (no arguments) get them."""
        if left is None and right is None:
            return list(self._vector_delims)
        if left is not None:
            self._vector_delims[0] = left
        if right is not None:
            self._vector_delims[1] = right

    def blackboard_bold(self, t=None):
        """Whether \\Bold is blackboard bold (\\mathbb) when typeset; latex()
        itself writes \\Bold{Q} either way, as Sage's does."""
        if t is None:
            return self._bb
        self._bb = bool(t)

    def add_macro(self, macro):
        """Add a macro definition (\\newcommand...) to extra_macros()."""
        if macro not in self._macros:
            self._macros += macro

    def extra_macros(self, macros=None):
        """The extra macros (a string): set them, or (no argument) get them."""
        if macros is None:
            return self._macros
        self._macros = macros

    def add_to_preamble(self, s):
        """Add s to the extra LaTeX preamble."""
        self._preamble += s

    def extra_preamble(self, s=None):
        """The extra preamble (a string): set it, or (no argument) get it."""
        if s is None:
            return self._preamble
        self._preamble = s

    def add_package_to_preamble_if_available(self, package):
        """Adds nothing here: there is no TeX installation to find the
        package in (Sage, without the package, also adds nothing)."""
        return None

    def engine(self, e=None):
        """The TeX engine's name: set it, or (no argument) get it."""
        if e is None:
            return self._engine
        if e not in ("latex", "pdflatex", "xelatex", "lualatex"):
            raise ValueError("%r is not a supported LaTeX engine. Use latex, pdflatex, xelatex, or lualatex" % (e,))
        self._engine = e


latex = _Latex()


class SignError(ArithmeticError):
    """oo*0, oo - oo: arithmetic of infinity without a value (as Sage's
    sage.rings.infinity.SignError).

    EXAMPLES::

        sage: oo * 0  # sagebrush only
        Traceback (most recent call last):
        ...
        _sage_expr.SignError: cannot multiply infinity by zero
    """


_SIGN_ERRORS = {"mul": "cannot multiply infinity by zero", "div": "cannot multiply infinity by zero",
                "add": "cannot add infinity to minus infinity", "sub": "cannot add infinity to minus infinity"}


class _LatexExpr(str):
    def __repr__(self):
        return str(self)
