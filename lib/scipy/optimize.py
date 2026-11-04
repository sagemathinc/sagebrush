"""scipy.optimize for Sagebrush: minimize (BFGS, CG, Nelder-Mead), minimize_scalar
(Brent, bounded, golden), the line searches they use, approx_fprime and the
Rosenbrock test functions.  (Under CPython, use SciPy itself.)

The algorithms are SciPy 1.18's scipy/optimize (BSD 3-Clause, see NOTICE.md),
followed line for line so that iterates, nfev, njev and nit are SciPy's:
_optimize.py, _linesearch.py, _dcsrch.py, _differentiable_functions.py's
ScalarFunction, _numdiff.py's dense differences and _minimize.py's minimize
and minimize_scalar.  What is not ported (other methods, bounds and
constraints, sparse differences) raises NotImplementedError, never a
plausible answer.
"""
import functools
import warnings
from warnings import warn
from math import sqrt
from collections import namedtuple
import numpy as np
from numpy import asarray
from numpy.linalg import LinAlgError, cholesky

__all__ = ["minimize", "minimize_scalar", "OptimizeResult", "OptimizeWarning", "approx_fprime", "line_search",
           "brent", "golden", "bracket", "fminbound", "fmin", "fmin_bfgs", "fmin_cg", "rosen", "rosen_der",
           "rosen_hess", "rosen_hess_prod", "BracketError", "LineSearchWarning"]


def _unsupported(what):
    raise NotImplementedError("scipy.optimize: %s is not in Sagebrush's scipy subset" % what)


class HessianUpdateStrategy:
    pass


class _Signature:
    def __init__(self, parameters):
        self.parameters = parameters


def wrapped_inspect_signature(callback):
    # (no inspect module here: a callback's parameter names from its code, as inspect.signature has them, a bound
    # method's or a callable object's self left out; only _wrap_callback asks, for the intermediate_result form)
    skip = 0
    f = callback
    if hasattr(f, "__func__"):
        f, skip = f.__func__, 1
    elif not hasattr(f, "__code__") and hasattr(getattr(type(f), "__call__", None), "__code__"):
        f, skip = type(f).__call__, 1
    c = getattr(f, "__code__", None)
    if c is None:
        return _Signature({})
    n = c.co_argcount + c.co_kwonlyargcount
    names = list(c.co_varnames[skip:n])
    if c.co_flags & 4:
        names.append(c.co_varnames[n])
        n += 1
    if c.co_flags & 8:
        names.append(c.co_varnames[n])
    return _Signature(dict.fromkeys(names))


def issymmetric(a):
    return np.array_equal(a, np.transpose(a))


def _check_positive_definite(Hk):
    def is_pos_def(A):
        if issymmetric(A):
            try:
                cholesky(A)
                return True
            except LinAlgError:
                return False
        else:
            return False
    if Hk is not None:
        if not is_pos_def(Hk):
            raise ValueError("'hess_inv0' matrix isn't positive definite.")


class LinearOperator:
    pass


class sps:
    # (no scipy.sparse here: a Hessian is never a sparse array)
    @staticmethod
    def issparse(a):
        return False


def rosen(x):
    x = np.asarray(x)
    r = np.sum(100.0 * (x[1:] - x[:-1] ** 2.0) ** 2.0 + (1 - x[:-1]) ** 2.0, axis=0)
    return r


def rosen_der(x):
    x = np.asarray(x)
    xm = x[1:-1]
    xm_m1 = x[:-2]
    xm_p1 = x[2:]
    der = np.zeros_like(x)
    der[1:-1] = (200 * (xm - xm_m1 ** 2) - 400 * (xm_p1 - xm ** 2) * xm - 2 * (1 - xm))
    der[0] = -400 * x[0] * (x[1] - x[0] ** 2) - 2 * (1 - x[0])
    der[-1] = 200 * (x[-1] - x[-2] ** 2)
    return der


def rosen_hess(x):
    x = np.atleast_1d(x)
    H = np.diag(-400 * x[:-1], 1) - np.diag(400 * x[:-1], -1)
    diagonal = np.zeros(len(x), dtype=x.dtype)
    diagonal[0] = 1200 * x[0] ** 2 - 400 * x[1] + 2
    diagonal[-1] = 200
    diagonal[1:-1] = 202 + 1200 * x[1:-1] ** 2 - 400 * x[2:]
    H = H + np.diag(diagonal)
    return H


def rosen_hess_prod(x, p):
    x = np.atleast_1d(x)
    Hp = np.zeros(len(x), dtype=x.dtype)
    Hp[0] = (1200 * x[0] ** 2 - 400 * x[1] + 2) * p[0] - 400 * x[0] * p[1]
    Hp[1:-1] = (-400 * x[:-2] * p[:-2] + (202 + 1200 * x[1:-1] ** 2 - 400 * x[2:]) * p[1:-1] - 400 * x[1:-1] * p[2:])
    Hp[-1] = -400 * x[-2] * p[-2] + 200 * p[-1]
    return Hp


def approx_derivative(fun, x0, method='3-point', rel_step=None, abs_step=None, f0=None, bounds=(-np.inf, np.inf),
                      sparsity=None, as_linear_operator=False, args=(), kwargs=None, full_output=False, workers=None):
    if method not in ['2-point', '3-point', 'cs']:
        raise ValueError(f"Unknown method '{method}'. ")
    if sparsity is not None:
        _unsupported("approx_derivative's sparsity")
    if as_linear_operator:
        _unsupported("approx_derivative's as_linear_operator")
    info_dict = {'nfev': None}
    _x = np.atleast_1d(np.asarray(x0))
    _dtype = np.float64
    if np.issubdtype(_x.dtype, np.floating):
        _dtype = _x.dtype
    x0 = _x.astype(_dtype)
    if x0.ndim > 1:
        raise ValueError('`x0` must have at most 1 dimension.')
    lb, ub = _prepare_bounds(bounds, x0)
    if lb.shape != x0.shape or ub.shape != x0.shape:
        raise ValueError('Inconsistent shapes between bounds and `x0`.')
    if kwargs is None:
        kwargs = {}
    fun_wrapped = _Fun_Wrapper(fun, x0, args, kwargs)
    nfev = _nfev = 0
    if f0 is None:
        f0 = fun_wrapped(x0)
        nfev = 1
    else:
        f0 = np.atleast_1d(f0)
        if f0.ndim > 1:
            raise ValueError('`f0` passed has more than 1 dimension.')
    if np.any((x0 < lb) | (x0 > ub)):
        raise ValueError('`x0` violates bound constraints.')
    if abs_step is None:
        h = _compute_absolute_step(rel_step, x0, f0, method)
    else:
        sign_x0 = (x0 >= 0).astype(x0.dtype) * 2 - 1
        h = abs_step
        dx = x0 + h - x0
        h = np.where(dx == 0, _eps_for_method(x0.dtype, f0.dtype, method) * sign_x0 * np.maximum(1.0, np.abs(x0)), h)
        h = h.astype(x0.dtype)
    if method == '2-point':
        h, use_one_sided = _adjust_scheme_to_bounds(x0, h, 1, '1-sided', lb, ub)
    elif method == '3-point':
        h, use_one_sided = _adjust_scheme_to_bounds(x0, h, 1, '2-sided', lb, ub)
    elif method == 'cs':
        use_one_sided = False
    J, _nfev = _dense_difference(fun_wrapped, x0, f0, h, use_one_sided, method, workers or map)
    if full_output:
        nfev += _nfev
        info_dict['nfev'] = nfev
        return (J, info_dict)
    else:
        return J


class _RichResult(dict):

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as e:
            raise AttributeError(name) from e
    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__

    def __repr__(self):
        order_keys = ['message', 'success', 'status', 'fun', 'funl', 'x', 'xl', 'col_ind', 'nit', 'lower', 'upper', 'eqlin', 'ineqlin', 'converged', 'flag', 'function_calls', 'iterations', 'root']
        order_keys = getattr(self, '_order_keys', order_keys)
        omit_keys = {'slack', 'con', 'crossover_nit', '_order_keys'}

        def key(item):
            try:
                return order_keys.index(item[0].lower())
            except ValueError:
                return np.inf

        def omit_redundant(items):
            for item in items:
                if item[0] in omit_keys:
                    continue
                yield item

        def item_sorter(d):
            return sorted(omit_redundant(d.items()), key=key)
        if self.keys():
            return _dict_formatter(self, sorter=item_sorter)
        else:
            return self.__class__.__name__ + '()'

    def __dir__(self):
        return list(self.keys())




def _indenter(s, n=0):
    split = s.split('\n')
    indent = ' ' * n
    return ('\n' + indent).join(split)




def _float_formatter_10(x):
    if np.isposinf(x):
        return '       inf'
    elif np.isneginf(x):
        return '      -inf'
    elif np.isnan(x):
        return '       nan'
    return np.format_float_scientific(x, precision=3, pad_left=2, unique=False)




def _dict_formatter(d, n=0, mplus=1, sorter=None):
    if isinstance(d, dict):
        m = max(map(len, list(d.keys()))) + mplus
        s = '\n'.join([k.rjust(m) + ': ' + _indenter(_dict_formatter(v, m + n + 2, 0, sorter), m + 2) for k, v in sorter(d)])
    else:
        with np.printoptions(linewidth=76 - n, edgeitems=2, threshold=12, formatter={'float_kind': _float_formatter_10}):
            s = str(d)
    return s




def _call_callback_maybe_halt(callback, res):
    if callback is None:
        return False
    try:
        callback(res)
        return False
    except StopIteration:
        callback.stop_iteration = True
        return True




class _ScalarFunctionWrapper:

    def __init__(self, f, args=None):
        self.f = f
        self.args = [] if args is None else args
        self.nfev = 0

    def __call__(self, x):
        fx = self.f(np.copy(x), *self.args)
        self.nfev += 1
        if not np.isscalar(fx):
            _dt = getattr(fx, 'dtype', np.dtype(np.float64))
            try:
                fx = _dt.type(np.asarray(fx).item())
            except (TypeError, ValueError) as e:
                raise ValueError('The user-provided objective function must return a scalar value.') from e
        return fx




class MemoizeJac:

    def __init__(self, fun):
        self.fun = fun
        self.jac = None
        self._value = None
        self.x = None

    def _compute_if_needed(self, x, *args):
        if not np.all(x == self.x) or self._value is None or self.jac is None:
            self.x = np.asarray(x).copy()
            fg = self.fun(x, *args)
            self.jac = fg[1]
            self._value = fg[0]

    def __call__(self, x, *args):
        self._compute_if_needed(x, *args)
        return self._value

    def derivative(self, x, *args):
        self._compute_if_needed(x, *args)
        return self.jac




_epsilon = sqrt(np.finfo(float).eps)




_status_message = {'success': 'Optimization terminated successfully.', 'maxfev': 'Maximum number of function evaluations has been exceeded.', 'maxiter': 'Maximum number of iterations has been exceeded.', 'pr_loss': 'Desired error not necessarily achieved due to precision loss.', 'nan': 'NaN result encountered.', 'out_of_bounds': 'The result is outside of the provided bounds.'}




class OptimizeResult(_RichResult):
    pass




class OptimizeWarning(UserWarning):
    pass




