"""Sage's symbolic ring: x = var('x'); diff(sin(x^2)/x, x).

An Expression is a handle on an expression of the Rust symbolic engine
(engine/sym): it holds the engine's canonical serialization, so equal
expressions have equal strings, and every operation is one stateless call
into the engine (simplification, printing, calculus, solving all happen
there).  This module only translates between Python values and the engine
and gives the results Sage's methods and printing.
"""

import math as _m
from fractions import Fraction as _Fraction

try:  # the CPython package
    from sagebrush._native import sym_call as _raw
except ImportError:  # pyjs: the engine is linked into the runtime
    import _sbengine
    _raw = _sbengine.sym

_SEP = "\x1f"
_ERRORS = {"ZeroDivisionError": ZeroDivisionError, "ValueError": ValueError,
           "NotImplementedError": NotImplementedError}


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


def _to_s(v):
    """The engine serialization of a Python value, or None."""
    if isinstance(v, Expression):
        return v._s
    if isinstance(v, bool):
        return "n%d/1;" % int(v)
    if isinstance(v, int):
        return "n%d/1;" % int(v)
    if isinstance(v, _Fraction):
        # exact ints first: formatting an int subclass must not round it
        return "n%d/%d;" % (int(v.numerator), int(v.denominator))
    if isinstance(v, float):
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
            return "n%d/%d;" % (int(p), int(q)) if int(q) > 0 else None
        except (TypeError, ValueError):
            return None
    return None


