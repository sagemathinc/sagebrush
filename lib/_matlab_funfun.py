"""MATLAB's function functions, for lib/_matlab.py: the optimization
options (optimset, optimget) and, as they are added, the solvers that take
them.  Each comes from MATLAB's documentation pages and the published
algorithms its docstring cites; where neither fixes a detail, the choice is
Sagebrush's own and says so.  Each registers a built-in in _matlab's table
(_bs/_bi), the same way lib/_matlab.py's do.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bs, _bi, _err, _istext, _text

# ------------------------------------------------------------------ optimset, optimget

# (the options the optimset page documents, in its order)
_OPTIONS = ["Display", "FunValCheck", "MaxFunEvals", "MaxIter", "OutputFcn", "PlotFcns", "TolFun", "TolX"]

# (each solver's defaults, as the optimset page gives them; a default that
# depends on the problem, such as fminsearch's 200 times the number of
# variables, stays empty, and the solver applies it)
_EPS = 2.220446049250313e-16
_DEFAULTS = {
    "fzero": {"Display": "notify", "FunValCheck": "off", "TolX": _EPS},
    "fminbnd": {"Display": "notify", "FunValCheck": "off", "MaxFunEvals": 500.0, "MaxIter": 500.0, "TolX": 1e-4},
    "fminsearch": {"Display": "notify", "FunValCheck": "off", "TolFun": 1e-4, "TolX": 1e-4},
    "lsqnonneg": {"Display": "notify"},
}


def _option_name(name, fname="optimset"):
    """an option's full name from enough leading characters, case ignored,
    as the optimset page allows"""
    low = name.lower()
    exact = [o for o in _OPTIONS if o.lower() == low]
    if exact:
        return exact[0]
    hits = [o for o in _OPTIONS if o.lower().startswith(low)]
    if len(hits) == 1 and low:
        return hits[0]
    if not hits:
        raise _err("%s: unrecognized parameter name '%s'." % (fname, name))
    raise _err("%s: ambiguous parameter name '%s' (%s)." % (fname, name, ", ".join(hits)))


def _check_value(name, v):
    """an option's value as the optimset page allows it (its listing:
    Display and FunValCheck one of their words, stored in lower case;
    MaxFunEvals and MaxIter positive integers; TolFun and TolX nonnegative
    real scalars; OutputFcn a function handle or a cell array of them), or
    [] for unset; PlotFcns, whose predefined plot functions Sagebrush does
    not have, is refused"""
    if v is None or _is_empty(v):
        return v
    if name in ("Display", "FunValCheck"):
        words = ("notify", "final", "off", "none", "iter") if name == "Display" else ("on", "off")
        if not _istext(v) or _text(v).lower() not in words:
            raise _err("optimset: %s must be %s." % (name, ", ".join("'%s'" % w for w in words[:-1]) + " or '%s'" % words[-1]))
        return _m.Char(_text(v).lower())
    if name in ("MaxFunEvals", "MaxIter", "TolFun", "TolX"):
        ok = not _istext(v) and _m._isnumlike(v) and type(v) is not _m.Sparse and _m._numel(v) == 1 \
            and not np.iscomplexobj(_m._arr(v))
        x = float(_m._scalar(v)) if ok else _math.nan
        if name in ("MaxFunEvals", "MaxIter"):
            if not (ok and x > 0 and x == _math.floor(x) and _math.isfinite(x)):
                raise _err("optimset: %s must be a positive integer." % name)
        elif not (ok and x >= 0):
            raise _err("optimset: %s must be a nonnegative real scalar." % name)
        return v
    if name == "OutputFcn":
        fs = v.a if type(v) is _m.Cell else [v]
        if not all(_m._iscallable(f) for f in fs):
            raise _err("optimset: OutputFcn must be a function handle or a cell array of function handles.")
        return v
    if name == "PlotFcns":
        raise _err("optimset: the PlotFcns option is not supported in Sagebrush.")
    return v


def _empty():
    return np.zeros((0, 0))


def _value(v):
    return _m.Char(v) if isinstance(v, str) else v


def _new_options():
    return {o: _empty() for o in _OPTIONS}


def _is_empty(v):
    return _m._isnumlike(v) and type(v) is not _m.Char and _m._numel(v) == 0


@_bi("optimset")
def optimset_(nargout, *args):
    """optimset as documented: optimset() is a structure of every option,
    all []; optimset(solver) (a name or handle of fzero, fminbnd,
    fminsearch or lsqnonneg) holds that solver's defaults; Name, Value pairs
    (enough leading characters, case ignored) set options, starting from an
    old structure if one is given; optimset(oldopts, newopts) takes
    newopts' nonempty values over oldopts'.  With neither arguments nor an
    output it lists the options and their values (in Sagebrush's own
    format)"""
    args = list(args)
    if not args:
        if nargout == 0:
            for o, vals in (("Display", "'notify' | 'final' | 'off' | 'none' | 'iter'"), ("FunValCheck", "'off' | 'on'"),
                            ("MaxFunEvals", "positive integer"), ("MaxIter", "positive integer"),
                            ("OutputFcn", "function | cell array of functions"), ("PlotFcns", "function | cell array of functions"),
                            ("TolFun", "nonnegative scalar"), ("TolX", "nonnegative scalar")):
                _m._write("%15s: %s\n" % (o, vals))
            return _m.NOVAL
        return _m._struct1(_new_options())
    opts = _new_options()
    if len(args) == 1 and (_istext(args[0]) or _m._iscallable(args[0])):
        name = _text(args[0]) if _istext(args[0]) else getattr(args[0], "name", None) or _text(_m._B["func2str"].f(1, args[0])).lstrip("@")
        if name not in _DEFAULTS:
            raise _err("optimset: no default options for '%s' (fzero, fminbnd, fminsearch and lsqnonneg have them)." % name)
        for k, v in _DEFAULTS[name].items():
            opts[k] = _value(v)
        return _m._struct1(opts)
    if args and type(args[0]) is _m.Struct:
        old = args.pop(0)
        if _m._numel(old) != 1:
            raise _err("optimset: an options structure must be a scalar structure.")
        for k, v in old.a[0].items():
            name = _option_name(k)
            opts[name] = _check_value(name, v)
        if args and type(args[0]) is _m.Struct:
            new = args.pop(0)
            if args or _m._numel(new) != 1:
                raise _err("optimset: optimset(oldopts, newopts) takes two options structures.")
            for k, v in new.a[0].items():
                if not _is_empty(v):
                    name = _option_name(k)
                    opts[name] = _check_value(name, v)
            return _m._struct1(opts)
    if len(args) % 2:
        raise _err("optimset: name-value arguments must come in pairs.")
    for k in range(0, len(args), 2):
        if not _istext(args[k]):
            raise _err("optimset: a parameter name must be text.")
        name = _option_name(_text(args[k]))
        opts[name] = _check_value(name, args[k + 1])
    return _m._struct1(opts)


@_bi("optimget")
def optimget_(nargout, options, name, *default):
    """optimget as documented: the value of the option with that name
    (enough leading characters, case ignored) in an options structure, or
    the given default when it is not set (absent or [])"""
    if type(options) is not _m.Struct or _m._numel(options) != 1:
        raise _err("optimget: the first input must be an options structure.")
    if not _istext(name):
        raise _err("optimget: the parameter name must be text.")
    if len(default) > 1:
        raise _err("Too many input arguments.")
    full = _option_name(_text(name), "optimget")
    d = options.a[0]
    v = next((d[k] for k in d if k.lower() == full.lower()), None)
    if v is None or _is_empty(v):
        return default[0] if default else _empty()
    return v


# ------------------------------------------------------------------ the solvers' common parts

def _opt(options, name, solver=None):
    """an option's value from an options structure, or the solver's
    default (as optimset gives it) when it is absent or [] (None with no
    solver)"""
    v = None
    if options is not None:
        d = options.a[0]
        v = next((d[k] for k in d if k.lower() == name.lower()), None)
    if v is None or _is_empty(v):
        v = _DEFAULTS[solver].get(name) if solver else None
    if v is not None and _istext(v):
        # (the option words in any case, also from a structure built by hand)
        v = _text(v).lower() if name in ("Display", "FunValCheck") else _text(v)
    return v


def _options_arg(options, solver):
    if options is None or _is_empty(options):
        return None
    if type(options) is not _m.Struct or _m._numel(options) != 1:
        raise _err("%s: options must be a scalar structure, typically made by optimset." % solver)
    return options


def _display(options, solver):
    v = _opt(options, "Display", solver)
    v = "off" if v == "none" else v
    if v not in ("off", "iter", "final", "notify"):
        raise _err("%s: Display must be 'notify', 'final', 'off', 'none' or 'iter'." % solver)
    return v


def _output_fcns(options, solver):
    """the OutputFcn option as a list of functions; PlotFcns, which would
    need MATLAB's predefined plot functions, is refused"""
    if _opt(options, "PlotFcns", solver) is not None:
        raise _err("%s: the PlotFcns option is not supported in Sagebrush." % solver)
    v = _opt(options, "OutputFcn", solver)
    if v is None:
        return []
    fs = v.a if type(v) is _m.Cell else [v]
    return [_m._fn_arg(f) for f in fs]