def _check_unknown_options(unknown_options):
    if unknown_options:
        msg = ', '.join(map(str, unknown_options.keys()))
        warnings.warn(f'Unknown solver options: {msg}', OptimizeWarning, stacklevel=4)




def is_finite_scalar(x):
    return np.size(x) == 1 and np.isfinite(x)




def vecnorm(x, ord=2):
    if ord == np.inf:
        return np.amax(np.abs(x))
    elif ord == -np.inf:
        return np.amin(np.abs(x))
    else:
        return np.sum(np.abs(x) ** ord, axis=0) ** (1.0 / ord)




def _prepare_scalar_function(fun, x0, jac=None, args=(), bounds=None, epsilon=None, finite_diff_rel_step=None, hess=None, workers=None):
    if callable(jac):
        grad = jac
    elif jac in FD_METHODS:
        epsilon = None
        grad = jac
    else:
        grad = '2-point'
        epsilon = epsilon
    if hess is None:

        def hess(x, *args):
            return None
    if bounds is None:
        bounds = (-np.inf, np.inf)
    workers = workers or map
    sf = ScalarFunction(fun, x0, args, grad, hess, finite_diff_rel_step, bounds, epsilon=epsilon, workers=workers)
    return sf




def _wrap_scalar_function(function, args):
    ncalls = [0]
    if function is None:
        return (ncalls, None)

    def function_wrapper(x, *wrapper_args):
        ncalls[0] += 1
        fx = function(np.copy(x), *wrapper_args + args)
        if not np.isscalar(fx):
            _dt = getattr(fx, 'dtype', np.float64)
            try:
                fx = _dt.type(np.asarray(fx).item())
            except (TypeError, ValueError) as e:
                raise ValueError('The user-provided objective function must return a scalar value.') from e
        return fx
    return (ncalls, function_wrapper)




class _MaxFuncCallError(RuntimeError):
    pass




def _wrap_scalar_function_maxfun_validation(function, args, maxfun):
    ncalls = [0]
    if function is None:
        return (ncalls, None)

    def function_wrapper(x, *wrapper_args):
        if ncalls[0] >= maxfun:
            raise _MaxFuncCallError('Too many function calls')
        ncalls[0] += 1
        fx = function(np.copy(x), *wrapper_args + args)
        if not np.isscalar(fx):
            _dt = getattr(fx, 'dtype', np.dtype(np.float64))
            try:
                fx = _dt.type(np.asarray(fx).item())
            except (TypeError, ValueError) as e:
                raise ValueError('The user-provided objective function must return a scalar value.') from e
        return fx
    return (ncalls, function_wrapper)




def _minimize_neldermead(func, x0, args=(), callback=None, maxiter=None, maxfev=None, disp=False, return_all=False, initial_simplex=None, xatol=0.0001, fatol=0.0001, adaptive=False, bounds=None, **unknown_options):
    _check_unknown_options(unknown_options)
    maxfun = maxfev
    retall = return_all
    x0 = np.atleast_1d(x0).flatten()
    dtype = x0.dtype if np.issubdtype(x0.dtype, np.inexact) else np.float64
    x0 = np.asarray(x0, dtype=dtype)
    if adaptive:
        dim = float(len(x0))
        rho = 1
        chi = 1 + 2 / dim
        psi = 0.75 - 1 / (2 * dim)
        sigma = 1 - 1 / dim
    else:
        rho = 1
        chi = 2
        psi = 0.5
        sigma = 0.5
    nonzdelt = 0.05
    zdelt = 0.00025
    if bounds is not None:
        lower_bound, upper_bound = (bounds.lb, bounds.ub)
        if (lower_bound > upper_bound).any():
            raise ValueError('Nelder Mead - one of the lower bounds is greater than an upper bound.')
        if np.any(lower_bound > x0) or np.any(x0 > upper_bound):
            warnings.warn('Initial guess is not within the specified bounds', OptimizeWarning, stacklevel=3)
    if bounds is not None:
        x0 = np.clip(x0, lower_bound, upper_bound)
    if initial_simplex is None:
        N = len(x0)
        sim = np.empty((N + 1, N), dtype=x0.dtype)
        sim[0] = x0
        for k in range(N):
            y = np.array(x0, copy=True)
            if y[k] != 0:
                y[k] = (1 + nonzdelt) * y[k]
            else:
                y[k] = zdelt
            sim[k + 1] = y
    else:
        sim = np.atleast_2d(initial_simplex).copy()
        dtype = sim.dtype if np.issubdtype(sim.dtype, np.inexact) else np.float64
        sim = np.asarray(sim, dtype=dtype)
        if sim.ndim != 2 or sim.shape[0] != sim.shape[1] + 1:
            raise ValueError('`initial_simplex` should be an array of shape (N+1,N)')
        if len(x0) != sim.shape[1]:
            raise ValueError('Size of `initial_simplex` is not consistent with `x0`')
        N = sim.shape[1]
    if retall:
        allvecs = [sim[0]]
    if maxiter is None and maxfun is None:
        maxiter = N * 200
        maxfun = N * 200
    elif maxiter is None:
        if maxfun == np.inf:
            maxiter = N * 200
        else:
            maxiter = np.inf
    elif maxfun is None:
        if maxiter == np.inf:
            maxfun = N * 200
        else:
            maxfun = np.inf
    if bounds is not None:
        msk = sim > upper_bound
        sim = np.where(msk, 2 * upper_bound - sim, sim)
        sim = np.clip(sim, lower_bound, upper_bound)
    one2np1 = list(range(1, N + 1))
    fsim = np.full((N + 1,), np.inf, dtype=float)
    fcalls, func = _wrap_scalar_function_maxfun_validation(func, args, maxfun)
    try:
        for k in range(N + 1):
            fsim[k] = func(sim[k])
    except _MaxFuncCallError:
        pass
    finally:
        ind = np.argsort(fsim)
        sim = np.take(sim, ind, 0)
        fsim = np.take(fsim, ind, 0)
    ind = np.argsort(fsim)
    fsim = np.take(fsim, ind, 0)
    sim = np.take(sim, ind, 0)
    iterations = 1
    while fcalls[0] < maxfun and iterations < maxiter:
        try:
            if np.max(np.ravel(np.abs(sim[1:] - sim[0]))) <= xatol and np.max(np.abs(fsim[0] - fsim[1:])) <= fatol:
                break
            xbar = np.add.reduce(sim[:-1], 0) / N
            xr = (1 + rho) * xbar - rho * sim[-1]
            if bounds is not None:
                xr = np.clip(xr, lower_bound, upper_bound)
            fxr = func(xr)
            doshrink = 0
            if fxr < fsim[0]:
                xe = (1 + rho * chi) * xbar - rho * chi * sim[-1]
                if bounds is not None:
                    xe = np.clip(xe, lower_bound, upper_bound)
                fxe = func(xe)
                if fxe < fxr:
                    sim[-1] = xe
                    fsim[-1] = fxe
                else:
                    sim[-1] = xr
                    fsim[-1] = fxr
            elif fxr < fsim[-2]:
                sim[-1] = xr
                fsim[-1] = fxr
            else:
                if fxr < fsim[-1]:
                    xc = (1 + psi * rho) * xbar - psi * rho * sim[-1]
                    if bounds is not None:
                        xc = np.clip(xc, lower_bound, upper_bound)
                    fxc = func(xc)
                    if fxc <= fxr:
                        sim[-1] = xc
                        fsim[-1] = fxc
                    else:
                        doshrink = 1
                else:
                    xcc = (1 - psi) * xbar + psi * sim[-1]
                    if bounds is not None:
                        xcc = np.clip(xcc, lower_bound, upper_bound)
                    fxcc = func(xcc)
                    if fxcc < fsim[-1]:
                        sim[-1] = xcc
                        fsim[-1] = fxcc
                    else:
                        doshrink = 1
                if doshrink:
                    for j in one2np1:
                        sim[j] = sim[0] + sigma * (sim[j] - sim[0])
                        if bounds is not None:
                            sim[j] = np.clip(sim[j], lower_bound, upper_bound)
                        fsim[j] = func(sim[j])
            iterations += 1
        except _MaxFuncCallError:
            pass
        ind = np.argsort(fsim)
        sim = np.take(sim, ind, 0)
        fsim = np.take(fsim, ind, 0)
        if retall:
            allvecs.append(sim[0])
        intermediate_result = OptimizeResult(x=sim[0], fun=fsim[0])
        if _call_callback_maybe_halt(callback, intermediate_result):
            break
    x = sim[0]
    fval = np.min(fsim)
    warnflag = 0
    if fcalls[0] >= maxfun:
        warnflag = 1
        msg = _status_message['maxfev']
        if disp:
            warnings.warn(msg, RuntimeWarning, stacklevel=3)
    elif iterations >= maxiter:
        warnflag = 2
        msg = _status_message['maxiter']
        if disp:
            warnings.warn(msg, RuntimeWarning, stacklevel=3)
    else:
        msg = _status_message['success']
        if disp:
            print(msg)
            print(f'         Current function value: {fval:f}')
            print(f'         Iterations: {iterations:d}')
            print(f'         Function evaluations: {fcalls[0]:d}')
    result = OptimizeResult(fun=fval, nit=iterations, nfev=fcalls[0], status=warnflag, success=warnflag == 0, message=msg, x=x, final_simplex=(sim, fsim))
    if retall:
        result['allvecs'] = allvecs
    return result




def approx_fprime(xk, f, epsilon=_epsilon, *args):
    xk = np.asarray(xk, float)
    f0 = f(xk, *args)
    return approx_derivative(f, xk, method='2-point', abs_step=epsilon, args=args, f0=f0)




class _LineSearchError(RuntimeError):
    pass




def _line_search_wolfe12(f, fprime, xk, pk, gfk, old_fval, old_old_fval, **kwargs):
    extra_condition = kwargs.pop('extra_condition', None)
    ret = line_search_wolfe1(f, fprime, xk, pk, gfk, old_fval, old_old_fval, **kwargs)
    if ret[0] is not None and extra_condition is not None:
        xp1 = xk + ret[0] * pk
        if not extra_condition(ret[0], xp1, ret[3], ret[5]):
            ret = (None,)
    if ret[0] is None:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', LineSearchWarning)
            kwargs2 = {}
            for key in ('c1', 'c2', 'amax'):
                if key in kwargs:
                    kwargs2[key] = kwargs[key]
            ret = line_search_wolfe2(f, fprime, xk, pk, gfk, old_fval, old_old_fval, extra_condition=extra_condition, **kwargs2)
    if ret[0] is None:
        raise _LineSearchError()
    return ret




