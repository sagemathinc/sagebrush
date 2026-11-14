"""sympy in Sagebrush: a small subset of SymPy's interface over Sagebrush's
own symbolic engine.

It covers single-letter symbols (sympy.abc), arithmetic with integer and
float powers, diff (partial derivatives too), subs, Matrix with jacobian and
subs, conversion to NumPy arrays, and SymPy's printed and LaTeX forms of
these expressions.  Anything else is not part of it; solve, for one, raises
NotImplementedError when called.
"""

import _sage_expr as _E

_COVERED = "symbols from sympy.abc, arithmetic, diff, subs and Matrix (jacobian, subs, NumPy arrays)"


def _not_covered(name):
    return NotImplementedError("sympy.%s is not part of Sagebrush's sympy, which covers %s" % (name, _COVERED))


# ---------------------------------------------------------------------------
# Numbers


def _full(x):
    """A float as SymPy prints a Float on its own: 15 significant digits."""
    if x != x:
        return "nan"
    if x in (float("inf"), float("-inf")):
        return "oo" if x > 0 else "-oo"
    if x == 0:
        return "0.0"
    m, e = ("%.14e" % x).split("e")
    e = int(e)
    if -5 <= e < 15:
        return "%.*f" % (14 - e, x)
    return "%se%+d" % (m, e)


def _short(x):
    """A float as SymPy prints a Float inside a larger expression: 15
    significant digits without trailing zeros (2.0, 4.5)."""
    s = _full(x)
    if "e" in s:
        m, e = s.split("e")
        m = m.rstrip("0")
        return (m + "0" if m.endswith(".") else m) + "e" + e
    if "." in s:
        s = s.rstrip("0")
        if s.endswith("."):
            s += "0"
    return s


def _latex_float(x):
    """A float as SymPy's LaTeX shows it: 1.0 \\cdot 10^{-7} for an exponent."""
    s = _short(x)
    if "e" in s:
        m, e = s.split("e")
        return "%s \\cdot 10^{%d}" % (m, int(e))
    return s


class Float(float):
    """A floating-point number, printed as SymPy prints a Float."""

    __slots__ = ("_digits",)

    def __new__(cls, x, digits=None):
        self = float.__new__(cls, x)
        self._digits = digits
        return self

    def __repr__(self):
        if self._digits is not None:
            return "%.*f" % (self._digits, self)
        return _full(float(self))

    __str__ = __repr__

    def _repr_latex_(self):
        return "$\\displaystyle %s$" % _latex_float(float(self))

    def subs(self, *args):
        return self

    def __round__(self, n=None):
        if n is None:
            return int(round(float(self)))
        return Float(round(float(self), n), max(n, 0))

    def __neg__(self):
        return Float(-float(self))

    def __pos__(self):
        return self

    def __abs__(self):
        return Float(abs(float(self)))


def _float_op(name):
    f = getattr(float, name)

    def op(self, other):
        if isinstance(other, (int, float)):
            r = f(float(self), other)
            if r is NotImplemented:
                return r
            return Integer(0) if r == 0 else Float(r)
        return NotImplemented
    op.__name__ = name
    return op


for _n in ("__add__", "__radd__", "__sub__", "__rsub__", "__mul__", "__rmul__", "__truediv__",
           "__rtruediv__", "__pow__", "__rpow__", "__mod__", "__rmod__", "__floordiv__", "__rfloordiv__"):
    setattr(Float, _n, _float_op(_n))
del _n


class Integer(int):
    """An integer, as SymPy's Integer: an exact quotient of two is a rational."""

    __slots__ = ()

    def __repr__(self):
        return int.__repr__(self)

    __str__ = __repr__

    def _repr_latex_(self):
        return "$\\displaystyle %d$" % self

    def subs(self, *args):
        return self

    def __neg__(self):
        return Integer(-int(self))

    def __pos__(self):
        return self

    def __abs__(self):
        return Integer(abs(int(self)))

    def __truediv__(self, other):
        if isinstance(other, int):
            return _wrap(_E.SR(int(self)) / int(other))
        return NotImplemented if isinstance(other, Expr) else sympify(int(self) / other)

    def __rtruediv__(self, other):
        if isinstance(other, int):
            return _wrap(_E.SR(int(other)) / int(self))
        return sympify(other / int(self))