def _call_output(fcns, x, values, state):
    """call each output function as stop = outfun(x, optimValues, state);
    true if any asks to stop.  The start is two calls, 'init' and then
    'iter' for iteration 0, as the published history an fminsearch output
    function records shows"""
    stop = False
    for st in (("init", "iter") if state == "init" else (state,)):
        for f in fcns:
            r = _m._call(f, [x, _m._struct1(dict(values)), _m.Char(st)])
            stop = _m._logical_val(r) or stop
        if stop:
            break
    return stop


def _single_round(v):
    return float(np.float32(v))


def _same_round(v):
    return v


# ------------------------------------------------------------------ fzero

class _ZeroFun:
    """fun for fzero: a real scalar value of a real scalar x, counted; its
    precision is single once x0 or a value is single"""

    def __init__(self, f, single, check):
        self.f, self.single, self.check, self.count = f, single, check, 0

    def __call__(self, x):
        arg = _m._canon(np.array([[x]], dtype=np.float32)) if self.single else x
        r = _m._call(self.f, [arg])
        self.count += 1
        if not _m._isnumlike(r) or type(r) is _m.Char or _m._numel(r) != 1:
            raise _err("fzero: the function must return a numeric scalar.")
        if _m.class_(r) == "single":
            self.single = True
        a = _m._arr(r).reshape(-1)[0]
        if np.iscomplexobj(a) and a.imag != 0:
            if self.check:
                raise _err("fzero: the function returned a complex value at x = %g (FunValCheck is on)." % x)
            return complex(a)
        v = float(a.real) if np.iscomplexobj(a) else float(a)
        if self.check and not _math.isfinite(v):
            raise _err("fzero: the function returned %s at x = %g (FunValCheck is on)." % (_m._special(v), x))
        return _single_round(v) if self.single else v