def _minimize_bfgs(fun, x0, args=(), jac=None, callback=None, gtol=1e-05, norm=np.inf, eps=_epsilon, maxiter=None, disp=False, return_all=False, finite_diff_rel_step=None, xrtol=0, c1=0.0001, c2=0.9, hess_inv0=None, workers=None, **unknown_options):
    _check_unknown_options(unknown_options)
    _check_positive_definite(hess_inv0)
    retall = return_all
    x0 = asarray(x0).flatten()
    if x0.ndim == 0:
        x0 = x0.reshape((1,))
    if maxiter is None:
        maxiter = len(x0) * 200
    sf = _prepare_scalar_function(fun, x0, jac, args=args, epsilon=eps, finite_diff_rel_step=finite_diff_rel_step, workers=workers)
    f = sf.fun
    myfprime = sf.grad
    old_fval = f(x0)
    gfk = myfprime(x0)
    k = 0
    N = len(x0)
    I = np.eye(N, dtype=int)
    Hk = I if hess_inv0 is None else hess_inv0
    old_old_fval = old_fval + np.linalg.norm(gfk) / 2
    xk = x0
    if retall:
        allvecs = [x0]
    warnflag = 0
    gnorm = vecnorm(gfk, ord=norm)
    while gnorm > gtol and k < maxiter:
        pk = -np.dot(Hk, gfk)
        try:
            alpha_k, fc, gc, old_fval, old_old_fval, gfkp1 = _line_search_wolfe12(f, myfprime, xk, pk, gfk, old_fval, old_old_fval, amin=1e-100, amax=1e+100, c1=c1, c2=c2)
        except _LineSearchError:
            warnflag = 2
            break
        sk = alpha_k * pk
        xkp1 = xk + sk
        if retall:
            allvecs.append(xkp1)
        xk = xkp1
        if gfkp1 is None:
            gfkp1 = myfprime(xkp1)
        yk = gfkp1 - gfk
        gfk = gfkp1
        k += 1
        intermediate_result = OptimizeResult(x=xk, fun=old_fval)
        if _call_callback_maybe_halt(callback, intermediate_result):
            break
        gnorm = vecnorm(gfk, ord=norm)
        if gnorm <= gtol:
            break
        if alpha_k * vecnorm(pk) <= xrtol * (xrtol + vecnorm(xk)):
            break
        if not np.isfinite(old_fval):
            warnflag = 2
            break
        rhok_inv = np.dot(yk, sk)
        if rhok_inv == 0.0:
            rhok = 1000.0
            if disp:
                msg = 'Divide-by-zero encountered: rhok assumed large'
                _print_success_message_or_warn(True, msg)
        else:
            rhok = 1.0 / rhok_inv
        A1 = I - sk[:, np.newaxis] * yk[np.newaxis, :] * rhok
        A2 = I - yk[:, np.newaxis] * sk[np.newaxis, :] * rhok
        Hk = np.dot(A1, np.dot(Hk, A2)) + rhok * sk[:, np.newaxis] * sk[np.newaxis, :]
    fval = old_fval
    if warnflag == 2:
        msg = _status_message['pr_loss']
    elif k >= maxiter:
        warnflag = 1
        msg = _status_message['maxiter']
    elif np.isnan(gnorm) or np.isnan(fval) or np.isnan(xk).any():
        warnflag = 3
        msg = _status_message['nan']
    else:
        msg = _status_message['success']
    if disp:
        _print_success_message_or_warn(warnflag, msg)
        print(f'         Current function value: {fval:f}')
        print(f'         Iterations: {k:d}')
        print(f'         Function evaluations: {sf.nfev:d}')
        print(f'         Gradient evaluations: {sf.ngev:d}')
    result = OptimizeResult(fun=fval, jac=gfk, hess_inv=Hk, nfev=sf.nfev, njev=sf.ngev, status=warnflag, success=warnflag == 0, message=msg, x=xk, nit=k)
    if retall:
        result['allvecs'] = allvecs
    return result




def _print_success_message_or_warn(warnflag, message, warntype=None):
    if not warnflag:
        print(message)
    else:
        warnings.warn(message, warntype or OptimizeWarning, stacklevel=3)




def _minimize_cg(fun, x0, args=(), jac=None, callback=None, gtol=1e-05, norm=np.inf, eps=_epsilon, maxiter=None, disp=False, return_all=False, finite_diff_rel_step=None, c1=0.0001, c2=0.4, workers=None, **unknown_options):
    _check_unknown_options(unknown_options)
    retall = return_all
    x0 = asarray(x0).flatten()
    if maxiter is None:
        maxiter = len(x0) * 200
    sf = _prepare_scalar_function(fun, x0, jac=jac, args=args, epsilon=eps, finite_diff_rel_step=finite_diff_rel_step, workers=workers)
    f = sf.fun
    myfprime = sf.grad
    old_fval = f(x0)
    gfk = myfprime(x0)
    k = 0
    xk = x0
    old_old_fval = old_fval + np.linalg.norm(gfk) / 2
    if retall:
        allvecs = [xk]
    warnflag = 0
    pk = -gfk
    gnorm = vecnorm(gfk, ord=norm)
    sigma_3 = 0.01
    while gnorm > gtol and k < maxiter:
        deltak = np.dot(gfk, gfk)
        cached_step = [None]

        def polak_ribiere_powell_step(alpha, gfkp1=None):
            xkp1 = xk + alpha * pk
            if gfkp1 is None:
                gfkp1 = myfprime(xkp1)
            yk = gfkp1 - gfk
            beta_k = max(0, np.dot(yk, gfkp1) / deltak)
            pkp1 = -gfkp1 + beta_k * pk
            gnorm = vecnorm(gfkp1, ord=norm)
            return (alpha, xkp1, pkp1, gfkp1, gnorm)

        def descent_condition(alpha, xkp1, fp1, gfkp1):
            cached_step[:] = polak_ribiere_powell_step(alpha, gfkp1)
            alpha, xk, pk, gfk, gnorm = cached_step
            if gnorm <= gtol:
                return True
            return np.dot(pk, gfk) <= -sigma_3 * np.dot(gfk, gfk)
        try:
            alpha_k, fc, gc, old_fval, old_old_fval, gfkp1 = _line_search_wolfe12(f, myfprime, xk, pk, gfk, old_fval, old_old_fval, c1=c1, c2=c2, amin=1e-100, amax=1e+100, extra_condition=descent_condition)
        except _LineSearchError:
            warnflag = 2
            break
        if alpha_k == cached_step[0]:
            alpha_k, xk, pk, gfk, gnorm = cached_step
        else:
            alpha_k, xk, pk, gfk, gnorm = polak_ribiere_powell_step(alpha_k, gfkp1)
        if retall:
            allvecs.append(xk)
        k += 1
        intermediate_result = OptimizeResult(x=xk, fun=old_fval)
        if _call_callback_maybe_halt(callback, intermediate_result):
            break
    fval = old_fval
    if warnflag == 2:
        msg = _status_message['pr_loss']
    elif k >= maxiter:
        warnflag = 1
        msg = _status_message['maxiter']
    elif np.isnan(gnorm) or np.isnan(fval) or np.isnan(xk).any():
        warnflag = 3
        msg = _status_message['nan']
    else:
        msg = _status_message['success']
    if disp:
        _print_success_message_or_warn(warnflag, msg)
        print(f'         Current function value: {fval:f}')
        print(f'         Iterations: {k:d}')
        print(f'         Function evaluations: {sf.nfev:d}')
        print(f'         Gradient evaluations: {sf.ngev:d}')
    result = OptimizeResult(fun=fval, jac=gfk, nfev=sf.nfev, njev=sf.ngev, status=warnflag, success=warnflag == 0, message=msg, x=xk, nit=k)
    if retall:
        result['allvecs'] = allvecs
    return result




def _minimize_scalar_bounded(func, bounds, args=(), xatol=1e-05, maxiter=500, disp=0, **unknown_options):
    _check_unknown_options(unknown_options)
    maxfun = maxiter
    if len(bounds) != 2:
        raise ValueError('bounds must have two elements.')
    x1, x2 = bounds
    if not (is_finite_scalar(x1) and is_finite_scalar(x2)):
        raise ValueError('Optimization bounds must be finite scalars.')
    if x1 > x2:
        raise ValueError('The lower bound exceeds the upper bound.')
    flag = 0
    header = ' Func-count     x          f(x)          Procedure'
    step = '       initial'
    sqrt_eps = sqrt(2.2e-16)
    golden_mean = 0.5 * (3.0 - sqrt(5.0))
    a, b = (x1, x2)
    fulc = a + golden_mean * (b - a)
    nfc, xf = (fulc, fulc)
    rat = e = 0.0
    x = xf
    fx = func(x, *args)
    num = 1
    fmin_data = (1, xf, fx)
    fu = np.inf
    ffulc = fnfc = fx
    xm = 0.5 * (a + b)
    tol1 = sqrt_eps * np.abs(xf) + xatol / 3.0
    tol2 = 2.0 * tol1
    if disp > 2:
        print(' ')
        print(header)
        print('%5.0f   %12.6g %12.6g %s' % (fmin_data + (step,)))
    while np.abs(xf - xm) > tol2 - 0.5 * (b - a):
        golden = 1
        if np.abs(e) > tol1:
            golden = 0
            r = (xf - nfc) * (fx - ffulc)
            q = (xf - fulc) * (fx - fnfc)
            p = (xf - fulc) * q - (xf - nfc) * r
            q = 2.0 * (q - r)
            if q > 0.0:
                p = -p
            q = np.abs(q)
            r = e
            e = rat
            if np.abs(p) < np.abs(0.5 * q * r) and p > q * (a - xf) and (p < q * (b - xf)):
                rat = (p + 0.0) / q
                x = xf + rat
                step = '       parabolic'
                if x - a < tol2 or b - x < tol2:
                    si = np.sign(xm - xf) + (xm - xf == 0)
                    rat = tol1 * si
            else:
                golden = 1
        if golden:
            if xf >= xm:
                e = a - xf
            else:
                e = b - xf
            rat = golden_mean * e
            step = '       golden'
        si = np.sign(rat) + (rat == 0)
        x = xf + si * np.maximum(np.abs(rat), tol1)
        fu = func(x, *args)
        num += 1
        fmin_data = (num, x, fu)
        if disp > 2:
            print('%5.0f   %12.6g %12.6g %s' % (fmin_data + (step,)))
        if fu <= fx:
            if x >= xf:
                a = xf
            else:
                b = xf
            fulc, ffulc = (nfc, fnfc)
            nfc, fnfc = (xf, fx)
            xf, fx = (x, fu)
        else:
            if x < xf:
                a = x
            else:
                b = x
            if fu <= fnfc or nfc == xf:
                fulc, ffulc = (nfc, fnfc)
                nfc, fnfc = (x, fu)
            elif fu <= ffulc or fulc == xf or fulc == nfc:
                fulc, ffulc = (x, fu)
        xm = 0.5 * (a + b)
        tol1 = sqrt_eps * np.abs(xf) + xatol / 3.0
        tol2 = 2.0 * tol1
        if num >= maxfun:
            flag = 1
            break
    if np.isnan(xf) or np.isnan(fx) or np.isnan(fu):
        flag = 2
    fval = fx
    if disp > 0:
        _endprint(x, flag, fval, maxfun, xatol, disp)
    result = OptimizeResult(fun=fval, status=flag, success=flag == 0, message={0: 'Solution found.', 1: 'Maximum number of function calls reached.', 2: _status_message['nan']}.get(flag, ''), x=xf, nfev=num, nit=num)
    return result




