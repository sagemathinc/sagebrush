"""Mixed integer linear programming, as Sage's MixedIntegerLinearProgram:
variables indexed by arbitrary keys, linear functions and constraints
(also chained, 1 <= x + y <= 4), objectives, and an exact solver: a
two-phase simplex method over the rationals (Bland's rule) for the linear
relaxations, and branch and bound for the integer and binary variables.
Values are returned as floats, as Sage's GLPK backend does.

EXAMPLES::

    sage: g = graphs.PetersenGraph(); p = MixedIntegerLinearProgram()
    sage: m = p.new_variable(binary=True)
    sage: p.set_objective(p.sum(m[e] for e in g.edges(sort=False, labels=False)))
    sage: for v in g:
    ....:     p.add_constraint(p.sum(m[e] for e in g.edges_incident(v, labels=False)) <= 1)
    sage: p.solve()
    5.0
"""

from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


class MIPSolverException(RuntimeError):
    """Raised when a program has no solution (infeasible or unbounded).

    EXAMPLES::

        sage: from sage.numerical.mip import MIPSolverException
        sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True)
        sage: p.add_constraint(x[0] >= 2); p.add_constraint(x[0] <= 1); p.set_objective(x[0])
        sage: try:
        ....:     p.solve()
        ....: except MIPSolverException as e:
        ....:     print(e)
        GLPK: Problem has no feasible solution
    """


def _frac(c):
    """An exact rational for a coefficient (floats exactly)."""
    if isinstance(c, _F):
        return c
    if isinstance(c, (int, float)):
        return _F(c)
    try:
        return _F(c._rational_()) if hasattr(c, "_rational_") else _F(c)
    except Exception:
        return _F(float(c))


def _norm(c):
    """Exact numbers stay; real numbers (1.5) become floats, as in RDF."""
    if isinstance(c, float):
        return float(c)
    if isinstance(c, (int, _F)):
        return c
    if hasattr(c, "_rational_") or type(c).__name__ in ("Integer", "Rational"):
        return c
    try:
        return float(c)
    except Exception:
        return c


def _is_zero(c):
    try:
        return c == 0
    except Exception:
        return False


def _num_repr(c):
    """A coefficient as Sage prints it in a linear function (3, 0.5, 2/3)."""
    if isinstance(c, float) and c == int(c) and abs(c) < 1e15:
        return repr(c)
    return repr(c)


# ----------------------------------------------------------- linear functions

_CHAIN = [None]   # the last comparison evaluated as a bool (a <= b <= c)


