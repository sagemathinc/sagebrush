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
