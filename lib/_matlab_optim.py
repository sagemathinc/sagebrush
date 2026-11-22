"""MATLAB's Optimization Toolbox solvers most used in teaching, for lib/_matlab.py: optimoptions, fsolve, fminunc,
lsqcurvefit and linprog.  Each is written from its documentation page and a published method:

- fsolve: Powell's dogleg trust-region method on the sum of squares of F (Nocedal and Wright, Numerical
  Optimization, 2nd ed., section 4.1), the Jacobian by forward differences;
- fminunc: the BFGS quasi-Newton method with a line search satisfying the strong Wolfe conditions (Nocedal and
  Wright, algorithms 3.5, 3.6 and 6.1), the gradient by forward differences unless the function supplies it;
- lsqcurvefit: the Levenberg-Marquardt method (Marquardt, J. SIAM 11, 1963), its steps projected onto the bounds;
- linprog: the two-phase simplex method with Bland's rule (Dantzig; Bland, Math. Oper. Res. 2, 1977), the
  Lagrange multipliers from the final basis.

The exit flags, the output structures' fields (in MATLAB's order), the default 'final' display texts and the
error identifiers are those of an observed MATLAB R2026b run (values and identifiers only).  The iterates are this
module's own: the solutions agree with MATLAB's within the solvers' tolerances, the iteration counts do not.
Loaded lazily: lib/_matlab.py registers each name as a stub that imports this module the first time one of them is
called (the lazy matlab-more chunk, web/lib-chunks.mts).
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import Char, NOVAL, HandleObj, _bi, _err, _istext, _text
from _matlab_data import _md, _out

_EPS = 2.220446049250313e-16
_SQRT_EPS = _math.sqrt(_EPS)

# ------------------------------------------------------------------ optimoptions

# (each solver's options and defaults, from its documentation page; MaxFunctionEvaluations' default depends on
# the number of variables, resolved by the solver)
_SOLVER_OPTIONS = {
    "fsolve": {"Algorithm": "trust-region-dogleg", "Display": "final", "FiniteDifferenceType": "forward",
               "FunctionTolerance": 1e-6, "MaxFunctionEvaluations": "100*numberOfVariables", "MaxIterations": 400.0,
               "OptimalityTolerance": 1e-6, "SpecifyObjectiveGradient": False, "StepTolerance": 1e-6},
    "fminunc": {"Algorithm": "quasi-newton", "Display": "final", "FiniteDifferenceType": "forward",
                "FunctionTolerance": 1e-6, "MaxFunctionEvaluations": "100*numberOfVariables", "MaxIterations": 400.0,
                "OptimalityTolerance": 1e-6, "SpecifyObjectiveGradient": False, "StepTolerance": 1e-6},
    "lsqcurvefit": {"Algorithm": "trust-region-reflective", "Display": "final", "FiniteDifferenceType": "forward",
                    "FunctionTolerance": 1e-6, "MaxFunctionEvaluations": "100*numberOfVariables",
                    "MaxIterations": 400.0, "OptimalityTolerance": 1e-6, "SpecifyObjectiveGradient": False,
                    "StepTolerance": 1e-6},
    "linprog": {"Algorithm": "dual-simplex-highs", "ConstraintTolerance": 1e-7, "Display": "final",
                "MaxIterations": "10*(numberOfEqualities+numberOfInequalities+numberOfVariables)",
                "OptimalityTolerance": 1e-7},
}

# (the older names optimset uses, as the optimoptions page maps them)
_ALIASES = {"tolfun": "FunctionTolerance", "tolx": "StepTolerance", "maxiter": "MaxIterations",
            "maxfunevals": "MaxFunctionEvaluations", "gradobj": "SpecifyObjectiveGradient",
            "jacobian": "SpecifyObjectiveGradient", "tolcon": "ConstraintTolerance"}


class OptimOptions(HandleObj):
    """optimoptions' object: a value (an assignment copies it, as MATLAB's options objects are values), class
    optim.options.<Solver>, its properties the solver's options"""
    _value_class = True

    def __init__(self, solver):
        HandleObj.__init__(self)
        self.solver = solver
        self._mclass = "optim.options." + solver[0].upper() + solver[1:]
        self.props = {k: _value(v) for k, v in _SOLVER_OPTIONS[solver].items()}
        self.set_names = []

    def copy(self):
        o = OptimOptions(self.solver)
        o.props = {k: _m.cp(v) for k, v in self.props.items()}
        o.set_names = list(self.set_names)
        return o

    def canonical(self, name):
        low = name.lower()
        for k in self.props:
            if k.lower() == low:
                return k
        a = _ALIASES.get(low)
        if a is not None and a in self.props:
            return a
        if low == "tolfun" and "OptimalityTolerance" in self.props:
            return "OptimalityTolerance"
        raise _err("'%s' is not an option for %s. A list of options can be found on the %s documentation page."
                   % (name, self.solver.upper(), self.solver.upper()), "optimlib:optimoptions:UnmatchedParameter")

    def mget(self, name):
        return self.props[self.canonical(name)]

    def mset(self, name, value):
        k = self.canonical(name)
        self.props[k] = _check(k, value)
        if k not in self.set_names:
            self.set_names.append(k)


def _value(v):
    if type(v) is bool:
        return v
    if type(v) is str:
        return Char(v)
    return float(v)