def _expr(v):
    """v as an Expression (SR(v)); TypeError if it has no symbolic form."""
    if isinstance(v, Expression):
        return v
    if isinstance(v, str):
        return Expression(_call("parse", v)[0])
    if type(v).__name__ == "SymbolicFunction" and not v._vec:
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

    __slots__ = ("_s", "_repr", "_fast", "__weakref__")

    def __init__(self, s):
        self._s, self._repr, self._fast = s, None, None

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
        return _one(op, o, self._s) if rev else _one(op, self._s, o)

    def __add__(self, o): return self._bin("add", o)
    def __radd__(self, o): return self._bin("add", o, True)
    def __sub__(self, o): return self._bin("sub", o)
    def __rsub__(self, o): return self._bin("sub", o, True)
    def __mul__(self, o): return self._bin("mul", o)
    def __rmul__(self, o): return self._bin("mul", o, True)
    def __truediv__(self, o): return self._bin("div", o)
    def __rtruediv__(self, o): return self._bin("div", o, True)
    def __pow__(self, o, mod=None): return self._bin("pow", o)
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
        # hashes broke dictionaries and sets: the systematic review's API-F2)
        s = self._s
        if s.startswith("n") and s.endswith(";") and "/" in s:
            try:
                num, den = s[1:-1].split("/")
                return hash(_Fraction(int(num), int(den)))
            except ValueError:
                pass
        return hash(s)

    def __bool__(self):
        op = self._op()
        if op[0].startswith("rel:"):
            kind = _relop(op[0][4:])
            a, b = Expression(op[1]), Expression(op[2])
            if kind in ("==", "!="):
                z = _call("is_zero", (a - b)._s)[0] == "1"
                if not z and kind == "==" and not (a - b).variables() and _call("const_sign", (a - b)._s)[0] == "":
                    # constants of undecided sign: equal if they agree to
                    # far more than double precision (never from an
                    # underflowed or cancelled double)
                    z = _numerically_equal(a, b)
                if not z and _ASSUMPTIONS and (a - b).variables():
                    z = bool(_assume_rewrite(a - b).expand() == 0)
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
            if t == n:
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

            sage: (x - x).is_zero(), (sin(x)^2 + cos(x)^2 - 1).is_zero()  # needs maxima
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
        re, im = _call("n", self._s)
        re, im = float(re), float(im)
        if im == 0:
            from _sage_lang import RealNumber
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
        re, im = _call("n", self._s)
        if float(im) != 0:
            raise TypeError("unable to simplify to float approximation")
        return float(re)

    def __complex__(self):
        if self._names():
            raise TypeError("unable to simplify to complex approximation")
        re, im = _call("n", self._s)
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
        """
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
            if isinstance(a, (list, tuple)):
                r = r.diff(*a)
                continue
            last = _var_name(a)
            r = _one("diff", r._s, last, "1")
        return r

    derivative = differentiate = diff

    def sum(self, *args, **kw):
        """The symbolic sum over a variable: f.sum(k, a, b).

        EXAMPLES::

            sage: var('k n'); (k^2).sum(k, 1, n)  # needs maxima
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

            sage: exp(x).taylor(x, 0, 4), sin(x).taylor(x, pi, 3)  # needs maxima
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

            sage: (sin(x)/x).limit(x=0), (1/x).limit(x=0, dir='+'), ((1 + 1/x)^x).limit(x=oo)  # needs maxima
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

            sage: (x^2 - 4).solve(x), (x^2 == 2).solve(x)  # needs maxima
            ([x == -2, x == 2], [x == -sqrt(2), x == sqrt(2)])
        """
        return solve(self, v, **kw)

    def roots(self, x=None, ring=None, multiplicities=True):
        """The roots of a polynomial equation with multiplicities, [(root, m), ...].

        EXAMPLES::

            sage: (x^2 - 1).roots(), ((x - 1)^2*(x + 2)).roots()  # needs maxima
            ([(-1, 1), (1, 1)], [(-2, 1), (1, 2)])
        """
        x = x if x is not None else self.variables()[0]
        f = self.lhs() - self.rhs() if self.is_relational() else self
        out = []
        for s in solve(f == 0, x):
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

            sage: (x + x).simplify(), (x^2/x).simplify()  # needs maxima
            (2*x, x)
        """
        return self  # Sage's simplify() only applies Maxima's simplification

    def simplify_full(self):
        """Full simplification (also full_simplify).

        EXAMPLES::

            sage: (sin(x)^2 + cos(x)^2).simplify_full()  # needs maxima
            1
        """
        if self.is_relational():
            return self._map_rel("simplify_full")
        return _one("simplify_full", self._s)

    full_simplify = simplify_full

    def simplify_rational(self):
        """Simplify as a rational function (also rational_simplify).

        EXAMPLES::

            sage: ((x^2 - 1)/(x + 1)).simplify_rational()  # needs maxima
            x - 1
        """
        return _one("simplify_rational", self._s)

    rational_simplify = simplify_rational

    def simplify_trig(self):
        """Simplify trigonometric expressions (also trig_simplify).

        EXAMPLES::

            sage: (sin(x)^2 + cos(x)^2).simplify_trig(), (2*sin(x)*cos(x)).trig_simplify()  # needs maxima
            (1, 2*cos(x)*sin(x))
        """
        return _one("simplify_trig", self._s)

    trig_simplify = simplify_trig

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
    """What show(expr) displays: typeset math where the page or Jupyter
    can render LaTeX, the text form elsewhere.  (Values print as text, as
    in Sage.)

    EXAMPLES::

        sage: from _sage_expr import show_typeset  # sagebrush only
        sage: show_typeset(x^2)  # random  # sagebrush only
        x^2
    """

    def __init__(self, obj):
        self._obj = obj

    def __repr__(self):
        return repr(self._obj)

    def _repr_latex_(self):
        f = getattr(self._obj, "_latex_", None)
        return "$$" + (f() if f is not None else latex(self._obj)) + "$$"

    def _repr_mimebundle_(self, include=None, exclude=None):
        # the marker: the notebook typesets what show() asked for, and
        # leaves other values with a LaTeX form (2/3) as text, as Sage
        return {"text/latex": self._repr_latex_(), "text/plain": repr(self),
                "application/vnd.sagebrush.typeset": "1"}