def _changes_sign(u, v):
    return u == 0 or v == 0 or (u < 0) != (v < 0)


def _fzero_row(count, x, fx, proc):
    _m._write("%5.0f%16.6g%14.6g        %s\n" % (count, x, fx, proc))


def _fzero_search_row(count, a, fa, b, fb, proc):
    _m._write("%5.0f%16.6g%14.6g%14.6g%14.6g               %s\n" % (count, a, fa, b, fb, proc))


def _fzero_search(F, x0, show, outs):
    """Look outward from a scalar x0 for a sign change.  As fzero's
    published iterative displays show, step k tries a = x0 - dx*sqrt(2)^k
    and then b = x0 + dx*sqrt(2)^k, with dx = x0/50, and stops at the first
    value whose sign differs from the other end's.  For x0 = 0, where that
    rule gives no step, dx = 1/50 is Sagebrush's own choice, as is ending
    the search (exitflag -6) when the next a or b would overflow.  Returns
    (a, fa, b, fb, k, flag, x, fx) where flag is None when it found a sign
    change"""
    fx0 = F(x0)
    R = _single_round if F.single else _same_round
    if show:
        _m._write("Search for an interval around %g containing a sign change:\n" % x0)
        _m._write(" Func-count    a          f(a)             b          f(b)                    Procedure\n")
        if type(fx0) is complex:
            _m._write("%5.0f%16.6g%14s%14.6g%14s               initial interval\n" % (1, x0, "complex", x0, "complex"))
        else:
            _fzero_search_row(1, x0, fx0, x0, fx0, "initial interval")
    vals = {"funccount": 1.0, "fval": fx0, "iteration": 0.0, "procedure": _m.Char("initial interval")}
    if type(fx0) is complex:
        return None, None, None, None, 0, -4, x0, fx0
    if not _math.isfinite(fx0):
        return None, None, None, None, 0, -3, x0, fx0
    if outs and _call_output(outs, x0, vals, "init"):
        return None, None, None, None, 0, -1, x0, fx0
    a = b = x0
    fa = fb = fx0
    if fx0 == 0:
        return a, fa, b, fb, 0, None, x0, fx0
    dx = x0 / 50 if x0 != 0 else 1 / 50
    k = 0
    while True:
        k += 1
        step = R(_math.ldexp(dx, k // 2) * (_math.sqrt(2) if k % 2 else 1.0))
        na, nb = R(x0 - step), R(x0 + step)
        if not (_math.isfinite(na) and _math.isfinite(nb)):
            return a, fa, b, fb, k - 1, -6, None, None
        a = na
        fa = F(a)
        bad = type(fa) is complex or not _math.isfinite(fa)
        if bad or not _changes_sign(fa, fb):
            if not bad:
                b = nb
                fb = F(b)
                bad = type(fb) is complex or not _math.isfinite(fb)
        if show:
            if type(fa) is complex or type(fb) is complex:
                _m._write("%5.0f%16.6g%14s%14.6g%14s               search\n" % (F.count, a, _fmt_val(fa), b, _fmt_val(fb)))
            else:
                _fzero_search_row(F.count, a, fa, b, fb, "search")
        for x, fx in ((a, fa), (b, fb)):
            if type(fx) is complex:
                return a, fa, b, fb, k, -4, x, fx
            if not _math.isfinite(fx):
                return a, fa, b, fb, k, -3, x, fx
        vals = {"funccount": float(F.count), "fval": fb, "iteration": float(k), "procedure": _m.Char("search")}
        if outs and _call_output(outs, b, vals, "iter"):
            return a, fa, b, fb, k, -1, b, fb
        if _changes_sign(fa, fb):
            return a, fa, b, fb, k, None, None, None


def _fmt_val(v):
    return "complex" if type(v) is complex else "%.6g" % v


def _fzero_brent(F, a, fa, b, fb, tol, show, outs, it0):
    """Brent's zero-finder (R. P. Brent, Algorithms for Minimization without
    Derivatives, Prentice-Hall 1973, chapter 4, procedure zero; the Fortran
    zeroin of Forsythe, Malcolm and Moler, Computer Methods for Mathematical
    Computations, Prentice-Hall 1976, section 7.2): on [a, b], where f
    changes sign, keep b the best point and c the other end of the
    bracket, and take an inverse quadratic (or, with two points, secant)
    step when it falls well inside the bracket and shrinks fast enough, and
    bisection otherwise, until the bracket is within
    tol1 = 2*u*|b| + tol/2 (u the unit roundoff, 2^-53 or 2^-24 in single)
    or f(b) = 0.  Each step rounds in the working precision.  Returns
    (b, fb, iterations, stopped by an output function)"""
    R = _single_round if F.single else _same_round
    u = 2.0 ** -24 if F.single else 2.0 ** -53
    tol = R(tol)
    c, fc = a, fa
    d = e = R(b - a)
    proc = "initial"
    it = 0
    while True:
        if abs(fc) < abs(fb):
            a, b, c = b, c, b
            fa, fb, fc = fb, fc, fb
        if show:
            _fzero_row(F.count, b, fb, proc)
        if it and outs:
            vals = {"funccount": float(F.count), "fval": fb, "iteration": float(it0 + it), "procedure": _m.Char(proc)}
            if _call_output(outs, b, vals, "iter"):
                return b, fb, it, True
        tol1 = R(R(2 * u * abs(b)) + R(0.5 * tol))
        xm = R(0.5 * R(c - b))
        if abs(xm) <= tol1 or fb == 0:
            return b, fb, it, False
        proc = "bisection"
        if abs(e) >= tol1 and abs(fa) > abs(fb):
            s = R(fb / fa)
            if a == c:
                p = R(R(2 * xm) * s)
                q = R(1 - s)
            else:
                q = R(fa / fc)
                r = R(fb / fc)
                p = R(s * R(R(R(R(2 * xm) * q) * R(q - r)) - R(R(b - a) * R(r - 1))))
                q = R(R(R(q - 1) * R(r - 1)) * R(s - 1))
            if p > 0:
                q = -q
            else:
                p = -p
            if R(2 * p) < R(R(R(3 * xm) * q) - abs(R(tol1 * q))) and p < abs(R(R(0.5 * e) * q)):
                e = d
                d = R(p / q)
                proc = "interpolation"
        if proc == "bisection":
            d = e = xm
        a, fa = b, fb
        b = R(b + d) if abs(d) > tol1 else R(b + (tol1 if xm > 0 else -tol1))
        fb = F(b)
        it += 1
        if type(fb) is complex or fb != fb:
            raise _err("fzero: the function returned %s at x = %g, inside the interval; fzero cannot continue."
                       % ("a complex value" if type(fb) is complex else "NaN", b))
        if (fb > 0 and fc > 0) or (fb < 0 and fc < 0):
            c, fc = a, fa
            d = e = R(b - a)


@_bi("fzero")
def fzero_(nargout, *args):
    """fzero as its documentation page describes it: fzero(fun, x0),
    fzero(fun, x0, options) and fzero(problem), with outputs
    [x, fval, exitflag, output].  A two-element x0 must bracket a sign
    change (an error otherwise); from a scalar x0 it first searches outward
    for one (_fzero_search).  The zero itself is Brent's method
    (_fzero_brent), which the page cites.  The options are Display,
    FunValCheck, OutputFcn and TolX (default eps, or eps('single') when x0
    or fun(x0) is single, when the arithmetic is single too).

    Sagebrush's own choices, where the page fixes nothing: a NaN or
    complex value inside the bracket is an error rather than a guess;
    exitflag -5 is never given, since the page says what it means (a
    possible singular point) but not how it is detected, so a sign change
    at a pole ends like any other, x the sign change's place and fval its
    large value; output functions see
    the search's steps as iterations too; the messages other than 'Zero
    found in the interval [a, b]' are Sagebrush's own; and PlotFcns is
    refused"""
    if len(args) == 1 and type(args[0]) is _m.Struct:
        p = args[0]
        if _m._numel(p) != 1:
            raise _err("fzero: the problem must be a scalar structure.")
        d = p.a[0]
        for k in ("objective", "x0", "solver"):
            if k not in d:
                raise _err("fzero: the problem structure needs the field '%s'." % k)
        if not _istext(d["solver"]) or _text(d["solver"]) != "fzero":
            raise _err("fzero: the problem structure's solver must be 'fzero'.")
        fun, x0, options = d["objective"], d["x0"], d.get("options")
    elif len(args) in (2, 3):
        fun, x0 = args[0], args[1]
        options = args[2] if len(args) == 3 else None
    elif len(args) < 2:
        raise _err("Not enough input arguments.")
    else:
        raise _err("Too many input arguments.")
    if nargout > 4:
        raise _err("Too many output arguments.")
    options = _options_arg(options, "fzero")
    f = _m._fn_arg(fun)
    disp = _display(options, "fzero")
    outs = _output_fcns(options, "fzero")
    check = _opt(options, "FunValCheck", "fzero") == "on"
    if type(x0) is _m.Char or not _m._isnumlike(x0) or _m._numel(x0) not in (1, 2):
        raise _err("fzero: x0 must be a real scalar or a two-element real vector.")
    xa = _m._arr(x0).T.reshape(-1)
    if np.iscomplexobj(xa) and np.any(xa.imag != 0):
        raise _err("fzero: x0 must be real.")
    xs = [float(v.real) if np.iscomplexobj(xa) else float(v) for v in xa]
    F = _ZeroFun(f, _m.class_(x0) == "single", check)
    if F.single:
        xs = [_single_round(v) for v in xs]
    tolx = _opt(options, "TolX")
    show = disp == "iter"
    intervals, iters, flag, x, fx = 0, 0, None, None, None
    if len(xs) == 2:
        if not all(_math.isfinite(v) for v in xs):
            raise _err("fzero: the interval x0 must be finite.")
        a, b = xs
        fa = F(a)
        fb = F(b)
        for v, fv in ((a, fa), (b, fb)):
            if type(fv) is complex or not _math.isfinite(fv):
                raise _err("fzero: the function value at the interval end x = %g must be real and finite." % v)
        if not _changes_sign(fa, fb):
            raise _err("fzero: the function values at the interval endpoints must differ in sign.")
        if show:
            _m._write(" Func-count    x          f(x)             Procedure\n")
    else:
        if not _math.isfinite(xs[0]):
            raise _err("fzero: x0 must be finite.")
        a, fa, b, fb, intervals, flag, x, fx = _fzero_search(F, xs[0], show, outs)
        if flag is None and show:
            _m._write("\nSearch for a zero in the interval [%g, %g]:\n" % (a, b))
            _m._write(" Func-count    x          f(x)             Procedure\n")
    if tolx is None:
        tolx = 1.1920928955078125e-07 if F.single else _EPS
    a0, b0, fa0, fb0 = a, b, fa, fb
    if flag is None:
        if len(xs) == 2 and outs:
            best = (b, fb) if abs(fb) <= abs(fa) else (a, fa)
            vals = {"funccount": float(F.count), "fval": best[1], "iteration": 0.0, "procedure": _m.Char("initial")}
            if _call_output(outs, best[0], vals, "init"):
                flag, x, fx = -1, best[0], best[1]
        if flag is None:
            x, fx, iters, stopped = _fzero_brent(F, a, fa, b, fb, float(_m._scalar(tolx)), show, outs, intervals)
            flag = -1 if stopped else 1
    if flag == 1:
        msg = "Zero found in the interval [%g, %g]" % (a0, b0)
    elif flag == -1:
        msg = "fzero stopped: an output function asked it to stop."
    elif flag == -6:
        msg = "fzero found no sign change: the search interval around %g grew as far as [%g, %g]." % (xs[0], a0, b0)
    else:
        msg = ("fzero stopped searching for an interval containing a sign change: the function value at x = %g is %s."
               % (x, "complex" if flag == -4 else _m._special(fx)))
    if flag in (-3, -4, -6):
        x = fx = _math.nan
    if outs:
        vals = {"funccount": float(F.count), "fval": fx if type(fx) is not complex else _math.nan,
                "iteration": float(intervals + iters), "procedure": _m.Char("")}
        _call_output(outs, x, vals, "done")
    if disp == "iter" or disp == "final" or (disp == "notify" and flag != 1):
        _m._write(("\n" if show else "") + msg + "\n")

    def num(v):
        return _m._canon(np.array([[v]], dtype=np.float32)) if F.single else float(v)
    out = [num(x), num(fx), num(float(flag)),
           _m._struct1({"intervaliterations": float(intervals), "iterations": float(iters), "funcCount": float(F.count),
                        "algorithm": _m.Char("bisection, interpolation"), "message": _m.Char(msg)})]
    return out[0] if nargout <= 1 else out[:nargout]


# ------------------------------------------------------------------ fminbnd

def _problem(args, solver, fields, nargs):
    """the arguments of solver(fun, ..., options) or solver(problem), the
    problem structure holding the given fields and solver"""
    if len(args) == 1 and type(args[0]) is _m.Struct:
        p = args[0]
        if _m._numel(p) != 1:
            raise _err("%s: the problem must be a scalar structure." % solver)
        d = p.a[0]
        for k in fields + ["solver"]:
            if k not in d:
                raise _err("%s: the problem structure needs the field '%s'." % (solver, k))
        if not _istext(d["solver"]) or _text(d["solver"]) != solver:
            raise _err("%s: the problem structure's solver must be '%s'." % (solver, solver))
        return [d[k] for k in fields] + [d.get("options")]
    if len(args) < nargs:
        raise _err("Not enough input arguments.")
    if len(args) > nargs + 1:
        raise _err("Too many input arguments.")
    return list(args) + [None] * (nargs + 1 - len(args))


def _real_value(f, x, solver, check):
    """fun(x) for a minimizer: a real scalar (NaN allowed unless
    FunValCheck is on; a complex value is always an error)"""
    r = _m._call(f, [x])
    if not _m._isnumlike(r) or type(r) is _m.Char or _m._numel(r) != 1:
        raise _err("%s: the objective function must return a numeric scalar." % solver)
    a = _m._arr(r).reshape(-1)[0]
    if np.iscomplexobj(a):
        if a.imag != 0:
            raise _err("%s: the objective function returned a complex value; only real values can be minimized." % solver)
        a = a.real
    v = float(a)
    if check and v != v:
        raise _err("%s: the objective function returned NaN (FunValCheck is on)." % solver)
    return v


def _positive_count(options, name, solver):
    v = _opt(options, name, solver)
    v = float(_m._scalar(v)) if not isinstance(v, float) else v
    return v


@_bi("fminbnd")
def fminbnd_(nargout, *args):
    """fminbnd as its documentation page describes it: fminbnd(fun, x1, x2),
    fminbnd(fun, x1, x2, options) and fminbnd(problem), with outputs
    [x, fval, exitflag, output].  The method is the one the page cites:
    Brent's localmin (R. P. Brent, Algorithms for Minimization without
    Derivatives, 1973, chapter 5; the Fortran fmin of Forsythe, Malcolm and
    Moler, Computer Methods for Mathematical Computations, 1976, section
    8.2), golden section search with parabolic interpolation, which never
    evaluates fun at the ends of the interval.  Its tolerance is
    sqrt(eps)*|x| + TolX/3, the one whose bound
    2*(TolX + 3*abs(x)*sqrt(eps)) the page gives.  The options are Display,
    FunValCheck, MaxFunEvals and MaxIter (500 each), OutputFcn and TolX
    (1e-4).  As the published displays show, the first evaluation is not
    an iteration.

    Sagebrush's own choices, where the page fixes nothing: x1 > x2 returns
    NaN with exitflag -2 without evaluating fun; a complex value is an
    error even with FunValCheck off; the limits are checked after the
    convergence test, before each new evaluation; output functions are
    called after each evaluation (the first with state 'init', then
    'iter'); the
    messages other than the converged one are Sagebrush's own; and
    PlotFcns is refused"""
    fun, x1, x2, options = _problem(args, "fminbnd", ["objective", "x1", "x2"], 3)
    if nargout > 4:
        raise _err("Too many output arguments.")
    options = _options_arg(options, "fminbnd")
    f = _m._fn_arg(fun)
    disp = _display(options, "fminbnd")
    outs = _output_fcns(options, "fminbnd")
    check = _opt(options, "FunValCheck", "fminbnd") == "on"
    ends = []
    for v in (x1, x2):
        if type(v) is _m.Char or not _m._isnumlike(v) or _m._numel(v) != 1 or _m.class_(v) != "double":
            raise _err("fminbnd: the bounds x1 and x2 must be double scalars.")
        a = _m._arr(v).reshape(-1)[0]
        if np.iscomplexobj(a) and a.imag != 0:
            raise _err("fminbnd: the bounds x1 and x2 must be real.")
        e = float(a.real)
        if not _math.isfinite(e):
            raise _err("fminbnd: the bounds x1 and x2 must be finite.")
        ends.append(e)
    a, b = ends
    tolx = float(_m._scalar(_opt(options, "TolX", "fminbnd")))
    maxfun = _positive_count(options, "MaxFunEvals", "fminbnd")
    maxit = _positive_count(options, "MaxIter", "fminbnd")
    show = disp == "iter"
    count, it = 0, 0
    algorithm = "golden section search, parabolic interpolation"

    def result(x, fx, flag, msg):
        if outs and flag != -2:
            _call_output(outs, x, {"funccount": float(count), "fval": fx, "iteration": float(it),
                                   "procedure": _m.Char("")}, "done")
        if disp == "iter" or disp == "final" or (disp == "notify" and flag != 1):
            _m._write(("\n" if show else "") + msg + "\n")
        out = [x, fx, float(flag), _m._struct1({"iterations": float(it), "funcCount": float(count),
                                               "algorithm": _m.Char(algorithm), "message": _m.Char(msg)})]
        return out[0] if nargout <= 1 else out[:nargout]

    if a > b:
        return result(_math.nan, _math.nan, -2, "fminbnd stopped: the bounds are inconsistent (x1 > x2).")
    if show:
        _m._write(" Func-count     x          f(x)         Procedure\n")

    def row(x, fx, proc):
        if show:
            _m._write("%5.0f%15.6g%13.6g        %s\n" % (count, x, fx, proc))

    c = 0.5 * (3.0 - _math.sqrt(5.0))
    seps = _math.sqrt(_EPS)
    v = w = x = a + c * (b - a)
    d = e = 0.0
    fx = _real_value(f, x, "fminbnd", check)
    count = 1
    fv = fw = fx
    row(x, fx, "initial")
    if outs and _call_output(outs, x, {"funccount": 1.0, "fval": fx, "iteration": 0.0,
                                       "procedure": _m.Char("initial")}, "init"):
        return result(x, fx, -1, "fminbnd stopped: an output function asked it to stop.")
    while True:
        xm = 0.5 * (a + b)
        tol1 = seps * abs(x) + tolx / 3.0
        tol2 = 2.0 * tol1
        if abs(x - xm) <= tol2 - 0.5 * (b - a):
            return result(x, fx, 1, "Optimization terminated:\n the current x satisfies the termination criteria "
                                    "using OPTIONS.TolX of %e " % tolx)
        if count >= maxfun or it >= maxit:
            which = "MaxFunEvals" if count >= maxfun else "MaxIter"
            return result(x, fx, 0, "fminbnd stopped: it reached the %s limit of %d before meeting TolX."
                          % (which, maxfun if which == "MaxFunEvals" else maxit))
        golden = True
        if abs(e) > tol1:
            r = (x - w) * (fx - fv)
            q = (x - v) * (fx - fw)
            p = (x - v) * q - (x - w) * r
            q = 2.0 * (q - r)
            if q > 0.0:
                p = -p
            q = abs(q)
            r, e = e, d
            if abs(p) < abs(0.5 * q * r) and p > q * (a - x) and p < q * (b - x):
                d = p / q
                u = x + d
                if u - a < tol2 or b - u < tol2:
                    d = tol1 if xm >= x else -tol1
                golden = False
        if golden:
            e = (b - x) if x < xm else (a - x)
            d = c * e
        u = x + (d if abs(d) >= tol1 else (tol1 if d > 0 else -tol1))
        fu = _real_value(f, u, "fminbnd", check)
        count += 1
        it += 1
        row(u, fu, "golden" if golden else "parabolic")
        if fu <= fx:
            if u >= x:
                a = x
            else:
                b = x
            v, fv, w, fw, x, fx = w, fw, x, fx, u, fu
        else:
            if u < x:
                a = u
            else:
                b = u
            if fu <= fw or w == x:
                v, fv, w, fw = w, fw, u, fu
            elif fu <= fv or v == x or v == w:
                v, fv = u, fu
        if outs and _call_output(outs, x, {"funccount": float(count), "fval": fx, "iteration": float(it),
                                           "procedure": _m.Char("golden" if golden else "parabolic")}, "iter"):
            return result(x, fx, -1, "fminbnd stopped: an output function asked it to stop.")


# ------------------------------------------------------------------ fminsearch

@_bi("fminsearch")
def fminsearch_(nargout, *args):
    """fminsearch as its documentation page describes it:
    fminsearch(fun, x0), fminsearch(fun, x0, options) and
    fminsearch(problem), with outputs [x, fval, exitflag, output]; fun gets
    x in x0's shape.  The method is the Nelder-Mead simplex search of
    Lagarias, Reeds, Wright and Wright (SIAM J. Optim. 9, 1998, section 2,
    with its standard coefficients 1, 2, 1/2 and 1/2), in the form MATLAB's
    "fminsearch Algorithm" page spells out step by step: the initial
    simplex adds 5% to each component of x0 in turn (0.00025 for a zero
    one); each iteration reflects the worst point through the centroid m of
    the others, then expands, accepts the reflection, contracts outside or
    inside, or shrinks toward the best point, with that page's tests.  The
    points are kept sorted by value, a new point after any it ties with
    (Lagarias et al.'s rule).  As the published display shows, building the
    initial simplex is iteration 1.

    It stops when both tolerances hold, as the page says it must; the
    measures are Sagebrush's own: every vertex within TolX of the best in
    each component, and every value within TolFun of the best value.  The
    other options are Display, FunValCheck, MaxFunEvals and MaxIter (each
    200 times the number of variables by default) and OutputFcn; PlotFcns
    is refused.  Also Sagebrush's own: a complex value is an error even with
    FunValCheck off; output functions are called after each iteration
    (x0, iteration 0, with state 'init' and then 'iter'); and the messages
    other than the converged one"""
    fun, x0, options = _problem(args, "fminsearch", ["objective", "x0"], 2)
    if nargout > 4:
        raise _err("Too many output arguments.")
    options = _options_arg(options, "fminsearch")
    f = _m._fn_arg(fun)
    disp = _display(options, "fminsearch")
    outs = _output_fcns(options, "fminsearch")
    check = _opt(options, "FunValCheck", "fminsearch") == "on"
    if type(x0) is _m.Char or not _m._isnumlike(x0) or _m.class_(x0) != "double" or _m._numel(x0) == 0:
        raise _err("fminsearch: x0 must be a nonempty double array.")
    a0 = _m._arr(x0)
    if np.iscomplexobj(a0):
        if np.any(a0.imag != 0):
            raise _err("fminsearch: x0 must be real.")
        a0 = a0.real
    shape = a0.shape
    start = np.array(a0, dtype=float).reshape(-1)  # (x0(:): the storage is transposed, so C order is MATLAB's)
    n = start.size
    tolx = float(_m._scalar(_opt(options, "TolX", "fminsearch")))
    tolf = float(_m._scalar(_opt(options, "TolFun", "fminsearch")))
    mf, mi = _opt(options, "MaxFunEvals"), _opt(options, "MaxIter")
    maxfun = 200.0 * n if mf is None else float(_m._scalar(mf))
    maxit = 200.0 * n if mi is None else float(_m._scalar(mi))
    show = disp == "iter"
    algorithm = "Nelder-Mead simplex direct search"

    def shaped(v):
        return _m._box(np.array(v, dtype=float).reshape(shape))

    count = [0]

    def value(v):
        count[0] += 1
        return _real_value(f, shaped(v), "fminsearch", check)

    def row(it, fbest, proc):
        if show:
            _m._write("%6.0f%13.0f%17.6g         %s\n" % (it, count[0], fbest, proc))

    def output(state, it, x, fx, proc):
        return outs and _call_output(outs, shaped(x), {"funccount": float(count[0]), "fval": fx,
                                                         "iteration": float(it), "procedure": _m.Char(proc)}, state)

    def result(x, fx, it, flag, msg):
        if outs:
            output("done", it, x, fx, "")
        if disp == "iter" or disp == "final" or (disp == "notify" and flag != 1):
            _m._write(("\n" if show else "") + msg + "\n")
        out = [shaped(x), fx, float(flag), _m._struct1({"iterations": float(it), "funcCount": float(count[0]),
                                                        "algorithm": _m.Char(algorithm), "message": _m.Char(msg)})]
        return out[0] if nargout <= 1 else out[:nargout]

    stopped = "fminsearch stopped: an output function asked it to stop."
    if show:
        _m._write(" Iteration   Func-count         f(x)         Procedure\n")
    pts = [start.copy()]
    vals = [value(start)]
    row(0, vals[0], "")
    if output("init", 0, pts[0], vals[0], ""):
        return result(pts[0], vals[0], 0, -1, stopped)
    for i in range(n):
        y = start.copy()
        y[i] = 1.05 * y[i] if y[i] != 0 else 0.00025
        pts.append(y)
        vals.append(value(y))

    def order():
        idx = sorted(range(n + 1), key=lambda k: vals[k])
        pts[:] = [pts[k] for k in idx]
        vals[:] = [vals[k] for k in idx]

    order()
    it = 1
    row(it, vals[0], "initial simplex")
    if output("iter", it, pts[0], vals[0], "initial simplex"):
        return result(pts[0], vals[0], it, -1, stopped)
    while True:
        best = pts[0]
        if (max(float(np.max(np.abs(p - best))) for p in pts[1:]) <= tolx
                and max(abs(v - vals[0]) for v in vals[1:]) <= tolf):
            return result(best, vals[0], it, 1,
                          "Optimization terminated:\n the current x satisfies the termination criteria using OPTIONS.TolX of %e \n"
                          " and F(X) satisfies the convergence criteria using OPTIONS.TolFun of %e " % (tolx, tolf))
        if count[0] >= maxfun or it >= maxit:
            which, lim = ("MaxFunEvals", maxfun) if count[0] >= maxfun else ("MaxIter", maxit)
            return result(best, vals[0], it, 0,
                          "fminsearch stopped: it reached the %s limit of %d before meeting TolX and TolFun." % (which, lim))
        it += 1
        worst, fworst = pts[n], vals[n]
        m = np.sum(np.array(pts[:n]), axis=0) / n
        r = 2 * m - worst
        fr = value(r)
        if vals[0] <= fr < vals[n - 1]:
            new, fnew, proc = r, fr, "reflect"
        elif fr < vals[0]:
            s = m + 2 * (m - worst)
            fs = value(s)
            new, fnew, proc = (s, fs, "expand") if fs < fr else (r, fr, "reflect")
        else:
            new = None
            if fr < fworst:
                c = m + (r - m) / 2
                fc = value(c)
                if fc < fr:
                    new, fnew, proc = c, fc, "contract outside"
            else:
                cc = m + (worst - m) / 2
                fcc = value(cc)
                if fcc < fworst:
                    new, fnew, proc = cc, fcc, "contract inside"
            if new is None:
                proc = "shrink"
                for i in range(1, n + 1):
                    pts[i] = pts[0] + (pts[i] - pts[0]) / 2
                    vals[i] = value(pts[i])
        if new is not None:
            pts[n], vals[n] = new, fnew
        order()
        row(it, vals[0], proc)
        if output("iter", it, pts[0], vals[0], proc):
            return result(pts[0], vals[0], it, -1, stopped)