def _check(name, v):
    """an option's value: on/off text for the logical options as optimset gives them, otherwise as given"""
    if name == "SpecifyObjectiveGradient" and _istext(v):
        t = _text(v).lower()
        if t not in ("on", "off"):
            raise _err("Invalid value for OPTIONS parameter %s: must be true or false." % name)
        return t == "on"
    return v


def _solver_name(v):
    if _istext(v):
        return _text(v)
    if _m._iscallable(v):
        return (getattr(v, "name", None) or _text(_m._B["func2str"].f(1, v))).lstrip("@")
    raise _err("optimoptions: the first argument must be a solver name or handle, or an options object.")


@_bi("optimoptions")
def optimoptions_(nargout, *args):
    """options = optimoptions(solver), optimoptions(solver, Name, Value, ...), optimoptions(oldoptions, Name,
    Value, ...): an options object for fsolve, fminunc, lsqcurvefit or linprog (class optim.options.<Solver>),
    the solver's defaults with the options given set; the older optimset names (TolFun, TolX, MaxIter,
    MaxFunEvals, GradObj, Jacobian) are accepted for the current ones"""
    if not args:
        raise _err("optimoptions: the solver is required.")
    args = list(args)
    first = args.pop(0)
    if isinstance(first, OptimOptions):
        o = first.copy()
    else:
        name = _solver_name(first)
        if name not in _SOLVER_OPTIONS:
            raise _err("optimoptions: '%s' is not supported in Sagebrush (fsolve, fminunc, lsqcurvefit and linprog are)."
                       % name)
        o = OptimOptions(name)
    if len(args) % 2:
        raise _err("optimoptions: name-value arguments must come in pairs.")
    for k in range(0, len(args), 2):
        if not _istext(args[k]):
            raise _err("optimoptions: an option name must be text.")
        o.mset(_text(args[k]), args[k + 1])
    return o


def _options(options, solver):
    """the solver's options as a dict of canonical names: from an optimoptions object (of any solver: the names it
    shares), an optimset structure (its older names mapped), or the defaults"""
    d = {k: _value(v) for k, v in _SOLVER_OPTIONS[solver].items()}
    if options is None or (_m._isnumlike(options) and not _istext(options) and _m._numel(options) == 0):
        return d
    if isinstance(options, OptimOptions):
        for k, v in options.props.items():
            if k in d and (options.solver == solver or k in options.set_names):
                d[k] = v
        return d
    if type(options) is _m.Struct and _m._numel(options) == 1:
        for k, v in options.a[0].items():
            if _m._isnumlike(v) and not _istext(v) and _m._numel(v) == 0:
                continue
            low = k.lower()
            name = next((n for n in d if n.lower() == low), None) or _ALIASES.get(low)
            if name in d:
                d[name] = _check(name, v)
        return d
    raise _err("%s: OPTIONS must be an optimoptions object or an optimset structure." % solver)


def _num(d, name, n=1):
    """an option's numeric value, a default given as an expression of the problem's size resolved"""
    v = d[name]
    if _istext(v):
        t = _text(v)
        if t.startswith("100*"):
            return 100.0 * n
        if t.startswith("10*"):
            return 10.0 * n
        raise _err("Invalid value for OPTIONS parameter %s." % name)
    return float(_m._scalar(v))


def _display(d):
    v = d["Display"]
    t = _text(v).lower() if _istext(v) else "final"
    return t


def _flag(d, name):
    v = d[name]
    return bool(v) if type(v) is bool else bool(_m._scalar(v))


# ------------------------------------------------------------------ evaluation

def _fun(f, solver):
    if _istext(f):
        return _m._B["str2func"].call(1, [f])
    if not _m._iscallable(f):
        raise _err("FUN must be a function, a valid character vector expression, or an inline function object.",
                   "MATLAB:fcnchk:invalidFunctionSpecifier")
    return f


def _start(x0, solver):
    if _istext(x0) or not _m._isnumlike(x0) or _m.class_(x0) != "double":
        raise _err("%s requires the following inputs to be of data type double: 'X0'." % solver.upper(),
                   "optim:%s:NonDoubleInput" % solver)
    M = _md(x0)
    if np.iscomplexobj(M):
        raise _err("%s: complex X0 is not supported in Sagebrush." % solver)
    return M.T.reshape(-1).astype(np.float64), M.shape


def _shaped(z, shape):
    r, c = shape
    return _out(np.asarray(z, dtype=np.float64).reshape((c, r)).T)


def _flat(v, what):
    if _istext(v) or not _m._isnumlike(v):
        raise _err("%s must return a numeric value." % what)
    M = _md(v)
    if np.iscomplexobj(M):
        raise _err("%s returned a complex value: complex values are not supported in Sagebrush." % what)
    return M.T.reshape(-1).astype(np.float64), M.shape


class _Counter:
    def __init__(self):
        self.n = 0


def _fd_jacobian(F, x, f0, count):
    """forward differences: column j from x + h_j e_j, h_j = sqrt(eps) max(|x_j|, 1) with x_j's sign"""
    J = np.zeros((f0.size, x.size))
    for j in range(x.size):
        h = _SQRT_EPS * max(abs(x[j]), 1.0) * (1.0 if x[j] >= 0 else -1.0)
        xj = x.copy()
        xj[j] += h
        h = xj[j] - x[j]
        J[:, j] = (F(xj) - f0) / h
        count.n += 1
    return J


def _say(display, text):
    if display in ("final", "iter", "final-detailed", "iter-detailed"):
        _m._write(text)


def _struct(pairs):
    return _m._struct1({k: v for k, v in pairs})


