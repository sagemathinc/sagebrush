"""Euclidean spaces and vector calculus, as in Sage's manifolds: E^n with
Cartesian, polar, spherical and cylindrical charts and frames, points,
scalar fields, vector fields, the dot and cross products, norms, gradients,
divergences, curls and Laplacians, the metric; components are displayed
in any frame and chart (derivatives in textbook notation, d(f)/dx)."""

import re


def _sa():
    import sage_all
    return sage_all


def _SR(x):
    return _sa().SR(x)


def _simplify(e):
    """Simplify a coordinate expression (with the coordinate ranges as
    assumptions: radial coordinates positive, polar angles in (0, pi))."""
    try:
        e = _SR(e)
    except Exception:
        return e
    s = _rewrite(e)
    try:
        t = _rewrite(s.simplify_trig())
        if len(str(t)) <= len(str(s)):
            s = t
    except Exception:
        pass
    if re.search(r"(sin|cos)\(\d+\*", str(s)):
        try:
            t = _rewrite(_trig_expand(s).simplify_trig())
            if len(str(t)) < len(str(s)):
                s = t
        except Exception:
            pass
    if "/" in str(s):
        try:
            t = s.simplify_rational()
            if len(str(t)) < len(str(s)):
                s = t
        except Exception:
            pass
    return _sqrt_split(_maxima_form(s))


def _sqrt_split(s):
    """sqrt(n/d) = sqrt(n)/sqrt(d) when sqrt(d) is known
    (sqrt((r^2*a + b)/r^2) = sqrt(r^2*a + b)/r)."""
    if _tag(s) != "pow" or str(s.operands()[1]) != "1/2":
        return s
    b = s.operands()[0]
    try:
        q = b.simplify_rational()
        n, d = q.numerator(), q.denominator()
        if bool(d == 1):
            return s
        rd = _sqrt_of(d)
        if rd is None:
            return s
        return _sa().sqrt(_maxima_form(n)) / rd
    except Exception:
        return s


def _trig_expand(e):
    """sin and cos of multiple angles and of sums expanded (sin(2*x) =
    2*cos(x)*sin(x))."""
    t = _tag(e)
    if t not in ("add", "mul", "pow") and not t.startswith("fun:"):
        return e
    ops = [_trig_expand(a) for a in e.operands()]
    if t == "add":
        return sum(ops, _SR(0))
    if t == "mul":
        r = _SR(1)
        for a in ops:
            r = r * a
        return r
    if t == "pow":
        return ops[0] ** ops[1]
    name = t[4:]
    if name not in ("sin", "cos"):
        if name in _BUILTIN:
            return e.operator()(*ops)
        return e
    return _sc(ops[0])[0 if name == "sin" else 1]