def _int_op(name):
    f = getattr(int, name)

    def op(self, other):
        if isinstance(other, bool) or not isinstance(other, (int, float)):
            if isinstance(other, bool):
                other = int(other)
            else:
                return NotImplemented
        if isinstance(other, float):
            r = getattr(float, name)(float(self), other)
            return Integer(0) if r == 0 else Float(r)
        r = f(int(self), other)
        return r if r is NotImplemented else sympify(r)
    op.__name__ = name
    return op


for _n in ("__add__", "__radd__", "__sub__", "__rsub__", "__mul__", "__rmul__", "__pow__", "__rpow__",
           "__mod__", "__rmod__", "__floordiv__", "__rfloordiv__"):
    setattr(Integer, _n, _int_op(_n))
del _n


def _number(x):
    """A Python number for an argument of an operation, or None."""
    if isinstance(x, bool):
        return int(x)
    if isinstance(x, (int, float)):
        return x
    k = getattr(getattr(x, "dtype", None), "kind", None)
    if k in ("i", "u"):
        return int(x)
    if k == "f":
        return float(x)
    return None


def _engine(x):
    """The engine value of an operand, or None."""
    if isinstance(x, Expr):
        return x._e
    v = _number(x)
    if v is None:
        return None
    return _E.SR(float(v) if isinstance(v, float) else v)


def _wrap(e):
    """A SymPy value for engine expression e: an int or Float when it is a
    number, an Expr otherwise."""
    if e.is_numeric():
        v = e.pyobject()
        if isinstance(v, int):
            return Integer(v)
        name = type(v).__name__
        if name in ("RealNumber", "RealNumberMP", "RealDoubleElement") or isinstance(v, float):
            return Integer(0) if float(v) == 0 else Float(float(v))
    return Expr(e)


def sympify(x):
    """x as a SymPy value (an Expr, an int or a Float)."""
    if isinstance(x, (Expr, Float, Integer)):
        return x
    v = _number(x)
    if isinstance(v, float):
        return Float(v)
    if v is not None:
        return Integer(v)
    raise TypeError("sympify: %r is not a number or an expression" % (x,))


# ---------------------------------------------------------------------------
# Expressions


class Expr(object):
    """A symbolic expression."""

    __slots__ = ("_e",)

    def __init__(self, e):
        self._e = e

    def _bin(self, other, f):
        o = _engine(other)
        if o is None:
            return NotImplemented
        return _wrap(f(self._e, o))

    def __add__(self, o):
        return self._bin(o, lambda a, b: a + b)

    def __radd__(self, o):
        return self._bin(o, lambda a, b: b + a)

    def __sub__(self, o):
        return self._bin(o, lambda a, b: a - b)

    def __rsub__(self, o):
        return self._bin(o, lambda a, b: b - a)

    def __mul__(self, o):
        return self._bin(o, lambda a, b: a * b)

    def __rmul__(self, o):
        return self._bin(o, lambda a, b: b * a)

    def __truediv__(self, o):
        return self._bin(o, lambda a, b: a / b)

    def __rtruediv__(self, o):
        return self._bin(o, lambda a, b: b / a)

    def __pow__(self, o):
        return self._bin(o, lambda a, b: a ** b)

    def __rpow__(self, o):
        return self._bin(o, lambda a, b: b ** a)

    def __neg__(self):
        return _wrap(-self._e)

    def __pos__(self):
        return self

    def __eq__(self, other):
        o = _engine(other)
        if o is None:
            return False
        return str(self._e) == str(o)

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash(str(self._e))

    def __float__(self):
        if not self._e.is_numeric():
            raise TypeError("Cannot convert expression to float")
        return float(self._e)

    def subs(self, *args):
        """The expression with symbols replaced: subs(old, new), subs([(old,
        new), ...]) or subs({old: new, ...})."""
        return _wrap(self._e.subs(_subs_dict(args)))

    def diff(self, *symbols):
        return diff(self, *symbols)

    @property
    def free_symbols(self):
        return set(Symbol(str(v)) for v in self._e.variables())

    def __str__(self):
        return _Printer(False).doprint(self._e)

    __repr__ = __str__

    def _latex(self):
        return _Printer(True).doprint(self._e)

    def _repr_latex_(self):
        return "$\\displaystyle %s$" % self._latex()


