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
        return "n%d/1;" % v
    if isinstance(v, _Fraction):
        return "n%d/%d;" % (v.numerator, v.denominator)
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


def _relop(sym):
    return {"Eq": "==", "Ne": "!=", "Lt": "<", "Le": "<=", "Gt": ">", "Ge": ">="}[sym]


# ------------------------------------------------------------------ Expression

class Expression:
    """An element of Sage's symbolic ring."""

    __slots__ = ("_s", "_repr", "_fast", "__weakref__")

    def __init__(self, s):
        self._s, self._repr, self._fast = s, None, None

    def __reduce__(self):
        return (Expression, (self._s,))

    def parent(self):
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
    def __abs__(self): return _one("fun", "abs", self._s)

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
        return hash(self._s)

    def __bool__(self):
        op = self._op()
        if op[0].startswith("rel:"):
            kind = _relop(op[0][4:])
            a, b = Expression(op[1]), Expression(op[2])
            if kind in ("==", "!="):
                z = _call("is_zero", (a - b)._s)[0] == "1"
                if not z and kind == "==" and not (a - b).variables():
                    # different constants are different unless numerically equal
                    try:
                        z = abs(complex(a - b)) == 0
                    except (TypeError, ValueError):
                        pass
                return z if kind == "==" else not z
            if (a - b).variables():
                return False
            try:
                u, v = float(a), float(b)
            except (TypeError, ValueError):
                return False
            return {"<": u < v, "<=": u <= v, ">": u > v, ">=": u >= v}[kind]
        return _call("is_zero", self._s)[0] != "1"

    def lhs(self):
        op = self._op()
        if not op[0].startswith("rel:"):
            raise AttributeError("lhs: not a relation")
        return Expression(op[1])

    def rhs(self):
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
        return _call("latex", self._s)[0]

    def _repr_latex_(self):
        return "$" + self._latex_() + "$"

    def __format__(self, spec):
        return format(str(self), spec)

    # --- structure
    def _op(self):
        return _call("operator", self._s)

    def variables(self):
        return tuple(Expression(_sym_s(n)) for n in _call("variables", self._s) if n)

    arguments = args = variables

    def _names(self):
        return [n for n in _call("variables", self._s) if n]

    def operator(self):
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
        return [Expression(s) for s in self._op()[1:]]

    def number_of_operands(self):
        return len(self._op()) - 1

    nops = number_of_operands

    def is_symbol(self):
        return self._s.startswith("s")

    def is_numeric(self):
        return self._s[0] in "nzfg"

    def is_constant(self):
        return not self._names()

    def is_relational(self):
        return self._s.startswith("R")

    def is_zero(self):
        return _call("is_zero", self._s)[0] == "1"

    def is_trivial_zero(self):
        return self._s == "n0/1;"

    def is_integer(self):
        v = _py_number(self._s)
        return isinstance(v, int) and not isinstance(v, float)

    def is_rational_expression(self):
        return True

    def is_polynomial(self, var):
        try:
            self.coefficients(var)
            return True
        except ValueError:
            return False

    # --- substitution and evaluation
    def subs(self, *args, **kw):
        """subs(x=2), subs({x: 2}), subs(x == 2), subs([x == 1, y == 2])."""
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
        """f(2), f(x=2): substitute (positionally, in the order of variables())."""
        names = self._names()
        if len(args) > len(names):
            raise ValueError("the number of arguments must be less than or equal to %d" % len(names))
        d = {Expression(_sym_s(n)): a for n, a in zip(names, args)}
        return self.subs(d, **kw)

    def n(self, digits=None, prec=None):
        """The numerical value: an element of RR, or of CC if it is complex."""
        if self.is_relational():
            return _one("rel", _relop(self._op()[0][4:]), _expr(self.lhs().n())._s, _expr(self.rhs().n())._s)
        if self._names():
            return self._n_partial()
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
        v = _py_number(self._s)
        if v is None:
            raise TypeError("self must be a numeric expression")
        return v

    def _fast_callable(self, names=None):
        """A Python function of the variables (in sorted order) computing this
        expression in floating point (for plots)."""
        names = list(names) if names is not None else self._names()
        if self._fast is None or self._fast[0] != names:
            src = "lambda %s: %s" % (", ".join("_v_" + n for n in names), _call("pysrc", self._s)[0])
            self._fast = (names, eval(src, _FAST_GLOBALS))
        return self._fast[1]

    # --- calculus
    def diff(self, *args):
        """diff(x), diff(x, 2), diff(x, y), diff(x, 2, y, 3); with no
        argument, in the only variable."""
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

    def gradient(self, vars=None):
        from _sage_matrix import vector
        vs = vars or self.variables()
        return vector([self.diff(v) for v in vs])

    def hessian(self):
        from _sage_matrix import matrix
        vs = self.variables()
        return matrix([[self.diff(u).diff(v) for v in vs] for u in vs])

    def taylor(self, *args):
        """taylor(x, a, n) or taylor((x, a), (y, b), n) (one variable here)."""
        if len(args) == 3:
            v, a, n = args
        elif len(args) == 2 and isinstance(args[0], (tuple, list)):
            (v, a), n = args
        else:
            raise ValueError("taylor(x, a, n): expected a variable, a point and an order")
        return _one("taylor", self._s, _var_name(v), _expr(a)._s, str(int(n)))

    def series(self, v, n):
        """The series to order n (in x - a for v = (x == a)), with an O-term."""
        if isinstance(v, Expression) and v.is_relational():
            var, a = v.lhs(), v.rhs()
        else:
            var, a = v, 0
        t = self.taylor(var, a, int(n) - 1)
        return _SeriesExpr(t, _expr(var), _expr(a), int(n))

    def limit(self, *args, dir=None, **kw):
        """limit(x=a), limit(x=a, dir='+'), limit(x == a)."""
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
        return solve(self, v, **kw)

    def roots(self, x=None, ring=None, multiplicities=True):
        """The roots of a polynomial equation with multiplicities, [(root, m), ...]."""
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
        return find_root(self, a, b, var)

    def integrate(self, *args, **kw):
        return integrate(self, *args, **kw)

    integral = integrate

    def plot(self, *args, **kw):
        from sage_plot import plot
        return plot(self, *args, **kw)

    # --- algebra
    def expand(self):
        if self.is_relational():
            return self._map_rel("expand")
        return _one("expand", self._s)

    def _map_rel(self, op):
        tag = _relop(self._op()[0][4:])
        return _one("rel", tag, _call(op, self.lhs()._s)[0], _call(op, self.rhs()._s)[0])

    def factor(self):
        return _one("factor", self._s)

    def simplify(self):
        return self  # Sage's simplify() only applies Maxima's simplification

    def simplify_full(self):
        if self.is_relational():
            return self._map_rel("simplify_full")
        return _one("simplify_full", self._s)

    full_simplify = simplify_full

    def simplify_rational(self):
        return _one("simplify_rational", self._s)

    rational_simplify = simplify_rational

    def simplify_trig(self):
        return _one("simplify_trig", self._s)

    trig_simplify = simplify_trig

    def combine(self):
        return _one("together", self._s)

    def numerator(self):
        return _one("numerator", self._s)

    def denominator(self):
        return _one("denominator", self._s)

    def numerator_denominator(self):
        return self.numerator(), self.denominator()

    def degree(self, x):
        return int(_call("degree", self._s, _var_name(x))[0])

    def coefficient(self, x, n=1):
        return _one("coefficient", self._s, _var_name(x), str(int(n)))

    coeff = coefficient

    def list(self, x=None):
        """The coefficients of a polynomial in x, constant term first."""
        x = _var_name(x if x is not None else self._default_var())
        return [Expression(s) for s in _call("coefficients", self._s, x)]

    def coefficients(self, x=None, sparse=True):
        """[[c, n], ...] for the nonzero terms c*x^n (sparse=False: list())."""
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
        """This expression as a polynomial (Sage's f.polynomial(QQ))."""
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
        raise NotImplementedError("power_series")

    def real(self):
        return _real_imag(self, 0)

    def imag(self):
        return _real_imag(self, 1)

    real_part, imag_part = real, imag

    def conjugate(self):
        return self.real() - Expression(_call("const", "I")[0]) * self.imag()

    def abs(self):
        return abs(self)

    def sqrt(self):
        return self ** _Fraction(1, 2)

    def exp(self):
        return _one("fun", "exp", self._s)

    def log(self, b=None):
        r = _one("fun", "log", self._s)
        return r if b is None else r / _one("fun", "log", _expr(b)._s)

    def show(self):
        from sage_plot import show
        return show(self)


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