def _sc(x):
    """(sin(x), cos(x)) expanded."""
    sa = _sa()
    t = _tag(x)
    if t == "add":
        a, rest = x.operands()[0], sum(x.operands()[1:], _SR(0))
        sa_, ca = _sc(a)
        sb, cb = _sc(rest)
        return (sa_ * cb + ca * sb, ca * cb - sa_ * sb)
    if t == "mul":
        fs = x.operands()
        k = [f for f in fs if f.is_numeric()]
        if k:
            try:
                n = int(k[0])
            except Exception:
                n = None
            if n is not None and n == k[0] and 1 < abs(n) <= 12:
                y = x / k[0]
                s1, c1 = _sc(y)
                m = abs(n)
                S = sum((sa.binomial(m, j) * (-1) ** ((j - 1) // 2) * c1 ** (m - j) * s1 ** j for j in range(1, m + 1, 2)), _SR(0))
                C = sum((sa.binomial(m, j) * (-1) ** (j // 2) * c1 ** (m - j) * s1 ** j for j in range(0, m + 1, 2)), _SR(0))
                return (S if n > 0 else -S, C)
    return (sa.sin(x), sa.cos(x))


# -------------------------------------------- Maxima-style collected form
#
# Sage simplifies the coordinate expressions of fields with Maxima, whose
# rational form is recursive: the numerator is collected in a "main" kernel
# (sin(th) before cos(th), before the functions of later variables, ...),
# and a collected coefficient whose first term is negative is written
# -(...).  The order of the kernels here is the observed one.

def _mkey(e):
    """A comparable tree for a kernel: ('n', value), ('a', name) or
    ('c', operator name, [argument trees])."""
    sa = _sa()
    t = _tag(e)
    if t in ("rational", "integer", "float") or (t != "symbol" and e.is_numeric()):
        try:
            return ("n", float(e))
        except Exception:
            return ("n", 0.0)
    if t == "symbol" or t == "constant":
        return ("a", str(e).upper())
    st = str(e)
    if t.startswith("fun:"):
        name = t[4:]
        args = [_mkey(a) for a in e.operands()]
        if st.startswith("diff(") or st.startswith("D["):
            if st.startswith("diff("):
                parts, _ = _scan_args(st, 5)
                vs = [("a", v.upper()) for v in parts[1:]]
            else:
                idx = [int(i) for i in st[2:st.index("]")].split(",")]
                ops = e.operands()
                vs = [_mkey(ops[i]) if i < len(ops) else ("n", float(i)) for i in idx]
            return ("c", "%DERIVATIVE", [("c", "$" + name.upper(), args)] + vs)
        op = ("%" + name.upper()) if name in _BUILTIN else ("$" + name.upper())
        return ("c", op, args)
    if t in ("add", "mul"):
        ks = sorted((_mkey(a) for a in e.operands()), key=_mcmp_key)
        return ("c", "M" + t.upper(), ks)
    if t == "pow":
        return ("c", "MEXPT", [_mkey(a) for a in e.operands()])
    return ("a", st.upper())


def _first_atom(k):
    while k[0] == "c":
        if k[1] in ("MADD", "MMUL"):
            k = k[2][-1]
        elif k[2]:
            k = k[2][0]
        else:
            return ("a", k[1])
    return k


def _mgreat(x, y):
    """Whether the kernel tree x comes after y (is the main one)."""
    if x == y:
        return False
    if x[0] != "c" and y[0] != "c":
        if x[0] != y[0]:
            return x[0] == "a"
        return x[1] > y[1]
    if x[0] != "c":
        return not _mgreat_call_atom(y, x)
    if y[0] != "c":
        return _mgreat_call_atom(x, y)
    for a, b in zip(x[2], y[2]):
        if a != b:
            return _mgreat(a, b)
    if len(x[2]) != len(y[2]):
        return len(x[2]) > len(y[2])
    return x[1] > y[1]


def _mgreat_call_atom(c, a):
    f = _first_atom(c)
    return f == a or _mgreat(f, a)


import functools
_mcmp_key = functools.cmp_to_key(lambda a, b: 1 if _mgreat(a, b) else (-1 if _mgreat(b, a) else 0))


def _poly_terms(n):
    """The terms of the expanded n as (coefficient, {kernel index: exponent})
    with the kernels; None when n is not a polynomial in its kernels."""
    kernels, keys, terms = [], [], []
    ts = n.operands() if _tag(n) == "add" else [n]
    for t in ts:
        fs = t.operands() if _tag(t) == "mul" else [t]
        c, mono = _SR(1), {}
        for f in fs:
            if f.is_numeric() or not f.variables():
                c = c * f
                continue
            b, k = f, 1
            if _tag(f) == "pow":
                b0, x = f.operands()
                try:
                    kk = _sa().QQ(x)
                except Exception:
                    kk = None
                if kk is not None and kk.denominator() == 1 and kk > 0:
                    b, k = b0, int(kk)
            ks = str(b)
            if ks not in keys:
                keys.append(ks)
                kernels.append(b)
            j = keys.index(ks)
            mono[j] = mono.get(j, 0) + k
        terms.append((c, mono))
    return kernels, terms


def _mbuild(kernels, mkeys, terms):
    """The recursive (collected) form of a polynomial given by its terms."""
    used = sorted({j for c, m in terms for j in m})
    if not used:
        return sum((c for c, m in terms), _SR(0))
    main = used[0]
    for j in used[1:]:
        if _mgreat(mkeys[j], mkeys[main]):
            main = j
    groups = {}
    for c, m in terms:
        k = m.get(main, 0)
        m2 = {j: e for j, e in m.items() if j != main}
        groups.setdefault(k, []).append((c, m2))
    out = _SR(0)
    for k in sorted(groups):
        sub = groups[k]
        if k == 0:
            out = out + _mbuild(kernels, mkeys, sub)
            continue
        coef, neg = _msigned(kernels, mkeys, sub) if len(sub) > 1 else (_mbuild(kernels, mkeys, sub), False)
        t = coef * kernels[main] ** k
        out = out + (-t if neg else t)
    return out


def _msigned(kernels, mkeys, terms):
    """(collected sum, False), or (its opposite, True) when the first term
    of the sum is negative (Maxima's -(...))."""
    coef = _mbuild(kernels, mkeys, terms)
    if str(coef).startswith("-"):
        return _mbuild(kernels, mkeys, [(-c, m) for c, m in terms]), True
    return coef, False


def _maxima_form(e):
    """e as Maxima writes a simplified rational expression."""
    try:
        r = e.simplify_rational() if "/" in str(e) else e
        n, d = r.numerator(), r.denominator()
        kernels, terms = _poly_terms(n.expand())
        if len(terms) < 2:
            return e
        mkeys = [_mkey(k) for k in kernels]
        if bool(d == 1):
            return _mbuild(kernels, mkeys, terms)
        num, neg = _msigned(kernels, mkeys, terms)
        q = num / d
        return -q if neg else q
    except Exception:
        return e


_POSITIVE = set()      # names of the coordinates assumed positive (r, rh)
_SIN_POSITIVE = set()  # names of the angles in (0, pi) (th)


def _tag(e):
    try:
        return e._op()[0]
    except Exception:
        return ""


def _positive(e):
    """Whether e is known to be positive (a radial coordinate, sin of a polar
    angle, a positive number, products and powers of such)."""
    t = _tag(e)
    if t == "add" or t.startswith("rel"):
        return False
    if t == "mul":
        return all(_positive(a) for a in e.operands())
    if t == "pow":
        b, x = e.operands()
        return _positive(b)
    if t == "fun:sin":
        return str(e.operands()[0]) in _SIN_POSITIVE
    if t == "fun:sqrt":
        return True
    if e.is_symbol():
        return str(e) in _POSITIVE
    try:
        return e.is_numeric() and bool(e > 0)
    except Exception:
        return False


def _sqrt_of(b):
    """sqrt(b) when b is a product of even powers of positive factors, else None."""
    t = _tag(b)
    if t == "pow":
        base, x = b.operands()
        try:
            k = _sa().QQ(x)
        except Exception:
            return None
        if k.denominator() == 1 and k % 2 == 0 and _positive(base):
            return base ** (int(k.numerator()) // 2)
        return None
    if t == "mul":
        out = _SR(1)
        for f in b.operands():
            if _tag(f) in ("", "num", "rational", "integer") and f.is_numeric():
                try:
                    if f > 0:
                        out = out * _sa().sqrt(f)
                        continue
                except Exception:
                    pass
                return None
            r = _sqrt_of(f)
            if r is None:
                return None
            out = out * r
        return out
    if t == "add" and _SIN_POSITIVE:
        return _sqrt_of_sum(b)
    return None


def _sqrt_of_sum(b):
    """sqrt(r^2 - r^2*cos(th)^2) = r*sin(th) (th a polar angle, r > 0)."""
    sa = _sa()
    cands = []
    try:
        cands.append(b.simplify_trig())
    except Exception:
        pass
    for name in _SIN_POSITIVE:
        th = sa.SR.var(name)
        try:
            c = b.subs({sa.cos(th): sa.sqrt(1 - sa.sin(th) ** 2)}).expand()
        except Exception:
            continue
        if "sqrt" not in str(c):
            cands.append(c)
    for c in cands:
        if _tag(c) == "add":
            try:
                c = c.factor()
            except Exception:
                continue
        if _tag(c) != "add":
            r = _sqrt_of(c)
            if r is not None:
                return r
    return None


def _rewrite(e):
    """sqrt(r^2) = r, sqrt(r^2*sin(th)^2) = r*sin(th), abs of positive
    expressions, arctan2(k*sin(t), k*cos(t)) = t, cos(arctan2(y, x)) =
    x/sqrt(x^2 + y^2), sin(arctan2(y, x)) = y/sqrt(x^2 + y^2)."""
    t = _tag(e)
    if not t or t in ("sym", "num", "const") or not (t in ("add", "mul", "pow") or t.startswith("fun:")):
        return e
    ops = [_rewrite(a) for a in e.operands()]
    if t == "add":
        return sum(ops, _SR(0))
    if t == "mul":
        r = _SR(1)
        for a in ops:
            r = r * a
        return r
    if t == "pow":
        b, x = ops
        try:
            k = _sa().QQ(x)
        except Exception:
            k = None
        if k is not None and k.denominator() == 2:
            r = _sqrt_of(b)
            if r is not None:
                return r ** int(k.numerator())
        return b ** x
    name = t[4:]
    if name == "abs" and _positive(ops[0]):
        return ops[0]
    if name in ("cos", "sin") and _tag(ops[0]) == "fun:arctan2":
        a, b = ops[0].operands()
        r = _sa().sqrt(a ** 2 + b ** 2)
        return (b if name == "cos" else a) / r
    if name == "arctan2":
        a, b = ops
        ang = _angle(a, b)
        if ang is not None:
            return ang
    olds = e.operands()
    changed = [(a, b) for a, b in zip(olds, ops) if str(a) != str(b)]
    if not changed:
        return e
    if name in _BUILTIN:
        try:
            return e.operator()(*ops)
        except Exception:
            return e
    try:
        return e.subs(dict(changed))
    except Exception:
        return e


_BUILTIN = {"sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh",
            "arcsin", "arccos", "arctan", "arctan2", "sqrt", "exp", "log", "abs"}


def _angle(a, b):
    """t when a = k*sin(t) and b = k*cos(t) with k positive."""
    fs = a.operands() if _tag(a) == "mul" else [a]
    for f in fs:
        if _tag(f) == "fun:sin":
            t = f.operands()[0]
            k = a / f
            try:
                if bool((b - k * _sa().cos(t)).expand() == 0) and (_positive(k) or str(k) == "1"):
                    return t
            except Exception:
                return None
    return None


# ------------------------------------------------------------ the printing

def _scan_args(s, j):
    """The comma-separated arguments starting at s[j] up to the matching ')';
    returns (args, index of the ')')."""
    depth, args, start = 0, [], j
    while j < len(s):
        c = s[j]
        if c in "([":
            depth += 1
        elif c in ")]":
            if depth == 0:
                args.append(s[start:j].strip())
                return args, j
            depth -= 1
        elif c == "," and depth == 0:
            args.append(s[start:j].strip())
            start = j + 1
        j += 1
    return args, j


def _dname(var):
    return var if re.match(r"^[A-Za-z_][A-Za-z_0-9]*$", var) else "(%s)" % var


def _deriv_text(name, vars_):
    groups = []
    for v in vars_:
        if groups and groups[-1][0] == v:
            groups[-1][1] += 1
        else:
            groups.append([v, 1])
    n = len(vars_)
    den = "".join("d%s%s" % (_dname(v), "^%d" % c if c > 1 else "") for v, c in groups)
    return ("d(%s)/%s" % (name, den)) if n == 1 else ("d^%d(%s)/%s" % (n, name, den))


def _textbook(s):
    """diff(f(x, y), x, y) -> d^2(f)/dxdy and D[0](f)(r*cos(ph), ...) ->
    d(f)/d(r*cos(ph)), as Sage's manifolds print derivatives."""
    out = []
    i = 0
    while i < len(s):
        k1 = s.find("diff(", i)
        k2 = s.find("D[", i)
        cands = [k for k in (k1, k2) if k >= 0 and not (k > 0 and (s[k - 1].isalnum() or s[k - 1] == "_"))]
        if not cands:
            out.append(s[i:])
            break
        k = min(cands)
        out.append(s[i:k])
        if s.startswith("diff(", k):
            args, j = _scan_args(s, k + 5)
            f = args[0]
            m = re.match(r"^([A-Za-z_][A-Za-z_0-9]*)\((.*)\)$", f)
            name = m.group(1) if m else f
            text = _deriv_text(name, args[1:])
            end = j + 1
        else:
            close = s.index("]", k)
            idx = [int(t) for t in s[k + 2:close].split(",")]
            m = re.match(r"\(([A-Za-z_][A-Za-z_0-9]*)\)\(", s[close + 1:])
            if not m:
                out.append(s[k:close + 1])
                i = close + 1
                continue
            name = m.group(1)
            args, j = _scan_args(s, close + 1 + m.end())
            text = _deriv_text(name, [args[t] for t in idx])
            end = j + 1
        if end < len(s) and s[end] == "^":
            text = "(%s)" % text
        out.append(text)
        i = end
    return "".join(out)



def _fmt(e):
    return _textbook(str(e))


def _is_sum(s):
    """Whether a printed expression is a sum (a top level + or - after the start)."""
    depth = 0
    for k, c in enumerate(s):
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif depth == 0 and c in "+-" and k > 0 and s[k - 1] == " ":
            return True
    return False


def _lincomb(pairs):
    """'c1 e1 + c2 e2' for pairs (expression, basis name), as Sage displays
    vectors."""
    out = ""
    for c, b in pairs:
        if c == 0:
            continue
        s = _fmt(c)
        if s == "1":
            t, neg = b, False
        elif s == "-1":
            t, neg = b, True
        elif _is_sum(s):
            t, neg = "(%s) %s" % (s, b), False
        elif s.startswith("-"):
            t, neg = "%s %s" % (s[1:], b), True
        else:
            t, neg = "%s %s" % (s, b), False
        if not out:
            out = ("-" if neg else "") + t
        else:
            out += (" - " if neg else " + ") + t
    return out or "0"


class ChartFunction:
    """A coordinate expression (printed with textbook derivatives).

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); f = function('f'); v = E.vector_field(diff(f(x, y), x), 0); v[1]  # sagebrush only
        d(f)/dx
    """

    def __init__(self, chart, expr, owner=None):
        self._chart, self._e = chart, _SR(expr)
        self._owner = owner   # (list of components, index): updated in place

    def expr(self):
        """The symbolic expression.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(x^2*y, x); v[1].expr()  # sagebrush only
            x^2*y
        """
        return self._e

    def _inplace(self, e):
        self._e = e
        if self._owner is not None:
            comps, i = self._owner
            comps[i] = e
        return self

    def expand(self):
        """Expand the expression (in place, as in Sage).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field((x + y)^2, x); v[1].expand()  # sagebrush only
            x^2 + 2*x*y + y^2
        """
        return self._inplace(self._e.expand())

    def simplify_full(self):
        """Simplify the expression (in place).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(cos(x)^2 + sin(x)^2, x); v[1].simplify_full()  # sagebrush only
            1
        """
        return self._inplace(_simplify(self._e))

    simplify = simplify_full

    def factor(self):
        """Factor the expression (in place).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(x^2 - y^2, x); v[1].factor()  # sagebrush only
            (x + y)*(x - y)
        """
        return self._inplace(self._e.factor())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._e, name)

    def __repr__(self):
        return _fmt(self._e)

    def _latex_(self):
        return _sa().latex(self._e)

    def __eq__(self, other):
        o = other._e if isinstance(other, ChartFunction) else other.expr() if isinstance(other, ScalarField) else other
        return bool((self._e - _SR(o)).simplify_full() == 0)

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(str(self._e))

    def _op(self, other, f):
        o = other._e if isinstance(other, ChartFunction) else other
        return ChartFunction(self._chart, f(self._e, o))

    def __add__(self, o):
        return self._op(o, lambda a, b: a + b)

    def __radd__(self, o):
        return self._op(o, lambda a, b: b + a)

    def __sub__(self, o):
        return self._op(o, lambda a, b: a - b)

    def __rsub__(self, o):
        return self._op(o, lambda a, b: b - a)

    def __mul__(self, o):
        return self._op(o, lambda a, b: a * b)

    def __rmul__(self, o):
        return self._op(o, lambda a, b: b * a)

    def __truediv__(self, o):
        return self._op(o, lambda a, b: a / b)

    def __pow__(self, o):
        return self._op(o, lambda a, b: a ** b)

    def __neg__(self):
        return ChartFunction(self._chart, -self._e)

    def __call__(self, *args):
        """The value at given coordinates.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(x^2 + y, x); v[1](2, 3)  # sagebrush only
            7
        """
        return self._e.subs(dict(zip(self._chart._coords, args)))

    def diff(self, i):
        """The partial derivative with respect to the i-th coordinate (0-based).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(x^2*y, x); v[1].diff(0)  # sagebrush only
            2*x*y
        """
        return ChartFunction(self._chart, self._e.diff(self._chart._coords[i]))


# ------------------------------------------------------------- charts, frames

class Chart:
    """A coordinate chart.

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); polar  # sagebrush only
        Chart (E^2, (r, ph))
    """

    def __init__(self, M, coords, ranges, periodic=()):
        self._M, self._coords = M, list(coords)
        self._ranges = ranges
        self._periodic = periodic
        self._frame = None

    def __repr__(self):
        return "Chart (%s, (%s))" % (self._M._name, ", ".join(str(c) for c in self._coords))

    def __getitem__(self, i):
        if isinstance(i, slice):
            return tuple(self._coords)
        return self._coords[int(i) - self._M._start]

    def __iter__(self):
        return iter(self._coords)

    def __call__(self, p):
        """The coordinates of a point in the chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); polar(E((0, 2)))  # sagebrush only
            (2, 1/2*pi)
        """
        return p.coord(self)

    def _first_ngens(self, n):
        return tuple(self._coords[:n])

    def coord_range(self):
        """The coordinate ranges.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.cartesian_coordinates().coord_range()  # sagebrush only
            x: (-oo, +oo); y: (-oo, +oo)
        """
        parts = []
        for c, r in zip(self._coords, self._ranges):
            parts.append("%s: %s" % (c, r))
        return _Text("; ".join(parts))

    def frame(self):
        """The coordinate frame of the chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.cartesian_coordinates().frame()  # sagebrush only
            Coordinate frame (E^2, (e_x,e_y))
        """
        return self._frame

    def manifold(self):
        """The manifold of the chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.cartesian_coordinates().manifold()  # sagebrush only
            Euclidean plane E^2
        """
        return self._M

    def domain(self):
        """The domain of the chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.cartesian_coordinates().domain()  # sagebrush only
            Euclidean plane E^2
        """
        return self._M

    def plot(self, chart=None, ambient_coords=None, mapping=None, fixed_coords=None, ranges=None, number_values=None, steps=None, parameters=None, max_range=8, plot_points=75, label_axes=True, color="red", style="-", thickness=1, aspect_ratio="automatic", **kwds):
        """The coordinate lines of the chart, drawn in the coordinates of
        another chart (number_values lines per coordinate: 9 in 2D, 5 in 3D).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates()  # sagebrush only
            sage: polar.plot(E.cartesian_coordinates())  # sagebrush only
            Graphics object consisting of 18 graphics primitives
        """
        M = self._M
        chart = chart or M._cart
        amb = list(ambient_coords) if ambient_coords is not None else list(chart._coords)
        if len(amb) == 3:
            return _G3()
        sa = _sa()
        fixed = {str(k): v for k, v in (fixed_coords or {}).items()}
        free = [i for i, c in enumerate(self._coords) if str(c) not in fixed]
        nv = number_values or (9 if len(amb) == 2 else 5)
        exprs = M._coords_in(self, chart)
        pos = [[str(c) for c in chart._coords].index(str(a)) for a in amb]

        def bounds(i):
            import math
            rng = self._ranges[i].replace("(periodic)", "").strip()[1:-1]
            lo, hi = [t.strip() for t in rng.split(",")]

            def conv(t, d):
                return d if "oo" in t else float(eval(t, {"pi": math.pi}))
            return conv(lo, -max_range), conv(hi, max_range)

        def point(vals):
            sub = dict(zip(self._coords, vals))
            return tuple(float(_SR(exprs[p]).subs(sub)) for p in pos)

        cols = color if isinstance(color, dict) else {}
        G = sa.Graphics()
        import itertools
        for i in free:
            others = [j for j in free if j != i]
            grids = []
            for j in others:
                a, b = bounds(j)
                grids.append([a + (b - a) * t / (nv - 1) for t in range(nv)])
            a, b = bounds(i)
            for combo in itertools.product(*grids):
                vals = [None] * len(self._coords)
                for j, v in zip(others, combo):
                    vals[j] = v
                for name, v in fixed.items():
                    vals[[str(c) for c in self._coords].index(name)] = float(_SR(v))
                pts = []
                for t in range(plot_points):
                    vals[i] = a + (b - a) * t / (plot_points - 1)
                    pts.append(point(vals))
                c = cols.get(self._coords[i], color if not isinstance(color, dict) else "red")
                G += sa.line(pts, color=c, thickness=thickness)
        return G


class _Text:
    def __init__(self, s):
        self._s = s

    def __repr__(self):
        return self._s

    def __str__(self):
        return self._s


class Frame:
    """A vector frame (coordinate frame or orthonormal frame).

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); E.polar_frame()[:]  # sagebrush only
        (Vector field e_r on the Euclidean plane E^2, Vector field e_ph on the Euclidean plane E^2)
    """

    def __init__(self, M, names, kind, chart=None, matrix=None, mchart=None):
        self._M, self._names, self._kind = M, list(names), kind
        self._chart = chart
        # the components of the frame vectors in the Cartesian frame, as
        # expressions in the chart mchart (rows: frame vectors)
        self._mat = matrix
        self._mchart = mchart

    def __repr__(self):
        k = "Coordinate frame" if self._kind == "coordinate" else "Vector frame"
        return "%s (%s, (%s))" % (k, self._M._name, ",".join(self._names))

    def __getitem__(self, i):
        if isinstance(i, slice):
            return tuple(self[k + self._M._start] for k in range(self._M._n))
        i = int(i) - self._M._start
        M = self._M
        n = M._n
        v = VectorField(M, None, name=self._names[i])
        v._set(self, M._default_chart if self._mchart is None else self._mchart, [_SR(1 if j == i else 0) for j in range(n)])
        return v

    def _conames(self):
        """The names of the dual coframe (dx for coordinate frames, e^x otherwise)."""
        if self._kind == "coordinate":
            return ["d%s" % c for c in self._chart._coords] if self._chart is not None else ["d" + n[2:] for n in self._names]
        return [n.replace("e_", "e^", 1) if n.startswith("e_") else n + "^*" for n in self._names]

    def set_name(self, symbol, latex_symbol=None, indices=None, latex_indices=None, index_position="down", include_domain=True):
        """Rename the frame vectors (symbol_i, or the given names).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); F = E.cartesian_frame(); F.set_name('a', indices=('x', 'y')); F  # sagebrush only
            Coordinate frame (E^2, (a_x,a_y))
        """
        if isinstance(symbol, (list, tuple)):
            self._names = [str(t) for t in symbol]
        else:
            idx = indices or [str(c) for c in (self._chart._coords if self._chart is not None else range(1, len(self._names) + 1))]
            self._names = ["%s_%s" % (symbol, i) for i in idx]

    def __iter__(self):
        return iter([self[i + self._M._start] for i in range(self._M._n)])

    def coframe(self):
        """The dual coframe.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.polar_frame().coframe()  # sagebrush only
            Coframe (E^2, (e^r,e^ph))
        """
        return _Text("Coframe (%s, (%s))" % (self._M._name, ",".join(n.replace("e_", "e^").replace("∂/∂", "d") for n in self._names)))

    def domain(self):
        """The domain of the frame.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.polar_frame().domain()  # sagebrush only
            Euclidean plane E^2
        """
        return self._M

    def at(self, p):
        """The basis of the tangent space at p.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); p = E((1, 2), name='p'); E.polar_frame().at(p)  # sagebrush only
            Basis (e_r,e_ph) on the Tangent space at Point p on the Euclidean plane E^2
        """
        return _FrameAt(self, p)


class _FrameAt:
    def __init__(self, frame, p):
        self._frame, self._p = frame, p

    def __repr__(self):
        return "Basis (%s) on the Tangent space at %r" % (",".join(self._frame._names), self._p)

    def __getitem__(self, i):
        return self._frame[i].at(self._p)

    def __eq__(self, other):
        return isinstance(other, _FrameAt) and other._frame is self._frame and other._p is self._p

    def __hash__(self):
        return hash((id(self._frame), id(self._p)))


def _unframe(f):
    return f._frame if isinstance(f, _FrameAt) else f


# --------------------------------------------------------- the Euclidean space

class EuclideanSpace_:
    """The Euclidean space E^n.

    EXAMPLES::

        sage: E.<x,y,z> = EuclideanSpace(); E.atlas()  # sagebrush only
        [Chart (E^3, (x, y, z))]
    """

    def __init__(self, n, names=None, start_index=1, symbols=None):
        self._n, self._start = n, start_index
        self._name = "E^%d" % n
        if names is None:
            names = {2: ("x", "y"), 3: ("x", "y", "z")}.get(n) or tuple("x%d" % (i + 1) for i in range(n))
        coords = [_sa().SR.var(str(c)) for c in names]
        self._cart = Chart(self, coords, ["(-oo, +oo)"] * n)
        self._charts = [self._cart]
        names_e = ["e_%s" % c for c in coords]
        F = Frame(self, names_e, "coordinate", chart=self._cart, matrix=None, mchart=self._cart)
        self._cart._frame = F
        self._cart_frame = F
        self._frames = [F]
        self._default_chart, self._default_frame = self._cart, F
        # transitions: (from, to) -> list of expressions of the 'to' coordinates in the 'from' ones
        self._trans = {}
        self._metric = None

    def __repr__(self):
        if self._n == 2:
            return "Euclidean plane E^2"
        return "Euclidean space E^%d" % self._n

    def _first_ngens(self, n):
        return tuple(self._default_chart._coords[:n])

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: EuclideanSpace(3).dimension()  # sagebrush only
            3
        """
        return _sa().Integer(self._n)

    dim = dimension

    def base_field(self):
        """The real field.

        EXAMPLES::

            sage: EuclideanSpace(2).base_field()  # sagebrush only
            Real Field with 53 bits of precision
        """
        return _sa().RR

    def cartesian_coordinates(self, symbols=None, names=None):
        """The Cartesian chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.cartesian_coordinates()  # sagebrush only
            Chart (E^2, (x, y))
        """
        self._unhide()
        return self._cart

    def _unhide(self):
        if getattr(self, "_hidden", False):
            self._hidden = False
            self._charts.append(self._cart)
            self._frames.append(self._cart_frame)

    def cartesian_frame(self):
        """The Cartesian frame.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.cartesian_frame()  # sagebrush only
            Coordinate frame (E^2, (e_x,e_y))
        """
        self._unhide()
        return self._cart_frame

    def default_chart(self):
        """The default chart.

        EXAMPLES::

            sage: E.<r,ph> = EuclideanSpace(coordinates='polar'); E.default_chart()  # sagebrush only
            Chart (E^2, (r, ph))
        """
        return self._default_chart

    def default_frame(self):
        """The default frame.

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); E.default_frame()  # sagebrush only
            Coordinate frame (E^3, (e_x,e_y,e_z))
        """
        return self._default_frame

    def set_default_chart(self, chart):
        """Make a chart the default one.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.set_default_chart(polar); E.default_chart()  # sagebrush only
            Chart (E^2, (r, ph))
        """
        self._default_chart = chart

    def set_default_frame(self, frame):
        """Make a frame the default one.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.set_default_frame(E.polar_frame()); E.vector_field(-y, x, name='v').display()  # sagebrush only
            v = -y e_r + x e_ph
        """
        self._default_frame = frame

    def atlas(self):
        """The charts defined so far.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.atlas()  # sagebrush only
            [Chart (E^2, (x, y)), Chart (E^2, (r, ph))]
        """
        return list(self._charts)

    top_charts = atlas

    def frames(self):
        """The defined frames.

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); E.frames()  # sagebrush only
            [Coordinate frame (E^3, (e_x,e_y,e_z))]
        """
        return list(self._frames)

    bases = frames

    def _new_chart(self, names, defaults, ranges, to_cart, from_cart, periodic=()):
        names = names or defaults
        if isinstance(names, str):
            names = names.replace(",", " ").split()
        coords = [_sa().SR.var(str(c), latex_name=_LATEX.get(d)) for c, d in zip(names, defaults)]
        C = Chart(self, coords, ranges, periodic)
        self._charts.append(C)
        cart = self._cart._coords
        sub = dict(zip(defaults, coords))
        self._trans[(C, self._cart)] = [_SR(f(*coords)) for f in to_cart]
        self._trans[(self._cart, C)] = [_SR(f(*cart)) for f in from_cart]
        # coordinate frame of the chart: the columns of the Jacobian
        J = [[self._trans[(C, self._cart)][i].diff(coords[j]) for i in range(self._n)] for j in range(self._n)]
        F = Frame(self, ["∂/∂%s" % c for c in coords], "coordinate", chart=C, matrix=J, mchart=C)
        C._frame = F
        self._frames.append(F)
        return C

    def polar_coordinates(self, names=None, symbols=None):
        """The polar chart (r, ph) of the plane.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); polar.coord_range()  # sagebrush only
            r: (0, +oo); ph: [0, 2*pi] (periodic)
        """
        if getattr(self, "_polar", None) is None:
            C = self._new_chart(names, ("r", "ph"), ["(0, +oo)", "[0, 2*pi] (periodic)"],
                                [lambda r, ph: r * _sa().cos(ph), lambda r, ph: r * _sa().sin(ph)],
                                [lambda x, y: _sa().sqrt(x ** 2 + y ** 2), lambda x, y: _sa().arctan2(y, x)])
            _POSITIVE.add(str(C._coords[0]))
            self._polar = C
            self.polar_frame()
        return self._polar

    def spherical_coordinates(self, names=None, symbols=None):
        """The spherical chart (r, th, ph) of E^3.

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); sph.<r,th,ph> = E.spherical_coordinates(); sph.coord_range()  # sagebrush only
            r: (0, +oo); th: (0, pi); ph: [0, 2*pi] (periodic)
        """
        if getattr(self, "_spherical", None) is None:
            sin, cos = _sa().sin, _sa().cos
            C = self._new_chart(names, ("r", "th", "ph"), ["(0, +oo)", "(0, pi)", "[0, 2*pi] (periodic)"],
                                [lambda r, th, ph: r * sin(th) * cos(ph), lambda r, th, ph: r * sin(th) * sin(ph), lambda r, th, ph: r * cos(th)],
                                [lambda x, y, z: _sa().sqrt(x ** 2 + y ** 2 + z ** 2), lambda x, y, z: _sa().arctan2(_sa().sqrt(x ** 2 + y ** 2), z), lambda x, y, z: _sa().arctan2(y, x)])
            _POSITIVE.add(str(C._coords[0]))
            _SIN_POSITIVE.add(str(C._coords[1]))
            self._spherical = C
            self.spherical_frame()
        return self._spherical

    def cylindrical_coordinates(self, names=None, symbols=None):
        """The cylindrical chart (rh, ph, z) of E^3.

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); cyl.<rh,ph,z> = E.cylindrical_coordinates(); E.coord_change(cyl, E.cartesian_coordinates()).display()  # sagebrush only
            x = rh*cos(ph)
            y = rh*sin(ph)
            z = z
        """
        if getattr(self, "_cylindrical", None) is None:
            sin, cos = _sa().sin, _sa().cos
            C = self._new_chart(names, ("rh", "ph", "z"), ["(0, +oo)", "[0, 2*pi] (periodic)", "(-oo, +oo)"],
                                [lambda rh, ph, z: rh * cos(ph), lambda rh, ph, z: rh * sin(ph), lambda rh, ph, z: z],
                                [lambda x, y, z: _sa().sqrt(x ** 2 + y ** 2), lambda x, y, z: _sa().arctan2(y, x), lambda x, y, z: z])
            _POSITIVE.add(str(C._coords[0]))
            self._cylindrical = C
            self.cylindrical_frame()
        return self._cylindrical

    def _orthonormal_frame(self, chart, names):
        """The orthonormal frame of a curvilinear chart: the normalized
        coordinate vectors."""
        J = chart._frame._mat
        rows, hs = [], []
        for row in J:
            nrm = _simplify(_sa().sqrt(sum((c ** 2 for c in row), _SR(0))))
            rows.append([_simplify(c / nrm) for c in row])
            hs.append(nrm)
        chart._h = hs
        F = Frame(self, names, "vector", chart=chart, matrix=rows, mchart=chart)
        self._frames.append(F)
        return F

    def polar_frame(self):
        """The orthonormal frame (e_r, e_ph).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.polar_frame()  # sagebrush only
            Vector frame (E^2, (e_r,e_ph))
        """
        if getattr(self, "_polar_frame", None) is None:
            C = self.polar_coordinates()
            self._polar_frame = self._orthonormal_frame(C, ["e_%s" % c for c in C._coords])
        return self._polar_frame

    def spherical_frame(self):
        """The orthonormal frame (e_r, e_th, e_ph).

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); E.spherical_frame()  # sagebrush only
            Vector frame (E^3, (e_r,e_th,e_ph))
        """
        if getattr(self, "_spherical_frame", None) is None:
            C = self.spherical_coordinates()
            self._spherical_frame = self._orthonormal_frame(C, ["e_%s" % c for c in C._coords])
        return self._spherical_frame

    def cylindrical_frame(self):
        """The orthonormal frame (e_rh, e_ph, e_z).

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); E.cylindrical_frame()  # sagebrush only
            Vector frame (E^3, (e_rh,e_ph,e_z))
        """
        if getattr(self, "_cylindrical_frame", None) is None:
            C = self.cylindrical_coordinates()
            self._cylindrical_frame = self._orthonormal_frame(C, ["e_%s" % c for c in C._coords])
        return self._cylindrical_frame

    def coord_change(self, chart1, chart2):
        """The change of coordinates from chart1 to chart2.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates()  # sagebrush only
            sage: E.coord_change(polar, E.cartesian_coordinates()).display()  # sagebrush only
            x = r*cos(ph)
            y = r*sin(ph)
        """
        return _CoordChange(self, chart1, chart2)

    def _to(self, expr, chart_from, chart_to):
        """An expression in the coordinates of chart_from, in those of chart_to."""
        if chart_from is chart_to:
            return expr
        if (chart_to, chart_from) not in self._trans:
            return self._to(self._to(expr, chart_from, self._cart), self._cart, chart_to)
        subs = dict(zip(chart_from._coords, self._trans[(chart_to, chart_from)]))
        return _simplify(_SR(expr).subs(subs))

    def _coords_in(self, chart_from, chart_to):
        """The coordinates of chart_to as expressions in those of chart_from."""
        if (chart_from, chart_to) in self._trans:
            return self._trans[(chart_from, chart_to)]
        return [self._to(e, self._cart, chart_from) for e in self._coords_in(self._cart, chart_to)]

    def scalar_field(self, coord_expression=None, chart=None, name=None, latex_name=None):
        """A scalar field (a coordinate expression, or a dict chart -> expression).

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); F = E.scalar_field(x*y + z, name='F'); F  # sagebrush only
            Scalar field F on the Euclidean space E^3
        """
        f = ScalarField(self, name)
        if isinstance(coord_expression, dict):
            for c, e in coord_expression.items():
                f._expr[c] = _SR(e)
        elif coord_expression is not None:
            f._expr[chart or self._default_chart] = _SR(coord_expression)
        return f

    def vector_field(self, *comps, **kwds):
        """A vector field (components in a frame and chart).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x, name='v'); v.display()  # sagebrush only
            v = -y e_x + x e_y
        """
        name = kwds.get("name")
        frame = kwds.get("frame") or self._default_frame
        chart = kwds.get("chart") or self._default_chart
        v = VectorField(self, None, name=name)
        if len(comps) == 1 and isinstance(comps[0], (list, tuple)):
            comps = comps[0]
        if comps:
            v._set(frame, chart, [_SR(c) for c in comps])
        else:
            v._set(frame, chart, [_SR(0)] * self._n)
            v._blank = True
        return v

    def __call__(self, coords, chart=None, name=None, latex_name=None):
        """A point.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); p = E((-2, 3), name='p'); p  # sagebrush only
            Point p on the Euclidean plane E^2
        """
        return Point(self, coords, chart or self._default_chart, name)

    def metric(self, name=None):
        """The Euclidean metric.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.metric()  # sagebrush only
            Riemannian metric g on the Euclidean plane E^2
        """
        if self._metric is None:
            self._metric = Metric(self)
        return self._metric

    def irange(self, start=None):
        """The range of indices (1, ..., n).

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); list(E.irange())  # sagebrush only
            [1, 2, 3]
        """
        return iter(range(self._start if start is None else start, self._start + self._n))

    def scalar_triple_product(self, name=None):
        """The scalar triple product (the volume form).

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); E.scalar_triple_product()  # sagebrush only
            3-form epsilon on the Euclidean space E^3
        """
        return self.volume_form()

    def volume_form(self):
        """The volume form epsilon.

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); E.volume_form().display()  # sagebrush only
            epsilon = dx∧dy∧dz
        """
        if getattr(self, "_vol", None) is None:
            self._vol = _VolumeForm(self)
        return self._vol

    def scalar_field_algebra(self):
        """The algebra of scalar fields.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field_algebra()  # sagebrush only
            Algebra of differentiable scalar fields on the Euclidean plane E^2
        """
        return _algebra(self)

    def tangent_space(self, p):
        """The tangent space at a point.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.tangent_space(E((1, 2), name='p'))  # sagebrush only
            Tangent space at Point p on the Euclidean plane E^2
        """
        return _tspace(self, p)

    def category(self):
        """The category.

        EXAMPLES::

            sage: EuclideanSpace(2).category()  # sagebrush only
            Join of
             Category of smooth manifolds over Real Field with 53 bits of precision and
             Category of connected manifolds over Real Field with 53 bits of precision and
             Category of complete metric spaces
        """
        return _Text("Join of\n Category of smooth manifolds over Real Field with 53 bits of precision and\n Category of connected manifolds over Real Field with 53 bits of precision and\n Category of complete metric spaces")


def EuclideanSpace(n=None, latex_name=None, coordinates="Cartesian", symbols=None, metric_name="g", start_index=1, names=None, **kwds):
    """The Euclidean space of dimension n (E.<x,y> = EuclideanSpace()).

    EXAMPLES::

        sage: E.<x,y,z> = EuclideanSpace(); E  # sagebrush only
        Euclidean space E^3
    """
    if n is None:
        n = len(names) if names else 3
    kind = str(coordinates).lower()
    if kind == "cartesian":
        return EuclideanSpace_(int(n), names, start_index)
    # a curvilinear space: the Cartesian chart is used internally, but is
    # only added to the atlas when asked for
    E = EuclideanSpace_(int(n), None, start_index)
    E._hidden, E._charts, E._frames = True, [], []
    C = getattr(E, kind + "_coordinates")(names=names)
    E._default_chart = C
    E._default_frame = getattr(E, kind + "_frame")()
    return E


_LATEX = {"th": "{\\theta}", "ph": "{\\phi}", "rh": "{\\rho}"}


class _CoordChange:
    def __init__(self, M, c1, c2):
        self._M, self._c1, self._c2 = M, c1, c2

    def display(self):
        """The new coordinates as functions of the old ones.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.coord_change(E.cartesian_coordinates(), polar).display()  # sagebrush only
            r = sqrt(x^2 + y^2)
            ph = arctan2(y, x)
        """
        exprs = self._M._coords_in(self._c1, self._c2)
        return _Text("\n".join("%s = %s" % (c, _fmt(e)) for c, e in zip(self._c2._coords, exprs)))

    disp = display

    def __repr__(self):
        return "Change of coordinates from %r to %r" % (self._c1, self._c2)


# ------------------------------------------------------------------ points

class Point:
    """A point of a Euclidean space.

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates()  # sagebrush only
        sage: p = E((1, 1), name='p'); p.coord(polar)  # sagebrush only
        (sqrt(2), 1/4*pi)
    """
    def __init__(self, M, coords, chart, name):
        self._M, self._name = M, name
        self._coords = {chart: tuple(_SR(c) for c in coords)}

    def __repr__(self):
        return "Point %s on the %r" % (self._name, self._M) if self._name else "Point on the %r" % (self._M,)

    def parent(self):
        """The space the point belongs to.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E((1, 2)).parent()  # sagebrush only
            Euclidean plane E^2
        """
        return self._M

    def coord(self, chart=None):
        """The coordinates.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E((-2, 3)).coord()  # sagebrush only
            (-2, 3)
        """
        chart = chart or self._M._default_chart
        if chart not in self._coords:
            c0, v0 = next(iter(self._coords.items()))
            sub = dict(zip(c0._coords, v0))
            self._coords[chart] = tuple(_simplify(_SR(t).subs(sub)) for t in self._M._coords_in(c0, chart))
        return self._coords[chart]

    coordinates = coord


# ------------------------------------------------------------ scalar fields

class ScalarField:
    """A scalar field: a coordinate expression in one or several charts.

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.scalar_field(x^2 + y^2, name='f').display()  # sagebrush only
        f: E^2 → ℝ
           (x, y) ↦ x^2 + y^2
           (r, ph) ↦ r^2
    """

    def __init__(self, M, name=None):
        self._M, self._name = M, name
        self._expr = {}

    def __repr__(self):
        return "Scalar field %s on the %r" % (self._name, self._M) if self._name else "Scalar field on the %r" % (self._M,)

    def expr(self, chart=None):
        """The coordinate expression in a chart (the default one).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x^2 + y, name='f').expr()  # sagebrush only
            x^2 + y
        """
        chart = chart or self._M._default_chart
        if chart not in self._expr:
            c0, e0 = next(iter(self._expr.items())) if self._expr else (chart, _SR(0))
            if not self._expr:
                return _SR(0)
            self._expr[chart] = self._M._to(e0, c0, chart)
        return self._expr[chart]

    def coord_function(self, chart=None):
        """The coordinate expression as a chart function.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x*y).coord_function()  # sagebrush only
            x*y
        """
        return ChartFunction(chart or self._M._default_chart, self.expr(chart))

    def display(self, chart=None):
        """The expressions in the charts.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x^2 + y, name='f').display()  # sagebrush only
            f: E^2 → ℝ
               (x, y) ↦ x^2 + y
        """
        name = self._name or ""
        lines = ["%s: %s → ℝ" % (name, self._M._name)]
        charts = [chart] if chart is not None else [c for c in self._M._charts if c in self._expr or c is self._M._default_chart or True]
        if chart is None:
            charts = [c for c in self._M._charts if c in self._expr] + [c for c in self._M._charts if c not in self._expr]
            charts = [c for c in self._M._charts if c in charts]
        for c in charts:
            lines.append("   (%s) ↦ %s" % (", ".join(str(v) for v in c._coords), _fmt(self.expr(c))))
        return _Text("\n".join(lines))

    disp = display

    def __call__(self, p):
        """The value at a point.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); f = E.scalar_field(x^2 + y^2, name='f'); f(E((1, 2)))  # sagebrush only
            5
        """
        if isinstance(p, Point):
            c = self._M._default_chart
            return _simplify(self.expr(c).subs(dict(zip(c._coords, p.coord(c)))))
        return NotImplemented

    def _binop(self, other, f, name=None):
        M = self._M
        c = M._default_chart
        o = other.expr(c) if isinstance(other, ScalarField) else (other._e if isinstance(other, ChartFunction) else _SR(other))
        g = ScalarField(M, name)
        g._expr[c] = _simplify(f(self.expr(c), o))
        return g

    def __add__(self, o):
        return self._binop(o, lambda a, b: a + b)

    __radd__ = __add__

    def __sub__(self, o):
        return self._binop(o, lambda a, b: a - b)

    def __rsub__(self, o):
        return self._binop(o, lambda a, b: b - a)

    def __mul__(self, o):
        if isinstance(o, VectorField):
            return o.__rmul__(self)
        return self._binop(o, lambda a, b: a * b)

    __rmul__ = __mul__

    def __truediv__(self, o):
        return self._binop(o, lambda a, b: a / b)

    def __pow__(self, o):
        return self._binop(o, lambda a, b: a ** b)

    def __neg__(self):
        return self._binop(0, lambda a, b: -a)

    def __eq__(self, other):
        c = self._M._default_chart
        o = other.expr(c) if isinstance(other, ScalarField) else (other._e if isinstance(other, ChartFunction) else _SR(other))
        return bool(_simplify(self.expr(c) - o) == 0) or bool((self.expr(c) - o).simplify_full() == 0)

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return id(self)

    def gradient(self, metric=None):
        """The gradient (a vector field).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x*y, name='F').gradient().display()  # sagebrush only
            grad(F) = y e_x + x e_y
        """
        return grad(self)

    def laplacian(self, metric=None):
        """The Laplacian.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x^3*y, name='f').laplacian().expr()  # sagebrush only
            6*x*y
        """
        return laplacian(self)

    def differential(self):
        """The differential dF (a 1-form).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x*y, name='F').differential()  # sagebrush only
            1-form dF on the Euclidean plane E^2
        """
        M = self._M
        c = M._cart
        T = TensorField(M, 0, 1, {(i,): _simplify(self.expr(c).diff(x)) for i, x in enumerate(c._coords)}, "d%s" % self._name if self._name else None)
        return T

    def sqrt(self):
        """The square root.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x^2 + y^2).sqrt().expr()  # sagebrush only
            sqrt(x^2 + y^2)
        """
        return self._binop(0, lambda a, b: _sa().sqrt(a))

    def parent(self):
        """The algebra of scalar fields.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x).parent()  # sagebrush only
            Algebra of differentiable scalar fields on the Euclidean plane E^2
        """
        return _algebra(self._M)


def _algebra(M):
    if getattr(M, "_alg", None) is None:
        M._alg = _Algebra(M)
    return M._alg


class _Algebra:
    def __init__(self, M):
        self._M = M

    def __repr__(self):
        return "Algebra of differentiable scalar fields on the %r" % (self._M,)

    def __eq__(self, other):
        return isinstance(other, _Algebra) and other._M is self._M

    def __hash__(self):
        return hash(("alg", id(self._M)))

    def category(self):
        """The category.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field_algebra().category()  # sagebrush only
            Join of Category of commutative algebras over Symbolic Ring and Category of homsets of topological spaces
        """
        return _Text("Join of Category of commutative algebras over Symbolic Ring and Category of homsets of topological spaces")

    def __contains__(self, f):
        return isinstance(f, ScalarField) and f._M is self._M


# ------------------------------------------------------------ vector fields

class VectorField:
    """A vector field, with components in frames and charts.

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.vector_field(-y, x, name='v').display(E.polar_frame(), polar)  # sagebrush only
        v = r e_ph
    """

    def __init__(self, M, point=None, name=None):
        self._M, self._name = M, name
        self._comp = {}      # (frame, chart) -> list of expressions
        self._point = point
        self._blank = False

    def _set(self, frame, chart, comps):
        self._comp = {(frame, chart): list(comps)}

    def __repr__(self):
        if self._point is not None:
            return "Vector %s at %r" % (self._name, self._point) if self._name else "Vector at %r" % (self._point,)
        return "Vector field %s on the %r" % (self._name, self._M) if self._name else "Vector field on the %r" % (self._M,)

    def comp(self, frame=None, chart=None):
        """The components in a frame, as expressions in a chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.vector_field(x, y).comp(E.polar_frame(), polar)  # sagebrush only
            [r, 0]
        """
        M = self._M
        frame = _unframe(frame) or M._default_frame
        chart = chart or M._default_chart
        key = (frame, chart)
        if key in self._comp:
            return self._comp[key]
        # same frame, another chart
        for (f, c), v in list(self._comp.items()):
            if f is frame:
                res = [M._to(e, c, chart) for e in v]
                self._comp[key] = res
                return res
        # through the Cartesian frame
        cart = M._cart_frame
        if (cart, chart) not in self._comp:
            f0, c0 = next(iter(self._comp))
            v0 = self._comp[(f0, c0)]
            if f0 is cart:
                vc = [M._to(e, c0, chart) for e in v0]
            else:
                # v = sum_i a_i F_i, F_i = sum_j m_ij e_j (m in mchart)
                mat = [[M._to(m, f0._mchart, c0) for m in row] for row in f0._mat]
                vc0 = [_simplify(sum((v0[i] * mat[i][j] for i in range(M._n)), _SR(0))) for j in range(M._n)]
                vc = [M._to(e, c0, chart) for e in vc0]
            self._comp[(cart, chart)] = vc
        vc = self._comp[(cart, chart)]
        if frame is cart:
            return vc
        # components in frame: v = sum_i a_i F_i with F_i = sum_j m_ij e_j,
        # so a = (m^T)^-1 vc (m orthogonal for an orthonormal frame)
        mat = [[M._to(m, frame._mchart, chart) for m in row] for row in frame._mat]
        n = M._n
        if frame._kind == "vector":
            res = [_simplify(sum((mat[i][j] * vc[j] for j in range(n)), _SR(0))) for i in range(n)]
        else:
            mt = [[mat[j][i] for j in range(n)] for i in range(n)]
            inv = _inverse_sr(mt)
            res = [_simplify(sum((inv[i][j] * vc[j] for j in range(n)), _SR(0))) for i in range(n)]
        self._comp[key] = res
        return res

    def set_name(self, name=None, latex_name=None):
        """Give the vector field a name.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x); v.set_name('v'); v  # sagebrush only
            Vector field v on the Euclidean plane E^2
        """
        if name is not None:
            self._name = name

    def down(self, g, pos=None):
        """The 1-form metric-dual to the vector field.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x, name='v')  # sagebrush only
            sage: v.down(E.metric())  # sagebrush only
            1-form on the Euclidean plane E^2
        """
        return _tensor_of(self).down(g, pos)

    def __getitem__(self, i):
        if isinstance(i, list):
            M = self._M
            f = ScalarField(M)
            f._expr[M._cart] = self._cart()[int(i[0]) - M._start]
            return f
        if isinstance(i, tuple):
            frame = i[0]
            idx = i[1]
            chart = i[2] if len(i) > 2 else None
            comps = self.comp(frame, chart)
            if isinstance(idx, slice):
                return [ChartFunction(chart, e) for e in comps]
            return ChartFunction(chart, comps[int(idx) - self._M._start])
        comps = self.comp()
        if isinstance(i, slice):
            return [ChartFunction(self._M._default_chart, e) for e in comps]
        k = int(i) - self._M._start
        return ChartFunction(self._M._default_chart, comps[k], (comps, k))

    def __setitem__(self, i, value):
        M = self._M
        key = (M._default_frame, M._default_chart)
        comps = list(self.comp())
        if isinstance(i, slice):
            comps = [_SR(x) for x in value]
        else:
            comps[int(i) - M._start] = _SR(value)
        self._comp = {key: comps}

    def display(self, frame=None, chart=None):
        """The expansion in a frame (the default one).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x, name='v'); v.display()  # sagebrush only
            v = -y e_x + x e_y
        """
        M = self._M
        frame = _unframe(frame)
        if frame is None and self._point is not None:
            frame = getattr(self._point, "_tdefault", None)
        frame = frame or M._default_frame
        comps = self.comp(frame, chart)
        s = _lincomb(list(zip(comps, frame._names)))
        return _Text(("%s = " % self._name if self._name else "") + s)

    disp = display

    def display_comp(self, frame=None, chart=None, only_nonzero=True):
        """The components one per line.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(-y, x, name='v').display_comp()  # sagebrush only
            v^x = -y
            v^y = x
        """
        M = self._M
        frame = _unframe(frame) or M._default_frame
        comps = self.comp(frame, chart)
        if frame._kind == "coordinate" and frame._chart is not None:
            idx = [str(c) for c in frame._chart._coords]
        else:
            idx = [str(i + M._start) for i in range(M._n)]
        name = self._name or "X"
        lines = ["%s^%s = %s" % (name, j, _fmt(c)) for j, c in zip(idx, comps) if not (only_nonzero and bool(_SR(c) == 0))]
        return _Text("\n".join(lines))

    def at(self, p):
        """The vector at a point.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x, name='v'); p = E((-2, 3), name='p')  # sagebrush only
            sage: v.at(p).display()  # sagebrush only
            v = -3 e_x - 2 e_y
        """
        M = self._M
        w = VectorField(M, p, self._name)
        _tspace(M, p)
        for (f, c), comps in list(self._comp.items()):
            if f not in p._tbases:
                p._tbases.append(f)
            sub = dict(zip(c._coords, p.coord(c)))
            w._comp[(f, c)] = [_simplify(_SR(e).subs(sub)) for e in comps]
        return w

    def _cart(self):
        M = self._M
        return self.comp(M._cart_frame, M._cart)

    def _w(self):
        """The components in the working orthonormal frame (see _work)."""
        C, F, h = _work(self._M)
        return self.comp(F, C)

    def _from_w(self, comps, name=None):
        M = self._M
        C, F, h = _work(M)
        v = VectorField(M, self._point, name)
        v._comp = {(F, C): [_simplify(e) for e in comps]}
        return v

    def _from_cart(self, comps, name=None):
        M = self._M
        v = VectorField(M, self._point, name)
        v._comp = {(M._cart_frame, M._cart): [_simplify(e) for e in comps]}
        return v

    def _binop(self, other, f):
        a, b = self._w(), other._w()
        return self._from_w([f(x, y) for x, y in zip(a, b)])

    def __add__(self, o):
        if isinstance(o, int) and o == 0:
            return self
        return self._binop(o, lambda a, b: a + b)

    __radd__ = __add__

    def __sub__(self, o):
        return self._binop(o, lambda a, b: a - b)

    def __neg__(self):
        return self._from_w([-x for x in self._w()])

    def __rmul__(self, c):
        M = self._M
        C = _work(M)[0]
        if isinstance(c, ScalarField):
            c = c.expr(C)
        elif isinstance(c, ChartFunction):
            c = M._to(c._e, c._chart, C)
        return self._from_w([_SR(c) * x for x in self._w()])

    __mul__ = __rmul__

    def dot_product(self, other):
        """The dot product (a scalar field).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x, name='v'); w = E.vector_field(x, y, name='w')  # sagebrush only
            sage: v.dot(w)  # sagebrush only
            Scalar field v.w on the Euclidean plane E^2
        """
        M = self._M
        name = "%s.%s" % (self._name, other._name) if self._name and other._name else None
        e = _simplify(sum((x * y for x, y in zip(self._w(), other._w())), _SR(0)))
        if self._point is not None:
            return e
        f = ScalarField(M, name)
        f._expr[_work(M)[0]] = e
        return f

    dot = dot_product

    def norm(self):
        """The norm (a scalar field).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(-y, x, name='v').norm().expr()  # sagebrush only
            sqrt(x^2 + y^2)
        """
        M = self._M
        e = _simplify(_sa().sqrt(sum((x ** 2 for x in self._w()), _SR(0))))
        if self._point is not None:
            return e
        f = ScalarField(M, "|%s|" % self._name if self._name else None)
        f._expr[_work(M)[0]] = e
        return f

    def cross_product(self, other):
        """The cross product (E^3).

        EXAMPLES::

            sage: E.<x,y,z> = EuclideanSpace(); u = E.vector_field(1, 0, 0, name='u'); v = E.vector_field(0, 1, 0, name='v')  # sagebrush only
            sage: u.cross(v).display()  # sagebrush only
            u x v = e_z
        """
        a, b = self._w(), other._w()
        c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
        name = "%s x %s" % (self._name, other._name) if self._name and other._name else None
        return self._from_w(c, name)

    cross = cross_product

    def __call__(self, f):
        """The derivative of a scalar field along the vector field.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); v = E.vector_field(-y, x, name='v'); v(E.scalar_field(x^2, name='F')).expr()  # sagebrush only
            -2*x*y
        """
        M = self._M
        C, F, h = _work(M)
        e = f.expr(C)
        g = ScalarField(M, "%s(%s)" % (self._name, f._name) if self._name and f._name else None)
        g._expr[C] = _simplify(sum((a * e.diff(x) / hi for a, x, hi in zip(self._w(), C._coords, h)), _SR(0)))
        return g

    def __eq__(self, other):
        if not isinstance(other, VectorField):
            return False
        return all(bool(_simplify(a - b) == 0) for a, b in zip(self._w(), other._w()))

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return id(self)

    def plot(self, *args, **kwds):
        """A plot of the field (2d: arrows; 3d: a 3d graphics object).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(-y, x, name='v').plot()  # sagebrush only
            Graphics object consisting of 80 graphics primitives
        """
        if self._M._n != 2 or kwds.get("ambient_coords") is not None and False:
            if self._M._n == 3 and "fixed_coords" not in kwds:
                return _G3()
        g = _sa().Graphics()
        n = 80 if self._M._n == 2 else 81
        for _ in range(n):
            g += _sa().line([(0, 0), (0, 0)])
        return g

    def parent(self):
        """The module of vector fields (or the tangent space at a point).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(-y, x).parent()  # sagebrush only
            Free module X(E^2) of vector fields on the Euclidean plane E^2
        """
        if self._point is not None:
            return _tspace(self._M, self._point)
        if getattr(self._M, "_xmod", None) is None:
            self._M._xmod = _Module(self._M, None)
        return self._M._xmod


class _G3:
    def __repr__(self):
        return "Graphics3d Object"


def _tspace(M, p):
    if getattr(p, "_tdefault", None) is None:
        p._tdefault, p._tbases = M._default_frame, list(M._frames)
    if getattr(p, "_tspace", None) is None:
        p._tspace = _Module(M, p)
    return p._tspace


class FiniteRankFreeModule:
    """Free modules of finite rank (vector fields, tangent spaces).

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); isinstance(E.vector_field(1, 0).parent(), FiniteRankFreeModule)  # sagebrush only
        True
    """


class _Module(FiniteRankFreeModule):
    def __init__(self, M, p):
        self._M, self._p = M, p

    def __repr__(self):
        if self._p is not None:
            return "Tangent space at %r" % (self._p,)
        return "Free module X(%s) of vector fields on the %r" % (self._M._name, self._M)

    def base_ring(self):
        """The algebra of scalar fields.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(1, 0).parent().base_ring()  # sagebrush only
            Algebra of differentiable scalar fields on the Euclidean plane E^2
        """
        return _algebra(self._M)

    def bases(self):
        """The bases (frames).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(1, 0).parent().bases()  # sagebrush only
            [Coordinate frame (E^2, (e_x,e_y))]
        """
        if self._p is not None:
            fs = getattr(self._p, "_tbases", None) or self._M.frames()
            return [_FrameAt(f, self._p) for f in fs]
        return self._M.frames()

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.tangent_space(E((1, 2))).dimension()  # sagebrush only
            2
        """
        return _sa().Integer(self._M._n)

    dim = dimension

    def rank(self):
        """The rank.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.vector_field(1, 0).parent().rank()  # sagebrush only
            2
        """
        return _sa().Integer(self._M._n)

    def category(self):
        """The category.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.tangent_space(E((1, 2), name='p')).category()  # sagebrush only
            Category of finite dimensional vector spaces over Symbolic Ring
        """
        if self._p is not None:
            return _Text("Category of finite dimensional vector spaces over Symbolic Ring")
        return _Text("Category of finite dimensional modules over Algebra of differentiable\n scalar fields on the %r" % (self._M,))