class Symbol(Expr):
    """A symbol; sympy.abc has one for every letter."""

    __slots__ = ("name",)

    def __init__(self, name):
        Expr.__init__(self, _E.var(name))
        self.name = name


def _subs_dict(args):
    if len(args) == 2:
        pairs = [args]
    elif len(args) == 1 and isinstance(args[0], dict):
        pairs = list(args[0].items())
    elif len(args) == 1 and isinstance(args[0], (list, tuple)):
        pairs = list(args[0])
    else:
        raise TypeError("subs takes (old, new), a list of (old, new) pairs or a dict")
    d = {}
    for old, new in pairs:
        o, n = _engine(old), _engine(new)
        if o is None or n is None:
            raise TypeError("subs: cannot substitute %r for %r" % (new, old))
        d[o] = n
    return d


def diff(f, *symbols):
    """The derivative of f with respect to the given symbols, in order:
    diff(f, X), diff(f, X, Y), diff(f, X, 2)."""
    if hasattr(f, "applyfunc"):
        return f.applyfunc(lambda g: diff(g, *symbols))
    e = _engine(f)
    if e is None:
        raise TypeError("diff: %r is not an expression" % (f,))
    args = []
    for s in symbols:
        if isinstance(s, Expr):
            args.append(s._e)
        elif isinstance(s, int) and not isinstance(s, bool):
            args.append(s)
        else:
            raise TypeError("diff: %r is not a symbol" % (s,))
    if not args:
        vs = e.variables()
        if len(vs) != 1:
            raise ValueError("diff of an expression of %d symbols needs the symbol" % len(vs))
        args = [vs[0]]
    return _wrap(_E.diff(e, *args))


def solve(*args, **kwds):
    raise _not_covered("solve")


# ---------------------------------------------------------------------------
# Printing, as SymPy prints these expressions


def _num(e):
    """The Python number of numeric engine expression e."""
    v = e.pyobject()
    if isinstance(v, int):
        return v
    name = type(v).__name__
    if name == "Rational" or hasattr(v, "denominator") and not isinstance(v, float):
        n, d = int(v.numerator), int(v.denominator)
        return n if d == 1 else (n, d)
    return float(v)


def _is_one(c):
    """Is coefficient c the exact integer 1 (a float 1.0 is printed)?"""
    return isinstance(c, int) and c == 1


def _opname(e):
    op = e.operator()
    return None if op is None else getattr(op, "__name__", str(op))


def _sign(x):
    if isinstance(x, tuple):
        return -1 if x[0] < 0 else 1
    return -1 if x < 0 else 1


def _neg(x):
    return (-x[0], x[1]) if isinstance(x, tuple) else -x


def _gen_key(g):
    """The order of generators: symbols and powers of a symbol by the
    symbol's name and the exponent, then anything else."""
    if g.is_symbol():
        return (1, str(g), 1.0, 0)
    if _opname(g) == "pow":
        b, x = g.operands()
        if b.is_symbol() and x.is_numeric():
            v = _num(x)
            return (1, str(b), v[0] / v[1] if isinstance(v, tuple) else float(v), 1)
    return (2, str(g), 0.0, 0)