class _SeriesExpr(Expression):
    """A truncated series: prints the polynomial part plus O(x^n)."""

    __slots__ = ("_var", "_at", "_order")

    def __init__(self, t, var, at, order):
        Expression.__init__(self, t._s)
        self._var, self._at, self._order = var, at, order

    def _terms(self, latex):
        # Sage's form: ascending powers of (x - a), numeric coefficients
        # written out (1*x) and parenthesized unless positive: (-1/6)*x^3
        v, a = self._var, self._at
        base = v - a
        body = Expression(self._s).subs({v: v + a}).expand()
        out = []
        for i, c in enumerate(body.list(v)):
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
        return Expression(self._s)


class _SymbolicRing:
    def __repr__(self):
        return "Symbolic Ring"

    def __call__(self, v):
        return _expr(v)

    def var(self, *names):
        return var(*names)

    def _latex_(self):
        return "\\text{SR}"


SR_parent = _SymbolicRing()


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

def var(*names, **kw):
    """var('x y') or var('x', 'y'): symbolic variables, also defined in __main__."""
    if len(names) == 1 and isinstance(names[0], (list, tuple)):
        names = tuple(names[0])
    if len(names) == 1 and isinstance(names[0], str):
        names = names[0].replace(",", " ").split()
    for n in names:
        if not n.isidentifier():
            raise ValueError("The name \"%s\" is not a valid Python identifier." % n)
    vs = tuple(Expression(_sym_s(n)) for n in names)
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
        if all(not isinstance(a, Expression) and not _is_poly(a) for a in args):
            v = _py_number(r._s)
            if v is not None:
                return v
        return r
    f.__name__ = name
    return f