class LinearFunction:
    """A linear function of the variables of a program: a constant plus a
    combination of the variables x_i.

    EXAMPLES::

        sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
        sage: 3 + x[0] + 2*x[1]
        3 + x_0 + 2*x_1
    """

    def __init__(self, coeffs, const=0):
        self._c = {i: _norm(c) for i, c in coeffs.items() if not _is_zero(c)}
        self._k = _norm(const)

    def dict(self):
        """The coefficients: index -> coefficient (index -1 is the constant).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
            sage: (2*x[0] - x[1] + 5).dict()
            {-1: 5.0, 0: 2.0, 1: -1.0}
        """
        d = {}
        if not _is_zero(self._k):
            d[-1] = float(self._k)
        d.update((i, float(c)) for i, c in sorted(self._c.items()))
        return d

    def __repr__(self):
        parts = []
        if not _is_zero(self._k) or not self._c:
            parts.append(repr(self._k) if self._c or not _is_zero(self._k) else "0")
        for i, c in sorted(self._c.items()):
            if not parts:
                parts.append("x_%d" % i if c == 1 else "%s*x_%d" % (_num_repr(c), i))
                continue
            neg = c < 0
            a = -c if neg else c
            t = "x_%d" % i if a == 1 else "%s*x_%d" % (_num_repr(a), i)
            parts.append(("- " if neg else "+ ") + t)
        return " ".join(parts)

    @staticmethod
    def _of(x):
        if isinstance(x, LinearFunction):
            return x
        return LinearFunction({}, x)

    def __add__(self, o):
        if not isinstance(o, LinearFunction):
            try:
                o = LinearFunction({}, o)
            except Exception:
                return NotImplemented
        d = dict(self._c)
        for i, c in o._c.items():
            d[i] = d.get(i, 0) + c
        return LinearFunction(d, self._k + o._k)

    __radd__ = __add__

    def __neg__(self):
        return LinearFunction({i: -c for i, c in self._c.items()}, -self._k)

    def __sub__(self, o):
        return self + (-LinearFunction._of(o))

    def __rsub__(self, o):
        return LinearFunction._of(o) + (-self)

    def __mul__(self, o):
        if isinstance(o, LinearFunction):
            if not o._c:
                o = o._k
            elif not self._c:
                return o * self._k
            else:
                raise TypeError("the product of two linear functions is not linear")
        return LinearFunction({i: c * o for i, c in self._c.items()}, self._k * o)

    def __rmul__(self, o):
        return LinearFunction({i: o * c for i, c in self._c.items()}, o * self._k)

    def __truediv__(self, o):
        return self * (_F(1) / _frac(o) if not isinstance(o, float) else 1.0 / o)

    def _cmp(self, other, op, reflected=False):
        o = LinearFunction._of(other) if not isinstance(other, LinearConstraint) else other
        if op == "<=":
            terms = [self, o]
        elif op == ">=":
            terms = [o, self]
        else:
            terms = [self, o]
        prev = _CHAIN[0]
        _CHAIN[0] = None
        if prev is not None and op != "==" and prev._op == "<=" and (prev._terms[-1] is self or prev._terms[0] is self):
            if op == "<=" and prev._terms[-1] is self:
                return LinearConstraint(prev._terms + [o], "<=")
            if op == ">=" and prev._terms[0] is self:
                return LinearConstraint([o] + prev._terms, "<=")
        return LinearConstraint(terms, "==" if op == "==" else "<=")

    def __le__(self, o):
        return self._cmp(o, "<=")

    def __ge__(self, o):
        return self._cmp(o, ">=")

    def __eq__(self, o):
        return self._cmp(o, "==")

    def __hash__(self):
        return id(self)

    def _key(self):
        return (tuple(sorted(self._c.items())), self._k)

    def is_zero(self):
        """Whether the function is 0.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
            sage: (x[0] - x[0]).is_zero(), x[0].is_zero()
            (True, False)
        """
        return not self._c and _is_zero(self._k)


class LinearConstraint:
    """A (chain of) linear (in)equalities: f_0 <= f_1 <= ... or f == g.

    EXAMPLES::

        sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
        sage: x[0] + 2*x[1] <= 4
        x_0 + 2*x_1 <= 4
        sage: 1 <= x[0] + x[1] <= 4
        1 <= x_0 + x_1 <= 4
    """

    def __init__(self, terms, op):
        self._terms, self._op = terms, op

    def __repr__(self):
        return (" %s " % self._op).join(repr(LinearFunction._of(t)) for t in self._terms)

    def __bool__(self):
        # Python evaluates a <= b <= c as (a <= b) and (b <= c): remember
        # this comparison, so that the next one extends it
        _CHAIN[0] = self
        return True

    def __le__(self, o):
        if self._op != "<=":
            raise ValueError("cannot chain an equality")
        return LinearConstraint(self._terms + [LinearFunction._of(o)], "<=")

    def __ge__(self, o):
        if self._op != "<=":
            raise ValueError("cannot chain an equality")
        return LinearConstraint([LinearFunction._of(o)] + self._terms, "<=")

    def is_equation(self):
        """Whether the constraint is an equality.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
            sage: (x[0] == 1).is_equation(), (x[0] <= 1).is_equation()
            (True, False)
        """
        return self._op == "=="

    def is_less_or_equal(self):
        """Whether the constraint is an inequality.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
            sage: (x[0] <= 1).is_less_or_equal()
            True
        """
        return self._op == "<="

    def __iter__(self):
        return iter(LinearFunction._of(t) for t in self._terms)


# ----------------------------------------------------------------- variables