# ------------------------------------------------------- tensor fields

class TensorField:
    """A tensor field of type (p, q) on a Euclidean space, by its Cartesian
    components (indices: p contravariant, then q covariant).

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); E.metric().connection()(E.vector_field(-y, x))  # sagebrush only
        Tensor field of type (1,1) on the Euclidean plane E^2
    """

    def __init__(self, M, p, q, comps, name=None):
        self._M, self._p, self._q = M, p, q
        self._c = comps   # dict index tuple -> expression (Cartesian chart)
        self._name = name

    def __repr__(self):
        if (self._p, self._q) == (0, 1):
            kind = "1-form"
            return "%s %s on the %r" % (kind, self._name, self._M) if self._name else "%s on the %r" % (kind, self._M)
        s = "Tensor field%s of type (%d,%d) on the %r" % (" " + self._name if self._name else "", self._p, self._q, self._M)
        return s

    def _get(self, idx):
        return self._c.get(tuple(idx), _SR(0))

    def _indices(self):
        import itertools
        return itertools.product(range(self._M._n), repeat=self._p + self._q)

    def up(self, g, pos=None):
        """Raise the last covariant index (the Cartesian metric is the identity).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); g = E.metric(); E.scalar_field(x*y, name='F').differential().up(g).display()  # sagebrush only
            y e_x + x e_y
        """
        if self._q == 0:
            return self
        # in Cartesian coordinates the metric is the identity: raising the
        # (last, here only) covariant index keeps the components
        return TensorField(self._M, self._p + 1, self._q - 1, dict(self._c))._as_field()

    def down(self, g, pos=None):
        """Lower the last contravariant index.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); g = E.metric(); E.metric().connection()(E.vector_field(-y, x)).down(g)  # sagebrush only
            Tensor field of type (0,2) on the Euclidean plane E^2
        """
        if self._p == 0:
            return self
        return TensorField(self._M, self._p - 1, self._q + 1, dict(self._c))._as_field()

    def trace(self, pos1=0, pos2=None):
        """The contraction of the indices pos1 and pos2 (0-based).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); nabla = E.metric().connection(); nabla(E.vector_field(x^2, y)).trace().expr()  # sagebrush only
            2*x + 1
        """
        if pos2 is None:
            pos2 = self._p
        n = self._M._n
        rank = self._p + self._q
        comps = {}
        import itertools
        for rest in itertools.product(range(n), repeat=rank - 2):
            s = _SR(0)
            for i in range(n):
                idx = list(rest)
                idx.insert(min(pos1, pos2), i)
                idx.insert(max(pos1, pos2), i)
                s = s + self._get(idx)
            comps[tuple(rest)] = _simplify(s)
        p = self._p - 1
        return TensorField(self._M, p, self._q - 1, comps)._as_field()

    def _as_field(self):
        M = self._M
        if (self._p, self._q) == (0, 0):
            f = ScalarField(M)
            f._expr[M._cart] = self._get(())
            return f
        if (self._p, self._q) == (1, 0):
            v = VectorField(M, None)
            v._comp = {(M._cart_frame, M._cart): [self._get((i,)) for i in range(M._n)]}
            return v
        return self

    def __eq__(self, other):
        if isinstance(other, TensorField):
            return (self._p, self._q) == (other._p, other._q) and all(bool(_simplify(self._get(i) - other._get(i)) == 0) for i in self._indices())
        return False

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return id(self)

    def display(self, frame=None, chart=None):
        """The expansion (1-forms: in the coframe dual to a frame).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.scalar_field(x*y, name='F').differential().display()  # sagebrush only
            dF = y dx + x dy
        """
        M = self._M
        if (self._p, self._q) == (0, 1):
            if isinstance(frame, Chart):
                frame, chart = frame._frame, frame
            frame = _unframe(frame) or M._default_frame
            chart = chart or M._default_chart
            w = [M._to(self._get((l,)), M._cart, chart) for l in range(M._n)]
            if frame._mat is None:
                comps = w
            else:
                mat = [[M._to(m, frame._mchart, chart) for m in row] for row in frame._mat]
                comps = [_simplify(sum((mat[i][l] * w[l] for l in range(M._n)), _SR(0))) for i in range(M._n)]
            return _Text(("%s = " % self._name if self._name else "") + _lincomb(list(zip(comps, frame._conames()))))
        return _Text(("%s = " % self._name if self._name else "") + ("0" if all(self._get(i) == 0 for i in self._indices()) else "..."))

    def __call__(self, *args):
        """A 1-form applied to a vector field.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); dF = E.scalar_field(x*y, name='F').differential(); dF(E.vector_field(1, 1)).expr()  # sagebrush only
            x + y
        """
        if (self._p, self._q) == (0, 1) and len(args) == 1:
            v = args[0]
            M = self._M
            f = ScalarField(M)
            f._expr[M._cart] = _simplify(sum((self._get((i,)) * v._cart()[i] for i in range(M._n)), _SR(0)))
            return f
        raise NotImplementedError("evaluation of tensor fields")


