"""MATLAB's nonstiff ODE solvers, for lib/_matlab.py: odeset and odeget,
ode45 and ode23, and deval for their solution structures.

The formulas come from the papers the documentation pages cite: ode45 is
the Dormand-Prince pair (J. R. Dormand and P. J. Prince, "A family of
embedded Runge-Kutta formulae", J. Comput. Appl. Math. 6, 1980, table 2,
RK5(4)7M) with Shampine's interpolant for it (L. F. Shampine, "Some
practical Runge-Kutta formulas", Math. Comp. 46, 1986, section 4: a
fourth-order value at the middle of the step and local quartic
interpolation); ode23 is the Bogacki-Shampine pair (P. Bogacki and
L. F. Shampine, "A 3(2) pair of Runge-Kutta formulas", Appl. Math. Lett. 2,
1989, (2.6) and section 3) with the cubic Hermite interpolant that paper
names.  Both advance with the higher order formula and reuse the last
stage as the next step's first (L. F. Shampine and M. W. Reichelt, "The
MATLAB ODE suite", SIAM J. Sci. Comput. 18, 1997, section 5).

The step size control is SciPy's (scipy/integrate/_ivp/rk.py and
common.py, BSD license; see NOTICE.md), which follows Hairer, Norsett and
Wanner, "Solving Ordinary Differential Equations I", section II.4: the
starting step from the derivative's size and a trial Euler step, and a new
step 0.9 err^(-1/(q+1)) times the last, between 0.2 and 10 times it (no
growth after a rejection).  The error test is the one the odeset page
documents.  These choices are Sagebrush's, so its steps and statistics
differ from MATLAB's published ones while its solutions agree to the
tolerances.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bi, _err, _istext, _text

_EPS = 2.220446049250313e-16

# ------------------------------------------------------------------ odeset, odeget

# (the fields of an options structure, in the order the odeset page's
# published structures show them)
_FIELDS = ["AbsTol", "BDF", "Events", "InitialStep", "Jacobian", "JConstant", "JPattern", "Mass", "MassSingular",
           "MaxOrder", "MaxStep", "MinStep", "NonNegative", "NormControl", "OutputFcn", "OutputSel", "Refine", "RelTol",
           "Stats", "Vectorized", "MStateDependence", "MvPattern", "InitialSlope"]
_BY_LOWER = {f.lower(): f for f in _FIELDS}


def _empty():
    return np.zeros((0, 0))


def _is_empty(v):
    return _m._isnumlike(v) and type(v) is not _m.Char and _m._numel(v) == 0


def _field(name):
    if not _istext(name) or _text(name).lower() not in _BY_LOWER:
        raise _err("odeset: unrecognized property name%s." % (" '%s'" % _text(name) if _istext(name) else ""))
    return _BY_LOWER[_text(name).lower()]


def _real_vector(v):
    return _m._isnumlike(v) and type(v) is not _m.Char and not np.iscomplexobj(_m._arr(v))


def _check(name, v):
    """a value as the odeset page allows it, text stored as a character
    vector (as its published structures show "on" stored as 'on')"""
    if _is_empty(v):
        return v
    if _istext(v):
        v = _m.Char(_text(v))
    if name == "RelTol" or name in ("InitialStep", "MaxStep", "MinStep"):
        if not _real_vector(v) or _m._numel(v) != 1 or not _m._scalar(v) > 0:
            raise _err("odeset: %s must be a positive scalar." % name)
    elif name == "AbsTol":
        if not _real_vector(v) or not np.all(np.array(_m._arr(v), dtype=float) > 0):
            raise _err("odeset: AbsTol must be a positive scalar or vector.")
    elif name == "Refine":
        if not _real_vector(v) or _m._numel(v) != 1 or not _m._scalar(v) >= 1 or _m._scalar(v) != _math.floor(_m._scalar(v)):
            raise _err("odeset: Refine must be a positive integer.")
    elif name in ("NormControl", "Stats"):
        if not _istext(v) or _text(v).lower() not in ("on", "off"):
            raise _err("odeset: %s must be \"on\" or \"off\"." % name)
    elif name in ("Events", "OutputFcn"):
        if not (_m._iscallable(v) or _istext(v)):
            raise _err("odeset: %s must be a function handle." % name)
    elif name in ("OutputSel", "NonNegative"):
        a = np.array(_m._arr(v), dtype=float).reshape(-1) if _real_vector(v) else None
        if a is None or np.any(a < 1) or np.any(a != np.floor(a)):
            raise _err("odeset: %s must be a vector of indices." % name)
    return v


@_bi("odeset")
def odeset_(nargout, *args):
    """odeset as its documentation page describes it: odeset(Name, Value,
    ...), odeset(oldopts, Name, Value, ...) and odeset(oldopts, newopts)
    (newopts' values other than [] overwrite), a structure of the page's 23
    options in its order, names in any case.  The values the page fixes are
    checked (tolerances and step sizes positive, Refine a positive integer,
    "on"/"off" switches, functions, index vectors).  With neither arguments
    nor an output it lists the options (in Sagebrush's own format)"""
    args = list(args)
    if not args and nargout == 0:
        for f in _FIELDS:
            _m._write("%17s: %s\n" % (f, "[ positive scalar | vector ]" if f == "AbsTol" else "[ ]"))
        return _m.NOVAL
    opts = {f: _empty() for f in _FIELDS}
    if args and type(args[0]) is _m.Struct:
        old = args.pop(0)
        for k, v in old.a[0].items():
            opts[_field(_m.Char(k))] = v
        if args and type(args[0]) is _m.Struct:
            new = args.pop(0)
            if args:
                raise _err("odeset: odeset(oldopts, newopts) takes two options structures.")
            for k, v in new.a[0].items():
                if not _is_empty(v):
                    f = _field(_m.Char(k))
                    opts[f] = _check(f, v)
            return _m._struct1(opts)
    if len(args) % 2:
        raise _err("odeset: name-value arguments must come in pairs.")
    for i in range(0, len(args), 2):
        f = _field(args[i])
        opts[f] = _check(f, args[i + 1])
    return _m._struct1(opts)


@_bi("odeget")
def odeget_(nargout, options, name, *default):
    """odeget as its documentation page describes it: the named option's
    value (the name in any case), or the default when it is [] or absent"""
    if type(options) is not _m.Struct or _m._numel(options) != 1:
        raise _err("odeget: the first input must be an options structure.")
    if len(default) > 1:
        raise _err("Too many input arguments.")
    f = _field(name)
    d = options.a[0]
    v = next((d[k] for k in d if k.lower() == f.lower()), None)
    if v is None or _is_empty(v):
        return default[0] if default else _empty()
    return v


# ------------------------------------------------------------------ the formulas

# (Dormand and Prince 1980, table 2: RK5(4)7M; the fifth-order weights
# advance, the fourth-order ones estimate the error)
_DP_C = [0.0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1.0, 1.0]
_DP_A = [[],
         [1 / 5],
         [3 / 40, 9 / 40],
         [44 / 45, -56 / 15, 32 / 9],
         [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
         [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
         [35 / 384, 0.0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]]
_DP_B5 = [35 / 384, 0.0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0.0]
_DP_B4 = [5179 / 57600, 0.0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40]
# (Shampine 1986, section 4: the fourth-order value at the middle of the step)
_DP_MID = [6025192743 / 30085553152, 0.0, 51252292925 / 65400821598, -2691868925 / 45128329728,
           187940372067 / 1594534317056, -1776094331 / 19743644256, 11237099 / 235043384]

# (Bogacki and Shampine 1989: Ralston's third-order formula (2.6), the
# fourth stage at the end of the step, and the second-order weights)
_BS_C = [0.0, 1 / 2, 3 / 4, 1.0]
_BS_A = [[], [1 / 2], [0.0, 3 / 4], [2 / 9, 1 / 3, 4 / 9]]
_BS_B3 = [2 / 9, 1 / 3, 4 / 9, 0.0]
_BS_B2 = [7 / 24, 1 / 4, 1 / 3, 1 / 8]

_METHODS = {
    "ode45": {"c": _DP_C, "a": _DP_A, "b": _DP_B5, "e": [b5 - b4 for b5, b4 in zip(_DP_B5, _DP_B4)], "q": 4,
              "refine": 4},
    "ode23": {"c": _BS_C, "a": _BS_A, "b": _BS_B3, "e": [b3 - b2 for b3, b2 in zip(_BS_B3, _BS_B2)], "q": 2,
              "refine": 1},
}

# (the quartic through y(0), y'(0), y(1/2), y(1), y'(1), in s = (t - t_n)/h:
# p(s) = y0 + s h f0 + a2 s^2 + a3 s^3 + a4 s^4, with [a2 a3 a4] = M^-1 r)
_QUARTIC = np.linalg.inv(np.array([[1.0, 1.0, 1.0], [2.0, 3.0, 4.0], [0.25, 0.125, 0.0625]]))


def _interp(solver, step, s):
    """the solution and its derivative at the fractions s of a step (an
    array), from the step's data (t0, h, y0, y1, k: the stages' slopes)"""
    t0, h, y0, y1, k = step
    f0, f1 = k[:, 0], k[:, -1]
    s = np.asarray(s, dtype=float)
    if solver == "ode23":
        # (cubic Hermite interpolation to the values and slopes at the ends)
        d = y1 - y0
        a2 = 3 * d - h * (2 * f0 + f1)
        a3 = -2 * d + h * (f0 + f1)
        y = y0[:, None] + np.outer(h * f0, s) + np.outer(a2, s ** 2) + np.outer(a3, s ** 3)
        yp = (np.outer(h * f0, np.ones_like(s)) + np.outer(2 * a2, s) + np.outer(3 * a3, s ** 2)) / h
        return y, yp
    ym = y0 + (h / 2) * (k @ np.array(_DP_MID))
    a1 = h * f0
    r = np.array([y1 - y0 - a1, h * f1 - a1, ym - y0 - a1 / 2])
    a2, a3, a4 = _QUARTIC @ r
    y = y0[:, None] + np.outer(a1, s) + np.outer(a2, s ** 2) + np.outer(a3, s ** 3) + np.outer(a4, s ** 4)
    yp = (np.outer(a1, np.ones_like(s)) + np.outer(2 * a2, s) + np.outer(3 * a3, s ** 2) + np.outer(4 * a4, s ** 3)) / h
    return y, yp


# ------------------------------------------------------------------ the solver

def _opt(opts, name):
    if opts is None:
        return None
    d = opts.a[0]
    v = next((d[k] for k in d if k.lower() == name.lower()), None)
    return None if v is None or _is_empty(v) else v


def _rms(x):
    return float(np.linalg.norm(x)) / _math.sqrt(x.size) if x.size else 0.0


def _solve(solver, nargout, args):
    if len(args) < 3:
        raise _err("Not enough input arguments.")
    if len(args) > 4:
        raise _err("Too many input arguments.")
    f = _m._fn_arg(args[0])
    tspan = np.array(_m._arr(args[1]), dtype=float).reshape(-1) if _real_vector(args[1]) else None
    if tspan is None or tspan.size < 2:
        raise _err("%s: tspan must be a vector of at least two real times." % solver)
    if not np.all(np.isfinite(tspan)):
        raise _err("%s: tspan must be finite." % solver)
    d = np.diff(tspan)
    if not (np.all(d > 0) or np.all(d < 0)):
        raise _err("%s: the entries of tspan must be strictly increasing or strictly decreasing." % solver)
    if not _m._isnumlike(args[2]) or type(args[2]) is _m.Char or np.iscomplexobj(_m._arr(args[2])):
        raise _err("%s: y0 must be a real vector." % solver)
    single = _m.class_(args[1]) == "single" or _m.class_(args[2]) == "single"
    y0 = np.array(_m._arr(args[2]), dtype=float).reshape(-1)
    n = y0.size
    opts = args[3] if len(args) == 4 and not _is_empty(args[3]) else None
    if opts is not None and (type(opts) is not _m.Struct or _m._numel(opts) != 1):
        raise _err("%s: options must be a structure made by odeset." % solver)
    if opts is not None:
        for k in opts.a[0]:
            _field(_m.Char(k))
    for name in ("Mass", "NonNegative", "MvPattern", "InitialSlope"):
        if _opt(opts, name) is not None:
            raise _err("%s: the %s option is not supported in Sagebrush." % (solver, name))
    meth = _METHODS[solver]
    rtol = float(_m._scalar(_opt(opts, "RelTol"))) if _opt(opts, "RelTol") is not None else 1e-3
    rtol = max(rtol, 100 * _EPS)
    av = _opt(opts, "AbsTol")
    atol = np.full(n, 1e-6) if av is None else np.array(_m._arr(av), dtype=float).reshape(-1)
    if atol.size == 1:
        atol = np.full(n, atol[0])
    if atol.size != n:
        raise _err("%s: AbsTol must be a scalar or have one value per solution component." % solver)
    normc = _opt(opts, "NormControl") is not None and _text(_opt(opts, "NormControl")).lower() == "on"
    stats_on = _opt(opts, "Stats") is not None and _text(_opt(opts, "Stats")).lower() == "on"
    t0, tf = float(tspan[0]), float(tspan[-1])
    direction = 1.0 if tf > t0 else -1.0
    span = abs(tf - t0)
    maxstep = float(_m._scalar(_opt(opts, "MaxStep"))) if _opt(opts, "MaxStep") is not None else 0.1 * span
    minstep = float(_m._scalar(_opt(opts, "MinStep"))) if _opt(opts, "MinStep") is not None else 0.0
    refine = int(_m._scalar(_opt(opts, "Refine"))) if _opt(opts, "Refine") is not None else meth["refine"]
    events = _opt(opts, "Events")
    events = _m._fn_arg(events) if events is not None else None
    outfn = _opt(opts, "OutputFcn")
    outfn = _m._fn_arg(outfn) if outfn is not None else None
    outsel = _opt(opts, "OutputSel")
    outsel = (np.array(_m._arr(outsel), dtype=int).reshape(-1) - 1) if outsel is not None else np.arange(n)
    nfev = [0]

    def fun(t, y):
        r = _m._call(f, [float(t), _m._unmat(y.reshape((-1, 1)))])
        nfev[0] += 1
        if not _m._isnumlike(r) or type(r) is _m.Char or _m._numel(r) != n:
            raise _err("%s: the ODE function must return a vector of length %d (as y0)." % (solver, n))
        v = np.array(_m._arr(r)).reshape(-1)
        if np.iscomplexobj(v):
            if np.any(v.imag != 0):
                raise _err("%s: complex values are not supported in Sagebrush." % solver)
            v = v.real
        return v.astype(float)

    def evfun(t, y):
        r = _m._call(events, [float(t), _m._unmat(y.reshape((-1, 1)))], 3)
        val = np.array(_m._arr(r[0]), dtype=float).reshape(-1)
        term = np.array(_m._arr(r[1]), dtype=float).reshape(-1)
        dirn = np.array(_m._arr(r[2]), dtype=float).reshape(-1)
        if not (val.size == term.size == dirn.size):
            raise _err("%s: the event function's value, isterminal and direction must have the same length." % solver)
        return val, term, dirn

    sol_struct = nargout == 1
    y = y0.copy()
    t = t0
    fy = fun(t, y)
    c, A, b, E = meth["c"], meth["a"], meth["b"], np.array(meth["e"])
    s_count = len(c)
    # (the starting step: SciPy's select_initial_step, Hairer, Norsett and
    # Wanner's algorithm of section II.4, or InitialStep as an upper bound)
    scale = atol + np.abs(y) * rtol
    dd0, dd1 = _rms(y / scale), _rms(fy / scale)
    h0 = 1e-6 if dd0 < 1e-5 or dd1 < 1e-5 else 0.01 * dd0 / dd1
    h0 = min(h0, span)
    f1 = fun(t + direction * h0, y + direction * h0 * fy)
    dd2 = _rms((f1 - fy) / scale) / h0
    h1 = max(1e-6, h0 * 1e-3) if dd1 <= 1e-15 and dd2 <= 1e-15 else (0.01 / max(dd1, dd2)) ** (1 / (meth["q"] + 1))
    h = min(100 * h0, h1, span, maxstep)
    if _opt(opts, "InitialStep") is not None:
        h = min(h, float(_m._scalar(_opt(opts, "InitialStep"))))
    h = max(h, minstep)
    # (outputs)
    tout, yout = [t0], [y0.copy()]
    steps_x, steps_y, steps_data = [t0], [y0.copy()], []
    te, ye, ie = [], [], []
    nsteps = nfailed = 0
    k_out = 1 if len(tspan) > 2 else None
    halt = False
    if outfn is not None:
        _m._call(outfn, [_m._unmat(np.array([[t0, tf]])), _m._unmat(y0[outsel].reshape((-1, 1))), _m.Char("init")], 0)
    ev_prev = None
    if events is not None:
        ev_prev, _, _ = evfun(t, y)
    failed_msg = None
    while direction * (tf - t) > 0 and not halt:
        # (the smallest step: 100 spacings of the floating-point numbers at
        # t, Sagebrush's choice, or MinStep; a step that must be smaller ends
        # the integration with a warning.  SciPy's 10 spacings let a step
        # straddle a pole symmetrically, where the error estimates of the two
        # sides cancel)
        min_step = max(100 * abs(_math.nextafter(t, direction * _math.inf) - t), minstep)
        h = min(max(h, min_step), maxstep)
        rejected = False
        while True:
            if h < min_step * (1 - 1e-12):
                failed_msg = ("%s: at t = %g the step size fell below its minimum (%g), so the tolerances cannot be "
                              "met; the solution so far is returned." % (solver, t, min_step))
                break
            tn = t + direction * h
            if direction * (tn - tf) > 0 or abs(tf - tn) < 1e-12 * span:
                tn = tf
            hs = tn - t
            K = np.zeros((n, s_count))
            K[:, 0] = fy
            # (the stages; the last is at t + h with the new value itself,
            # first same as last, so it is the next step's first)
            for i in range(1, s_count):
                K[:, i] = fun(t + c[i] * hs, y + hs * (K[:, :i] @ np.array(A[i])))
            ynew = y + hs * (K @ np.array(b))
            errv = hs * (K @ E)
            if normc:
                err = float(np.linalg.norm(errv)) / max(rtol * max(float(np.linalg.norm(y)), float(np.linalg.norm(ynew))),
                                                         float(np.max(atol)))
            else:
                err = float(np.max(np.abs(errv) / np.maximum(rtol * np.maximum(np.abs(y), np.abs(ynew)), atol)))
            if not _math.isfinite(err):
                err = _math.inf
            expo = -1.0 / (meth["q"] + 1)
            if err <= 1:
                factor = 10.0 if err == 0 else min(10.0, 0.9 * err ** expo)
                if rejected:
                    factor = min(1.0, factor)
                hnext = abs(hs) * factor
                break
            nfailed += 1
            rejected = True
            h = abs(hs) * max(0.2, 0.9 * err ** expo)
        if failed_msg:
            _m.warning_(failed_msg)
            break
        nsteps += 1
        step = (t, hs, y.copy(), ynew.copy(), K.copy())
        steps_data.append(step)
        # (events: sign changes between the ends of the step, located on the
        # interpolant; a terminal one in the first step counts as not
        # terminal, as the odeset page says)
        stop_at = None
        if events is not None:
            ev_new, term, dirn = evfun(tn, ynew)
            found = []
            for j in range(ev_new.size):
                a0, a1 = ev_prev[j], ev_new[j]
                crossing = (a0 < 0 <= a1 or a0 > 0 >= a1) and a0 != 0
                if crossing and (dirn[j] == 0 or (dirn[j] > 0 and a1 > a0) or (dirn[j] < 0 and a1 < a0)):
                    ts = _event_time(lambda s: evfun(t + s * hs, _interp(solver, step, [s])[0][:, 0])[0][j], 0.0, 1.0, a0, a1)
                    found.append((ts, j))
            found.sort()
            for ts, j in found:
                yv = _interp(solver, step, [ts])[0][:, 0]
                te.append(t + ts * hs)
                ye.append(yv)
                ie.append(j + 1)
                if term[j] and nsteps > 1:
                    stop_at = (ts, yv)
                    break
            ev_prev = ev_new
        # (the output of this step)
        if stop_at is not None:
            s_end, y_end = stop_at
            t_end = t + s_end * hs
        else:
            s_end, y_end, t_end = 1.0, ynew, tn
        chunk_t, chunk_y = [], []
        if k_out is not None:
            while k_out < len(tspan) and direction * (tspan[k_out] - t_end) <= 0:
                s = (tspan[k_out] - t) / hs
                yv = ynew if tspan[k_out] == tn else _interp(solver, step, [s])[0][:, 0]
                chunk_t.append(float(tspan[k_out]))
                chunk_y.append(yv)
                k_out += 1
            if stop_at is not None and (not chunk_t or chunk_t[-1] != t_end):
                chunk_t.append(t_end)
                chunk_y.append(y_end)
        elif not sol_struct:
            for j in range(1, refine):
                s = j / refine
                if s >= s_end:
                    break
                chunk_t.append(t + s * hs)
                chunk_y.append(_interp(solver, step, [s])[0][:, 0])
            chunk_t.append(t_end)
            chunk_y.append(y_end)
        tout.extend(chunk_t)
        yout.extend(chunk_y)
        steps_x.append(t_end)
        steps_y.append(y_end.copy())
        if outfn is not None and chunk_t:
            st = _m._call(outfn, [_m._unmat(np.array(chunk_t).reshape((1, -1))),
                                  _m._unmat(np.array(chunk_y).T[outsel, :]), _empty()])
            if st is not _m.NOVAL and _m._isnumlike(st) and _m._numel(st) and _m._logical_val(st):
                halt = True
        if stop_at is not None:
            break
        t, y, fy = tn, ynew, K[:, -1]
        h = hnext
    if outfn is not None:
        _m._call(outfn, [_empty(), _empty(), _m.Char("done")], 0)
    if stats_on:
        _m._write("%d successful steps\n%d failed attempts\n%d function evaluations\n" % (nsteps, nfailed, nfev[0]))

    def num(a):
        r = _m._unmat(np.asarray(a))
        return _m._B["single"].f(1, r) if single else r
    if sol_struct:
        d = {"solver": _m.Char(solver),
             "extdata": _m._struct1({"odefun": f, "options": opts if opts is not None else _empty(),
                                     "varargin": _m.Cell([], (1, 0))}),
             "x": num(np.array(steps_x).reshape((1, -1))),
             "y": num(np.array(steps_y).T if steps_y else np.zeros((n, 0))),
             "stats": _m._struct1({"nsteps": float(nsteps), "nfailed": float(nfailed), "nfevals": float(nfev[0])}),
             "idata": _m._struct1({"_steps": _StepData(solver, steps_data)})}
        if events is not None:
            d["xe"] = num(np.array(te).reshape((1, -1)))
            d["ye"] = num(np.array(ye).T if ye else np.zeros((n, 0)))
            d["ie"] = num(np.array(ie, dtype=float).reshape((1, -1)))
        return _m._struct1(d)
    T = np.array(tout).reshape((-1, 1))
    Y = np.array(yout)
    if nargout == 0:
        _m._B["plot"].f(0, _m._unmat(T), _m._unmat(Y))
        return _m.NOVAL
    out = [num(T), num(Y)]
    if nargout > 2:
        out += [num(np.array(te).reshape((-1, 1))), num(np.array(ye).reshape((-1, n)) if ye else np.zeros((0, n))),
                num(np.array(ie, dtype=float).reshape((-1, 1)))]
    return out[:nargout]


class _StepData:
    """a solution's steps, for deval (an opaque value in sol.idata)"""
    __slots__ = ("solver", "steps")

    def __init__(self, solver, steps):
        self.solver, self.steps = solver, steps


def _event_time(g, a, b, ga, gb):
    """a zero of g on [a, b], where g changes sign, by the Illinois variant
    of regula falsi (Sagebrush's choice), to a few ulps of the step"""
    for _ in range(200):
        if abs(b - a) <= 4 * _EPS * max(1.0, abs(a), abs(b)):
            break
        m = b - gb * (b - a) / (gb - ga) if gb != ga else (a + b) / 2
        if not (min(a, b) < m < max(a, b)):
            m = (a + b) / 2
        gm = g(m)
        if gm == 0:
            return m
        if (gm < 0) == (gb < 0):
            b, gb = m, gm
            ga = ga / 2
        else:
            a, ga = b, gb
            b, gb = m, gm
    return b


@_bi("ode45")
def ode45_(nargout, *args):
    """ode45 as its documentation page describes it: [t, y] = ode45(odefun,
    tspan, y0, options), [t, y, te, ye, ie] with Events, and sol =
    ode45(...) for deval.  The Dormand-Prince pair with Shampine's
    interpolant, Refine 4 by default (see the module's docstring for the
    sources and Sagebrush's step size control); the options are odeset's
    RelTol, AbsTol, NormControl, InitialStep, MaxStep (0.1*abs(tf-t0)),
    MinStep, Refine, Stats, Events, OutputFcn and OutputSel.  Mass,
    NonNegative and the DAE options are refused.  Sagebrush's own choices:
    the step size control (SciPy's, from Hairer, Norsett and Wanner), a
    RelTol below 100*eps raised to it, the event location (regula falsi on
    the interpolant), the smallest step (100 spacings of the numbers at t)
    and the warning when a step must be smaller, a plot of the solution after the integration when there is no
    output (MATLAB plots it as it goes), and sol.idata's contents"""
    return _solve("ode45", nargout, list(args))


@_bi("ode23")
def ode23_(nargout, *args):
    """ode23 as its documentation page describes it: as ode45 (the same
    interface and options), with the Bogacki-Shampine pair and cubic Hermite
    interpolation, Refine 1 by default"""
    return _solve("ode23", nargout, list(args))


@_bi("deval")
def deval_(nargout, *args):
    """deval as its documentation page describes it: deval(sol, x) or
    deval(x, sol), with idx for some components, and [y, yp], the
    interpolated solution and its slope at points of [sol.x(1) sol.x(end)],
    for ode45's and ode23's solution structures (the solvers' own
    interpolants)"""
    args = list(args)
    if len(args) < 2:
        raise _err("Not enough input arguments.")
    if type(args[0]) is _m.Struct:
        sol, x = args[0], args[1]
    elif type(args[1]) is _m.Struct:
        x, sol = args[0], args[1]
    else:
        raise _err("deval: the solution structure must be the first or second input.")
    idx = args[2] if len(args) > 2 else None
    dd = sol.a[0]
    data = dd.get("idata")
    sd = data.a[0].get("_steps") if type(data) is _m.Struct else None
    if not isinstance(sd, _StepData):
        raise _err("deval: the solution structure must come from ode45 or ode23 in Sagebrush.")
    xs = np.array(_m._arr(x), dtype=float).reshape(-1)
    steps = sd.steps
    if not steps:
        raise _err("deval: the solution has no steps.")
    n = steps[0][2].size
    lo = min(steps[0][0], steps[-1][0] + steps[-1][1])
    hi = max(steps[0][0], steps[-1][0] + steps[-1][1])
    Y = np.zeros((n, xs.size))
    YP = np.zeros((n, xs.size))
    ends = np.array([st[0] + st[1] for st in steps])
    forward = steps[0][1] > 0
    for j, xv in enumerate(xs):
        if not (lo - 1e-12 * max(1.0, abs(lo)) <= xv <= hi + 1e-12 * max(1.0, abs(hi))):
            raise _err("deval: the points must lie in the interval of integration, [sol.x(1) sol.x(end)].")
        i = int(np.searchsorted(ends, xv)) if forward else int(np.searchsorted(-ends, -xv))
        i = min(i, len(steps) - 1)
        st = steps[i]
        s = (xv - st[0]) / st[1]
        yv, ypv = _interp(sd.solver, st, [s])
        Y[:, j], YP[:, j] = yv[:, 0], ypv[:, 0]
    if idx is not None:
        ii = np.array(_m._arr(idx), dtype=int).reshape(-1) - 1
        if np.any(ii < 0) or np.any(ii >= n):
            raise _err("deval: idx must index the solution's components.")
        Y, YP = Y[ii, :], YP[ii, :]
    out = [_m._unmat(Y), _m._unmat(YP)]
    return out[0] if nargout <= 1 else out[:nargout]