class MIPVariable:
    """A family of variables of a program, indexed by arbitrary keys; each
    new key makes a new variable.

    EXAMPLES::

        sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True)
        sage: x["a"], x[3, 2], x["a"]
        (x_0, x_1, x_0)
        sage: x
        MIPVariable with 2 real components, >= 0
    """

    def __init__(self, p, vtype, nonnegative, name):
        self._p, self._type, self._nonneg, self._name = p, vtype, nonnegative, name
        self._dict = {}

    def __getitem__(self, key):
        if key not in self._dict:
            i = self._p._new_var(self._type, 0 if (self._nonneg or self._type == "binary") else None,
                                 1 if self._type == "binary" else None,
                                 ("%s[%s]" % (self._name, _keystr(key))) if self._name else None)
            self._dict[key] = LinearFunction({i: 1})
        return self._dict[key]

    def __repr__(self):
        kind = {"binary": "binary", "integer": "integer", "real": "real"}[self._type]
        s = "MIPVariable%s with %d %s component%s" % (" " + self._name if self._name else "", len(self._dict), kind, "" if len(self._dict) == 1 else "s")
        if self._nonneg and self._type != "binary":
            s += ", >= 0"
        return s

    def keys(self):
        """The keys used so far.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); x[1], x[5]
            (x_0, x_1)
            sage: sorted(x.keys())
            [1, 5]
        """
        return self._dict.keys()

    def values(self):
        """The variables made so far.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); x[1], x[5]
            (x_0, x_1)
            sage: sorted(x.values(), key=str)
            [x_0, x_1]
        """
        return self._dict.values()

    def items(self):
        """The (key, variable) pairs.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); x['a']
            x_0
            sage: list(x.items())
            [('a', x_0)]
        """
        return self._dict.items()

    def __len__(self):
        return len(self._dict)

    def __iter__(self):
        return iter(self._dict)

    def __contains__(self, key):
        return key in self._dict

    def mip(self):
        """The program of the variables.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); p.new_variable().mip() is p
            True
        """
        return self._p


def _keystr(k):
    if isinstance(k, tuple):
        return ", ".join(str(x) for x in k)
    return str(k)


# ------------------------------------------------------------------ programs