_functions = {}


def _register(names, numeric=None):
    f = _function(names[0], numeric)
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
    """log(x), the natural logarithm; log(x, b) = log(x)/log(b)."""
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


def function(name, nargs=None):
    """function('f'): an undefined symbolic function f(x)."""
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

def _poly_or(f):
    return _expr(f) if _is_poly(f) else f


def diff(f, *args):
    """diff(f, x), diff(f, x, 2), diff(f, x, y)."""
    f = _poly_or(f)
    if not isinstance(f, Expression):
        if hasattr(f, "derivative"):
            return f.derivative(*args)
        return 0
    return f.diff(*args)


derivative = diff


def expand(f):
    f = _poly_or(f) if not hasattr(f, "expand") or isinstance(f, Expression) else f
    return f.expand() if hasattr(f, "expand") else f


def simplify(f):
    return f.simplify() if hasattr(f, "simplify") else f


def taylor(f, *args):
    return _expr(f).taylor(*args)


def limit(f, *args, dir=None, **kw):
    return _expr(f).limit(*args, dir=dir, **kw)


lim = limit


def solve(f, *args, **kw):
    """solve(x^2 == 4, x) -> [x == -2, x == 2]; solve([eqs], x, y) ->
    [[x == ..., y == ...], ...]; solution_dict=True for dictionaries."""
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
    it.  Without one, the integral stays unevaluated, as in Sage."""
    f, v, a, b = _int_args(f, args)
    if a is None:
        return _one("integrate", f._s, v)
    return _one("integrate", f._s, v, _expr(a)._s, _expr(b)._s)


integral = integrate


class IntegrationSteps:
    """How an antiderivative was found: integrate_steps(x*cos(x), x)."""

    def __init__(self, rows, f, v):
        self._rows, self._f, self._v = rows, f, v

    def result(self):
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
            lines.append("%s\\int %s \\, d%s &= %s && \\text{%s}" % ("\\quad " * depth, f._latex_(), var, r._latex_(), rule))
        return "\\begin{aligned}" + " \\\\ ".join(lines) + "\\end{aligned}"

    def _repr_latex_(self):
        return "$$" + self._latex_() + "$$"


def integrate_steps(f, *args):
    """The steps of an antiderivative (rule by rule, with the integrals each
    rule needed), for teaching: integrate_steps(x*exp(x), x)."""
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


def numerical_integral(f, a, b, max_points=87, params=None, eps_abs=1e-6, eps_rel=1e-6, rule=6, algorithm="qag"):
    """(value, error estimate) of the integral of f from a to b: adaptive
    Gauss-Kronrod (7-15 points); infinite bounds through x = t/(1 - t^2)."""
    if isinstance(f, Expression) or hasattr(f, "_fast_callable"):
        names = f._names() if isinstance(f, Expression) else None
        g = f._fast_callable(names[:1] if names else [])
        if names is not None and not names:
            c = float(f)
            g = lambda t: c
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
    v, e = _gk_adaptive(h, lo, hi, max(eps_abs, 1e-14), eps_rel)
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
    [x0, y0, dy0] for initial conditions."""
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
    'slope_field' draws it."""
    f, v = _dvar(dvar, ivar)
    yx = _expr(dvar)
    ysym, dsym = Expression(_sym_s("_rk_y")), Expression(_sym_s("_rk_dy"))
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
    """A root of f in [a, b] (Brent's method); f must change sign."""
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
    """The LaTeX form of v (a LatexExpr string)."""
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