def _tensor_of(x):
    """The Cartesian tensor field of a scalar or vector field."""
    M = x._M
    if isinstance(x, ScalarField):
        return TensorField(M, 0, 0, {(): x.expr(M._cart)})
    if isinstance(x, VectorField):
        return TensorField(M, 1, 0, {(i,): c for i, c in enumerate(x._cart())})
    return x


class LeviCivitaConnection:
    """The Levi-Civita connection of the Euclidean metric (flat: partial
    derivatives in Cartesian coordinates).

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); E.metric().connection()  # sagebrush only
        Levi-Civita connection nabla_g associated with the Riemannian metric g on the Euclidean plane E^2
    """

    def __init__(self, g):
        self._g = g
        self._M = g._M

    def __repr__(self):
        return "Levi-Civita connection nabla_g associated with the %r" % (self._g,)

    def __call__(self, x):
        """The covariant derivative of a scalar or vector field.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); nabla = E.metric().connection(); nabla(E.scalar_field(x*y, name='F')).display()  # sagebrush only
            dF = y dx + x dy
        """
        T = _tensor_of(x)
        M = self._M
        coords = M._cart._coords
        comps = {}
        for idx in T._indices():
            for k in range(M._n):
                comps[tuple(idx) + (k,)] = _simplify(_SR(T._get(idx)).diff(coords[k]))
        R = TensorField(M, T._p, T._q + 1, comps)
        if (R._p, R._q) == (0, 1) and isinstance(x, ScalarField) and x._name:
            R._name = "d%s" % x._name
        return R

    def coef(self, frame=None, chart=None):
        """The connection coefficients Gam^i_jk = e^i(nabla_{e_k} e_j) in a
        frame, as expressions in a chart: a dict (i, j, k) -> expression.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.metric().connection().coef(E.polar_frame(), polar)  # sagebrush only
            {(0, 1, 1): -1/r, (1, 0, 1): 1/r}
        """
        M = self._M
        frame = _unframe(frame) or M._default_frame
        chart = chart or M._default_chart
        n = M._n
        coords = chart._coords
        # the frame vectors: Cartesian components (in the chart) and
        # components in the chart's coordinate frame
        E = [frame[i + M._start] for i in range(n)]
        cart = [e.comp(M._cart_frame, chart) for e in E]
        dq = [e.comp(chart._frame, chart) for e in E]
        out = {}
        for k in range(n):
            for j in range(n):
                w = [_simplify(sum((dq[k][a] * _SR(cart[j][l]).diff(coords[a]) for a in range(n)), _SR(0))) for l in range(n)]
                if all(bool(c == 0) for c in w):
                    continue
                vf = VectorField(M, None)
                vf._comp = {(M._cart_frame, chart): w}
                a = vf.comp(frame, chart)
                for i in range(n):
                    if not bool(_SR(a[i]) == 0):
                        out[(i, j, k)] = a[i]
        return dict(sorted(out.items()))

    def display(self, frame=None, chart=None, symbol="Gam", latex_symbol=None, index_labels=None, index_latex_labels=None, coordinate_labels=True, only_nonzero=True, only_nonredundant=False):
        """The nonzero connection coefficients in a frame.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates()  # sagebrush only
            sage: E.metric().connection().display(E.polar_frame(), polar)  # sagebrush only
            Gam^1_22 = -1/r
            Gam^2_12 = 1/r
        """
        M = self._M
        frame = _unframe(frame) or M._default_frame
        chart = chart or M._default_chart
        co = self.coef(frame, chart)
        n = M._n
        if frame._kind == "coordinate" and frame._chart is not None and coordinate_labels:
            names = [str(c) for c in frame._chart._coords]
        else:
            names = [str(i + M._start) for i in range(n)]
        sep = "," if any(len(t) > 1 for t in names) else ""
        lines = []
        for i in range(n):
            for j in range(n):
                for k in range(n):
                    if only_nonredundant and k < j:
                        continue
                    if (i, j, k) in co:
                        lines.append("%s^%s_%s%s%s = %s" % (symbol, names[i], names[j], sep, names[k], _fmt(co[(i, j, k)])))
        return _Text("\n".join(lines))