def _empty():
    return _m._empty_double()


# ------------------------------------------------------------------ fsolve

_FSOLVE_SOLVED = ("\nEquation solved.\n\nfsolve completed because the vector of function values is near zero\n"
                  "as measured by the value of the function tolerance, and\nthe problem appears regular as measured "
                  "by the gradient.\n\n<stopping criteria details>\n")
_FSOLVE_NOT_SOLVED = ("\nNo solution found.\n\nfsolve stopped because the problem appears regular as measured by the "
                      "gradient,\nbut the vector of function values is not near zero as measured by the\nvalue of the "
                      "function tolerance.\n\n<stopping criteria details>\n")
_FSOLVE_MAX = ("\nSolver stopped prematurely.\n\nfsolve stopped because it exceeded the iteration or function "
               "evaluation limit.\n\n<stopping criteria details>\n")


@_bi("fsolve")
def fsolve_(nargout, fun, x0, options=None):
    """[x, fval, exitflag, output, jacobian] = fsolve(fun, x0, options): x with fun(x) = 0 for the system of
    equations fun, from x0, by Powell's dogleg trust-region method on sum(fun(x).^2) (MATLAB's default algorithm,
    'trust-region-dogleg'), the Jacobian by forward differences unless SpecifyObjectiveGradient is set and fun
    returns it second. exitflag 1: the equations are solved (sum(fval.^2) within FunctionTolerance squared); -2:
    stopped at a point that is not a root; 0: the iteration or evaluation limit. With Display 'final' (the
    default) it prints MATLAB's exit message."""
    f = _fun(fun, "fsolve")
    x, shape = _start(x0, "fsolve")
    d = _options(options, "fsolve")
    display = _display(d)
    n = x.size
    ftol, xtol, otol = _num(d, "FunctionTolerance"), _num(d, "StepTolerance"), _num(d, "OptimalityTolerance")
    maxit, maxfev = _num(d, "MaxIterations"), _num(d, "MaxFunctionEvaluations", n)
    jac = _flag(d, "SpecifyObjectiveGradient")
    count = _Counter()
    fshape = [None]

    def F(z):
        r = _m._call(f, [_shaped(z, shape)], 1)
        v, s = _flat(r, "FUN")
        fshape[0] = s
        return v

    def FJ(z):
        r = _m._call(f, [_shaped(z, shape)], 2)
        v, s = _flat(r[0], "FUN")
        fshape[0] = s
        Jm = _md(r[1]).astype(np.float64)
        return v, Jm

    def evaluate(z):
        count.n += 1
        if jac:
            return FJ(z)
        v = F(z)
        return v, _fd_jacobian(F, z, v, count)

    Fx, J = evaluate(x)
    if Fx.size == 0:
        raise _err("fsolve: FUN must return a nonempty vector.")
    delta = max(1.0, float(np.linalg.norm(x)))
    it = 0
    flag = None
    while True:
        ss = float(Fx @ Fx)
        g = J.T @ Fx
        fo = float(np.max(np.abs(g))) if g.size else 0.0
        # (solved once the sum of squares is down to FunctionTolerance * eps: near a root the steps converge
        # quadratically, so they go on until then; stopped elsewhere when the trust region shrinks below
        # StepTolerance (a root if the sum of squares is within FunctionTolerance), or at a point that is not a
        # root where the gradient of the sum of squares vanishes)
        if ss <= ftol * _EPS:
            flag = 1
            break
        if delta <= xtol * (xtol + float(np.linalg.norm(x))):
            flag = 1 if ss <= ftol else -2
            break
        if fo <= otol and ss > ftol:
            flag = -2
            break
        if it >= maxit or count.n >= maxfev:
            flag = 0
            break
        # (the dogleg step in the trust region: Gauss-Newton when it fits, else along the steepest descent
        # direction to the Cauchy point and on towards Gauss-Newton up to the region's edge)
        pgn = np.linalg.lstsq(J, -Fx, rcond=None)[0]
        Jg = J @ g
        gg = float(g @ g)
        alpha = gg / float(Jg @ Jg) if float(Jg @ Jg) > 0 else 0.0
        pc = -alpha * g
        if np.linalg.norm(pgn) <= delta:
            p = pgn
        elif np.linalg.norm(pc) >= delta:
            p = -delta * g / _math.sqrt(gg) if gg > 0 else pgn * (delta / np.linalg.norm(pgn))
        else:
            dd = pgn - pc
            a, b, c = float(dd @ dd), 2.0 * float(pc @ dd), float(pc @ pc) - delta * delta
            tau = (-b + _math.sqrt(max(b * b - 4 * a * c, 0.0))) / (2 * a) if a > 0 else 0.0
            p = pc + tau * dd
        Fn, Jn = evaluate(x + p)
        pred = ss - float((Fx + J @ p) @ (Fx + J @ p))
        actual = ss - float(Fn @ Fn)
        rho = actual / pred if pred > 0 else -1.0
        pn = float(np.linalg.norm(p))
        if rho < 0.25:
            delta = 0.25 * pn
        elif rho > 0.75 and pn >= 0.99 * delta:
            delta = 2.0 * delta
        if rho > 1e-4:
            x, Fx, J = x + p, Fn, Jn
        it += 1
    msg = {1: _FSOLVE_SOLVED, -2: _FSOLVE_NOT_SOLVED, 0: _FSOLVE_MAX}[flag]
    _say(display, msg)
    xo = _shaped(x, shape)
    if nargout <= 1:
        return xo
    out = [xo, _shaped(Fx, fshape[0] or (Fx.size, 1)), float(flag),
           _struct([("iterations", float(it)), ("funcCount", float(count.n)), ("algorithm", Char("trust-region-dogleg")),
                    ("firstorderopt", float(np.max(np.abs(J.T @ Fx))) if Fx.size else 0.0),
                    ("message", Char(msg.strip("\n")))]),
           _out(J)]
    return out[:nargout]


