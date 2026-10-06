"""Just enough symbolics for Sage-style plotting: x = var('x'); sin(x^2)/x.

Expressions are trees that print the way Sage writes them, substitute
values (f(x=2), f(2)), and compile once to a fast numerical function
(_fast_callable) for plotting.  There is no simplification, calculus or
solving here.
"""

import math as _m

_PREC = {"+": 1, "-": 1, "*": 2, "/": 2, "neg": 3, "^": 4}


def _wrap(v):
    if isinstance(v, Expr):
        return v
    if isinstance(v, bool):
        return Expr("num", (int(v),))
    if isinstance(v, (int, float, complex)) or hasattr(v, "numerator"):
        return Expr("num", (v,))
    return None


class Expr:
    __slots__ = ("op", "args", "_fast")

    def __init__(self, op, args):
        self.op, self.args, self._fast = op, tuple(args), None

    # --- arithmetic builds trees
    def _bin(self, op, other, rev=False):
        o = _wrap(other)
        if o is None:
            return NotImplemented
        return Expr(op, (o, self) if rev else (self, o))

    def __add__(self, o): return self._bin("+", o)
    def __radd__(self, o): return self._bin("+", o, True)
    def __sub__(self, o): return self._bin("-", o)
    def __rsub__(self, o): return self._bin("-", o, True)
    def __mul__(self, o): return self._bin("*", o)
    def __rmul__(self, o): return self._bin("*", o, True)
    def __truediv__(self, o): return self._bin("/", o)
    def __rtruediv__(self, o): return self._bin("/", o, True)
    def __pow__(self, o): return self._bin("^", o)
    def __xor__(self, o): raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")
    def __rpow__(self, o): return self._bin("^", o, True)
    # Constant expressions (pi, 2*pi, sqrt(2)) compare as numbers.
    def _cmp(self, other):
        if self._names() or (isinstance(other, Expr) and other._names()):
            raise TypeError("cannot compare symbolic expressions with variables: %s" % self)
        return float(self), float(other)

    def __lt__(self, o): a, b = self._cmp(o); return a < b
    def __le__(self, o): a, b = self._cmp(o); return a <= b
    def __gt__(self, o): a, b = self._cmp(o); return a > b
    def __ge__(self, o): a, b = self._cmp(o); return a >= b
    def __neg__(self): return Expr("neg", (self,))
    def __pos__(self): return self
    def __abs__(self): return Expr("fn", ("abs", self))

    # --- inspection
    def variables(self):
        out = set()

        def walk(e):
            if e.op == "var":
                out.add(e.args[0])
            elif e.op in ("num", "const"):
                pass
            else:
                for a in e.args:
                    if isinstance(a, Expr):
                        walk(a)
        walk(self)
        return tuple(Expr("var", (n,)) for n in sorted(out))

    def _names(self):
        return [v.args[0] for v in self.variables()]

    def __repr__(self):
        return self._str(0)

    def _str(self, outer):
        op, a = self.op, self.args
        if op == "var":
            return a[0]
        if op == "const":
            return a[0]
        if op == "num":
            v = a[0]
            s = repr(v)
            neg = s.startswith("-")
            if "/" in s or neg:
                return "(" + s + ")" if outer > 1 else s
            return s
        if op == "fn":
            return "%s(%s)" % (a[0], ", ".join(x._str(0) for x in a[1:]))
        if op == "neg":
            s = "-" + a[0]._str(_PREC["neg"])
            return "(" + s + ")" if outer > _PREC["neg"] else s
        p = _PREC[op]
        left = a[0]._str(p + (1 if op == "^" else 0))
        right = a[1]._str(p + (0 if op == "^" else 1) if op in ("-", "/", "^") else p)
        s = left + ({"^": "^", "*": "*", "/": "/"}.get(op, " " + op + " ")) + right
        return "(" + s + ")" if outer > p else s

    __str__ = __repr__

    # --- numbers
    def _src(self):
        op, a = self.op, self.args
        if op == "var":
            return "_v_" + a[0]
        if op == "const":
            return repr(a[1])
        if op == "num":
            v = a[0]
            return "(%r)" % (float(v) if hasattr(v, "denominator") and not isinstance(v, int) else v)
        if op == "fn":
            return "%s(%s)" % (_SRC.get(a[0], "_m." + a[0]), ", ".join(x._src() for x in a[1:]))
        if op == "neg":
            return "(-" + a[0]._src() + ")"
        py = "**" if op == "^" else op
        return "(" + a[0]._src() + py + a[1]._src() + ")"

    def _fast_callable(self, names=None):
        """A Python function of the variables (in sorted order) computing this expression."""
        names = names or self._names()
        if self._fast is None or self._fast[0] != names:
            src = "lambda %s: %s" % (", ".join("_v_" + n for n in names), self._src())
            self._fast = (names, eval(src, {"_m": _m, "_abs": abs, "_gamma": _gamma}))
        return self._fast[1]

    def subs(self, values=None, **kw):
        values = dict(values or {})
        for k, v in kw.items():
            values[k] = v
        vals = {(k.args[0] if isinstance(k, Expr) else str(k)): v for k, v in values.items()}

        def walk(e):
            if e.op == "var":
                return _wrap(vals[e.args[0]]) if e.args[0] in vals else e
            if e.op in ("num", "const"):
                return e
            if e.op == "fn":
                return Expr("fn", (e.args[0],) + tuple(walk(x) for x in e.args[1:]))
            return Expr(e.op, tuple(walk(x) for x in e.args))
        return walk(self)

    def __call__(self, *args, **kw):
        names = self._names()
        values = dict(zip(names, args))
        values.update(kw)
        r = self.subs(values)
        if not r._names():
            return r._value()
        return r

    def _value(self):
        v = self._fast_callable([])()
        return v

    def __float__(self):
        if self._names():
            raise TypeError("cannot evaluate symbolic expression %s numerically" % self)
        return float(self._value())

    def __complex__(self):
        return complex(self._value())

    def n(self, digits=None):
        from _sage_lang import RealNumber
        return RealNumber(float(self))

    numerical_approx = N = n