class Brent:

    def __init__(self, func, args=(), tol=1.48e-08, maxiter=500, full_output=0, disp=0):
        self.func = func
        self.args = args
        self.tol = tol
        self.maxiter = maxiter
        self._mintol = 1e-11
        self._cg = 0.381966
        self.xmin = None
        self.fval = None
        self.iter = 0
        self.funcalls = 0
        self.disp = disp

    def set_bracket(self, brack=None):
        self.brack = brack

    def get_bracket_info(self):
        func = self.func
        args = self.args
        brack = self.brack
        if brack is None:
            xa, xb, xc, fa, fb, fc, funcalls = bracket(func, args=args)
        elif len(brack) == 2:
            xa, xb, xc, fa, fb, fc, funcalls = bracket(func, xa=brack[0], xb=brack[1], args=args)
        elif len(brack) == 3:
            xa, xb, xc = brack
            if xa > xc:
                xc, xa = (xa, xc)
            if not (xa < xb and xb < xc):
                raise ValueError('Bracketing values (xa, xb, xc) do not fulfill this requirement: (xa < xb) and (xb < xc)')
            fa = func(*(xa,) + args)
            fb = func(*(xb,) + args)
            fc = func(*(xc,) + args)
            if not (fb < fa and fb < fc):
                raise ValueError('Bracketing values (xa, xb, xc) do not fulfill this requirement: (f(xb) < f(xa)) and (f(xb) < f(xc))')
            funcalls = 3
        else:
            raise ValueError('Bracketing interval must be length 2 or 3 sequence.')
        return (xa, xb, xc, fa, fb, fc, funcalls)

    def optimize(self):
        func = self.func
        xa, xb, xc, fa, fb, fc, funcalls = self.get_bracket_info()
        _mintol = self._mintol
        _cg = self._cg
        x = w = v = xb
        fw = fv = fx = fb
        if xa < xc:
            a = xa
            b = xc
        else:
            a = xc
            b = xa
        deltax = 0.0
        iter = 0
        if self.disp > 2:
            print(' ')
            print(f"{'Func-count':^12} {'x':^12} {'f(x)': ^12}")
            print(f'{funcalls:^12g} {x:^12.6g} {fx:^12.6g}')
        while iter < self.maxiter:
            tol1 = self.tol * np.abs(x) + _mintol
            tol2 = 2.0 * tol1
            xmid = 0.5 * (a + b)
            if np.abs(x - xmid) < tol2 - 0.5 * (b - a):
                break
            if np.abs(deltax) <= tol1:
                if x >= xmid:
                    deltax = a - x
                else:
                    deltax = b - x
                rat = _cg * deltax
            else:
                tmp1 = (x - w) * (fx - fv)
                tmp2 = (x - v) * (fx - fw)
                p = (x - v) * tmp2 - (x - w) * tmp1
                tmp2 = 2.0 * (tmp2 - tmp1)
                if tmp2 > 0.0:
                    p = -p
                tmp2 = np.abs(tmp2)
                dx_temp = deltax
                deltax = rat
                if p > tmp2 * (a - x) and p < tmp2 * (b - x) and (np.abs(p) < np.abs(0.5 * tmp2 * dx_temp)):
                    rat = p * 1.0 / tmp2
                    u = x + rat
                    if u - a < tol2 or b - u < tol2:
                        if xmid - x >= 0:
                            rat = tol1
                        else:
                            rat = -tol1
                else:
                    if x >= xmid:
                        deltax = a - x
                    else:
                        deltax = b - x
                    rat = _cg * deltax
            if np.abs(rat) < tol1:
                if rat >= 0:
                    u = x + tol1
                else:
                    u = x - tol1
            else:
                u = x + rat
            fu = func(*(u,) + self.args)
            funcalls += 1
            if fu > fx:
                if u < x:
                    a = u
                else:
                    b = u
                if fu <= fw or w == x:
                    v = w
                    w = u
                    fv = fw
                    fw = fu
                elif fu <= fv or v == x or v == w:
                    v = u
                    fv = fu
            else:
                if u >= x:
                    a = x
                else:
                    b = x
                v = w
                w = x
                x = u
                fv = fw
                fw = fx
                fx = fu
            if self.disp > 2:
                print(f'{funcalls:^12g} {x:^12.6g} {fx:^12.6g}')
            iter += 1
        self.xmin = x
        self.fval = fx
        self.iter = iter
        self.funcalls = funcalls

    def get_result(self, full_output=False):
        if full_output:
            return (self.xmin, self.fval, self.iter, self.funcalls)
        else:
            return self.xmin




def brent(func, args=(), brack=None, tol=1.48e-08, full_output=0, maxiter=500):
    options = {'xtol': tol, 'maxiter': maxiter}
    res = _minimize_scalar_brent(func, brack, args, **options)
    if full_output:
        return (res['x'], res['fun'], res['nit'], res['nfev'])
    else:
        return res['x']




def _minimize_scalar_brent(func, brack=None, args=(), xtol=1.48e-08, maxiter=500, disp=0, **unknown_options):
    _check_unknown_options(unknown_options)
    tol = xtol
    if tol < 0:
        raise ValueError(f'tolerance should be >= 0, got {tol!r}')
    brent = Brent(func=func, args=args, tol=tol, full_output=True, maxiter=maxiter, disp=disp)
    brent.set_bracket(brack)
    brent.optimize()
    x, fval, nit, nfev = brent.get_result(full_output=True)
    success = nit < maxiter and (not (np.isnan(x) or np.isnan(fval)))
    if success:
        message = f'\nOptimization terminated successfully;\nThe returned value satisfies the termination criteria\n(using xtol = {xtol} )'
    else:
        if nit >= maxiter:
            message = '\nMaximum number of iterations exceeded'
        if np.isnan(x) or np.isnan(fval):
            message = f"{_status_message['nan']}"
    if disp:
        _print_success_message_or_warn(not success, message)
    return OptimizeResult(fun=fval, x=x, nit=nit, nfev=nfev, success=success, message=message)




def golden(func, args=(), brack=None, tol=_epsilon, full_output=0, maxiter=5000):
    options = {'xtol': tol, 'maxiter': maxiter}
    res = _minimize_scalar_golden(func, brack, args, **options)
    if full_output:
        return (res['x'], res['fun'], res['nfev'])
    else:
        return res['x']




def _minimize_scalar_golden(func, brack=None, args=(), xtol=_epsilon, maxiter=5000, disp=0, **unknown_options):
    _check_unknown_options(unknown_options)
    tol = xtol
    if brack is None:
        xa, xb, xc, fa, fb, fc, funcalls = bracket(func, args=args)
    elif len(brack) == 2:
        xa, xb, xc, fa, fb, fc, funcalls = bracket(func, xa=brack[0], xb=brack[1], args=args)
    elif len(brack) == 3:
        xa, xb, xc = brack
        if xa > xc:
            xc, xa = (xa, xc)
        if not (xa < xb and xb < xc):
            raise ValueError('Bracketing values (xa, xb, xc) do not fulfill this requirement: (xa < xb) and (xb < xc)')
        fa = func(*(xa,) + args)
        fb = func(*(xb,) + args)
        fc = func(*(xc,) + args)
        if not (fb < fa and fb < fc):
            raise ValueError('Bracketing values (xa, xb, xc) do not fulfill this requirement: (f(xb) < f(xa)) and (f(xb) < f(xc))')
        funcalls = 3
    else:
        raise ValueError('Bracketing interval must be length 2 or 3 sequence.')
    _gR = 0.61803399
    _gC = 1.0 - _gR
    x3 = xc
    x0 = xa
    if np.abs(xc - xb) > np.abs(xb - xa):
        x1 = xb
        x2 = xb + _gC * (xc - xb)
    else:
        x2 = xb
        x1 = xb - _gC * (xb - xa)
    f1 = func(*(x1,) + args)
    f2 = func(*(x2,) + args)
    funcalls += 2
    nit = 0
    if disp > 2:
        print(' ')
        print(f"{'Func-count':^12} {'x':^12} {'f(x)': ^12}")
    for i in range(maxiter):
        if np.abs(x3 - x0) <= tol * (np.abs(x1) + np.abs(x2)):
            break
        if f2 < f1:
            x0 = x1
            x1 = x2
            x2 = _gR * x1 + _gC * x3
            f1 = f2
            f2 = func(*(x2,) + args)
        else:
            x3 = x2
            x2 = x1
            x1 = _gR * x2 + _gC * x0
            f2 = f1
            f1 = func(*(x1,) + args)
        funcalls += 1
        if disp > 2:
            if f1 < f2:
                xmin, fval = (x1, f1)
            else:
                xmin, fval = (x2, f2)
            print(f'{funcalls:^12g} {xmin:^12.6g} {fval:^12.6g}')
        nit += 1
    if f1 < f2:
        xmin = x1
        fval = f1
    else:
        xmin = x2
        fval = f2
    success = nit < maxiter and (not (np.isnan(fval) or np.isnan(xmin)))
    if success:
        message = f'\nOptimization terminated successfully;\nThe returned value satisfies the termination criteria\n(using xtol = {xtol} )'
    else:
        if nit >= maxiter:
            message = '\nMaximum number of iterations exceeded'
        if np.isnan(xmin) or np.isnan(fval):
            message = f"{_status_message['nan']}"
    if disp:
        _print_success_message_or_warn(not success, message)
    return OptimizeResult(fun=fval, nfev=funcalls, x=xmin, nit=nit, success=success, message=message)




def bracket(func, xa=0.0, xb=1.0, args=(), grow_limit=110.0, maxiter=1000):
    _gold = 1.618034
    _verysmall_num = 1e-21
    xa, xb = np.asarray([xa, xb])
    fa = func(*(xa,) + args)
    fb = func(*(xb,) + args)
    if fa < fb:
        xa, xb = (xb, xa)
        fa, fb = (fb, fa)
    xc = xb + _gold * (xb - xa)
    fc = func(*(xc,) + args)
    funcalls = 3
    iter = 0
    while fc < fb:
        tmp1 = (xb - xa) * (fb - fc)
        tmp2 = (xb - xc) * (fb - fa)
        val = tmp2 - tmp1
        if np.abs(val) < _verysmall_num:
            denom = 2.0 * _verysmall_num
        else:
            denom = 2.0 * val
        w = xb - ((xb - xc) * tmp2 - (xb - xa) * tmp1) / denom
        wlim = xb + grow_limit * (xc - xb)
        msg = 'No valid bracket was found before the iteration limit was reached. Consider trying different initial points or increasing `maxiter`.'
        if iter > maxiter:
            raise RuntimeError(msg)
        iter += 1
        if (w - xc) * (xb - w) > 0.0:
            fw = func(*(w,) + args)
            funcalls += 1
            if fw < fc:
                xa = xb
                xb = w
                fa = fb
                fb = fw
                break
            elif fw > fb:
                xc = w
                fc = fw
                break
            w = xc + _gold * (xc - xb)
            fw = func(*(w,) + args)
            funcalls += 1
        elif (w - wlim) * (wlim - xc) >= 0.0:
            w = wlim
            fw = func(*(w,) + args)
            funcalls += 1
        elif (w - wlim) * (xc - w) > 0.0:
            fw = func(*(w,) + args)
            funcalls += 1
            if fw < fc:
                xb = xc
                xc = w
                w = xc + _gold * (xc - xb)
                fb = fc
                fc = fw
                fw = func(*(w,) + args)
                funcalls += 1
        else:
            w = xc + _gold * (xc - xb)
            fw = func(*(w,) + args)
            funcalls += 1
        xa = xb
        xb = xc
        xc = w
        fa = fb
        fb = fc
        fc = fw
    cond1 = fb < fc and fb <= fa or (fb < fa and fb <= fc)
    cond2 = xa < xb < xc or xc < xb < xa
    cond3 = np.isfinite(xa) and np.isfinite(xb) and np.isfinite(xc)
    msg = 'The algorithm terminated without finding a valid bracket. Consider trying different initial points.'
    if not (cond1 and cond2 and cond3):
        e = BracketError(msg)
        e.data = (xa, xb, xc, fa, fb, fc, funcalls)
        raise e
    return (xa, xb, xc, fa, fb, fc, funcalls)




