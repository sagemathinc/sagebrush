"""MATLAB's stiff ODE solvers, for lib/_matlab.py: ode15s and ode23s.  Both are written from the paper MATLAB's
documentation cites for them, L. F. Shampine and M. W. Reichelt, "The MATLAB ODE suite", SIAM J. Sci. Comput. 18
(1997):

- ode23s is the modified Rosenbrock triple of section 3, d = 1/(2 + sqrt(2)), e32 = 6 + sqrt(2): a second-order
  formula with a third-order error estimate and the continuous extension the paper gives, a W-method with the
  Jacobian (from the Jacobian option, or by forward differences) evaluated at the start of every step;
- ode15s is the variable-order (1 to MaxOrder, 5 by default) numerical differentiation formulas of section 2, kappa
  = (-0.1850, -1/9, -0.0823, -0.0415, 0) (the backward differentiation formulas with BDF 'on'), in backward
  differences with quasi-constant steps (the differences rescaled when the step changes), the implicit equation
  solved by a simplified Newton iteration that keeps its Jacobian while it converges.

A constant mass matrix M (M y' = f(t, y)) is allowed for both, singular too (an index-1 differential-algebraic
equation from consistent initial values).  The step size and order selection, the error norm (each component
against max(RelTol*|y|, AbsTol), as the odeset page documents for the other solvers) and the starting step are
this module's: its steps and statistics differ from MATLAB's while its solutions agree to the tolerances.
Loaded lazily (the matlab-more chunk); the interface (tspan, outputs, Events, the solution structure for deval) is
lib/_matlab_ode.py's.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bi, _err, _text
import _matlab_ode as _ode

_EPS = 2.220446049250313e-16
_SQRT2 = _math.sqrt(2.0)
_D = 1.0 / (2.0 + _SQRT2)
_E32 = 6.0 + _SQRT2
_KAPPA = [0.0, -0.1850, -1.0 / 9.0, -0.0823, -0.0415, 0.0]
_GAMMA = [0.0] + [sum(1.0 / i for i in range(1, k + 1)) for k in range(1, 7)]


def interp(solver, step, s):
    """the solution and its derivative at the fractions s of a step (an array), from what the step kept"""
    s = np.asarray(s, dtype=float)
    if solver == "ode23s":
        # (the paper's continuous extension: y0 + h (s(1-s)/(1-2d) k1 + s(s-2d)/(1-2d) k2))
        t0, h, y0, y1, k1, k2 = step
        a = (s * (1 - s)) / (1 - 2 * _D)
        b = (s * (s - 2 * _D)) / (1 - 2 * _D)
        y = y0[:, None] + h * (np.outer(k1, a) + np.outer(k2, b))
        yp = np.outer(k1, (1 - 2 * s) / (1 - 2 * _D)) + np.outer(k2, (2 * s - 2 * _D) / (1 - 2 * _D))
        return y, yp
    # (ode15s: the interpolating polynomial in backward differences at the step's end, s' = s - 1 in [-1, 0])
    t0, h, y0, y1, D, k = step
    sp = s - 1.0
    n = y1.size
    y = np.tile(D[:, 0][:, None], (1, s.size))
    yp = np.zeros((n, s.size))
    prod = np.ones(s.size)
    dprod = np.zeros(s.size)
    for j in range(1, k + 1):
        fac = (sp + (j - 1)) / j
        dprod = dprod * fac + prod / j
        prod = prod * fac
        y = y + np.outer(D[:, j], prod)
        yp = yp + np.outer(D[:, j], dprod)
    return y, yp / h


def _solve(solver, nargout, args):
    if len(args) < 3:
        raise _err("Not enough input arguments.")
    if len(args) > 4:
        raise _err("Too many input arguments.")
    f = _m._fn_arg(args[0])
    tspan = np.array(_m._arr(args[1]), dtype=float).reshape(-1) if _ode._real_vector(args[1]) else None
    if tspan is None or tspan.size < 2:
        raise _err("%s: tspan must be a vector of at least two real times." % solver)
    if not np.all(np.isfinite(tspan)):
        raise _err("%s: tspan must be finite." % solver)
    if tspan[0] == tspan[-1]:
        raise _err("The last entry in tspan must be different from the first entry.",
                   "MATLAB:odearguments:TspanEndpointsNotDistinct")
    dts = np.diff(tspan)
    if not (np.all(dts > 0) or np.all(dts < 0)):
        raise _err("The entries in tspan must strictly increase or decrease.", "MATLAB:odearguments:TspanNotMonotonic")
    if not _m._isnumlike(args[2]) or type(args[2]) is _m.Char or np.iscomplexobj(_m._arr(args[2])):
        raise _err("%s: y0 must be a real vector." % solver)
    y0 = np.array(_m._arr(args[2]), dtype=float).reshape(-1)
    n = y0.size
    opts = args[3] if len(args) == 4 and not _ode._is_empty(args[3]) else None
    if opts is not None and (type(opts) is not _m.Struct or _m._numel(opts) != 1):
        raise _err("%s: options must be a structure made by odeset." % solver)
    if opts is not None:
        for k in opts.a[0]:
            _ode._field(_m.Char(k))
    o = lambda name: _ode._opt(opts, name)  # noqa: E731
    for name in ("NonNegative", "MvPattern", "InitialSlope", "OutputFcn", "Vectorized", "JPattern"):
        if o(name) is not None:
            raise _err("%s: the %s option is not supported in Sagebrush." % (solver, name))
    if o("MStateDependence") is not None and _text(o("MStateDependence")).lower() != "none":
        raise _err("%s: only a constant mass matrix is supported in Sagebrush." % solver)
    rtol = max(float(_m._scalar(o("RelTol"))) if o("RelTol") is not None else 1e-3, 100 * _EPS)
    av = o("AbsTol")
    atol = np.full(n, 1e-6) if av is None else np.array(_m._arr(av), dtype=float).reshape(-1)
    if atol.size == 1:
        atol = np.full(n, atol[0])
    if atol.size != n:
        raise _err("%s: AbsTol must be a scalar or have one value per solution component." % solver)
    stats_on = o("Stats") is not None and _text(o("Stats")).lower() == "on"
    t0, tf = float(tspan[0]), float(tspan[-1])
    direction = 1.0 if tf > t0 else -1.0
    span = abs(tf - t0)
    maxstep = float(_m._scalar(o("MaxStep"))) if o("MaxStep") is not None else 0.1 * span
    refine = int(_m._scalar(o("Refine"))) if o("Refine") is not None else 1
    maxorder = int(_m._scalar(o("MaxOrder"))) if o("MaxOrder") is not None else 5
    if not 1 <= maxorder <= 5:
        raise _err("%s: MaxOrder must be 1, 2, 3, 4 or 5." % solver)
    bdf = o("BDF") is not None and _text(o("BDF")).lower() == "on"
    Mv = o("Mass")
    if Mv is not None and _m._iscallable(Mv):
        raise _err("%s: a mass matrix function is not supported in Sagebrush: give a constant matrix." % solver)
    M = np.eye(n) if Mv is None else np.array(_m._farr(Mv)).T.astype(float)
    if M.shape != (n, n):
        raise _err("%s: the mass matrix must be %d by %d." % (solver, n, n))
    events = o("Events")
    events = _m._fn_arg(events) if events is not None else None
    jopt = o("Jacobian")
    nfev, njac, nlu = [0], [0], [0]

    def fun(t, y):
        r = _m._call(f, [float(t), _m._unmat(y.reshape((-1, 1)))])
        nfev[0] += 1
        if not _m._isnumlike(r) or type(r) is _m.Char or _m._numel(r) != n:
            # (the function's text upper-cased, as MATLAB's message gives it: @(T,Y)[Y;Y])
            name = _text(_m._B["func2str"].f(1, f)).upper() if _m._iscallable(f) else "the ODE function"
            raise _err("%s returns a vector of length %d, but the length of initial conditions vector is %d. The vector "
                       "returned by %s and the initial conditions vector must have the same number of elements."
                       % (name, _m._numel(r) if _m._isnumlike(r) else 0, n, name), "MATLAB:odearguments:SizeIC")
        v = np.array(_m._arr(r)).reshape(-1)
        if np.iscomplexobj(v):
            if np.any(v.imag != 0):
                raise _err("%s: complex values are not supported in Sagebrush." % solver)
            v = v.real
        return v.astype(float)

    def jac(t, y, fy):
        njac[0] += 1
        if jopt is not None:
            Jm = _m._call(jopt, [float(t), _m._unmat(y.reshape((-1, 1)))]) if _m._iscallable(jopt) else jopt
            return np.array(_m._farr(Jm)).T.astype(float).reshape((n, n))
        J = np.zeros((n, n))
        for j in range(n):
            hj = _math.sqrt(_EPS) * max(abs(y[j]), atol[j] / rtol if rtol > 0 else 1.0, 1e-8)
            yj = y.copy()
            yj[j] += hj
            J[:, j] = (fun(t, yj) - fy) / (yj[j] - y[j])
        return J

    def evfun(t, y):
        r = _m._call(events, [float(t), _m._unmat(y.reshape((-1, 1)))], 3)
        return (np.array(_m._arr(r[0]), dtype=float).reshape(-1), np.array(_m._arr(r[1]), dtype=float).reshape(-1),
                np.array(_m._arr(r[2]), dtype=float).reshape(-1))

    def wnorm(e, ya, yb):
        return float(np.max(np.abs(e) / np.maximum(rtol * np.maximum(np.abs(ya), np.abs(yb)), atol))) if n else 0.0

    # (the starting step: from the slope's size, as for the explicit solvers, then capped)
    fy0 = fun(t0, y0)
    if np.all(M == np.eye(n)):
        yp0 = fy0
    else:
        yp0 = np.linalg.lstsq(M, fy0, rcond=None)[0]
    scale = atol + np.abs(y0) * rtol
    rate = float(np.max(np.abs(yp0) / scale)) if n else 0.0
    h = min(maxstep, span, (rtol ** (1.0 / 3.0)) / rate if rate > 0 else span * 0.01)
    if o("InitialStep") is not None:
        h = min(h, float(_m._scalar(o("InitialStep"))))
    h = max(h, 16 * _EPS * max(abs(t0), 1.0))
    stepper = _Rosenbrock(fun, jac, M, wnorm) if solver == "ode23s" else _NDF(fun, jac, M, wnorm, maxorder, bdf, n)
    stepper.start(t0, y0, fy0, yp0, h * direction)

    tout, yout = [t0], [y0.copy()]
    steps_x, steps_y, steps_data = [t0], [y0.copy()], []
    te, ye, ie = [], [], []
    k_out = 1 if len(tspan) > 2 else None
    ev_prev = evfun(t0, y0)[0] if events is not None else None
    t, y = t0, y0.copy()
    while direction * (tf - t) > 0:
        res = stepper.step(tf, maxstep, direction)
        if res is None:
            _m.warning_("%s: at t = %g the step size fell below its minimum, so the tolerances cannot be met; the "
                        "solution so far is returned." % (solver, t))
            break
        tn, ynew, data = res
        hs = tn - t
        steps_data.append(data)
        stop_at = None
        if events is not None:
            ev_new, term, dirn = evfun(tn, ynew)
            found = []
            for j in range(ev_new.size):
                a0, a1 = ev_prev[j], ev_new[j]
                if (a0 < 0 <= a1 or a0 > 0 >= a1) and a0 != 0 and \
                        (dirn[j] == 0 or (dirn[j] > 0 and a1 > a0) or (dirn[j] < 0 and a1 < a0)):
                    ts = _ode._event_time(lambda s: evfun(t + s * hs, interp(solver, data, [s])[0][:, 0])[0][j],
                                          0.0, 1.0, a0, a1)
                    found.append((ts, j))
            found.sort()
            for ts, j in found:
                yv = interp(solver, data, [ts])[0][:, 0]
                te.append(t + ts * hs)
                ye.append(yv)
                ie.append(j + 1)
                if term[j] and len(steps_data) > 1:
                    stop_at = (ts, yv)
                    break
            ev_prev = ev_new
        s_end, y_end, t_end = (stop_at[0], stop_at[1], t + stop_at[0] * hs) if stop_at else (1.0, ynew, tn)
        if k_out is not None:
            while k_out < len(tspan) and direction * (tspan[k_out] - t_end) <= 0:
                s = (tspan[k_out] - t) / hs
                tout.append(float(tspan[k_out]))
                yout.append(ynew if tspan[k_out] == tn else interp(solver, data, [s])[0][:, 0])
                k_out += 1
            if stop_at is not None and tout[-1] != t_end:
                tout.append(t_end)
                yout.append(y_end)
        else:
            for j in range(1, refine):
                s = j / refine
                if s >= s_end:
                    break
                tout.append(t + s * hs)
                yout.append(interp(solver, data, [s])[0][:, 0])
            tout.append(t_end)
            yout.append(y_end)
        steps_x.append(t_end)
        steps_y.append(y_end.copy())
        if stop_at is not None:
            break
        t, y = tn, ynew
    if stats_on:
        _m._write("%d successful steps\n%d failed attempts\n%d function evaluations\n%d partial derivatives\n"
                  "%d LU decompositions\n%d solutions of linear systems\n"
                  % (stepper.nsteps, stepper.nfailed, nfev[0], njac[0], stepper.nlu, stepper.nsolve))
    stats = {"nsteps": float(stepper.nsteps), "nfailed": float(stepper.nfailed), "nfevals": float(nfev[0]),
             "npds": float(njac[0]), "ndecomps": float(stepper.nlu), "nsolves": float(stepper.nsolve), "tfinal": float(steps_x[-1])}
    if nargout == 1:
        # (the fields in MATLAB's order: xe, ye and ie after y, with Events)
        d = {"solver": _m.Char(solver),
             "extdata": _m._struct1({"odefun": f, "options": opts if opts is not None else _ode._empty(),
                                     "varargin": _m.Cell([], (1, 0))}),
             "x": _m._unmat(np.array(steps_x).reshape((1, -1))),
             "y": _m._unmat(np.array(steps_y).T if steps_y else np.zeros((n, 0)))}
        if events is not None:
            d["xe"] = _m._unmat(np.array(te).reshape((1, -1)))
            d["ye"] = _m._unmat(np.array(ye).T if ye else np.zeros((n, 0)))
            d["ie"] = _m._unmat(np.array(ie, dtype=float).reshape((1, -1)))
        d["stats"] = _m._struct1(stats)
        d["idata"] = _m._struct1({"_steps": _ode._StepData(solver, steps_data, steps_x[-1])})
        return _m._struct1(d)
    T = np.array(tout).reshape((-1, 1))
    Y = np.array(yout)
    if nargout == 0:
        _m._B["plot"].f(0, _m._unmat(T), _m._unmat(Y))
        return _m.NOVAL
    out = [_m._unmat(T), _m._unmat(Y)]
    if nargout > 2:
        out += [_m._unmat(np.array(te).reshape((-1, 1))), _m._unmat(np.array(ye).reshape((-1, n)) if ye else np.zeros((0, n))),
                _m._unmat(np.array(ie, dtype=float).reshape((-1, 1)))]
    return out[:nargout]


class _Rosenbrock:
    """ode23s's steps: the modified Rosenbrock triple, the Jacobian at the start of each step and the time derivative
    by a forward difference"""

    def __init__(self, fun, jac, M, wnorm):
        self.fun, self.jac, self.M, self.wnorm = fun, jac, M, wnorm
        self.nsteps = self.nfailed = self.nlu = self.nsolve = 0

    def start(self, t, y, fy, yp, h):
        self.t, self.y, self.fy, self.h = t, y, fy, h

    def step(self, tf, maxstep, direction):
        t, y, F0, M = self.t, self.y, self.fy, self.M
        J = self.jac(t, y, F0)
        dt = _math.sqrt(_EPS) * max(abs(t), 1.0)
        T = (self.fun(t + dt, y) - F0) / dt
        rejected = False
        while True:
            h = self.h
            if direction * (t + h - tf) > 0 or abs(tf - t - h) < 1e-12 * abs(h):
                h = tf - t
            if abs(h) < 16 * _EPS * max(abs(t), 1.0):
                return None
            W = M - h * _D * J
            self.nlu += 1
            try:
                Wi = np.linalg.inv(W)
            except np.linalg.LinAlgError:
                self.h = h / 2
                self.nfailed += 1
                continue
            k1 = Wi @ (F0 + h * _D * T)
            F1 = self.fun(t + 0.5 * h, y + 0.5 * h * k1)
            k2 = Wi @ (F1 - M @ k1) + k1
            ynew = y + h * k2
            F2 = self.fun(t + h, ynew)
            k3 = Wi @ (F2 - _E32 * (M @ k2 - F1) - 2.0 * (M @ k1 - F0) + h * _D * T)
            self.nsolve += 3
            err = self.wnorm(h / 6.0 * (k1 - 2.0 * k2 + k3), y, ynew)
            if not _math.isfinite(err):
                err = _math.inf
            if err <= 1.0:
                fac = 5.0 if err == 0 else min(5.0, 0.8 * err ** (-1.0 / 3.0))
                if rejected:
                    fac = min(1.0, fac)
                self.h = direction * min(abs(h) * fac, maxstep)
                self.nsteps += 1
                data = (t, h, y.copy(), ynew.copy(), k1.copy(), k2.copy())
                self.t, self.y, self.fy = t + h, ynew, F2
                return t + h, ynew, data
            self.nfailed += 1
            rejected = True
            self.h = h * max(0.1, 0.8 * err ** (-1.0 / 3.0))


def _rescale(D, k, r):
    """the backward differences of order 0..k for a step changed by the factor r (the interpolating polynomial
    re-sampled on the new grid)"""
    def R(order, factor):
        I = np.arange(1, order + 1)[:, None]
        J = np.arange(1, order + 1)[None, :]
        Mx = np.zeros((order + 1, order + 1))
        Mx[1:, 1:] = (I - 1 - factor * J) / I
        Mx[0] = 1.0
        return np.cumprod(Mx, axis=0)
    RU = R(k, r) @ R(k, 1.0)
    D[:, :k + 1] = D[:, :k + 1] @ RU


class _NDF:
    """ode15s's steps: the numerical differentiation formulas of orders 1 to maxorder in backward differences"""

    def __init__(self, fun, jac, M, wnorm, maxorder, bdf, n):
        self.fun, self.jac, self.M, self.wnorm = fun, jac, M, wnorm
        self.maxorder = maxorder
        self.kappa = [0.0] * 6 if bdf else _KAPPA
        self.n = n
        self.nsteps = self.nfailed = self.nlu = self.nsolve = 0

    def start(self, t, y, fy, yp, h):
        self.t, self.h, self.k = t, h, 1
        self.D = np.zeros((self.n, self.maxorder + 3))
        self.D[:, 0] = y
        self.D[:, 1] = h * yp
        self.J = self.jac(t, y, fy)
        self.J_fresh = True
        self.LU = None
        self.since_change = 0

    def _factor(self, c):
        self.nlu += 1
        self.LU = (c, np.linalg.inv(self.M - c * self.J))

    def step(self, tf, maxstep, direction):
        t, D, M = self.t, self.D, self.M
        while True:
            k, h = self.k, self.h
            hmax = direction * maxstep
            if abs(h) > maxstep:
                _rescale(D, k, hmax / h)
                self.h = h = hmax
                self.LU = None
            if direction * (t + h - tf) > 0:
                r = (tf - t) / h
                _rescale(D, k, r)
                self.h = h = tf - t
                self.LU = None
            if abs(h) < 16 * _EPS * max(abs(t), 1.0):
                return None
            tn = t + h
            kap = self.kappa[k]
            alpha = (1.0 - kap) * _GAMMA[k]
            c = h / alpha
            ypred = D[:, :k + 1].sum(axis=1)
            psi = (D[:, 1:k + 1] @ np.array(_GAMMA[1:k + 1])) / alpha
            converged = False
            for attempt in range(2):
                if self.LU is None or self.LU[0] != c:
                    try:
                        self._factor(c)
                    except np.linalg.LinAlgError:
                        # (M - c J singular at this step size, e.g. y' = y with c = 1: a smaller step instead)
                        break
                Wi = self.LU[1]
                d = np.zeros(self.n)
                yn = ypred.copy()
                rate_old = None
                dy_norm_old = None
                for it in range(4):
                    F = self.fun(tn, yn)
                    dy = Wi @ (c * F - M @ (psi + d))
                    self.nsolve += 1
                    dy_norm = self.wnorm(dy, yn, yn)
                    rate = dy_norm / dy_norm_old if dy_norm_old else None
                    if rate is not None and (rate >= 1 or rate ** (4 - it) / (1 - rate) * dy_norm > 1e-2):
                        break
                    yn = yn + dy
                    d = d + dy
                    if dy_norm == 0 or (rate is not None and rate / (1 - rate) * dy_norm < 1e-2) or dy_norm < 1e-10:
                        converged = True
                        break
                    dy_norm_old = dy_norm
                if converged:
                    break
                if not self.J_fresh:
                    self.J = self.jac(t, D[:, 0], self.fun(t, D[:, 0]))
                    self.J_fresh = True
                    self.LU = None
                else:
                    break
            if not converged:
                # (the Newton iteration failed or its matrix was singular: the step halved)
                self.nfailed += 1
                _rescale(D, k, 0.5)
                self.h = h * 0.5
                self.LU = None
                continue
            err_const = kap * _GAMMA[k] + 1.0 / (k + 1)
            err = self.wnorm(err_const * d, D[:, 0], yn)
            if not _math.isfinite(err):
                err = _math.inf
            if err > 1.0:
                self.nfailed += 1
                fac = max(0.2, 0.9 * err ** (-1.0 / (k + 1)))
                _rescale(D, k, fac)
                self.h = h * fac
                self.LU = None
                self.since_change = 0
                continue
            break
        # (accepted: the differences updated with d, the k+2'th first)
        self.nsteps += 1
        ystart = D[:, 0].copy()
        D[:, k + 2] = d - D[:, k + 1]
        D[:, k + 1] = d
        for i in range(k, -1, -1):
            D[:, i] += D[:, i + 1]
        data = (t, h, ystart, yn.copy(), D[:, :k + 1].copy(), k)
        self.t = tn
        self.J_fresh = False
        self.since_change += 1
        # (order and step selection after k + 1 steps at this order: the errors estimated at k - 1, k and k + 1)
        if self.since_change >= k + 1:
            ek = err
            em = self.wnorm((self.kappa[k - 1] * _GAMMA[k - 1] + 1.0 / k) * D[:, k], yn, yn) if k > 1 else _math.inf
            ep = self.wnorm((self.kappa[k + 1] * _GAMMA[k + 1] + 1.0 / (k + 2)) * D[:, k + 2], yn, yn) \
                if k < self.maxorder else _math.inf
            facs = []
            for order, e in ((k - 1, em), (k, ek), (k + 1, ep)):
                facs.append((0.0 if not _math.isfinite(e) else (10.0 if e == 0 else (1.0 / e) ** (1.0 / (order + 1))),
                             order))
            best, order = max(facs)
            fac = min(10.0, 0.9 * best) if best > 0 else 1.0
            if fac > 1.2 or fac < 1.0:
                self.k = order
                _rescale(D, order, fac)
                self.h = h * fac
                self.LU = None
                self.since_change = 0
        return tn, yn, data


@_bi("ode15s")
def ode15s_(nargout, *args):
    """[t, y] = ode15s(odefun, tspan, y0, options), [t, y, te, ye, ie] with Events, sol = ode15s(...) for deval:
    a stiff system of ordinary differential equations (or, with a constant singular Mass matrix, an index-1
    differential-algebraic system) by the variable-order numerical differentiation formulas of Shampine and
    Reichelt (BDF 'on' for the backward differentiation formulas, MaxOrder up to 5). Options: RelTol, AbsTol,
    InitialStep, MaxStep, Refine (1 by default), Stats, Events, Jacobian (a matrix or a function of t and y), Mass
    (a constant matrix), MaxOrder and BDF."""
    return _solve("ode15s", nargout, list(args))


@_bi("ode23s")
def ode23s_(nargout, *args):
    """[t, y] = ode23s(odefun, tspan, y0, options), with Events and sol as ode15s: a stiff system by the modified
    Rosenbrock triple of Shampine and Reichelt (second order, with a third-order error estimate and its
    continuous extension). Options as ode15s's but MaxOrder and BDF."""
    return _solve("ode23s", nargout, list(args))