def show_typeset(obj):
    """Show obj typeset with LaTeX.

    EXAMPLES::

        sage: from _sage_expr import show_typeset  # sagebrush only
        sage: show_typeset(sqrt(x)/2)  # random  # sagebrush only
        1/2*sqrt(x)
    """
    import builtins
    d = getattr(builtins, "__pyjs_display__", None)
    if d is not None:
        d(Typeset(obj))  # (it prints the text form without a notebook)
        return
    from _graphics import host_display
    if not host_display(Typeset(obj)):
        print(repr(obj))


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

    def __pow__(self, k):
        k = int(k)
        if k < 1:
            raise NotImplementedError("series: only positive integer powers")
        r = self
        for _ in range(k - 1):
            r = r * self
        return r

    def __truediv__(self, o):
        o = _expr(o)
        if str(self._var) in o._names():
            raise NotImplementedError("series: division by a series")
        return self._make(Expression(self._s) / o, self._order)

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
    def __repr__(self):
        return "Symbolic Ring"

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
        """
        if len(names) == 1 and isinstance(names[0], (list, tuple)):
            names = tuple(names[0])
        if len(names) == 1 and isinstance(names[0], str):
            names = names[0].replace(",", " ").split()
        vs = tuple(Expression(_sym_s(n)) for n in names)
        if kw.get("latex_name") is not None:
            for n in names:
                _LATEX_NAMES[n] = str(kw["latex_name"])
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


def _lanczos_gamma(z):
    # Lanczos approximation (g = 7, n = 9): about 15 digits.
    if z < 0.5:
        return _m.pi / (_m.sin(_m.pi * z) * _lanczos_gamma(1 - z))
    z -= 1
    c = (0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
         -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
         1.5056327351493116e-7)
    a = c[0] + sum(c[i] / (z + i) for i in range(1, 9))
    t = z + 7.5
    return _m.sqrt(2 * _m.pi) * t ** (z + 0.5) * _m.exp(-t) * a


_gamma = getattr(_m, "gamma", None) or _lanczos_gamma


def _series_erf(z):
    # Taylor series for |z| <= 2.5; the continued fraction for erfc beyond
    if abs(z) <= 2.5:
        t, s, n = z, z, 0
        while abs(t) > 1e-17 * abs(s):
            n += 1
            t *= -z * z / n
            s += t / (2 * n + 1)
        return 2 / _m.sqrt(_m.pi) * s
    a = abs(z)
    f = 0.0
    for k in range(60, 0, -1):
        f = k / 2 / (a + f)
    r = 1 - _m.exp(-a * a) / _m.sqrt(_m.pi) / (a + f)
    return r if z > 0 else -r


_erf = getattr(_m, "erf", None) or _series_erf


class _Math:
    pass


_M = _Math()
for _k in dir(_m):
    if not _k.startswith("_"):
        setattr(_M, _k, getattr(_m, _k))
_M.gamma, _M.erf = _gamma, _erf


def _sgn(v):
    return (v > 0) - (v < 0)


def _undefined(name):
    raise ValueError("cannot evaluate %s numerically" % name)


_FAST_GLOBALS = {"_m": _M, "_gamma": _gamma, "_sgn": _sgn, "_undefined": _undefined,
                 "__builtins__": {"abs": abs, "complex": complex, "float": float}}


# ------------------------------------------------------------------ constructors

_LATEX_NAMES = {}   # symbol name -> LaTeX (var('th', latex_name=r'\theta'))


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

        sage: assume(x > 0); bool(sqrt(x^2) == x), abs(x)  # needs maxima
        (True, x)
        sage: assumptions()  # needs maxima
        [x > 0]
        sage: forget()  # needs maxima
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

        sage: assume(x > 0); forget(x > 0); assumptions()  # needs maxima
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

        sage: assume(x > 0, x < 1); assumptions()  # needs maxima
        [x > 0, x < 1]
        sage: forget()  # needs maxima
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

        sage: with assuming(x > 0):  # needs maxima
        ....:     abs(x)
        x
        sage: assumptions()  # needs maxima
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
            continue
        if not isinstance(r, Expression):
            continue
        rr = r.subs(sub)
        if rr.variables():
            continue
        try:
            if not bool(rr):
                return False
        except Exception:
            pass
    return True


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
            try:
                if sym_a and b.is_numeric():
                    c = float(b)
                    if k in ("Gt", "Ge") and c >= 0:
                        return 1
                    if k in ("Lt", "Le") and c <= 0:
                        return -1
                if sym_b and a.is_numeric():
                    c = float(a)
                    if k in ("Lt", "Le") and c >= 0:
                        return 1
                    if k in ("Gt", "Ge") and c <= 0:
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
        try:
            k = int(x)
            return 1 if k % 2 == 0 else -1
        except (TypeError, ValueError):
            return None
    if e.is_numeric():
        c = _const_sign(e)
        if c is not None:
            return 1 if c >= 0 else -1
    return None


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
        return any(isinstance(r, Expression) and name in r._names() and r._op()[0][4:] in ("Lt", "Le", "Gt", "Ge") for r in _ASSUMPTIONS)
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


def _function(name, numeric=None, cnumeric=None):
    """A Sage function: numerical on floats, exact or symbolic otherwise
    (sin(0) = 0, sin(pi/6) = 1/2, sin(1) stays sin(1))."""
    def f(*args, **kw):
        if args and all(_numeric_arg(a) or isinstance(a, int) for a in args) and any(_numeric_arg(a) for a in args):
            if numeric is not None and not any(isinstance(a, complex) for a in args):
                try:
                    r = numeric(*[float(a) for a in args])
                    from _sage_lang import RealNumber
                    return RealNumber(r) if isinstance(r, float) else r
                except (ValueError, OverflowError):
                    pass
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
    'gamma': """The gamma function.

    EXAMPLES::

        sage: gamma(5)
        24
        sage: gamma(1/2)
        sqrt(pi)
        sage: gamma(2.5)
        1.32934038817914""",
    'erf': """The error function.

    EXAMPLES::

        sage: erf(0)
        0
        sage: erf(1.0)
        0.842700792949715
        sage: erf(x).diff(x)
        2*e^(-x^2)/sqrt(pi)""",
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
gamma = _register(["gamma"], _gamma)
erf = _register(["erf"], _erf)
sgn = sign = _register(["sgn", "sign"], _sgn)
heaviside = _register(["heaviside"], lambda t: 1.0 if t > 0 else 0.0)


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
    ranges; otherwise the sum stays unevaluated.

    EXAMPLES::

        sage: var('k n')
        (k, n)
        sage: symbolic_sum(k, k, 1, n), symbolic_sum(k^2, k, 1, n)  # needs maxima
        (1/2*n^2 + 1/2*n, 1/3*n^3 + 1/2*n^2 + 1/6*n)
        sage: symbolic_sum((1/3)^k, k, 0, oo), symbolic_sum(binomial(n, k), k, 0, n)  # needs maxima
        (3/2, 2^n)
        sage: symbolic_sum(1/k^2, k, 1, oo), symbolic_sum(x^k/factorial(k), k, 0, oo)  # needs maxima
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
    # q = c * x^k
    r = (q.subs({v: v + 1}) / q).simplify_rational()
    if vn not in r._names():
        c = q.subs({v: 0})
        return c * (r + 1) ** n
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
    return type(f).__name__ == "SymbolicFunction"


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

        sage: simplify(x + x - 1)  # needs maxima
        2*x - 1
    """
    return f.simplify() if hasattr(f, "simplify") else f