class BracketError(RuntimeError):
    pass




def _recover_from_bracket_error(solver, fun, bracket, args, **options):
    try:
        res = solver(fun, bracket, args, **options)
    except BracketError as e:
        msg = str(e)
        xa, xb, xc, fa, fb, fc, funcalls = e.data
        xs, fs = ([xa, xb, xc], [fa, fb, fc])
        if np.any(np.isnan([xs, fs])):
            x, fun = (np.nan, np.nan)
        else:
            imin = np.argmin(fs)
            x, fun = (xs[imin], fs[imin])
        return OptimizeResult(fun=fun, nfev=funcalls, x=x, nit=0, success=False, message=msg)
    return res




def _endprint(x, flag, fval, maxfun, xtol, disp):
    if flag == 0:
        if disp > 1:
            print('\nOptimization terminated successfully;\nThe returned value satisfies the termination criteria\n(using xtol = ', xtol, ')')
        return
    if flag == 1:
        msg = '\nMaximum number of function evaluations exceeded --- increase maxfun argument.\n'
    elif flag == 2:
        msg = f"\n{_status_message['nan']}"
    _print_success_message_or_warn(flag, msg)
    return




def _wrap_callback(callback, method=None):
    if callback is None or method in {'tnc', 'cobyla', 'cobyqa'}:
        return callback
    sig = wrapped_inspect_signature(callback)
    if set(sig.parameters) == {'intermediate_result'}:

        def wrapped_callback(res):
            return callback(intermediate_result=res)
    elif method == 'trust-constr':

        def wrapped_callback(res):
            return callback(np.copy(res.x), res)
    elif method == 'differential_evolution':

        def wrapped_callback(res):
            return callback(np.copy(res.x), res.convergence)
    else:

        def wrapped_callback(res):
            return callback(np.copy(res.x))
    wrapped_callback.stop_iteration = False
    return wrapped_callback




def fminbound(func, x1, x2, args=(), xtol=1e-05, maxfun=500, full_output=0, disp=1):
    options = {'xatol': xtol, 'maxiter': maxfun, 'disp': disp}
    res = _minimize_scalar_bounded(func, (x1, x2), args, **options)
    if full_output:
        return (res['x'], res['fun'], res['status'], res['nfev'])
    else:
        return res['x']




def fmin(func, x0, args=(), xtol=0.0001, ftol=0.0001, maxiter=None, maxfun=None, full_output=0, disp=1, retall=0, callback=None, initial_simplex=None):
    opts = {'xatol': xtol, 'fatol': ftol, 'maxiter': maxiter, 'maxfev': maxfun, 'disp': disp, 'return_all': retall, 'initial_simplex': initial_simplex}
    callback = _wrap_callback(callback)
    res = _minimize_neldermead(func, x0, args, callback=callback, **opts)
    if full_output:
        retlist = (res['x'], res['fun'], res['nit'], res['nfev'], res['status'])
        if retall:
            retlist += (res['allvecs'],)
        return retlist
    elif retall:
        return (res['x'], res['allvecs'])
    else:
        return res['x']




def fmin_bfgs(f, x0, fprime=None, args=(), gtol=1e-05, norm=np.inf, epsilon=_epsilon, maxiter=None, full_output=0, disp=1, retall=0, callback=None, xrtol=0, c1=0.0001, c2=0.9, hess_inv0=None):
    opts = {'gtol': gtol, 'norm': norm, 'eps': epsilon, 'disp': disp, 'maxiter': maxiter, 'return_all': retall, 'xrtol': xrtol, 'c1': c1, 'c2': c2, 'hess_inv0': hess_inv0}
    callback = _wrap_callback(callback)
    res = _minimize_bfgs(f, x0, args, fprime, callback=callback, **opts)
    if full_output:
        retlist = (res['x'], res['fun'], res['jac'], res['hess_inv'], res['nfev'], res['njev'], res['status'])
        if retall:
            retlist += (res['allvecs'],)
        return retlist
    elif retall:
        return (res['x'], res['allvecs'])
    else:
        return res['x']




def fmin_cg(f, x0, fprime=None, args=(), gtol=1e-05, norm=np.inf, epsilon=_epsilon, maxiter=None, full_output=0, disp=1, retall=0, callback=None, c1=0.0001, c2=0.4):
    opts = {'gtol': gtol, 'norm': norm, 'eps': epsilon, 'disp': disp, 'maxiter': maxiter, 'return_all': retall}
    callback = _wrap_callback(callback)
    res = _minimize_cg(f, x0, args, fprime, callback=callback, c1=c1, c2=c2, **opts)
    if full_output:
        retlist = (res['x'], res['fun'], res['nfev'], res['njev'], res['status'])
        if retall:
            retlist += (res['allvecs'],)
        return retlist
    elif retall:
        return (res['x'], res['allvecs'])
    else:
        return res['x']




class LineSearchWarning(RuntimeWarning):
    pass




def _check_c1_c2(c1, c2):
    if not 0 < c1 < c2 < 1:
        raise ValueError("'c1' and 'c2' do not satisfy'0 < c1 < c2 < 1'.")




def line_search_wolfe1(f, fprime, xk, pk, gfk=None, old_fval=None, old_old_fval=None, args=(), c1=0.0001, c2=0.9, amax=50, amin=1e-08, xtol=1e-14):
    if gfk is None:
        gfk = fprime(xk, *args)
    gval = [gfk]
    gc = [0]
    fc = [0]

    def phi(s):
        fc[0] += 1
        return f(xk + s * pk, *args)

    def derphi(s):
        gval[0] = fprime(xk + s * pk, *args)
        gc[0] += 1
        return np.dot(gval[0], pk)
    derphi0 = np.dot(gfk, pk)
    stp, fval, old_fval = scalar_search_wolfe1(phi, derphi, old_fval, old_old_fval, derphi0, c1=c1, c2=c2, amax=amax, amin=amin, xtol=xtol)
    return (stp, fc[0], gc[0], fval, old_fval, gval[0])




def scalar_search_wolfe1(phi, derphi, phi0=None, old_phi0=None, derphi0=None, c1=0.0001, c2=0.9, amax=50, amin=1e-08, xtol=1e-14):
    _check_c1_c2(c1, c2)
    if phi0 is None:
        phi0 = phi(0.0)
    if derphi0 is None:
        derphi0 = derphi(0.0)
    if old_phi0 is not None and derphi0 != 0:
        alpha1 = min(1.0, 1.01 * 2 * (phi0 - old_phi0) / derphi0)
        if alpha1 < 0:
            alpha1 = 1.0
    else:
        alpha1 = 1.0
    maxiter = 100
    dcsrch = DCSRCH(phi, derphi, c1, c2, xtol, amin, amax)
    stp, phi1, phi0, task = dcsrch(alpha1, phi0=phi0, derphi0=derphi0, maxiter=maxiter)
    return (stp, phi1, phi0)




def line_search_wolfe2(f, myfprime, xk, pk, gfk=None, old_fval=None, old_old_fval=None, args=(), c1=0.0001, c2=0.9, amax=None, extra_condition=None, maxiter=10):
    fc = [0]
    gc = [0]
    gval = [None]
    gval_alpha = [None]

    def phi(alpha):
        fc[0] += 1
        return f(xk + alpha * pk, *args)
    fprime = myfprime

    def derphi(alpha):
        gc[0] += 1
        gval[0] = fprime(xk + alpha * pk, *args)
        gval_alpha[0] = alpha
        return np.dot(gval[0], pk)
    if gfk is None:
        gfk = fprime(xk, *args)
    derphi0 = np.dot(gfk, pk)
    if extra_condition is not None:

        def extra_condition2(alpha, phi):
            if gval_alpha[0] != alpha:
                derphi(alpha)
            x = xk + alpha * pk
            return extra_condition(alpha, x, phi, gval[0])
    else:
        extra_condition2 = None
    alpha_star, phi_star, old_fval, derphi_star = scalar_search_wolfe2(phi, derphi, old_fval, old_old_fval, derphi0, c1, c2, amax, extra_condition2, maxiter=maxiter)
    if derphi_star is None:
        warn('The line search algorithm did not converge', LineSearchWarning, stacklevel=2)
    else:
        derphi_star = gval[0]
    return (alpha_star, fc[0], gc[0], phi_star, old_fval, derphi_star)




def scalar_search_wolfe2(phi, derphi, phi0=None, old_phi0=None, derphi0=None, c1=0.0001, c2=0.9, amax=None, extra_condition=None, maxiter=10):
    _check_c1_c2(c1, c2)
    if phi0 is None:
        phi0 = phi(0.0)
    if derphi0 is None:
        derphi0 = derphi(0.0)
    alpha0 = 0
    if old_phi0 is not None and derphi0 != 0:
        alpha1 = min(1.0, 1.01 * 2 * (phi0 - old_phi0) / derphi0)
    else:
        alpha1 = 1.0
    if alpha1 < 0:
        alpha1 = 1.0
    if amax is not None:
        alpha1 = min(alpha1, amax)
    phi_a1 = phi(alpha1)
    phi_a0 = phi0
    derphi_a0 = derphi0
    if extra_condition is None:

        def extra_condition(alpha, phi):
            return True
    for i in range(maxiter):
        if alpha1 == 0 or (amax is not None and alpha0 > amax):
            alpha_star = None
            phi_star = phi0
            phi0 = old_phi0
            derphi_star = None
            if alpha1 == 0:
                msg = 'Rounding errors prevent the line search from converging'
            else:
                msg = 'The line search algorithm could not find a solution ' + f'less than or equal to amax: {amax}'
            warn(msg, LineSearchWarning, stacklevel=2)
            break
        not_first_iteration = i > 0
        if phi_a1 > phi0 + c1 * alpha1 * derphi0 or (phi_a1 >= phi_a0 and not_first_iteration):
            alpha_star, phi_star, derphi_star = _zoom(alpha0, alpha1, phi_a0, phi_a1, derphi_a0, phi, derphi, phi0, derphi0, c1, c2, extra_condition)
            break
        derphi_a1 = derphi(alpha1)
        if abs(derphi_a1) <= -c2 * derphi0:
            if extra_condition(alpha1, phi_a1):
                alpha_star = alpha1
                phi_star = phi_a1
                derphi_star = derphi_a1
                break
        if derphi_a1 >= 0:
            alpha_star, phi_star, derphi_star = _zoom(alpha1, alpha0, phi_a1, phi_a0, derphi_a1, phi, derphi, phi0, derphi0, c1, c2, extra_condition)
            break
        alpha2 = 2 * alpha1
        if amax is not None:
            alpha2 = min(alpha2, amax)
        alpha0 = alpha1
        alpha1 = alpha2
        phi_a0 = phi_a1
        phi_a1 = phi(alpha1)
        derphi_a0 = derphi_a1
    else:
        alpha_star = alpha1
        phi_star = phi_a1
        derphi_star = None
        warn('The line search algorithm did not converge', LineSearchWarning, stacklevel=2)
    return (alpha_star, phi_star, phi0, derphi_star)