# ------------------------------------------------------------------ fminunc

_LOCAL_MIN = ("\nLocal minimum found.\n\nOptimization completed because the size of the gradient is less than\n"
              "the value of the optimality tolerance.\n\n<stopping criteria details>\n")
_FMINUNC_POSSIBLE = ("\nLocal minimum possible.\n\nfminunc stopped because it cannot decrease the objective function\n"
                     "along the current search direction.\n\n<stopping criteria details>\n")
_FMINUNC_MAX = ("\nSolver stopped prematurely.\n\nfminunc stopped because it exceeded the iteration or function "
                "evaluation limit.\n\n<stopping criteria details>\n")


def _scalar_obj(v):
    if _istext(v) or not _m._isnumlike(v) or _m._numel(v) != 1:
        raise _err("Supplied objective function must return a scalar value.", "optimlib:fmincon:NonScalarObj")
    z = _md(v).reshape(-1)[0]
    if np.iscomplexobj(z):
        raise _err("Supplied objective function must return a scalar value.", "optimlib:fmincon:NonScalarObj")
    return float(z)


@_bi("fminunc")
def fminunc_(nargout, fun, x0, options=None):
    """[x, fval, exitflag, output, grad, hessian] = fminunc(fun, x0, options): a local minimum of the scalar
    function fun from x0, by the BFGS quasi-Newton method with a line search (MATLAB's default algorithm,
    'quasi-newton'); the gradient by forward differences unless SpecifyObjectiveGradient is set and fun returns
    it second. grad is a column; hessian the quasi-Newton approximation. exitflag 1: the gradient is below
    OptimalityTolerance (relative to the first); 2: the step is below StepTolerance; 0: the limits."""
    f = _fun(fun, "fminunc")
    x, shape = _start(x0, "fminunc")
    d = _options(options, "fminunc")
    display = _display(d)
    n = x.size
    otol, xtol = _num(d, "OptimalityTolerance"), _num(d, "StepTolerance")
    maxit, maxfev = _num(d, "MaxIterations"), _num(d, "MaxFunctionEvaluations", n)
    grad = _flag(d, "SpecifyObjectiveGradient")
    count = _Counter()

    def fval(z):
        count.n += 1
        return _scalar_obj(_m._call(f, [_shaped(z, shape)], 1))

    def fg(z):
        if grad:
            count.n += 1
            r = _m._call(f, [_shaped(z, shape)], 2)
            g, _s = _flat(r[1], "The gradient")
            return _scalar_obj(r[0]), g
        v = fval(z)
        g = np.zeros(n)
        for j in range(n):
            h = _SQRT_EPS * max(abs(z[j]), 1.0) * (1.0 if z[j] >= 0 else -1.0)
            zj = z.copy()
            zj[j] += h
            g[j] = (fval(zj) - v) / (zj[j] - z[j])
        return v, g

    fx, g = fg(x)
    g0 = max(1.0, float(np.max(np.abs(g)))) if n else 1.0
    Hinv = np.eye(n)
    it = 0
    flag = None
    stepsize, lsstep = 0.0, 0.0
    while True:
        fo = float(np.max(np.abs(g))) if n else 0.0
        if fo <= otol * g0:
            flag = 1
            break
        if it >= maxit or count.n >= maxfev:
            flag = 0
            break
        p = -Hinv @ g
        if float(p @ g) >= 0:
            Hinv = np.eye(n)
            p = -g
        a, fn, gn = _wolfe(fg, x, fx, g, p)
        if a == 0.0:
            # (no decrease along the search direction: as far as the gradient's accuracy allows)
            flag = 5
            break
        s = a * p
        y = gn - g
        sy = float(s @ y)
        if it == 0 and sy > 0:
            Hinv = np.eye(n) * (sy / float(y @ y))
        if sy > 1e-12 * float(np.linalg.norm(s)) * float(np.linalg.norm(y)):
            rho = 1.0 / sy
            V = np.eye(n) - rho * np.outer(s, y)
            Hinv = V @ Hinv @ V.T + rho * np.outer(s, s)
        x, fx, g = x + s, fn, gn
        stepsize, lsstep = float(np.linalg.norm(s)), a
        it += 1
        if stepsize <= xtol * (1.0 + float(np.linalg.norm(x))):
            flag = 1 if float(np.max(np.abs(g))) <= otol * g0 else 2
            break
    msg = _LOCAL_MIN if flag == 1 else (_FMINUNC_MAX if flag == 0 else _FMINUNC_POSSIBLE)
    _say(display, msg)
    xo = _shaped(x, shape)
    if nargout <= 1:
        return xo
    H = np.linalg.inv(Hinv) if n else np.zeros((0, 0))
    out = [xo, fx, float(flag),
           _struct([("iterations", float(it)), ("funcCount", float(count.n)), ("stepsize", stepsize),
                    ("lssteplength", lsstep), ("firstorderopt", float(np.max(np.abs(g))) if n else 0.0),
                    ("algorithm", Char("quasi-newton")), ("message", Char(msg.strip("\n")))]),
           _out(g.reshape((-1, 1))), _out((H + H.T) / 2)]
    return out[:nargout]