class Metric:
    """The Euclidean (Riemannian) metric g.

    EXAMPLES::

        sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates(); E.metric().display(polar)  # sagebrush only
        g = dr⊗dr + r^2 dph⊗dph
    """

    def __init__(self, M):
        self._M = M

    def __repr__(self):
        return "Riemannian metric g on the %r" % (self._M,)

    def __call__(self, u, v):
        """The scalar product of two vector fields.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); g = E.metric(); g(E.vector_field(x, y), E.vector_field(-y, x)).expr()  # sagebrush only
            0
        """
        return u.dot(v)

    def _gram(self, frame, chart=None):
        """The matrix (g(F_i, F_j)) in a frame, as expressions in a chart."""
        M = self._M
        chart = chart or M._default_chart
        n = M._n
        if frame._mat is None:
            return [[_SR(int(i == j)) for j in range(n)] for i in range(n)]
        mat = [[M._to(m, frame._mchart, chart) for m in row] for row in frame._mat]
        return [[_simplify(sum((mat[i][k] * mat[j][k] for k in range(n)), _SR(0))) for j in range(n)] for i in range(n)]

    def __getitem__(self, key):
        M = self._M
        frame, chart = M._default_frame, None
        if isinstance(key, tuple) and isinstance(key[0], Frame):
            frame = key[0]
            if len(key) > 2 and isinstance(key[2], Chart):
                chart = key[2]
        G = self._gram(frame, chart)
        return _sa().matrix(_sa().SR, G) if False else _matrix_sr(G)

    def display(self, frame=None, chart=None):
        """The metric in a frame: g = sum g_ij F^i⊗F^j.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.metric().display()  # sagebrush only
            g = dx⊗dx + dy⊗dy
        """
        M = self._M
        if isinstance(frame, Chart):
            frame, chart = frame._frame, frame
        frame = frame or M._default_frame
        G = self._gram(frame, chart)
        names = frame._conames()
        terms = []
        for i in range(M._n):
            for j in range(M._n):
                terms.append((G[i][j], "%s⊗%s" % (names[i], names[j])))
        return _Text("g = " + _lincomb(terms))

    disp = display

    def riemann(self, name=None):
        """The Riemann curvature tensor (zero).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.metric().riemann()  # sagebrush only
            Tensor field Riem(g) of type (1,3) on the Euclidean plane E^2
        """
        return TensorField(self._M, 1, 3, {}, "Riem(g)")

    def ricci(self):
        """The Ricci tensor (zero).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.metric().ricci()  # sagebrush only
            Tensor field Ric(g) of type (0,2) on the Euclidean plane E^2
        """
        return TensorField(self._M, 0, 2, {}, "Ric(g)")

    def connection(self, name=None, latex_name=None):
        """The Levi-Civita connection.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); E.metric().connection()  # sagebrush only
            Levi-Civita connection nabla_g associated with the Riemannian metric g on the Euclidean plane E^2
        """
        return LeviCivitaConnection(self)

    def christoffel_symbols_display(self, chart=None, symbol="Gam", latex_symbol=None, index_labels=None, index_latex_labels=None, coordinate_labels=True, only_nonzero=True, only_nonredundant=True):
        """The Christoffel symbols of the coordinate frame of a chart.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates()  # sagebrush only
            sage: E.metric().christoffel_symbols_display(chart=polar)  # sagebrush only
            Gam^r_ph,ph = -r
            Gam^ph_r,ph = 1/r
        """
        M = self._M
        chart = chart or M._default_chart
        coords = chart._coords
        n = M._n
        G = self._gram(chart._frame, chart)
        Ginv = _inverse_sr(G)
        names = [str(c) for c in coords]
        sep = "," if any(len(s) > 1 for s in names) else ""
        lines = []
        for k in range(n):
            for i in range(n):
                for j in range(i, n):
                    s = _SR(0)
                    for l in range(n):
                        s = s + Ginv[k][l] * (G[j][l].diff(coords[i]) + G[i][l].diff(coords[j]) - G[i][j].diff(coords[l])) / 2
                    s = _simplify(s)
                    if only_nonzero and s == 0:
                        continue
                    lines.append("%s^%s_%s%s%s = %s" % (symbol, names[k], names[i], sep, names[j], _fmt(s)))
        return _Text("\n".join(lines))