def _cubicmin(a, fa, fpa, b, fb, c, fc):
    with np.errstate(divide='raise', over='raise', invalid='raise'):
        try:
            C = fpa
            db = b - a
            dc = c - a
            denom = (db * dc) ** 2 * (db - dc)
            d1 = np.empty((2, 2))
            d1[0, 0] = dc ** 2
            d1[0, 1] = -db ** 2
            d1[1, 0] = -dc ** 3
            d1[1, 1] = db ** 3
            [A, B] = np.dot(d1, np.asarray([fb - fa - C * db, fc - fa - C * dc]).flatten())
            A /= denom
            B /= denom
            radical = B * B - 3 * A * C
            xmin = a + (-B + np.sqrt(radical)) / (3 * A)
        except ArithmeticError:
            return None
    if not np.isfinite(xmin):
        return None
    return xmin




def _quadmin(a, fa, fpa, b, fb):
    with np.errstate(divide='raise', over='raise', invalid='raise'):
        try:
            D = fa
            C = fpa
            db = b - a * 1.0
            B = (fb - D - C * db) / (db * db)
            xmin = a - C / (2.0 * B)
        except ArithmeticError:
            return None
    if not np.isfinite(xmin):
        return None
    return xmin




def _zoom(a_lo, a_hi, phi_lo, phi_hi, derphi_lo, phi, derphi, phi0, derphi0, c1, c2, extra_condition):
    maxiter = 10
    i = 0
    delta1 = 0.2
    delta2 = 0.1
    phi_rec = phi0
    a_rec = 0
    while True:
        dalpha = a_hi - a_lo
        if dalpha < 0:
            a, b = (a_hi, a_lo)
        else:
            a, b = (a_lo, a_hi)
        if i > 0:
            cchk = delta1 * dalpha
            a_j = _cubicmin(a_lo, phi_lo, derphi_lo, a_hi, phi_hi, a_rec, phi_rec)
        if i == 0 or a_j is None or a_j > b - cchk or (a_j < a + cchk):
            qchk = delta2 * dalpha
            a_j = _quadmin(a_lo, phi_lo, derphi_lo, a_hi, phi_hi)
            if a_j is None or a_j > b - qchk or a_j < a + qchk:
                a_j = a_lo + 0.5 * dalpha
        phi_aj = phi(a_j)
        if phi_aj > phi0 + c1 * a_j * derphi0 or phi_aj >= phi_lo:
            phi_rec = phi_hi
            a_rec = a_hi
            a_hi = a_j
            phi_hi = phi_aj
        else:
            derphi_aj = derphi(a_j)
            if abs(derphi_aj) <= -c2 * derphi0 and extra_condition(a_j, phi_aj):
                a_star = a_j
                val_star = phi_aj
                valprime_star = derphi_aj
                break
            if derphi_aj * (a_hi - a_lo) >= 0:
                phi_rec = phi_hi
                a_rec = a_hi
                a_hi = a_lo
                phi_hi = phi_lo
            else:
                phi_rec = phi_lo
                a_rec = a_lo
            a_lo = a_j
            phi_lo = phi_aj
            derphi_lo = derphi_aj
        i += 1
        if i > maxiter:
            a_star = None
            val_star = None
            valprime_star = None
            break
    return (a_star, val_star, valprime_star)




class DCSRCH:

    def __init__(self, phi, derphi, ftol, gtol, xtol, stpmin, stpmax):
        self.stage = None
        self.ginit = None
        self.gtest = None
        self.gx = None
        self.gy = None
        self.finit = None
        self.fx = None
        self.fy = None
        self.stx = None
        self.sty = None
        self.stmin = None
        self.stmax = None
        self.width = None
        self.width1 = None
        self.ftol = ftol
        self.gtol = gtol
        self.xtol = xtol
        self.stpmin = stpmin
        self.stpmax = stpmax
        self.phi = phi
        self.derphi = derphi

    def __call__(self, alpha1, phi0=None, derphi0=None, maxiter=100):
        if phi0 is None:
            phi0 = self.phi(0.0)
        if derphi0 is None:
            derphi0 = self.derphi(0.0)
        phi1 = phi0
        derphi1 = derphi0
        task = b'START'
        for i in range(maxiter):
            stp, phi1, derphi1, task = self._iterate(alpha1, phi1, derphi1, task)
            if not np.isfinite(stp):
                task = b'WARN'
                stp = None
                break
            if task[:2] == b'FG':
                alpha1 = stp
                phi1 = self.phi(stp)
                derphi1 = self.derphi(stp)
            else:
                break
        else:
            stp = None
            task = b'WARNING: dcsrch did not converge within max iterations'
        if task[:5] == b'ERROR' or task[:4] == b'WARN':
            stp = None
        return (stp, phi1, phi0, task)

    def _iterate(self, stp, f, g, task):
        p5 = 0.5
        p66 = 0.66
        xtrapl = 1.1
        xtrapu = 4.0
        if task[:5] == b'START':
            if stp < self.stpmin:
                task = b'ERROR: STP .LT. STPMIN'
            if stp > self.stpmax:
                task = b'ERROR: STP .GT. STPMAX'
            if g >= 0:
                task = b'ERROR: INITIAL G .GE. ZERO'
            if self.ftol < 0:
                task = b'ERROR: FTOL .LT. ZERO'
            if self.gtol < 0:
                task = b'ERROR: GTOL .LT. ZERO'
            if self.xtol < 0:
                task = b'ERROR: XTOL .LT. ZERO'
            if self.stpmin < 0:
                task = b'ERROR: STPMIN .LT. ZERO'
            if self.stpmax < self.stpmin:
                task = b'ERROR: STPMAX .LT. STPMIN'
            if task[:5] == b'ERROR':
                return (stp, f, g, task)
            self.brackt = False
            self.stage = 1
            self.finit = f
            self.ginit = g
            self.gtest = self.ftol * self.ginit
            self.width = self.stpmax - self.stpmin
            self.width1 = self.width / p5
            self.stx = 0.0
            self.fx = self.finit
            self.gx = self.ginit
            self.sty = 0.0
            self.fy = self.finit
            self.gy = self.ginit
            self.stmin = 0
            self.stmax = stp + xtrapu * stp
            task = b'FG'
            return (stp, f, g, task)
        ftest = self.finit + stp * self.gtest
        if self.stage == 1 and f <= ftest and (g >= 0):
            self.stage = 2
        if self.brackt and (stp <= self.stmin or stp >= self.stmax):
            task = b'WARNING: ROUNDING ERRORS PREVENT PROGRESS'
        if self.brackt and self.stmax - self.stmin <= self.xtol * self.stmax:
            task = b'WARNING: XTOL TEST SATISFIED'
        if stp == self.stpmax and f <= ftest and (g <= self.gtest):
            task = b'WARNING: STP = STPMAX'
        if stp == self.stpmin and (f > ftest or g >= self.gtest):
            task = b'WARNING: STP = STPMIN'
        if f <= ftest and abs(g) <= self.gtol * -self.ginit:
            task = b'CONVERGENCE'
        if task[:4] == b'WARN' or task[:4] == b'CONV':
            return (stp, f, g, task)
        if self.stage == 1 and f <= self.fx and (f > ftest):
            fm = f - stp * self.gtest
            fxm = self.fx - self.stx * self.gtest
            fym = self.fy - self.sty * self.gtest
            gm = g - self.gtest
            gxm = self.gx - self.gtest
            gym = self.gy - self.gtest
            with np.errstate(invalid='ignore', over='ignore'):
                tup = dcstep(self.stx, fxm, gxm, self.sty, fym, gym, stp, fm, gm, self.brackt, self.stmin, self.stmax)
                self.stx, fxm, gxm, self.sty, fym, gym, stp, self.brackt = tup
            self.fx = fxm + self.stx * self.gtest
            self.fy = fym + self.sty * self.gtest
            self.gx = gxm + self.gtest
            self.gy = gym + self.gtest
        else:
            with np.errstate(invalid='ignore', over='ignore'):
                tup = dcstep(self.stx, self.fx, self.gx, self.sty, self.fy, self.gy, stp, f, g, self.brackt, self.stmin, self.stmax)
            self.stx, self.fx, self.gx, self.sty, self.fy, self.gy, stp, self.brackt = tup
        if self.brackt:
            if abs(self.sty - self.stx) >= p66 * self.width1:
                stp = self.stx + p5 * (self.sty - self.stx)
            self.width1 = self.width
            self.width = abs(self.sty - self.stx)
        if self.brackt:
            self.stmin = min(self.stx, self.sty)
            self.stmax = max(self.stx, self.sty)
        else:
            self.stmin = stp + xtrapl * (stp - self.stx)
            self.stmax = stp + xtrapu * (stp - self.stx)
        stp = np.clip(stp, self.stpmin, self.stpmax)
        if self.brackt and (stp <= self.stmin or stp >= self.stmax) or (self.brackt and self.stmax - self.stmin <= self.xtol * self.stmax):
            stp = self.stx
        task = b'FG'
        return (stp, f, g, task)