def _wolfe(fg, x, f0, g0, p, c1=1e-4, c2=0.9):
    """a step length along p satisfying the strong Wolfe conditions (Nocedal and Wright, algorithms 3.5 and 3.6),
    with the function value and gradient there; 0 when none is found"""
    d0 = float(g0 @ p)
    a_prev, f_prev, d_prev = 0.0, f0, d0
    a = 1.0
    best = (0.0, f0, g0)
    for i in range(30):
        fa, ga = fg(x + a * p)
        da = float(ga @ p)
        if fa > f0 + c1 * a * d0 or (i > 0 and fa >= f_prev):
            return _zoom(fg, x, f0, d0, p, a_prev, f_prev, d_prev, a, fa, da, c1, c2) or best
        if abs(da) <= -c2 * d0:
            return a, fa, ga
        if fa < best[1]:
            best = (a, fa, ga)
        if da >= 0:
            return _zoom(fg, x, f0, d0, p, a, fa, da, a_prev, f_prev, d_prev, c1, c2) or best
        a_prev, f_prev, d_prev = a, fa, da
        a *= 2.0
    return best


def _zoom(fg, x, f0, d0, p, lo, flo, dlo, hi, fhi, dhi, c1, c2):
    best = None
    for _i in range(40):
        # (the minimizer of the cubic through both ends, kept inside the bracket; bisection when it falls out)
        d1 = dlo + dhi - 3 * (flo - fhi) / (lo - hi) if lo != hi else 0.0
        rad = d1 * d1 - dlo * dhi
        if rad >= 0 and lo != hi:
            d2 = _math.copysign(_math.sqrt(rad), hi - lo)
            den = dhi - dlo + 2 * d2
            a = hi - (hi - lo) * (dhi + d2 - d1) / den if den != 0 else 0.5 * (lo + hi)
        else:
            a = 0.5 * (lo + hi)
        lo_b, hi_b = min(lo, hi), max(lo, hi)
        if not (lo_b + 0.1 * (hi_b - lo_b) <= a <= hi_b - 0.1 * (hi_b - lo_b)):
            a = 0.5 * (lo + hi)
        fa, ga = fg(x + a * p)
        da = float(ga @ p)
        if fa > f0 + c1 * a * d0 or fa >= flo:
            hi, fhi, dhi = a, fa, da
        else:
            if abs(da) <= -c2 * d0:
                return a, fa, ga
            if best is None or fa < best[1]:
                best = (a, fa, ga)
            if da * (hi - lo) >= 0:
                hi, fhi, dhi = lo, flo, dlo
            lo, flo, dlo = a, fa, da
        if abs(hi - lo) <= _EPS * max(1.0, abs(lo)):
            break
    if best is None and flo < f0:
        return lo, flo, fg(x + lo * p)[1]
    return best


# ------------------------------------------------------------------ lsqcurvefit

_LSQ_POSSIBLE = ("\nLocal minimum possible.\n\nlsqcurvefit stopped because the final change in the sum of squares "
                 "relative to \nits initial value is less than the value of the function tolerance.\n\n"
                 "<stopping criteria details>\n")
_LSQ_STEP = ("\nLocal minimum possible.\n\nlsqcurvefit stopped because the size of the current step is less than\n"
             "the value of the step size tolerance.\n\n<stopping criteria details>\n")
_LSQ_MAX = ("\nSolver stopped prematurely.\n\nlsqcurvefit stopped because it exceeded the iteration or function "
            "evaluation limit.\n\n<stopping criteria details>\n")