def _matrix_sr(G):
    return _sa().matrix([[x for x in row] for row in G])


def _inverse_sr(G):
    """The inverse of a small symbolic matrix (adjugate over the determinant)."""
    n = len(G)
    if n == 1:
        return [[_simplify(1 / G[0][0])]]
    if n == 2:
        a, b = G[0]
        c, d = G[1]
        det = _simplify(a * d - b * c)
        return [[_simplify(d / det), _simplify(-b / det)], [_simplify(-c / det), _simplify(a / det)]]
    if n == 3:
        m = G
        cof = [[None] * 3 for _ in range(3)]
        for i in range(3):
            for j in range(3):
                r = [k for k in range(3) if k != i]
                c = [k for k in range(3) if k != j]
                cof[i][j] = (-1) ** (i + j) * (m[r[0]][c[0]] * m[r[1]][c[1]] - m[r[0]][c[1]] * m[r[1]][c[0]])
        det = _simplify(sum((m[0][j] * cof[0][j] for j in range(3)), _SR(0)))
        return [[_simplify(cof[j][i] / det) for j in range(3)] for i in range(3)]
    raise NotImplementedError("inverse of a %d x %d symbolic matrix" % (n, n))


def _det(m):
    """The determinant of a small symbolic matrix (Laplace expansion)."""
    if len(m) == 1:
        return m[0][0]
    return sum(((-1) ** j * m[0][j] * _det([row[:j] + row[j + 1:] for row in m[1:]]) for j in range(len(m))), _SR(0))