def dcstep(stx, fx, dx, sty, fy, dy, stp, fp, dp, brackt, stpmin, stpmax):
    sgn_dp = np.sign(dp)
    sgn_dx = np.sign(dx)
    sgnd = sgn_dp * sgn_dx
    if fp > fx:
        theta = 3.0 * (fx - fp) / (stp - stx) + dx + dp
        s = max(abs(theta), abs(dx), abs(dp))
        gamma = s * np.sqrt((theta / s) ** 2 - dx / s * (dp / s))
        if stp < stx:
            gamma *= -1
        p = gamma - dx + theta
        q = gamma - dx + gamma + dp
        r = p / q
        stpc = stx + r * (stp - stx)
        stpq = stx + dx / ((fx - fp) / (stp - stx) + dx) / 2.0 * (stp - stx)
        if abs(stpc - stx) <= abs(stpq - stx):
            stpf = stpc
        else:
            stpf = stpc + (stpq - stpc) / 2.0
        brackt = True
    elif sgnd < 0.0:
        theta = 3 * (fx - fp) / (stp - stx) + dx + dp
        s = max(abs(theta), abs(dx), abs(dp))
        gamma = s * np.sqrt((theta / s) ** 2 - dx / s * (dp / s))
        if stp > stx:
            gamma *= -1
        p = gamma - dp + theta
        q = gamma - dp + gamma + dx
        r = p / q
        stpc = stp + r * (stx - stp)
        stpq = stp + dp / (dp - dx) * (stx - stp)
        if abs(stpc - stp) > abs(stpq - stp):
            stpf = stpc
        else:
            stpf = stpq
        brackt = True
    elif abs(dp) < abs(dx):
        theta = 3 * (fx - fp) / (stp - stx) + dx + dp
        s = max(abs(theta), abs(dx), abs(dp))
        gamma = s * np.sqrt(max(0, (theta / s) ** 2 - dx / s * (dp / s)))
        if stp > stx:
            gamma = -gamma
        p = gamma - dp + theta
        q = gamma + (dx - dp) + gamma
        r = p / q
        if r < 0 and gamma != 0:
            stpc = stp + r * (stx - stp)
        elif stp > stx:
            stpc = stpmax
        else:
            stpc = stpmin
        stpq = stp + dp / (dp - dx) * (stx - stp)
        if brackt:
            if abs(stpc - stp) < abs(stpq - stp):
                stpf = stpc
            else:
                stpf = stpq
            if stp > stx:
                stpf = min(stp + 0.66 * (sty - stp), stpf)
            else:
                stpf = max(stp + 0.66 * (sty - stp), stpf)
        else:
            if abs(stpc - stp) > abs(stpq - stp):
                stpf = stpc
            else:
                stpf = stpq
            stpf = np.clip(stpf, stpmin, stpmax)
    elif brackt:
        theta = 3.0 * (fp - fy) / (sty - stp) + dy + dp
        s = max(abs(theta), abs(dy), abs(dp))
        gamma = s * np.sqrt((theta / s) ** 2 - dy / s * (dp / s))
        if stp > sty:
            gamma = -gamma
        p = gamma - dp + theta
        q = gamma - dp + gamma + dy
        r = p / q
        stpc = stp + r * (sty - stp)
        stpf = stpc
    elif stp > stx:
        stpf = stpmax
    else:
        stpf = stpmin
    if fp > fx:
        sty = stp
        fy = fp
        dy = dp
    else:
        if sgnd < 0:
            sty = stx
            fy = fx
            dy = dx
        stx = stp
        fx = fp
        dx = dp
    stp = stpf
    return (stx, fx, dx, sty, fy, dy, stp, brackt)




FD_METHODS = ('2-point', '3-point', 'cs')




class _ScalarGradWrapper:

    def __init__(self, grad, fun=None, args=None, finite_diff_options=None):
        self.fun = fun
        self.grad = grad
        self.args = [] if args is None else args
        self.finite_diff_options = finite_diff_options
        self.ngev = 0
        self.nfev = 0

    def __call__(self, x, f0=None, **kwds):
        if callable(self.grad):
            g = np.atleast_1d(self.grad(np.copy(x), *self.args))
        elif self.grad in FD_METHODS:
            g, dct = approx_derivative(self.fun, x, f0=f0, **self.finite_diff_options)
            self.nfev += dct['nfev']
        self.ngev += 1
        return g




class _ScalarHessWrapper:

    def __init__(self, hess, x0=None, grad=None, args=None, finite_diff_options=None):
        self.hess = hess
        self.grad = grad
        self.args = [] if args is None else args
        self.finite_diff_options = finite_diff_options
        self.ngev = 0
        self.nhev = 0
        self.H = None
        self._hess_func = None
        if callable(hess):
            self.H = hess(np.copy(x0), *args)
            self.nhev += 1
            if sps.issparse(self.H):
                self._hess_func = 'sparse_callable'
                self.H = sps.csr_array(self.H)
            elif isinstance(self.H, LinearOperator):
                self._hess_func = 'linearoperator_callable'
            else:
                self._hess_func = 'dense_callable'
                self.H = None if self.H is None else np.atleast_2d(np.asarray(self.H))
        elif hess in FD_METHODS:
            self._hess_func = 'fd_hess'

    def __call__(self, x, f0=None, **kwds):
        match self._hess_func:
            case 'sparse_callable':
                _h = self._sparse_callable
            case 'linearoperator_callable':
                _h = self._linearoperator_callable
            case 'dense_callable':
                _h = self._dense_callable
            case 'fd_hess':
                _h = self._fd_hess
        return _h(np.copy(x), f0=f0)

    def _fd_hess(self, x, f0=None, **kwds):
        self.H, dct = approx_derivative(self.grad, x, f0=f0, **self.finite_diff_options)
        self.ngev += dct['nfev']
        return self.H

    def _sparse_callable(self, x, **kwds):
        self.nhev += 1
        self.H = sps.csr_array(self.hess(x, *self.args))
        return self.H

    def _dense_callable(self, x, **kwds):
        self.nhev += 1
        self.H = np.atleast_2d(np.asarray(self.hess(x, *self.args)))
        return self.H

    def _linearoperator_callable(self, x, **kwds):
        self.nhev += 1
        self.H = self.hess(x, *self.args)
        return self.H




class ScalarFunction:

    def __init__(self, fun, x0, args, grad, hess, finite_diff_rel_step=None, finite_diff_bounds=(-np.inf, np.inf), epsilon=None, workers=None):
        if not callable(grad) and grad not in FD_METHODS:
            raise ValueError(f'`grad` must be either callable or one of {FD_METHODS}.')
        if not (callable(hess) or hess in FD_METHODS or isinstance(hess, HessianUpdateStrategy)):
            raise ValueError(f'`hess` must be either callable, HessianUpdateStrategy or one of {FD_METHODS}.')
        if grad in FD_METHODS and hess in FD_METHODS:
            raise ValueError('Whenever the gradient is estimated via finite-differences, we require the Hessian to be estimated using one of the quasi-Newton strategies.')
        _x = np.atleast_1d(np.asarray(x0))
        _dtype = np.float64
        if np.issubdtype(_x.dtype, np.floating):
            _dtype = _x.dtype
        self._wrapped_fun = _ScalarFunctionWrapper(fun, args)
        self._orig_fun = fun
        self._orig_grad = grad
        self._orig_hess = hess
        self._args = args
        self.x = _x.astype(_dtype)
        self.x_dtype = _dtype
        self.n = self.x.size
        self.f_updated = False
        self.g_updated = False
        self.H_updated = False
        self._lowest_x = None
        self._lowest_f = np.inf
        workers = workers or map
        finite_diff_options = {}
        if grad in FD_METHODS:
            finite_diff_options['method'] = grad
            finite_diff_options['rel_step'] = finite_diff_rel_step
            finite_diff_options['abs_step'] = epsilon
            finite_diff_options['bounds'] = finite_diff_bounds
            finite_diff_options['workers'] = workers
            finite_diff_options['full_output'] = True
        if hess in FD_METHODS:
            finite_diff_options['method'] = hess
            finite_diff_options['rel_step'] = finite_diff_rel_step
            finite_diff_options['abs_step'] = epsilon
            finite_diff_options['as_linear_operator'] = True
            finite_diff_options['workers'] = workers
            finite_diff_options['full_output'] = True
        self._nfev = 0
        self._update_fun()
        self._wrapped_grad = _ScalarGradWrapper(grad, fun=self._wrapped_fun, args=args, finite_diff_options=finite_diff_options)
        self._update_grad()
        if isinstance(hess, HessianUpdateStrategy):
            self.H = hess
            self.H.initialize(self.n, 'hess')
            self.H_updated = True
            self.x_prev = None
            self.g_prev = None
            _FakeCounter = namedtuple('_FakeCounter', ['ngev', 'nhev'])
            self._wrapped_hess = _FakeCounter(ngev=0, nhev=0)
        elif callable(hess):
            self._wrapped_hess = _ScalarHessWrapper(hess, x0=x0, args=args, finite_diff_options=finite_diff_options)
            self.H = self._wrapped_hess.H
            self.H_updated = True
        elif hess in FD_METHODS:
            self._wrapped_hess = _ScalarHessWrapper(hess, x0=x0, args=args, grad=self._wrapped_grad, finite_diff_options=finite_diff_options)
            self._update_grad()
            self.H = self._wrapped_hess(self.x, f0=self.g)
            self.H_updated = True

    @property
    def nfev(self):
        return self._nfev + self._wrapped_grad.nfev

    @property
    def ngev(self):
        return self._wrapped_grad.ngev

    @property
    def nhev(self):
        return self._wrapped_hess.nhev

    def _update_x(self, x):
        if isinstance(self._orig_hess, HessianUpdateStrategy):
            self._update_grad()
            self.x_prev = self.x
            self.g_prev = self.g
            _x = np.atleast_1d(np.asarray(x))
            self.x = _x.astype(self.x_dtype)
            self.f_updated = False
            self.g_updated = False
            self.H_updated = False
            self._update_hess()
        else:
            _x = np.atleast_1d(np.asarray(x))
            self.x = _x.astype(self.x_dtype)
            self.f_updated = False
            self.g_updated = False
            self.H_updated = False

    def _update_fun(self):
        if not self.f_updated:
            fx = self._wrapped_fun(self.x)
            self._nfev += 1
            if fx < self._lowest_f:
                self._lowest_x = self.x
                self._lowest_f = fx
            self.f = fx
            self.f_updated = True

    def _update_grad(self):
        if not self.g_updated:
            if self._orig_grad in FD_METHODS:
                self._update_fun()
            self.g = self._wrapped_grad(self.x, f0=self.f)
            self.g_updated = True

    def _update_hess(self):
        if not self.H_updated:
            if self._orig_hess in FD_METHODS:
                self._update_grad()
                self.H = self._wrapped_hess(self.x, f0=self.g)
            elif isinstance(self._orig_hess, HessianUpdateStrategy):
                self._update_grad()
                self.H.update(self.x - self.x_prev, self.g - self.g_prev)
            else:
                self.H = self._wrapped_hess(self.x)
            self.H_updated = True

    def fun(self, x):
        if not np.array_equal(x, self.x):
            self._update_x(x)
        self._update_fun()
        return self.f

    def grad(self, x):
        if not np.array_equal(x, self.x):
            self._update_x(x)
        self._update_grad()
        return self.g

    def hess(self, x):
        if not np.array_equal(x, self.x):
            self._update_x(x)
        self._update_hess()
        return self.H

    def fun_and_grad(self, x):
        if not np.array_equal(x, self.x):
            self._update_x(x)
        self._update_fun()
        self._update_grad()
        return (self.f, self.g)




class _Fun_Wrapper:

    def __init__(self, fun, x0, args, kwargs):
        self.fun = fun
        self.x0 = x0
        self.args = args
        self.kwargs = kwargs

    def __call__(self, x):
        if np.issubdtype(x.dtype, np.floating):
            x = x.astype(self.x0.dtype)
        f = np.atleast_1d(self.fun(x, *self.args, **self.kwargs))
        if f.ndim > 1:
            raise RuntimeError('`fun` return value has more than 1 dimension.')
        return f