@_bi("lsqcurvefit")
def lsqcurvefit_(nargout, fun, x0, xdata, ydata, lb=None, ub=None, options=None):
    """[x, resnorm, residual, exitflag, output, lambda, jacobian] = lsqcurvefit(fun, x0, xdata, ydata, lb, ub,
    options): the coefficients x minimizing sum((fun(x, xdata) - ydata).^2), within the bounds lb <= x <= ub, by
    the Levenberg-Marquardt method with its steps projected onto the bounds; the Jacobian by forward differences
    unless SpecifyObjectiveGradient is set. exitflag 1: the gradient is below OptimalityTolerance; 2: the step is
    below StepTolerance; 3: the change in the sum of squares relative to it is below FunctionTolerance; 0: the
    limits."""
    f = _fun(fun, "lsqcurvefit")
    x, shape = _start(x0, "lsqcurvefit")
    d = _options(options, "lsqcurvefit")
    display = _display(d)
    n = x.size
    yv, yshape = _flat(ydata, "YDATA")
    lo = _bound(lb, n, -np.inf, "lb")
    hi = _bound(ub, n, np.inf, "ub")
    if np.any(lo > hi):
        raise _err("lsqcurvefit: the lower bounds must not exceed the upper bounds.")
    x = np.minimum(np.maximum(x, lo), hi)
    ftol, xtol, otol = _num(d, "FunctionTolerance"), _num(d, "StepTolerance"), _num(d, "OptimalityTolerance")
    maxit, maxfev = _num(d, "MaxIterations"), _num(d, "MaxFunctionEvaluations", n)
    jac = _flag(d, "SpecifyObjectiveGradient")
    count = _Counter()

    def R(z):
        r = _m._call(f, [_shaped(z, shape), xdata], 1)
        v, s = _flat(r, "FUN")
        if s != yshape:
            raise _err("Function value and YDATA sizes are not equal.", "optimlib:lsqcurvefit:YdataSizeMismatchFunVal")
        return v - yv

    def evaluate(z):
        count.n += 1
        if jac:
            rr = _m._call(f, [_shaped(z, shape), xdata], 2)
            v, s = _flat(rr[0], "FUN")
            if s != yshape:
                raise _err("Function value and YDATA sizes are not equal.",
                           "optimlib:lsqcurvefit:YdataSizeMismatchFunVal")
            return v - yv, _md(rr[1]).astype(np.float64)
        r = R(z)
        return r, _fd_jacobian(R, z, r, count)

    r, J = evaluate(x)
    rn = float(r @ r)
    g = J.T @ r
    fo0 = max(1.0, float(np.max(np.abs(g)))) if n else 1.0
    mu = 1e-3 * max(float(np.max(np.diag(J.T @ J))) if n else 1.0, 1e-12)
    it, flag, step = 0, None, 0.0
    while True:
        g = J.T @ r
        fo = float(np.max(np.abs(g))) if n else 0.0
        if fo <= otol * fo0 * _SQRT_EPS:
            flag = 1
            break
        if it >= maxit or count.n >= maxfev:
            flag = 0
            break
        # (the variables at a bound that the gradient pushes outward stay there; the step is over the others)
        free = ~(((x <= lo) & (g > 0)) | ((x >= hi) & (g < 0)))
        if not np.any(free):
            flag = 1
            break
        Jf = J[:, free]
        A = Jf.T @ Jf
        gf = g[free]
        accepted = False
        for _k in range(60):
            p = np.zeros(n)
            p[free] = np.linalg.solve(A + mu * np.diag(np.maximum(np.diag(A), 1e-12)), -gf)
            xn = np.minimum(np.maximum(x + p, lo), hi)
            pn = xn - x
            rnew, Jn = evaluate(xn)
            rnn = float(rnew @ rnew)
            if rnn < rn:
                accepted = True
                break
            mu *= 10.0
            if count.n >= maxfev:
                break
        if not accepted:
            flag = 2 if count.n < maxfev else 0
            break
        mu = max(mu / 10.0, 1e-20)
        change = rn - rnn
        x, r, J = xn, rnew, Jn
        old, rn = rn, rnn
        step = float(np.linalg.norm(pn))
        it += 1
        if change <= ftol * old and rn > 0:
            # (the sum of squares has stopped changing: done once the variables not held at a bound have a small
            # gradient too, flag 1 when every component's is, 3 when a bound holds the rest)
            g = J.T @ r
            held = ((x <= lo) & (g > 0)) | ((x >= hi) & (g < 0))
            gfree = float(np.max(np.abs(g[~held]))) if np.any(~held) else 0.0
            if gfree <= otol * fo0:
                flag = 1 if float(np.max(np.abs(g))) <= otol * fo0 * _SQRT_EPS else 3
                break
        if step <= xtol * (xtol + float(np.linalg.norm(x))):
            g = J.T @ r
            flag = 1 if float(np.max(np.abs(g))) <= otol * fo0 else 2
            break
    msg = {1: _LOCAL_MIN, 2: _LSQ_STEP, 3: _LSQ_POSSIBLE, 0: _LSQ_MAX}[flag]
    _say(display, msg)
    xo = _shaped(x, shape)
    if nargout <= 1:
        return xo
    gfinal = J.T @ r
    lam_lo = np.where((x <= lo) & (gfinal > 0), 2 * gfinal, 0.0)
    lam_hi = np.where((x >= hi) & (gfinal < 0), -2 * gfinal, 0.0)
    out = [xo, rn, _shaped(r, yshape), float(flag),
           _struct([("firstorderopt", float(np.max(np.abs(2 * gfinal))) if n else 0.0), ("iterations", float(it)),
                    ("funcCount", float(count.n)), ("cgiterations", 0.0), ("algorithm", Char("trust-region-reflective")),
                    ("stepsize", step), ("message", Char(msg.strip("\n"))), ("bestfeasible", _empty()),
                    ("constrviolation", _empty())]),
           _struct([("lower", _out(lam_lo.reshape((-1, 1)))), ("upper", _out(lam_hi.reshape((-1, 1))))]),
           _out(J)]
    return out[:nargout]


def _bound(v, n, default, what):
    if v is None or (not _istext(v) and _m._isnumlike(v) and _m._numel(v) == 0):
        return np.full(n, default)
    b = _md(v).T.reshape(-1).astype(np.float64)
    if b.size != n:
        raise _err("The number of elements in %s must equal the number of variables (%d)." % (what, n))
    return b


# ------------------------------------------------------------------ linprog

_LP_OPTIMAL = "\nOptimal solution found.\n\n"
_LP_UNBOUNDED = "\nProblem is unbounded.\n\n"
_LP_INFEASIBLE = "\nNo feasible solution found.\n\nlinprog stopped because no point satisfies the constraints.\n\n"
_LP_MAX = "\nSolver stopped prematurely.\n\nlinprog stopped because it exceeded the iteration limit.\n\n"


def _mat(v, rows, cols, what):
    """a constraint matrix (rows x cols, rows unknown when None), empty as 0 x cols"""
    if v is None or (not _istext(v) and _m._isnumlike(v) and _m._numel(v) == 0):
        return np.zeros((0, cols))
    M = _md(v).astype(np.float64)
    if M.shape[1] != cols:
        raise _err("The number of columns in %s must be the same as the number of elements of f." % what,
                   "optim:linprog:SizeMismatchColsOf%s" % what)
    return M