class MixedIntegerLinearProgram:
    """A (mixed integer) linear program.

    EXAMPLES::

        sage: p = MixedIntegerLinearProgram()
        sage: v = p.new_variable(real=True, nonnegative=True)
        sage: x, y, z = v['x'], v['y'], v['z']
        sage: p.set_objective(x + y + 3*z)
        sage: p.add_constraint(x + 2*y <= 4)
        sage: p.add_constraint(5*z - y <= 8)
        sage: p.solve()
        8.8
        sage: p.get_values(x), p.get_values(y), p.get_values(z)
        (4.0, 0.0, 1.6)
    """

    def __init__(self, solver=None, maximization=True, constraint_generation=False, check_redundant=False, base_ring=None):
        self._max = bool(maximization)
        self._types, self._lo, self._hi, self._names = [], [], [], []
        self._rows = []          # (name, LinearFunction without constant, lower, upper)
        self._obj = None
        self._values = None
        self._objval = None

    # -- structure
    def _new_var(self, vtype, lo, hi, name):
        self._types.append(vtype)
        self._lo.append(lo)
        self._hi.append(hi)
        self._names.append(name)
        return len(self._types) - 1

    def __repr__(self):
        n = len(self._types)
        kinds = set(t == "real" for t in self._types)
        if n and kinds == {True}:
            kind = "Linear Program"
        elif n and kinds == {False}:
            kind = "Integer Program"
        else:
            kind = "Mixed Integer Program"
        obj = "no objective" if self._obj is None else ("maximization" if self._max else "minimization")
        m = len(self._rows)
        return "%s (%s, %d variable%s, %d constraint%s)" % (kind, obj, n, "" if n == 1 else "s", m, "" if m == 1 else "s")

    def new_variable(self, binary=False, integer=False, real=False, nonnegative=False, name="", indices=None, **kwds):
        """A new family of variables (real by default, unbounded unless
        nonnegative=True; binary variables are 0 or 1).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); p.new_variable(binary=True, name='taken')
            MIPVariable taken with 0 binary components
        """
        vtype = "binary" if binary else "integer" if integer else "real"
        v = MIPVariable(self, vtype, nonnegative, name or "")
        for k in indices or ():
            v[k]
        return v

    def number_of_variables(self):
        """The number of variables.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); x[0] + x[1]
            x_0 + x_1
            sage: p.number_of_variables()
            2
        """
        return _sa().Integer(len(self._types))

    def number_of_constraints(self):
        """The number of constraints.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.add_constraint(x[0] <= 1)
            sage: p.number_of_constraints()
            1
        """
        return _sa().Integer(len(self._rows))

    def sum(self, L):
        """The sum of linear functions (faster than sum()).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable()
            sage: p.sum(x[i] for i in range(3))
            x_0 + x_1 + x_2
        """
        d, k = {}, 0
        for f in L:
            f = LinearFunction._of(f)
            for i, c in f._c.items():
                d[i] = d.get(i, 0) + c
            k = k + f._k
        return LinearFunction(d, k)

    def set_objective(self, obj):
        """The function to maximize (or minimize); None: no objective.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True)
            sage: p.add_constraint(x[0] + x[1] <= 3); p.set_objective(x[0] + 2*x[1]); p.solve()
            6.0
        """
        self._obj = None if obj is None else LinearFunction._of(obj)

    def add_constraint(self, linear_function, max=None, min=None, name=None):
        """Add a constraint: a (chained) inequality or equality, or a linear
        function with bounds min and max.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True)
            sage: p.add_constraint(x[0] + x[1], max=4, min=1); p.add_constraint(x[0] - x[1] == 1)
            sage: p.set_objective(x[0]); p.solve()
            2.5
        """
        _CHAIN[0] = None
        c = linear_function
        if isinstance(c, LinearConstraint):
            ts = [LinearFunction._of(t) for t in c._terms]
            if c._op == "==":
                d = ts[0] - ts[1]
                self._add_row(name, d, -d._k, -d._k)
                return
            # f_0 <= f_1 <= ...: each consecutive pair
            for a, b in zip(ts, ts[1:]):
                d = a - b
                self._add_row(name, d, None, -d._k)
            return
        f = LinearFunction._of(c)
        self._add_row(name, f, None if min is None else min - f._k, None if max is None else max - f._k)

    def _add_row(self, name, f, lo, hi):
        self._rows.append((name, LinearFunction(dict(f._c)), lo, hi))

    def remove_constraint(self, i):
        """Remove the i-th constraint.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.add_constraint(x[0] <= 1)
            sage: p.remove_constraint(0); p.number_of_constraints()
            0
        """
        del self._rows[int(i)]

    def constraints(self, indices=None):
        """The constraints as (lower bound, (indices, coefficients), upper bound).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.add_constraint(x[0] + 2*x[1] <= 4)
            sage: p.constraints()
            [(None, ([1, 0], [2.0, 1.0]), 4.0)]
        """
        out = []
        rows = self._rows if indices is None else [self._rows[i] for i in ([indices] if isinstance(indices, int) else indices)]
        for name, f, lo, hi in rows:
            idx = sorted(f._c, reverse=True)
            out.append((None if lo is None else float(lo), (idx, [float(f._c[i]) for i in idx]), None if hi is None else float(hi)))
        return out

    # -- bounds and types
    def _index(self, v):
        f = LinearFunction._of(v)
        if len(f._c) != 1:
            raise ValueError("not a variable")
        return next(iter(f._c))

    def set_min(self, v, min):
        """Set the lower bound of a variable (None: no bound).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.set_min(x[0], 2); p.get_min(x[0])
            2.0
        """
        self._lo[self._index(v)] = min

    def set_max(self, v, max):
        """Set the upper bound of a variable (None: no bound).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.set_max(x[0], 3); p.get_max(x[0])
            3.0
        """
        self._hi[self._index(v)] = max

    def get_min(self, v):
        """The lower bound of a variable (None: none).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True); p.get_min(x[0])
            0.0
        """
        b = self._lo[self._index(v)]
        return None if b is None else float(b)

    def get_max(self, v):
        """The upper bound of a variable (None: none).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(binary=True); p.get_max(x[0])
            1.0
        """
        b = self._hi[self._index(v)]
        return None if b is None else float(b)

    def set_binary(self, v):
        """Make variables binary.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.set_binary(x[0]); p.is_binary(x[0])
            True
        """
        for i in self._indices_of(v):
            self._types[i], self._lo[i], self._hi[i] = "binary", 0, 1

    def set_integer(self, v):
        """Make variables integer.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.set_integer(x[0]); p.is_integer(x[0])
            True
        """
        for i in self._indices_of(v):
            self._types[i] = "integer"

    def set_real(self, v):
        """Make variables real.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(integer=True); p.set_real(x[0]); p.is_real(x[0])
            True
        """
        for i in self._indices_of(v):
            self._types[i] = "real"

    def _indices_of(self, v):
        if isinstance(v, MIPVariable):
            return [self._index(f) for f in v.values()]
        return [self._index(v)]

    def is_binary(self, v):
        """Whether the variable is binary.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(binary=True); p.is_binary(x[0])
            True
        """
        return self._types[self._index(v)] == "binary"

    def is_integer(self, v):
        """Whether the variable is integer.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(integer=True); p.is_integer(x[0])
            True
        """
        return self._types[self._index(v)] == "integer"

    def is_real(self, v):
        """Whether the variable is real (continuous).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(); p.is_real(x[0])
            True
        """
        return self._types[self._index(v)] == "real"

    # -- display
    def show(self):
        """Print the program: objective, constraints and variables.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True)
            sage: p.set_objective(x[0] + 3*x[1]); p.add_constraint(x[0] + 2*x[1] <= 4)
            sage: p.show()
            Maximization:
              x_0 + 3.0 x_1
            Constraints:
              x_0 + 2.0 x_1 <= 4.0
            Variables:
              x_0 is a continuous variable (min=0.0, max=+oo)
              x_1 is a continuous variable (min=0.0, max=+oo)
        """
        print(self._show())

    def _vname(self, i):
        return self._names[i] or "x_%d" % i

    def _terms(self, f):
        out = []
        for i, c in sorted(f._c.items()):
            c = float(c)
            n = self._vname(i)
            if not out:
                out.append(n if c == 1 else "- %s" % n if c == -1 else "%r %s" % (c, n))
            else:
                if c == 1:
                    out.append("+ %s" % n)
                elif c == -1:
                    out.append("- %s" % n)
                elif c < 0:
                    out.append("- %r %s" % (-c, n))
                else:
                    out.append("+ %r %s" % (c, n))
        return " ".join(out)

    def _show(self):
        lines = ["Maximization:" if self._max else "Minimization:"]
        obj = self._obj or LinearFunction({})
        s = self._terms(obj)
        k = float(obj._k)
        if k != 0:
            s = (s + " " if s else "") + ("+ %r" % k if k > 0 and s else "- %r" % -k if s else "%r" % k)
        lines.append("  " + s)
        lines.append("Constraints:")
        for name, f, lo, hi in self._rows:
            body = self._terms(f)
            pre = "%s: " % name if name else ""
            if lo is not None and hi is not None:
                lines.append("  %s%r <= %s <= %r" % (pre, float(lo), body, float(hi)))
            elif hi is not None:
                lines.append("  %s%s <= %r" % (pre, body, float(hi)))
            else:
                lines.append("  %s%s >= %r" % (pre, body, float(lo)))
        lines.append("Variables:")
        for i, t in enumerate(self._types):
            what = {"real": "a continuous", "integer": "an integer", "binary": "a boolean"}[t]
            lo = "-oo" if self._lo[i] is None else repr(float(self._lo[i]))
            hi = "+oo" if self._hi[i] is None else repr(float(self._hi[i]))
            nm = ("%s = x_%d" % (self._names[i], i)) if self._names[i] else "x_%d" % i
            lines.append("  %s is %s variable (min=%s, max=%s)" % (nm, what, lo, hi))
        return "\n".join(lines)

    # -- solving
    def solve(self, log=None, objective_only=False):
        """Solve the program: the optimal value of the objective (0.0
        without an objective).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(binary=True)
            sage: p.add_constraint(3*x[0] + 4*x[1] + 5*x[2] <= 8); p.set_objective(4*x[0] + 5*x[1] + 7*x[2])
            sage: p.solve(), p.get_values(x)
            (11.0, {0: 1.0, 1: 0.0, 2: 1.0})
        """
        n = len(self._types)
        obj = self._obj or LinearFunction({})
        sign = _F(1) if self._max else _F(-1)
        c = [sign * _frac(obj._c.get(i, 0)) for i in range(n)]
        rows = [([_frac(f._c.get(i, 0)) for i in range(n)], None if lo is None else _frac(lo), None if hi is None else _frac(hi)) for _, f, lo, hi in self._rows]
        lo = [None if b is None else _frac(b) for b in self._lo]
        hi = [None if b is None else _frac(b) for b in self._hi]
        ints = [i for i, t in enumerate(self._types) if t != "real"]
        best = _branch_and_bound(c, rows, lo, hi, ints)
        if best is None:
            raise MIPSolverException("GLPK: Problem has no feasible solution")
        val, x = best
        self._values = x
        self._objval = float(sign * val + _frac(obj._k))
        return self._objval

    def get_objective_value(self):
        """The optimal value found by the last solve().

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(nonnegative=True)
            sage: p.add_constraint(x[0] <= 2); p.set_objective(x[0]); p.solve(); p.get_objective_value()
            2.0
            2.0
        """
        if self._objval is None:
            raise MIPSolverException("the program has not been solved")
        return self._objval

    def get_values(self, *lists, convert=None, tolerance=None):
        """The values of variables in the last solution: a float for a
        variable, a dict for a MIPVariable, a list for a list.

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); x = p.new_variable(binary=True)
            sage: p.add_constraint(x[0] + x[1] <= 1); p.set_objective(x[0] + 2*x[1]); p.solve()
            2.0
            sage: p.get_values(x), p.get_values(x, convert=bool, tolerance=1e-3)
            ({0: 0.0, 1: 1.0}, {0: False, 1: True})
        """
        if self._values is None:
            raise MIPSolverException("the program has not been solved")

        def conv(v):
            if convert is None:
                return v
            if tolerance is None and convert is not float:
                raise TypeError("for converting to integers, a tolerance must be provided")
            r = round(v)
            if tolerance is not None and abs(v - r) > tolerance:
                raise RuntimeError("the value %s is not within %s of an integer" % (v, tolerance))
            if convert is bool:
                return bool(r)
            if convert is float:
                return float(v)
            return convert(int(r))

        def val(o):
            if isinstance(o, MIPVariable):
                return {k: val(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return [val(v) for v in o]
            if isinstance(o, dict):
                return {k: val(v) for k, v in o.items()}
            f = LinearFunction._of(o)
            s = float(_frac(f._k)) + sum(float(_frac(c)) * float(self._values[i]) for i, c in f._c.items())
            return conv(s)

        out = [val(o) for o in lists]
        return out[0] if len(out) == 1 else out

    def get_backend(self):
        """The backend (here the program itself: an exact simplex method with
        branch and bound).

        EXAMPLES::

            sage: p = MixedIntegerLinearProgram(); p.get_backend() is p  # sagebrush only
            True
        """
        return self


# ------------------------------------------------------------------ solver

def _branch_and_bound(c, rows, lo, hi, ints, limit=200000):
    """Maximize c.x subject to the rows (a, lower, upper) and the bounds,
    x_i integral for i in ints: (value, x) or None if infeasible."""
    best = [None]
    stack = [(list(lo), list(hi))]
    nodes = 0
    while stack:
        nodes += 1
        if nodes > limit:
            break
        l, h = stack.pop()
        r = _lp(c, rows, l, h)
        if r is None:
            continue
        val, x = r
        if best[0] is not None and val <= best[0][0]:
            continue
        frac = [i for i in ints if x[i].denominator != 1]
        if not frac:
            best[0] = (val, x)
            continue
        # branch on the most fractional variable
        i = max(frac, key=lambda j: min(x[j] - (x[j].numerator // x[j].denominator), (x[j].numerator // x[j].denominator) + 1 - x[j]))
        fl = x[i].numerator // x[i].denominator
        l1, h1 = list(l), list(h)
        h1[i] = _F(fl)
        l2, h2 = list(l), list(h)
        l2[i] = _F(fl + 1)
        # explore the side closer to the relaxation first (pushed last)
        if x[i] - fl >= _F(1, 2):
            stack.append((l1, h1))
            stack.append((l2, h2))
        else:
            stack.append((l2, h2))
            stack.append((l1, h1))
    return best[0]


class _Unbounded(Exception):
    pass


def _lp(c, rows, lo, hi):
    """Maximize c.x subject to lower <= a.x <= upper for the rows and
    lo <= x <= hi: (value, x) exactly, None if infeasible; raises
    MIPSolverException if unbounded."""
    n = len(c)
    for i in range(n):
        if lo[i] is not None and hi[i] is not None and lo[i] > hi[i]:
            return None
    # substitute x_j = lo_j + y_j, x_j = hi_j - y_j, or y_j+ - y_j- (free)
    cols = []          # for each x_j: list of (y index, sign), and offset
    m = 0
    for j in range(n):
        if lo[j] is not None:
            cols.append(([(m, 1)], lo[j]))
            m += 1
        elif hi[j] is not None:
            cols.append(([(m, -1)], hi[j]))
            m += 1
        else:
            cols.append(([(m, 1), (m + 1, -1)], _F(0)))
            m += 2
    le, eq = [], []    # rows a.y <= b, a.y == b in y >= 0

    def tr(a):
        y = [_F(0)] * m
        off = _F(0)
        for j, aj in enumerate(a):
            if aj == 0:
                continue
            ys, o = cols[j]
            off += aj * o
            for k, s in ys:
                y[k] += s * aj
        return y, off

    for a, l, u in rows:
        y, off = tr(a)
        if l is not None and u is not None and l == u:
            eq.append((y, l - off))
            continue
        if u is not None:
            le.append((y, u - off))
        if l is not None:
            le.append(([-v for v in y], off - l))
    for j in range(n):
        if lo[j] is not None and hi[j] is not None:
            y = [_F(0)] * m
            y[cols[j][0][0][0]] = _F(1)
            le.append((y, hi[j] - lo[j]))
    cy = [_F(0)] * m
    const = _F(0)
    for j in range(n):
        ys, o = cols[j]
        const += c[j] * o
        for k, s in ys:
            cy[k] += s * c[j]
    try:
        r = _simplex(cy, le, eq, m)
    except _Unbounded:
        raise MIPSolverException("GLPK: The LP (relaxation) problem has no dual feasible solution")
    if r is None:
        return None
    val, y = r
    x = []
    for j in range(n):
        ys, o = cols[j]
        x.append(o + sum((s * y[k] for k, s in ys), _F(0)))
    return val + const, x


def _simplex(c, le, eq, m):
    """Maximize c.y, y >= 0, subject to le (a.y <= b) and eq (a.y == b):
    two-phase simplex method with Bland's rule, exact."""
    # rows: a.y + s = b (slack) for le with b >= 0; otherwise -a.y - s' + art = -b
    rows, basis = [], []
    nart = 0
    width = m + len(le)       # y, slacks
    art_cols = []
    for i, (a, b) in enumerate(le):
        row = list(a) + [_F(0)] * len(le)
        row[m + i] = _F(1)
        if b < 0:
            row = [-v for v in row]
            rows.append([row, -b, True])
        else:
            rows.append([row, b, False])
    for a, b in eq:
        row = list(a) + [_F(0)] * len(le)
        if b < 0:
            row, b = [-v for v in row], -b
        rows.append([row, b, True])
    # artificial columns for the rows that need them
    total = width + sum(1 for r in rows if r[2])
    T = []
    k = width
    for i, (r, b, art) in enumerate(rows):
        full = r + [_F(0)] * (total - width)
        if art:
            full[k] = _F(1)
            basis.append(k)
            art_cols.append(k)
            k += 1
        else:
            basis.append(m + i)     # the slack of an le row with b >= 0
        T.append(full + [b])
    nrows = len(T)

    def pivot(pr, pc):
        piv = T[pr][pc]
        T[pr] = [v / piv for v in T[pr]]
        for i in range(nrows):
            if i != pr and T[i][pc] != 0:
                f = T[i][pc]
                Ti, Tp = T[i], T[pr]
                T[i] = [a - f * b for a, b in zip(Ti, Tp)]
        basis[pr] = pc

    def run(cost, allowed):
        # maximize cost.x; reduced costs computed from the basis
        while True:
            # z_j - c_j
            cb = [cost[basis[i]] for i in range(nrows)]
            enter = None
            for j in range(total):
                if j not in allowed or j in basis:
                    continue
                zj = sum((cb[i] * T[i][j] for i in range(nrows) if T[i][j] != 0), _F(0))
                if cost[j] - zj > 0:
                    enter = j
                    break
            if enter is None:
                return True
            best, br = None, None
            for i in range(nrows):
                if T[i][enter] > 0:
                    ratio = T[i][-1] / T[i][enter]
                    if best is None or ratio < best or (ratio == best and basis[i] < basis[br]):
                        best, br = ratio, i
            if br is None:
                raise _Unbounded()
            pivot(br, enter)

    allowed = set(range(total))
    if art_cols:
        cost1 = [_F(0)] * total
        for j in art_cols:
            cost1[j] = _F(-1)
        run(cost1, allowed)
        if sum((T[i][-1] for i in range(nrows) if basis[i] in art_cols), _F(0)) != 0:
            return None
        # drive the artificials out of the basis
        for i in range(nrows):
            if basis[i] in art_cols:
                for j in range(width):
                    if T[i][j] != 0:
                        pivot(i, j)
                        break
        allowed = set(range(width))
    cost2 = list(c) + [_F(0)] * (total - m)
    run(cost2, allowed)
    y = [_F(0)] * m
    for i in range(nrows):
        if basis[i] is not None and basis[i] < m:
            y[basis[i]] = T[i][-1]
    return sum((ci * yi for ci, yi in zip(c, y)), _F(0)), y