def _monomial(t):
    """Term t as {generator: exponent}: an integer or rational power's base
    is the generator, a float power is a generator itself."""
    m = {}

    def add(g, k):
        s = str(g)
        if s in m:
            m[s] = (m[s][0], m[s][1] + k)
        else:
            m[s] = (g, k)

    def factor(f):
        if f.is_numeric():
            return
        if f.is_symbol():
            add(f, 1)
            return
        if _opname(f) == "pow":
            b, x = f.operands()
            if x.is_numeric():
                v = _num(x)
                if isinstance(v, tuple):
                    add(b, v[0] / v[1])
                    return
                if isinstance(v, int):
                    add(b, v)
                    return
        add(f, 1)

    if _opname(t) == "mul":
        for f in t.operands():
            factor(f)
    else:
        factor(t)
    return m


def _ordered_terms(e):
    terms = list(e.operands())
    mons = [_monomial(t) for t in terms]
    gens = {}
    for m in mons:
        for s, (g, k) in m.items():
            gens[s] = g
    order = sorted(gens, key=lambda s: _gen_key(gens[s]))
    keyed = [(tuple(m[s][1] if s in m else 0 for s in order), i) for i, m in enumerate(mons)]
    keyed.sort(key=lambda p: p[0], reverse=True)
    out = [terms[i] for _, i in keyed]
    if len(out) == 2 and out[1].is_numeric() and _sign(_num(out[1])) > 0 and _single_negative(out[0]):
        out.reverse()
    return out


def _single_negative(t):
    """Is term t a negative coefficient times one factor (-X**2, -N/10)?
    SymPy prints such a term after a positive constant: 1 - X**2."""
    if _opname(t) != "mul":
        return False
    ops = t.operands()
    nums = [f for f in ops if f.is_numeric()]
    return len(nums) == 1 and len(ops) == 2 and _sign(_num(nums[0])) < 0


PREC_ADD, PREC_MUL, PREC_POW, PREC_ATOM = 40, 50, 60, 1000