def _adjust_scheme_to_bounds(x0, h, num_steps, scheme, lb, ub):
    if scheme == '1-sided':
        use_one_sided = np.ones_like(h, dtype=bool)
    elif scheme == '2-sided':
        h = np.abs(h)
        use_one_sided = np.zeros_like(h, dtype=bool)
    else:
        raise ValueError("`scheme` must be '1-sided' or '2-sided'.")
    if np.all((lb == -np.inf) & (ub == np.inf)):
        return (h, use_one_sided)
    h_total = h * num_steps
    h_adjusted = h.copy()
    lower_dist = x0 - lb
    upper_dist = ub - x0
    if scheme == '1-sided':
        x = x0 + h_total
        violated = (x < lb) | (x > ub)
        fitting = np.abs(h_total) <= np.maximum(lower_dist, upper_dist)
        h_adjusted[violated & fitting] *= -1
        forward = (upper_dist >= lower_dist) & ~fitting
        h_adjusted[forward] = upper_dist[forward] / num_steps
        backward = (upper_dist < lower_dist) & ~fitting
        h_adjusted[backward] = -lower_dist[backward] / num_steps
    elif scheme == '2-sided':
        central = (lower_dist >= h_total) & (upper_dist >= h_total)
        forward = (upper_dist >= lower_dist) & ~central
        h_adjusted[forward] = np.minimum(h[forward], 0.5 * upper_dist[forward] / num_steps)
        use_one_sided[forward] = True
        backward = (upper_dist < lower_dist) & ~central
        h_adjusted[backward] = -np.minimum(h[backward], 0.5 * lower_dist[backward] / num_steps)
        use_one_sided[backward] = True
        min_dist = np.minimum(upper_dist, lower_dist) / num_steps
        adjusted_central = ~central & (np.abs(h_adjusted) <= min_dist)
        h_adjusted[adjusted_central] = min_dist[adjusted_central]
        use_one_sided[adjusted_central] = False
    return (h_adjusted, use_one_sided)




def _compute_absolute_step(rel_step, x0, f0, method):
    sign_x0 = (x0 >= 0).astype(x0.dtype) * 2 - 1
    rstep = _eps_for_method(x0.dtype, f0.dtype, method)
    default_abs_step = (rstep * sign_x0 * np.maximum(1.0, np.abs(x0))).astype(x0.dtype)
    if rel_step is None:
        abs_step = default_abs_step
    else:
        abs_step = (rel_step * sign_x0 * np.abs(x0)).astype(x0.dtype)
        dx = x0 + abs_step - x0
        abs_step = np.where(dx == 0, default_abs_step, abs_step)
    return abs_step




def _prepare_bounds(bounds, x0):
    lb, ub = (np.asarray(b, dtype=float) for b in bounds)
    if lb.ndim == 0:
        lb = np.resize(lb, x0.shape)
    if ub.ndim == 0:
        ub = np.resize(ub, x0.shape)
    return (lb, ub)




def _dense_difference(fun, x0, f0, h, use_one_sided, method, workers):
    m = f0.size
    n = x0.size
    nfev = 0
    result_type = np.result_type(x0, f0, 1.0)
    J_transposed = np.empty((n, m), dtype=result_type)
    if method == '2-point':

        def x_generator2(x0, h):
            for i in range(n):
                x1 = np.copy(x0)
                x1[i] = x0[i] + h[i]
                yield x1
        f_evals = workers(fun, x_generator2(x0, h))
        dx = [x0[i] + h[i] - x0[i] for i in range(n)]
        df = [f_eval - f0 for f_eval in f_evals]
        df_dx = [delf / delx for delf, delx in zip(df, dx)]
        nfev += len(df_dx)
    elif method == '3-point':

        def x_generator3(x0, h, use_one_sided):
            for i, one_sided in enumerate(use_one_sided):
                x1 = np.copy(x0)
                x2 = np.copy(x0)
                if one_sided:
                    x1[i] = x0[i] + h[i]
                    x2[i] = x0[i] + 2 * h[i]
                else:
                    x1[i] = x0[i] - h[i]
                    x2[i] = x0[i] + h[i]
                yield x1
                yield x2
        f_evals = iter(workers(fun, x_generator3(x0, h, use_one_sided)))
        gen = x_generator3(x0, h, use_one_sided)
        dx = list()
        df = list()
        for i, one_sided in enumerate(use_one_sided):
            l = next(gen)
            u = next(gen)
            f1 = next(f_evals)
            f2 = next(f_evals)
            if one_sided:
                dx.append(u[i] - x0[i])
                df.append(-3.0 * f0 + 4 * f1 - f2)
            else:
                dx.append(u[i] - l[i])
                df.append(f2 - f1)
        df_dx = [delf / delx for delf, delx in zip(df, dx)]
        nfev += 2 * len(df_dx)
    elif method == 'cs':

        def x_generator_cs(x0, h):
            for i in range(n):
                xc = x0.astype(complex, copy=True)
                xc[i] += h[i] * 1j
                yield xc
        f_evals = iter(workers(fun, x_generator_cs(x0, h)))
        df_dx = [f1.imag / hi for f1, hi in zip(f_evals, h)]
        nfev += len(df_dx)
    else:
        raise RuntimeError('Never be here.')
    for i, v in enumerate(df_dx):
        J_transposed[i] = v
    if m == 1:
        J_transposed = np.ravel(J_transposed)
    return (J_transposed.T, nfev)




@functools.lru_cache
def _eps_for_method(x0_dtype, f0_dtype, method):
    EPS = np.finfo(np.float64).eps
    x0_is_fp = False
    if np.issubdtype(x0_dtype, np.inexact):
        EPS = np.finfo(x0_dtype).eps
        x0_itemsize = np.dtype(x0_dtype).itemsize
        x0_is_fp = True
    if np.issubdtype(f0_dtype, np.inexact):
        f0_itemsize = np.dtype(f0_dtype).itemsize
        if x0_is_fp and f0_itemsize < x0_itemsize:
            EPS = np.finfo(f0_dtype).eps
    if method in ['2-point', 'cs']:
        return EPS ** 0.5
    elif method in ['3-point']:
        return EPS ** (1 / 3)
    else:
        raise RuntimeError("Unknown step method, should be one of {'2-point', '3-point', 'cs'}")




MINIMIZE_SCALAR_METHODS = ['brent', 'bounded', 'golden']




_PORTED = ('nelder-mead', 'cg', 'bfgs')


def minimize(fun, x0, args=(), method=None, jac=None, hess=None, hessp=None, bounds=None, constraints=(), tol=None,
             callback=None, options=None):
    x0 = np.atleast_1d(np.asarray(x0))
    if x0.ndim != 1:
        raise ValueError("'x0' must only have one dimension.")
    if x0.dtype.kind in 'bBhHiIlLqQnNpP':  # (np.typecodes['AllInteger'], as SciPy asks)
        x0 = np.asarray(x0, dtype=float)
    if not isinstance(args, tuple):
        args = (args,)
    if method is None:
        if constraints:
            method = 'SLSQP'
        elif bounds is not None:
            method = 'L-BFGS-B'
        else:
            method = 'BFGS'
    if callable(method):
        meth = '_custom'
    else:
        meth = method.lower()
    if options is None:
        options = {}
    if meth not in _PORTED and meth != '_custom':
        _unsupported("minimize's method %r" % method)
    if meth in ('nelder-mead', 'powell', 'cobyla', 'cobyqa') and bool(jac):
        warn(f'Method {method} does not use gradient information (jac).', RuntimeWarning, stacklevel=2)
    if meth not in ('newton-cg', 'dogleg', 'trust-ncg', 'trust-constr', 'trust-krylov', 'trust-exact', '_custom') and hess is not None:
        warn(f'Method {method} does not use Hessian information (hess).', RuntimeWarning, stacklevel=2)
    if meth not in ('newton-cg', 'trust-ncg', 'trust-constr', 'trust-krylov', '_custom') and hessp is not None:
        warn(f'Method {method} does not use Hessian-vector product information (hessp).', RuntimeWarning, stacklevel=2)
    if meth not in ('cobyla', 'cobyqa', 'slsqp', 'trust-constr', '_custom') and np.any(constraints):
        warn(f'Method {method} cannot handle constraints.', RuntimeWarning, stacklevel=2)
    if meth not in ('nelder-mead', 'powell', 'l-bfgs-b', 'cobyla', 'cobyqa', 'slsqp', 'tnc', 'trust-constr', '_custom') and bounds is not None:
        warn(f'Method {method} cannot handle bounds.', RuntimeWarning, stacklevel=2)
    if callable(jac):
        pass
    elif jac is True:
        fun = MemoizeJac(fun)
        jac = fun.derivative
    elif jac in FD_METHODS and meth in ['trust-constr', 'bfgs', 'cg', 'l-bfgs-b', 'tnc', 'slsqp']:
        pass
    elif meth in ['trust-constr']:
        jac = '2-point'
    elif jac is None or bool(jac) is False:
        jac = None
    else:
        jac = None
    if tol is not None:
        options = dict(options)
        if meth == 'nelder-mead':
            options.setdefault('xatol', tol)
            options.setdefault('fatol', tol)
        if meth in ('bfgs', 'cg'):
            options.setdefault('gtol', tol)
        if meth == '_custom':
            options.setdefault('tol', tol)
    if meth == '_custom':
        return method(fun, x0, args=args, jac=jac, hess=hess, hessp=hessp, bounds=bounds, constraints=constraints,
                      callback=callback, **options)
    if meth == 'nelder-mead' and bounds is not None:
        _unsupported("Nelder-Mead with bounds")
    callback = _wrap_callback(callback, meth)
    if meth == 'nelder-mead':
        res = _minimize_neldermead(fun, x0, args, callback, bounds=None, **options)
    elif meth == 'cg':
        res = _minimize_cg(fun, x0, args, jac, callback, **options)
    else:
        res = _minimize_bfgs(fun, x0, args, jac, callback, **options)
    if getattr(callback, 'stop_iteration', False):
        res.success = False
        res.status = 99
        res.message = '`callback` raised `StopIteration`.'
    return res


def minimize_scalar(fun, bracket=None, bounds=None, args=(), method=None, tol=None, options=None):
    if not isinstance(args, tuple):
        args = (args,)
    if callable(method):
        meth = '_custom'
    elif method is None:
        meth = 'brent' if bounds is None else 'bounded'
    else:
        meth = method.lower()
    if options is None:
        options = {}
    if bounds is not None and meth in {'brent', 'golden'}:
        message = f"Use of `bounds` is incompatible with 'method={method}'."
        raise ValueError(message)
    if tol is not None:
        options = dict(options)
        if meth == 'bounded' and 'xatol' not in options:
            warn("Method 'bounded' does not support relative tolerance in x; defaulting to absolute tolerance.", RuntimeWarning, stacklevel=2)
            options['xatol'] = tol
        elif meth == '_custom':
            options.setdefault('tol', tol)
        else:
            options.setdefault('xtol', tol)
    disp = options.get('disp')
    if isinstance(disp, bool):
        options['disp'] = 2 * int(disp)
    if meth == '_custom':
        res = method(fun, args=args, bracket=bracket, bounds=bounds, **options)
    elif meth == 'brent':
        res = _recover_from_bracket_error(_minimize_scalar_brent, fun, bracket, args, **options)
    elif meth == 'bounded':
        if bounds is None:
            raise ValueError('The `bounds` parameter is mandatory for method `bounded`.')
        res = _minimize_scalar_bounded(fun, bounds, args, **options)
    elif meth == 'golden':
        res = _recover_from_bracket_error(_minimize_scalar_golden, fun, bracket, args, **options)
    else:
        raise ValueError(f'Unknown solver {method}')
    res.fun = np.asarray(res.fun)[()]
    res.x = np.reshape(res.x, res.fun.shape)[()]
    return res

line_search = line_search_wolfe2