def taylor(f, *args):
    """The Taylor polynomial: taylor(f, x, a, n).

    EXAMPLES::

        sage: taylor(1/(1 - x), x, 0, 4), taylor(cos(x), x, 0, 6)  # needs maxima
        (x^4 + x^3 + x^2 + x + 1, -1/720*x^6 + 1/24*x^4 - 1/2*x^2 + 1)
    """
    if _callable(f):
        return f.taylor(*args)
    return _expr(f).taylor(*args)


def limit(f, *args, dir=None, **kw):
    """The limit: limit(f, x=a), dir='+' or '-' for one side (also lim).

    EXAMPLES::

        sage: limit(sin(x)/x, x=0), limit(1/x, x=0, dir='-'), lim((x^2 - 1)/(x - 1), x=1)  # needs maxima
        (1, -Infinity, 2)
    """
    if _callable(f):
        return f.limit(*args, dir=dir, **kw)
    return _expr(f).limit(*args, dir=dir, **kw)


lim = limit


def solve(f, *args, **kw):
    """solve(x^2 == 4, x) -> [x == -2, x == 2]; solve([eqs], x, y) ->
    [[x == ..., y == ...], ...]; solution_dict=True for dictionaries.

    EXAMPLES::

        sage: solve(x^2 == 4, x)  # needs maxima
        [x == -2, x == 2]
        sage: var('y')
        y
        sage: solve([x + y == 3, x - y == 1], x, y)  # needs maxima
        [[x == 2, y == 1]]
    """
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
    names = [_var_name(v) for v in vs]
    eqs = [g if g.is_relational() else g == 0 for g in eqs]
    r = _call("solve", str(len(eqs)), *[g._s for g in eqs], *names)
    k, i, sols = int(r[0]), 1, []
    for _ in range(k):
        m = int(r[i])
        sols.append([Expression(s) for s in r[i + 1:i + 1 + m]])
        i += 1 + m
    if _ASSUMPTIONS:
        sols = [sol for sol in sols if _satisfies(sol)]
    if kw.get("multiplicities"):
        if many or len(names) != 1 or kw.get("solution_dict"):
            raise NotImplementedError("solve: multiplicities=True for one equation in one variable")
        out = [s for sol in sols for s in sol]
        z = eqs[0].lhs() - eqs[0].rhs()
        v = Expression(_call("parse", names[0])[0])
        mults = []
        for s in out:
            if s.lhs()._op()[0] != "symbol":
                mults.append(1)
                continue
            m, d = 0, z
            while True:
                d = d.diff(v)
                m += 1
                if _call("is_zero", d.subs({v: s.rhs()})._s)[0] != "1" or m > 1000:
                    break
            mults.append(m)
        return out, mults
    if kw.get("solution_dict"):
        return [{s.lhs(): s.rhs() for s in sol} for sol in sols]
    if len(names) == 1 and not many:
        return [s for sol in sols for s in sol]
    return [list(sol) for sol in sols]


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