class _Printer(object):

    def __init__(self, latex):
        self.latex = latex

    def doprint(self, e):
        if e.is_numeric():
            return self.number(_num(e), True)
        return self.expr(e)

    # numbers

    def number(self, v, top=False):
        if isinstance(v, tuple):
            n, d = v
            if self.latex:
                s = "\\frac{%d}{%d}" % (abs(n), d)
                return "- " + s if n < 0 else s
            return "%d/%d" % (n, d)
        if isinstance(v, int):
            return str(v)
        if self.latex:
            return _latex_float(v)
        return _full(v) if top else _short(v)

    # precedence

    def prec(self, e):
        if e.is_numeric():
            v = _num(e)
            if isinstance(v, tuple) or _sign(v) < 0:
                return PREC_ADD
            return PREC_ATOM
        if e.is_symbol():
            return PREC_ATOM
        op = _opname(e)
        if op == "add":
            return PREC_ADD
        if op == "mul":
            c, num, den = self.split_mul(e)
            if not _is_one(c) or den or len(num) > 1:
                return PREC_MUL
            return PREC_ATOM
        if op == "pow":
            b, x = e.operands()
            if x.is_numeric():
                v = _num(x)
                if _sign(v) < 0:
                    return PREC_MUL
            return PREC_POW
        return PREC_ATOM

    def paren(self, e, level, strict=False):
        p = self.prec(e)
        s = self.expr(e) if not e.is_numeric() else self.number(_num(e))
        if p < level or strict and p <= level:
            return ("\\left(%s\\right)" if self.latex else "(%s)") % s
        return s

    # expressions

    def expr(self, e):
        if e.is_numeric():
            return self.number(_num(e))
        if e.is_symbol():
            return str(e)
        op = _opname(e)
        if op == "add":
            return self.add(e)
        if op == "mul":
            return self.mul(e)
        if op == "pow":
            return self.pow(e)
        raise _not_covered("printing of %s" % (e,))

    def add(self, e):
        out = []
        for t in _ordered_terms(e):
            s = self.expr(t)
            if s.startswith("-"):
                neg, s = True, s[1:].lstrip()
            else:
                neg = False
            if not out:
                out.append(("- " if self.latex and not t.is_numeric() else "-") + s if neg else s)
            else:
                out.append((" - " if neg else " + ") + s)
        return "".join(out)

    def split_mul(self, e):
        """Product e as (coefficient, numerator factors, denominator
        factors), the factors as (base, exponent) in SymPy's order."""
        c = 1
        num, den = [], []
        for f in e.operands():
            if f.is_numeric():
                c = _num(f)
                continue
            b, x = f, 1
            if _opname(f) == "pow":
                fb, fx = f.operands()
                if fx.is_numeric():
                    v = _num(fx)
                    if _sign(v) < 0:
                        b, x = fb, _neg(v)
                        den.append((b, x))
                        continue
            num.append((b, x))
        num.sort(key=lambda p: _gen_key(p[0]))
        den.sort(key=lambda p: _gen_key(p[0]))
        return c, num, den

    def factor_str(self, item):
        b, x = item
        if x == 1:
            return self.paren(b, PREC_MUL)
        return self.pow_str(b, x)

    def pow_str(self, b, x):
        if isinstance(x, tuple) and x == (1, 2):
            return ("\\sqrt{%s}" if self.latex else "sqrt(%s)") % self.expr(b)
        bs = self.paren(b, PREC_POW, strict=True)
        if self.latex:
            if isinstance(x, tuple):
                xs = "\\frac{%d}{%d}" % x
            else:
                xs = self.number(x)
            return "%s^{%s}" % (bs, xs)
        if isinstance(x, tuple):
            xs = "(%d/%d)" % x
        else:
            xs = self.number(x)
            if _sign(x) < 0:
                xs = "(%s)" % xs
        return "%s**%s" % (bs, xs)

    def mul(self, e):
        c, num, den = self.split_mul(e)
        neg = _sign(c) < 0
        if neg:
            c = _neg(c)
        if isinstance(c, tuple):
            cn, cd = c
        else:
            cn, cd = c, 1
        nums = [self.factor_str(f) for f in num]
        if self.latex and len(den) == 1 and den[0][1] == 1 and cd == 1:
            dens = [self.expr(den[0][0])]
        else:
            dens = [self.factor_str(f) for f in den]
        if cd != 1:
            dens.insert(0, str(cd))
        if self.latex:
            parts = ([self.number(cn)] if not _is_one(cn) else []) + nums
            n = " ".join(parts) if parts else "1"
            s = "\\frac{%s}{%s}" % (n, " ".join(dens)) if dens else n
            return ("- " + s) if neg else s
        parts = ([self.number(cn)] if not _is_one(cn) else []) + nums
        n = "*".join(parts) if parts else "1"
        if dens:
            if len(dens) == 1:
                s = "%s/%s" % (n, dens[0])
            else:
                s = "%s/(%s)" % (n, "*".join(dens))
        else:
            s = n
        return ("-" + s) if neg else s

    def pow(self, e):
        b, x = e.operands()
        if x.is_numeric():
            v = _num(x)
            if _sign(v) < 0:
                p = _neg(v)
                if isinstance(p, float):
                    return self.pow_str(b, v)
                if self.latex:
                    return "\\frac{1}{%s}" % (self.expr(b) if p == 1 else self.factor_str((b, p)))
                if p == 1:
                    return "1/%s" % self.paren(b, PREC_MUL, strict=True)
                if isinstance(p, tuple) and p == (1, 2):
                    return "1/sqrt(%s)" % self.expr(b)
                return self.pow_str(b, v)
            return self.pow_str(b, v)
        bs = self.paren(b, PREC_POW, strict=True)
        xs = self.paren(x, PREC_POW, strict=True)
        return ("%s^{%s}" if self.latex else "%s**%s") % (bs, self.expr(x) if self.latex else xs)


from sympy.matrices import Matrix  # noqa: E402