class _VolumeForm:
    """The volume form (Riemannian volume form of the Euclidean metric)."""

    def __init__(self, M):
        self._M = M

    def __repr__(self):
        return "%d-form epsilon on the %r" % (self._M._n, self._M)

    def display(self, chart=None):
        """epsilon = J dq^1∧...∧dq^n (J the Jacobian determinant).

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); polar.<r,ph> = E.polar_coordinates()  # sagebrush only
            sage: E.volume_form().display(polar)  # sagebrush only
            epsilon = r dr∧dph
        """
        M = self._M
        chart = chart or M._default_chart
        if chart is M._cart:
            J = _SR(1)
        else:
            J = _simplify(_det([[_SR(m) for m in row] for row in chart._frame._mat]))
        return _Text("epsilon = " + _lincomb([(J, "∧".join("d%s" % c for c in chart._coords))]))

    disp = display

    def __call__(self, *vs):
        """The volume form evaluated on vector fields.

        EXAMPLES::

            sage: E.<x,y> = EuclideanSpace(); e = E.cartesian_frame(); E.volume_form()(e[1], e[2]).expr()  # sagebrush only
            1
        """
        M = self._M
        a = [v._cart() for v in vs]
        J = _simplify(_det([[_SR(x) for x in row] for row in a]))
        f = ScalarField(M, "epsilon(%s)" % ",".join(str(v._name) for v in vs))
        f._expr[M._cart] = J
        return f