def _vecarg(v, n, what):
    if v is None or (not _istext(v) and _m._isnumlike(v) and _m._numel(v) == 0):
        return np.zeros(0)
    b = _md(v).T.reshape(-1).astype(np.float64)
    if b.size != n:
        raise _err("The number of rows in %s must be the same as the number of elements of %s." % (
            "A" if what == "b" else "Aeq", what), "optim:linprog:SizeMismatchRowsOf%s" % ("A" if what == "b" else "Aeq"))
    return b


@_bi("linprog")
def linprog_(nargout, f, A=None, b=None, Aeq=None, beq=None, lb=None, ub=None, options=None):
    """[x, fval, exitflag, output, lambda] = linprog(f, A, b, Aeq, beq, lb, ub, options): x minimizing f'*x subject
    to A*x <= b, Aeq*x = beq and lb <= x <= ub (no bounds when lb and ub are empty, as the page says), by the
    two-phase simplex method; lambda the Lagrange multipliers (lower, upper, eqlin, ineqlinLower, ineqlin), as
    f + A'*ineqlin + Aeq'*eqlin - lower + upper = 0. exitflag 1: optimal; -2: no feasible point; -3: unbounded
    (x and fval are then empty)."""
    if _istext(f) or not _m._isnumlike(f):
        raise _err("linprog: f must be a numeric vector.")
    c = _md(f).T.reshape(-1).astype(np.float64)
    n = c.size
    Ai = _mat(A, None, n, "A")
    bi = _vecarg(b, Ai.shape[0], "b")
    Ae = _mat(Aeq, None, n, "Aeq")
    be = _vecarg(beq, Ae.shape[0], "beq")
    lo = _bound(lb, n, -np.inf, "lb")
    hi = _bound(ub, n, np.inf, "ub")
    d = _options(options, "linprog")
    display = _display(d)
    maxit = _num(d, "MaxIterations", Ai.shape[0] + Ae.shape[0] + n)
    status, x, y_ineq, y_eq, red, it = _simplex(c, Ai, bi, Ae, be, lo, hi, maxit)
    if status == 0:
        msg = _LP_OPTIMAL
        flag = 1.0
    elif status == 2:
        msg, flag = _LP_UNBOUNDED, -3.0
    elif status == 3:
        msg, flag = _LP_MAX, 0.0
    else:
        msg, flag = _LP_INFEASIBLE, -2.0
    _say(display, msg)
    if status != 0:
        xo, fv = _empty(), _empty()
        lam = _struct([("lower", _empty()), ("upper", _empty()), ("eqlin", _empty()), ("ineqlinLower", _empty()),
                       ("ineqlin", _empty())])
        viol = _empty()
    else:
        xo, fv = _out(x.reshape((-1, 1))), float(c @ x)
        lam = _struct([("lower", _out(red[0].reshape((-1, 1)))), ("upper", _out(red[1].reshape((-1, 1)))),
                       ("eqlin", _out(y_eq.reshape((-1, 1)))), ("ineqlinLower", _out(np.zeros((y_ineq.size, 1)))),
                       ("ineqlin", _out(y_ineq.reshape((-1, 1))))])
        v = [0.0]
        if Ai.shape[0]:
            v.append(float(np.max(Ai @ x - bi)))
        if Ae.shape[0]:
            v.append(float(np.max(np.abs(Ae @ x - be))))
        viol = max(v)
    if nargout <= 1:
        return xo
    out = [xo, fv, flag,
           _struct([("iterations", float(it)), ("constrviolation", viol), ("message", Char(msg.strip("\n"))),
                    ("algorithm", Char("dual-simplex-highs")), ("firstorderopt", 0.0 if status == 0 else _empty())]),
           lam]
    return out[:nargout]