def desolve(de, dvar, ics=None, ivar=None, show_method=False, contrib_ode=False, algorithm="maxima"):
    """Solve an ordinary differential equation for y = function('y')(x):
    desolve(diff(y, x) + y == x, y) = (_C + (x - 1)*e^x)*e^(-x).  First
    order: linear, separable, exact, homogeneous, Bernoulli; second order:
    linear with constant coefficients, or Cauchy-Euler.  ics=[x0, y0] or
    [x0, y0, dy0] for initial conditions.

    EXAMPLES::

        sage: y = function('y')(x)
        sage: desolve(diff(y, x) == y, y)  # needs maxima
        _C*e^x
        sage: desolve(diff(y, x, 2) + y == 0, y)  # needs maxima
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
        sage: desolve_rk4(x + y, y, ics=[0, 1], end_points=1, step=0.5)  # abs tol 1e-8  # needs maxima
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
    """A root of f in [a, b] (Brent's method), a Python float as in Sage; f
    must change sign.

    EXAMPLES::

        sage: find_root(x^2 - 2, 0, 2)  # abs tol 1e-12
        1.41421356237314
        sage: find_root(cos(x) - x, 0, 1)  # abs tol 1e-12
        0.739085133215156
    """
    return float(_find_root(f, a, b, var, xtol, maxiter))


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


def latex(v):
    """The LaTeX form of v (a LatexExpr string).

    EXAMPLES::

        sage: latex(x^2/2), latex(sqrt(x)), latex(1/2)
        (\\frac{1}{2} \\, x^{2}, \\sqrt{x}, \\frac{1}{2})
    """
    if hasattr(v, "_latex_"):
        return _LatexExpr(v._latex_())
    if isinstance(v, _Fraction):
        return _LatexExpr(_expr(v)._latex_())
    if isinstance(v, (list, tuple)):
        inner = ", ".join(latex(t) for t in v)
        return _LatexExpr(("\\left[%s\\right]" if isinstance(v, list) else "\\left(%s\\right)") % inner)
    return _LatexExpr(str(v))


class _LatexExpr(str):
    def __repr__(self):
        return str(self)