_SRC = {"abs": "_abs", "gamma": "_gamma"}


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


def var(*names):
    """var('x y') or var('x', 'y'): symbolic variables, also defined in __main__."""
    if len(names) == 1 and isinstance(names[0], str):
        names = names[0].replace(",", " ").split()
    vs = tuple(Expr("var", (n,)) for n in names)
    import sys
    main = sys.modules.get("__main__")
    if main is not None:
        for v in vs:
            setattr(main, v.args[0], v)
    return vs[0] if len(vs) == 1 else vs


def _function(name, numeric):
    def f(*args):
        if any(isinstance(a, Expr) for a in args):
            return Expr("fn", (name,) + tuple(_wrap(a) for a in args))
        r = numeric(*args)
        if type(r) is float:
            from _sage_lang import RealNumber
            return RealNumber(r)
        return r
    f.__name__ = name
    return f


pi = Expr("const", ("pi", _m.pi))
e = Expr("const", ("e", _m.e))
x = Expr("var", ("x",))
sin = _function("sin", _m.sin)
cos = _function("cos", _m.cos)
tan = _function("tan", _m.tan)
asin = arcsin = _function("asin", _m.asin)
acos = arccos = _function("acos", _m.acos)
atan = arctan = _function("atan", _m.atan)
atan2 = arctan2 = _function("atan2", _m.atan2)
sinh = _function("sinh", _m.sinh)
cosh = _function("cosh", _m.cosh)
tanh = _function("tanh", _m.tanh)
exp = _function("exp", _m.exp)
log = ln = _function("log", _m.log)
floor = _function("floor", _m.floor)
ceil = _function("ceil", _m.ceil)
gamma = _function("gamma", _gamma)