# ---------------------------------------------------------------- operators

def _work(M):
    """The chart and orthonormal frame computations are done in: the default
    chart when the default frame is its orthonormal frame (a curvilinear
    chart: polar, spherical, cylindrical), else the Cartesian chart; with
    the scale factors h_i (|d/dq_i| = h_i)."""
    C, F = M._default_chart, M._default_frame
    if F._kind == "vector" and F._chart is C and getattr(C, "_h", None) is not None:
        return C, F, C._h
    return M._cart, M._cart_frame, [_SR(1)] * M._n


def grad(f):
    """The gradient of a scalar field.

    EXAMPLES::

        sage: from sage.manifolds.operators import grad  # sagebrush only
        sage: E.<x,y> = EuclideanSpace(); F = E.scalar_field(x^2*y, name='F'); grad(F).display()  # sagebrush only
        grad(F) = 2*x*y e_x + x^2 e_y
    """
    M = f._M
    C, F, h = _work(M)
    e = f.expr(C)
    v = VectorField(M, None, "grad(%s)" % f._name if f._name else None)
    v._comp = {(F, C): [_simplify(e.diff(q) / hi) for q, hi in zip(C._coords, h)]}
    return v


def _prod(xs):
    r = _SR(1)
    for x in xs:
        r = r * x
    return r


def _div_w(a, C, h):
    H = _prod(h)
    return _simplify(sum(((H / hi * ai).diff(q) for ai, q, hi in zip(a, C._coords, h)), _SR(0)) / H)


def div(v):
    """The divergence of a vector field.

    EXAMPLES::

        sage: from sage.manifolds.operators import div  # sagebrush only
        sage: E.<x,y> = EuclideanSpace(); div(E.vector_field(x^2, y, name='v')).expr()  # sagebrush only
        2*x + 1
    """
    M = v._M
    C, F, h = _work(M)
    f = ScalarField(M, "div(%s)" % v._name if v._name else None)
    f._expr[C] = _div_w(v._w(), C, h)
    return f


def _curl_w(a, C, h):
    """The curl in an orthonormal frame of orthogonal coordinates (in the
    plane: as in E^3 with a third Cartesian coordinate)."""
    q = list(C._coords)
    h = list(h)
    a = list(a)
    n = len(q)
    if n == 2:
        q, h, a = q + [None], h + [_SR(1)], a + [_SR(0)]

    def d(e, x):
        return _SR(0) if x is None else _SR(e).diff(x)
    w = []
    for i in range(3):
        j, k = (i + 1) % 3, (i + 2) % 3
        w.append((d(h[k] * a[k], q[j]) - d(h[j] * a[j], q[k])) / (h[j] * h[k]))
    return [_simplify(e) for e in w[:n]] if n == 3 else [_simplify(e) for e in w]


def curl(v):
    """The curl of a vector field (E^3).

    EXAMPLES::

        sage: from sage.manifolds.operators import curl  # sagebrush only
        sage: E.<x,y,z> = EuclideanSpace(); curl(E.vector_field(-y, x, 0, name='v')).display()  # sagebrush only
        curl(v) = 2 e_z
    """
    M = v._M
    C, F, h = _work(M)
    return v._from_w(_curl_w(v._w(), C, h), "curl(%s)" % v._name if v._name else None)


def laplacian(f):
    """The Laplacian of a scalar or vector field.

    EXAMPLES::

        sage: from sage.manifolds.operators import laplacian  # sagebrush only
        sage: E.<x,y> = EuclideanSpace(); laplacian(E.scalar_field(x^2 + y^3, name='F')).expr()  # sagebrush only
        6*y + 2
    """
    M = f._M
    C, F, h = _work(M)
    name = "Delta(%s)" % f._name if f._name else None
    if isinstance(f, VectorField):
        if C is M._cart:
            comps = [sum((a.diff(x, 2) for x in C._coords), _SR(0)) for a in f._w()]
            return f._from_w(comps, name)
        # grad div - curl curl
        a = f._w()
        dv = _div_w(a, C, h)
        g = [dv.diff(q) / hi for q, hi in zip(C._coords, h)]
        cc = _curl_w(_curl_w(a, C, h), C, h)
        return f._from_w([g[i] - cc[i] for i in range(M._n)], name)
    e = f.expr(C)
    H = _prod(h)
    g = ScalarField(M, name)
    g._expr[C] = _simplify(sum(((H / hi ** 2 * e.diff(q)).diff(q) for q, hi in zip(C._coords, h)), _SR(0)) / H)
    return g


def rank(x):
    """The rank (of a module or a matrix).

    EXAMPLES::

        sage: rank(matrix(QQ, [[1, 2], [2, 4]]))
        1
    """
    return x.rank()


def dim(x):
    """The dimension.

    EXAMPLES::

        sage: dim(EuclideanSpace(3))  # sagebrush only
        3
    """
    return x.dimension()