def _simplex(c, Ai, bi, Ae, be, lo, hi, maxit):
    """(status, x, ineqlin, eqlin, (lower, upper), iterations) for min c'x, Ai x <= bi, Ae x = be, lo <= x <= hi:
    status 0 optimal, 1 infeasible, 2 unbounded, 3 stopped at MaxIterations pivots. Each variable becomes nonnegative ones (x = lo + z, x = hi - z, or
    z1 - z2 when free), finite upper bounds of shifted variables become rows, slacks make every row an equation;
    phase 1 drives artificial variables out, phase 2 minimizes, Bland's rule throughout."""
    n = c.size
    cols = []  # (variable j, sign, kind): x_j = base + sign * z
    base = np.zeros(n)
    for j in range(n):
        if np.isfinite(lo[j]):
            base[j] = lo[j]
            cols.append((j, 1.0))
        elif np.isfinite(hi[j]):
            base[j] = hi[j]
            cols.append((j, -1.0))
        else:
            cols.append((j, 1.0))
            cols.append((j, -1.0))
    nz = len(cols)
    T = np.zeros((n, nz))
    for k, (j, s) in enumerate(cols):
        T[j, k] = s
    rows_ineq = [Ai @ T]
    rhs_ineq = [bi - Ai @ base]
    ub_rows = []
    for j in range(n):
        if np.isfinite(lo[j]) and np.isfinite(hi[j]):
            r = np.zeros(nz)
            r[[k for k, (jj, s) in enumerate(cols) if jj == j][0]] = 1.0
            rows_ineq.append(r.reshape((1, -1)))
            rhs_ineq.append(np.array([hi[j] - lo[j]]))
            ub_rows.append(j)
    Gi = np.vstack(rows_ineq) if rows_ineq else np.zeros((0, nz))
    hi_rhs = np.concatenate(rhs_ineq) if rhs_ineq else np.zeros(0)
    Ge, he = Ae @ T, be - Ae @ base
    mi, me = Gi.shape[0], Ge.shape[0]
    m = mi + me
    # (standard form: [Gi I; Ge 0] [z; s] = [hi_rhs; he], z, s >= 0; rows with a negative right side negated)
    M = np.zeros((m, nz + mi))
    M[:mi, :nz] = Gi
    M[:mi, nz:] = np.eye(mi)
    M[mi:, :nz] = Ge
    rhs = np.concatenate([hi_rhs, he])
    sgn = np.where(rhs < 0, -1.0, 1.0)
    M = M * sgn.reshape((-1, 1))
    rhs = rhs * sgn
    cz = np.concatenate([T.T @ c, np.zeros(mi)])
    N = nz + mi
    # (phase 1: artificial variables on every row)
    tab = np.hstack([M, np.eye(m), rhs.reshape((-1, 1))])
    basis = list(range(N, N + m))
    cost1 = np.concatenate([np.zeros(N), np.ones(m), [0.0]])
    it = [0]
    status = _pivot_loop(tab, basis, cost1, N + m, it, maxit)
    if status == 3:
        return 3, None, None, None, None, it[0]
    if m and tab[:, -1] @ cost1[_ix(basis)] > 1e-9 * max(1.0, float(np.max(np.abs(rhs))) if m else 1.0):
        return 1, None, None, None, None, it[0]
    # (drive the remaining artificial variables out of the basis, or drop their redundant rows)
    for r in range(m):
        if basis[r] >= N:
            cand = [k for k in range(N) if abs(tab[r, k]) > 1e-9]
            if cand:
                _pivot(tab, basis, r, cand[0])
    keep = [r for r in range(m) if basis[r] < N]
    kept = tab[_ix(keep)] if keep else np.zeros((0, tab.shape[1]))
    tab2 = np.hstack([kept[:, :N], kept[:, -1:]])
    basis2 = [basis[r] for r in keep]
    cost2 = np.concatenate([cz, [0.0]])
    status = _pivot_loop(tab2, basis2, cost2, N, it, maxit)
    if status in (2, 3):
        return status, None, None, None, None, it[0]
    zs = np.zeros(N)
    for r, k in enumerate(basis2):
        zs[k] = tab2[r, -1]
    x = base + T @ zs[:nz]
    # (the multipliers from the final basis: y = c_B B^-1 on the original rows, B from the standard form's columns)
    b2 = _ix(basis2)
    if m == 0:
        y = np.zeros(0)
    elif len(basis2) == m:
        y = np.linalg.solve(M[:, b2].T, cz[b2])
    else:
        y = np.linalg.lstsq(M[:, b2].T, cz[b2], rcond=None)[0]
    y = y * sgn
    red_z = cz - (M * sgn.reshape((-1, 1))).T @ y if m else cz.copy()
    ineq = -y[:mi]
    y_ineq = ineq[:Ai.shape[0]]
    upper = np.zeros(n)
    for k, j in enumerate(ub_rows):
        upper[j] = ineq[Ai.shape[0] + k]
    lower = np.zeros(n)
    for k, (j, s) in enumerate(cols):
        if np.isfinite(lo[j]) and s > 0:
            lower[j] = red_z[k]
        elif not np.isfinite(lo[j]) and np.isfinite(hi[j]):
            upper[j] = red_z[k]
    lower = np.where(np.abs(lower) < 1e-12, 0.0, lower)
    upper = np.where(np.abs(upper) < 1e-12, 0.0, upper)
    y_ineq = np.where(np.abs(y_ineq) < 1e-12, 0.0, y_ineq)
    return 0, x, y_ineq, -y[mi:], (lower, upper), it[0]


def _ix(basis):
    """the basis as an integer index array (empty when there are no rows)"""
    return np.asarray(basis, dtype=np.int64)


def _pivot(tab, basis, r, k):
    tab[r] = tab[r] / tab[r, k]
    for i in range(tab.shape[0]):
        if i != r and tab[i, k] != 0:
            tab[i] = tab[i] - tab[i, k] * tab[r]
    basis[r] = k


def _pivot_loop(tab, basis, cost, ncols, it, maxit):
    """the simplex iterations on the tableau for the costs: 0 optimal, 2 unbounded, 3 at the MaxIterations option's
    count of pivots (both phases together) (Bland's rule: the first column with a negative reduced cost enters; the
    ratio test's ties go to the smallest basic index)"""
    while True:
        if it[0] >= maxit:
            return 3
        red = cost[:ncols] - cost[_ix(basis)] @ tab[:, :ncols] if basis else cost[:ncols].copy()
        enter = next((k for k in range(ncols) if red[k] < -1e-10), None)
        if enter is None:
            return 0
        col = tab[:, enter]
        best, row = None, None
        for i in range(tab.shape[0]):
            if col[i] > 1e-12:
                ratio = tab[i, -1] / col[i]
                if best is None or ratio < best - 1e-12 or (abs(ratio - best) <= 1e-12 and basis[i] < basis[row]):
                    best, row = ratio, i
        if row is None:
            return 2
        _pivot(tab, basis, row, enter)
        it[0] += 1
